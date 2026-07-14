/**
 * `tailscale serve` control — the host side of the webchat "Enable HTTPS over
 * Tailscale" action.
 *
 * `tailscale serve --bg <port>` puts an HTTPS reverse proxy in front of the
 * local webchat on the node's `*.ts.net` MagicDNS name, using Tailscale's
 * automatic Let's Encrypt cert. The result is `https://<node>.ts.net` with a
 * valid cert (a real browser secure context → PWA install / push / voice work)
 * proxying to `http://127.0.0.1:<port>`. Serve injects `Tailscale-User-Login`,
 * which auth.ts maps back to the same `webchat:tailscale:<login>` identity the
 * whois path produces (see `tailscaleServeIdentity`), so an owner claimed over
 * plain http-tailnet stays owner once HTTPS is on.
 *
 * Two external prerequisites this module can only *report*, not fix:
 *   - HTTPS certificates must be enabled once, tailnet-wide, in the Tailscale
 *     admin console (DNS page). We detect that failure and hand back the link.
 *   - `tailscale serve` needs root or operator access to tailscaled. The
 *     community-scripts deploy runs as root; a self-hosted service user needs
 *     `tailscale set --operator=<user>`. We detect the permission error too.
 *
 * The tailscale invocations go through an injectable runner so the parsing and
 * error-classification logic is unit-tested without a real daemon.
 */
import { execFile } from 'child_process';

export interface TailscaleServeState {
  /** tailscaled is up and logged into a tailnet. */
  available: boolean;
  /** An HTTPS serve mapping already exists (best-effort; older CLIs lack --json). */
  active: boolean;
  /** `https://<node>.ts.net`, or null when it can't be determined. */
  url: string | null;
}

export interface EnableResult {
  ok: boolean;
  url?: string;
  error?: string;
  hint?: string;
  hintUrl?: string;
}

export interface RunResult {
  ok: boolean;
  notFound: boolean;
  stdout: string;
  stderr: string;
}

export type TailscaleRunner = (args: string[]) => Promise<RunResult>;

const defaultRunner: TailscaleRunner = (args) =>
  new Promise((resolve) => {
    execFile('tailscale', args, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        notFound: !!err && (err as NodeJS.ErrnoException).code === 'ENOENT',
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
  });

/** Probe tailscaled: is it up, what's the HTTPS URL, and is serve already on? */
export async function getTailscaleServeState(runner: TailscaleRunner = defaultRunner): Promise<TailscaleServeState> {
  const status = await runner(['status', '--json']);
  if (!status.ok) return { available: false, active: false, url: null };

  let dns: string | null = null;
  let running = false;
  try {
    const j = JSON.parse(status.stdout) as { Self?: { DNSName?: string }; BackendState?: string };
    running = j.BackendState === 'Running';
    const raw = j.Self?.DNSName?.replace(/\.$/, '') ?? '';
    dns = raw || null;
  } catch {
    /* malformed status → treat as unavailable below */
  }
  const url = dns ? `https://${dns}` : null;

  let active = false;
  const serve = await runner(['serve', 'status', '--json']);
  if (serve.ok) {
    try {
      const cfg = JSON.parse(serve.stdout) as { Web?: Record<string, unknown>; TCP?: Record<string, unknown> };
      active = Object.keys(cfg.Web ?? {}).length > 0 || Object.keys(cfg.TCP ?? {}).length > 0;
    } catch {
      /* older CLI or no config → leave active=false */
    }
  }
  return { available: running, active, url };
}

/**
 * Turn on `tailscale serve --bg <port>`. Classifies the common failure modes
 * (certs not enabled, insufficient privilege, daemon down, binary missing) into
 * actionable hints so the UI can guide the operator instead of dumping stderr.
 */
export async function enableTailscaleServe(
  port: number,
  runner: TailscaleRunner = defaultRunner,
): Promise<EnableResult> {
  const state = await getTailscaleServeState(runner);
  if (!state.available) {
    return {
      ok: false,
      error: 'Tailscale is not running or not logged in on this machine.',
      hint: 'Run `tailscale up` first, then try again.',
    };
  }

  const run = await runner(['serve', '--bg', String(port)]);
  if (run.ok) {
    const after = await getTailscaleServeState(runner);
    return { ok: true, url: after.url ?? state.url ?? undefined };
  }

  if (run.notFound) {
    return {
      ok: false,
      error: '`tailscale` is not installed on this machine.',
      hint: 'Install Tailscale, then try again.',
    };
  }

  const err = `${run.stdout}\n${run.stderr}`.toLowerCase();
  if (/https|certificate|\bcert\b/.test(err) && /enabl|not |admin|provision/.test(err)) {
    return {
      ok: false,
      error: 'HTTPS certificates are not enabled for your tailnet yet.',
      hint: 'Enable "HTTPS Certificates" in the Tailscale admin console (DNS page), then try again.',
      hintUrl: 'https://login.tailscale.com/admin/dns',
    };
  }
  if (/access denied|permission|operator|must be run|not permitted|are not allowed/.test(err)) {
    return {
      ok: false,
      error: 'This process is not allowed to configure `tailscale serve`.',
      hint: 'Run the host as root, or grant the service user access with `tailscale set --operator=<user>`.',
    };
  }
  return { ok: false, error: (run.stderr || run.stdout || 'tailscale serve failed').trim().slice(0, 400) };
}
