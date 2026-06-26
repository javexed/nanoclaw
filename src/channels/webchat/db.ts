/**
 * Webchat DB helpers — typed CRUD over the central DB tables created by
 * migration `webchat-initial`.
 *
 * Does NOT replace inbound.db / outbound.db — the adapter mirrors agent
 * traffic into webchat_messages so the PWA has a unified history view, but
 * routing/delivery still flows through the v2 session DBs.
 */
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { createMessagingGroup, deleteMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';

/**
 * "Webchat room" is a UI-level alias for `messaging_groups WHERE channel_type='webchat'`.
 * The room id surfaces as `messaging_groups.platform_id`. Two layers describing
 * one concept were collapsed by the `webchat-drop-rooms` migration; this
 * interface keeps the simpler shape for callers that don't care about the
 * generic platform schema.
 */
export interface WebchatRoom {
  id: string;
  name: string;
  created_at: number;
  /**
   * Per-user archive flag. Not populated by row mapping (it's per-viewer
   * state, not part of the room itself); set by the view layer before
   * returning to the client. Optional + default-false on the client.
   */
  archived?: boolean;
}

export interface FileMeta {
  url: string;
  filename: string;
  mime: string;
  size: number;
}

export interface WebchatMessage {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: 'text' | 'file' | 'a2a' | 'approval' | 'approval_resolved';
  file_meta?: FileMeta | null;
  created_at: number;
}

interface WebchatMessageRow {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: 'text' | 'file' | 'a2a' | 'approval' | 'approval_resolved';
  file_meta: string | null;
  created_at: number;
}

export interface WebchatPushSubscription {
  endpoint: string;
  identity: string;
  keys_json: string;
  created_at: number;
}

// ── Rooms ──
// All four helpers route through `messaging_groups WHERE channel_type='webchat'`.
// The legacy `webchat_rooms` table was dropped by the `webchat-drop-rooms`
// migration; `id` here is `messaging_groups.platform_id`.

function rowToRoom(row: { platform_id: string; name: string | null; created_at: string }): WebchatRoom {
  return {
    id: row.platform_id,
    name: row.name ?? row.platform_id,
    created_at: Date.parse(row.created_at) || Date.now(),
  };
}

export function createWebchatRoom(name: string, id?: string): WebchatRoom {
  const platformId = id ?? randomUUID();
  // Guard against duplicate creation — re-running setup or the install-time
  // bootstrap can call this twice for the same canonical room.
  const existing = getMessagingGroupByPlatform('webchat', platformId);
  if (existing) {
    return {
      id: existing.platform_id,
      name: existing.name ?? platformId,
      created_at: Date.parse(existing.created_at) || Date.now(),
    };
  }
  const createdAt = new Date().toISOString();
  createMessagingGroup({
    id: randomUUID(),
    channel_type: 'webchat',
    platform_id: platformId,
    name,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  return {
    id: platformId,
    name,
    created_at: Date.parse(createdAt),
  };
}

export function getWebchatRoom(id: string): WebchatRoom | undefined {
  const mg = getMessagingGroupByPlatform('webchat', id);
  if (!mg) return undefined;
  return {
    id: mg.platform_id,
    name: mg.name ?? mg.platform_id,
    created_at: Date.parse(mg.created_at) || Date.now(),
  };
}

/**
 * Synthetic platform_id prefix for per-user approval inboxes. The webchat
 * adapter exposes openDM() returning this shape so requestApproval() can
 * resolve a delivery target for webchat users; the row exists in
 * messaging_groups so MessagingGroup-shaped APIs work, but it does not
 * represent a real chat room — it's an approver inbox keyed on the user's
 * handle. Hidden from the room list so it never surfaces in the sidebar.
 */
export const APPROVAL_INBOX_PREFIX = 'approvals:';

export function isApprovalInbox(platformId: string): boolean {
  return platformId.startsWith(APPROVAL_INBOX_PREFIX);
}

/**
 * Convert a webchat user_id (e.g. `webchat:tailscale:foo@bar.com`) to the
 * approval-inbox platform_id (`approvals:tailscale:foo@bar.com`). Returns
 * null for non-webchat user_ids.
 */
export function approvalInboxForUser(userId: string): string | null {
  if (!userId.startsWith('webchat:')) return null;
  return `${APPROVAL_INBOX_PREFIX}${userId.slice('webchat:'.length)}`;
}

export interface PendingApprovalRow {
  approval_id: string;
  action: string;
  title: string;
  options_json: string;
  payload: string;
  created_at: string;
}

/**
 * Record an approval delivered to a webchat approval-inbox. Called from
 * the adapter's deliver() the moment we route an `ask_question` payload
 * to a `approvals:` platform_id. Idempotent — `INSERT OR IGNORE`.
 *
 * This is the skill-only alternative to having trunk's `requestApproval`
 * stamp `channel_type`/`platform_id` on the `pending_approvals` row at
 * insert time. We record the mapping here, on our side, and join against
 * it in the read path below.
 */
export function recordWebchatApproval(approvalId: string, platformId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO webchat_approvals_index (approval_id, platform_id, recorded_at)
       VALUES (?, ?, ?)`,
    )
    .run(approvalId, platformId, Date.now());
}

/**
 * Whether an approval was indexed against the given platform_id (approval
 * inbox). The respond endpoint uses this to authorize the responder. A single
 * approval may be indexed against multiple inboxes under fan-out delivery
 * (every eligible admin gets a card); any of those inboxes is a valid
 * responder. We can't authorize against `pending_approvals.channel_type/
 * platform_id` because trunk's `requestApproval` doesn't populate those.
 */
export function isWebchatApprovalIndexedFor(approvalId: string, platformId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM webchat_approvals_index WHERE approval_id = ? AND platform_id = ? LIMIT 1`)
    .get(approvalId, platformId) as { 1: number } | undefined;
  return row !== undefined;
}

/**
 * Every inbox the given approval was indexed against, in insertion order. The
 * approval-resolved listener uses this to fan out a clear event to each admin
 * whose UI still shows the now-stale card.
 */
export function getWebchatApprovalInboxes(approvalId: string): string[] {
  const rows = getDb()
    .prepare(`SELECT platform_id FROM webchat_approvals_index WHERE approval_id = ? ORDER BY recorded_at`)
    .all(approvalId) as { platform_id: string }[];
  return rows.map((r) => r.platform_id);
}

/**
 * Drop every index row for an approval — called after it resolves so we don't
 * accumulate dead pointers. Safe to call on unknown ids.
 */
export function deleteWebchatApprovalIndex(approvalId: string): void {
  getDb().prepare(`DELETE FROM webchat_approvals_index WHERE approval_id = ?`).run(approvalId);
}

/** Inverse of `approvalInboxForUser`. Returns null for non-approval platform_ids. */
export function userForApprovalInbox(platformId: string): string | null {
  if (!platformId.startsWith(APPROVAL_INBOX_PREFIX)) return null;
  return `webchat:${platformId.slice(APPROVAL_INBOX_PREFIX.length)}`;
}

/**
 * Pending approvals destined for this webchat user's inbox.
 *
 * We can't filter on `pending_approvals.channel_type`/`platform_id`
 * because trunk's `requestApproval` doesn't populate those columns.
 * Instead we JOIN against the skill-owned `webchat_approvals_index`,
 * which webchat's deliver() populates on the way through.
 */
export function getWebchatPendingApprovalsForUser(userId: string): PendingApprovalRow[] {
  const platformId = approvalInboxForUser(userId);
  if (!platformId) return [];
  return getDb()
    .prepare(
      `SELECT pa.approval_id, pa.action, pa.title, pa.options_json, pa.payload, pa.created_at
         FROM pending_approvals pa
         JOIN webchat_approvals_index wai ON wai.approval_id = pa.approval_id
        WHERE wai.platform_id = ?
          AND pa.status = 'pending'
        ORDER BY pa.created_at`,
    )
    .all(platformId) as PendingApprovalRow[];
}

export function getAllWebchatRooms(): WebchatRoom[] {
  const rows = getDb()
    .prepare(
      `SELECT platform_id, name, created_at
         FROM messaging_groups
        WHERE channel_type = 'webchat'
          AND platform_id NOT LIKE 'approvals:%'
        ORDER BY created_at`,
    )
    .all() as { platform_id: string; name: string | null; created_at: string }[];
  return rows.map(rowToRoom);
}

export function updateWebchatRoomName(id: string, name: string): void {
  getDb()
    .prepare(`UPDATE messaging_groups SET name = ? WHERE channel_type='webchat' AND platform_id = ?`)
    .run(name, id);
}

/**
 * Delete a webchat room and everything that hangs off it: messages (cascade
 * is gone with the FK, so explicit), the wiring rows, dangling agent_destinations
 * pointing at this room, the prime designation, and the messaging_group itself.
 * Idempotent — no-op if the room doesn't exist.
 */
export function deleteWebchatRoom(id: string): void {
  const mg = getMessagingGroupByPlatform('webchat', id);
  if (!mg) return;
  const db = getDb();
  db.prepare(`DELETE FROM webchat_messages WHERE room_id = ?`).run(id);
  db.prepare(`DELETE FROM messaging_group_agents WHERE messaging_group_id = ?`).run(mg.id);
  db.prepare(`DELETE FROM webchat_room_primes WHERE room_id = ?`).run(id);
  db.prepare(`DELETE FROM webchat_user_room_hides WHERE room_id = ?`).run(id);
  db.prepare(`DELETE FROM webchat_room_archives WHERE room_id = ?`).run(id);
  db.prepare(`DELETE FROM webchat_room_reads WHERE room_id = ?`).run(id);
  db.prepare(`DELETE FROM webchat_room_pins WHERE room_id = ?`).run(id);
  // Drop any agent_destinations rows pointing at this room. target_id has no
  // FK so they wouldn't block, just rot. Guarded — a2a module may not be installed.
  if (hasTable(db, 'agent_destinations')) {
    db.prepare(`DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?`).run(mg.id);
  }
  // sessions.messaging_group_id has an FK to messaging_groups(id) and is NOT
  // NULL; any active session for this room would otherwise block the
  // deleteMessagingGroup below with an FK error. Running containers are
  // reaped by the host sweep on its next stale-heartbeat tick once the
  // session row is gone.
  db.prepare(`DELETE FROM sessions WHERE messaging_group_id = ?`).run(mg.id);
  deleteMessagingGroup(mg.id);
}

// ── Room ↔ Agent wirings ──

export interface WebchatRoomAgent {
  id: string;
  name: string;
  folder: string;
}

/**
 * List the agents currently wired to a webchat room. Empty array when the
 * room doesn't exist or has no wirings.
 */
export function getAgentsForWebchatRoom(roomId: string): WebchatRoomAgent[] {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return [];
  return getDb()
    .prepare(
      `SELECT ag.id, ag.name, ag.folder
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE mga.messaging_group_id = ?
       ORDER BY ag.name`,
    )
    .all(mg.id) as WebchatRoomAgent[];
}

/**
 * Remove a single (room, agent) wiring. Returns true if a row was deleted.
 * The agent_group itself is left intact — caller's responsibility to decide
 * whether the bare agent should also be deleted.
 *
 * Also drops the matching agent_destinations row so the agent's session
 * doesn't keep a destination pointing at a chat it can no longer write to.
 */
export function unwireAgentFromWebchatRoom(roomId: string, agentGroupId: string): boolean {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return false;
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`)
    .run(mg.id, agentGroupId);
  if (hasTable(db, 'agent_destinations')) {
    db.prepare(
      `DELETE FROM agent_destinations
       WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?`,
    ).run(agentGroupId, mg.id);
  }
  return result.changes > 0;
}

export interface AgentWebchatRoom {
  id: string; // room platform_id
  name: string;
  is_prime: boolean;
  /** Total agents wired to this room — lets the UI block removing the last one. */
  agent_count: number;
}

/**
 * List the webchat rooms a given agent is wired to. The agent-centric mirror of
 * getAgentsForWebchatRoom. Excludes approval inboxes (they aren't real rooms).
 * `is_prime` reflects whether this agent is the room's prime; `agent_count`
 * lets the UI enforce the same "can't unwire the last agent" guard the
 * room-detail panel uses.
 */
export function getWebchatRoomsForAgent(agentGroupId: string): AgentWebchatRoom[] {
  const rows = getDb()
    .prepare(
      `SELECT mg.platform_id AS id, mg.name AS name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mga.agent_group_id = ? AND mg.channel_type = 'webchat'
       ORDER BY mg.name`,
    )
    .all(agentGroupId) as { id: string; name: string | null }[];
  return rows
    .filter((r) => !isApprovalInbox(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      is_prime: getPrimeAgentForWebchatRoom(r.id) === agentGroupId,
      agent_count: countAgentsForWebchatRoom(r.id),
    }));
}

/**
 * Look up the agent most likely to have produced an outbound message for
 * this room. Used by the webchat adapter's `deliver()` (and the reconcile
 * loop) to attach the actual agent's display name to stored messages
 * instead of the generic "Agent" placeholder.
 *
 * Heuristic:
 *   - Exactly one wired agent → that's the producer.
 *   - Multiple wired agents → pick the session whose `last_active` is
 *     most recent. The container's poll loop bumps `last_active` when it
 *     picks up an inbound message, immediately before writing the
 *     response; by the time `deliver()` fires, the responding session is
 *     reliably the most recently active one.
 *
 * Returns `null` if no wired agent is found (orphan room or stale state).
 * Falls back to the first wired agent if `last_active` is null on every
 * session (fresh container, no traffic yet).
 */
export function findActiveAgentForWebchatRoom(roomId: string): WebchatRoomAgent | null {
  const agents = getAgentsForWebchatRoom(roomId);
  if (agents.length === 0) return null;
  if (agents.length === 1) return agents[0];
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return agents[0];
  // Filter to sessions whose container is actually running. Without this,
  // `writeSessionMessage` bumps `last_active` even for accumulate writes
  // (router stores message context without waking the container), so an
  // accumulate-only session can win the "most recent" race against the
  // session that actually produced the message. That mis-attributes the
  // sender name in the UI AND — load-bearing — feeds the wrong
  // `senderAgentGroupId` into the Pattern C loop-back, breaking router
  // self-exclusion. Container-status filtering identifies the actual
  // producer because only true wakes spawn/run a container.
  const row = getDb()
    .prepare(
      `SELECT ag.id, ag.name, ag.folder
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       WHERE s.messaging_group_id = ?
         AND s.last_active IS NOT NULL
         AND s.container_status IN ('running', 'idle')
       ORDER BY s.last_active DESC
       LIMIT 1`,
    )
    .get(mg.id) as { id: string; name: string; folder: string } | undefined;
  return row ?? agents[0];
}

/**
 * Count agents wired to a webchat room. Used to enforce the "no empty rooms"
 * invariant when removing an agent.
 */
export function countAgentsForWebchatRoom(roomId: string): number {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return 0;
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?`)
    .get(mg.id) as { c: number };
  return row.c;
}

// ── Prime agent designation ──
//
// A room opts in to "prime" routing by designating one wired agent as prime.
// The prime answers every message that doesn't @-mention another wired agent
// (matched by folder name). Implementation rewrites
// messaging_group_agents.engage_pattern via recomputeEngagePatterns() in
// server.ts — no router-side change needed.
//
// Storage: webchat_room_primes(room_id PK, agent_group_id, created_at).
// Stale rows can exist transiently (an unwired prime, a deleted agent's row);
// the wiring-change paths in server.ts clear them when they notice.

export function getPrimeAgentForWebchatRoom(roomId: string): string | null {
  const row = getDb().prepare(`SELECT agent_group_id FROM webchat_room_primes WHERE room_id = ?`).get(roomId) as
    | { agent_group_id: string }
    | undefined;
  return row?.agent_group_id ?? null;
}

export function setPrimeAgentForWebchatRoom(roomId: string, agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_room_primes (room_id, agent_group_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET agent_group_id = excluded.agent_group_id, created_at = excluded.created_at`,
    )
    .run(roomId, agentGroupId, Date.now());
}

export function clearPrimeAgentForWebchatRoom(roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_room_primes WHERE room_id = ?`).run(roomId);
}

// ── Room settings (engage_default) ──

export type EngageDefault = 'broadcast' | 'mention-only';

/**
 * Per-room engagement default used when no prime is configured. Controls
 * what `recomputeEngagePatterns` rewrites un-primed wirings to:
 *
 *   'broadcast'    → engage_pattern = '.'           (every agent responds)
 *   'mention-only' → engage_pattern = `\B@<folder>\b` (only addressed agents respond)
 *
 * Rooms with no row default to 'broadcast' so installs that predate this
 * setting see no behavior change.
 */
export function getRoomEngageDefault(roomId: string): EngageDefault {
  const row = getDb().prepare(`SELECT engage_default FROM webchat_room_settings WHERE room_id = ?`).get(roomId) as
    | { engage_default: EngageDefault }
    | undefined;
  return row?.engage_default ?? 'broadcast';
}

export function setRoomEngageDefault(roomId: string, mode: EngageDefault): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_room_settings (room_id, engage_default, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET engage_default = excluded.engage_default, updated_at = excluded.updated_at`,
    )
    .run(roomId, mode, Date.now());
}

// ── Messages ──

function rowToMessage(row: WebchatMessageRow): WebchatMessage {
  return {
    ...row,
    file_meta: row.file_meta ? (JSON.parse(row.file_meta) as FileMeta) : null,
  };
}

export function storeWebchatMessage(
  roomId: string,
  sender: string,
  senderType: string,
  content: string,
): WebchatMessage {
  const msg: WebchatMessage = {
    id: randomUUID(),
    room_id: roomId,
    sender,
    sender_type: senderType,
    content,
    message_type: 'text',
    file_meta: null,
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    )
    .run({ ...msg, file_meta: null });
  return msg;
}

/**
 * Store an ACTIONABLE approval card in the agent's room (in addition to the
 * per-approver inboxes). `message_type='approval'`; content carries the
 * ask_question payload + the eligible `approvers` (the client shows the
 * approve/deny buttons only to those users). Keyed by a deterministic id so
 * re-firing is idempotent and the card can be updated on resolution.
 */
export function storeWebchatApprovalCard(
  roomId: string,
  sender: string,
  payload: {
    questionId: string;
    title: string;
    question: string;
    options: unknown;
    action: string;
    approvers: string[];
  },
): WebchatMessage {
  const msg: WebchatMessage = {
    id: `appr-card-${payload.questionId}`,
    room_id: roomId,
    sender,
    sender_type: 'agent',
    content: JSON.stringify(payload),
    message_type: 'approval',
    file_meta: null,
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    )
    .run({ ...msg, file_meta: null });
  return msg;
}

/**
 * Flip a room approval card to resolved (so reload renders it non-actionable).
 * No-op if the card row doesn't exist. The live clear is a broadcast handled
 * by the resolved-listener; this keeps the persisted row consistent.
 */
export function markRoomApprovalResolved(approvalId: string, resolvedBy: string): void {
  const id = `appr-card-${approvalId}`;
  const row = getDb().prepare(`SELECT content FROM webchat_messages WHERE id = ?`).get(id) as
    | { content: string }
    | undefined;
  if (!row) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.content) as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  payload.resolvedBy = resolvedBy;
  getDb()
    .prepare(`UPDATE webchat_messages SET message_type = 'approval_resolved', content = ? WHERE id = ?`)
    .run(JSON.stringify(payload), id);
}

/**
 * Store an agent↔agent (a2a) message surfaced into a room both agents share —
 * a read-only side-channel copy so humans can watch agents talk. Marked with
 * `sender_type` + `message_type` = 'a2a' (so it never trips agent-message UI
 * like thinking-bubble removal), with the target encoded in `content` as
 * `{to, text}` — the client renders a "from → to" label. `sender` is the
 * source agent's display name; no users-table row is created (display only).
 */
export function storeWebchatA2aMessage(roomId: string, fromName: string, toName: string, text: string): WebchatMessage {
  const msg: WebchatMessage = {
    id: randomUUID(),
    room_id: roomId,
    sender: fromName,
    sender_type: 'a2a',
    content: JSON.stringify({ to: toName, text }),
    message_type: 'a2a',
    file_meta: null,
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    )
    .run({ ...msg, file_meta: null });
  return msg;
}

/**
 * Webchat rooms that BOTH agents are wired to (the side-channel surfacing
 * target). Excludes approval inboxes. Returns the room platform_id (the
 * `room_id` used by webchat_messages / broadcast) and display name.
 */
export function getSharedWebchatRooms(agentGroupIdA: string, agentGroupIdB: string): { id: string; name: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT mg.platform_id AS id, mg.name AS name
       FROM messaging_groups mg
       JOIN messaging_group_agents a ON a.messaging_group_id = mg.id AND a.agent_group_id = ?
       JOIN messaging_group_agents b ON b.messaging_group_id = mg.id AND b.agent_group_id = ?
       WHERE mg.channel_type = 'webchat'
       ORDER BY mg.name`,
    )
    .all(agentGroupIdA, agentGroupIdB) as { id: string; name: string | null }[];
  return rows.filter((r) => !isApprovalInbox(r.id)).map((r) => ({ id: r.id, name: r.name ?? r.id }));
}

