// ── Room list + join ─────────────────────────────────────────────────────────
import { $, onAsync } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { confirmDialog } from '../core/confirm.js';
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
  $('#room-set-btn')!.hidden = false;
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
  // Tidy an open rename editor (title element stays in the DOM, only hidden).
  const editing = document.getElementById('room-title-edit');
  if (editing) editing.remove();
  $('#room-title')!.hidden = false;
  state.currentRoom = null;
  state.currentRoomName = '';
  localStorage.removeItem('lastRoom');
  $('#room-title')!.textContent = 'Pick a chat';
  $('#room-set-btn')!.hidden = true;
  $('#room-del-btn')!.hidden = true;
  $('#composer')!.hidden = true;
  $('#app')!.classList.remove('in-room');
  clearTranscript();
  setEmptyNote('');
  hideAgentTyping();
  clearAllTurns();
}

/** Click the room title to rename in place — Enter saves, Escape cancels. */
export function wireRoomRename(): void {
  const title = $('#room-title')!;
  title.title = 'Click to rename';
  title.addEventListener('click', () => {
    if (!state.currentRoom || document.getElementById('room-title-edit')) return;
    const input = document.createElement('input');
    input.id = 'room-title-edit';
    input.value = state.currentRoomName;
    // Insert as a sibling and hide the title rather than detaching it, so
    // leaveRoom (delete from another tab mid-edit) can always reach #room-title.
    title.hidden = true;
    title.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save: boolean): Promise<void> => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      const room = state.currentRoom; // pin: don't rename whatever room is open when this resolves
      input.remove();
      title.hidden = false;
      if (!save || !name || !room || name === state.currentRoomName) return;
      try {
        await apiJson(`/api/rooms/${encodeURIComponent(room)}/name`, { method: 'PUT', body: { name } });
        if (state.currentRoom !== room) return; // switched away mid-request
        state.currentRoomName = name;
        title.textContent = name;
        showToast('Renamed', { kind: 'success' });
      } catch (err) {
        toastError(err, 'Rename failed');
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void finish(true);
      } else if (e.key === 'Escape') {
        void finish(false);
      }
    });
    input.addEventListener('blur', () => void finish(true));
  });
}

