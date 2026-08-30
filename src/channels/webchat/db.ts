/**
 * Webchat DB helpers — typed CRUD over the tables created by migration.ts.
 *
 * Does NOT replace inbound.db / outbound.db — the adapter mirrors agent
 * traffic into webchat_messages so the PWA has a unified history view, but
 * routing/delivery still flows through the per-session DBs like every other
 * channel.
 *
 * Ported from nanoclaw-webchat's db.ts (2,462 lines) minus everything the
 * single-user build dropped: threads, FTS search, per-user reads/pins/
 * archives/hides/handles, push subscriptions, a2a surfacing, skill drafts,
 * credential modes, template/skill sources, topology.
 */
import { randomUUID } from 'crypto';

import { getDb, hasTable } from '../../db/connection.js';
import { createMessagingGroup, deleteMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';

/**
 * "Webchat room" is a UI-level alias for `messaging_groups WHERE
 * channel_type='webchat'`. The room id surfaces as
 * `messaging_groups.platform_id` — one source of truth for the router and
 * the UI alike (the overlay collapsed its separate rooms table into this
 * shape and never looked back).
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
  message_type: 'text' | 'file' | 'approval' | 'approval_resolved' | 'context-divider';
  file_meta?: FileMeta | null;
  created_at: number;
}

interface WebchatMessageRow {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: WebchatMessage['message_type'];
  file_meta: string | null;
  created_at: number;
}

function rowToMessage(row: WebchatMessageRow): WebchatMessage {
  return {
    ...row,
    file_meta: row.file_meta ? (JSON.parse(row.file_meta) as FileMeta) : null,
  };
}

// ── Rooms ───────────────────────────────────────────────────────────────────

function rowToRoom(row: { platform_id: string; name: string | null; created_at: string }): WebchatRoom {
  return {
    id: row.platform_id,
    name: row.name ?? row.platform_id,
    created_at: Date.parse(row.created_at) || Date.now(),
  };
}

export async function createWebchatRoom(name: string, id?: string): Promise<WebchatRoom> {
  const platformId = id ?? randomUUID();
  // Guard against duplicate creation — re-running setup or the install-time
  // bootstrap can call this twice for the same canonical room.
  const existing = await getMessagingGroupByPlatform('webchat', platformId);
  if (existing) return rowToRoom(existing);
  const createdAt = new Date().toISOString();
  await createMessagingGroup({
    id: randomUUID(),
    channel_type: 'webchat',
    platform_id: platformId,
    name,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  return { id: platformId, name, created_at: Date.parse(createdAt) };
}

export async function getWebchatRoom(id: string): Promise<WebchatRoom | undefined> {
  const mg = await getMessagingGroupByPlatform('webchat', id);
  return mg ? rowToRoom(mg) : undefined;
}

export async function getAllWebchatRooms(): Promise<WebchatRoom[]> {
  const rows = (await getDb().all(`SELECT platform_id, name, created_at
         FROM messaging_groups
        WHERE channel_type = 'webchat'
          AND platform_id NOT LIKE 'approvals:%'
        ORDER BY created_at`)) as { platform_id: string; name: string | null; created_at: string }[];
  return rows.map(rowToRoom);
}

/**
 * Clean a user-supplied room name: strip control characters, collapse
 * internal whitespace, trim, and bound the length. Returns null when the
 * result is empty or longer than 80 chars — the caller rejects those.
 */
export function sanitizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name.length > 80) return null;
  return name;
}

export async function updateWebchatRoomName(id: string, name: string): Promise<void> {
  await getDb().run(`UPDATE messaging_groups SET name = ? WHERE channel_type='webchat' AND platform_id = ?`, name, id);
}

/**
 * Delete a webchat room and everything that hangs off it: messages, the
 * wiring rows, dangling agent_destinations pointing at this room, the prime
 * designation, sessions (FK to messaging_groups blocks otherwise; running
 * containers get reaped by the host sweep once the row is gone), and the
 * messaging_group itself. Idempotent — no-op if the room doesn't exist.
 */
