/**
 * Container-side reachability preflight for locally-hosted model endpoints.
 *
 * The model save-validation (`validateModel`) runs FROM THE HOST. But the agent
 * runs inside a container, and a loopback endpoint that the host reaches fine
 * (`127.0.0.1:11434`) becomes `host.docker.internal:11434` in the container —
 * a completely different network path that a host firewall or a loopback-only
 * bind can silently drop. When that happens the agent loops forever on
 * "API retry" with no surfaced cause.
 *
 * This module reproduces the agent's EXACT direct-connect conditions: a
 * throwaway container off the same agent image, with the same
 * `--add-host=host.docker.internal:host-gateway` alias and NO egress proxy
 * (loopback endpoints ride `NO_PROXY=host.docker.internal`, i.e. direct). It
 * TCP-connects and does one HTTP probe, then maps the outcome to an actionable
 * verdict + copy-paste fix.
 *
 * Scope: only endpoints whose container-facing form is `host.docker.internal`
 * (i.e. loopback-origin) are probed — those are the ones the agent dials
 * DIRECTLY. LAN/public endpoints ride the egress proxy (a different path) and
 * are reported as `skipped`, not falsely failed.
 */
import { execFile } from 'node:child_process';

import { log } from '../../log.js';
import { containerReachableUrl } from './models.js';

export type ReachabilityVerdict =
  | 'ok' // container reached the endpoint
  | 'timeout' // TCP connect timed out — packets dropped (firewall)
  | 'refused' // connection refused — nothing listening / loopback-only bind
  | 'dns' // hostname didn't resolve from the container
  | 'incompatible' // reachable, but not answering as a model API
  | 'skipped' // not a direct-connect endpoint (rides the egress proxy) or docker unavailable
  | 'error'; // probe infrastructure failed

export interface ReachabilityResult {
  verdict: ReachabilityVerdict;
  /** The container-facing URL that was (or would be) probed. */
  probedUrl: string;
  /** One-line human summary. */
  detail: string;
  /** Copy-paste remediation, when there is one. */
  fix?: string;
  /** HTTP status from the /api/tags probe, when TCP connected. */
  httpStatus?: number;
}

const DOCKER_BRIDGE_CIDR = '172.17.0.0/16';

/**
 * The bun one-liner that runs inside the throwaway container. Passed as a
 * single argv element (execFile, no shell) so it needs no shell-escaping.
 * Emits exactly one JSON line to stdout describing the outcome.
 */
const PROBE_SCRIPT = `
const url = process.env.PROBE_URL;
const u = new URL(url);
const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
const net = require('net');
let done = false;
const fin = (o) => { if (done) return; done = true; try { s.destroy(); } catch {} console.log(JSON.stringify(o)); process.exit(0); };
const s = net.connect(port, u.hostname);
s.setTimeout(4000);
s.on('connect', async () => {
  let http = {};
  try {
    const r = await fetch(url.replace(/\\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(4000) });
    http = { httpOk: true, status: r.status };
  } catch (e) { http = { httpOk: false, httpErr: String((e && e.message) || e) }; }
  fin({ stage: 'connected', ...http });
});
s.on('timeout', () => fin({ stage: 'tcp', result: 'timeout' }));
s.on('error', (e) => fin({ stage: 'tcp', result: 'error', code: e.code || '', msg: String((e && e.message) || e) }));
setTimeout(() => fin({ stage: 'tcp', result: 'timeout' }), 9000);
`;

/**
 * Resolve the agent container image to probe with. Prefers the explicit env
 * the host runner uses; falls back to a `docker images` lookup for the
 * `nanoclaw-agent` image the install builds. Returns null when neither is
 * available (→ verdict `skipped`, we don't fail a model over a missing probe).
 */
function resolveAgentImage(): Promise<string | null> {
  const fromEnv = process.env.CONTAINER_IMAGE || process.env.AGENT_IMAGE;
  if (fromEnv && fromEnv.trim()) return Promise.resolve(fromEnv.trim());
  return new Promise((resolve) => {
    execFile('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('nanoclaw-agent'));
      resolve(line ?? null);
    });
  });
}