export function wireRoomDelete(): void {
  onAsync($('#room-del-btn')!, 'click', async () => {
    const roomId = state.currentRoom;
    if (!roomId) return;
    if (!(await confirmDialog(`Delete "${state.currentRoomName}" and its agent?`))) return;
    try {
      await apiJson(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
      leaveRoom();
      renderRooms(state.lastRoomsList.filter((r) => r.id !== roomId));
    } catch (err) {
      toastError(err, 'Could not delete chat');
    }
  });
}

// ── Create-chat dialog ───────────────────────────────────────────────────────

export function wireBackButton(): void {
  $('#back-btn')!.addEventListener('click', () => {
    $('#app')!.classList.remove('in-room');
  });
}

/**
 * Creating a chat creates its agent — one object, one form. There is no agent
 * picker because there is nothing to pick between: an existing agent already
 * has its chat.
 */
export function wireRoomCreate(): void {
  const dialog = $('#new-room-dialog') as HTMLDialogElement;
  const nameEl = $('#new-room-name') as HTMLInputElement;
  const instrEl = $('#new-room-instructions') as HTMLTextAreaElement;
  const draftBtn = $('#new-room-draft') as HTMLButtonElement;

  $('#new-room-btn')!.addEventListener('click', () => {
    nameEl.value = '';
    instrEl.value = '';
    dialog.showModal();
  });
  $('#new-room-cancel')!.addEventListener('click', () => dialog.close());

  onAsync(draftBtn, 'click', async () => {
    const prompt = instrEl.value.trim() || nameEl.value.trim();
    if (!prompt) {
      showToast('Type an idea first', { kind: 'error' });
      return;
    }
    draftBtn.disabled = true;
    const label = draftBtn.textContent;
    draftBtn.textContent = 'Drafting…';
    try {
      const { draft } = (await apiJson('/api/rooms/draft', { method: 'POST', body: { prompt } })) as {
        draft: { name?: string; instructions?: string };
      };
      if (draft.name) nameEl.value = draft.name;
      if (draft.instructions) instrEl.value = draft.instructions;
    } catch (err) {
      toastError(err, 'Drafting failed');
    } finally {
      draftBtn.disabled = false;
      draftBtn.textContent = label;
    }
  });

  onAsync($('#new-room-form') as HTMLFormElement, 'submit', async (e) => {
    e.preventDefault();
    const name = nameEl.value.trim();
    if (!name) return;
    try {
      const { room } = (await apiJson('/api/rooms', {
        method: 'POST',
        body: { name, instructions: instrEl.value.trim() || undefined },
      })) as { room: Room };
      dialog.close();
      joinRoom(room.id, room.name);
    } catch (err) {
      toastError(err, 'Could not create chat');
    }
  });
}

// ── Chat settings ────────────────────────────────────────────────────────────
// Model, standing instructions and the auto-learn switch. These belong to the
// agent, and the agent is the chat — so they are edited here, in the chat, and
// addressed by room id. This is what the management drawer's Agents tab used
// to hold.

interface ModelOption {
  id: string;
  name: string;
  kind: string;
}

export function wireRoomSettings(): void {
  const dialog = $('#room-settings-dialog') as HTMLDialogElement;
  const modelEl = $('#room-set-model') as HTMLSelectElement;
  const instrEl = $('#room-set-instructions') as HTMLTextAreaElement;
  const learnEl = $('#room-set-autolearn') as HTMLInputElement;

  onAsync($('#room-set-btn')!, 'click', async () => {
    const roomId = state.currentRoom;
    if (!roomId) return;
    const room = state.lastRoomsList.find((r) => r.id === roomId);
    try {
      const [{ models, default_model_id: defaultId }, { instructions }] = await Promise.all([
        apiJson('/api/models') as Promise<{ models: ModelOption[]; default_model_id: string | null }>,
        apiJson(`/api/rooms/${encodeURIComponent(roomId)}/instructions`) as Promise<{ instructions: string }>,
      ]);
      const defName = models.find((m) => m.id === defaultId)?.name;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = defName ? `Default (${defName})` : 'Default';
      modelEl.replaceChildren(
        none,
        ...models.map((m) => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = `${m.name} (${m.kind})`;
          opt.selected = m.id === room?.model_id;
          return opt;
        }),
      );
      instrEl.value = instructions;
      learnEl.checked = room?.auto_learn ?? false;
      dialog.showModal();
    } catch (err) {
      toastError(err, 'Could not load chat settings');
    }
  });

  $('#room-settings-cancel')!.addEventListener('click', () => dialog.close());

  onAsync($('#room-settings-form') as HTMLFormElement, 'submit', async (e) => {
    e.preventDefault();
    const roomId = state.currentRoom;
    if (!roomId) return;
    const base = `/api/rooms/${encodeURIComponent(roomId)}`;
    const room = state.lastRoomsList.find((r) => r.id === roomId);
    try {
      // Sent independently so an unchanged field costs nothing, and so one
      // rejected write (an instructions body over the cap, say) doesn't
      // silently drop the others.
      const writes: Promise<unknown>[] = [
        apiJson(`${base}/instructions`, { method: 'PUT', body: { instructions: instrEl.value } }),
      ];
      if ((modelEl.value || null) !== (room?.model_id ?? null)) {
        writes.push(apiJson(`${base}/model`, { method: 'PUT', body: { model_id: modelEl.value || null } }));
      }
      if (learnEl.checked !== (room?.auto_learn ?? false)) {
        writes.push(apiJson(`${base}/learning`, { method: 'PUT', body: { autoTrigger: learnEl.checked } }));
      }
      await Promise.all(writes);
      dialog.close();
      showToast('Saved', { kind: 'success' });
    } catch (err) {
      toastError(err, 'Save failed');
    }
  });
}