export async function deleteWebchatRoom(id: string): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', id);
  if (!mg) return;
  const db = getDb();
  await db.run(`DELETE FROM webchat_messages WHERE room_id = ?`, id);
  await db.run(`DELETE FROM messaging_group_agents WHERE messaging_group_id = ?`, mg.id);
  await db.run(`DELETE FROM webchat_room_primes WHERE room_id = ?`, id);
  // Drop any agent_destinations rows pointing at this room. target_id has no
  // FK so they wouldn't block, just rot. Guarded — a2a module may not have
  // created the table yet.
  if (await hasTable(db, 'agent_destinations')) {
    await db.run(`DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?`, mg.id);
  }
  await db.run(`DELETE FROM sessions WHERE messaging_group_id = ?`, mg.id);
  await deleteMessagingGroup(mg.id);
}

/** Newest-message time per room — drives the sidebar "Recent" sort. */
export async function getRoomLastActivity(): Promise<Map<string, number>> {
  const rows = (await getDb().all(
    `SELECT room_id, MAX(created_at) AS last_at FROM webchat_messages GROUP BY room_id`,
  )) as { room_id: string; last_at: number }[];
  return new Map(rows.map((r) => [r.room_id, r.last_at]));
}

// ── Approval inbox plumbing ─────────────────────────────────────────────────
// The webchat adapter exposes openDM() returning `approvals:<handle>` so
// requestApproval() can resolve a delivery target; the row exists in
// messaging_groups so MessagingGroup-shaped APIs work, but it is an approver
// inbox, not a chat room — hidden from the room list.

export const APPROVAL_INBOX_PREFIX = 'approvals:';

export function isApprovalInbox(platformId: string): boolean {
  return platformId.startsWith(APPROVAL_INBOX_PREFIX);
}

/** `webchat:owner` → `approvals:owner`. Null for non-webchat user_ids. */
export function approvalInboxForUser(userId: string): string | null {
  if (!userId.startsWith('webchat:')) return null;
  return `${APPROVAL_INBOX_PREFIX}${userId.slice('webchat:'.length)}`;
}

