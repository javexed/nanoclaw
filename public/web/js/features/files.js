// ── Attachments: pick / drop / paste → STAGE → send ──────────────────────────
// Picking a file stages it; Send uploads it multipart to /api/files/:roomId
// with the composer text as the caption, so the picture and its words arrive as
// ONE message.
//
// This used to upload the instant a file was chosen, taking whatever happened to
// be in the composer at that moment as the caption. That works if you type
// first, but "attach, then type, then send" — the order every other chat app
// teaches — produced two messages: a captionless file, then a lone comment.
// Staging makes both orders behave the same.
//
// Progress renders as a transient row; the server's broadcast echo renders the
// real file message (this client included), so the progress row simply removes
// itself when the request settles.
import { $ } from '../core/dom.js';
import { getAuthToken } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { state } from '../core/state.js';
// Staged, in pick order. The caption rides with the FIRST upload only: the
// server stores one message per file, so captioning every one would repeat the
// same sentence under each picture.
let staged = [];
const KB = 1024;
function humanSize(bytes) {
    if (bytes < KB)
        return `${bytes} B`;
    if (bytes < KB * KB)
        return `${Math.round(bytes / KB)} KB`;
    return `${(bytes / KB / KB).toFixed(1)} MB`;
}
function renderTray() {
    const tray = $('#attach-tray');
    if (!tray)
        return;
    tray.replaceChildren(...staged.map((file, i) => {
        const chip = document.createElement('span');
        chip.className = 'attach-chip';
        const name = document.createElement('span');
        name.className = 'attach-chip-name';
        // textContent, never innerHTML: the filename is attacker-controlled.
        name.textContent = `${file.name} (${humanSize(file.size)})`;
        const drop = document.createElement('button');
        drop.type = 'button'; // not submit — this lives inside the composer form
        drop.className = 'attach-chip-x';
        drop.textContent = '✕';
        drop.title = `Remove ${file.name}`;
        drop.setAttribute('aria-label', `Remove ${file.name}`);
        drop.addEventListener('click', () => {
            staged.splice(i, 1);
            renderTray();
            $('#composer-input').focus();
        });
        chip.append(name, drop);
        return chip;
    }));
    tray.hidden = staged.length === 0;
}
function stageFiles(files) {
    if (!state.currentRoom) {
        showToast('Join a room first', { kind: 'error' });
        return;
    }
    const added = [...files];
    if (added.length === 0)
        return;
    staged.push(...added);
    renderTray();
    // Typing the caption is the next step, so put the cursor where it goes.
    $('#composer-input').focus();
}
/** Does Send have an upload to make? */
export function hasStagedFiles() {
    return staged.length > 0;
}
/**
 * Upload everything staged, captioning the first. Returns false — keeping the
 * staging — when there is nothing to send or no room, so the composer leaves the
 * typed text alone rather than clearing it into the void.
 */
export function sendStagedFiles(caption) {
    if (staged.length === 0)
        return false;
    if (!state.currentRoom) {
        showToast('Join a room first', { kind: 'error' });
        return false;
    }
    const batch = staged;
    staged = [];
    renderTray();
    batch.forEach((file, i) => uploadFile(file, i === 0 ? caption : ''));
    return true;
}
function uploadFile(file, caption) {
    if (!state.currentRoom)
        return;
    const input = $('#composer-input');
    // A failed upload must not swallow the work: put the file back in the tray so
    // Send retries it, and give the caption back if nothing has been typed since.
    const restore = () => {
        staged.push(file);
        renderTray();
        if (caption && !input.value)
            input.value = caption;
    };
    const row = document.createElement('div');
    row.className = 'msg mine';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble msg-note';
    bubble.textContent = `Uploading ${file.name}… 0%`;
    row.appendChild(bubble);
    $('#messages').appendChild(row);
    $('#transcript').scrollTop = $('#transcript').scrollHeight;
    const form = new FormData();
    form.append('caption', caption);
    form.append('file', file, file.name);
    // XHR, not fetch: upload progress events don't exist on fetch.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/${encodeURIComponent(state.currentRoom)}`);
    const token = getAuthToken();
    if (token)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('X-Web-CSRF', '1');
    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            bubble.textContent = `Uploading ${file.name}… ${Math.round((e.loaded / e.total) * 100)}%`;
        }
    };
    xhr.onload = () => {
        row.remove(); // the broadcast echo carries the real file row
        if (xhr.status !== 200) {
            let detail = `HTTP ${xhr.status}`;
            try {
                detail = JSON.parse(xhr.responseText).error || detail;
            }
            catch {
                /* keep status */
            }
            restore();
            toastError(new Error(detail), 'Upload failed');
        }
    };
    xhr.onerror = () => {
        row.remove();
        restore();
        toastError(new Error('Network error'), 'Upload failed');
    };
    xhr.send(form);
}
export function wireAttachments() {
    const picker = $('#attach-input');
    $('#attach-btn').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
        stageFiles(picker.files ?? []);
        picker.value = '';
    });
    // Drag-drop anywhere over the transcript.
    const transcript = $('#transcript');
    transcript.addEventListener('dragover', (e) => {
        e.preventDefault();
        transcript.classList.add('drop-target');
    });
    transcript.addEventListener('dragleave', () => transcript.classList.remove('drop-target'));
    transcript.addEventListener('drop', (e) => {
        e.preventDefault();
        transcript.classList.remove('drop-target');
        stageFiles(e.dataTransfer?.files ?? []);
    });
    // Paste an image/file into the composer.
    $('#composer-input').addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length === 0)
            return;
        e.preventDefault();
        stageFiles(files);
    });
}