export function storeWebchatFileMessage(
  roomId: string,
  sender: string,
  senderType: string,
  caption: string,
  fileMeta: FileMeta,
): WebchatMessage {
  const msg: WebchatMessage = {
    id: randomUUID(),
    room_id: roomId,
    sender,
    sender_type: senderType,
    content: caption,
    message_type: 'file',
    file_meta: fileMeta,
    created_at: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    )
    .run({ ...msg, file_meta: JSON.stringify(fileMeta) });
  return msg;
}

export function getWebchatMessages(roomId: string, limit = 200): WebchatMessage[] {
  const rows = getDb()
    .prepare(`SELECT * FROM webchat_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(roomId, limit) as WebchatMessageRow[];
  return rows.reverse().map(rowToMessage);
}

/**
 * Delete a message — only the original sender (matched on `sender` text)
 * may delete their own, AND only within the room they're connected to.
 * The room scope prevents a client connected to room A from deleting a
 * message in room B (especially relevant in shared-bearer auth where
 * every client carries the same `webchat:owner` identity). Returns true
 * on success.
 */
export function deleteWebchatMessage(messageId: string, requesterIdentity: string, roomId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM webchat_messages WHERE id = ? AND sender = ? AND room_id = ?`)
    .run(messageId, requesterIdentity, roomId);
  return result.changes > 0;
}