/** Inverse of `approvalInboxForUser`. Null for non-approval platform_ids. */
export function userForApprovalInbox(platformId: string): string | null {
  if (!platformId.startsWith(APPROVAL_INBOX_PREFIX)) return null;
  return `webchat:${platformId.slice(APPROVAL_INBOX_PREFIX.length)}`;
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
 * Record an approval delivered to a webchat surface (an inbox or a room
 * card). Idempotent — `INSERT OR IGNORE` on the composite key. Trunk's
 * `requestApproval` doesn't stamp platform ids on pending_approvals, so this
 * side-table is where webchat remembers which surfaces rendered which card.
 */
export async function recordWebchatApproval(approvalId: string, platformId: string): Promise<void> {
  await getDb().run(
    `INSERT OR IGNORE INTO webchat_approvals_index (approval_id, platform_id, recorded_at)
       VALUES (?, ?, ?)`,
    approvalId,
    platformId,
    Date.now(),
  );
}

/** Whether an approval was indexed against the given surface — authorizes the responder. */
export async function isWebchatApprovalIndexedFor(approvalId: string, platformId: string): Promise<boolean> {
  const row = (await getDb().get(
    `SELECT 1 FROM webchat_approvals_index WHERE approval_id = ? AND platform_id = ? LIMIT 1`,
    approvalId,
    platformId,
  )) as { 1: number } | undefined;
  return row !== undefined;
}

/** Every surface the approval was indexed against, in insertion order. */
export async function getWebchatApprovalInboxes(approvalId: string): Promise<string[]> {
  const rows = (await getDb().all(
    `SELECT platform_id FROM webchat_approvals_index WHERE approval_id = ? ORDER BY recorded_at`,
    approvalId,
  )) as { platform_id: string }[];
  return rows.map((r) => r.platform_id);
}

/** Drop every index row for an approval — called after it resolves. */
export async function deleteWebchatApprovalIndex(approvalId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_approvals_index WHERE approval_id = ?`, approvalId);
}

/** Pending approvals destined for this user's inbox (joined against the index). */
export async function getWebchatPendingApprovalsForUser(userId: string): Promise<PendingApprovalRow[]> {
  const platformId = approvalInboxForUser(userId);
  if (!platformId) return [];
  return (await getDb().all(
    `SELECT pa.approval_id, pa.action, pa.title, pa.options_json, pa.payload, pa.created_at
         FROM pending_approvals pa
         JOIN webchat_approvals_index wai ON wai.approval_id = pa.approval_id
        WHERE wai.platform_id = ?
          AND pa.status = 'pending'
        ORDER BY pa.created_at`,
    platformId,
  )) as PendingApprovalRow[];
}

// ── Room ↔ Agent wirings ────────────────────────────────────────────────────

export interface WebchatRoomAgent {
  id: string;
  name: string;
  folder: string;
}

/** The agents wired to a webchat room (v1 invariant: at most one). */
export async function getAgentsForWebchatRoom(roomId: string): Promise<WebchatRoomAgent[]> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return [];
  return (await getDb().all(
    `SELECT ag.id, ag.name, ag.folder
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE mga.messaging_group_id = ?
       ORDER BY ag.name`,
    mg.id,
  )) as WebchatRoomAgent[];
}

/**
 * Remove a single (room, agent) wiring. Returns true if a row was deleted.
 * Also drops the matching agent_destinations row so the agent's session
 * doesn't keep a destination pointing at a chat it can no longer write to.
 */
export async function unwireAgentFromWebchatRoom(roomId: string, agentGroupId: string): Promise<boolean> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return false;
  const db = getDb();
  const result = await db.run(
    `DELETE FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?`,
    mg.id,
    agentGroupId,
  );
  if (await hasTable(db, 'agent_destinations')) {
    await db.run(
      `DELETE FROM agent_destinations
       WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ?`,
      agentGroupId,
      mg.id,
    );
  }
  return result.changes > 0;
}

export interface AgentWebchatRoom {
  id: string; // room platform_id
  name: string;
}

/** The webchat rooms a given agent is wired to (excludes approval inboxes). */
export async function getWebchatRoomsForAgent(agentGroupId: string): Promise<AgentWebchatRoom[]> {
  const rows = (await getDb().all(
    `SELECT mg.platform_id AS id, mg.name AS name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mga.agent_group_id = ? AND mg.channel_type = 'webchat'
       ORDER BY mg.name`,
    agentGroupId,
  )) as { id: string; name: string | null }[];
  return rows.filter((r) => !isApprovalInbox(r.id)).map((r) => ({ id: r.id, name: r.name ?? r.id }));
}

/**
 * The agent that produces messages for this room. One agent per room is a v1
 * invariant, so this is simply the wired agent (null when unwired). Kept as
 * its own accessor because the multi-agent build replaces this body with a
 * most-recently-active-session heuristic.
 */
export async function findActiveAgentForWebchatRoom(roomId: string): Promise<WebchatRoomAgent | null> {
  const agents = await getAgentsForWebchatRoom(roomId);
  return agents[0] ?? null;
}

// ── Prime agent designation ─────────────────────────────────────────────────
// v1: the room's single wired agent IS the prime. setPrime is stamped by
// wireAgentToRoom (server.ts); deleting an agent clears any prime rows that
// pointed at it so getPrime never returns a ghost.

export async function setPrimeAgentForWebchatRoom(roomId: string, agentGroupId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_room_primes (room_id, agent_group_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET agent_group_id = excluded.agent_group_id, created_at = excluded.created_at`,
    roomId,
    agentGroupId,
    Date.now(),
  );
}

export async function clearPrimeAgentForAgentGroup(agentGroupId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_room_primes WHERE agent_group_id = ?`, agentGroupId);
}

// ── Messages ────────────────────────────────────────────────────────────────

export async function storeWebchatMessage(
  roomId: string,
  sender: string,
  senderType: string,
  content: string,
): Promise<WebchatMessage> {
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
  await getDb().run(
    `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return msg;
}

