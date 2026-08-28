// ── Attachments: pick / drop / paste → upload ────────────────────────────────
// Uploads go multipart to /api/files/:roomId with the composer text as the
// caption. Progress renders as a transient row; the server's broadcast echo
// renders the real file message (this client included), so the progress row
// simply removes itself when the request settles.
import { $ } from '../core/dom.js';
import { getAuthToken } from '../core/api.js';
import { showToast, toastError } from '../core/toast.js';
import { state } from '../core/state.js';
function uploadFile(file) {
    if (!state.currentRoom) {
        showToast('Join a room first', { kind: 'error' });
        return;
    }
    const input = $('#composer-input');
    const caption = input.value.trim();
    input.value = '';
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
    xhr.setRequestHeader('X-Webchat-CSRF', '1');
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
            toastError(new Error(detail), 'Upload failed');
        }
    };
    xhr.onerror = () => {
        row.remove();
        toastError(new Error('Network error'), 'Upload failed');
    };
    xhr.send(form);
}
export function wireAttachments() {
    const picker = $('#attach-input');
    $('#attach-btn').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
        for (const f of picker.files ?? [])
            uploadFile(f);
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
        for (const f of e.dataTransfer?.files ?? [])
            uploadFile(f);
    });
    // Paste an image/file into the composer.
    $('#composer-input').addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length === 0)
            return;
        e.preventDefault();
        for (const f of files)
            uploadFile(f);
    });
}