export function getWebchatMessagesAfterId(roomId: string, afterId: string, limit = 500): WebchatMessage[] {
  const anchor = getDb().prepare(`SELECT created_at FROM webchat_messages WHERE id = ?`).get(afterId) as
    | { created_at: number }
    | undefined;
  if (!anchor) return [];
  const rows = getDb()
    .prepare(
      `SELECT * FROM webchat_messages
       WHERE room_id = ? AND created_at > ?
       ORDER BY created_at LIMIT ?`,
    )
    .all(roomId, anchor.created_at, limit) as WebchatMessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Older-message pagination (scroll-back). Returns up to `limit` messages
 * immediately BEFORE `beforeId`, oldest-to-newest so the client can prepend
 * them as one ascending block. An empty/short result means the start of
 * history has been reached. Mirrors getWebchatMessagesAfterId's created_at
 * anchoring.
 */
export interface WebchatSearchResult {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  message_type: string;
  snippet: string;
  created_at: number;
}

/**
 * Full-text search (FTS5) over message content, scoped to `roomIds` (the
 * caller's accessible rooms — never search rooms the user can't see). Returns
 * relevance-ranked hits with a highlighted snippet.
 *
 * The MATCH string is built ONLY from extracted word tokens, each prefix-matched
 * and AND-ed — so no user-supplied FTS5 operators/quotes reach the parser (which
 * would otherwise throw a syntax error on input like `"` or `AND`).
 */
export function searchWebchatMessages(roomIds: string[], rawQuery: string, limit = 50): WebchatSearchResult[] {
  if (roomIds.length === 0) return [];
  const tokens = (rawQuery.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  if (tokens.length === 0) return [];
  const match = tokens.map((t) => `${t}*`).join(' ');
  const placeholders = roomIds.map(() => '?').join(',');
  return getDb()
    .prepare(
      `SELECT m.id, m.room_id, m.sender, m.sender_type, m.message_type,
              snippet(webchat_messages_fts, 0, '«', '»', '…', 12) AS snippet,
              m.created_at
       FROM webchat_messages_fts f
       JOIN webchat_messages m ON m.rowid = f.rowid
       WHERE webchat_messages_fts MATCH ?
         AND m.room_id IN (${placeholders})
         AND m.message_type NOT IN ('approval', 'approval_resolved')
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, ...roomIds, limit) as WebchatSearchResult[];
}

export function getWebchatMessagesBeforeId(roomId: string, beforeId: string, limit = 50): WebchatMessage[] {
  const anchor = getDb().prepare(`SELECT created_at FROM webchat_messages WHERE id = ?`).get(beforeId) as
    | { created_at: number }
    | undefined;
  if (!anchor) return [];
  const rows = getDb()
    .prepare(
      `SELECT * FROM webchat_messages
       WHERE room_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(roomId, anchor.created_at, limit) as WebchatMessageRow[];
  return rows.reverse().map(rowToMessage);
}

// ── Push subscriptions ──

export function upsertWebchatPushSubscription(sub: Omit<WebchatPushSubscription, 'created_at'>): void {
  const row: WebchatPushSubscription = { ...sub, created_at: Date.now() };
  getDb()
    .prepare(
      `INSERT INTO webchat_push_subscriptions (endpoint, identity, keys_json, created_at)
       VALUES (@endpoint, @identity, @keys_json, @created_at)
       ON CONFLICT(endpoint) DO UPDATE SET identity = excluded.identity, keys_json = excluded.keys_json`,
    )
    .run(row);
}

export function deleteWebchatPushSubscriptionForIdentity(identity: string, endpoint: string): void {
  getDb().prepare(`DELETE FROM webchat_push_subscriptions WHERE identity = ? AND endpoint = ?`).run(identity, endpoint);
}

export function getWebchatPushSubscriptionsForIdentity(identity: string): WebchatPushSubscription[] {
  return getDb()
    .prepare(`SELECT * FROM webchat_push_subscriptions WHERE identity = ?`)
    .all(identity) as WebchatPushSubscription[];
}

export function deleteWebchatPushSubscriptionByEndpoint(endpoint: string): void {
  getDb().prepare(`DELETE FROM webchat_push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

// ── Models ──
//
// LLM endpoint registry. The MVP supports two kinds:
//   - 'anthropic': pin an agent to a specific Anthropic model_id (the
//     existing OneCLI-managed credential is reused — no per-model key).
//   - 'ollama': route at a local Ollama endpoint (Ollama speaks the
//     Anthropic API natively at <endpoint>/v1/messages).
//
// `webchat_agent_models` is the assignment join. PK on agent_group_id keeps
// it 1:1. No FK to webchat_models so the delete-model handler can do
// cascade-with-confirmation in JS.

// 'openai-compatible' covers OpenRouter, LM Studio, vLLM, Llama.cpp, and any
// /v1/{models,chat/completions} endpoint. Storing/registering works without
// extra setup; *using* one as an agent's runtime model requires the
// `/add-opencode` skill (the default Claude SDK doesn't speak OpenAI's
// protocol). The PWA surfaces a "needs /add-opencode" warning when
// assigning, but the row stays around for when the skill is installed.
export type WebchatModelKind = 'anthropic' | 'ollama' | 'openai-compatible';

export interface WebchatModel {
  id: string;
  name: string;
  kind: WebchatModelKind;
  endpoint: string | null;
  model_id: string;
  credential_ref: string | null;
  created_at: number;
}

export function listWebchatModels(): WebchatModel[] {
  return getDb().prepare(`SELECT * FROM webchat_models ORDER BY name COLLATE NOCASE`).all() as WebchatModel[];
}

export function getWebchatModel(id: string): WebchatModel | undefined {
  return getDb().prepare(`SELECT * FROM webchat_models WHERE id = ?`).get(id) as WebchatModel | undefined;
}

export function createWebchatModel(m: WebchatModel): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES (@id, @name, @kind, @endpoint, @model_id, @credential_ref, @created_at)`,
    )
    .run(m);
}

export function updateWebchatModel(
  id: string,
  patch: { name?: string; endpoint?: string | null; model_id?: string; credential_ref?: string | null },
): void {
  const existing = getWebchatModel(id);
  if (!existing) return;
  const next = { ...existing, ...patch };
  getDb()
    .prepare(
      `UPDATE webchat_models
       SET name = ?, endpoint = ?, model_id = ?, credential_ref = ?
       WHERE id = ?`,
    )
    .run(next.name, next.endpoint, next.model_id, next.credential_ref, id);
}

export function deleteWebchatModel(id: string): void {
  const db = getDb();
  // Cascade in JS — caller is expected to have surfaced the impact list.
  db.prepare(`DELETE FROM webchat_agent_models WHERE model_id = ?`).run(id);
  db.prepare(`DELETE FROM webchat_models WHERE id = ?`).run(id);
}

export function getAgentsAssignedToModel(modelId: string): string[] {
  return (
    getDb().prepare(`SELECT agent_group_id FROM webchat_agent_models WHERE model_id = ?`).all(modelId) as {
      agent_group_id: string;
    }[]
  ).map((r) => r.agent_group_id);
}

export interface WebchatTopology {
  rooms: { id: string; name: string }[];
  agents: { id: string; name: string; modelId: string | null; modelName: string | null }[];
  models: { id: string; name: string }[];
  edges: { room: string; agent: string }[]; // room↔agent wirings
}

/**
 * Assemble the room → agent → model topology from the given (already
 * access-filtered) rooms AND agents. ALL accessible agents appear as nodes —
 * including ones wired to no in-scope room (they surface as orphans in the graph
 * and as empty columns in the wiring matrix, so a brand-new agent can be wired
 * straight from the matrix). Edges are the room↔agent wirings among these rooms
 * and agents only — so nothing outside the caller's visible set leaks. Each
 * agent carries its assigned model; models are deduped. Powers GET /api/topology.
 */
export function getWebchatTopology(
  rooms: { id: string; name: string }[],
  agents: { id: string; name: string }[],
): WebchatTopology {
  const agentNodes = agents.map((a) => {
    const m = getAssignedModelForAgent(a.id);
    return { id: a.id, name: a.name, modelId: m?.id ?? null, modelName: m?.name ?? null };
  });
  const ids = new Set(agentNodes.map((a) => a.id));
  const edges: { room: string; agent: string }[] = [];
  for (const room of rooms) {
    for (const a of getAgentsForWebchatRoom(room.id)) {
      if (ids.has(a.id)) edges.push({ room: room.id, agent: a.id });
    }
  }
  const modelMap = new Map<string, { id: string; name: string }>();
  for (const a of agentNodes) if (a.modelId) modelMap.set(a.modelId, { id: a.modelId, name: a.modelName ?? a.modelId });
  return {
    rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
    agents: agentNodes,
    models: [...modelMap.values()],
    edges,
  };
}

export function getAssignedModelForAgent(agentGroupId: string): WebchatModel | null {
  const row = getDb()
    .prepare(`SELECT model_id FROM webchat_agent_models WHERE agent_group_id = ?`)
    .get(agentGroupId) as { model_id: string } | undefined;
  if (!row) return null;
  return getWebchatModel(row.model_id) ?? null;
}

export function assignModelToAgent(agentGroupId: string, modelId: string): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET model_id = excluded.model_id, assigned_at = excluded.assigned_at`,
    )
    .run(agentGroupId, modelId, Date.now());
}

export function unassignModelFromAgent(agentGroupId: string): void {
  getDb().prepare(`DELETE FROM webchat_agent_models WHERE agent_group_id = ?`).run(agentGroupId);
}

// ── Room state: global archive + per-user hide ──
//
// `archive` is now a GLOBAL room state — settable by owners/admins,
// visible to every user with access. The room still routes messages
// normally; archive is presentation only ("closed-to-active-work" hint).
//
// `hide` is a PER-USER sidebar preference (renamed from the previous
// "archive for user X"). Affects only that user's view; doesn't change
// anything for other users.
//
// `room_id` is `messaging_groups.platform_id` (consistent with
// webchat_room_primes etc.). Both tables intentionally have no FK
// to `messaging_groups` — cascade-on-room-delete is handled in app code
// (clearArchiveForRoom / clearHidesForRoom called from deleteWebchatRoom).

// ── Global archive (settable by owners + admins) ──

export function archiveRoom(roomId: string, archivedBy: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_room_archives (room_id, archived_at, archived_by)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO NOTHING`,
    )
    .run(roomId, new Date().toISOString(), archivedBy);
}

export function unarchiveRoom(roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_room_archives WHERE room_id = ?`).run(roomId);
}

export function isRoomArchived(roomId: string): boolean {
  const row = getDb().prepare(`SELECT 1 FROM webchat_room_archives WHERE room_id = ?`).get(roomId);
  return !!row;
}

export function getArchivedRoomIds(): Set<string> {
  const rows = getDb().prepare(`SELECT room_id FROM webchat_room_archives`).all() as { room_id: string }[];
  return new Set(rows.map((r) => r.room_id));
}

export function clearArchiveForRoom(roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_room_archives WHERE room_id = ?`).run(roomId);
}

