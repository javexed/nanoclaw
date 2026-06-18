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

/** Bind to the delivery adapter. Called once by src/delivery.ts. */
export function setStatusAdapter(a: StatusAdapter): void {
  adapter = a;
}

const VALID_KINDS = new Set<AgentActivityStatus['kind']>(['tool', 'progress', 'reasoning', 'done']);

/**
 * Read and forward any new status events for a session. Best-effort: opens the
 * outbound DB read-only, reads past the watermark, and pushes each row to the
 * adapter. Swallows everything — a cosmetic feed must never break delivery.
 */
export async function forwardSessionStatus(session: Session): Promise<void> {
  if (!adapter?.sendStatus) return;

  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!mg || !mg.platform_id) return;

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
      try {
        await adapter.sendStatus(
          mg.channel_type,
          mg.platform_id,
          null,
          { kind, text: ev.text, detail: ev.detail },
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

/** Forget a session's watermark when it's torn down so the Map can't leak. */
export function stopSessionStatus(sessionId: string): void {
  watermarks.delete(sessionId);
}
