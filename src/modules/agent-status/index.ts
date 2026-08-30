/**
 * Agent activity status forwarding — the thinking bubble's host side.
 *
 * The agent-runner records fine-grained activity for the current turn (tool
 * in use, progress milestones, reasoning summaries) into an append-only
 * `status_events` table in the session's outbound.db (status-feed.ts). This
 * module tails that table on the delivery poll and forwards each new row to
 * the channel adapter via `sendStatus`, so a rich client (webchat) can render
 * a live "thinking" bubble. Purely cosmetic: it never touches routing,
 * delivery, or lifecycle, and any failure is swallowed.
 *
 * The predecessor registered on seam hook registries; nanoclaw-web calls it
 * DIRECTLY: delivery.ts calls agentStatusSweep(session) after each session's
 * delivery drain, and container-runner calls notifySessionStopped(session)
 * on container exit. Channels with no status surface simply don't implement
 * sendStatus, so the forward is a no-op for them. Redaction of forwarded
 * text is the channel's responsibility (webchat scrubs before broadcasting).
 *
 * status_events is read directly from the outbound sqlite file rather than
 * through the mailbox abstraction: the table is module-owned, the reads are
 * read-only + best-effort, and threading a cosmetic feed through the mailbox
 * contract would put it on the delivery critical path it must never touch.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

import type { Session } from '../../types.js';
import type { AgentActivityStatus } from '../../channels/adapter.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { isContainerRunning } from '../../container-runner.js';

export interface StatusAdapter {
  sendStatus?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    status: AgentActivityStatus,
    instance?: string,
  ): Promise<void>;
}

let adapter: StatusAdapter | null = null;

/** Bind to the delivery adapter. Called once by src/delivery.ts at startup. */
export function setStatusAdapter(a: StatusAdapter): void {
  adapter = a;
}

/**
 * Per-session high-water mark: the seq of the last status event we've already
 * forwarded. On first sight of a session we seed it with the current MAX so a
 * host restart doesn't replay a turn's backlog — only genuinely new activity
 * (including all activity in subsequent turns, since seq is monotonic) flows.
 */
const watermarks = new Map<string, number>();
// Guards against the 1s active poll and 60s sweep poll forwarding a session's
// frames concurrently (delivery.ts calls this after each deliverSessionMessages).
const sweeping = new Set<string>();

/**
 * Sessions with a turn currently in progress (a 'start' was forwarded, no
 * 'done' yet). Lets notifySessionStopped tell a mid-turn death (warn the
 * room) from a clean idle exit after a completed turn (stay silent).
 */
const turnActive = new Set<string>();

/**
 * Sessions whose orphaned bubble we've already cleared via
 * reconcileStaleBubble. Prevents re-emitting a synthetic 'done' every poll;
 * re-armed when a fresh 'start' reopens the turn.
 */
const cleared = new Set<string>();

// 'start' rides the container's status feed; 'stalled' is host-generated (see
// notifySessionStopped) and never appears in the feed.
const VALID_KINDS = new Set<AgentActivityStatus['kind']>(['start', 'tool', 'progress', 'reasoning', 'done']);