// ── Per-user hide (any user, on rooms they can access) ──

export function hideRoomForUser(userId: string, roomId: string): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_user_room_hides (user_id, room_id, archived_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, room_id) DO NOTHING`,
    )
    .run(userId, roomId, new Date().toISOString());
}

export function unhideRoomForUser(userId: string, roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_user_room_hides WHERE user_id = ? AND room_id = ?`).run(userId, roomId);
}

export function getHiddenRoomIdsForUser(userId: string): Set<string> {
  const rows = getDb().prepare(`SELECT room_id FROM webchat_user_room_hides WHERE user_id = ?`).all(userId) as {
    room_id: string;
  }[];
  return new Set(rows.map((r) => r.room_id));
}

export function clearHidesForRoom(roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_user_room_hides WHERE room_id = ?`).run(roomId);
}

// ── Per-user read markers (unread badge persistence) ──
//
// `last_read_at` is a per-(user, room) high-water mark of the newest message
// `created_at` the user has seen. A room is unread for the user when its newest
// message is newer than the marker (or there's no marker and the room has any
// messages). The marker is server-side and keyed on the trusted webchat
// user_id, so the unread badge is shared across all of that user's devices:
// reading on one device clears it on the others (live via a `read_cleared`
// push; on reconnect via the `unread` flag in the rooms payload).

/**
 * Advance a user's read marker for a room to `ts` (defaults to now). Idempotent
 * and monotonic — never moves the marker backwards, so a late-arriving stale
 * read (e.g. a backgrounded tab catching up) can't un-read newer messages.
 */
export function markRoomRead(userId: string, roomId: string, ts: number = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_room_reads (user_id, room_id, last_read_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, room_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
    )
    .run(userId, roomId, ts);
}

/**
 * The set of room ids that have unread messages for this user: rooms whose
 * newest message is newer than the user's read marker (rooms with no marker
 * yet count as unread if they contain any message). The `idx_webchat_messages_room`
 * index makes the per-room MAX(created_at) cheap. Approval/a2a side-channel
 * rows count the same as in the live `unread` path — any new activity lights
 * the dot.
 */
export function getUnreadRoomIdsForUser(userId: string): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT m.room_id AS room_id
         FROM webchat_messages m
         LEFT JOIN webchat_room_reads r
           ON r.room_id = m.room_id AND r.user_id = ?
        GROUP BY m.room_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.last_read_at), 0)`,
    )
    .all(userId) as { room_id: string }[];
  return new Set(rows.map((r) => r.room_id));
}