/** Map the probe's stdout JSON to a verdict + fix hint. Exported for tests. */
export function classifyReachability(
  probedUrl: string,
  out: { stage?: string; result?: string; code?: string; status?: number },
): ReachabilityResult {
  const host = safeHost(probedUrl);
  const port = safePort(probedUrl);

  if (out.stage === 'connected') {
    if (typeof out.status === 'number' && out.status >= 500) {
      return {
        verdict: 'incompatible',
        probedUrl,
        httpStatus: out.status,
        detail: `Reachable, but ${host}:${port} answered HTTP ${out.status} to /api/tags.`,
        fix: 'The port is reachable but the server errored. Confirm the endpoint is an Ollama or OpenAI-compatible server and that the model is loaded.',
      };
    }
    return {
      verdict: 'ok',
      probedUrl,
      httpStatus: out.status,
      detail: `Container reached ${host}:${port}${typeof out.status === 'number' ? ` (HTTP ${out.status})` : ''}.`,
    };
  }

  if (out.stage === 'tcp' && out.result === 'timeout') {
    return {
      verdict: 'timeout',
      probedUrl,
      detail: `Connection to ${host}:${port} timed out from inside a container — packets are being dropped, not refused. The host reaches this fine; a container does not.`,
      fix:
        `A host firewall is dropping Docker-bridge → host traffic on port ${port}. ` +
        `If you use UFW:\n  sudo ufw allow from ${DOCKER_BRIDGE_CIDR} to any port ${port} proto tcp\n` +
        `For firewalld:\n  sudo firewall-cmd --permanent --zone=trusted --add-source=${DOCKER_BRIDGE_CIDR} && sudo firewall-cmd --reload`,
    };
  }

  if (out.stage === 'tcp' && out.result === 'error') {
    const code = (out.code || '').toUpperCase();
    if (code === 'ECONNREFUSED') {
      return {
        verdict: 'refused',
        probedUrl,
        detail: `Connection to ${host}:${port} was refused — nothing is listening there as seen from a container.`,
        fix:
          `This is almost always a loopback-only bind. A local Ollama installed by the OS listens on 127.0.0.1 only, ` +
          `which a container can't reach. Bind it to all interfaces:\n` +
          `  sudo mkdir -p /etc/systemd/system/ollama.service.d\n` +
          `  printf '[Service]\\nEnvironment="OLLAMA_HOST=0.0.0.0:${port}"\\n' | sudo tee /etc/systemd/system/ollama.service.d/override.conf\n` +
          `  sudo systemctl daemon-reload && sudo systemctl restart ollama`,
      };
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return {
        verdict: 'dns',
        probedUrl,
        detail: `The container could not resolve "${host}".`,
        fix: 'Use an IP address the container can route to, or a hostname resolvable inside the container. Loopback endpoints should be registered as 127.0.0.1/localhost so they map to host.docker.internal automatically.',
      };
    }
    return {
      verdict: 'error',
      probedUrl,
      detail: `Probe hit an unexpected socket error (${code || 'unknown'}) reaching ${host}:${port}.`,
    };
  }

  return { verdict: 'error', probedUrl, detail: 'Probe returned no recognizable result.' };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
function safePort(url: string): string {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch {
    return '?';
  }
}

/**
 * Probe whether an agent container could reach `endpoint`. Never throws —
 * infrastructure problems degrade to `skipped`/`error` so a preflight can't
 * block a model save on its own flakiness.
 */
export async function probeContainerReachability(
  endpoint: string | null | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<ReachabilityResult> {
  if (!endpoint || !endpoint.trim()) {
    return { verdict: 'skipped', probedUrl: '', detail: 'No endpoint to probe (e.g. a hosted Anthropic model).' };
  }
  const probedUrl = containerReachableUrl(endpoint.trim().replace(/\/+$/, ''));

  // Only endpoints the agent dials DIRECTLY (NO_PROXY=host.docker.internal) are
  // meaningful to probe this way. LAN/public endpoints ride the egress proxy.
  if (!/^https?:\/\/host\.docker\.internal(?=[:/]|$)/.test(probedUrl)) {
    return {
      verdict: 'skipped',
      probedUrl,
      detail:
        'Non-loopback endpoint — the agent reaches it through the egress proxy, not directly, so a direct container probe would be misleading.',
    };
  }

  const image = await resolveAgentImage();
  if (!image) {
    return {
      verdict: 'skipped',
      probedUrl,
      detail: 'Could not resolve the agent container image to probe with (docker unavailable or image not built yet).',
    };
  }

  const timeoutMs = opts.timeoutMs ?? 20000;
  return new Promise<ReachabilityResult>((resolve) => {
    execFile(
      'docker',
      [
        'run',
        '--rm',
        '--add-host=host.docker.internal:host-gateway',
        '-e',
        `PROBE_URL=${probedUrl}`,
        // The agent image's ENTRYPOINT is tini → entrypoint.sh; override it so
        // our probe args reach bun directly instead of the runner bootstrap.
        '--entrypoint',
        'bun',
        image,
        '-e',
        PROBE_SCRIPT,
      ],
      { timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          log.warn('Webchat: reachability probe container failed', {
            probedUrl,
            image,
            err: err.message,
            stderr: (stderr || '').slice(0, 200),
          });
          resolve({
            verdict: 'error',
            probedUrl,
            detail: `Could not run the probe container: ${err.message}`,
          });
          return;
        }
        const line = (stdout || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (!line) {
          resolve({ verdict: 'error', probedUrl, detail: 'Probe produced no output.' });
          return;
        }
        try {
          resolve(classifyReachability(probedUrl, JSON.parse(line)));
        } catch {
          resolve({ verdict: 'error', probedUrl, detail: 'Probe output was not valid JSON.' });
        }
      },
    );
  });
}
