// ── Room list + join ─────────────────────────────────────────────────────────
import { $ } from '../core/dom.js';
import { apiJson } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { confirmDialog } from '../core/confirm.js';
import { state } from '../core/state.js';
import { clearTranscript, hideAgentTyping, setEmptyNote, clearMissed } from './transcript.js';
import { clearAllTurns } from './thinking.js';
export function renderRooms(rooms) {
    if (state.currentRoom && !rooms.some((r) => r.id === state.currentRoom))
        leaveRoom();
    const listEl = $('#room-list');
    const sorted = [...rooms].sort((a, b) => Math.max(state.roomActivity.get(b.id) ?? 0, b.last_activity) -
        Math.max(state.roomActivity.get(a.id) ?? 0, a.last_activity));
    listEl.replaceChildren(...sorted.map((room) => {
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
    }));
}
export function updateUnreadDots() {
    renderRooms(state.lastRoomsList);
}
export function joinRoom(roomId, roomName) {
    if (state.currentRoom === roomId)
        return;
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
    $('#room-title').textContent = roomName;
    $('#room-del-btn').hidden = false;
    $('#no-room-hint').hidden = true;
    $('#app').classList.add('in-room'); // mobile: show the chat pane
    $('#composer').hidden = false;
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
export function leaveRoom() {
    // Tidy an open rename editor (title element stays in the DOM, only hidden).
    const editing = document.getElementById('room-title-edit');
    if (editing)
        editing.remove();
    $('#room-title').hidden = false;
    state.currentRoom = null;
    state.currentRoomName = '';
    localStorage.removeItem('lastRoom');
    $('#room-title').textContent = 'Pick a room';
    $('#room-del-btn').hidden = true;
    $('#no-room-hint').hidden = false;
    $('#composer').hidden = true;
    $('#app').classList.remove('in-room');
    clearTranscript();
    setEmptyNote('');
    hideAgentTyping();
    clearAllTurns();
}
/** Click the room title to rename in place — Enter saves, Escape cancels. */
export function wireRoomRename() {
    const title = $('#room-title');
    title.title = 'Click to rename';
    title.addEventListener('click', () => {
        if (!state.currentRoom || document.getElementById('room-title-edit'))
            return;
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
        const finish = async (save) => {
            if (done)
                return;
            done = true;
            const name = input.value.trim();
            const room = state.currentRoom; // pin: don't rename whatever room is open when this resolves
            input.remove();
            title.hidden = false;
            if (!save || !name || !room || name === state.currentRoomName)
                return;
            try {
                await apiJson(`/api/rooms/${encodeURIComponent(room)}/name`, { method: 'PUT', body: { name } });
                if (state.currentRoom !== room)
                    return; // switched away mid-request
                state.currentRoomName = name;
                title.textContent = name;
                showToast('Room renamed', { kind: 'success' });
            }
            catch (err) {
                toastError(err, 'Rename failed');
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void finish(true);
            }
            else if (e.key === 'Escape') {
                void finish(false);
            }
        });
        input.addEventListener('blur', () => void finish(true));
    });
}
export function wireRoomDelete() {
    $('#room-del-btn').addEventListener('click', async () => {
        const roomId = state.currentRoom;
        if (!roomId)
            return;
        if (!(await confirmDialog(`Delete room "${state.currentRoomName}"? Its messages are removed permanently.`)))
            return;
        try {
            await apiJson(`/api/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
            leaveRoom();
            renderRooms(state.lastRoomsList.filter((r) => r.id !== roomId));
        }
        catch (err) {
            toastError(err, 'Could not delete room');
        }
    });
}
export function wireBackButton() {
    $('#back-btn').addEventListener('click', () => {
        $('#app').classList.remove('in-room');
    });
}
export function wireRoomCreate() {
    const dialog = $('#new-room-dialog');
    $('#new-room-btn').addEventListener('click', async () => {
        const select = $('#new-room-agent');
        try {
            const agents = (await apiJson('/api/agents'));
            select.replaceChildren(...agents.map((a) => {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = a.name;
                return opt;
            }));
        }
        catch (err) {
            toastError(err, 'Could not load agents');
            return;
        }
        $('#new-room-name').value = '';
        dialog.showModal();
    });
    $('#new-room-cancel').addEventListener('click', () => dialog.close());
    $('#new-room-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = $('#new-room-name').value.trim();
        const agentId = $('#new-room-agent').value;
        if (!name)
            return;
        try {
            const { room } = (await apiJson('/api/rooms', {
                method: 'POST',
                body: { name, agent_group_id: agentId || undefined },
            }));
            dialog.close();
            joinRoom(room.id, room.name);
        }
        catch (err) {
            toastError(err, 'Could not create room');
        }
    });
}