/** Drop a room's read markers — called from deleteWebchatRoom's cascade. */
export function clearReadsForRoom(roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_room_reads WHERE room_id = ?`).run(roomId);
}

// ── Per-user room pins (sticky group at the top of the sidebar) ──
// Pins are per-(user, room), keyed on the trusted webchat user_id, so a pin
// follows the user across devices (same model as read markers/hides).

/** Pin a room for a user. Idempotent — re-pinning keeps the original pinned_at. */
export function pinRoomForUser(userId: string, roomId: string, ts: number = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO webchat_room_pins (user_id, room_id, pinned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, room_id) DO NOTHING`,
    )
    .run(userId, roomId, ts);
}

export function unpinRoomForUser(userId: string, roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_room_pins WHERE user_id = ? AND room_id = ?`).run(userId, roomId);
}

export function getPinnedRoomIdsForUser(userId: string): Set<string> {
  const rows = getDb().prepare(`SELECT room_id FROM webchat_room_pins WHERE user_id = ?`).all(userId) as {
    room_id: string;
  }[];
  return new Set(rows.map((r) => r.room_id));
}

/** Drop a room's pins — called from deleteWebchatRoom's cascade. */
export function clearPinsForRoom(roomId: string): void {
  getDb().prepare(`DELETE FROM webchat_room_pins WHERE room_id = ?`).run(roomId);
}

/**
 * Newest message `created_at` per room — the sort key for the "Recent" sidebar
 * order. Rooms with no messages are absent; the view falls back to the room's
 * own `created_at`. The `idx_webchat_messages_room` index makes the per-room MAX
 * cheap.
 */
export function getRoomLastActivity(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT room_id, MAX(created_at) AS last_at FROM webchat_messages GROUP BY room_id`)
    .all() as { room_id: string; last_at: number }[];
  return new Map(rows.map((r) => [r.room_id, r.last_at]));
}

