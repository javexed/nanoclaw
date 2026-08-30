/**
 * Webchat in-memory client registry + broadcast.
 *
 * Tracks connected WS clients per room and fans out broadcasts, applying
 * redaction to message bodies before they leave the host. Single-user build:
 * no per-user room filtering, no push, no @-mention resolution — but the
 * client/room split stays, because one user has many TABS (and devices), and
 * the "message landed in a room you're not looking at" unread nudge is a
 * multi-tab feature, not a multi-user one.
 */
import { WebSocket } from 'ws';

import { log } from '../../log.js';
import { getAllWebchatRooms, getRoomLastActivity, type WebchatRoom } from './db.js';
import { redactMessageContent } from './redact.js';

export interface WSClient {
  id: string;
  ws: WebSocket;
  /** Display name shown in the chat. Equals `userId` when no separate name. */
  identity: string;
  identity_type: 'user' | 'agent';
  /** v2-namespaced user id (`webchat:owner` / `webchat:local-owner`). */
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

// ── Active agent turns (for thinking-bubble replay on room re-join) ─────────
// Status frames are broadcast live only to clients CURRENTLY in the room and
// are ephemeral — so a client that leaves and returns mid-turn never sees the
// bubble again. Track which agents have an open turn per room so a re-join
// can replay a synthetic `start`. start adds; done/stalled removes.
const activeTurns = new Map<string, Set<string>>();

export function recordTurnStart(roomId: string, agentName: string): void {
  let set = activeTurns.get(roomId);
  if (!set) activeTurns.set(roomId, (set = new Set()));
  set.add(agentName);
}

export function recordTurnEnd(roomId: string, agentName: string): void {
  const set = activeTurns.get(roomId);
  if (!set) return;
  set.delete(agentName);
  if (set.size === 0) activeTurns.delete(roomId);
}

/** Agent names with an open turn in this room — replayed to a joining client. */
export function getActiveTurns(roomId: string): string[] {
  return [...(activeTurns.get(roomId) ?? [])];
}

export async function broadcast(roomId: string, msg: object, excludeId?: string): Promise<void> {
  const m = msg as { type?: string; content?: string; message_type?: Parameters<typeof redactMessageContent>[0] };
  const isMessage = m.type === 'message';
  const outgoing = isMessage
    ? { ...msg, content: redactMessageContent(m.message_type ?? 'text', m.content || '') }
    : msg;
  const payload = JSON.stringify(outgoing);
  const notifyPayload = isMessage ? JSON.stringify({ type: 'unread', room_id: roomId }) : '';

  let inRoom = 0;
  let elsewhere = 0;
  for (const c of clients.values()) {
    if (c.id === excludeId || c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      if (c.room_id === roomId) {
        inRoom += 1;
        c.ws.send(payload);
      } else if (isMessage) {
        elsewhere += 1;
        c.ws.send(notifyPayload);
      }
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
  // A message nobody is in the room for, while clients ARE connected, is the
  // signature of "I sent it and saw nothing until I switched rooms and back":
  // the sender's own socket is tracking a different room, so it takes the
  // unread branch instead of receiving the message. Worth a line, because the
  // alternative is diagnosing it from the absence of evidence.
  if (isMessage && inRoom === 0 && elsewhere > 0) {
    log.warn('Webchat: message broadcast with no client in the room', { roomId, clientsElsewhere: elsewhere });
  }
}

/**
 * Send a payload to every connected client matching `userId` — the
 * approval-inbox delivery path: the card reaches all of the owner's open
 * tabs regardless of which room each has selected. Returns how many clients
 * received it.
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
 * Push a typed `approval` event with the ask_question payload spread onto it.
 * Logs when the approver isn't connected — the PWA refetches
 * /api/approvals/pending on connect, so the card surfaces on next open.
 */
export function pushApprovalToUser(userId: string, askQuestionPayload: Record<string, unknown>): void {
  const sent = pushToUser(userId, { type: 'approval', ...askQuestionPayload });
  if (sent === 0) {
    log.info('Webchat approval queued for offline user', { userId });
  }
}

/** Push `approval_resolved` so open tabs hide a card that was handled elsewhere. */
export function pushApprovalResolvedToUser(userId: string, approvalId: string, resolvedByUserId: string): void {
  pushToUser(userId, { type: 'approval_resolved', approvalId, resolvedBy: resolvedByUserId });
}

/** Room list rows as the client renders them — name + activity sort key. */
export async function annotateRooms(
  allRoomsIn?: WebchatRoom[],
  activityMapIn?: Map<string, number>,
): Promise<Array<WebchatRoom & { last_activity: number }>> {
  const allRooms = allRoomsIn ?? (await getAllWebchatRooms());
  const activityMap = activityMapIn ?? (await getRoomLastActivity());
  return allRooms.map((r) => ({ ...r, last_activity: activityMap.get(r.id) ?? r.created_at }));
}

/** Push the current room list to every connected client. Called by the routes that mutate rooms. */
export async function broadcastRooms(): Promise<void> {
  const rooms = await annotateRooms();
  const payload = JSON.stringify({ type: 'rooms', rooms });
  for (const c of clients.values()) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      c.ws.send(payload);
    } catch {
      // Socket may have closed between readyState check and send — ignore.
    }
  }
}
