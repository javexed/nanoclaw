// ── Transcript ───────────────────────────────────────────────────────────────
// The message list: keyed-by-id DOM rows, markdown rendering, the scroll
// discipline, and older-message pagination. The rendering pipeline and every
// scroll rule are ported from the predecessor's transcript (where each rule
// was earned by a bug); the DOM building replaces its Vue template.
import { marked } from '/marked.min.js';
import DOMPurify from '/dompurify.min.js';
import { $, esc } from '../core/dom.js';
import { authFetch } from '../core/api.js';
import { state } from '../core/state.js';
import { buildApprovalCard } from './approvals.js';
import { closeTurnFor } from './thinking.js';
const list = () => $('#messages');
const scroller = () => $('#transcript');
// ── Rendering ────────────────────────────────────────────────────────────────
/**
 * Markdown is best-effort: a malformed message must not crash the render loop
 * and leave the transcript half-populated — fall back to plain text (escaped
 * by the DOM, no XSS risk). DOMPurify config is explicit rather than default:
 * marked never emits forms or style attributes, so forbidding them costs
 * nothing — but with the CSP carrying style-src 'unsafe-inline' a "sanitized"
 * LLM message could otherwise restyle its own bubble into a fake UI or draw
 * input fields. Belt for the CSP's one deliberate gap.
 */
function renderMarkdown(body, target) {
    try {
        target.innerHTML = DOMPurify.sanitize(marked.parse(body), {
            FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'style'],
            FORBID_ATTR: ['style'],
        });
    }
    catch {
        target.textContent = body;
    }
}
function formatTime(ts) {
    if (!ts)
        return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** Build one transcript row. Keyed by data-message-id when the server id exists. */
function buildRow(msg, statusText) {
    const isMine = msg.sender === state.myIdentity;
    const isAgent = msg.sender_type === 'agent';
    const row = document.createElement('div');
    row.className = isMine ? 'msg mine' : isAgent ? 'msg agent' : 'msg other';
    if (msg.id)
        row.dataset.messageId = msg.id;
    if (!isMine) {
        const sender = document.createElement('div');
        sender.className = 'msg-sender';
        sender.textContent = msg.sender ?? '';
        row.appendChild(sender);
    }
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (msg.message_type === 'file' && msg.file_meta) {
        bubble.appendChild(buildFileBody(msg.file_meta, msg.content));
    }
    else if (msg.message_type === 'approval' || msg.message_type === 'approval_resolved') {
        bubble.classList.add('msg-approval');
        bubble.appendChild(buildApprovalCard(msg));
    }
    else {
        const body = document.createElement('div');
        body.className = 'msg-content';
        renderMarkdown(msg.content ?? '', body);
        bubble.appendChild(body);
    }
    row.appendChild(bubble);
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = document.createElement('span');
    time.textContent = formatTime(msg.created_at);
    if (msg.created_at)
        time.title = new Date(msg.created_at).toLocaleString();
    meta.appendChild(time);
    if (isMine && statusText) {
        const status = document.createElement('span');
        status.className = 'msg-status';
        status.textContent = statusText;
        meta.appendChild(status);
    }
    if (isMine && msg.id)
        meta.appendChild(buildDeleteButton(msg.id));
    row.appendChild(meta);
    return row;
}
function buildFileBody(meta, caption) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-file';
    if (meta.mime.startsWith('image/')) {
        const a = document.createElement('a');
        a.href = meta.url;
        a.target = '_blank';
        a.rel = 'noopener';
        const img = document.createElement('img');
        img.src = meta.url;
        img.alt = meta.filename;
        img.loading = 'lazy';
        a.appendChild(img);
        wrap.appendChild(a);
    }
    else {
        const a = document.createElement('a');
        a.href = meta.url;
        a.download = meta.filename;
        a.className = 'msg-file-link';
        a.textContent = `📎 ${meta.filename} (${formatSize(meta.size)})`;
        wrap.appendChild(a);
    }
    if (caption && caption !== meta.filename) {
        const cap = document.createElement('div');
        cap.className = 'msg-file-caption';
        cap.textContent = caption;
        wrap.appendChild(cap);
    }
    return wrap;
}
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function buildDeleteButton(messageId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-delete';
    btn.title = 'Delete message';
    btn.textContent = '✕';
    btn.addEventListener('click', () => {
        state.ws?.send(JSON.stringify({ type: 'delete_message', message_id: messageId }));
    });
    return btn;
}
// ── List operations ──────────────────────────────────────────────────────────
export function clearTranscript() {
    list().replaceChildren();
    setEmptyNote(null);
}
export function setEmptyNote(text) {
    const el = $('#transcript-empty');
    el.textContent = text ?? '';
    el.hidden = text === null;
}
export function appendMessage(msg) {
    if (msg.id && list().querySelector(`[data-message-id="${CSS.escape(msg.id)}"]`))
        return; // replay dedup
    setEmptyNote(null);
    // An agent message means the turn produced output — close that agent's
    // bubble even if the 'done' status frame is late or lost (belt; the frame
    // remains the primary close).
    if (msg.sender_type === 'agent')
        closeTurnFor(msg.sender ?? '');
    list().appendChild(buildRow(msg));
}
/** Prepend one older page, preserving the reader's scroll position. */
function prependMessages(messages) {
    const el = scroller();
    const prevHeight = el.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const m of messages) {
        if (m.id && list().querySelector(`[data-message-id="${CSS.escape(m.id)}"]`))
            continue;
        frag.appendChild(buildRow(m));
    }
    list().prepend(frag);
    // Keep the viewport anchored on what the reader was looking at.
    el.scrollTop += el.scrollHeight - prevHeight;
}
export function appendSystem(text) {
    if (!text)
        return;
    const row = document.createElement('div');
    row.className = 'msg system';
    row.textContent = text;
    list().appendChild(row);
}
export function removeMessage(messageId) {
    const el = list().querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!el)
        return;
    el.classList.add('deleting');
    setTimeout(() => el.remove(), 350);
}
/**
 * Optimistic send: render the row immediately with a pending tick; the server
 * echo (matched by client_id) upgrades it in place instead of appending a
 * duplicate.
 */
