/**
 * Webchat in-memory client registry + broadcast.
 *
 * Tracks connected WS clients per room, fans out broadcasts, and triggers
 * Web Push to offline subscribers. Redaction is applied to message bodies
 * before they leave the host.
 *
 * Differences from the v1 module:
 *   - No setOnNewMessage / setOnGroupUpdated callback registry. The hooks
 *     for inbound chat messages are passed at server start; room-list
 *     changes are broadcast eagerly by the routes that mutate them, since
 *     v2 has no central group-change event (per design Q1=c).
 *   - getChatRoom / getChatRooms calls are routed through webchat/db.ts.
 */
import { WebSocket } from 'ws';

import { log } from '../../log.js';
import { canArchiveRoom, filterRoomsForUser } from './access.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  getAllWebchatRooms,
  getArchivedRoomIds,
  getHiddenRoomIdsForUser,
  getSharedWebchatRooms,
  getMentionedRoomIdsForUser,
  getPinnedPositionsForUser,
  getRoomLastActivity,
  getUnreadRoomIdsForUser,
  getWebchatRoom,
  getWebchatUserHandle,
  markRoomRead,
  resolveHandlesToUserIds,
  storeWebchatA2aMessage,
  type WebchatRoom,
} from './db.js';
import { sendPushForMessage } from './push.js';
import { redactSensitiveData } from './redact.js';

export interface WSClient {
  id: string;
  ws: WebSocket;
  /** Display name shown in the chat. Equals `userId` when no separate name. */
  identity: string;
  identity_type: 'user' | 'agent';
  /**
   * v2-namespaced user id (`webchat:owner`, `webchat:tailscale:<email>`, ...).
   * Threaded into inbound message content as `senderId` so the permissions
   * module's senderResolver can upsert the users row and gate access.
   */
  userId: string;
  room_id?: string;
  isAlive: boolean;
}

export const clients = new Map<string, WSClient>();

export function addClient(c: WSClient): void {
  clients.set(c.id, c);
}

export function removeClient(id: string): WSClient | undefined {
  const c = clients.get(id);
  clients.delete(id);
  return c;
}

interface MemberInfo {
  identity: string;
  identity_type: 'user' | 'agent';
  /** Human members' @-mention handle, for the client's @ autocomplete. */
  handle?: string;
}

// Tracked separately from `clients` because the agent isn't a WS client —
// the channel adapter's setTyping() flips its presence flag.
const activeAgents = new Map<string, string>(); // roomId -> agent identity

export function getMemberList(roomId: string): MemberInfo[] {
  const seen = new Set<string>();
  const members: MemberInfo[] = [];
  for (const c of clients.values()) {
    if (c.room_id === roomId && !seen.has(c.identity)) {
      seen.add(c.identity);
      members.push({
        identity: c.identity,
        identity_type: c.identity_type,
        handle: getWebchatUserHandle(c.userId) ?? undefined,
      });
    }
  }
  const agentIdentity = activeAgents.get(roomId);
  if (agentIdentity && !seen.has(agentIdentity)) {
    members.push({ identity: agentIdentity, identity_type: 'agent' });
  }
  return members;
}

/** Extract @-mention handle tokens (`@alice`) from message text, lowercased. */
export function extractHandles(text: string): string[] {
  const re = /(?:^|[^a-z0-9_-])@([a-z0-9-]{1,32})/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].toLowerCase());
  return out;
}

