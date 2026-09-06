// Module seams for session resolution. Installed modules register here to
// re-key a turn to a different session, veto a delivery before any session
// exists, or own the inbound write for a session they re-keyed. Core ships
// with nothing registered: every resolver falls back to upstream's behavior,
// and a registered hook that throws is isolated — it must never break routing.
import { log } from '../log.js';
import type { Session } from '../types.js';

type MessagingGroupKey = { id: string; channel_type: string; platform_id: string; is_group?: number };

/** Session keying mode (mirrors sessions.session_mode). */
export type SessionMode = 'shared' | 'per-thread' | 'agent-shared';

/**
 * Optional per-message session-key override, registered by an installed
 * module. Given the messaging group + agent + resolved sender, it can
 * redirect the turn to a different session (mode + threadId) — e.g. a
 * per-member session keyed by userId, so each person's turns run in a
 * container bearing their own credential identity. Core ships with no
 * resolver (null → unchanged keying).
 */
export interface SessionKeyOverride {
  sessionMode: SessionMode;
  threadId: string | null;
}
type SessionKeyResolver = (
  mg: MessagingGroupKey,
  agentGroupId: string,
  userId: string | null,
  /**
   * The thread this turn arrived on, BEFORE any override (null = the room's
   * main thread). A resolver that re-keys by user needs it to key by
   * (user, thread) instead of collapsing every thread in a room into one
   * session — without it, messages from the room and from a topic thread
   * share one queue and replies come back on the wrong one. Additive and
   * last, so existing resolvers are unaffected.
   */
  threadId?: string | null,
) => SessionKeyOverride | null | Promise<SessionKeyOverride | null>;
const sessionKeyResolvers: SessionKeyResolver[] = [];
export function registerSessionKeyResolver(fn: SessionKeyResolver): void {
  sessionKeyResolvers.push(fn);
}
export async function resolveSessionKeyOverride(
  mg: MessagingGroupKey,
  agentGroupId: string,
  userId: string | null,
  threadId?: string | null,
): Promise<SessionKeyOverride | null> {
  // Decision chain: first non-null override wins; a throwing resolver is
  // skipped (a resolver bug must never break routing). Async since the DB went
  // async — a resolver that consults credential state has to await it, and the
  // one caller (the router) is already in an async context.
  for (const fn of sessionKeyResolvers) {
    let override: SessionKeyOverride | null;
    try {
      override = await fn(mg, agentGroupId, userId, threadId ?? null);
    } catch {
      continue;
    }
    if (!override) continue;
    // Reserved namespace guard: the router strips event-derived thread ids
    // that collide with 'system:%' (task sessions) — an override must not
    // reopen that door. Ignore the claim and fall through.
    if (override.threadId && override.threadId.startsWith('system:')) {
      log.warn('session-key override targeted the reserved system:% namespace — ignoring', {
        agentGroupId,
        threadId: override.threadId,
      });
      continue;
    }
    return override;
  }
  return null;
}

/**
 * Turn gates: a module may VETO a delivery before a session is resolved
 * (e.g. a policy that requires per-user setup before an agent may act for
 * this sender). Deliberately separate from the session-key resolver so the
 * veto power is visible in the API. On veto the router records a dropped
 * message with the module's `reason`; any user-facing notice is the vetoing
 * module's own responsibility (it knows its surface). First veto wins; a
 * throwing gate is skipped. Core ships none.
 */
export interface TurnVeto {
  /** Machine-readable reason recorded on the dropped message. */
  reason: string;
}
type TurnGate = (
  mg: MessagingGroupKey,
  agentGroupId: string,
  userId: string | null,
) => TurnVeto | null | Promise<TurnVeto | null>;
const turnGates: TurnGate[] = [];
export function registerTurnGate(fn: TurnGate): void {
  turnGates.push(fn);
}
export async function consultTurnGates(
  mg: MessagingGroupKey,
  agentGroupId: string,
  userId: string | null,
): Promise<TurnVeto | null> {
  for (const fn of turnGates) {
    try {
      const veto = await fn(mg, agentGroupId, userId);
      if (veto) return veto;
    } catch {
      // a gate bug must never break routing — skip it
    }
  }
  return null;
}

/**
 * Optional session inbound writer. For a key-overridden session's wake turn,
 * the module may write the inbound itself (e.g. syncing the full shared-room
 * transcript into the per-member session so the responding agent has the
 * whole conversation: current message → trigger=1, the rest → trigger=0
 * context). Returns true if it handled the write; the router then skips its
 * normal single-message write. Core ships with no writer.
 */
export interface SessionInboundWriterArgs {
  agentGroupId: string;
  session: Session;
  roomId: string;
  currentMessageId: string;
  deliveryAddr: { platformId: string | null; channelType: string | null; threadId: string | null };
}
type SessionInboundWriter = (args: SessionInboundWriterArgs) => boolean | Promise<boolean>;
const sessionInboundWriters: SessionInboundWriter[] = [];
export function registerSessionInboundWriter(fn: SessionInboundWriter): void {
  sessionInboundWriters.push(fn);
}
export async function runSessionInboundWriter(args: SessionInboundWriterArgs): Promise<boolean> {
  // First writer to return true claims the write (writers decline sessions
  // they don't own); a throwing writer falls through to the next, and to the
  // router's normal single-message write if none claim it. Async since the DB
  // went async — the await matters doubly here: an un-awaited writer would
  // look unclaimed (a promise is not === true) and the router would write a
  // SECOND copy of everything the writer synced.
  for (const fn of sessionInboundWriters) {
    try {
      if (await fn(args)) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}
