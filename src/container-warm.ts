/**
 * Cold-spawn warmer — primes the host page cache for the agent image.
 *
 * Why: the first container spawn after a host restart / image rebuild pays a
 * cold-disk penalty that dwarfs the code path itself. Measured on a live
 * install (see docs/webchat/design/cold-spawn.md): `claude --version` inside
 * the image is ~1.8s with a cold page cache vs ~0.1s warm; the Claude SDK
 * subprocess start goes from 2.6–8.7s cold/loaded to 0.8–1.9s warm. The
 * overlayfs layers are ordinary host files, so the kernel page cache is
 * shared across every container of the image — one throwaway warm run at
 * service start moves that entire penalty off the first user message.
 *
 * The warmer is strictly off the critical path: fire-and-forget at host
 * startup, `--network none`, hard caps, never throws, and a failure only
 * means the first spawn is as slow as it always was.
 */
import { spawn } from 'child_process';
import path from 'path';

import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

/**
 * The in-container warm script. Touches exactly the files a real cold spawn
 * reads, in the same way it reads them:
 *
 *  - `bun -e import(...)` pulls the agent-runner module graph (poll loop,
 *    providers barrel incl. the Claude SDK's sdk.mjs/bridge.mjs, the MCP
 *    server tree) through bun's transpiler — the same ~0.5s of reads the
 *    runner does at boot.
 *  - `claude --version` faults in the Claude Code native binary the SDK
 *    subprocess execs on the first turn.
 *
 * Import failures are swallowed (`catch`) — a module that can't load without
 * a /workspace mount still had its bytes read, which is all warming needs.
 */
const WARM_SCRIPT =
  "cd /app && bun -e '" +
  'const w = (p) => import(p).catch(() => {});' +
  'await w("/app/src/providers/index.ts");' +
  'await w("/app/src/poll-loop.ts");' +
  'await w("/app/src/mcp-tools/server.ts");' +
  "' >/dev/null 2>&1; /pnpm/claude --version >/dev/null 2>&1; true";

/**
 * Build the `docker run` argv for the warm container. Pure — unit-tested
 * without a container runtime.
 */
export function buildWarmArgs(image: string, agentRunnerSrc: string): string[] {
  return [
    'run',
    '--rm',
    '--name',
    `nanoclaw-warm-${Date.now()}`,
    '--label',
    CONTAINER_INSTALL_LABEL,
    // No network: the warmer only reads image layers, it never talks to
    // anything. Also keeps it inert if the image entrypoint ever changes.
    '--network',
    'none',
    '--memory',
    '1g',
    '--entrypoint',
    'bash',
    '-v',
    `${agentRunnerSrc}:/app/src:ro`,
    image,
    '-c',
    WARM_SCRIPT,
  ];
}

let warmStarted = false;

/**
 * Fire-and-forget: spawn one warm container for the base agent image.
 * Per-group images are built FROM the base image, so their heavy layers
 * (bun, node_modules, the Claude Code binary) are the same host files —
 * warming the base warms them all.
 *
 * Never throws; a warm failure is logged at debug and costs nothing.
 */
export function warmAgentImage(): void {
  if (warmStarted) return;
  warmStarted = true;
  try {
    const agentRunnerSrc = path.join(process.cwd(), 'container', 'agent-runner', 'src');
    const args = buildWarmArgs(CONTAINER_IMAGE, agentRunnerSrc);
    const started = Date.now();
    const child = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: 'ignore' });
    child.on('close', (code) => {
      if (code === 0) {
        log.info('Agent image warmed (page cache primed for cold spawns)', {
          image: CONTAINER_IMAGE,
          ms: Date.now() - started,
        });
      } else {
        log.debug('Agent image warm run exited non-zero (harmless — first spawn just stays cold)', {
          image: CONTAINER_IMAGE,
          code,
        });
      }
    });
    child.on('error', (err) => {
      log.debug('Agent image warm spawn failed (harmless)', { err });
    });
  } catch (err) {
    log.debug('Agent image warm setup failed (harmless)', { err });
  }
}
