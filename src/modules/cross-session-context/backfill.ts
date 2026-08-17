/**
 * New-session backfill — the pull half of cross-session context.
 *
 * The fan-out layer (fan.ts) pushes echoes only into sessions that EXIST at
 * delivery time, so a brand-new per-thread DM session is born blind: the user
 * replies to something the agent just said in another thread (live-hit: the
 * welcome message tour offer) and the fresh session has no idea. At session
 * birth we seed the new session with the most recent user-facing exchanges
 * from sibling sessions of the SAME messaging group — identical audience, so
 * the same privacy argument as the dm-thread fan applies.
 *
 * Bounded: last BACKFILL_LIMIT rows across all siblings, echo truncation as
 * usual. Rows are trigger=0 session-echo rows written BEFORE the triggering
 * message (lower seq → the formatter renders them first, as ambient context).
 */
import fs from 'fs';

import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openOutboundDb, withInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { ECHO_CHANNEL_TYPE, ECHO_TIMELINE_SURFACE } from './config.js';
import { truncateEchoText } from './fan.js';

export const BACKFILL_LIMIT = 12;

interface BackfillRow {
  timestamp: string;
  sender: string;
  senderId: string;
  text: string;
  /** Row authored by the agent itself — rendered as "you" in the prelude. */
  self: boolean;
}

function parseContent(raw: string): { text?: string; sender?: string; senderId?: string; echo?: unknown } {
  try {
    return JSON.parse(raw) as { text?: string; sender?: string; senderId?: string; echo?: unknown };
  } catch {
    return {};
  }
}

/**
 * TOP-LEVEL timeline rows from one sibling session — what a human sees
 * scrolling the DM's Messages tab, not the interiors of other threads:
 *  - the session's ROOT user message (per-thread sessions: the first
 *    triggering chat row IS the conversation opener), and
 *  - top-level agent posts (outbound with an empty/absent thread — e.g. the
 *    welcome message), which start conversations of their own.
 * Thread replies stay in their threads; deep conversations contribute one
 * line here, not their whole tail.
 */
function collectSiblingTopLevel(agentGroup: AgentGroup, sessionId: string, limit: number): BackfillRow[] {
  const rows: BackfillRow[] = [];
  if (fs.existsSync(inboundDbPath(agentGroup.id, sessionId))) {
    const inbound = withInboundDb(agentGroup.id, sessionId, (db) =>
      db
        .prepare(
          "SELECT timestamp, content FROM messages_in WHERE kind IN ('chat','chat-sdk') " +
            "AND trigger = 1 AND (channel_type IS NULL OR channel_type NOT IN (?, 'agent')) " +
            'ORDER BY seq ASC LIMIT 1',
        )
        .all(ECHO_CHANNEL_TYPE),
    ) as Array<{ timestamp: string; content: string }>;
    for (const r of inbound) {
      const c = parseContent(r.content);
      if (!c.text || c.senderId === 'system' || c.sender === 'system') continue;
      // Host-injected triggers (the welcome hand-off) are attributed to the
      // OWNER for sender-gating, so filter them by shape too — internal
      // prompts must never surface as user timeline entries (live-hit: the
      // raw "System instruction: run /welcome…" leaked into a new thread).
      if (c.text.startsWith('System instruction:')) continue;
      rows.push({
        timestamp: r.timestamp,
        sender: c.sender ?? 'user',
        senderId: c.senderId ?? '',
        text: c.text,
        self: false,
      });
    }
  }
  try {
    const outDb = openOutboundDb(agentGroup.id, sessionId);
    try {
      const outbound = outDb
        .prepare(
          "SELECT timestamp, content FROM messages_out WHERE kind NOT IN ('system','task_log') " +
            "AND (channel_type IS NULL OR channel_type != 'agent') " +
            "AND (thread_id IS NULL OR thread_id = '' OR thread_id LIKE '%:') " +
            'ORDER BY seq DESC LIMIT ?',
        )
        .all(limit) as Array<{ timestamp: string; content: string }>;
      for (const r of outbound) {
        const c = parseContent(r.content);
        if (!c.text) continue;
        rows.push({
          timestamp: r.timestamp,
          sender: agentGroup.name,
          senderId: agentGroup.id,
          text: c.text,
          self: true,
        });
      }
    } finally {
      outDb.close();
    }
  } catch {
    // outbound.db may not exist yet — inbound-only view.
  }
  return rows;
}

/**
 * Seed a just-created DM session with recent sibling-thread context. Call
 * BEFORE the triggering message is written. Non-throwing; no-ops for rooms,
 * task sessions, and sessions with no siblings.
 */
export function backfillNewDmSession(agentGroup: AgentGroup, session: Session, mg: MessagingGroup): void {
  try {
    if (mg.is_group !== 0) return;
    if (session.thread_id !== null && isTaskThread(session.thread_id)) return;

    const siblings = getSessionsByAgentGroup(agentGroup.id).filter(
      (s) => s.id !== session.id && s.status === 'active' && s.messaging_group_id === mg.id,
    );
    if (siblings.length === 0) return;

    const rows: BackfillRow[] = [];
    for (const sibling of siblings) {
      rows.push(...collectSiblingTopLevel(agentGroup, sibling.id, BACKFILL_LIMIT));
    }
    rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const newest = rows.slice(-BACKFILL_LIMIT);
    if (newest.length === 0) return;

    const label = 'this DM, just before this conversation';
    newest.forEach((row, i) => {
      // The most recent entry is what a short opener ("sure") is usually
      // answering — deliver it whole; earlier entries get the normal cap.
      const isLast = i === newest.length - 1;
      writeSessionMessage(agentGroup.id, session.id, {
        id: `${session.id}:backfill:${i}`,
        kind: 'chat',
        timestamp: row.timestamp,
        channelType: ECHO_CHANNEL_TYPE,
        content: JSON.stringify({
          text: isLast ? row.text.slice(0, 4000) : truncateEchoText(row.text),
          sender: row.sender,
          senderId: row.senderId,
          ...(row.self ? { self: true } : {}),
          echo: { surface: ECHO_TIMELINE_SURFACE, label },
        }),
        trigger: 0,
      });
    });
    log.debug('Backfilled new DM session with sibling context', {
      sessionId: session.id,
      rows: newest.length,
      siblings: siblings.length,
    });
  } catch (err) {
    log.warn('New-session backfill failed (continuing without context)', { sessionId: session.id, err });
  }
}
