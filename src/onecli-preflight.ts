/**
 * OneCLI gateway preflight — a startup diagnostic.
 *
 * Agent spawns hard-require the OneCLI credential gateway (container-runner's
 * buildContainerArgs calls ensureAgent/applyContainerConfig and refuses to
 * spawn without it). When the gateway is unreachable or too old for the
 * installed @onecli-sh/sdk, EVERY spawn fails the same silent way and rooms
 * look dead. This probes the gateway once at boot and logs the exact fix,
 * instead of leaving it to be reverse-engineered from 404/401/fetch-failed spam.
 *
 * Deliberately NON-FATAL: it logs loudly but never aborts startup — the gateway
 * may recover, non-OneCLI work may still function, and crash-looping the host on
 * a transient blip is worse than a warning.
 */
import { ONECLI_URL, ONECLI_API_KEY } from './config.js';
import { log } from './log.js';

const PROBE_TIMEOUT_MS = 5000;

export type PreflightVerdict = {
  level: 'info' | 'warn' | 'error';
  message: string;
};

/**
 * Map a gateway probe to a log verdict. Pure (no I/O) so it is unit-testable.
 *
 * `probe` is the HTTP status of `GET <ONECLI_URL>/v1/agents`, or `null` when the
 * request threw (unreachable), or `'unset'` when ONECLI_URL is absent. A 404
 * means the /v1 router doesn't exist → the gateway predates the SDK's API (the
 * version-coupling trap: SDK 2.x calls /v1/agents, an old gateway only has
 * /api/agents, so every ensureAgent 404s and nothing spawns). Any other status
 * (200/401/403/405) means /v1 is present → the gateway speaks the SDK's API.
 */
export function classifyGatewayProbe(probe: number | null | 'unset', url?: string): PreflightVerdict {
  if (probe === 'unset') {
    return {
      level: 'warn',
      message:
        'OneCLI: ONECLI_URL is not set — agent containers cannot obtain credentials and will fail to spawn ' +
        '(unless a native-credential path is configured). Set ONECLI_URL in .env (on Linux the gateway binds to ' +
        'the docker-bridge IP, e.g. http://172.17.0.1:10254, not 127.0.0.1).',
    };
  }
  if (probe === null) {
    return {
      level: 'error',
      message:
        `OneCLI: gateway at ${url} is UNREACHABLE — agent spawns will fail until it is reachable. Check: ` +
        '`docker ps` shows the onecli container healthy; `docker port onecli` binds the host:port in ONECLI_URL ' +
        '(on Linux it MUST be the docker-bridge IP, not 127.0.0.1 — set ONECLI_BIND_HOST in ~/.onecli/.env then ' +
        '`cd ~/.onecli && docker compose up -d`).',
    };
  }
  if (probe === 404) {
    return {
      level: 'error',
      message:
        `OneCLI: gateway at ${url} is too OLD for the installed @onecli-sh/sdk (no /v1 API — ensureAgent will 404, ` +
        'so NO agents will spawn and every room goes silent). Upgrade the gateway: ' +
        '`cd ~/.onecli && docker compose pull && docker compose up -d` (back up first: pg_dumpall + tar the ' +
        'app-data volume). Also bump the CLI: `curl -fsSL onecli.sh/cli/install | sh`.',
    };
  }
  return {
    level: 'info',
    message: `OneCLI: gateway reachable at ${url} (HTTP ${probe}) — credential path OK`,
  };
}

/** Probe the OneCLI gateway and log a single actionable verdict. Never throws. */
export async function preflightOneCLI(): Promise<void> {
  let probe: number | null | 'unset';
  if (!ONECLI_URL) {
    probe = 'unset';
  } else {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${ONECLI_URL.replace(/\/+$/, '')}/v1/agents`, {
          method: 'GET',
          headers: ONECLI_API_KEY ? { Authorization: `Bearer ${ONECLI_API_KEY}` } : {},
          signal: ctrl.signal,
        });
        probe = res.status;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      probe = null; // network error / timeout / DNS — unreachable
    }
  }
  const verdict = classifyGatewayProbe(probe, ONECLI_URL);
  log[verdict.level](verdict.message);
}