export async function storeWebchatFileMessage(
  roomId: string,
  sender: string,
  senderType: string,
  caption: string,
  fileMeta: FileMeta,
): Promise<WebchatMessage> {
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
  await getDb().run(
    `INSERT INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: JSON.stringify(fileMeta) },
  );
  return msg;
}

/**
 * Store an ACTIONABLE approval card in the agent's room. `message_type =
 * 'approval'`; content carries the ask_question payload. Keyed by a
 * deterministic id so re-firing is idempotent and the card can be updated on
 * resolution.
 */
export async function storeWebchatApprovalCard(
  roomId: string,
  sender: string,
  payload: {
    questionId: string;
    title: string;
    question: string;
    options: unknown;
    action: string;
  },
): Promise<WebchatMessage> {
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
  await getDb().run(
    `INSERT OR REPLACE INTO webchat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at)
       VALUES (@id, @room_id, @sender, @sender_type, @content, @message_type, @file_meta, @created_at)`,
    { ...msg, file_meta: null },
  );
  return msg;
}

/** Flip an in-room approval card to resolved (adds `resolvedBy` to its payload). */
export async function markRoomApprovalResolved(approvalId: string, resolvedBy: string): Promise<void> {
  const id = `appr-card-${approvalId}`;
  const row = (await getDb().get(`SELECT content FROM webchat_messages WHERE id = ?`, id)) as
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
  await getDb().run(
    `UPDATE webchat_messages SET message_type = 'approval_resolved', content = ? WHERE id = ?`,
    JSON.stringify(payload),
    id,
  );
}

export async function getWebchatMessages(roomId: string, limit = 200): Promise<WebchatMessage[]> {
  const rows = (await getDb().all(
    `SELECT * FROM webchat_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
    roomId,
    limit,
  )) as WebchatMessageRow[];
  return rows.reverse().map(rowToMessage);
}

/**
 * Delete a message — only the original sender (matched on `sender` text)
 * may delete their own, AND only within the room they're connected to.
 * Returns true on success.
 */
export async function deleteWebchatMessage(
  messageId: string,
  requesterIdentity: string,
  roomId: string,
): Promise<boolean> {
  const result = await getDb().run(
    `DELETE FROM webchat_messages WHERE id = ? AND sender = ? AND room_id = ?`,
    messageId,
    requesterIdentity,
    roomId,
  );
  return result.changes > 0;
}

/** Messages strictly after the anchor id — the WS reconnect replay path. */
export async function getWebchatMessagesAfterId(
  roomId: string,
  afterId: string,
  limit = 500,
): Promise<WebchatMessage[]> {
  const anchor = (await getDb().get(`SELECT created_at, id FROM webchat_messages WHERE id = ?`, afterId)) as
    | { created_at: number; id: string }
    | undefined;
  if (!anchor) return [];
  // (created_at, id) keyset: same-millisecond siblings tie-break on id instead
  // of being dropped by a strict created_at comparison.
  const rows = (await getDb().all(
    `SELECT * FROM webchat_messages
       WHERE room_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at, id LIMIT ?`,
    roomId,
    anchor.created_at,
    anchor.created_at,
    anchor.id,
    limit,
  )) as WebchatMessageRow[];
  return rows.map(rowToMessage);
}

/**
 * Older-message pagination (scroll-back). Returns up to `limit` messages
 * immediately BEFORE `beforeId`, oldest-to-newest so the client can prepend
 * them as one ascending block. An empty/short result means the start of
 * history has been reached.
 */
