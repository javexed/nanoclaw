// ── WebSocket transport ──────────────────────────────────────────────────────
// Socket lifecycle (open/close/retry with backoff, connection banner, the
// diagnose-on-failure probe) and the dispatcher that turns server events into
// transcript / room-list updates. The lifecycle rules are ported from the
// predecessor; the single-user event set is much smaller (no members, mentions,
// read-sync, threads).
import { $ } from './dom.js';
import { authFetch, getWsUrl, getWsProtocols } from './api.js';
import { state, setLastSeenMessageId, type Room } from './state.js';
import {
  appendMessage,
  appendSystem,
  upgradeOptimistic,
  clearTranscript,
  setEmptyNote,
  followScroll,
  hideAgentTyping,
  incrementMissed,
  isNearBottom,
  removeMessage,
  scrollToBottom,
  showAgentTyping,
} from '../features/transcript.js';
import { joinRoom, renderRooms, updateUnreadDots } from '../features/rooms.js';
import { handleStatusEvent } from '../features/thinking.js';
import { fetchPendingApprovals, handleApprovalEvent, handleApprovalResolved } from '../features/approvals.js';

/**
 * The socket, plus the one marker we hang on it. `_intentionalClose` tells the
 * close handler that WE closed the socket (reconnect, logout) so it must not
 * schedule a retry. Per-socket, so two rapid reconnects don't collapse: the
 * OLD socket's onclose checks the OLD socket's flag.
 */
interface TaggedSocket extends WebSocket {
  _intentionalClose?: boolean;
}

export function setConnectionBanner(text: string): void {
  const banner = $('#connection-banner');
  if (!banner) return;
  banner.textContent = text;
  banner.classList.add('visible');
}

export function hideConnectionBanner(): void {
  $('#connection-banner')?.classList.remove('visible');
}

async function probeInternet(): Promise<boolean> {
  try {
    await fetch('https://www.gstatic.com/generate_204', {
      mode: 'no-cors',
      cache: 'no-store',
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined,
    });
    return true;
  } catch {
    return false;
  }
}

async function diagnoseConnection(): Promise<void> {
  if (!navigator.onLine) {
    setConnectionBanner('You’re offline. Reconnecting when the network returns…');
    return;
  }
  if (Date.now() - state.lastProbeAt < 10_000) {
    // Throttled — but each retry's onclose resets the banner to the generic
    // text, so re-apply the standing diagnosis instead of losing it.
    if (state.lastDiagnosis) setConnectionBanner(state.lastDiagnosis.text);
    return;
  }
  state.lastProbeAt = Date.now();
  const internetUp = await probeInternet();
  // The socket may have recovered while the probe ran — never overwrite a
  // hidden banner.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  state.lastDiagnosis = {
    text: internetUp
      ? 'Internet is up but the server is unreachable — it may be down, or Tailscale is off on this device.'
      : 'No internet connection. Reconnecting…',
  };
  setConnectionBanner(state.lastDiagnosis.text);
}

