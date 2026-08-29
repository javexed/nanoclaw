// ── Room list + join ─────────────────────────────────────────────────────────
import { $, esc } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { toastError } from '../core/toast.js';
import { state, type Room } from '../core/state.js';
import { clearTranscript, hideAgentTyping, setEmptyNote, clearMissed } from './transcript.js';
import { clearAllTurns } from './thinking.js';

export function renderRooms(rooms: Room[]): void {
  if (state.currentRoom && !rooms.some((r) => r.id === state.currentRoom)) leaveRoom();
  const listEl = $('#room-list')!;
  const sorted = [...rooms].sort(
    (a, b) =>
      Math.max(state.roomActivity.get(b.id) ?? 0, b.last_activity) -
      Math.max(state.roomActivity.get(a.id) ?? 0, a.last_activity),
  );
  listEl.replaceChildren(
    ...sorted.map((room) => {
      const li = document.createElement('li');
      li.dataset.roomId = room.id;
      li.className = room.id === state.currentRoom ? 'active' : '';
      const name = document.createElement('span');
      name.className = 'room-name';
      name.textContent = room.name;
      li.appendChild(name);
      if (state.unreadRooms.has(room.id)) {
        const dot = document.createElement('span');
        dot.className = 'unread-dot';
        li.appendChild(dot);
      }
      li.addEventListener('click', () => joinRoom(room.id, room.name));
      return li;
    }),
  );
}

export function updateUnreadDots(): void {
  renderRooms(state.lastRoomsList);
}

export function joinRoom(roomId: string, roomName: string): void {
  if (state.currentRoom === roomId) return;
  state.currentRoom = roomId;
  state.currentRoomName = roomName;
  state.unreadRooms.delete(roomId);
  state.oldestMessageId = null;
  state.noMoreOlder = false;
  state.userScrolledAway = false;
  clearMissed();
  hideAgentTyping();
  clearAllTurns();
  localStorage.setItem('lastRoom', roomId);
  $('#room-title')!.textContent = roomName;
  $('#room-del-btn')!.hidden = false;
  $('#app')!.classList.add('in-room'); // mobile: show the chat pane
  $('#composer')!.hidden = false;
  clearTranscript();
  setEmptyNote('Loading…');
  renderRooms(state.lastRoomsList);
  // The join may race a still-connecting socket; the rooms handler re-joins
  // on (re)connect using state.currentRoom, so a dropped send self-heals.
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'join', room_id: roomId }));
  }
}

/** Back to the no-room state — after deleting, or when the room vanishes. */
export function leaveRoom(): void {
  state.currentRoom = null;
  state.currentRoomName = '';
  localStorage.removeItem('lastRoom');
  $('#room-title')!.textContent = 'Pick a room';
  $('#room-del-btn')!.hidden = true;
  $('#composer')!.hidden = true;
  $('#app')!.classList.remove('in-room');
  clearTranscript();
  setEmptyNote('');
  hideAgentTyping();
  clearAllTurns();
}

export function wireRoomDelete(): void {
  $('#room-del-btn')!.addEventListener('click', async () => {
    const roomId = state.currentRoom;
    if (!roomId) return;
    if (!confirm(`Delete room "${state.currentRoomName}"? Its messages are removed permanently.`)) return;
    try {
      await apiJson(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
      leaveRoom();
      renderRooms(state.lastRoomsList.filter((r) => r.id !== roomId));
    } catch (err) {
      toastError(err, 'Could not delete room');
    }
  });
}

// ── Create-room dialog ───────────────────────────────────────────────────────

interface AgentOption {
  id: string;
  name: string;
}

export function wireBackButton(): void {
  $('#back-btn')!.addEventListener('click', () => {
    $('#app')!.classList.remove('in-room');
  });
}

export function wireRoomCreate(): void {
  const dialog = $('#new-room-dialog') as HTMLDialogElement;
  $('#new-room-btn')!.addEventListener('click', async () => {
    const select = $('#new-room-agent') as HTMLSelectElement;
    try {
      const agents = (await apiJson('/api/agents')) as AgentOption[];
      select.replaceChildren(
        ...agents.map((a) => {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = a.name;
          return opt;
        }),
      );
    } catch (err) {
      toastError(err, 'Could not load agents');
      return;
    }
    ($('#new-room-name') as HTMLInputElement).value = '';
    dialog.showModal();
  });
  $('#new-room-cancel')!.addEventListener('click', () => dialog.close());
  ($('#new-room-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = ($('#new-room-name') as HTMLInputElement).value.trim();
    const agentId = ($('#new-room-agent') as HTMLSelectElement).value;
    if (!name) return;
    try {
      const { room } = (await apiJson('/api/rooms', {
        method: 'POST',
        body: { name, agent_group_id: agentId || undefined },
      })) as { room: Room };
      dialog.close();
      joinRoom(room.id, room.name);
    } catch (err) {
      toastError(err, 'Could not create room');
    }
  });
}

export { esc };