export async function getWebchatMessagesBeforeId(
  roomId: string,
  beforeId: string,
  limit = 50,
): Promise<WebchatMessage[]> {
  const anchor = (await getDb().get(`SELECT created_at, id FROM webchat_messages WHERE id = ?`, beforeId)) as
    | { created_at: number; id: string }
    | undefined;
  if (!anchor) return [];
  const rows = (await getDb().all(
    `SELECT * FROM webchat_messages
       WHERE room_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    roomId,
    anchor.created_at,
    anchor.created_at,
    anchor.id,
    limit,
  )) as WebchatMessageRow[];
  return rows.reverse().map(rowToMessage);
}

// ── Install settings (webchat_settings singleton) ───────────────────────────
// The row is seeded by migration; setters are plain UPDATEs on id=1.

function settingsGetter<T>(column: string, decode: (value: unknown) => T): () => Promise<T> {
  return async () => {
    try {
      const row = (await getDb().get(`SELECT ${column} FROM webchat_settings WHERE id = 1`)) as
        | Record<string, unknown>
        | undefined;
      return decode(row?.[column]);
    } catch {
      return decode(undefined);
    }
  };
}

function settingsSetter<V>(column: string, encode: (value: V) => string | number | null): (value: V) => Promise<void> {
  return async (value) => {
    await getDb().run(
      `UPDATE webchat_settings SET ${column} = ?, updated_at = ? WHERE id = 1`,
      encode(value),
      Date.now(),
    );
  };
}

const decodeBool = (v: unknown): boolean => v === 1;
const encodeBool = (v: boolean): number => (v ? 1 : 0);
const decodeNullableString = (v: unknown): string | null => (v as string | null) ?? null;
const encodeNullableString = (v: string | null): string | null => v;

/** First-run wizard state. Defaults false so a fresh install shows the wizard. */
export const getOnboardingComplete = settingsGetter('onboarding_complete', decodeBool);
export const setOnboardingComplete = settingsSetter('onboarding_complete', encodeBool);

/** Bearer-token opt-out: true = WEBCHAT_TOKEN is ignored by auth.ts. */
export const getBearerTokenDisabled = settingsGetter('bearer_token_disabled', decodeBool);
export const setBearerTokenDisabled = settingsSetter('bearer_token_disabled', encodeBool);

// ── Model roster ────────────────────────────────────────────────────────────

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

export async function listWebchatModels(): Promise<WebchatModel[]> {
  return (await getDb().all(`SELECT * FROM webchat_models ORDER BY name COLLATE NOCASE`)) as WebchatModel[];
}

export async function getWebchatModel(id: string): Promise<WebchatModel | undefined> {
  return (await getDb().get(`SELECT * FROM webchat_models WHERE id = ?`, id)) as WebchatModel | undefined;
}

export async function createWebchatModel(m: WebchatModel): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_models (id, name, kind, endpoint, model_id, credential_ref, created_at)
       VALUES (@id, @name, @kind, @endpoint, @model_id, @credential_ref, @created_at)`,
    m,
  );
}

export async function updateWebchatModel(
  id: string,
  patch: { name?: string; endpoint?: string | null; model_id?: string; credential_ref?: string | null },
): Promise<void> {
  const existing = await getWebchatModel(id);
  if (!existing) return;
  const next = { ...existing, ...patch };
  await getDb().run(
    `UPDATE webchat_models
       SET name = ?, endpoint = ?, model_id = ?, credential_ref = ?
       WHERE id = ?`,
    next.name,
    next.endpoint,
    next.model_id,
    next.credential_ref,
    id,
  );
}

export async function deleteWebchatModel(id: string): Promise<void> {
  const db = getDb();
  // Cascade in JS — caller is expected to have surfaced the impact list.
  await db.run(`DELETE FROM webchat_agent_models WHERE model_id = ?`, id);
  await db.run(`DELETE FROM webchat_models WHERE id = ?`, id);
}

export async function getAgentsAssignedToModel(modelId: string): Promise<string[]> {
  return (
    (await getDb().all(`SELECT agent_group_id FROM webchat_agent_models WHERE model_id = ?`, modelId)) as {
      agent_group_id: string;
    }[]
  ).map((r) => r.agent_group_id);
}

export async function getAssignedModelForAgent(agentGroupId: string): Promise<WebchatModel | null> {
  const row = (await getDb().get(
    `SELECT model_id FROM webchat_agent_models WHERE agent_group_id = ?`,
    agentGroupId,
  )) as { model_id: string } | undefined;
  if (!row) return null;
  return (await getWebchatModel(row.model_id)) ?? null;
}

/**
 * Install-wide DEFAULT model — the roster model every agent WITHOUT its own
 * assignment falls back to.
 */
export const getDefaultModelId = settingsGetter('default_model_id', decodeNullableString);
export const setDefaultModelId = settingsSetter('default_model_id', encodeNullableString);

/** The model that actually powers an agent: its own assignment, else the default. */
export async function getEffectiveModelForAgent(agentGroupId: string): Promise<WebchatModel | null> {
  const assigned = await getAssignedModelForAgent(agentGroupId);
  if (assigned) return assigned;
  const defaultId = await getDefaultModelId();
  return defaultId ? ((await getWebchatModel(defaultId)) ?? null) : null;
}

export async function assignModelToAgent(agentGroupId: string, modelId: string): Promise<void> {
  await getDb().run(
    `INSERT INTO webchat_agent_models (agent_group_id, model_id, assigned_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_group_id) DO UPDATE SET model_id = excluded.model_id, assigned_at = excluded.assigned_at`,
    agentGroupId,
    modelId,
    Date.now(),
  );
}

export async function unassignModelFromAgent(agentGroupId: string): Promise<void> {
  await getDb().run(`DELETE FROM webchat_agent_models WHERE agent_group_id = ?`, agentGroupId);
}