export function broadcast(roomId: string, msg: object, excludeId?: string): void {
  const isMessage = (msg as { type?: string }).type === 'message';
  const outgoing = isMessage
    ? { ...msg, content: redactSensitiveData((msg as { content?: string }).content || '') }
    : msg;
  const payload = JSON.stringify(outgoing);
  const notifyPayload = isMessage ? JSON.stringify({ type: 'unread', room_id: roomId }) : '';

  // Resolve @-handle mentions to user ids so a mentioned recipient who isn't in
  // the room gets a distinct `mention` signal (room badge) instead of a plain
  // unread. Parsed from the original text — redaction never touches @handles.
  // In-room recipients render the highlight + fire a mention notification client
  // side from their own handle, so no per-recipient payload is needed here.
  // (Web-push stays generic for now — subscriptions are keyed by display name,
  // not user id, so per-recipient mention tailoring is a follow-up.)
  const mentionedUserIds = isMessage
    ? new Set(resolveHandlesToUserIds(extractHandles((msg as { content?: string }).content || '')))
    : new Set<string>();
  const mentionPayload = JSON.stringify({ type: 'mention', room_id: roomId });

  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (c.room_id === roomId) c.ws.send(payload);
      else if (isMessage) c.ws.send(mentionedUserIds.has(c.userId) ? mentionPayload : notifyPayload);
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }

  // Side-channel a2a copies and in-room approval cards fan out to open tabs
  // (above) but don't push-notify here — a2a is agent chatter, and approvals
  // get their own delivery to approver inboxes.
  if (
    isMessage &&
    !['a2a', 'approval', 'approval_resolved'].includes((msg as { message_type?: string }).message_type ?? '')
  ) {
    const m = msg as { sender?: string; content?: string; id?: string };
    const room = getWebchatRoom(roomId);
    sendPushForMessage({
      roomId,
      roomName: room?.name || roomId,
      sender: m.sender || 'unknown',
      content: redactSensitiveData(m.content || ''),
      messageId: m.id,
    }).catch((err) => log.warn('sendPushForMessage failed', { err: err instanceof Error ? err.message : err }));
  }
}

/**
 * Surface an agent→agent (a2a) message into every webchat room both agents
 * share, as a read-only side-channel copy. Called from the a2a router after a
 * message is delivered to the target agent's session, so humans watching the
 * room can see agents talking to each other (which otherwise happens entirely
 * off-screen). Best-effort and self-contained: any failure is logged and
 * swallowed by the caller so it never blocks routing.
 *
 * `contentJson` is the raw a2a message content (`{"text": "..."}`); only the
 * text is surfaced (file attachments are not). Self-messages (from === to,
 * used for system notes) and empty text are skipped.
 */
export function surfaceA2aMessage(fromAgentGroupId: string, toAgentGroupId: string, contentJson: string): void {
  if (fromAgentGroupId === toAgentGroupId) return;

  let text = '';
  try {
    const parsed = JSON.parse(contentJson) as { text?: unknown };
    if (typeof parsed.text === 'string') text = parsed.text;
  } catch {
    // Non-JSON content — fall back to the raw string.
    text = contentJson;
  }
  text = text.trim();
  if (!text) return;

  const rooms = getSharedWebchatRooms(fromAgentGroupId, toAgentGroupId);
  if (rooms.length === 0) return;

  const fromName = getAgentGroup(fromAgentGroupId)?.name ?? fromAgentGroupId;
  const toName = getAgentGroup(toAgentGroupId)?.name ?? toAgentGroupId;

  for (const room of rooms) {
    const stored = storeWebchatA2aMessage(room.id, fromName, toName, text);
    broadcast(room.id, { type: 'message', ...stored });
  }
}

export function setAgentPresence(roomId: string, identity: string, active: boolean): void {
  const wasBefore = activeAgents.has(roomId);
  if (active) activeAgents.set(roomId, identity);
  else activeAgents.delete(roomId);
  const isNow = activeAgents.has(roomId);
  if (wasBefore !== isNow) {
    broadcast(roomId, {
      type: 'members',
      room_id: roomId,
      members: getMemberList(roomId),
    });
  }
}

/**
 * Send a payload to every connected client matching `userId`. Used by
 * webchat's approval-inbox delivery path — when an admin/owner has an
 * approval queued, the card is pushed to all of their currently-open
 * PWA tabs regardless of which room they have selected.
 *
 * Returns the number of clients that received the payload.
 */
