/**
 * Agent activity status forwarding — default module.
 *
 * The agent-runner records fine-grained activity for the current turn (tool in
 * use, progress milestones, reasoning summaries) into an append-only
 * `status_events` table in the session's outbound.db. This module tails that
 * table on the delivery poll and forwards each new row to the channel adapter
 * via `sendStatus`, so a rich client (webchat) can render a live "thinking"
 * bubble. It is purely cosmetic: it never touches routing, delivery, or
 * lifecycle, and any failure is swallowed.
 *
 * Channels with no status surface simply don't implement `sendStatus`, so the
 * forward is a no-op for them. Redaction of the forwarded text is the channel's
 * responsibility (webchat scrubs before broadcasting to clients).
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not core); ships on main, imported
 *     directly by src/delivery.ts. No registry, no hook.
 *   - Removing requires dropping the calls in src/delivery.ts.
 */
import type { Session } from '../../types.js';
import type { AgentActivityStatus } from '../../channels/adapter.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { openOutboundDb } from '../../session-manager.js';
import { getMaxStatusEventSeq, getStatusEventsSince } from '../../db/session-db.js';

interface StatusAdapter {
  sendStatus?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    status: AgentActivityStatus,
    instance?: string,
  ): Promise<void>;
}

let adapter: StatusAdapter | null = null;

/**
 * Per-session high-water mark: the seq of the last status event we've already
 * forwarded. On first sight of a session we seed it with the current MAX so a
 * host restart doesn't replay a turn's backlog — only genuinely new activity
 * (including all activity in subsequent turns, since seq is monotonic) flows.
 */
const watermarks = new Map<string, number>();

/**
 * Sessions with a turn currently in progress (a 'start' was forwarded, no
 * 'done' yet). Lets notifySessionStopped tell a mid-turn death (warn the room)
 * from a clean idle exit after a completed turn (stay silent).
 */
const turnActive = new Set<string>();

/** Bind to the delivery adapter. Called once by src/delivery.ts. */
export function setStatusAdapter(a: StatusAdapter): void {
  adapter = a;
}

// 'start' rides the container's status feed; 'stalled' is host-generated (see
// notifySessionStopped) and never appears in the feed.
const VALID_KINDS = new Set<AgentActivityStatus['kind']>(['start', 'tool', 'progress', 'reasoning', 'done']);

/**
 * Read and forward any new status events for a session. Best-effort: opens the
 * outbound DB read-only, reads past the watermark, and pushes each row to the
 * adapter. Swallows everything — a cosmetic feed must never break delivery.
 */
export async function forwardSessionStatus(session: Session): Promise<void> {
  if (!adapter?.sendStatus) return;

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || !mg.platform_id) return;

  // Attribute every frame to its agent so a multi-agent room renders one bubble
  // per agent (the webchat keys bubbles by name).
  const agentName = getAgentGroup(session.agent_group_id)?.name ?? null;

  let outDb;
  try {
    outDb = openOutboundDb(session.agent_group_id, session.id);
  } catch {
    return; // DB not created yet
  }

  try {
    const seen = watermarks.get(session.id);
    if (seen === undefined) {
      // First sight — seed the watermark and forward nothing (skip backlog).
      watermarks.set(session.id, getMaxStatusEventSeq(outDb));
      return;
    }

    const events = getStatusEventsSince(outDb, seen);
    if (events.length === 0) return;

    // Advance the watermark before awaiting any send so a slow/failed send
    // can't cause the same row to be re-forwarded on the next tick.
    watermarks.set(session.id, events[events.length - 1]!.seq);

    for (const ev of events) {
      const kind = ev.kind as AgentActivityStatus['kind'];
      if (!VALID_KINDS.has(kind)) continue;
      // Track turn boundaries so a mid-turn container death can be told from a
      // clean idle exit (see notifySessionStopped).
      if (kind === 'start') turnActive.add(session.id);
      else if (kind === 'done') turnActive.delete(session.id);
      try {
        await adapter.sendStatus(
          mg.channel_type,
          mg.platform_id,
          null,
          { kind, text: ev.text, detail: ev.detail, agentName },
          mg.instance,
        );
      } catch {
        // Per-event best-effort.
      }
    }
  } catch {
    // Cosmetic — ignore.
  } finally {
    try {
      outDb.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Called by the host when a session's container exits (normal, crash, or
 * ceiling-kill). If a turn was in progress (we forwarded 'start' but never
 * 'done'), the agent died mid-turn — tell the room with a 'stalled' notice so
 * the bubble clears with an explanation instead of vanishing silently. A clean
 * idle exit after a completed turn is a no-op. Best-effort and idempotent.
 */
export async function notifySessionStopped(session: Session): Promise<void> {
  if (!turnActive.has(session.id)) return; // clean exit, or already handled
  turnActive.delete(session.id);
  if (!adapter?.sendStatus) return;

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || !mg.platform_id) return;

  try {
    await adapter.sendStatus(
      mg.channel_type,
      mg.platform_id,
      null,
      {
        kind: 'stalled',
        text: 'The agent stopped responding. You may want to resend your message.',
        detail: null,
        agentName: getAgentGroup(session.agent_group_id)?.name ?? null,
      },
      mg.instance,
    );
  } catch {
    // Best-effort.
  }
}

/** Forget a session's tracking when it's torn down so the maps can't leak. */
export function stopSessionStatus(sessionId: string): void {
  watermarks.delete(sessionId);
  turnActive.delete(sessionId);
}
