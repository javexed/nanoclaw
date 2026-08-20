/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */

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
