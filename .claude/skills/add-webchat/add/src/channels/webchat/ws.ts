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
import { WSClient, clients, addClient, removeClient, broadcast, getMemberList } from './state.js';
import {
  deleteWebchatMessage,
  getAllWebchatRooms,
  getWebchatMessages,
  getWebchatRoom,
  storeWebchatMessage,
} from './db.js';
import { canAccessRoom, filterRoomsForUser } from './access.js';
import { redactSensitiveData } from './redact.js';

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
        send({ type: 'rooms', rooms: filterRoomsForUser(client.userId, getAllWebchatRooms()) });
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

      // ── MESSAGE ──────────────────────────────────────────────────────────
      if (msg.type === 'message') {
        if (!client.room_id) {
          send({ type: 'error', error: 'Join a room first' });
          return;
        }
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text.trim()) return;

        const stored = storeWebchatMessage(client.room_id, client.identity, client.identity_type, text);
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
