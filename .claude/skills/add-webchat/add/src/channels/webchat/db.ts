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
  message_type: 'text' | 'file';
  file_meta?: FileMeta | null;
  created_at: number;
}

interface WebchatMessageRow {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: 'text' | 'file';
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
  // Drop any agent_destinations rows pointing at this room. target_id has no
  // FK so they wouldn't block, just rot. Guarded — a2a module may not be installed.
  if (hasTable(db, 'agent_destinations')) {
    db.prepare(`DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?`).run(mg.id);
  }
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
  const row = getDb()
    .prepare(
      `SELECT ag.id, ag.name, ag.folder
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
       WHERE s.messaging_group_id = ?
         AND s.last_active IS NOT NULL
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
