/**
 * Webchat WebSocket protocol — single-user build.
 *
 * Handshake: HTTP upgrade on /ws is gated by authenticateRequest(); once
 * promoted to a WS, the client sends `{type:'auth'}` to bind the connection.
 * Subsequent frames: join / message / interrupt / delete_message.
 *
 * Dropped vs the predecessor: typing indicators, read-marker sync, member
 * rosters, @-handles, per-thread routing (a room is one conversation — the
 * session key is always null/main).
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import { log } from '../../log.js';
import type { InboundMessage } from '../adapter.js';
import { WSClient, clients, addClient, removeClient, broadcast, annotateRooms, getActiveTurns } from './state.js';
import { deleteWebchatMessage, getWebchatMessages, getWebchatRoom, storeWebchatMessage } from './db.js';
import { redactMessageContent } from './redact.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getRunningSessions } from '../../db/sessions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { writeSessionMessage } from '../../session-manager.js';
import { filterAsync } from './async-array.js';

/**
 * Deliver a "stop" signal to live session(s) behind a webchat room (the GUI
 * Stop button — the in-browser equivalent of the CLI's ESC). Writes a
 * trigger=0 `interrupt` control row into each targeted running session's
 * inbound.db; the container's poll-loop aborts the active stream when it sees
 * one mid-turn, and treats a stale one (no live stream) as a no-op. Never
 * wakes/spawns a container.
 */
async function interruptRoomSessions(roomId: string, agentName?: string | null): Promise<void> {
  const mg = await getMessagingGroupByPlatform('webchat', roomId);
  if (!mg) return;
  let sessions = (await getRunningSessions()).filter((s) => s.messaging_group_id === mg.id);
  if (agentName) {
    sessions = await filterAsync(sessions, async (s) => (await getAgentGroup(s.agent_group_id))?.name === agentName);
  }
  for (const s of sessions) {
    await writeSessionMessage(s.agent_group_id, s.id, {
      id: `interrupt-${randomUUID()}`,
      kind: 'interrupt',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ reason: 'user-stop' }),
      trigger: false, // control signal only — must not wake/spawn a container
    });
  }
}

// Cap inbound WS messages — chat payloads are small (text, controls);
// without this, ws's default (100 MB) lets an authenticated client OOM the
// host with one giant JSON.
const WS_MAX_PAYLOAD = 1024 * 1024; // 1 MB
const WS_PING_INTERVAL = 30_000;

// Carries identity from the HTTP upgrade into the WS connection event.
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

// Inbound-message idempotency. A client_id seen within this window is a
// duplicate delivery of the same logical send (flaky-socket resend, double-
// fire) and is dropped so it can't spawn a second agent turn.
const CLIENT_ID_DEDUP_WINDOW_MS = 10_000;
const seenClientIds = new Map<string, number>();

/**
 * Atomically claim a client_id: returns true if it is fresh (proceed) and
 * records it; false if already seen within the window (drop the duplicate).
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
): WebSocketServer {
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

    // Frames must process IN ARRIVAL ORDER. The handler is async (the DB is),
    // and a bare async listener interleaves at every await — a `message` frame
    // arriving while `join` awaited its room lookup would see no room_id and
    // drop silently. A per-connection chain restores the ordering guarantee.
    let frameChain: Promise<void> = Promise.resolve();
    const handleFrame = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(raw.toString()) as typeof msg;
      } catch {
        send({ type: 'error', error: 'Invalid JSON' });
        return;
      }

      // ── AUTH ────────────────────────────────────────────────────────────
      if (msg.type === 'auth') {
        // The upgrade-time identity is the only identity. The auth message
        // just confirms the session is established.
        authenticated = true;
        send({ type: 'system', message: `Connected as ${client.identity}` });
        send({ type: 'rooms', rooms: await annotateRooms() });
        return;
      }

      if (!authenticated) {
        send({ type: 'error', error: 'Not authenticated' });
        return;
      }

      // ── JOIN ─────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        const roomId = typeof msg.room_id === 'string' ? msg.room_id : '';
        const room = await getWebchatRoom(roomId);
        // A refused join must not be silent: live delivery is gated on the
        // client's tracked room, and a refused join leaves it pointing at the
        // previous one — the symptom is "I don't see my message until I
        // switch rooms and come back". Log it so the next occurrence names
        // its own cause.
        if (!room) {
          log.warn('Webchat: join refused — room not found', { roomId, userId: client.userId });
          send({ type: 'error', error: `Room not found: ${roomId}` });
          return;
        }
        client.room_id = room.id;
        send({
          type: 'history',
          room_id: room.id,
          messages: (await getWebchatMessages(room.id, 50)).map((m) => ({
            ...m,
            content: redactMessageContent(m.message_type, m.content),
          })),
        });
        // Replay any in-progress agent turn so a re-join mid-turn re-shows the
        // thinking bubble (status frames are live-only + room-scoped, so
        // leaving and returning otherwise loses it). A synthetic `start` —
        // subsequent live frames refine it; the turn's real `done` clears it.
        for (const agentName of getActiveTurns(room.id)) {
          send({ type: 'status', room_id: room.id, agent_name: agentName || null, event: 'start' });
        }
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

        // Idempotency: a duplicate delivery of the same client_id must NOT
        // create a second inbound row → a second agent turn → a phantom
        // reply. The first delivery already echoed the sender's optimistic
        // bubble, so the repeat is dropped silently.
        const cid = typeof msg.client_id === 'string' ? msg.client_id : null;
        if (cid && !claimClientId(cid)) {
          log.warn('Webchat: dropped duplicate message (client_id already seen)', {
            clientId: cid,
            identity: client.identity,
          });
          return;
        }

        const stored = await storeWebchatMessage(client.room_id, client.identity, client.identity_type, text);
        const outgoing: Record<string, unknown> = { type: 'message', ...stored };
        if (typeof msg.client_id === 'string') outgoing.client_id = msg.client_id;
        await broadcast(client.room_id, outgoing, clientId);

        // Pipe the inbound to the router so the agent sees it. content
        // carries senderId (namespaced) for sender resolution.
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

        send({ ...outgoing, content: redactMessageContent(stored.message_type, stored.content) });
        return;
      }

      // ── INTERRUPT (GUI "stop", the ESC equivalent) ───────────────────────
      if (msg.type === 'interrupt') {
        if (!client.room_id) return;
        const agentName = typeof msg.agent_name === 'string' ? msg.agent_name : undefined;
        await interruptRoomSessions(client.room_id, agentName);
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
        const deleted = await deleteWebchatMessage(messageId, client.identity, client.room_id);
        if (deleted) {
          await broadcast(client.room_id, {
            type: 'delete_message',
            room_id: client.room_id,
            message_id: messageId,
          });
        }
        return;
      }
    };
    ws.on('message', (raw) => {
      frameChain = frameChain
        .then(() => handleFrame(raw))
        .catch((err) => {
          // Keep the chain alive and ordered, but never silently: a dropped
          // frame is a lost message from the user's point of view.
          log.warn('Webchat: WS frame handler failed', { err: err instanceof Error ? err.message : String(err) });
        });
    });

    ws.on('close', () => {
      removeClient(clientId);
    });
  });

  return wss;
}
