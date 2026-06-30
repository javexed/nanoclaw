/**
 * Webchat WebSocket protocol.
 *
 * Handshake: HTTP upgrade on /ws is gated by authenticateRequest(); once
 * promoted to a WS, the client sends `{type:'auth'}` to bind the connection
 * to its derived userId. Subsequent messages: join / typing / message /
 * delete_message.
 *
 * v1 → v2 changes:
 *   - Dropped agent-token auth (`getChatAgentToken`) — Q4: agents push via
 *     outbound.db, not back through this WS.
 *   - Inbound chat messages are pushed via the `onInbound` hook supplied at
 *     server start, not via the v1 setOnNewMessage callback registry.
 *   - The inbound payload's `content` carries `senderId` (v2-namespaced) so
 *     the permissions module's senderResolver upserts the correct users row.
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import type { InboundMessage } from '../adapter.js';
import {
  WSClient,
  clients,
  addClient,
  removeClient,
  broadcast,
  getMemberList,
  annotateRoomsForUser,
  markRoomReadForUser,
} from './state.js';
import {
  deleteWebchatMessage,
  ensureWebchatUserHandle,
  getWebchatMessages,
  getWebchatRoom,
  storeWebchatMessage,
  MAIN_THREAD,
  threadToSessionKey,
  markThreadRead,
  resolveBoundedThread,
} from './db.js';
import { canAccessRoom } from './access.js';
import { redactSensitiveData } from './redact.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getRunningSessions } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { writeSessionMessage } from '../../session-manager.js';

/**
 * Deliver a "stop" signal to live session(s) behind a webchat room (the GUI Stop
 * button — the in-browser equivalent of the CLI's ESC). Writes a trigger=0
 * `interrupt` control row into each targeted running session's inbound.db; the
 * container's poll-loop aborts the active stream when it sees one mid-turn, and
 * treats a stale one (no live stream) as a no-op. Never wakes/spawns a container.
 *
 * `agentName` (the thinking bubble's per-agent Stop) targets just that agent's
 * session; omitted, it stops every running agent in the room.
 */
function interruptRoomSessions(roomId: string, agentName?: string | null): void {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return;
  let sessions = getRunningSessions().filter((s) => s.messaging_group_id === mg.id);
  if (agentName) {
    sessions = sessions.filter((s) => getAgentGroup(s.agent_group_id)?.name === agentName);
  }
  for (const s of sessions) {
    writeSessionMessage(s.agent_group_id, s.id, {
      id: `interrupt-${randomUUID()}`,
      kind: 'interrupt',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ reason: 'user-stop' }),
      trigger: 0, // control signal only — must not wake/spawn a container
    });
  }
}

// Cap inbound WS messages — chat payloads are small (text, controls);
// without this, ws's default (100 MB) lets an authenticated client OOM the
// host with one giant JSON.
const WS_MAX_PAYLOAD = 1024 * 1024; // 1 MB
const WS_PING_INTERVAL = 30_000;

// Carries identity from the HTTP upgrade into the WS connection event.
// `(req as any)._authUserId` would typecheck via cast but offends the
// no-explicit-any rule that v2 enforces; a typed augmentation keeps it clean.
interface AuthedUpgradeRequest extends http.IncomingMessage {
  _authUserId?: string;
  _authDisplayName?: string;
}

export interface WSHooks {
  /** Inbound chat from a connected client → router. `threadId` is the session
   * key (null = the room's main/default thread). */
  onInbound: (roomId: string, message: InboundMessage, threadId: string | null) => void;
}

export interface AuthForUpgrade {
  userId: string;
  displayName: string;
}

// Inbound-message idempotency. A client_id seen within this window is a duplicate
// delivery of the same logical send (flaky-socket resend, future offline-outbox
// replay, double-fire) and is dropped so it can't spawn a second agent turn. The
// id is unique per send (client mints `local-<seq>-<ts>`), so global keying never
// collides across users/rooms.
const CLIENT_ID_DEDUP_WINDOW_MS = 10_000;
const seenClientIds = new Map<string, number>();

/**
 * Atomically claim a client_id: returns true if it is fresh (proceed) and records
 * it; returns false if it was already seen within the window (drop the duplicate).
 * Opportunistically prunes expired ids to bound memory. Exported for tests.
 */
export function claimClientId(id: string, now: number = Date.now()): boolean {
  const prev = seenClientIds.get(id);
  if (prev !== undefined && now - prev < CLIENT_ID_DEDUP_WINDOW_MS) return false;
  seenClientIds.set(id, now);
  if (seenClientIds.size > 1000) {
    for (const [k, t] of seenClientIds) if (now - t >= CLIENT_ID_DEDUP_WINDOW_MS) seenClientIds.delete(k);
  }
  return true;
}

