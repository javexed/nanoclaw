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
} from './db.js';
import { canAccessRoom } from './access.js';
import { redactSensitiveData } from './redact.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getRunningSessions } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';

/**
 * Deliver a "stop" signal to every live session behind a webchat room (the GUI
 * Stop button — the in-browser equivalent of the CLI's ESC). Writes a trigger=0
 * `interrupt` control row into each running session's inbound.db; the container's
 * poll-loop aborts the active stream when it sees one mid-turn, and treats a
 * stale one (no live stream) as a no-op. Never wakes/spawns a container — there's
 * nothing to interrupt if none is running.
 */
function interruptRoomSessions(roomId: string): void {
  const mg = getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return;
  const sessions = getRunningSessions().filter((s) => s.messaging_group_id === mg.id);
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
  /** Inbound chat from a connected client → router. */
  onInbound: (roomId: string, message: InboundMessage) => void;
}

export interface AuthForUpgrade {
  userId: string;
  displayName: string;
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
        // Opening a room reads it: advance the marker and clear any stale dot
        // on this user's other devices.
        markRoomReadForUser(client.userId, room.id, Date.now(), clientId);
        send({
          type: 'history',
          room_id: room.id,
          messages: getWebchatMessages(room.id, 50).map((m) => ({
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

        const stored = storeWebchatMessage(client.room_id, client.identity, client.identity_type, text);
        // The sender has by definition read their own message — advance their
        // marker (and sync their other devices) so it never self-unreads.
        markRoomReadForUser(client.userId, client.room_id, stored.created_at, clientId);
        const outgoing: Record<string, unknown> = { type: 'message', ...stored };
        if (typeof msg.client_id === 'string') outgoing.client_id = msg.client_id;
        broadcast(client.room_id, outgoing, clientId);

        // Pipe the inbound to the router so the agent sees it. content carries
        // senderId (namespaced for the v2 permissions module's senderResolver).
        hooks.onInbound(client.room_id, {
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
        });

        send({ ...outgoing, content: redactSensitiveData(stored.content) });
        return;
      }

      // ── INTERRUPT (GUI "stop", the ESC equivalent) ───────────────────────
      if (msg.type === 'interrupt') {
        if (!client.room_id) return;
        interruptRoomSessions(client.room_id);
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
