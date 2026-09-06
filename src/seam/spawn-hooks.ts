// Module seams for the spawn path. Installed modules register here to shape
// how a session's container spawns, without patching the spawn code. Core
// ships with nothing registered: every resolver falls back to upstream's
// behavior, and a registered hook that throws is isolated — it must never
// break spawning.
import { INSTALL_SLUG } from '../config.js';
import { log } from '../log.js';
import type { Session } from '../types.js';

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

export function __snapshotAgentIdentityResolversForTest(): () => void {
  const saved = [...agentIdentityResolvers];
  return () => {
    agentIdentityResolvers.length = 0;
    agentIdentityResolvers.push(...saved);
  };
}

/**
 * The gateway contribution's `key`, with the agent identity a module may have
 * re-pointed. Spread LAST into the contribute() literal so it overrides
 * upstream's `key` line without that line changing; `{}` — upstream's key
 * stands — whenever no module claims a different identity. The gateway uses
 * key.agentGroupId as the OneCLI agent, so a per-member session gets THAT
 * member's credential injected; with no resolver this equals upstream's key.
 */
export function seamGatewayKey(
  agentGroupId: string,
  threadId: string | null,
  sessionId: string,
): { key?: { installSlug: string; agentGroupId: string; sessionId: string } } {
  const agentIdentifier = resolveAgentIdentity(agentGroupId, threadId);
  if (agentIdentifier == null || agentIdentifier === agentGroupId) return {};
  return { key: { installSlug: INSTALL_SLUG, agentGroupId: agentIdentifier, sessionId } };
}

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

export function __snapshotContainerEnvResolversForTest(): () => void {
  const saved = [...containerEnvResolvers];
  return () => {
    containerEnvResolvers.length = 0;
    containerEnvResolvers.push(...saved);
  };
}

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

/**
 * Observers fired when a session's container exits or fails to spawn. An
 * installed module reacts to the session going away (e.g. reconcile UI state
 * it derived from the running container). Fire-and-forget and isolated: a
 * throwing observer can never affect container lifecycle. Core ships none.
 *
 * Fires from the driver's terminal callback only — at most once per session,
 * and only on ends the host did not request, so an observer never has to work
 * out whether a stop was intentional.
 */
type ContainerExitObserver = (session: Session) => void | Promise<void>;
const containerExitObservers: ContainerExitObserver[] = [];
export function registerContainerExitObserver(fn: ContainerExitObserver): void {
  containerExitObservers.push(fn);
}
export function notifyContainerExit(session: Session): void {
  for (const fn of containerExitObservers) {
    try {
      void Promise.resolve(fn(session)).catch((err) =>
        log.warn('Container exit observer failed', { sessionId: session.id, err: String(err) }),
      );
    } catch (err) {
      log.warn('Container exit observer failed', { sessionId: session.id, err: String(err) });
    }
  }
}
