/**
 * Grok provider container config — host side.
 *
 * One job, and it is load-bearing: give the container a PERSISTENT `~/.grok`.
 *
 * WHY THAT IS NOT OPTIONAL. The provider's continuation token is an ACP
 * sessionId, and Grok resolves that id against its own on-disk session store at
 * `~/.grok/sessions`. Phase 2 verified a sessionId survives a PROCESS restart —
 * but a container's home is ephemeral, so without a mount every container
 * restart would silently invalidate every stored continuation. The agent would
 * keep its memory of the conversation in nanoclaw's DB while Grok had forgotten
 * it, and the next turn would fail `session/load` instead of resuming. Mounting
 * the grok home turns "survives a process restart" into "survives a container
 * restart", which is the property that actually matters here.
 *
 * The same directory holds `auth.json` (the device-code session), so a group
 * authenticates once rather than once per container.
 *
 * It is per-AGENT-GROUP, not per-session, and sits beside `.claude-shared` for
 * exactly the same reasons: sessions of one group share an identity, and the
 * store must outlive any single session.
 *
 * NO PROXY BYPASS — the absence is the decision. Grok talks to a remote,
 * authenticated endpoint, so it stays on the OneCLI path where credentials can
 * be injected on the wire. This is the INVERSE of the local-model providers,
 * which NO_PROXY around the gateway to reach a host-local server.
 *
 * SSL_CERT_FILE IS WHAT MAKES THAT TRUE RATHER THAN NOMINAL. The gateway can
 * only inject a credential if it can terminate TLS, which requires the client to
 * trust its CA. applyContainerConfig sets NODE_EXTRA_CA_CERTS — Node-only — and
 * the grok CLI is a native binary, so without this it does not trust the proxy,
 * the request tunnels straight through, and nothing is ever injected. Measured:
 * with the CA trusted, a container holding a deliberately INVALID token still
 * completed a turn because the gateway swapped the Authorization header; without
 * it, the same request reached grok.com unmodified and returned
 * `credential_not_found`. So this line is the difference between being on the
 * credential path and merely appearing to be.
 *
 * Scoped to grok's own containers by virtue of being a provider contribution —
 * it does not change the trust store for groups running any other harness.
 *
 * NOT `providesAgentSurfaces`. Grok reads CLAUDE.md and AGENTS.md from the cwd
 * natively (verified with `grok inspect`), so the host's default surfaces are
 * already the right ones — this provider composes nothing of its own.
 *
 * CREDENTIALS are materialised here too, per spawn: the host keeps the refresh
 * token outside this mount and writes only a short-lived access token into it
 * (grok-auth.ts). So the writable home below carries a session store and a
 * bounded-lifetime token, never the renewable credential itself.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { materializeContainerAuth, startGrokCredentialRefresh } from './grok-auth.js';
import { onHostStart } from '../host-lifecycle.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Container-side home for the grok CLI. Fixed by the CLI, not by us. */
export const GROK_HOME_CONTAINER_PATH = '/home/node/.grok';

/**
 * Where the OneCLI SDK mounts its proxy CA inside the container.
 *
 * Coupled to the SDK's choice (applyContainerConfig mounts it here and points
 * NODE_EXTRA_CA_CERTS at it). Duplicated because the provider's config fn runs
 * BEFORE that call, so there is nothing to read it from.
 */
export const ONECLI_CA_CONTAINER_PATH = '/tmp/onecli-gateway-ca.pem';

/** Per-group host directory backing that home. Beside `.claude-shared`. */
export function grokSharedDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.grok-shared');
}

/**
 * Create the group's grok home if absent.
 *
 * 0700 because this directory holds `auth.json` — a live subscription refresh
 * token. The CLI itself writes that file 0600; the directory guard is ours, so
 * a permissive host umask cannot widen it.
 */
export function ensureGrokSharedDir(agentGroupId: string): string {
  const dir = grokSharedDir(agentGroupId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is subject to umask, and it is a no-op when the directory
  // already exists — so state the mode explicitly either way.
  fs.chmodSync(dir, 0o700);
  return dir;
}

registerProviderContainerConfig('grok', (ctx) => {
  const hostPath = ensureGrokSharedDir(ctx.agentGroupId);

  // Refresh the container's copy of the access token on every spawn. A group
  // that has never authenticated simply has nothing to write — that is the
  // un-authenticated case, handled by the setup walk-through, not an error to
  // fail a spawn over.
  const wrote = materializeContainerAuth(ctx.agentGroupId, hostPath, {
    onError: (err) =>
      log.warn(
        `Grok token refresh failed for agent group ${ctx.agentGroupId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
  });
  if (!wrote) {
    log.warn(`Grok: no host credentials for agent group ${ctx.agentGroupId} — run the Grok auth walk-through`);
  }

  return {
    mounts: [{ hostPath, containerPath: GROK_HOME_CONTAINER_PATH, readonly: false }],
    env: { SSL_CERT_FILE: ONECLI_CA_CONTAINER_PATH },
  };
});

/**
 * Keep credentials alive on a timer, not only when a container spawns.
 *
 * A spawn-gated refresh renews a 6h token only if something happens to use Grok
 * inside that window. An install whose Grok agents idle overnight therefore
 * wakes up expired — which is precisely what happened here: the wizard reported
 * "not connected" on a credential whose refresh token was still perfectly good.
 *
 * Registered at host start rather than on import so it starts with the rest of
 * the host, and skipped entirely when this install has no Grok credentials —
 * the sweep reads nothing and does nothing.
 */
onHostStart(() => {
  startGrokCredentialRefresh({
    onInfo: (message) => log.info(message),
    onError: (message) => log.warn(message),
  });
});