// ── User @-mention handles ──────────────────────────────────────────────────
// Per-user slug others type to @-mention them. Lowercase [a-z0-9-]; UNIQUE so a
// handle resolves to exactly one user. Defaults to a slug of the display name.

/** Slugify a display name into a candidate handle: lowercase, [a-z0-9-] only. */
export function slugifyHandle(name: string): string {
  const slug = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'user';
}

export function getWebchatUserHandle(userId: string): string | null {
  const row = getDb().prepare(`SELECT handle FROM webchat_user_handles WHERE user_id = ?`).get(userId) as
    | { handle: string }
    | undefined;
  return row?.handle ?? null;
}

/** Which user_id (if any) currently owns a handle. */
export function userIdForHandle(handle: string): string | null {
  const row = getDb().prepare(`SELECT user_id FROM webchat_user_handles WHERE handle = ?`).get(handle.toLowerCase()) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
}

/**
 * Set a user's handle. Returns { ok } or { ok:false, reason } when the handle is
 * already taken by another user (caller surfaces a 409). Validates the shape too.
 */
export function setWebchatUserHandle(userId: string, handle: string): { ok: true } | { ok: false; reason: string } {
  const h = handle.toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(h)) return { ok: false, reason: 'invalid' };
  const owner = userIdForHandle(h);
  if (owner && owner !== userId) return { ok: false, reason: 'taken' };
  getDb()
    .prepare(
      `INSERT INTO webchat_user_handles (user_id, handle, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle`,
    )
    .run(userId, h, Date.now());
  return { ok: true };
}

