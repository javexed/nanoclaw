/**
 * Webchat reconcile loop — recovers from a known race where the host's
 * delivery dispatcher logs "No adapter for channel type" for an instant,
 * marks an outbound chat message delivered, and the message never reaches
 * the WS broadcast or `webchat_messages` table.
 *
 * Symptom: PWA shows "agent thinking" indefinitely, the response is in the
 * agent's `outbound.db` and the inbound `delivered` table — but no row in
 * `webchat_messages`, no WS broadcast.
 *
 * The bug is in trunk (`src/index.ts`'s deliveryAdapter wrapper marks
 * messages delivered even when `getChannelAdapter()` returns undefined),
 * so a clean fix requires a trunk change. This watchdog is the skill-only
 * workaround: every RECONCILE_INTERVAL_MS, scan recent outbound messages
 * across all webchat sessions and replay any that have no corresponding
 * `webchat_messages` row.
 *
 * Idempotency: an in-memory Set tracks outbound message ids we've already
 * replayed (or seen the regular delivery cover). Bounded to ~1000 entries.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-manager.js';

import { storeWebchatFileMessage, storeWebchatMessage, type FileMeta } from './db.js';
import type { WebchatServer } from './server.js';

const RECONCILE_INTERVAL_MS = 7_000;
const RECENT_WINDOW_MS = 60_000; // only scan messages from the last minute
const GRACE_MS = 5_000; // give the regular delivery path this much time before we replay
const SEEN_BOUND = 1000; // cap the dedup memory

const seen = new Set<string>();
let timer: NodeJS.Timeout | null = null;

interface WebchatSessionRow {
  session_id: string;
  agent_group_id: string;
  agent_name: string;
  room_id: string;
}

interface OutboundRow {
  id: string;
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  content: string;
  timestamp: string;
}

interface WebchatMessageProbe {
  id: string;
}

export function startReconcileLoop(server: WebchatServer): void {
  if (timer) return; // already running — guard against double-setup
  timer = setInterval(() => {
    reconcileOnce(server).catch((err) => {
      log.warn('Webchat reconcile pass failed', { err: err instanceof Error ? err.message : String(err) });
    });
  }, RECONCILE_INTERVAL_MS);
}

export function stopReconcileLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  seen.clear();
}

async function reconcileOnce(server: WebchatServer): Promise<void> {
  const sessions = listWebchatSessions();
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  for (const sess of sessions) {
    const outDbPath = path.join(DATA_DIR, 'v2-sessions', sess.agent_group_id, sess.session_id, 'outbound.db');
    if (!fs.existsSync(outDbPath)) continue;

    let outDb;
    try {
      outDb = openOutboundDb(sess.agent_group_id, sess.session_id);
    } catch {
      continue;
    }
    try {
      // Recent webchat-channel chat messages produced by the container.
      const rows = outDb
        .prepare(
          `SELECT id, kind, channel_type, platform_id, content, timestamp
           FROM messages_out
           WHERE kind = 'chat'
             AND channel_type = 'webchat'
             AND timestamp > datetime(?, 'unixepoch')
           ORDER BY timestamp ASC`,
        )
        .all(Math.floor(cutoff / 1000)) as OutboundRow[];

      for (const msg of rows) {
        if (seen.has(msg.id)) continue;

        const tsMs = Date.parse(msg.timestamp.endsWith('Z') ? msg.timestamp : msg.timestamp + 'Z');
        if (Number.isNaN(tsMs)) continue;
        // Give regular delivery a head start before we second-guess it.
        if (Date.now() - tsMs < GRACE_MS) continue;

        const roomId = msg.platform_id ?? sess.room_id;
        if (!roomId) continue;

        // Did the regular delivery path already store this in webchat_messages?
        // We match on (room, sender_type=agent, content prefix, timestamp band)
        // because webchat_messages doesn't carry the outbound message id.
        const text = parseTextFromContent(msg.content);
        const fileMetas = parseFilesFromContent(msg.content);
        const hasText = text !== null && text.length > 0;
        const hasFiles = fileMetas.length > 0;
        if (!hasText && !hasFiles) {
          seen.add(msg.id);
          continue;
        }

        const probe: WebchatMessageProbe | undefined = hasText
          ? findStoredAgentMessage(roomId, text!, tsMs)
          : findStoredAgentFile(roomId, fileMetas[0].filename, tsMs);

        if (probe) {
          // Regular delivery covered it — just remember we've seen it.
          markSeen(msg.id);
          continue;
        }

        // Lost message: replay through the same path the adapter's deliver()
        // would have used. Stores in webchat_messages + broadcasts via WS.
        log.warn('Webchat reconcile: replaying lost agent message', {
          room: roomId,
          msgId: msg.id,
          sessionId: sess.session_id,
          agent: sess.agent_name,
        });
        // Use the session's actual agent name as the sender — reconcile
        // has the unambiguous mapping (one session = one agent), so we
        // skip the deliver-path's "most recently active" heuristic.
        const senderName = sess.agent_name || agentDisplayName();
        try {
          if (hasText) {
            const stored = storeWebchatMessage(roomId, senderName, 'agent', text!);
            server.broadcast(roomId, { type: 'message', ...stored });
          }
          for (const fileMeta of fileMetas) {
            const stored = storeWebchatFileMessage(roomId, senderName, 'agent', fileMeta.filename, fileMeta);
            server.broadcast(roomId, { type: 'message', ...stored });
          }
          markSeen(msg.id);
        } catch (err) {
          log.warn('Webchat reconcile: replay failed', {
            msgId: msg.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      outDb.close();
    }
  }
}

/** All webchat-channel sessions known to the central DB. */
function listWebchatSessions(): WebchatSessionRow[] {
  return getDb()
    .prepare(
      `SELECT s.id AS session_id, s.agent_group_id, ag.name AS agent_name, mg.platform_id AS room_id
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       WHERE mg.channel_type = 'webchat'`,
    )
    .all() as WebchatSessionRow[];
}