export function appendOptimistic(clientId, roomId, content) {
    setEmptyNote(null);
    const el = buildRow({ sender: state.myIdentity, sender_type: 'user', content, created_at: Date.now() }, '…');
    list().appendChild(el);
    state.pendingMessages.set(clientId, { clientId, roomId, el, id: null });
}
/** The echo arrived — delivered tick, server id (which also arms delete). */
export function upgradeOptimistic(clientId, msg) {
    const row = state.pendingMessages.get(clientId);
    if (!row)
        return false;
    state.pendingMessages.delete(clientId);
    if (row.roomId !== (msg.room_id ?? state.currentRoom)) {
        row.el.remove(); // room switched mid-flight — the history reload owns it now
        return true;
    }
    const status = row.el.querySelector('.msg-status');
    if (status)
        status.textContent = '✓✓';
    if (msg.id) {
        row.el.dataset.messageId = msg.id;
        row.el.querySelector('.msg-meta')?.appendChild(buildDeleteButton(msg.id));
        row.id = msg.id;
    }
    return true;
}
// ── Scroll discipline ────────────────────────────────────────────────────────
// Every rule here was earned: snapshot near-bottom BEFORE appending (the new
// row pushes the bottom past the threshold and lies about intent); re-scroll
// at rAF + 200ms so late-rendering markdown/images don't strand the view
// mid-message; never yank a reader who scrolled up — count missed messages
// into a jump pill instead.
export function isNearBottom() {
    const el = scroller();
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
export function scrollToBottom(force = false) {
    if (!force && state.userScrolledAway)
        return;
    const el = scroller();
    el.scrollTop = el.scrollHeight;
}
export function followScroll() {
    scrollToBottom();
    requestAnimationFrame(() => {
        if (!state.userScrolledAway)
            scrollToBottom();
    });
    setTimeout(() => {
        if (!state.userScrolledAway)
            scrollToBottom();
    }, 200);
}
let missed = 0;
export function incrementMissed() {
    missed += 1;
    const pill = $('#jump-pill');
    pill.textContent = missed === 1 ? '1 new message ↓' : `${missed} new messages ↓`;
    pill.hidden = false;
}
export function clearMissed() {
    missed = 0;
    $('#jump-pill').hidden = true;
}
export async function loadOlderMessages() {
    if (!state.currentRoom || !state.oldestMessageId || state.noMoreOlder || state.loadingOlder)
        return;
    state.loadingOlder = true;
    try {
        const res = await authFetch(`/api/history/${encodeURIComponent(state.currentRoom)}?before=${encodeURIComponent(state.oldestMessageId)}`);
        const data = (await res.json());
        const older = data.messages ?? [];
        if (older.length === 0) {
            state.noMoreOlder = true;
            return;
        }
        prependMessages(older);
        state.oldestMessageId = older[0]?.id ?? state.oldestMessageId;
        if (older.length < 50)
            state.noMoreOlder = true;
    }
    catch {
        /* transient — the next scroll near the top retries */
    }
    finally {
        state.loadingOlder = false;
    }
}
export function wireTranscriptScroll() {
    const el = scroller();
    el.addEventListener('scroll', () => {
        state.userScrolledAway = !isNearBottom();
        if (!state.userScrolledAway)
            clearMissed();
        if (el.scrollTop < 80)
            void loadOlderMessages();
    });
    $('#jump-pill').addEventListener('click', () => {
        state.userScrolledAway = false;
        clearMissed();
        scrollToBottom(true);
    });
}
// ── Agent typing line (superseded by the thinking bubble in M3) ──────────────
let typingTimer = null;
export function showAgentTyping(identity) {
    const el = $('#typing-line');
    el.textContent = `${identity} is working…`;
    el.hidden = false;
    if (typingTimer)
        clearTimeout(typingTimer);
    // Typing frames have no explicit "stopped" signal for agents — the reply
    // itself clears the line; this timeout covers a turn that dies silently.
    typingTimer = setTimeout(() => hideAgentTyping(), 60_000);
}
export function hideAgentTyping() {
    if (typingTimer)
        clearTimeout(typingTimer);
    typingTimer = null;
    $('#typing-line').hidden = true;
}
export { esc };