export function setupWebSocket(
  server: http.Server,
  hooks: WSHooks,
  authenticate: (req: http.IncomingMessage) => Promise<AuthForUpgrade | null>,
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // Ping/pong keepalive — terminate clients that don't pong within the window.
  const pingTimer = setInterval(() => {
    for (const c of clients.values()) {
      if (!c.isAlive) {
        c.ws.terminate();
        removeClient(c.id);
        continue;
      }
      c.isAlive = false;
      c.ws.ping();
    }
  }, WS_PING_INTERVAL);
  wss.on('close', () => clearInterval(pingTimer));

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    void (async () => {
      const auth = await authenticate(req);
      if (!auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        const augmented = req as AuthedUpgradeRequest;
        augmented._authUserId = auth.userId;
        augmented._authDisplayName = auth.displayName;
        wss.emit('connection', ws, req);
      });
    })().catch((err) => {
      log.warn('Webchat WS upgrade failed', { err });
      socket.destroy();
    });
  });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const augmented = req as AuthedUpgradeRequest;
    const clientId = randomUUID();
    const userId = augmented._authUserId ?? 'webchat:unknown';
    const displayName = augmented._authDisplayName ?? userId;
    // Make this user @-mentionable right away: ensure a handle exists (defaults
    // to a slug of the display name, suffixed on collision). Idempotent.
    try {
      ensureWebchatUserHandle(userId, displayName);
    } catch (err) {
      log.warn('ensureWebchatUserHandle failed', { userId, err: err instanceof Error ? err.message : err });
    }

    const client: WSClient = {
      id: clientId,
      ws,
      identity: displayName,
      identity_type: 'user',
      userId,
      isAlive: true,
    };
    addClient(client);

    ws.on('pong', () => {
      client.isAlive = true;
    });
    ws.on('error', (err) => {
      log.warn('Webchat WS client error', { clientId, identity: client.identity, err: err.message });
    });

    let authenticated = false;
    const send = (data: object): void => {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // Socket may have closed between send-side check and write — swallow.
      }
    };

    ws.on('message', (raw) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        send({ type: 'error', error: 'Invalid JSON' });
        return;
      }

      // ── AUTH ────────────────────────────────────────────────────────────
      if (msg.type === 'auth') {
        // v2: agent-token auth dropped. The upgrade-time identity is the only
        // identity. The auth message just confirms the session is established.
        authenticated = true;
        send({ type: 'system', message: `Connected as ${client.identity}` });
        // Annotated payload (incl. per-user `unread`) so the sidebar reconstructs
        // unread badges on reconnect — not just for messages seen live.
        send({ type: 'rooms', rooms: annotateRoomsForUser(client.userId) });
        return;
      }

      if (!authenticated) {
        send({ type: 'error', error: 'Not authenticated' });
        return;
      }

      // ── JOIN ─────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        const roomId = typeof msg.room_id === 'string' ? msg.room_id : '';
        const room = getWebchatRoom(roomId);
        if (!room) {
          send({ type: 'error', error: `Room not found: ${roomId}` });
          return;
        }
        if (!canAccessRoom(client.userId, room.id)) {
          send({ type: 'error', error: 'Access denied' });
          return;
        }
        client.room_id = room.id;
        // Thread being opened (default 'main'). History is filtered to it; live
        // messages still arrive room-wide and the client routes them by thread.
        const joinThread = typeof msg.thread_id === 'string' && msg.thread_id ? msg.thread_id : MAIN_THREAD;
        client.thread_id = joinThread;
        // Opening reads it: advance the room marker (clears the room dot + syncs
        // devices) and the per-thread marker.
        markRoomReadForUser(client.userId, room.id, Date.now(), clientId);
        markThreadRead(client.userId, room.id, joinThread);
        send({
          type: 'history',
          room_id: room.id,
          thread_id: joinThread,
          messages: getWebchatMessages(room.id, 50, joinThread).map((m) => ({
            ...m,
            content: redactSensitiveData(m.content),
          })),
        });
        broadcast(room.id, { type: 'system', room_id: room.id, message: `${client.identity} joined` }, clientId);
        broadcast(room.id, {
          type: 'members',
          room_id: room.id,
          members: getMemberList(room.id),
        });
        return;
      }

      // ── TYPING ───────────────────────────────────────────────────────────
      if (msg.type === 'typing') {
        if (!client.room_id) return;
        broadcast(
          client.room_id,
          {
            type: 'typing',
            room_id: client.room_id,
            identity: client.identity,
            identity_type: client.identity_type,
            is_typing: !!msg.is_typing,
          },
          clientId,
        );
        return;
      }

      // ── READ ─────────────────────────────────────────────────────────────
      // Client signals it has caught up on a room (e.g. a message arrived while
      // the room was open and focused). Advances the server marker and clears
      // the badge on the user's other devices. Scoped to rooms the user can see.
      if (msg.type === 'read') {
        const roomId = typeof msg.room_id === 'string' ? msg.room_id : '';
        if (!roomId) return;
        const room = getWebchatRoom(roomId);
        if (!room || !canAccessRoom(client.userId, room.id)) return;
        markRoomReadForUser(client.userId, room.id, Date.now(), clientId);
        // Per-thread marker (default 'main') so thread badges clear too.
        const readThread = typeof msg.thread_id === 'string' && msg.thread_id ? msg.thread_id : MAIN_THREAD;
        markThreadRead(client.userId, room.id, readThread);
        return;
      }

      // ── MESSAGE ──────────────────────────────────────────────────────────
      if (msg.type === 'message') {
        if (!client.room_id) {
          send({ type: 'error', error: 'Join a room first' });
          return;
        }
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text.trim()) return;

        // Idempotency: a duplicate delivery of the same client_id (flaky-socket
        // resend / double-fire) must NOT create a second inbound row → a second
        // agent turn → a phantom reply. The first delivery already echoed the
        // sender's optimistic bubble, so the repeat is dropped silently.
        const cid = typeof msg.client_id === 'string' ? msg.client_id : null;
        if (cid && !claimClientId(cid)) {
          log.warn('Webchat: dropped duplicate message (client_id already seen)', {
            clientId: cid,
            identity: client.identity,
          });
          return;
        }

        // Resolve the thread this message belongs to, BOUNDED so an arbitrary
        // client-supplied thread_id can't lazily spawn unbounded threads/sessions
        // (the spawn-amplification vector). See resolveBoundedThread in db.ts —
        // shared with the file-upload handlers so both enforce the same bound.
        const storeThread = resolveBoundedThread(client.room_id, msg.thread_id);

        const stored = storeWebchatMessage(client.room_id, client.identity, client.identity_type, text, storeThread);
        // The sender has by definition read their own message — advance their
        // marker (and sync their other devices) so it never self-unreads.
        markRoomReadForUser(client.userId, client.room_id, stored.created_at, clientId);
        const outgoing: Record<string, unknown> = { type: 'message', ...stored };
        if (typeof msg.client_id === 'string') outgoing.client_id = msg.client_id;
        broadcast(client.room_id, outgoing, clientId);

        // Pipe the inbound to the router so the agent sees it. content carries
        // senderId (namespaced for the v2 permissions module's senderResolver).
        // threadId is the SESSION key (null for main) so per-thread routing keys
        // the right session.
        hooks.onInbound(
          client.room_id,
          {
            id: stored.id,
            kind: 'chat',
            timestamp: new Date(stored.created_at).toISOString(),
            isGroup: true,
            content: {
              text,
              sender: client.identity,
              senderId: client.userId,
              senderName: client.identity,
            },
          },
          threadToSessionKey(storeThread),
        );

        send({ ...outgoing, content: redactSensitiveData(stored.content) });
        return;
      }

      // ── INTERRUPT (GUI "stop", the ESC equivalent) ───────────────────────
      if (msg.type === 'interrupt') {
        if (!client.room_id) return;
        const agentName = typeof msg.agent_name === 'string' ? msg.agent_name : undefined;
        interruptRoomSessions(client.room_id, agentName);
        return;
      }

      // ── DELETE MESSAGE ───────────────────────────────────────────────────
      if (msg.type === 'delete_message') {
        if (!client.room_id) return;
        const messageId = typeof msg.message_id === 'string' ? msg.message_id : '';
        if (!messageId) {
          send({ type: 'error', error: 'message_id required' });
          return;
        }
        const deleted = deleteWebchatMessage(messageId, client.identity, client.room_id);
        if (deleted) {
          broadcast(client.room_id, {
            type: 'delete_message',
            room_id: client.room_id,
            message_id: messageId,
          });
        }
        return;
      }
    });

    ws.on('close', () => {
      const c = removeClient(clientId);
      if (c?.room_id) {
        broadcast(c.room_id, {
          type: 'system',
          room_id: c.room_id,
          message: `${c.identity} left`,
        });
        broadcast(c.room_id, {
          type: 'members',
          room_id: c.room_id,
          members: getMemberList(c.room_id),
        });
      }
    });
  });
}