/**
 * Look for a recent agent-typed text row in webchat_messages whose content
 * matches the outbound text exactly. Time band is generous (±30s) because
 * outbound timestamps are SQL `datetime('now')` and webchat_messages uses
 * `Date.now()` ms — they can drift a bit.
 */
function findStoredAgentMessage(
  roomId: string,
  content: string,
  outboundTsMs: number,
): WebchatMessageProbe | undefined {
  const lo = outboundTsMs - 30_000;
  const hi = outboundTsMs + 30_000;
  return getDb()
    .prepare(
      `SELECT id FROM webchat_messages
       WHERE room_id = ? AND sender_type = 'agent' AND message_type = 'text'
         AND content = ?
         AND created_at BETWEEN ? AND ?
       LIMIT 1`,
    )
    .get(roomId, content, lo, hi) as WebchatMessageProbe | undefined;
}

function findStoredAgentFile(roomId: string, filename: string, outboundTsMs: number): WebchatMessageProbe | undefined {
  const lo = outboundTsMs - 30_000;
  const hi = outboundTsMs + 30_000;
  return getDb()
    .prepare(
      `SELECT id FROM webchat_messages
       WHERE room_id = ? AND sender_type = 'agent' AND message_type = 'file'
         AND file_meta LIKE ?
         AND created_at BETWEEN ? AND ?
       LIMIT 1`,
    )
    .get(roomId, `%"filename":"${filename.replace(/"/g, '\\"')}"%`, lo, hi) as WebchatMessageProbe | undefined;
}

function parseTextFromContent(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as { text?: unknown };
    return typeof obj.text === 'string' ? obj.text : null;
  } catch {
    return null;
  }
}

function parseFilesFromContent(raw: string): FileMeta[] {
  try {
    const obj = JSON.parse(raw) as { files?: unknown };
    if (!Array.isArray(obj.files)) return [];
    return (obj.files as unknown[]).filter((f): f is FileMeta => {
      if (!f || typeof f !== 'object') return false;
      const m = f as Record<string, unknown>;
      return typeof m.filename === 'string' && typeof m.url === 'string';
    });
  } catch {
    return [];
  }
}

function agentDisplayName(): string {
  return process.env.AGENT_DISPLAY_NAME || 'Agent';
}

function markSeen(id: string): void {
  seen.add(id);
  if (seen.size > SEEN_BOUND) {
    // Drop oldest entries (Set preserves insertion order).
    const toDrop = seen.size - Math.floor(SEEN_BOUND * 0.8);
    let i = 0;
    for (const v of seen) {
      if (i++ >= toDrop) break;
      seen.delete(v);
    }
  }
}