/**
 * Ensure a user has a handle, defaulting to a slug of their display name with a
 * numeric suffix on collision. Idempotent; called on WS connect so every user is
 * @-mentionable by default. Returns the effective handle.
 */
export function ensureWebchatUserHandle(userId: string, displayName: string): string {
  const existing = getWebchatUserHandle(userId);
  if (existing) return existing;
  const base = slugifyHandle(displayName);
  let candidate = base;
  for (let n = 2; userIdForHandle(candidate) !== null; n++) candidate = `${base}-${n}`;
  getDb()
    .prepare(`INSERT OR IGNORE INTO webchat_user_handles (user_id, handle, created_at) VALUES (?, ?, ?)`)
    .run(userId, candidate, Date.now());
  // Re-read in case a concurrent connect won the INSERT for this user_id.
  return getWebchatUserHandle(userId) ?? candidate;
}

/**
 * Everyone who has a handle, with their display name — the candidate pool for
 * @-mention autocomplete. The caller filters by room access; mention candidates
 * are NOT limited to currently-connected members (you can mention someone who's
 * offline — they get the badge/notification when they return).
 */
export function getWebchatHandleUsers(): { userId: string; handle: string; displayName: string | null }[] {
  return getDb()
    .prepare(
      `SELECT h.user_id AS userId, h.handle AS handle, u.display_name AS displayName
         FROM webchat_user_handles h
         LEFT JOIN users u ON u.id = h.user_id`,
    )
    .all() as { userId: string; handle: string; displayName: string | null }[];
}