export function pushToUser(userId: string, msg: object): number {
  const payload = JSON.stringify(msg);
  let sent = 0;
  for (const c of clients.values()) {
    if (c.userId !== userId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      c.ws.send(payload);
      sent++;
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
  return sent;
}

/**
 * Convenience wrapper for the approvals delivery path: pushes a typed
 * `approval` event with the ask_question payload spread onto it. Logs at
 * info level when the approver isn't currently connected so the gap is
 * visible (the PWA refetches /api/approvals/pending on connect, so the
 * card will surface on next open — this is informational, not an error).
 */
export function pushApprovalToUser(userId: string, askQuestionPayload: Record<string, unknown>): void {
  const sent = pushToUser(userId, { type: 'approval', ...askQuestionPayload });
  if (sent === 0) {
    log.info('Webchat approval queued for offline user', { userId });
  }
}

/**
 * Push a typed `approval_resolved` event so a connected PWA can hide a fan-out
 * card another admin already handled. Offline users are covered by the PWA's
 * refetch on reconnect (the row is gone), so this is purely the live clear.
 */
export function pushApprovalResolvedToUser(userId: string, approvalId: string, resolvedByUserId: string): void {
  pushToUser(userId, { type: 'approval_resolved', approvalId, resolvedBy: resolvedByUserId });
}

/**
 * Push the current room list to every connected client. Called by the routes
 * that mutate webchat_rooms — webchat-initiated changes only, per Q1=c. We
 * don't try to detect external messaging_groups changes; that would require a
 * polling layer and was scoped out of the v2 PR.
 *
 * Per-client filter: each client only sees rooms whose wired agent groups they
 * can access (`canAccessRoom`). Filtering happens here, not at the call sites,
 * so every broadcastRooms() call stays per-user-correct without each caller
 * threading userId.
 */
/**
 * Annotate the room list for one user with the per-viewer flags the PWA
 * sidebar needs: `archived` (global), `hidden` (per-user), `canArchive`
 * (capability), and `unread` (per-user read marker). Shared by the auth-time
 * send (ws.ts) and broadcastRooms so both paths carry identical metadata —
 * crucially `unread`, so the badge reconstructs on reconnect instead of only
 * appearing for live messages. `allRooms`/`archivedSet` are accepted so a
 * fan-out (broadcastRooms) computes them once across all clients.
 */
export function annotateRoomsForUser(
  userId: string,
  allRooms: WebchatRoom[] = getAllWebchatRooms(),
  archivedSet: Set<string> = getArchivedRoomIds(),
  activityMap: Map<string, number> = getRoomLastActivity(),
): Array<
  WebchatRoom & {
    archived: boolean;
    hidden: boolean;
    canArchive: boolean;
    unread: boolean;
    mention: boolean;
    pinned: boolean;
    pin_position: number | null;
    last_activity: number;
  }
> {
  const visible = filterRoomsForUser(userId, allRooms);
  const hiddenSet = getHiddenRoomIdsForUser(userId); // per-user
  const unreadSet = getUnreadRoomIdsForUser(userId); // per-user
  const mentionSet = getMentionedRoomIdsForUser(userId, getWebchatUserHandle(userId) ?? ''); // per-user
  const pinnedPos = getPinnedPositionsForUser(userId); // per-user: room → manual order
  return visible.map((r) => ({
    ...r,
    archived: archivedSet.has(r.id),
    hidden: hiddenSet.has(r.id),
    canArchive: canArchiveRoom(userId, r.id),
    unread: unreadSet.has(r.id),
    mention: mentionSet.has(r.id),
    pinned: pinnedPos.has(r.id),
    // Manual pin order (lower = higher); null when unpinned. The client sorts the
    // pinned group by this instead of recent activity.
    pin_position: pinnedPos.get(r.id) ?? null,
    // Newest-message time drives the "Recent" sort; fall back to created_at.
    last_activity: activityMap.get(r.id) ?? r.created_at,
  }));
}

export function broadcastRooms(): void {
  const allRooms = getAllWebchatRooms();
  const archivedSet = getArchivedRoomIds(); // global, computed once per broadcast
  const activityMap = getRoomLastActivity(); // global, computed once per broadcast
  for (const c of clients.values()) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    c.ws.send(
      JSON.stringify({ type: 'rooms', rooms: annotateRoomsForUser(c.userId, allRooms, archivedSet, activityMap) }),
    );
  }
}

/**
 * Advance a user's read marker for a room and clear the unread badge live on
 * that user's OTHER connected clients. The `read_cleared` push is what makes
 * read state feel synced across devices: open a room on your phone and the
 * stale dot disappears on your laptop without waiting for a reconnect. The
 * originating client (which already cleared its own dot locally) is skipped.
 */
export function markRoomReadForUser(userId: string, roomId: string, ts: number, originClientId?: string): void {
  markRoomRead(userId, roomId, ts);
  const payload = JSON.stringify({ type: 'read_cleared', room_id: roomId });
  for (const c of clients.values()) {
    if (c.userId !== userId || c.id === originClientId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      c.ws.send(payload);
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
}