function openOutboundReadonly(session: Session): Database.Database | null {
  const p = outboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(p)) return null;
  try {
    return new Database(p, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/**
 * Read and forward any new status events for a session. Called by
 * delivery.ts after each session's delivery drain. Best-effort: swallows
 * everything — a cosmetic feed must never break delivery.
 */
export async function agentStatusSweep(session: Session): Promise<void> {
  if (!adapter?.sendStatus) return;
  if (sweeping.has(session.id)) return; // a concurrent poll is already draining this session
  sweeping.add(session.id);
  try {
    await agentStatusSweepInner(session);
  } finally {
    sweeping.delete(session.id);
  }
}

async function agentStatusSweepInner(session: Session): Promise<void> {
  const sendStatus = adapter?.sendStatus;
  if (!sendStatus) return;
  const mg = await (session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined);
  if (!mg || !mg.platform_id) return;

  // Attribute every frame to its agent so a multi-agent room renders one
  // bubble per agent (the client keys bubbles by name).
  const agentName = (await getAgentGroup(session.agent_group_id))?.name ?? null;

  const outDb = openOutboundReadonly(session);
  if (!outDb) return;

  try {
    const seen = watermarks.get(session.id);
    if (seen === undefined) {
      // First sight — seed the watermark and forward nothing (skip backlog).
      watermarks.set(session.id, getMaxStatusEventSeq(outDb));
    } else {
      const events = getStatusEventsSince(outDb, seen);
      if (events.length > 0) {
        // Advance the watermark before awaiting any send so a slow/failed
        // send can't re-forward the same row on the next tick.
        watermarks.set(session.id, events[events.length - 1]!.seq);

        for (const ev of events) {
          const kind = ev.kind as AgentActivityStatus['kind'];
          if (!VALID_KINDS.has(kind)) continue;
          // Track turn boundaries so a mid-turn container death can be told
          // from a clean idle exit (see notifySessionStopped).
          if (kind === 'start') {
            turnActive.add(session.id);
            cleared.delete(session.id); // a fresh turn re-arms reconcile
          } else if (kind === 'done') turnActive.delete(session.id);
          try {
            await sendStatus(
              mg.channel_type,
              mg.platform_id,
              session.thread_id ?? null,
              { kind, text: ev.text, detail: ev.detail, agentName },
              mg.instance,
            );
          } catch {
            // Per-event best-effort.
          }
        }
      }
    }

    // Clear a stuck "thinking" bubble: a turn that ended without 'done' and
    // has no live container left an orphaned bubble (a host restart wipes the
    // in-memory tracking above; ungraceful deaths never write 'done'). Runs
    // every tick so it also recovers bubbles orphaned across a restart.
    await reconcileStaleBubble(session, outDb, agentName, mg);
  } catch {
    // Cosmetic — ignore.
  } finally {
    try {
      outDb.close();
    } catch {
      /* ignore */
    }
  }
}

async function reconcileStaleBubble(
  session: Session,
  outDb: Database.Database,
  agentName: string | null,
  mg: { channel_type: string; platform_id: string; instance?: string },
): Promise<void> {
  const last = getLastStatusEvent(outDb);
  if (!last || last.kind === 'done') {
    cleared.delete(session.id); // healthy / no open turn — allow a future reconcile
    return;
  }
  if (cleared.has(session.id)) return; // already cleared this orphan
  if (isContainerRunning(session.id)) return; // genuine in-flight turn — real bubble
  cleared.add(session.id);
  turnActive.delete(session.id);
  if (!adapter?.sendStatus) return;
  try {
    await adapter.sendStatus(
      mg.channel_type,
      mg.platform_id,
      session.thread_id ?? null,
      { kind: 'done', text: null, detail: null, agentName },
      mg.instance,
    );
  } catch {
    // Cosmetic — ignore.
  }
}

/**
 * Called by container-runner when a session's container exits (normal,
 * crash, or ceiling-kill). If a turn was in progress, the agent died
 * mid-turn — tell the room with a 'stalled' notice so the bubble clears with
 * an explanation instead of vanishing silently. Clean idle exits no-op.
 */
export async function notifySessionStopped(session: Session): Promise<void> {
  const wasMidTurn = turnActive.has(session.id);
  // Container is gone — forget the session so watermarks/turnActive/cleared
  // don't grow one dead entry per session for the host's lifetime.
  watermarks.delete(session.id);
  turnActive.delete(session.id);
  cleared.delete(session.id);
  if (!wasMidTurn) return; // clean exit — nothing to warn about
  if (!adapter?.sendStatus) return;

  const mg = await (session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined);
  if (!mg || !mg.platform_id) return;

  try {
    await adapter.sendStatus(
      mg.channel_type,
      mg.platform_id,
      session.thread_id ?? null,
      {
        kind: 'stalled',
        text: 'The agent stopped responding. You may want to resend your message.',
        detail: null,
        agentName: (await getAgentGroup(session.agent_group_id))?.name ?? null,
      },
      mg.instance,
    );
  } catch {
    // Best-effort.
  }
}

// ── status_events readers ────────────────────────────────────────────────────

export interface StatusEvent {
  seq: number;
  kind: string;
  text: string | null;
  detail: string | null;
}

/** Rows past the host's per-session watermark. [] when the table is absent. */
export function getStatusEventsSince(outDb: Database.Database, sinceSeq: number): StatusEvent[] {
  try {
    return outDb
      .prepare('SELECT seq, kind, text, detail FROM status_events WHERE seq > ? ORDER BY seq ASC')
      .all(sinceSeq) as StatusEvent[];
  } catch {
    return []; // table not present on older session DBs
  }
}

/** The latest event's seq + kind, or undefined when the table is empty/absent. */
export function getLastStatusEvent(outDb: Database.Database): { seq: number; kind: string } | undefined {
  try {
    return outDb.prepare('SELECT seq, kind FROM status_events ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; kind: string }
      | undefined;
  } catch {
    return undefined;
  }
}

/** Current max seq, or 0 when the table is empty/absent — the restart watermark seed. */
export function getMaxStatusEventSeq(outDb: Database.Database): number {
  try {
    const row = outDb.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM status_events').get() as { m: number };
    return row.m;
  } catch {
    return 0;
  }
}