/** Resolve a set of @-handles to the user_ids that own them (for mention detection). */
export function resolveHandlesToUserIds(handles: string[]): string[] {
  const uniq = [...new Set(handles.map((h) => h.toLowerCase()))].filter(Boolean);
  if (uniq.length === 0) return [];
  const rows = getDb()
    .prepare(`SELECT user_id FROM webchat_user_handles WHERE handle IN (${uniq.map(() => '?').join(',')})`)
    .all(...uniq) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/**
 * Rooms with an unread message that @-mentions this user's handle (latest such
 * message is newer than their last read marker) — for the durable mention badge
 * on load. The live `mention` WS signal is exact; this load-time query uses a
 * substring LIKE on the handle, so it's approximate (may include `@handle-2`
 * style near-matches) — acceptable for a badge. Empty when handle is blank.
 */
export function getMentionedRoomIdsForUser(userId: string, handle: string): Set<string> {
  const h = (handle || '').toLowerCase();
  if (!h) return new Set();
  const rows = getDb()
    .prepare(
      `SELECT m.room_id AS room_id
         FROM webchat_messages m
         LEFT JOIN webchat_room_reads r
           ON r.room_id = m.room_id AND r.user_id = ?
        WHERE m.content LIKE '%@' || ? || '%'
        GROUP BY m.room_id
       HAVING MAX(m.created_at) > COALESCE(MAX(r.last_read_at), 0)`,
    )
    .all(userId, h) as { room_id: string }[];
  return new Set(rows.map((r) => r.room_id));
}