export function connect(): void {
  if (state.ws) {
    (state.ws as TaggedSocket)._intentionalClose = true;
    try {
      state.ws.close();
    } catch {
      /* already closed */
    }
  }
  const sock: TaggedSocket = new WebSocket(getWsUrl(), getWsProtocols());
  state.ws = sock;

  sock.onopen = () => {
    hideConnectionBanner();
    state.reconnectDelay = 1000;
    state.lastProbeAt = 0; // next drop diagnoses fresh, not against a stale probe
    state.lastDiagnosis = null;
    sock.send(JSON.stringify({ type: 'auth' }));
  };

  sock.onmessage = (evt) => {
    const msg = JSON.parse(evt.data as string);
    switch (msg.type) {
      case 'system': {
        if (msg.message && !state.myIdentity) {
          const m = (msg.message as string).match(/^Connected as\s+(.+)$/);
          if (m) state.myIdentity = m[1].trim();
        }
        if (state.currentRoom) appendSystem(msg.message);
        return;
      }
      case 'rooms': {
        const rooms = msg.rooms as Room[];
        state.lastRoomsList = rooms;
        renderRooms(rooms);
        // Catch up on approvals queued while offline / mid-reconnect. Idempotent.
        void fetchPendingApprovals();
        if (state.currentRoom) {
          // Rejoin after reconnect, then catch up on anything missed while the
          // socket was down (the join's history reply also covers this, but
          // the after-anchor fetch is cheaper than a full repaint when the
          // gap is small — and history handles the repaint anyway).
          sock.send(JSON.stringify({ type: 'join', room_id: state.currentRoom }));
        } else {
          const saved = localStorage.getItem('lastRoom');
          const room = saved ? rooms.find((r) => r.id === saved) : undefined;
          if (room) joinRoom(room.id, room.name);
          else if (rooms.length === 0) setEmptyNote('No rooms yet — create one to start.');
        }
        break;
      }
      case 'history': {
        const room = (msg.room_id as string) || state.currentRoom;
        if (room !== state.currentRoom) break;
        // A message sent between the join and this reply is not in the payload
        // (the server queried before it existed). Carry the optimistic rows for
        // THIS room over the wipe: the echo upgrades a row in place, and a row
        // no longer in the DOM could never be upgraded — that was the
        // predecessor's "my first message didn't show up" bug.
        const carried = [...state.pendingMessages.values()].filter((r) => r.roomId === room);
        clearTranscript();
        const messages = msg.messages as Array<{ id?: string }>;
        for (const m of messages) appendMessage(m);
        for (const row of carried) {
          if (row.id && messages.some((m) => m.id === row.id)) continue; // echo raced us — server copy already rendered
          $('#messages')!.appendChild(row.el);
        }
        state.oldestMessageId = messages.length ? (messages[0].id ?? null) : null;
        state.noMoreOlder = messages.length < 50;
        state.loadingOlder = false;
        if (messages.length === 0 && carried.length === 0) {
          setEmptyNote('No messages yet. Start the conversation!');
        }
        if (messages.length > 0) setLastSeenMessageId(messages[messages.length - 1].id ?? null);
        state.userScrolledAway = false;
        scrollToBottom(true);
        requestAnimationFrame(() => scrollToBottom(true));
        setTimeout(() => scrollToBottom(true), 100); // mobile layout settle
        break;
      }
      case 'message': {
        if (msg.room_id && msg.created_at) {
          state.roomActivity.set(msg.room_id, Math.max(state.roomActivity.get(msg.room_id) ?? 0, msg.created_at));
          if (state.lastRoomsList.length) renderRooms(state.lastRoomsList);
        }
        if (msg.room_id && msg.room_id !== state.currentRoom) break; // server scopes broadcasts; belt only
        if (msg.sender_type === 'agent') hideAgentTyping();
        // Snapshot BEFORE appending: the new row pushes the bottom past the
        // threshold and makes isNearBottom lie about the reader's intent.
        const wasNearBottom = isNearBottom();
        if (state.notifications && document.hidden && msg.sender !== state.myIdentity) {
          try {
            new Notification(String(msg.sender ?? 'nanoclaw'), {
              body: String(msg.content ?? '').slice(0, 100),
              tag: msg.id || 'nanoclaw-msg',
            });
          } catch {
            /* notifications unavailable */
          }
        }
        if (!(msg.sender === state.myIdentity && msg.client_id && upgradeOptimistic(msg.client_id, msg))) {
          appendMessage(msg);
        }
        if (msg.id) setLastSeenMessageId(msg.id);
        if (wasNearBottom && !state.userScrolledAway) followScroll();
        else if (msg.sender !== state.myIdentity) incrementMissed();
        break;
      }
      case 'typing': {
        if (msg.room_id === state.currentRoom && msg.identity_type === 'agent' && msg.is_typing) {
          showAgentTyping(String(msg.identity ?? 'Agent'));
        }
        break;
      }
      case 'status':
        handleStatusEvent(msg);
        break;
      case 'unread': {
        if (msg.room_id && msg.room_id !== state.currentRoom) {
          state.unreadRooms.add(msg.room_id);
          updateUnreadDots();
        }
        break;
      }
      case 'delete_message':
        if (msg.message_id) removeMessage(msg.message_id);
        break;
      case 'approval':
        handleApprovalEvent(msg);
        break;
      case 'approval_resolved':
        handleApprovalResolved(msg);
        break;
      case 'error':
        console.error('WS error:', msg.error);
        break;
    }
  };

  sock.onclose = () => {
    if (sock._intentionalClose) return;
    // If another socket has since taken over (rapid reconnects, visibility
    // change), let it own the reconnect lifecycle.
    if (state.ws !== sock) return;
    setConnectionBanner('Connection lost. Reconnecting…');
    void diagnoseConnection();
    state.myIdentity = '';
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30_000);
  };
}

/** Catch up after the tab was hidden/asleep: reconnect a dead socket eagerly. */
export function wireVisibilityReconnect(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
      connect();
    }
  });
  window.addEventListener('online', () => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connect();
  });
}

/** Fetch messages after the last-seen anchor (visibility catch-up). */
export async function catchUpSince(): Promise<void> {
  if (!state.currentRoom || !state.lastSeenMessageId) return;
  const room = state.currentRoom; // pin against a mid-fetch room switch
  try {
    const res = await authFetch(
      `/api/history/${encodeURIComponent(room)}?after=${encodeURIComponent(state.lastSeenMessageId)}`,
    );
    if (!res.ok) return;
    if (state.currentRoom !== room) return; // switched rooms — don't cross-contaminate
    const data = (await res.json()) as { messages: Array<{ id?: string }> };
    if (!data.messages?.length) return;
    const wasNearBottom = isNearBottom();
    for (const m of data.messages) appendMessage(m);
    setLastSeenMessageId(data.messages[data.messages.length - 1].id ?? null);
    if (wasNearBottom) scrollToBottom();
  } catch {
    /* reconnect path covers it */
  }
}
