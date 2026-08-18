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
 * authenticated endpoint (api.x.ai), so it stays on the OneCLI path where
 * credentials are injected on the wire. This is the INVERSE of the local-model
 * providers, which NO_PROXY around the gateway to reach a host-local server.
 * Adding a bypass here would route subscription traffic outside the credential
 * gateway.
 *
 * NOT `providesAgentSurfaces`. Grok reads CLAUDE.md and AGENTS.md from the cwd
 * natively (verified with `grok inspect`), so the host's default surfaces are
 * already the right ones — this provider composes nothing of its own.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Container-side home for the grok CLI. Fixed by the CLI, not by us. */
export const GROK_HOME_CONTAINER_PATH = '/home/node/.grok';

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
  return {
    mounts: [{ hostPath, containerPath: GROK_HOME_CONTAINER_PATH, readonly: false }],
  };
});
