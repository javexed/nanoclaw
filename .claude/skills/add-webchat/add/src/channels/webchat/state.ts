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
import { filterRoomsForUser } from './access.js';
import { getAllWebchatRooms, getWebchatRoom } from './db.js';
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
      members.push({ identity: c.identity, identity_type: c.identity_type });
    }
  }
  const agentIdentity = activeAgents.get(roomId);
  if (agentIdentity && !seen.has(agentIdentity)) {
    members.push({ identity: agentIdentity, identity_type: 'agent' });
  }
  return members;
}

export function broadcast(roomId: string, msg: object, excludeId?: string): void {
  const isMessage = (msg as { type?: string }).type === 'message';
  const outgoing = isMessage
    ? { ...msg, content: redactSensitiveData((msg as { content?: string }).content || '') }
    : msg;
  const payload = JSON.stringify(outgoing);
  const notifyPayload = isMessage ? JSON.stringify({ type: 'unread', room_id: roomId }) : '';

  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (c.room_id === roomId) c.ws.send(payload);
      else if (isMessage) c.ws.send(notifyPayload);
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }

  if (isMessage) {
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
export function broadcastRooms(): void {
  const allRooms = getAllWebchatRooms();
  for (const c of clients.values()) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    const visible = filterRoomsForUser(c.userId, allRooms);
    c.ws.send(JSON.stringify({ type: 'rooms', rooms: visible }));
  }
}
