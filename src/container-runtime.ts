/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

// ── Module seams for the spawn path ──────────────────────────────────────────
// Installed modules register here to shape how a session's container spawns,
// without patching the spawn code. Core ships with nothing registered: every
// resolver falls back to today's behavior, and a registered hook that throws
// is isolated — it must never break spawning.

/**
 * Optional override for a session's OneCLI agent identity. Lets an installed
 * module spawn a specific session under a different credential identity than
 * the agent group's default (e.g. a per-member session under that member's
 * own agent, so the gateway injects THEIR key). Core ships with no resolver →
 * identity stays `agentGroup.id`.
 */
type AgentIdentityResolver = (agentGroupId: string, threadId: string | null) => string | null;
const agentIdentityResolvers: AgentIdentityResolver[] = [];
export function registerAgentIdentityResolver(fn: AgentIdentityResolver): void {
  agentIdentityResolvers.push(fn);
}
export function resolveAgentIdentity(agentGroupId: string, threadId: string | null): string | null {
  // Decision chain: resolvers are asked in registration order and the first
  // non-null claim wins. (The old single-slot shape let a later registration
  // silently REPLACE an earlier module's resolver — for the credential
  // boundary that meant sessions the first module would have claimed fell
  // back to the workspace identity: a quiet credential-scope downgrade.)
  for (const fn of agentIdentityResolvers) {
    let id: string | null;
    try {
      id = fn(agentGroupId, threadId);
    } catch {
      continue; // a resolver bug must never break spawning
    }
    if (id == null) continue;
    // OneCLI identifiers are lowercase [a-z0-9-]. Reject a malformed claim
    // HERE as a named module bug — otherwise it surfaces later as a
    // confusing gateway error mid-spawn.
    if (!/^[a-z0-9-]+$/.test(id)) {
      log.warn('agent identity resolver returned a malformed identifier — ignoring', { agentGroupId, threadId, id });
      continue;
    }
    return id;
  }
  return null;
}

/** Test support: snapshot + restore the identity-resolver chain. */
export function __snapshotAgentIdentityResolversForTest(): () => void {
  const saved = [...agentIdentityResolvers];
  return () => {
    agentIdentityResolvers.length = 0;
    agentIdentityResolvers.push(...saved);
  };
}

/**
 * Extra container env vars contributed by an installed module for a specific
 * (agent group, session). Applied AFTER the core env so they take precedence
 * (last `-e` wins). Resolvers compose — registration order, later wins per
 * key. Core ships with none → {}.
 */
type ContainerEnvResolver = (agentGroupId: string, threadId: string | null) => Record<string, string>;
const containerEnvResolvers: ContainerEnvResolver[] = [];
export function registerContainerEnvResolver(fn: ContainerEnvResolver): void {
  containerEnvResolvers.push(fn);
}
export function resolveContainerEnv(agentGroupId: string, threadId: string | null): Record<string, string> {
  // Resolvers compose like the config augmentors below: registration order,
  // later wins per key. A throwing resolver loses only its own contribution —
  // a module bug must never break spawning.
  const merged: Record<string, string> = {};
  for (const fn of containerEnvResolvers) {
    try {
      Object.assign(merged, fn(agentGroupId, threadId));
    } catch {
      // skip this resolver's contribution
    }
  }
  return merged;
}

/** Test support: snapshot + restore the env-resolver registry (vitest runs share module state). */
export function __snapshotContainerEnvResolversForTest(): () => void {
  const saved = [...containerEnvResolvers];
  return () => {
    containerEnvResolvers.length = 0;
    containerEnvResolvers.push(...saved);
  };
}

/**
 * Extra `container.json` fields contributed by installed modules for an agent
 * group, merged into the materialized config at spawn — following the
 * architecture rule that NanoClaw-specific config travels in container.json
 * (read by the runner) rather than as env vars. Augmentors compose (later
 * registrations merge over earlier ones); core ships with none, so the result
 * is `{}` and container.json is unchanged.
 */
type ContainerConfigAugmentor = (agentGroupId: string) => Record<string, unknown>;
const containerConfigAugmentors: ContainerConfigAugmentor[] = [];
export function registerContainerConfigAugmentor(fn: ContainerConfigAugmentor): void {
  containerConfigAugmentors.push(fn);
}
export function resolveContainerConfigAugmentation(agentGroupId: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const fn of containerConfigAugmentors) {
    try {
      Object.assign(merged, fn(agentGroupId));
    } catch {
      // An augmentor bug must never break spawning — skip its contribution.
    }
  }
  return merged;
}

/**
 * Async pre-spawn hooks contributed by installed modules, run once just before
 * a session's container is spawned (e.g. lazy provisioning: create per-session
 * credentials so the identity/env resolvers above find them ready). Hook
 * failures are logged and swallowed — they must never break spawning. Core
 * ships with no hooks → no-op.
 */
type SessionPrepareHook = (agentGroupId: string, threadId: string | null) => Promise<void>;
const sessionPrepareHooks: SessionPrepareHook[] = [];
export function registerSessionPrepareHook(fn: SessionPrepareHook): void {
  sessionPrepareHooks.push(fn);
}
export async function runSessionPrepareHooks(agentGroupId: string, threadId: string | null): Promise<void> {
  for (const fn of sessionPrepareHooks) {
    try {
      await fn(agentGroupId, threadId);
    } catch (err) {
      log.warn('session prepare hook failed', { agentGroupId, threadId, err: String(err) });
    }
  }
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
