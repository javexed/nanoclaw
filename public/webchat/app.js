import { marked } from '/marked.min.js';
import DOMPurify from '/dompurify.min.js';

marked.setOptions({ breaks: true, gfm: true });

const $ = (sel) => document.querySelector(sel);

// ── Code block copy / wrap controls ──────────────────────────────────────
// Decorates any <pre> inside a container with a toolbar (language label,
// wrap toggle, copy button). Called after marked+DOMPurify renders agent
// messages. Event handling is delegated on #messages below.
function decorateCodeBlocks(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.classList.contains('has-code-toolbar')) return;
    pre.classList.add('has-code-toolbar');

    const code = pre.querySelector('code');
    const langClass = code && [...code.classList].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';

    const toolbar = document.createElement('div');
    toolbar.className = 'code-toolbar';

    if (lang) {
      const label = document.createElement('span');
      label.className = 'code-lang';
      label.textContent = lang;
      toolbar.appendChild(label);
    }

    const wrapBtn = document.createElement('button');
    wrapBtn.type = 'button';
    wrapBtn.className = 'code-btn wrap-code-btn';
    wrapBtn.textContent = 'Wrap';
    wrapBtn.setAttribute('aria-label', 'Toggle line wrapping');
    toolbar.appendChild(wrapBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-btn copy-code-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy code to clipboard');
    toolbar.appendChild(copyBtn);

    pre.insertBefore(toolbar, pre.firstChild);
  });
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

// ── Auth bootstrap ────────────────────────────────────────────────────────
// sessionStorage (not localStorage) so a stored-XSS attack can't exfiltrate
// the token from a long-lived background tab — the worst case shrinks to
// "active session in the same tab", which already has full access anyway.
let authToken = sessionStorage.getItem('nanoclaw-token') || '';

function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

// Bearer goes in the WebSocket subprotocol (Sec-WebSocket-Protocol) instead
// of the URL — keeps it out of proxy logs and browser history.
function getWsProtocols() {
  return authToken ? [`bearer.${authToken}`] : [];
}

function authFetch(url, opts = {}) {
  opts.headers = { ...opts.headers };
  if (authToken && !opts.headers['Authorization'] && !opts.headers['authorization']) {
    opts.headers['Authorization'] = `Bearer ${authToken}`;
  }
  // CSRF guard — server requires this on multipart/chunked upload endpoints
  // so cross-origin form-POSTs can't auto-attach credentials.
  opts.headers['X-Webchat-CSRF'] = '1';
  return fetch(url, opts);
}

async function checkAuth() {
  // Localhost doesn't need auth
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return true;
  }
  // Try existing token or tailscale
  try {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const res = await fetch('/api/auth/check', { headers });
    if (res.ok) return true;
  } catch {}
  return false;
}

async function initApp() {
  const authed = await checkAuth();
  if (authed) {
    $('#login-screen').hidden = true;
    $('#app').hidden = false;
    connect();
    // Auto-subscribe to push if the user has already granted permission.
    // Browsers require a user gesture for `Notification.requestPermission()`,
    // so a fresh install will still need one flip of the Settings toggle to
    // trigger the prompt — but after that, every reload re-subscribes silently.
    if (settings.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      enableWebPush();
    }
  } else {
    $('#login-screen').hidden = false;
    $('#app').hidden = true;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#login-token').value.trim();
  if (!token) return;
  // Test the token
  try {
    const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      authToken = token;
      sessionStorage.setItem('nanoclaw-token', token);
      $('#login-screen').hidden = true;
      $('#app').hidden = false;
      connect();
    } else {
      $('#login-error').textContent = 'Invalid token';
      $('#login-error').hidden = false;
    }
  } catch {
    $('#login-error').textContent = 'Connection failed';
    $('#login-error').hidden = false;
  }
});

const ROOM_COLORS = ['#4fc3f7', '#69f0ae', '#ffd54f', '#ff8a80', '#b388ff', '#80deea', '#ffab91', '#a5d6a7'];

function roomColor(roomId) {
  let hash = 0;
  for (let i = 0; i < roomId.length; i++) hash = ((hash << 5) - hash + roomId.charCodeAt(i)) | 0;
  return ROOM_COLORS[Math.abs(hash) % ROOM_COLORS.length];
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Settings ──────────────────────────────────────────────────────────────
const DEFAULTS = { theme: 'dark', font: 'medium', sendKey: 'ctrl-enter', notifications: true };

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('nanoclaw-settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  localStorage.setItem('nanoclaw-settings', JSON.stringify(settings));
}

let settings = loadSettings();

function applySettings() {
  document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.setAttribute('data-font', settings.font);
  // Update meta theme-color for mobile browsers
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
    if (surface) meta.setAttribute('content', surface);
  }
}

function renderSettingsModal() {
  // Theme buttons
  document.querySelectorAll('#theme-options .setting-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === settings.theme);
  });
  // Font buttons
  document.querySelectorAll('#font-options .setting-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === settings.font);
  });
  // Send key buttons
  document.querySelectorAll('#send-options .setting-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === settings.sendKey);
  });
  // Notifications
  $('#notif-toggle').checked = settings.notifications;
}

// Apply on load
applySettings();

// Settings modal open/close
function openSettings() {
  renderSettingsModal();
  $('#settings-overlay').hidden = false;
  // Focus trap
  const modal = $('#settings-overlay .modal');
  const focusable = modal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
  if (focusable.length) focusable[0].focus();
}
function closeSettings() {
  $('#settings-overlay').hidden = true;
}
$('#settings-btn').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('#settings-overlay')) closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#settings-overlay').hidden) closeSettings();
});

// Theme selection
document.querySelectorAll('#theme-options .setting-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.value;
    saveSettings(settings);
    applySettings();
    renderSettingsModal();
  });
});

// Font size selection
document.querySelectorAll('#font-options .setting-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.font = btn.dataset.value;
    saveSettings(settings);
    applySettings();
    renderSettingsModal();
  });
});

// Send key selection
document.querySelectorAll('#send-options .setting-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.sendKey = btn.dataset.value;
    saveSettings(settings);
    renderSettingsModal();
  });
});

// Notifications toggle — handles both foreground Notifications and Web Push
$('#notif-toggle').addEventListener('change', async () => {
  if ($('#notif-toggle').checked) {
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        $('#notif-toggle').checked = false;
        settings.notifications = false;
        saveSettings(settings);
        return;
      }
    }
    await enableWebPush();
  } else {
    await disableWebPush();
  }
  settings.notifications = $('#notif-toggle').checked;
  saveSettings(settings);
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

async function enableWebPush() {
  try {
    if (!('serviceWorker' in navigator)) {
      appendSystem('Push: service worker not supported');
      return;
    }
    if (!('PushManager' in window)) {
      appendSystem(
        'Push: PushManager not supported. On iOS, install this PWA to the home screen and launch it from there.',
      );
      return;
    }
    appendSystem('Push: fetching VAPID key…');
    const keyRes = await authFetch('/api/push/vapid-public');
    if (!keyRes.ok) {
      appendSystem('Push: server missing VAPID key (status ' + keyRes.status + ')');
      return;
    }
    const { key } = await keyRes.json();
    if (!key) {
      appendSystem('Push: empty VAPID key');
      return;
    }

    appendSystem('Push: waiting for service worker…');
    const reg = await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      appendSystem('Push: subscribing (accept the prompt)…');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    } else {
      appendSystem('Push: reusing existing subscription');
    }

    appendSystem('Push: saving subscription on server…');
    const res = await authFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) {
      appendSystem('Push: server rejected subscription (status ' + res.status + ')');
      return;
    }
    appendSystem('Push: subscribed ✓ (endpoint ' + sub.endpoint.slice(-24) + ')');
    console.log('[push] subscribed');
  } catch (err) {
    console.error('[push] subscribe failed:', err);
    appendSystem('Push: ' + (err && err.message ? err.message : String(err)));
  }
}

async function disableWebPush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await authFetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
      console.log('[push] unsubscribed');
    }
  } catch (err) {
    console.error('[push] unsubscribe failed:', err);
  }
}

let ws,
  currentRoom = null,
  myIdentity = '';
const pendingMessages = new Map();
const typingUsers = new Map();
const unreadRooms = new Set();
let agentName = '';
let lastSeenMessageId = sessionStorage.getItem('lastSeenMessageId') || null;
let reconnectDelay = 1000;

function setLastSeenMessageId(id) {
  lastSeenMessageId = id;
  if (id) sessionStorage.setItem('lastSeenMessageId', id);
}

function connect() {
  // Close any existing socket cleanly before opening a new one. The
  // intentional-close flag lives ON the socket so two rapid reconnects
  // don't collapse into one — the OLD socket's onclose checks the OLD
  // socket's flag, while the new socket runs independently.
  if (ws) {
    ws._intentionalClose = true;
    try {
      ws.close();
    } catch {}
  }
  const sock = new WebSocket(getWsUrl(), getWsProtocols());
  ws = sock;

  sock.onopen = () => {
    $('#connection-banner').classList.remove('visible');
    reconnectDelay = 1000;
    sock.send(JSON.stringify({ type: 'auth' }));
  };

  sock.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    switch (msg.type) {
      case 'system':
        if (msg.message && !myIdentity) {
          const m = msg.message.match(/^(?:Connected as|Welcome,)\s+(.+)$/);
          if (m) myIdentity = m[1].trim();
        }
        appendSystem(msg.message);
        return;
      case 'rooms':
        lastRoomsList = msg.rooms;
        if (allAgents.length === 0) {
          authFetch('/api/agents')
            .then((r) => r.json())
            .then((b) => {
              allAgents = b;
              renderRooms(msg.rooms);
            })
            .catch(() => renderRooms(msg.rooms));
        } else {
          renderRooms(msg.rooms);
        }
        // Catch up on approvals queued while offline / mid-reconnect. Idempotent.
        fetchApprovals();
        // Reveal the Permissions header button if the caller is owner.
        // Idempotent: probe runs every reconnect, but the button only
        // toggles visible.
        probeIsOwner();
        // Wirings or prime designations may have changed — refresh the
        // mention-autocomplete cache for the active room.
        refreshWiredAgentsForCurrentRoom();
        if (currentRoom) {
          // Rejoin after reconnect — catch up on missed messages
          ws.send(JSON.stringify({ type: 'join', room_id: currentRoom }));
          if (lastSeenMessageId) {
            authFetch(`/api/rooms/${currentRoom}/messages?after_id=${lastSeenMessageId}`)
              .then((r) => r.json())
              .then((missed) => {
                if (missed.length > 0) {
                  missed.forEach(appendMessage);
                  setLastSeenMessageId(missed[missed.length - 1].id);
                  scrollToBottom();
                }
              })
              .catch(() => {});
          }
        } else {
          const saved = sessionStorage.getItem('lastRoom');
          if (saved) {
            const room = msg.rooms.find((r) => r.id === saved);
            if (room) joinRoom(room.id, room.name);
          }
        }
        break;
      case 'history':
        $('#messages').innerHTML = '';
        msg.messages.forEach(appendMessage);
        if (msg.messages.length === 0) {
          $('#messages').innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
        }
        if (msg.messages.length > 0) {
          setLastSeenMessageId(msg.messages[msg.messages.length - 1].id);
        }
        scrollToBottom(true);
        requestAnimationFrame(() => scrollToBottom(true));
        // Extra scrolls for mobile layout settle
        setTimeout(() => scrollToBottom(true), 100);
        setTimeout(() => scrollToBottom(true), 300);
        break;
      case 'members':
        if (msg.room_id === currentRoom) renderMembers(msg.members);
        break;
      case 'message':
        // Desktop notification for messages from others when tab is not focused
        if (settings.notifications && document.hidden && msg.sender !== myIdentity) {
          try {
            new Notification(`${msg.sender}`, {
              body: msg.content.slice(0, 100),
              tag: msg.id || 'nanoclaw-msg',
            });
          } catch {}
        }
        if (msg.sender === myIdentity && msg.client_id && pendingMessages.has(msg.client_id)) {
          const el = pendingMessages.get(msg.client_id);
          const status = el.querySelector('.status');
          if (status) status.textContent = '✓✓';
          if (status) status.classList.add('delivered');
          pendingMessages.delete(msg.client_id);
          // Upgrade with server-assigned id and delete button
          if (msg.id) {
            el.dataset.messageId = msg.id;
            addDeleteButton(el, msg.id);
          }
        } else {
          appendMessage(msg);
        }
        if (msg.id && msg.room_id === currentRoom) setLastSeenMessageId(msg.id);
        if (isNearBottom() || (forceScrollCount > 0 && !userScrolledAway)) {
          scrollToBottom();
          if (forceScrollCount > 0) forceScrollCount--;
        } else {
          incrementMissedMessages();
        }
        break;
      case 'typing':
        handleTypingEvent(msg);
        break;
      case 'status':
        handleStatusEvent(msg);
        break;
      case 'unread':
        if (msg.room_id && msg.room_id !== currentRoom) {
          unreadRooms.add(msg.room_id);
          updateUnreadDots();
        }
        break;
      case 'delete_message':
        if (msg.message_id) {
          const el = document.querySelector(`[data-message-id="${CSS.escape(msg.message_id)}"]`);
          if (el) {
            el.classList.add('deleting');
            setTimeout(() => el.remove(), 350);
          }
        }
        break;
      case 'approval':
        handleApprovalEvent(msg);
        break;
      case 'error':
        console.error('WS error:', msg.error);
        break;
    }
  };

  sock.onclose = () => {
    // Per-socket flag — the new socket that replaced this one is already
    // running, so we don't reconnect from here.
    if (sock._intentionalClose) return;
    // If another socket has since taken over (rapid reconnects, visibility
    // change), let it own the reconnect lifecycle.
    if (ws !== sock) return;
    $('#connection-banner').classList.add('visible');
    myIdentity = '';
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

// iOS/mobile: when the app returns from background, the WebSocket may be
// silently dead without onclose firing. Force a full reconnect on resume.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ws && ws.readyState !== WebSocket.OPEN) {
    connect();
  }
});

// ── Rooms ─────────────────────────────────────────────────────────────────
// ── Room ordering ─────────────────────────────────────────────────────────
function getSavedRoomOrder() {
  try {
    return JSON.parse(localStorage.getItem('room-order') || '[]');
  } catch {
    return [];
  }
}
function saveRoomOrder(ids) {
  localStorage.setItem('room-order', JSON.stringify(ids));
}

let dragSrcLi = null;

function renderRooms(rooms) {
  const list = $('#room-list');
  list.innerHTML = '';

  // Apply saved order, falling back to created_at.
  const savedOrder = getSavedRoomOrder();
  const orderMap = new Map(savedOrder.map((id, i) => [id, i]));

  function cmp(a, b) {
    const aIdx = orderMap.get(a.id);
    const bIdx = orderMap.get(b.id);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    return (a.created_at || 0) - (b.created_at || 0);
  }

  const sorted = [...rooms].sort(cmp);

  for (let i = 0; i < sorted.length; i++) {
    const room = sorted[i];
    const li = document.createElement('li');
    const color = roomColor(room.id);
    li.dataset.roomId = room.id;
    li.style.borderLeftColor = color;
    li.style.display = 'flex';
    li.style.alignItems = 'center';

    const text = document.createElement('span');
    text.textContent = `#${room.id}`;
    text.style.flex = '1';
    li.appendChild(text);

    if (unreadRooms.has(room.id)) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.style.background = color;
      li.appendChild(dot);
    }
    if (room.id === currentRoom) li.classList.add('active');
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('draggable', 'true');

    li.addEventListener('dragstart', (e) => {
      dragSrcLi = li;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', room.id);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      dragSrcLi = null;
      list.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragSrcLi && dragSrcLi !== li) li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (!dragSrcLi || dragSrcLi === li) return;
      const items = [...list.children].map((el) => el.dataset.roomId);
      const fromId = dragSrcLi.dataset.roomId;
      const toId = li.dataset.roomId;
      const fromIdx = items.indexOf(fromId);
      const toIdx = items.indexOf(toId);
      items.splice(fromIdx, 1);
      items.splice(toIdx, 0, fromId);
      saveRoomOrder(items.filter(Boolean));
      renderRooms(lastRoomsList);
    });

    li.addEventListener('click', () => joinRoom(room.id, room.name));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        joinRoom(room.id, room.name);
      }
    });
    list.appendChild(li);
  }
}

let lastRoomsList = [];
function updateUnreadDots() {
  if (lastRoomsList.length) renderRooms(lastRoomsList);
}

function joinRoom(roomId, roomName) {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  currentRoom = roomId;
  unreadRooms.delete(roomId);
  updateUnreadDots();
  // Set agent name for thinking bubble from the agent wired to this room.
  const roomAgent = allAgents.find((b) => b.room_id === roomId);
  if (roomAgent) agentName = roomAgent.name;
  $('#app').classList.add('in-room');
  $('#app').classList.remove('in-dashboard');
  for (const t of typingUsers.values()) clearTimeout(t.timeout);
  typingUsers.clear();
  renderTypingIndicator();
  $('#members-panel').hidden = true;
  $('#members-overlay').classList.remove('visible');
  renderMembers([]);
  $('#messages').innerHTML = '<div class="empty-state">Loading...</div>';
  ws.send(JSON.stringify({ type: 'join', room_id: roomId }));
  sessionStorage.setItem('lastRoom', roomId);
  $('#room-name').textContent = `#${roomId}`;
  $('#message-input').disabled = false;
  $('#message-form button[type=submit]').disabled = false;
  $('#room-settings-toggle').hidden = false;
  document.querySelectorAll('#room-list li').forEach((li) => {
    li.classList.toggle('active', li.dataset.roomId === roomId);
  });
  // Prime the mention-autocomplete cache so the first '@' the user types
  // doesn't have to wait on a fetch.
  refreshWiredAgentsForCurrentRoom();
}

// ── Messages ──────────────────────────────────────────────────────────────
function createDeleteButton(messageId) {
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-delete';
  delBtn.textContent = '🗑';
  delBtn.title = 'Delete message';
  let confirmTimer = null;
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (delBtn.classList.contains('confirm')) {
      clearTimeout(confirmTimer);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'delete_message', message_id: messageId }));
      }
    } else {
      delBtn.classList.add('confirm');
      delBtn.textContent = 'delete?';
      confirmTimer = setTimeout(() => {
        delBtn.classList.remove('confirm');
        delBtn.textContent = '🗑';
      }, 3000);
    }
  });
  return delBtn;
}

function addDeleteButton(msgEl, messageId) {
  if (msgEl.querySelector('.msg-delete')) return;
  const bubble = msgEl.querySelector('.bubble');
  if (!bubble) return;
  // Wrap bubble in a msg-body row if not already
  let bodyRow = msgEl.querySelector('.msg-body');
  if (!bodyRow) {
    bodyRow = document.createElement('div');
    bodyRow.className = 'msg-body';
    bubble.parentNode.insertBefore(bodyRow, bubble);
    bodyRow.appendChild(bubble);
  }
  bodyRow.insertBefore(createDeleteButton(messageId), bubble);
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(msg, statusText) {
  if (msg.type === 'system') {
    appendSystem(msg.message);
    return;
  }
  const div = document.createElement('div');
  const isMine = msg.sender === myIdentity;
  const isAgent = msg.sender_type === 'agent';
  // Remove thinking bubble when an agent message arrives (covers reconnect catch-up too)
  if (isAgent) {
    const tb = $('#messages .thinking-bubble');
    if (tb) tb.remove();
  }
  div.className = isMine ? 'msg mine' : isAgent ? 'msg agent' : 'msg other';
  if (msg.id) div.dataset.messageId = msg.id;

  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = isAgent ? `🤖 ${msg.sender}` : isMine ? 'You' : msg.sender;
  div.appendChild(sender);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.message_type === 'file' && msg.file_meta) {
    bubble.appendChild(renderFileBubble(msg.file_meta));
    if (msg.content && msg.content !== msg.file_meta.filename) {
      const caption = document.createElement('div');
      caption.className = 'file-caption';
      caption.textContent = msg.content;
      bubble.appendChild(caption);
    }
  } else {
    // Markdown render is best-effort: a malformed message must not crash the
    // whole render loop and leave #messages half-populated. Fall back to
    // text-content (escaped by the DOM, no XSS risk) if marked or DOMPurify
    // throws.
    try {
      bubble.innerHTML = DOMPurify.sanitize(marked.parse(msg.content));
      decorateCodeBlocks(bubble);
      decorateMentions(bubble);
    } catch (err) {
      console.error('Message render failed; falling back to plain text', err);
      bubble.textContent = msg.content;
    }
  }

  if (isMine && msg.id) {
    const bodyRow = document.createElement('div');
    bodyRow.className = 'msg-body';
    bodyRow.appendChild(createDeleteButton(msg.id));
    bodyRow.appendChild(bubble);
    div.appendChild(bodyRow);
  } else {
    div.appendChild(bubble);
  }

  // Timestamp
  const timeStr = formatTime(msg.created_at);
  if (timeStr) {
    const time = document.createElement('div');
    time.className = 'timestamp';
    time.textContent = timeStr;
    div.appendChild(time);
  }
  if (isMine && statusText) {
    const status = document.createElement('div');
    status.className = 'status' + (statusText === '✓✓' ? ' delivered' : '');
    status.textContent = statusText;
    div.appendChild(status);
  }
  // Insert before the thinking bubble so it always stays at the bottom
  const thinkingBubble = $('#messages .thinking-bubble');
  if (thinkingBubble) {
    $('#messages').insertBefore(div, thinkingBubble);
  } else {
    $('#messages').appendChild(div);
  }
  return div;
}

function appendSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  const thinkingBubble = $('#messages .thinking-bubble');
  if (thinkingBubble) {
    $('#messages').insertBefore(div, thinkingBubble);
  } else {
    $('#messages').appendChild(div);
  }
  return div;
}

function renderFileBubble(meta) {
  const wrap = document.createElement('div');
  wrap.className = 'file-bubble';
  const isImage = meta.mime?.startsWith('image/');
  if (isImage) {
    const img = document.createElement('img');
    img.src = meta.url;
    img.alt = meta.filename;
    img.className = 'file-image-preview';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(meta.url, '_blank'));
    wrap.appendChild(img);
  }
  const info = document.createElement('div');
  info.className = 'file-info';
  const icon = isImage ? '🖼️' : meta.mime?.includes('pdf') ? '📄' : '📎';
  const sizeStr =
    meta.size < 1024
      ? `${meta.size} B`
      : meta.size < 1048576
        ? `${(meta.size / 1024).toFixed(1)} KB`
        : `${(meta.size / 1048576).toFixed(1)} MB`;
  info.innerHTML = `<span class="file-icon">${icon}</span><span class="file-name">${esc(meta.filename)}</span><span class="file-size">${sizeStr}</span>`;
  const dl = document.createElement('a');
  dl.href = meta.url;
  dl.download = meta.filename;
  dl.className = 'file-download';
  dl.textContent = '↓';
  dl.title = 'Download';
  info.appendChild(dl);
  wrap.appendChild(info);
  return wrap;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

let pendingFiles = [];
let pendingFileSeq = 0;
const pendingThumbUrls = new Map();

function stageFile(file) {
  if (!currentRoom) return;
  const id = ++pendingFileSeq;
  pendingFiles.push({ id, file });
  renderFilePreview();
  const input = $('#message-input');
  input.focus();
  input.placeholder =
    pendingFiles.length === 1
      ? `Add a message about ${file.name}...`
      : `Add a message about ${pendingFiles.length} files...`;
}

function stageFiles(fileList) {
  for (const f of fileList) stageFile(f);
}

function removeStagedFile(id) {
  const url = pendingThumbUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    pendingThumbUrls.delete(id);
  }
  pendingFiles = pendingFiles.filter((p) => p.id !== id);
  if (pendingFiles.length === 0) {
    clearStagedFiles();
  } else {
    renderFilePreview();
    $('#message-input').placeholder =
      pendingFiles.length === 1
        ? `Add a message about ${pendingFiles[0].file.name}...`
        : `Add a message about ${pendingFiles.length} files...`;
  }
}

function clearStagedFiles() {
  for (const url of pendingThumbUrls.values()) URL.revokeObjectURL(url);
  pendingThumbUrls.clear();
  pendingFiles = [];
  const preview = $('#file-preview');
  if (preview) {
    preview.hidden = true;
    preview.innerHTML = '';
  }
  $('#message-input').placeholder = 'Message...';
}

function renderFilePreview() {
  const preview = $('#file-preview');
  if (!preview) return;
  if (pendingFiles.length === 0) {
    preview.hidden = true;
    preview.innerHTML = '';
    return;
  }
  preview.hidden = false;
  let html = '';
  for (const { id, file } of pendingFiles) {
    const isImage = file.type.startsWith('image/');
    html += `<div class="file-preview-content" data-id="${id}">`;
    if (isImage) {
      let url = pendingThumbUrls.get(id);
      if (!url) {
        url = URL.createObjectURL(file);
        pendingThumbUrls.set(id, url);
      }
      html += `<img src="${url}" class="file-preview-thumb" alt="">`;
    } else {
      html += `<span class="file-preview-icon">📎</span>`;
    }
    html += `<span class="file-preview-name">${esc(file.name)}</span>`;
    html += `<span class="file-preview-size">${formatFileSize(file.size)}</span>`;
    html += `<button class="file-preview-remove" data-remove-id="${id}">&times;</button>`;
    html += '</div>';
  }
  preview.innerHTML = html;
  preview.querySelectorAll('[data-remove-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      removeStagedFile(Number(btn.dataset.removeId));
    });
  });
}

const CHUNK_THRESHOLD = 512 * 1024; // Use chunked upload for files > 512KB
const CHUNK_SIZE = 512 * 1024; // 512KB per chunk

async function uploadFile(file, caption) {
  if (!currentRoom) return;
  if (file.size > CHUNK_THRESHOLD) {
    return uploadFileChunked(file, caption);
  }
  const form = new FormData();
  form.append('file', file);
  if (caption) form.append('caption', caption);
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/upload`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Upload failed:', err.error || res.statusText);
      appendSystem('Upload failed: ' + (err.error || res.statusText));
    }
  } catch (err) {
    console.error('Upload error:', err);
    appendSystem('Upload failed: ' + err.message);
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function uploadFileChunked(file, caption) {
  const uploadId = crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const statusMsg = appendSystem(`Uploading ${file.name} (0/${totalChunks})...`);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const slice = file.slice(start, end);
    const buf = await slice.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);

    const body = {
      uploadId,
      chunkIndex: i,
      totalChunks,
      filename: file.name,
      mime: file.type || 'application/octet-stream',
      data: b64,
    };
    // Include caption on the last chunk
    if (i === totalChunks - 1 && caption) body.caption = caption;

    try {
      const res = await authFetch(`/api/rooms/${encodeURIComponent(currentRoom)}/upload/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (statusMsg) statusMsg.textContent = `Upload failed: ${err.error || res.statusText}`;
        return;
      }
    } catch (err) {
      if (statusMsg) statusMsg.textContent = `Upload failed: ${err.message}`;
      return;
    }
    if (statusMsg) statusMsg.textContent = `Uploading ${file.name} (${i + 1}/${totalChunks})...`;
  }
  if (statusMsg) statusMsg.remove();
}

function scrollToBottom(instant) {
  const el = $('#messages');
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  // Also scroll window for mobile where body scrolls instead of #messages
  window.scrollTo({ top: document.body.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
}

function isNearBottom() {
  const el = $('#messages');
  const elNear = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  const winNear = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
  // Both must be near bottom — on mobile the window scrolls (elNear is always
  // true because #messages doesn't overflow), on desktop #messages scrolls.
  return elNear && winNear;
}

let missedMsgCount = 0;
let forceScrollCount = 0; // force scroll for next N incoming messages after send
let userScrolledAway = false; // true once user scrolls up after sending

function updateScrollButton() {
  if (isNearBottom()) {
    $('#scroll-bottom').hidden = true;
    missedMsgCount = 0;
    $('#unread-badge').textContent = '';
  } else {
    $('#scroll-bottom').hidden = false;
    $('#unread-badge').textContent = missedMsgCount > 0 ? String(missedMsgCount) : '';
  }
}

function incrementMissedMessages() {
  if (!isNearBottom()) {
    missedMsgCount++;
    updateScrollButton();
  }
}

// Delegated clicks for code-block toolbar buttons (copy + wrap).
$('#messages').addEventListener('click', async (e) => {
  const btn = e.target.closest('.code-btn');
  if (!btn) return;
  const pre = btn.closest('pre');
  if (!pre) return;
  if (btn.classList.contains('copy-code-btn')) {
    const code = pre.querySelector('code');
    const text = code ? code.textContent : pre.textContent;
    const ok = await copyTextToClipboard(text || '');
    btn.classList.add(ok ? 'copied' : 'error');
    btn.textContent = ok ? 'Copied ✓' : 'Failed';
    setTimeout(() => {
      btn.classList.remove('copied', 'error');
      btn.textContent = 'Copy';
    }, 1500);
  } else if (btn.classList.contains('wrap-code-btn')) {
    const wrapping = pre.classList.toggle('wrap');
    btn.textContent = wrapping ? 'Unwrap' : 'Wrap';
    btn.classList.toggle('active', wrapping);
  }
});

// Show/hide scroll-to-bottom button; detect user scrolling away
$('#messages').addEventListener('scroll', () => {
  updateScrollButton();
  if (!isNearBottom()) {
    userScrolledAway = true;
    forceScrollCount = 0;
  } else userScrolledAway = false;
});
window.addEventListener('scroll', () => {
  updateScrollButton();
  if (!isNearBottom()) {
    userScrolledAway = true;
    forceScrollCount = 0;
  } else userScrolledAway = false;
});
$('#scroll-bottom').addEventListener('click', () => {
  missedMsgCount = 0;
  userScrolledAway = false;
  $('#unread-badge').textContent = '';
  scrollToBottom();
});

let clientMsgSeq = 0;

function sendCurrentMessage() {
  const input = $('#message-input');
  const text = input.value.trim();
  if (!currentRoom) return;

  // Files + optional caption (caption attaches to the first upload)
  if (pendingFiles.length > 0) {
    const files = pendingFiles.map((p) => p.file);
    const caption = text;
    clearStagedFiles();
    input.value = '';
    input.style.height = 'auto';
    (async () => {
      for (let i = 0; i < files.length; i++) {
        await uploadFile(files[i], i === 0 ? caption : '');
      }
    })();
    return;
  }

  if (!text) return;
  const clientId = `local-${++clientMsgSeq}-${Date.now()}`;
  ws.send(JSON.stringify({ type: 'message', content: text, client_id: clientId }));
  const el = appendMessage({ sender: myIdentity, sender_type: 'user', content: text }, '✓');
  pendingMessages.set(clientId, el);
  userScrolledAway = false;
  forceScrollCount = 3; // ensure agent response scrolls into view
  scrollToBottom();
  input.value = '';
  input.style.height = 'auto';
}

$('#message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sendCurrentMessage();
});

$('#message-input').addEventListener('keydown', (e) => {
  // If mention popover is showing, let it consume Enter/Tab before send fires.
  if (mentionMatches.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) return;
  if (e.key !== 'Enter') return;
  if (settings.sendKey === 'enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
  if (settings.sendKey === 'shift-enter' && e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
  if (settings.sendKey === 'ctrl-enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendCurrentMessage();
  }
});

// ── Mention autocomplete (@<folder>) + chip rendering ─────────────────────────
//
// The router engages an agent when a wired-room message matches the agent's
// engage_pattern (`\B@<folder>\b`, case-insensitive — see ciFolderToken in
// server.ts). The autocomplete here is purely UX — it lets the user pick from
// wired agents instead of remembering folder slugs. The chip styling is
// purely cosmetic — confirmation that the @ token will be matched.
//
// Cache is refreshed on join + on the same broadcastRooms event the room list
// listens for, so adds/removes/prime-changes stay current without polling.

let wiredAgentsForCurrentRoom = []; // [{ id, name, folder, is_prime }]

async function refreshWiredAgentsForCurrentRoom() {
  const roomId = currentRoom;
  if (!roomId) {
    wiredAgentsForCurrentRoom = [];
    return;
  }
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`);
    const next = await res.json();
    // Race guard: if the user navigated to a different room while this was
    // in flight, drop the stale result.
    if (currentRoom === roomId) wiredAgentsForCurrentRoom = next;
  } catch {
    // network blip — leave stale cache rather than blanking
  }
}

let mentionPopover = null;
let mentionStart = -1;
let mentionMatches = [];
let mentionSelectedIndex = 0;

function ensureMentionPopover() {
  if (mentionPopover) return mentionPopover;
  const el = document.createElement('div');
  el.id = 'mention-popover';
  el.className = 'mention-popover';
  el.hidden = true;
  document.body.appendChild(el);
  mentionPopover = el;
  return el;
}

function dismissMentionPopover() {
  mentionStart = -1;
  mentionMatches = [];
  if (mentionPopover) mentionPopover.hidden = true;
}

function renderMentionPopover(input) {
  const el = ensureMentionPopover();
  if (mentionMatches.length === 0) {
    el.hidden = true;
    return;
  }
  el.innerHTML = '';
  mentionMatches.forEach((agent, i) => {
    const item = document.createElement('div');
    item.className = 'mention-popover-item' + (i === mentionSelectedIndex ? ' active' : '');
    const slug = document.createElement('span');
    slug.className = 'mention-popover-slug';
    slug.textContent = `@${agent.folder}`;
    item.appendChild(slug);
    if (agent.name && agent.name !== agent.folder) {
      const name = document.createElement('span');
      name.className = 'mention-popover-name';
      name.textContent = ` — ${agent.name}`;
      item.appendChild(name);
    }
    if (agent.is_prime) {
      const badge = document.createElement('span');
      badge.className = 'mention-popover-prime';
      badge.textContent = 'prime';
      item.appendChild(badge);
    }
    // mousedown (not click) so the input doesn't blur and dismiss the popover
    // before we can read the selection.
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      mentionSelectedIndex = i;
      acceptMention(input);
    });
    el.appendChild(item);
  });
  // Position above the input.
  el.hidden = false;
  const rect = input.getBoundingClientRect();
  const popHeight = el.offsetHeight || 200;
  el.style.left = `${Math.round(rect.left + 8)}px`;
  el.style.top = `${Math.round(rect.top - popHeight - 4)}px`;
  el.style.minWidth = `${Math.round(Math.min(Math.max(rect.width - 16, 200), 320))}px`;
}

function tryActivateMention(input) {
  if (wiredAgentsForCurrentRoom.length === 0) {
    dismissMentionPopover();
    return;
  }
  const value = input.value;
  const cursor = input.selectionStart ?? value.length;
  // Walk back from cursor to find the most recent '@' that's at a word boundary
  // (start of string or preceded by whitespace). Bail if we hit a non-slug char
  // first — that means the cursor is no longer inside a mention token.
  let i = cursor - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === '@') {
      if (i !== 0 && !/\s/.test(value[i - 1])) {
        dismissMentionPopover();
        return;
      }
      break;
    }
    if (!/[a-zA-Z0-9-]/.test(c)) {
      dismissMentionPopover();
      return;
    }
    i--;
  }
  if (i < 0) {
    dismissMentionPopover();
    return;
  }
  mentionStart = i;
  const token = value.slice(i + 1, cursor).toLowerCase();
  mentionMatches = wiredAgentsForCurrentRoom
    .filter((a) => a.folder.toLowerCase().startsWith(token))
    .slice(0, 8);
  mentionSelectedIndex = 0;
  if (mentionMatches.length === 0) {
    dismissMentionPopover();
    return;
  }
  renderMentionPopover(input);
}

function acceptMention(input) {
  if (mentionStart < 0 || mentionMatches.length === 0) return;
  const agent = mentionMatches[mentionSelectedIndex];
  if (!agent) return;
  const before = input.value.slice(0, mentionStart);
  const after = input.value.slice(input.selectionStart ?? input.value.length);
  const inserted = `@${agent.folder} `;
  input.value = before + inserted + after;
  const newCursor = before.length + inserted.length;
  input.setSelectionRange(newCursor, newCursor);
  dismissMentionPopover();
  // Fire input so the textarea auto-resize logic (if any) catches up.
  input.dispatchEvent(new Event('input'));
}

(() => {
  const input = $('#message-input');
  input.addEventListener('input', () => tryActivateMention(input));
  input.addEventListener('blur', () => {
    // Defer so a click on a popover item registers before we tear down.
    setTimeout(dismissMentionPopover, 120);
  });
  // Capture phase so we intercept Enter/Tab before the send-message handler
  // fires. Only intercept when the popover is actually showing.
  input.addEventListener(
    'keydown',
    (e) => {
      if (mentionMatches.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionMatches.length;
        renderMentionPopover(input);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionMatches.length) % mentionMatches.length;
        renderMentionPopover(input);
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        acceptMention(input);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dismissMentionPopover();
      }
    },
    true,
  );
})();

/**
 * Walk a rendered bubble's text nodes and wrap `@<slug>` tokens in a styled
 * span. Cosmetic only — even if the token doesn't match a wired agent, the
 * styling tells the user "this looks like a mention." Server-side matching
 * is what actually decides routing.
 */
function decorateMentions(bubble) {
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip code/pre — we don't want to chip-style stuff inside backticks.
      let p = node.parentNode;
      while (p && p !== bubble) {
        const tag = p.nodeName;
        if (tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);
  const re = /(^|\s)@([a-z0-9-]+)\b/gi;
  for (const node of nodes) {
    const txt = node.nodeValue;
    if (!/@[a-z0-9-]/i.test(txt)) continue;
    re.lastIndex = 0;
    let last = 0;
    let m;
    const frag = document.createDocumentFragment();
    let touched = false;
    while ((m = re.exec(txt)) !== null) {
      const fullStart = m.index + m[1].length; // skip the leading whitespace match
      if (fullStart > last) frag.appendChild(document.createTextNode(txt.slice(last, fullStart)));
      const span = document.createElement('span');
      span.className = 'mention';
      span.textContent = `@${m[2]}`;
      frag.appendChild(span);
      last = fullStart + 1 + m[2].length;
      touched = true;
    }
    if (!touched) continue;
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// ── Members panel ─────────────────────────────────────────────────────────
let currentMembers = [];

function renderMembers(members) {
  currentMembers = members;
  const list = $('#members-list');
  const toggle = $('#members-toggle');
  toggle.textContent = members.length;
  toggle.hidden = !currentRoom;

  list.innerHTML = '';
  const sorted = [...members].sort((a, b) => {
    if (a.identity_type !== b.identity_type) return a.identity_type === 'agent' ? -1 : 1;
    return a.identity.localeCompare(b.identity);
  });
  for (const m of sorted) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `member-dot ${m.identity_type}`;
    li.appendChild(dot);
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.identity === myIdentity ? `${m.identity} (you)` : m.identity;
    li.appendChild(name);
    if (m.identity_type === 'agent') {
      const tag = document.createElement('span');
      tag.className = 'member-tag';
      tag.textContent = 'AGENT';
      li.appendChild(tag);
    }
    list.appendChild(li);
  }
}

function toggleMembersPanel() {
  const panel = $('#members-panel');
  const overlay = $('#members-overlay');
  const visible = panel.hidden;
  panel.hidden = !visible;
  if (visible) overlay.classList.add('visible');
  else overlay.classList.remove('visible');
}

$('#members-toggle').addEventListener('click', toggleMembersPanel);
$('#members-close').addEventListener('click', toggleMembersPanel);
$('#members-overlay').addEventListener('click', toggleMembersPanel);

// ── Sidebar tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.sidebar-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    // Switching tabs makes any open detail aside contextually irrelevant
    // (an agent detail showing while the user is browsing the Rooms tab,
    // or vice versa). Close both unconditionally so the screen reflects
    // the tab the user is on.
    closeAgentDetail();
    closeRoomDetail();
    closeModelDetail();
    document.querySelectorAll('.sidebar-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'agents') fetchAgents();
    if (tab.dataset.tab === 'models') fetchModels();
  });
});

// ── Approvals ─────────────────────────────────────────────────────────────
// Pending approvals (install_packages, add_mcp_server, etc.) surface as an
// inline banner above the active sidebar tab — only when count > 0, so
// users with no pending items see nothing. The banner expands to reveal
// the cards in place; click Approve/Reject directly without leaving the
// current tab. Live arrival also fires a top-right toast.
let pendingApprovals = []; // {questionId, action, title, options, payload, created_at}

function setApprovalsBanner(count) {
  const banner = $('#approvals-banner');
  // Defensive: if the cached HTML doesn't include the banner element yet,
  // bail silently. Avoids a throw that would break unrelated WS handling.
  if (!banner) return;
  const countEl = $('#approvals-count');
  const textEl = banner.querySelector('.approvals-banner-text');
  if (count <= 0) {
    banner.hidden = true;
    banner.classList.remove('expanded');
    $('#approval-list').hidden = true;
    $('#approvals-banner-toggle').setAttribute('aria-expanded', 'false');
    return;
  }
  banner.hidden = false;
  countEl.textContent = String(count);
  // Pluralize the trailing word: "1 approval pending" / "2 approvals pending".
  // The number itself stays inside #approvals-count; we just rewrite the
  // sibling text node around it.
  const noun = count === 1 ? 'approval' : 'approvals';
  // Reset textEl content but keep the count span: rebuild it.
  textEl.innerHTML = '';
  textEl.appendChild(countEl);
  textEl.appendChild(document.createTextNode(` ${noun} pending`));
}

function renderApprovalCard(a, options) {
  const opts = options || {};
  const card = document.createElement(opts.toast ? 'div' : 'li');
  card.className = opts.toast ? 'approval-toast' : 'approval-card';
  card.dataset.questionId = a.questionId;

  const title = document.createElement('div');
  title.className = 'approval-title';
  title.textContent = a.title || a.action || 'Approval requested';
  card.appendChild(title);

  if (a.payload && !opts.toast) {
    const pre = document.createElement('pre');
    pre.className = 'approval-payload';
    pre.textContent = typeof a.payload === 'string' ? a.payload : JSON.stringify(a.payload, null, 2);
    card.appendChild(pre);
  }

  const actions = document.createElement('div');
  actions.className = 'approval-actions';
  const optionList = Array.isArray(a.options) && a.options.length
    ? a.options
    : [
        { label: 'Approve', value: 'approve' },
        { label: 'Reject', value: 'reject' },
      ];
  optionList.forEach((opt) => {
    const btn = document.createElement('button');
    btn.textContent = opt.label || opt.value;
    btn.className = opt.value === 'approve' ? 'approve' : opt.value === 'reject' ? 'reject' : '';
    btn.addEventListener('click', () => respondToApproval(a.questionId, opt.value, card));
    actions.appendChild(btn);
  });
  card.appendChild(actions);
  return card;
}

function renderApprovalsList() {
  const list = $('#approval-list');
  if (list) {
    list.innerHTML = '';
    pendingApprovals.forEach((a) => list.appendChild(renderApprovalCard(a)));
  }
  setApprovalsBanner(pendingApprovals.length);
}

// Banner toggle: expand/collapse the inline approvals list. Guarded with
// an existence check so a stale cached HTML (without the banner element)
// can't kill the rest of the script with a null.addEventListener throw.
const approvalsBannerToggle = $('#approvals-banner-toggle');
if (approvalsBannerToggle) {
  approvalsBannerToggle.addEventListener('click', () => {
    const banner = $('#approvals-banner');
    const list = $('#approval-list');
    const expanded = banner.classList.toggle('expanded');
    list.hidden = !expanded;
    approvalsBannerToggle.setAttribute('aria-expanded', String(expanded));
  });
}

async function fetchApprovals() {
  try {
    const r = await authFetch('/api/approvals/pending');
    if (!r.ok) return;
    pendingApprovals = await r.json();
    renderApprovalsList();
  } catch (err) {
    console.error('fetchApprovals failed:', err);
  }
}

function showApprovalToast(a) {
  const container = $('#approval-toasts');
  if (!container) return;
  const toast = renderApprovalCard(a, { toast: true });
  container.appendChild(toast);
  // Auto-remove after 30s if user takes no action — they can still respond
  // via the Approvals tab.
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 30_000);
}

function handleApprovalEvent(msg) {
  // msg shape: { type: 'approval', questionId, title, question, options, ... }
  // We re-fetch the canonical list so we don't drift if multiple events
  // arrive close together; the toast is purely for live visibility.
  showApprovalToast(msg);
  fetchApprovals();
  // Desktop notification when settings allow + tab not focused.
  if (settings.notifications && document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(msg.title || 'Approval requested', { body: msg.question || '' }); } catch {}
  }
}

async function respondToApproval(questionId, value, cardEl) {
  if (!cardEl) cardEl = document.querySelector(`[data-question-id="${questionId}"]`);
  if (cardEl) cardEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const r = await authFetch(`/api/approvals/${encodeURIComponent(questionId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ value }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      console.error('Approval respond failed:', r.status, body);
      if (cardEl) cardEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }
    pendingApprovals = pendingApprovals.filter((a) => a.questionId !== questionId);
    renderApprovalsList();
    // Remove the toast version too if it's currently visible.
    document.querySelectorAll(`.approval-toast[data-question-id="${questionId}"]`).forEach((el) => el.remove());
  } catch (err) {
    console.error('Approval respond errored:', err);
    if (cardEl) cardEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

// ── Mobile back button ────────────────────────────────────────────────────
$('#mobile-back').addEventListener('click', () => {
  $('#app').classList.remove('in-room');
});

// ── Dashboard ─────────────────────────────────────────────────────────────
// On-open + manual refresh only — no background polling. The dashboard
// surfaces a snapshot of webchat-internal state (rooms, sessions, agents,
// 24h messages) plus host-level system metrics for owner-only callers.
// Non-owner admins see a graceful-degrade view: their visible agents,
// session count, channel breakdown — no system info or busiest-rooms.

let dashboardActive = false;

function toggleDashboard() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  dashboardActive = !dashboardActive;
  $('#chat').hidden = dashboardActive;
  $('#dashboard').hidden = !dashboardActive;
  $('#dash-toggle').classList.toggle('active', dashboardActive);
  $('#app').classList.toggle('in-dashboard', dashboardActive);
  $('#app').classList.remove('in-room');
  if (dashboardActive) refreshDashboard();
}

$('#dash-toggle').addEventListener('click', toggleDashboard);
$('#dash-back').addEventListener('click', toggleDashboard);
$('#dash-refresh').addEventListener('click', refreshDashboard);

// ── Permissions section (owner-only) ──────────────────────────────────────
// List + detail pattern (mirrors the Agents tab). Header button is hidden
// by default and revealed by probeIsOwner() once /api/users succeeds. The
// detail pane has two views — selected user (chips + add-role form) and
// new-user form — plus an empty-state shown when nothing is selected.
let permsActive = false;
let permsAgents = []; // cached agent_groups for group dropdowns
let permsUsers = []; // cached most-recent /api/users result
let permsSelectedUserId = null;
let myUserId = null; // populated by probeIsOwner via /api/auth/check

function togglePermissions() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  permsActive = !permsActive;
  $('#chat').hidden = permsActive;
  $('#permissions').hidden = !permsActive;
  $('#perms-toggle').classList.toggle('active', permsActive);
  $('#app').classList.toggle('in-dashboard', permsActive);
  $('#app').classList.remove('in-room');
  if (permsActive) {
    permsShowList();
    refreshPermissions();
  }
}

async function probeIsOwner() {
  try {
    const [check, users] = await Promise.all([authFetch('/api/auth/check'), authFetch('/api/users')]);
    if (check.ok) {
      const body = await check.json();
      if (body && typeof body.userId === 'string') myUserId = body.userId;
    }
    if (users.ok) {
      $('#perms-toggle').hidden = false;
      return true;
    }
  } catch {}
  return false;
}

async function refreshPermissions() {
  try {
    const [usersRes, agentsRes] = await Promise.all([authFetch('/api/users'), authFetch('/api/agents')]);
    if (!usersRes.ok) {
      $('#perms-user-list').innerHTML = '<li class="perms-empty">Failed to load users.</li>';
      return;
    }
    permsUsers = await usersRes.json();
    permsAgents = agentsRes.ok ? await agentsRes.json() : [];
    populatePermsAgentDropdowns();
    renderPermsUserList();
    if (permsSelectedUserId && permsUsers.find((u) => u.id === permsSelectedUserId)) {
      renderPermsDetail(permsSelectedUserId);
    } else if (permsSelectedUserId) {
      // The selected user got revoked-into-nonexistence or otherwise vanished.
      permsSelectedUserId = null;
      permsShowList();
    }
  } catch (err) {
    console.error('refreshPermissions failed:', err);
  }
}

function populatePermsAgentDropdowns() {
  // Only the wizard uses an agent-group dropdown now (the matrix UI lists
  // each group as its own row). Repopulate from the latest /api/agents.
  const el = $('#perms-create-group');
  if (!el) return;
  el.innerHTML = '<option value="">— global —</option>';
  permsAgents.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name || a.id;
    el.appendChild(opt);
  });
}

function agentLabel(agentGroupId) {
  const a = permsAgents.find((x) => x.id === agentGroupId);
  return a ? a.name || a.id : agentGroupId;
}

function userDisplayName(u) {
  // Prefer the channel-supplied display name, else extract a readable token
  // from the namespaced id (handle/email after the last colon).
  if (u.display_name && u.display_name.trim()) return u.display_name.trim();
  const lastColon = u.id.lastIndexOf(':');
  return lastColon >= 0 ? u.id.slice(lastColon + 1) : u.id;
}

function userIsOwner(u) {
  return !!u.roles.find((r) => r.kind === 'owner' && r.agent_group_id === null);
}
function userIsGlobalAdmin(u) {
  return !!u.roles.find((r) => r.kind === 'admin' && r.agent_group_id === null);
}
function userScopedAdminCount(u) {
  return u.roles.filter((r) => r.kind === 'admin' && r.agent_group_id).length;
}
function userMemberCount(u) {
  return u.memberships.length;
}

function userRoleSummary(u) {
  const parts = [];
  if (userIsOwner(u)) parts.push('owner');
  if (userIsGlobalAdmin(u)) parts.push('global admin');
  const sa = userScopedAdminCount(u);
  if (sa) parts.push(`admin · ${sa} group${sa > 1 ? 's' : ''}`);
  const m = userMemberCount(u);
  if (m) parts.push(`member · ${m} group${m > 1 ? 's' : ''}`);
  return parts.join(' · ') || 'no roles';
}

function renderPermsUserList() {
  const list = $('#perms-user-list');
  list.innerHTML = '';
  if (permsUsers.length === 0) {
    list.innerHTML = '<li class="perms-empty" style="padding:16px;">No users yet — anyone who authenticates will appear here.</li>';
    return;
  }
  // Sort: you first, then owners, then admins, then everyone else, alphabetical
  // within each tier. Cheap stable enough for personal-scale.
  const sorted = [...permsUsers].sort((a, b) => {
    const tier = (u) => (u.id === myUserId ? 0 : userIsOwner(u) ? 1 : userIsGlobalAdmin(u) || userScopedAdminCount(u) ? 2 : 3);
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return userDisplayName(a).localeCompare(userDisplayName(b));
  });
  sorted.forEach((u) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    if (u.id === permsSelectedUserId) li.classList.add('active');

    const nameRow = document.createElement('div');
    nameRow.className = 'perms-user-name';
    const nameText = document.createElement('span');
    nameText.className = 'perms-name-text';
    nameText.textContent = userDisplayName(u);
    nameRow.appendChild(nameText);
    if (u.id === myUserId) {
      const youTag = document.createElement('span');
      youTag.className = 'perms-you-tag';
      youTag.textContent = 'YOU';
      nameRow.appendChild(youTag);
    }
    li.appendChild(nameRow);

    const idLine = document.createElement('div');
    idLine.className = 'perms-user-id-sub';
    idLine.textContent = u.id;
    li.appendChild(idLine);

    const summary = document.createElement('div');
    summary.className = 'perms-user-summary';
    summary.textContent = userRoleSummary(u);
    li.appendChild(summary);

    li.addEventListener('click', () => permsSelectUser(u.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        permsSelectUser(u.id);
      }
    });
    list.appendChild(li);
  });
}

function permsSelectUser(userId) {
  permsSelectedUserId = userId;
  renderPermsDetail(userId);
  // Highlight the selected row.
  $('#perms-user-list')
    .querySelectorAll('li')
    .forEach((li) => li.classList.remove('active'));
  // Re-render to pick up the active state (cheap; the list is short).
  renderPermsUserList();
  permsShowDetail();
}

// Audit-aware lookup helpers driven by the new /api/users response shape.
// `roles[]` carries `{kind, agent_group_id, granted_by, granted_at}`,
// `memberships[]` carries `{agent_group_id, added_by, added_at}`.
function findRole(u, kind, agentGroupId) {
  return u.roles.find((r) => r.kind === kind && r.agent_group_id === agentGroupId);
}
function findMembership(u, agentGroupId) {
  return u.memberships.find((m) => m.agent_group_id === agentGroupId);
}

function auditTooltip(audit) {
  if (!audit) return '';
  const who = audit.granted_by || audit.added_by || 'system';
  const whenIso = audit.granted_at || audit.added_at || '';
  const when = whenIso ? new Date(whenIso).toLocaleString() : '';
  return `Granted by ${who}${when ? ' on ' + when : ''}`;
}

function renderPermsDetail(userId) {
  const u = permsUsers.find((x) => x.id === userId);
  if (!u) return;
  $('#perms-detail-name').textContent = userDisplayName(u);
  $('#perms-detail-id').textContent = u.id;

  // ── GLOBAL section: Owner + Global admin toggles ──
  const globalEl = $('#perms-global-toggles');
  globalEl.innerHTML = '';
  globalEl.appendChild(buildToggleRow(u, 'Owner', '👑 ', findRole(u, 'owner', null), () => togglePerm(u.id, 'owner', null, !findRole(u, 'owner', null))));
  globalEl.appendChild(buildToggleRow(u, 'Global admin', '', findRole(u, 'admin', null), () => togglePerm(u.id, 'admin', null, !findRole(u, 'admin', null))));

  // ── PER-AGENT-GROUP matrix ──
  const matrix = $('#perms-matrix');
  matrix.innerHTML = '';
  if (permsAgents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'perms-matrix-empty';
    empty.textContent = 'No agent groups yet.';
    matrix.appendChild(empty);
  } else {
    permsAgents.forEach((a) => {
      const adminRole = findRole(u, 'admin', a.id);
      const member = findMembership(u, a.id);
      const row = document.createElement('div');
      row.className = 'perms-matrix-row';

      const name = document.createElement('span');
      name.className = 'perms-group-name';
      name.textContent = a.name || a.id;
      name.title = a.id;
      row.appendChild(name);

      // Admin cell
      const adminBtn = document.createElement('button');
      adminBtn.type = 'button';
      adminBtn.className = `perms-cell${adminRole ? ' on' : ''}`;
      adminBtn.textContent = adminRole ? '✓' : '·';
      if (adminRole) adminBtn.title = auditTooltip(adminRole);
      adminBtn.setAttribute('aria-label', `${adminRole ? 'Revoke' : 'Grant'} admin · ${a.name || a.id}`);
      adminBtn.addEventListener('click', () => togglePerm(u.id, 'admin', a.id, !adminRole, adminBtn));
      row.appendChild(adminBtn);

      // Member cell
      const memberBtn = document.createElement('button');
      memberBtn.type = 'button';
      memberBtn.className = `perms-cell member-style${member ? ' on' : ''}`;
      memberBtn.textContent = member ? '✓' : '·';
      if (member) memberBtn.title = auditTooltip(member);
      memberBtn.setAttribute('aria-label', `${member ? 'Revoke' : 'Grant'} member · ${a.name || a.id}`);
      memberBtn.addEventListener('click', () => togglePerm(u.id, 'member', a.id, !member, memberBtn));
      row.appendChild(memberBtn);

      matrix.appendChild(row);
    });
  }

  // ── Delete user button (visible only when no roles + no memberships) ──
  const deleteBtn = $('#perms-delete-btn');
  const empty = u.roles.length === 0 && u.memberships.length === 0;
  // Don't let the owner delete themselves through this UI either.
  deleteBtn.hidden = !empty || u.id === myUserId;
}

function buildToggleRow(u, label, prefix, audit, onClick) {
  const row = document.createElement('div');
  row.className = 'perms-toggle-row';

  const lbl = document.createElement('span');
  lbl.className = 'perms-toggle-label';
  lbl.textContent = `${prefix}${label}`;
  if (audit) {
    const meta = document.createElement('span');
    meta.className = 'perms-toggle-meta';
    meta.textContent = `(${auditTooltip(audit)})`;
    lbl.appendChild(meta);
  }
  row.appendChild(lbl);

  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = `perms-switch${audit ? ' on' : ''}`;
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', audit ? 'true' : 'false');
  sw.setAttribute('aria-label', label);
  sw.addEventListener('click', () => onClick(sw));
  row.appendChild(sw);

  return row;
}

/**
 * Toggle a permission on or off. `granting=true` calls /grant; false calls
 * /revoke. The cell is briefly disabled while the request is in flight, then
 * the canonical state is re-fetched from the server.
 */
async function togglePerm(targetUserId, kind, agentGroupId, granting, cellEl) {
  if (cellEl) cellEl.classList.add('busy');
  const ok = granting
    ? await grantPerm(targetUserId, kind, agentGroupId)
    : await revokePermSilent(targetUserId, kind, agentGroupId);
  if (cellEl) cellEl.classList.remove('busy');
  if (ok) await refreshPermissions();
}

async function revokePermSilent(targetUserId, kind, agentGroupId) {
  // Same as revokePerm but no confirm() prompt — the matrix's tap-to-revoke
  // model relies on the visual "on → off" feedback being immediate. Last-
  // owner protection still trips the server's 409 response, surfaced as an
  // alert rather than a confirmation prompt.
  try {
    const r = await authFetch('/api/permissions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ userId: targetUserId, kind, agentGroupId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Revoke failed: ' + (err.error || r.statusText));
      return false;
    }
    return true;
  } catch (err) {
    alert('Revoke failed: ' + err.message);
    return false;
  }
}

async function deleteUser(targetUserId) {
  if (!confirm(`Delete ${targetUserId}? This removes the user record. Roles must already be revoked.`)) return;
  try {
    const r = await authFetch(`/api/users/${encodeURIComponent(targetUserId)}`, {
      method: 'DELETE',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Delete failed: ' + (err.error || r.statusText));
      return;
    }
    permsSelectedUserId = null;
    await refreshPermissions();
    permsShowList();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// View switching within the detail pane (also flips the mobile data-mode)
function permsShowList() {
  $('#perms-body').dataset.mode = 'list';
  $('#perms-detail-empty').hidden = false;
  $('#perms-detail-view').hidden = true;
  $('#perms-create-view').hidden = true;
}
function permsShowDetail() {
  $('#perms-body').dataset.mode = 'detail';
  $('#perms-detail-empty').hidden = true;
  $('#perms-detail-view').hidden = false;
  $('#perms-create-view').hidden = true;
}
function permsShowCreate() {
  $('#perms-body').dataset.mode = 'detail';
  $('#perms-detail-empty').hidden = true;
  $('#perms-detail-view').hidden = true;
  $('#perms-create-view').hidden = false;
  // Reset the wizard fields each time it opens.
  $('#perms-create-channel').value = 'webchat:tailscale';
  $('#perms-create-handle').value = '';
  $('#perms-create-raw').value = '';
  $('#perms-create-kind').value = 'member';
  $('#perms-create-group').value = '';
  permsRefreshCreateUI();
  $('#perms-create-handle').focus();
}

async function grantPerm(targetUserId, kind, agentGroupId) {
  try {
    const r = await authFetch('/api/permissions/grant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ userId: targetUserId, kind, agentGroupId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Grant failed: ' + (err.error || r.statusText));
      return false;
    }
    return true;
  } catch (err) {
    alert('Grant failed: ' + err.message);
    return false;
  }
}

async function revokePerm(targetUserId, kind, agentGroupId) {
  const label = `${kind}${agentGroupId ? ' · ' + agentLabel(agentGroupId) : ''}`;
  if (!confirm(`Revoke ${label} from ${targetUserId}?`)) return;
  try {
    const r = await authFetch('/api/permissions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ userId: targetUserId, kind, agentGroupId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Revoke failed: ' + (err.error || r.statusText));
      return;
    }
    refreshPermissions();
  } catch (err) {
    alert('Revoke failed: ' + err.message);
  }
}

// Wiring
$('#perms-toggle').addEventListener('click', togglePermissions);
$('#perms-exit').addEventListener('click', togglePermissions);
$('#perms-refresh').addEventListener('click', refreshPermissions);
$('#perms-new-btn').addEventListener('click', () => {
  permsSelectedUserId = null;
  $('#perms-user-list')
    .querySelectorAll('li')
    .forEach((li) => li.classList.remove('active'));
  permsShowCreate();
});
$('#perms-detail-back').addEventListener('click', permsShowList);
$('#perms-create-back').addEventListener('click', permsShowList);
$('#perms-delete-btn').addEventListener('click', () => {
  if (permsSelectedUserId) deleteUser(permsSelectedUserId);
});

// ── + New User wizard ────────────────────────────────────────────────
// The dropdown picks a channel "namespace prefix"; the handle/email input
// is appended after a colon to compose the full user_id. Picking
// "__raw__" reveals a single raw input instead. The preview line shows
// the resolved id as the user types.
function permsCreateComposedId() {
  const channel = $('#perms-create-channel').value;
  if (channel === '__raw__') return $('#perms-create-raw').value.trim();
  const handle = $('#perms-create-handle').value.trim();
  if (!handle) return '';
  return `${channel}:${handle}`;
}
function permsRefreshCreateUI() {
  const channel = $('#perms-create-channel').value;
  const isRaw = channel === '__raw__';
  $('#perms-create-handle-label').hidden = isRaw;
  $('#perms-create-raw-label').hidden = !isRaw;
  const composed = permsCreateComposedId();
  $('#perms-create-preview').textContent = composed
    ? `Resolved id: ${composed}`
    : 'Resolved id will appear here.';
  // Show/hide the agent-group selector based on initial-role choice.
  const kind = $('#perms-create-kind').value;
  const wantsGroup = kind === 'admin' || kind === 'member';
  $('#perms-create-group-label').hidden = !wantsGroup;
}
$('#perms-create-channel').addEventListener('change', permsRefreshCreateUI);
$('#perms-create-handle').addEventListener('input', permsRefreshCreateUI);
$('#perms-create-raw').addEventListener('input', permsRefreshCreateUI);
$('#perms-create-kind').addEventListener('change', permsRefreshCreateUI);

$('#perms-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = permsCreateComposedId();
  if (!userId) {
    alert('Enter a handle / email (or pick "raw user_id" and enter the full id).');
    return;
  }
  if (!userId.includes(':')) {
    alert('user_id must be namespaced (channel:handle).');
    return;
  }
  const kind = $('#perms-create-kind').value;
  const groupVal = $('#perms-create-group').value;
  const agentGroupId = groupVal || null;
  if (kind === 'owner' && agentGroupId) {
    alert('owner role is always global — pick "— global —".');
    return;
  }
  if (kind === 'member' && !agentGroupId) {
    alert('member role requires an agent group.');
    return;
  }
  if (await grantPerm(userId, kind, agentGroupId)) {
    permsSelectedUserId = userId;
    await refreshPermissions();
    permsShowDetail();
  }
});

function relativeTime(ts) {
  const diff = Date.now() - (typeof ts === 'number' ? ts : new Date(ts).getTime());
  if (diff < 0 || diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function refreshDashboard() {
  let snap;
  try {
    const res = await authFetch('/api/overview');
    if (!res.ok) {
      $('#dash-graph').innerHTML = `<div class="dash-empty">Unable to load overview (${res.status})</div>`;
      return;
    }
    snap = await res.json();
  } catch (err) {
    $('#dash-graph').innerHTML = `<div class="dash-empty">Unable to load overview: ${esc(err.message)}</div>`;
    return;
  }
  renderHealthStrip(snap);
  renderMetrics(snap);
}

function renderHealthStrip(snap) {
  const wsOk = ws && ws.readyState === WebSocket.OPEN;
  const pills = [
    { dot: 'ok', label: 'Server', value: 'Online' },
    { dot: 'ok', label: 'Uptime', value: snap.health.uptime ? formatUptime(snap.health.uptime) : '—' },
    { dot: wsOk ? 'ok' : 'err', label: 'WebSocket', value: wsOk ? 'Connected' : 'Disconnected' },
  ];
  if (snap.health.container_runtime_ok !== undefined && !snap.restricted) {
    pills.push({
      dot: snap.health.container_runtime_ok ? 'ok' : 'warn',
      label: 'Containers',
      value: snap.health.container_runtime_ok ? 'Up' : 'Unreachable',
    });
  }
  $('#dash-health').innerHTML = pills
    .map(
      (p) =>
        `<div class="dash-pill"><span class="pill-dot ${p.dot}"></span><span class="pill-label">${esc(p.label)}</span><span class="pill-value">${esc(p.value)}</span></div>`,
    )
    .join('');
}

function renderMetrics(snap) {
  const el = $('#dash-graph');
  const num = (v) => esc(String(Number(v) || 0));

  const agentsLabel = snap.restricted ? 'Visible Agents' : 'Agents';
  const agentsCount = snap.restricted ? snap.agents.visible : snap.agents.total;
  const agentsCard = `<div class="metric-card clickable" onclick="showAgentsDetail()">
    <div class="metric-value">${num(agentsCount)}</div>
    <div class="metric-label">${esc(agentsLabel)}</div>
  </div>`;

  const sessionsCard = `<div class="metric-card">
    <div class="metric-value">${num(snap.sessions.active)}</div>
    <div class="metric-label">Active Sessions</div>
    <div class="metric-sub">${num(snap.sessions.total)} total</div>
  </div>`;

  const messagesCard = `<div class="metric-card clickable" onclick="showMessagesDetail()">
    <div class="metric-value">${num(snap.messages.webchat_24h)}</div>
    <div class="metric-label">Webchat Msgs (24h)</div>
  </div>`;

  let containersCard;
  if (snap.restricted || snap.active_containers === null) {
    containersCard = `<div class="metric-card">
      <div class="metric-value">—</div>
      <div class="metric-label">Containers</div>
    </div>`;
  } else {
    containersCard = `<div class="metric-card clickable" onclick="showContainersDetail()">
      <div class="metric-value">${num(snap.active_containers)}</div>
      <div class="metric-label">Active Containers</div>
    </div>`;
  }

  const topRow = `<div class="metrics-grid">${agentsCard}${sessionsCard}${messagesCard}${containersCard}</div>`;

  // System (owner-only).
  let systemCards = '';
  if (snap.system) {
    const memBar = snap.system.memory_used_pct;
    const memColor = memBar > 85 ? 'var(--delete-color)' : memBar > 60 ? '#ffd54f' : 'var(--accent)';
    const loadStr = snap.system.load_avg.join(' / ');
    const sysCard = `<div class="metric-card wide">
      <div class="metric-label">System</div>
      <div class="sys-row"><span>Memory</span><span>${num(snap.system.memory_used_gb)} / ${num(snap.system.memory_total_gb)} GB (${num(memBar)}%)</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${num(memBar)}%;background:${memColor}"></div></div>
      <div class="sys-row"><span>CPU Load (1/5/15m)</span><span>${esc(loadStr)}</span></div>
      <div class="sys-row"><span>CPUs</span><span>${num(snap.system.cpus)}</span></div>
      <div class="sys-row"><span>Platform</span><span>${esc(snap.system.platform)}</span></div>
    </div>`;
    let ollamaCard;
    if (!snap.ollama) {
      ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">Ollama</div>
        <div class="metric-sub">Not configured</div>
      </div>`;
    } else {
      const dot = snap.ollama.ok ? '<span class="pill-dot ok"></span>' : '<span class="pill-dot err"></span>';
      const models =
        snap.ollama.models && snap.ollama.models.length
          ? snap.ollama.models.map((m) => `<span class="model-tag">${esc(m)}</span>`).join(' ')
          : '<span class="metric-sub">No models</span>';
      ollamaCard = `<div class="metric-card wide">
        <div class="metric-label">${dot} Ollama</div>
        <div class="sys-row"><span>Host</span><span>${esc(snap.ollama.host)}</span></div>
        <div class="sys-row"><span>Status</span><span>${snap.ollama.ok ? 'Connected' : 'Unreachable'}</span></div>
        <div style="margin-top:6px">${models}</div>
      </div>`;
    }
    systemCards = `<div class="metrics-grid two-col">${sysCard}${ollamaCard}</div>`;
  }

  // Channels.
  const channelEntries = Object.entries(snap.channels).sort((a, b) => b[1] - a[1]);
  const channelHtml =
    channelEntries.length === 0
      ? '<div class="metric-sub">No channels wired</div>'
      : channelEntries
          .map(
            ([ch, count]) =>
              `<div class="channel-row"><span class="channel-name">${esc(ch)}</span><span class="channel-count">${count}</span></div>`,
          )
          .join('');
  const channelsCard = `<div class="metric-card">
    <div class="metric-label">Channels</div>
    ${channelHtml}
  </div>`;

  // Busiest rooms (owner-only).
  let busiestCard;
  if (snap.busiest_rooms !== null) {
    const rows =
      snap.busiest_rooms.length === 0
        ? '<div class="metric-sub">No activity</div>'
        : snap.busiest_rooms
            .map(
              (r) =>
                `<div class="channel-row"><span class="channel-name">#${esc(r.id)}</span><span class="channel-count">${r.count} msgs</span></div>`,
            )
            .join('');
    busiestCard = `<div class="metric-card">
      <div class="metric-label">Busiest Rooms (24h)</div>
      ${rows}
    </div>`;
  } else {
    busiestCard = '';
  }

  const breakdownRow = busiestCard
    ? `<div class="metrics-grid two-col">${channelsCard}${busiestCard}</div>`
    : `<div class="metrics-grid two-col">${channelsCard}</div>`;

  el.innerHTML = topRow + systemCards + breakdownRow;
}

// ── Dashboard detail panels ───────────────────────────────────────────────

function showDetail(title, html) {
  $('#dash-detail-title').textContent = title;
  $('#dash-detail-body').innerHTML = html;
  $('#dash-detail').hidden = false;
  $('#dash-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideDetail() {
  $('#dash-detail').hidden = true;
}

$('#dash-detail-close').addEventListener('click', hideDetail);

async function showMessagesDetail() {
  // Aggregate recent messages across rooms — same approach as v1.
  const rooms = await authFetch('/api/rooms')
    .then((r) => r.json())
    .catch(() => []);
  const since = Date.now() - 86400000;
  const perRoom = await Promise.all(
    rooms.map((room) =>
      authFetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`)
        .then((r) => r.json())
        .then((msgs) => msgs.filter((m) => m.created_at > since).map((m) => ({ ...m, roomId: room.id })))
        .catch(() => []),
    ),
  );
  const all = perRoom.flat().sort((a, b) => b.created_at - a.created_at).slice(0, 50);
  if (all.length === 0) {
    showDetail('Messages (24h)', '<div class="metric-sub">No messages in the last 24 hours</div>');
    return;
  }
  const rows = all
    .map((m) => {
      const time = new Date(m.created_at).toLocaleTimeString();
      const icon = m.sender_type === 'agent' ? '🤖' : '👤';
      return `<tr>
      <td>${esc(time)}</td>
      <td style="color:${roomColor(m.roomId)}">#${esc(m.roomId)}</td>
      <td>${icon} ${esc(m.sender)}</td>
      <td class="msg-content">${esc(String(m.content || '').slice(0, 100))}</td>
    </tr>`;
    })
    .join('');
  showDetail(
    'Messages (24h)',
    `<table class="detail-table">
      <thead><tr><th>Time</th><th>Room</th><th>Sender</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

async function showContainersDetail() {
  showDetail(
    'Active Containers',
    `<div class="metric-sub">Run <code>docker ps --filter name=nanoclaw-</code> on the host to see container details. The number on the card reflects what was running at the moment of the last refresh.</div>`,
  );
}

async function showAgentsDetail() {
  const agents = await authFetch('/api/agents')
    .then((r) => r.json())
    .catch(() => []);
  if (agents.length === 0) {
    showDetail('Agents', '<div class="metric-sub">No agents</div>');
    return;
  }
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const rows = sorted
    .map((b) => {
      const room = b.room_id ? `<code>${esc(b.room_id)}</code>` : '<span class="metric-sub">—</span>';
      return `<tr>
      <td>${esc(b.name)}</td>
      <td><code>${esc(b.folder)}</code></td>
      <td>${room}</td>
      <td><span class="metric-sub">${esc(new Date(b.created_at).toLocaleString())}</span></td>
    </tr>`;
    })
    .join('');
  showDetail(
    'Agents',
    `<table class="detail-table">
      <thead><tr><th>Name</th><th>Folder</th><th>Room</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

// Make detail handlers globally accessible for inline onclick.
window.showMessagesDetail = showMessagesDetail;
window.showContainersDetail = showContainersDetail;
window.showAgentsDetail = showAgentsDetail;

// ── Agent management ────────────────────────────────────────────────────────

let allAgents = [];
let selectedAgentId = null;

async function fetchAgents() {
  try {
    const res = await authFetch('/api/agents');
    allAgents = await res.json();
    renderAgents();
  } catch (err) {
    console.error('Failed to fetch agents:', err);
  }
}

function renderAgents() {
  const list = $('#agent-list');
  list.innerHTML = '';

  const sorted = [...allAgents].sort((a, b) => a.name.localeCompare(b.name));

  for (const agent of sorted) {
    const li = document.createElement('li');
    li.dataset.agentId = agent.id;
    if (agent.id === selectedAgentId) li.classList.add('active');

    const icon = document.createElement('span');
    icon.className = 'agent-icon';
    icon.textContent = '🤖';
    li.appendChild(icon);

    const info = document.createElement('span');
    info.className = 'agent-info';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'agent-info-name';
    nameSpan.textContent = agent.name;
    info.appendChild(nameSpan);
    li.appendChild(info);

    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => {
      if (selectedAgentId === agent.id && !$('#agent-detail').hidden) {
        closeAgentDetail();
      } else {
        openAgentDetail(agent.id);
      }
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openAgentDetail(agent.id);
      }
    });
    list.appendChild(li);
  }
}

async function openAgentDetail(id) {
  const agent = allAgents.find((b) => b.id === id);
  if (!agent) return;
  selectedAgentId = id;
  renderAgents();
  closeRoomDetail();
  closeModelDetail();

  // Show edit view, hide create view
  $('#agent-edit-view').hidden = false;
  $('#agent-create-view').hidden = true;

  $('#agent-detail-title').textContent = agent.name;
  $('#agent-name').value = agent.name;

  // Models dropdown — refresh the list lazily so a freshly-added model
  // shows up without a tab-switch round trip.
  if (allModels.length === 0) await fetchModels();
  populateAgentModelSelect(agent.assigned_model_id);

  // Load instructions
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(id)}/instructions`);
    if (res.ok) {
      const { content } = await res.json();
      $('#agent-instructions').value = content;
    }
  } catch {}

  $('#agent-detail').hidden = false;
  $('#members-panel').hidden = true;
}

function closeAgentDetail() {
  $('#agent-detail').hidden = true;
  $('#agent-edit-view').hidden = false;
  $('#agent-create-view').hidden = true;
  selectedAgentId = null;
  renderAgents();
}

$('#agent-detail-close').addEventListener('click', closeAgentDetail);
$('#agent-create-close').addEventListener('click', closeAgentDetail);

// Save existing agent
$('#agent-detail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedAgentId) return;
  const btn = $('#agent-detail-form button.btn-save');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  btn.classList.remove('success');
  const updates = {
    name: $('#agent-name').value.trim(),
  };
  try {
    // Update agent config
    await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    // Update instructions
    await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/instructions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: $('#agent-instructions').value }),
    });
    // Update model assignment (empty string in the select = unassign).
    const selectedModel = $('#agent-model').value || null;
    const currentModel =
      allAgents.find((b) => b.id === selectedAgentId)?.assigned_model_id || null;
    if (selectedModel !== currentModel) {
      await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: selectedModel }),
      });
    }
    await fetchAgents();
    // Don't re-openAgentDetail — that re-fetches instructions and resets the
    // user's cursor position. The form values already reflect what they typed,
    // and the agent list re-render is what we actually need for the rename
    // to be visible.
    btn.textContent = '✓ Saved';
    btn.classList.add('success');
    setTimeout(() => {
      // Only restore if the user hasn't navigated away (form still mounted).
      if (btn.isConnected) {
        btn.textContent = originalLabel;
        btn.classList.remove('success');
        btn.disabled = false;
      }
    }, 1500);
  } catch (err) {
    console.error('Failed to update agent:', err);
    alert('Failed to save agent: ' + (err.message || 'Unknown error'));
    btn.textContent = originalLabel;
    btn.classList.remove('success');
    btn.disabled = false;
  }
});

// Delete agent
$('#agent-delete').addEventListener('click', async () => {
  if (!selectedAgentId) return;
  const agent = allAgents.find((b) => b.id === selectedAgentId);
  if (!confirm(`Delete "${agent?.name}"? This cannot be undone.`)) return;
  try {
    await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}`, { method: 'DELETE' });
    closeAgentDetail();
    await fetchAgents();
  } catch (err) {
    console.error('Failed to delete agent:', err);
  }
});

// ── Create agent ────────────────────────────────────────────────────────────

$('#create-agent-btn').addEventListener('click', () => {
  selectedAgentId = null;
  renderAgents();
  $('#agent-edit-view').hidden = true;
  $('#agent-create-view').hidden = false;
  $('#agent-create-name').value = '';
  $('#agent-detail').hidden = false;
  $('#members-panel').hidden = true;
  $('#agent-create-name').focus();
});

$('#agent-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#agent-create-name').value.trim();
  if (!name) return;
  const instructions = $('#agent-create-instructions').value;
  try {
    const res = await authFetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, instructions: instructions || undefined }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to create agent: ' + (err.error || res.statusText));
      return;
    }
    await fetchAgents();
    closeAgentDetail();
  } catch (err) {
    alert('Failed to create agent: ' + err.message);
  }
});

// ── Drafter: ✨ Suggest from prompt ───────────────────────────────────────
//
// Three target sets keyed on data-drafter-target:
//   agent-create   → #agent-create-draft-prompt → #agent-create-name + -instructions
//   room-create    → #room-create-draft-prompt  → #room-create-new-name + -instructions
//   room-add-agent → #room-add-agent-draft-prompt → #room-add-agent-new-name + -instructions
//
// Each ✨ click POSTs the prompt to /api/agents/draft (host-side LLM call,
// routed through the OneCLI proxy for the webchat-drafter identifier).
// The response populates the corresponding name + instructions inputs and
// focuses the name so the operator can tweak before submitting. Never
// auto-creates — review is always required.
const DRAFTER_TARGETS = {
  'agent-create': {
    prompt: '#agent-create-draft-prompt',
    name: '#agent-create-name',
    instructions: '#agent-create-instructions',
  },
  'room-create': {
    prompt: '#room-create-draft-prompt',
    name: '#room-create-new-name',
    instructions: '#room-create-new-instructions',
  },
  'room-add-agent': {
    prompt: '#room-add-agent-draft-prompt',
    name: '#room-add-agent-new-name',
    instructions: '#room-add-agent-new-instructions',
  },
};

document.querySelectorAll('.drafter-btn').forEach((btn) => {
  btn.addEventListener('click', () => draftFor(btn));
});

async function draftFor(btn) {
  const targetKey = btn.dataset.drafterTarget;
  const target = DRAFTER_TARGETS[targetKey];
  if (!target) return;
  const promptEl = $(target.prompt);
  const nameEl = $(target.name);
  const instructionsEl = $(target.instructions);
  const prompt = (promptEl?.value || '').trim();
  if (!prompt) {
    alert('Type a description first, e.g. "An agent that helps me draft replies to emails".');
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '✨ Drafting…';
  try {
    const res = await authFetch('/api/agents/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert('Drafter failed: ' + (body.error || res.statusText));
      return;
    }
    if (nameEl) nameEl.value = body.name || '';
    if (instructionsEl) instructionsEl.value = body.instructions || '';
    nameEl?.focus();
    nameEl?.select();
  } catch (err) {
    alert('Drafter failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── Room management ─────────────────────────────────────────────────────────

let selectedRoomId = null;
let roomDetailWiredAgents = [];

function showRoomSettingsToggle(visible) {
  $('#room-settings-toggle').hidden = !visible;
}

async function openRoomDetail(roomId) {
  selectedRoomId = roomId;
  closeAgentDetail();
  $('#room-create-view').hidden = true;
  $('#room-edit-view').hidden = false;

  const room = lastRoomsList.find((r) => r.id === roomId);
  $('#room-detail-title').textContent = room ? `${room.name} — settings` : 'Room settings';

  // Hide the add-agent form when opening
  $('#room-add-agent-form').hidden = true;

  await refreshRoomWiredAgents(roomId);

  $('#room-detail').hidden = false;
  $('#members-panel').hidden = true;
  $('#agent-detail').hidden = true;
}

function closeRoomDetail() {
  $('#room-detail').hidden = true;
  $('#room-edit-view').hidden = false;
  $('#room-create-view').hidden = true;
  selectedRoomId = null;
}

async function refreshRoomWiredAgents(roomId) {
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`);
    roomDetailWiredAgents = await res.json();
  } catch (err) {
    console.error('Failed to fetch wired agents:', err);
    roomDetailWiredAgents = [];
  }
  renderRoomWiredAgents();
  await populateAddAgentSelect();
}

function renderRoomWiredAgents() {
  const list = $('#room-wired-agents');
  list.innerHTML = '';
  const onlyOne = roomDetailWiredAgents.length <= 1;
  const anyPrime = roomDetailWiredAgents.some((a) => a.is_prime);
  for (const agent of roomDetailWiredAgents) {
    const li = document.createElement('li');

    // Prime toggle (★) — clicking sets this agent as prime, or clears if already prime.
    // With only one wired agent, prime designation is meaningless (that agent fires on
    // everything anyway), so the control is hidden.
    const primeBtn = document.createElement('button');
    primeBtn.type = 'button';
    primeBtn.className = 'room-wired-prime' + (agent.is_prime ? ' active' : '');
    primeBtn.textContent = agent.is_prime ? '★' : '☆';
    primeBtn.title = agent.is_prime
      ? `Clear prime — ${agent.name} will lose default-responder status`
      : `Make ${agent.name} prime — they answer all messages except those that @mention another wired agent`;
    primeBtn.hidden = onlyOne;
    primeBtn.addEventListener('click', () => togglePrimeAgent(agent));
    li.appendChild(primeBtn);

    const name = document.createElement('span');
    name.className = 'room-wired-name';
    name.textContent = agent.name;
    if (agent.is_prime) {
      const badge = document.createElement('span');
      badge.className = 'room-wired-prime-badge';
      badge.textContent = ' prime';
      name.appendChild(badge);
    }
    li.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'room-wired-remove';
    removeBtn.textContent = '×';
    removeBtn.title = onlyOne ? 'Cannot remove the last agent (delete the room instead)' : `Remove ${agent.name}`;
    removeBtn.disabled = onlyOne;
    removeBtn.addEventListener('click', () => removeAgentFromRoom(agent.id, agent.name));
    li.appendChild(removeBtn);

    list.appendChild(li);
  }

  // Helper line below the list explaining the prime model. Only shown when the
  // toggle is meaningful (≥2 agents) so it doesn't clutter the 1:1 case.
  let note = $('#room-prime-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'room-prime-note';
    note.className = 'room-prime-note';
    list.parentElement?.insertBefore(note, list.nextSibling);
  }
  if (onlyOne) {
    note.hidden = true;
  } else {
    note.hidden = false;
    note.textContent = anyPrime
      ? 'Prime agent answers everything except messages that @mention another wired agent (by their slug folder).'
      : 'No prime: every wired agent answers every message. Star one to make it the default responder.';
  }
}

async function togglePrimeAgent(agent) {
  if (!selectedRoomId) return;
  const url = `/api/rooms/${encodeURIComponent(selectedRoomId)}/prime`;
  try {
    const res = agent.is_prime
      ? await authFetch(url, { method: 'DELETE' })
      : await authFetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agent.id }),
        });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to update prime: ' + (err.error || res.statusText));
      return;
    }
    await refreshRoomWiredAgents(selectedRoomId);
  } catch (err) {
    alert('Failed to update prime: ' + err.message);
  }
}

async function populateAddAgentSelect() {
  // Make sure allAgents is fresh for the picker (avoid showing stale list).
  if (allAgents.length === 0) await fetchAgents();
  const wiredIds = new Set(roomDetailWiredAgents.map((a) => a.id));
  const candidates = allAgents.filter((a) => !wiredIds.has(a.id));
  const list = $('#room-add-agent-list');
  list.innerHTML = '';
  if (candidates.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'No unwired agents — switch to "New" to create one.';
    list.appendChild(li);
    updateAddAgentSubmitLabel();
    return;
  }
  const sorted = [...candidates].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  for (const agent of sorted) {
    const li = document.createElement('li');
    li.className = 'room-add-agent-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = agent.id;
    cb.id = `room-add-agent-${agent.id}`;
    cb.addEventListener('change', updateAddAgentSubmitLabel);
    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.className = 'room-add-agent-label';
    const name = document.createElement('span');
    name.className = 'room-add-agent-name';
    name.textContent = agent.name || agent.id;
    const sub = document.createElement('span');
    sub.className = 'room-add-agent-sub';
    sub.textContent = agent.folder || agent.id;
    lbl.appendChild(name);
    lbl.appendChild(sub);
    li.appendChild(cb);
    li.appendChild(lbl);
    list.appendChild(li);
  }
  updateAddAgentSubmitLabel();
}

function updateAddAgentSubmitLabel() {
  const checked = $('#room-add-agent-list').querySelectorAll('input[type=checkbox]:checked');
  const btn = $('#room-add-agent-existing-submit');
  const n = checked.length;
  btn.textContent = n > 0 ? `Add selected (${n})` : 'Add selected';
  btn.disabled = n === 0;
}

async function addExistingAgentToRoom() {
  if (!selectedRoomId) return;
  const checked = Array.from($('#room-add-agent-list').querySelectorAll('input[type=checkbox]:checked'));
  if (checked.length === 0) return;
  const ids = checked.map((cb) => cb.value);
  // Add each selected agent. POST /api/rooms/:id/agents currently takes one
  // agent per call; we issue them sequentially so a failure surfaces with
  // the matching agent and partial progress is preserved.
  $('#room-add-agent-existing-submit').disabled = true;
  try {
    for (const id of ids) {
      await addAgentToRoom(selectedRoomId, { kind: 'existing', id });
    }
  } finally {
    // populateAddAgentSelect re-runs after each addAgentToRoom (via the
    // refresh path), so the list is now empty of just-added entries.
    updateAddAgentSubmitLabel();
  }
}

async function addNewAgentToRoom() {
  if (!selectedRoomId) return;
  const name = $('#room-add-agent-new-name').value.trim();
  if (!name) return;
  const instructions = $('#room-add-agent-new-instructions').value;
  await addAgentToRoom(selectedRoomId, { kind: 'new', name, instructions });
}

async function addAgentToRoom(roomId, ref) {
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ref),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to add agent: ' + (err.error || res.statusText));
      return;
    }
    $('#room-add-agent-form').hidden = true;
    $('#room-add-agent-new-name').value = '';
    $('#room-add-agent-new-instructions').value = '';
    // Refresh agents (in case a new one was created), then re-render wirings.
    await fetchAgents();
    await refreshRoomWiredAgents(roomId);
  } catch (err) {
    alert('Failed to add agent: ' + err.message);
  }
}

async function removeAgentFromRoom(agentId, agentName) {
  if (!selectedRoomId) return;
  if (!confirm(`Remove "${agentName}" from this room? The agent itself will not be deleted.`)) return;
  try {
    const res = await authFetch(
      `/api/rooms/${encodeURIComponent(selectedRoomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to remove agent: ' + (err.error || res.statusText));
      return;
    }
    await refreshRoomWiredAgents(selectedRoomId);
  } catch (err) {
    alert('Failed to remove agent: ' + err.message);
  }
}

async function deleteCurrentRoom() {
  if (!selectedRoomId) return;
  const room = lastRoomsList.find((r) => r.id === selectedRoomId);
  const label = room ? room.name : selectedRoomId;
  if (!confirm(`Delete room "${label}"? Wired agents will be preserved (delete them separately if you want them gone).`)) {
    return;
  }
  const roomToClose = selectedRoomId;
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomToClose)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to delete room: ' + (err.error || res.statusText));
      return;
    }
    closeRoomDetail();
    if (currentRoom === roomToClose) {
      currentRoom = null;
      $('#room-name').textContent = 'Select a room';
      $('#message-input').disabled = true;
      $('#message-form button[type=submit]').disabled = true;
      $('#messages').innerHTML = '<div class="empty-state">Select a room from the sidebar to start chatting</div>';
      showRoomSettingsToggle(false);
    }
  } catch (err) {
    alert('Failed to delete room: ' + err.message);
  }
}

// Wire up room-detail UI.
$('#room-settings-toggle').addEventListener('click', () => {
  if (!currentRoom) return;
  if (selectedRoomId === currentRoom && !$('#room-detail').hidden) closeRoomDetail();
  else openRoomDetail(currentRoom);
});
$('#room-detail-close').addEventListener('click', closeRoomDetail);
$('#room-delete').addEventListener('click', deleteCurrentRoom);
$('#room-add-agent-toggle').addEventListener('click', () => {
  $('#room-add-agent-form').hidden = !$('#room-add-agent-form').hidden;
});
$('#room-add-agent-existing-submit').addEventListener('click', addExistingAgentToRoom);
$('#room-add-agent-new-submit').addEventListener('click', addNewAgentToRoom);
document.querySelectorAll('.room-agent-picker-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.room-agent-picker-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.picker;
    $('#room-add-agent-existing').hidden = which !== 'existing';
    $('#room-add-agent-new').hidden = which !== 'new';
  });
});

// ── Create room ─────────────────────────────────────────────────────────────

async function openRoomCreate() {
  selectedRoomId = null;
  closeAgentDetail();
  $('#room-edit-view').hidden = true;
  $('#room-create-view').hidden = false;
  $('#room-create-name').value = '';
  $('#room-create-new-name').value = '';
  $('#room-create-new-instructions').value = '';
  $('#room-create-new-block').hidden = true;
  await fetchAgents();
  renderRoomCreateAgentChecklist();
  $('#room-detail').hidden = false;
  $('#members-panel').hidden = true;
  $('#agent-detail').hidden = true;
  $('#room-create-name').focus();
}

function renderRoomCreateAgentChecklist() {
  const list = $('#room-create-existing-agents');
  list.innerHTML = '';
  if (allAgents.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'No agents yet — create one inline below.';
    list.appendChild(li);
    return;
  }
  const sorted = [...allAgents].sort((a, b) => a.name.localeCompare(b.name));
  for (const agent of sorted) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = agent.id;
    cb.id = `room-create-agent-${agent.id}`;
    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.textContent = agent.name;
    li.appendChild(cb);
    li.appendChild(lbl);
    list.appendChild(li);
  }
}

$('#create-room-btn').addEventListener('click', openRoomCreate);
$('#room-create-close').addEventListener('click', closeRoomDetail);
$('#room-create-toggle-new').addEventListener('click', () => {
  $('#room-create-new-block').hidden = !$('#room-create-new-block').hidden;
  if (!$('#room-create-new-block').hidden) $('#room-create-new-name').focus();
});

$('#room-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#room-create-name').value.trim();
  if (!name) return;
  const checked = Array.from($('#room-create-existing-agents').querySelectorAll('input[type=checkbox]'))
    .filter((cb) => cb.checked)
    .map((cb) => ({ kind: 'existing', id: cb.value }));
  const newName = $('#room-create-new-name').value.trim();
  const refs = [...checked];
  if (newName) {
    refs.push({
      kind: 'new',
      name: newName,
      instructions: $('#room-create-new-instructions').value || undefined,
    });
  }
  if (refs.length === 0) {
    alert('Pick at least one existing agent or create a new one inline.');
    return;
  }
  try {
    const res = await authFetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, agents: refs }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to create room: ' + (err.error || res.statusText));
      return;
    }
    const body = await res.json();
    closeRoomDetail();
    await fetchAgents();
    // The broadcastRooms() server-side will push the updated list via WS,
    // but join immediately so the user lands in the new room.
    if (body.room) joinRoom(body.room.id, body.room.name);
  } catch (err) {
    alert('Failed to create room: ' + err.message);
  }
});

// ── Typing indicators ─────────────────────────────────────────────────────
function handleTypingEvent(msg) {
  if (msg.room_id !== currentRoom) return;
  const { identity, identity_type, is_typing } = msg;

  if (is_typing) {
    if (identity_type === 'agent') agentName = identity;
    if (typingUsers.has(identity)) clearTimeout(typingUsers.get(identity).timeout);
    const timeout = setTimeout(
      () => {
        typingUsers.delete(identity);
        renderTypingIndicator();
      },
      identity_type === 'agent' ? 120000 : 5000,
    );
    typingUsers.set(identity, { timeout, identity_type });
  } else {
    if (typingUsers.has(identity)) clearTimeout(typingUsers.get(identity).timeout);
    typingUsers.delete(identity);
  }
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const el = $('#typing-indicator');
  const entries = [...typingUsers.entries()];
  if (entries.length === 0) {
    el.hidden = true;
    el.className = 'typing-indicator';
    const bubble = $('#messages .thinking-bubble');
    if (bubble) bubble.remove();
    return;
  }

  const hasAgent = entries.some(([, v]) => v.identity_type === 'agent');
  const userTypers = entries.filter(([, v]) => v.identity_type !== 'agent');

  let bubble = $('#messages .thinking-bubble');
  if (hasAgent) {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'msg agent thinking-bubble';
      const sender = document.createElement('div');
      sender.className = 'sender';
      sender.textContent = `🤖 ${agentName || 'Agent'} — Thinking`;
      bubble.appendChild(sender);
      const content = document.createElement('div');
      content.className = 'bubble';
      content.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
      bubble.appendChild(content);
      $('#messages').appendChild(bubble);
      if (isNearBottom()) scrollToBottom();
    }
  } else if (bubble) {
    bubble.remove();
  }

  if (userTypers.length > 0) {
    const names = userTypers.map(([n]) => n);
    const label =
      names.length === 1
        ? `${names[0]} is typing`
        : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`;
    el.innerHTML = `${label}<span class="dots"><span></span><span></span><span></span></span>`;
    el.className = 'typing-indicator';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── Agent status events ───────────────────────────────────────────────────
const TOOL_LABELS = {
  Bash: 'Running command',
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Glob: 'Searching files',
  Grep: 'Searching code',
  WebSearch: 'Searching the web',
  WebFetch: 'Fetching page',
  Task: 'Managing tasks',
  NotebookEdit: 'Editing notebook',
};

function handleStatusEvent(msg) {
  if (msg.room_id !== currentRoom) return;
  if (msg.event === 'tool_use' && msg.detail) {
    updateThinkingBubble(TOOL_LABELS[msg.detail] || `Using ${msg.detail}`);
  } else if (msg.event === 'thinking') {
    updateThinkingBubble('Thinking');
  } else if (msg.event === 'done') {
    const bubble = $('#messages .thinking-bubble');
    if (bubble) bubble.remove();
  }
}

function updateThinkingBubble(label) {
  let bubble = $('#messages .thinking-bubble');
  const created = !bubble;
  if (created) {
    const wasNearBottom = isNearBottom();
    bubble = document.createElement('div');
    bubble.className = 'msg agent thinking-bubble';
    const sender = document.createElement('div');
    sender.className = 'sender';
    bubble.appendChild(sender);
    const content = document.createElement('div');
    content.className = 'bubble';
    content.innerHTML = '<span class="dots"><span></span><span></span><span></span></span>';
    bubble.appendChild(content);
    $('#messages').appendChild(bubble);
    if (wasNearBottom) scrollToBottom();
  }
  const sender = bubble.querySelector('.sender');
  if (sender) sender.textContent = `🤖 ${agentName || 'Agent'} — ${label}`;
}

// ── Typing send (debounced) ───────────────────────────────────────────────
let typingTimeout = null;
let isTyping = false;

$('#message-input').addEventListener('input', function () {
  // Auto-grow textarea — only resize when content overflows or shrinks
  const prevH = this._prevScrollHeight || this.clientHeight;
  if (this.scrollHeight > this.clientHeight || this.scrollHeight < prevH) {
    this.style.height = '0';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  }
  this._prevScrollHeight = this.scrollHeight;
  if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (!isTyping) {
    isTyping = true;
    ws.send(JSON.stringify({ type: 'typing', is_typing: true }));
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    isTyping = false;
    ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }, 2000);
});

$('#message-form').addEventListener('submit', () => {
  if (isTyping) {
    isTyping = false;
    clearTimeout(typingTimeout);
    ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }
});

// ── File upload (drag-drop, paste, picker) ────────────────────────────────
const messagesEl = $('#messages');

messagesEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  messagesEl.classList.add('drag-over');
});
messagesEl.addEventListener('dragleave', () => {
  messagesEl.classList.remove('drag-over');
});
messagesEl.addEventListener('drop', (e) => {
  e.preventDefault();
  messagesEl.classList.remove('drag-over');
  if (e.dataTransfer.files.length > 0) stageFiles(e.dataTransfer.files);
});

document.addEventListener('paste', (e) => {
  if (!currentRoom) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length > 0) {
    e.preventDefault();
    stageFiles(files);
  }
});

$('#file-picker').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => {
    if (input.files.length > 0) stageFiles(input.files);
  });
  input.click();
});

$('#camera-btn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.addEventListener('change', () => {
    if (input.files.length > 0) stageFile(input.files[0]);
  });
  input.click();
});

// ── App badge (unread counter) ───────────────────────────────────────────
async function clearBadgeCount() {
  try {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('nanoclaw-badge', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('state');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise((resolve) => {
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put(0, 'count');
      tx.oncomplete = () => resolve();
    });
  } catch {
    /* ignore */
  }
  if ('clearAppBadge' in navigator) {
    try {
      await navigator.clearAppBadge();
    } catch {}
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) clearBadgeCount();
});
if (!document.hidden) clearBadgeCount();

// ── Init ──────────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Check for updates every 60 seconds
    setInterval(() => reg.update(), 60000);
  });

  // Reload when a new service worker takes over.
  // Don't yank the user mid-message: if there's text in the input, a staged
  // file, or the tab is currently visible-and-interactive, defer the reload
  // until the next time the tab is hidden. (`visibilitychange` to hidden →
  // user switched away → safe to reload.)
  let refreshing = false;
  let reloadPending = false;
  function safeToReload() {
    const input = document.getElementById('message-input');
    const hasDraft = input && input.value.trim().length > 0;
    // pendingFiles is the module-scoped staged-files array.
    const hasStagedFile = Array.isArray(pendingFiles) && pendingFiles.length > 0;
    if (hasDraft || hasStagedFile) return false;
    return document.hidden;
  }
  function tryReload() {
    if (refreshing) return;
    if (safeToReload()) {
      refreshing = true;
      location.reload();
    } else {
      reloadPending = true;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (reloadPending && document.hidden) tryReload();
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    tryReload();
  });

  // Navigate to a room when the SW (notification click) asks us to.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'open-room' && e.data.roomId) {
      const agent = allAgents.find((b) => b.room_id === e.data.roomId);
      joinRoom(e.data.roomId, agent?.name || e.data.roomId);
    }
  });

  // Cold launch from notification (?room=...) — open that room after init.
  const params = new URLSearchParams(location.search);
  const coldRoom = params.get('room');
  if (coldRoom) {
    const tryJoin = () => {
      const agent = allAgents.find((b) => b.room_id === coldRoom);
      if (allAgents.length) joinRoom(coldRoom, agent?.name || coldRoom);
      else setTimeout(tryJoin, 200);
    };
    tryJoin();
  }
}

// ── Models ─────────────────────────────────────────────────────────────────
//
// Sidebar tab + create/edit/delete + per-agent assignment dropdown. Mirrors
// the agents tab shape. Models are skill-owned (webchat_models) and the
// assignment-to-agent flows through PUT /api/agents/:id/model, which the
// host turns into per-agent settings.json env overrides on next spawn.

let allModels = [];
let selectedModelId = null;

async function fetchModels() {
  try {
    const res = await authFetch('/api/models');
    allModels = await res.json();
    renderModels();
  } catch (err) {
    console.error('Failed to fetch models:', err);
  }
}

function renderModels() {
  const list = $('#model-list');
  list.innerHTML = '';
  if (allModels.length === 0) {
    const li = document.createElement('li');
    li.style.cursor = 'default';
    li.style.opacity = '0.6';
    li.textContent = 'No models registered. Click "+ New Model" to add one.';
    list.appendChild(li);
    return;
  }
  for (const model of allModels) {
    const li = document.createElement('li');
    li.dataset.modelId = model.id;
    if (model.id === selectedModelId) li.classList.add('active');

    const badge = document.createElement('span');
    badge.className = `model-kind-badge kind-${model.kind}`;
    badge.textContent = model.kind;
    li.appendChild(badge);

    const name = document.createElement('span');
    name.className = 'model-row-name';
    name.textContent = model.name;
    li.appendChild(name);

    if (model.agents_assigned > 0) {
      const uses = document.createElement('span');
      uses.className = 'model-row-uses';
      uses.textContent = `${model.agents_assigned}×`;
      li.appendChild(uses);
    }

    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.addEventListener('click', () => {
      if (selectedModelId === model.id && !$('#model-detail').hidden) {
        closeModelDetail();
      } else {
        openModelDetail(model.id);
      }
    });
    list.appendChild(li);
  }
}

async function openModelDetail(id) {
  const model = allModels.find((m) => m.id === id);
  if (!model) return;
  selectedModelId = id;
  renderModels();
  closeAgentDetail();
  closeRoomDetail();

  $('#model-edit-view').hidden = false;
  $('#model-create-view').hidden = true;

  $('#model-detail-title').textContent = model.name;
  $('#model-name').value = model.name;
  $('#model-kind').value = model.kind;
  $('#model-endpoint').value = model.endpoint || '';
  $('#model-endpoint-label').hidden = model.kind !== 'ollama';
  $('#model-model-id').value = model.model_id;
  $('#model-discover-select').hidden = true;

  const usage = $('#model-detail-usage');
  usage.textContent =
    model.agents_assigned > 0
      ? `Assigned to ${model.agents_assigned} agent${model.agents_assigned === 1 ? '' : 's'}.`
      : 'Not assigned to any agent yet.';

  $('#model-detail').hidden = false;
  $('#members-panel').hidden = true;
}

function closeModelDetail() {
  $('#model-detail').hidden = true;
  $('#model-edit-view').hidden = false;
  $('#model-create-view').hidden = true;
  selectedModelId = null;
  renderModels();
}

$('#model-detail-close').addEventListener('click', closeModelDetail);
$('#model-create-close').addEventListener('click', closeModelDetail);

$('#create-model-btn').addEventListener('click', () => {
  selectedModelId = null;
  renderModels();
  $('#model-edit-view').hidden = true;
  $('#model-create-view').hidden = false;
  $('#model-create-name').value = '';
  $('#model-create-endpoint').value = '';
  $('#model-create-model-id').value = '';
  $('#model-create-discover-select').hidden = true;
  // Reset kind to default + sync conditional fields
  $('#model-create-kind').value = 'anthropic';
  syncCreateFormToKind();
  // Reset the probe block (used between successive opens)
  $('#model-probe-url').value = '';
  $('#model-probe-status').hidden = true;
  $('#model-probe-results').hidden = true;
  lastProbeResult = null;
  $('#model-detail').hidden = false;
  $('#members-panel').hidden = true;
  $('#model-probe-url').focus();
});

function syncCreateFormToKind() {
  const kind = $('#model-create-kind').value;
  // Endpoint field shows for ollama AND openai-compatible — both need an endpoint.
  $('#model-create-endpoint-label').hidden = kind === 'anthropic';
  const placeholders = {
    anthropic: 'claude-sonnet-4-6',
    ollama: 'llama3.1:70b',
    'openai-compatible': 'gpt-4o-mini or qwen2.5:14b',
  };
  $('#model-create-model-id').placeholder = placeholders[kind] || '';
}
$('#model-create-kind').addEventListener('change', syncCreateFormToKind);

// ── Probe-by-URL flow ──────────────────────────────────────────────────────

let lastProbeResult = null; // { kind, endpoint, models, requires_credential, notes, reason }

$('#model-probe-btn').addEventListener('click', runProbe);
$('#model-probe-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runProbe();
  }
});
$('#model-probe-select-all').addEventListener('click', () => {
  document.querySelectorAll('#model-probe-list input[type=checkbox]').forEach((cb) => {
    cb.checked = true;
  });
});
$('#model-probe-add-selected').addEventListener('click', addSelectedFromProbe);

async function runProbe() {
  const url = $('#model-probe-url').value.trim();
  if (!url) {
    alert('Enter a URL or host first (e.g. localhost:11434, api.anthropic.com).');
    return;
  }
  // Scheme is optional — server races http+https when omitted. Reject only
  // obvious garbage (whitespace, angle brackets) early so we don't burn a
  // round-trip on malformed input.
  if (/\s|[<>]/.test(url)) {
    alert('URL contains invalid characters.');
    return;
  }
  const status = $('#model-probe-status');
  const results = $('#model-probe-results');
  status.classList.remove('error');
  status.textContent = 'Probing…';
  status.hidden = false;
  results.hidden = true;
  $('#model-probe-btn').disabled = true;
  try {
    const res = await authFetch('/api/models/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = body.error || `Probe failed (${res.status})`;
      status.classList.add('error');
      return;
    }
    lastProbeResult = body;
    if (!body.kind) {
      status.textContent = body.reason || 'No known provider responded.';
      status.classList.add('error');
      return;
    }
    status.hidden = true;
    renderProbeResults(body);
  } catch (err) {
    status.textContent = 'Probe failed: ' + err.message;
    status.classList.add('error');
  } finally {
    $('#model-probe-btn').disabled = false;
  }
}

function renderProbeResults(probe) {
  const summary = $('#model-probe-results .model-probe-summary');
  const kindBadge = summary.querySelector('.model-probe-kind');
  const notesEl = summary.querySelector('.model-probe-notes');
  kindBadge.className = `model-probe-kind kind-${probe.kind}`;
  kindBadge.textContent = probe.kind;
  notesEl.textContent = probe.notes || '';

  const list = $('#model-probe-list');
  list.innerHTML = '';
  if (probe.models.length === 0) {
    // Auth-gated endpoint or no models advertised — let user type a model id.
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = probe.requires_credential
      ? 'Endpoint detected, but the model list is gated. Use the Advanced section below to add a specific model id manually.'
      : 'No models advertised — use the Advanced section to add manually.';
    list.appendChild(li);
  } else {
    const host = (() => {
      try {
        return new URL(probe.endpoint).host;
      } catch {
        return probe.endpoint;
      }
    })();
    for (const modelId of probe.models) {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = modelId;
      cb.checked = probe.models.length === 1; // pre-check if only one
      const lbl = document.createElement('label');
      lbl.appendChild(cb);
      const slug = document.createElement('span');
      slug.textContent = modelId;
      slug.style.flex = '1';
      lbl.appendChild(slug);
      li.appendChild(lbl);
      // Editable display name — defaults to "<host> · <model_id>".
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = `${host} · ${modelId}`;
      nameInput.placeholder = 'Display name';
      nameInput.dataset.modelId = modelId;
      li.appendChild(nameInput);
      list.appendChild(li);
    }
  }
  $('#model-probe-results').hidden = false;
}

async function addSelectedFromProbe() {
  if (!lastProbeResult || !lastProbeResult.kind) return;
  const checked = Array.from(document.querySelectorAll('#model-probe-list input[type=checkbox]:checked'));
  if (checked.length === 0) {
    alert('Select at least one model.');
    return;
  }
  const items = checked.map((cb) => {
    const li = cb.closest('li');
    const nameInput = li.querySelector('input[type=text]');
    return {
      name: (nameInput?.value || cb.value).trim(),
      kind: lastProbeResult.kind,
      endpoint: lastProbeResult.endpoint,
      model_id: cb.value,
    };
  });
  const btn = $('#model-probe-add-selected');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = `Adding ${items.length}…`;
  try {
    const res = await authFetch('/api/models/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: items }),
    });
    const out = await res.json();
    if (!res.ok) {
      alert('Bulk add failed: ' + (out.error || res.statusText));
      return;
    }
    if (out.failed && out.failed.length > 0) {
      const lines = out.failed.map((f) => `  • ${items[f.index].model_id}: ${f.error}`).join('\n');
      alert(`Added ${out.created_count}, ${out.failed.length} failed:\n${lines}`);
    }
    await fetchModels();
    closeModelDetail();
    // If the picker kicked off this add, return user to the agent detail
    // and auto-assign the new model when there's exactly one.
    const createdIds = (out.created || []).map((m) => m.id);
    await maybeAssignAfterPickerAdd(createdIds);
  } catch (err) {
    alert('Bulk add failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function discoverModels(kind, endpoint) {
  const body = kind === 'anthropic' ? { kind } : { kind, endpoint };
  const res = await authFetch('/api/models/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out.error || 'discover failed');
  return out.models || [];
}

function bindDiscover(buttonId, kindGetter, endpointGetter, modelIdInput, selectEl) {
  $(buttonId).addEventListener('click', async () => {
    const kind = kindGetter();
    const endpoint = endpointGetter();
    if (kind === 'ollama' && !endpoint) {
      alert('Enter an Ollama endpoint first (e.g. http://localhost:11434)');
      return;
    }
    const btn = $(buttonId);
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const models = await discoverModels(kind, endpoint);
      const select = $(selectEl);
      select.innerHTML = '<option value="">— pick a model —</option>';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
      }
      select.hidden = models.length === 0;
      if (models.length === 0) alert('No models found at that endpoint.');
      select.onchange = () => {
        if (select.value) {
          $(modelIdInput).value = select.value;
          select.hidden = true;
        }
      };
    } catch (err) {
      alert('Discover failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

bindDiscover(
  '#model-create-discover-btn',
  () => $('#model-create-kind').value,
  () => $('#model-create-endpoint').value.trim(),
  '#model-create-model-id',
  '#model-create-discover-select',
);
bindDiscover(
  '#model-discover-btn',
  () => $('#model-kind').value,
  () => $('#model-endpoint').value.trim(),
  '#model-model-id',
  '#model-discover-select',
);

$('#model-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: $('#model-create-name').value.trim(),
    kind: $('#model-create-kind').value,
    model_id: $('#model-create-model-id').value.trim(),
    endpoint: $('#model-create-endpoint').value.trim() || null,
  };
  if (!body.name || !body.model_id) {
    alert('Name and Model ID are required.');
    return;
  }
  try {
    const res = await authFetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) {
      alert('Failed to create model: ' + (out.error || res.statusText));
      return;
    }
    await fetchModels();
    closeModelDetail();
    // If the picker kicked off this add, auto-assign + return to agent.
    const createdId = out.model && out.model.id;
    if (createdId) {
      await maybeAssignAfterPickerAdd([createdId]);
    }
  } catch (err) {
    alert('Failed to create model: ' + err.message);
  }
});

$('#model-detail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedModelId) return;
  const btn = $('#model-detail-form button.btn-save');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  btn.classList.remove('success');
  const patch = {
    name: $('#model-name').value.trim(),
    model_id: $('#model-model-id').value.trim(),
    endpoint: $('#model-endpoint').value.trim() || null,
  };
  try {
    const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const out = await res.json();
    if (!res.ok) {
      alert('Failed to save model: ' + (out.error || res.statusText));
      btn.textContent = original;
      btn.disabled = false;
      return;
    }
    await fetchModels();
    btn.textContent = '✓ Saved';
    btn.classList.add('success');
    setTimeout(() => {
      if (btn.isConnected) {
        btn.textContent = original;
        btn.classList.remove('success');
        btn.disabled = false;
      }
    }, 1500);
  } catch (err) {
    alert('Failed to save model: ' + err.message);
    btn.textContent = original;
    btn.disabled = false;
  }
});

$('#model-delete').addEventListener('click', async () => {
  if (!selectedModelId) return;
  const model = allModels.find((m) => m.id === selectedModelId);
  if (!model) return;
  // First DELETE: server returns 409 with the impact list. We surface it
  // and prompt; on confirm we re-DELETE with ?force=1.
  try {
    const res = await authFetch(`/api/models/${encodeURIComponent(selectedModelId)}`, { method: 'DELETE' });
    if (res.status === 409) {
      const body = await res.json();
      const n = (body.assigned_agent_group_ids || []).length;
      if (
        !confirm(
          `Delete "${model.name}"? It is currently assigned to ${n} agent${n === 1 ? '' : 's'}.\n\n` +
            `They will fall back to the default Anthropic credential + default model on their next session spawn.`,
        )
      ) {
        return;
      }
      const force = await authFetch(
        `/api/models/${encodeURIComponent(selectedModelId)}?force=1`,
        { method: 'DELETE' },
      );
      if (!force.ok) {
        const err = await force.json().catch(() => ({}));
        alert('Failed to delete: ' + (err.error || force.statusText));
        return;
      }
    } else if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('Failed to delete: ' + (err.error || res.statusText));
      return;
    }
    closeModelDetail();
    await fetchModels();
    // Refresh the agents list too — assigned_model_id may have changed for some.
    if (allAgents.length > 0) await fetchAgents();
  } catch (err) {
    alert('Failed to delete: ' + err.message);
  }
});

// ── Agent → Model assignment ──────────────────────────────────────────────
//
// The Model dropdown in the agent edit form. Populated from /api/models on
// every openAgentDetail (cheap; a handful of rows). Saved alongside the
// other agent fields when the user clicks Save.

function populateAgentModelSelect(currentModelId) {
  // The <select> was replaced by a button-driven picker; agent-model is now
  // a hidden input that holds the chosen id. The existing save handler in
  // saveAgentDetail still reads `$('#agent-model').value`.
  $('#agent-model').value = currentModelId || '';
  refreshAgentModelTrigger();
}

/**
 * Update the picker trigger button's labels to reflect the currently-
 * assigned model. Two-line layout: name on top, kind+model_id+host underneath.
 * No selection → "Default" / "Built-in Anthropic".
 */
function refreshAgentModelTrigger() {
  const trigger = $('#agent-model-trigger');
  if (!trigger) return;
  const id = $('#agent-model').value;
  const nameEl = trigger.querySelector('.model-picker-trigger-name');
  const metaEl = trigger.querySelector('.model-picker-trigger-meta');
  if (!id) {
    nameEl.textContent = 'Default';
    metaEl.textContent = 'Built-in Anthropic';
    return;
  }
  const m = allModels.find((mm) => mm.id === id);
  if (!m) {
    nameEl.textContent = 'Unknown model';
    metaEl.textContent = id;
    return;
  }
  nameEl.textContent = m.name;
  const host = endpointHost(m.endpoint);
  metaEl.textContent = host ? `${m.kind} · ${m.model_id} · ${host}` : `${m.kind} · ${m.model_id}`;
}

function endpointHost(endpoint) {
  if (!endpoint) return '';
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

// ── Model picker ──────────────────────────────────────────────────────────
//
// Bottom-sheet (mobile) / centered popover (desktop) for assigning a model
// to the open agent. Default is always pinned at the top. Search filters by
// name + model_id + endpoint host. "+ Add new model" delegates to the
// existing model-detail create flow with a flag set so we auto-assign on
// success.

let pickerAddInProgress = false;
let pickerAgentForAdd = null;

function openModelPicker() {
  const picker = $('#model-picker');
  picker.hidden = false;
  // Force reflow so the open-state transition runs from the initial state.
  void picker.offsetHeight;
  picker.classList.add('open');
  $('#model-picker-search').value = '';
  renderPickerList('');
  // Autofocus the search on desktop only — mobile autofocus pops the
  // soft keyboard immediately, which is jarring when you're scanning a list.
  if (window.matchMedia('(min-width: 720px)').matches) {
    setTimeout(() => $('#model-picker-search').focus(), 60);
  }
}

function closeModelPicker() {
  const picker = $('#model-picker');
  picker.classList.remove('open');
  // Wait for the slide-out animation before hiding so the close is animated.
  setTimeout(() => {
    picker.hidden = true;
  }, 220);
}

function renderPickerList(filterText) {
  const list = $('#model-picker-list');
  list.innerHTML = '';
  const q = (filterText || '').trim().toLowerCase();
  const currentSelected = $('#agent-model').value || '';

  // Default row — always pinned at the top, even when there's a search query.
  // We never filter it out (the user might be searching to confirm "yeah, no
  // model here matches what I want, fall back to default").
  const defaultRow = createPickerRow(
    {
      id: '',
      isDefault: true,
      name: 'Default',
      sub: 'Built-in Anthropic',
    },
    currentSelected,
  );
  list.appendChild(defaultRow);

  const matches = allModels.filter((m) => {
    if (!q) return true;
    const host = endpointHost(m.endpoint).toLowerCase();
    return [m.name, m.model_id, host, m.kind].some((s) => (s || '').toLowerCase().includes(q));
  });

  if (matches.length === 0 && allModels.length > 0 && q) {
    const empty = document.createElement('li');
    empty.className = 'model-picker-empty';
    empty.textContent = `No models match "${filterText}".`;
    list.appendChild(empty);
  } else if (allModels.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'model-picker-empty';
    empty.textContent = 'No models registered yet. Use "+ Add new model" below.';
    list.appendChild(empty);
  }

  for (const m of matches) {
    list.appendChild(createPickerRow(m, currentSelected));
  }
}

function createPickerRow(m, currentSelected) {
  const li = document.createElement('li');
  li.className = 'model-picker-row';
  li.tabIndex = 0;
  if (m.isDefault) li.classList.add('is-default');
  li.dataset.modelId = m.id || '';
  if ((m.id || '') === currentSelected) li.classList.add('selected');

  const top = document.createElement('div');
  top.className = 'model-picker-row-top';
  const name = document.createElement('span');
  name.className = 'model-picker-row-name';
  name.textContent = m.name;
  top.appendChild(name);
  const badge = document.createElement('span');
  if (m.isDefault) {
    badge.className = 'model-kind-badge model-default-badge';
    badge.textContent = 'default';
  } else {
    badge.className = `model-kind-badge kind-${m.kind}`;
    badge.textContent = m.kind;
  }
  top.appendChild(badge);
  li.appendChild(top);

  const sub = document.createElement('div');
  sub.className = 'model-picker-row-sub';
  if (m.isDefault) {
    sub.textContent = m.sub || 'Built-in Anthropic';
  } else {
    const host = endpointHost(m.endpoint);
    sub.textContent = host ? `${m.model_id} · ${host}` : m.model_id;
  }
  li.appendChild(sub);

  const onPick = () => selectFromPicker(m.id || '');
  li.addEventListener('click', onPick);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onPick();
    }
  });
  return li;
}

function selectFromPicker(modelId) {
  $('#agent-model').value = modelId;
  refreshAgentModelTrigger();
  closeModelPicker();
  // Note: we don't auto-persist on select. Existing flow waits for the
  // agent-detail Save button, matching the pre-picker behavior.
}

// Trigger button → open picker. Only meaningful when an agent is open.
$('#agent-model-trigger').addEventListener('click', () => {
  if (selectedAgentId) openModelPicker();
});

// Picker close paths.
$('#model-picker-close').addEventListener('click', closeModelPicker);
$('#model-picker .model-picker-backdrop').addEventListener('click', closeModelPicker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#model-picker').hidden) closeModelPicker();
});

// Live filter.
$('#model-picker-search').addEventListener('input', (e) => {
  renderPickerList(e.target.value);
});

// "+ Add new model" → close picker, set the auto-assign flag, then trigger
// the existing model-create flow. After a successful create we auto-assign
// the new model id to the agent and return them to the agent detail.
$('#model-picker-add-new').addEventListener('click', () => {
  if (!selectedAgentId) return;
  pickerAddInProgress = true;
  pickerAgentForAdd = selectedAgentId;
  closeModelPicker();
  // Existing path: opens model-detail aside in create mode.
  setTimeout(() => $('#create-model-btn').click(), 180);
});

/**
 * Called from both the manual create and the probe bulk-add success paths.
 * If the picker initiated this add, assign the newly-created model to the
 * agent and return the user to the agent detail. Bulk-add of >1 doesn't
 * auto-assign — we leave the user on the agent detail and they can re-open
 * the picker to choose explicitly.
 */
async function maybeAssignAfterPickerAdd(createdIds) {
  if (!pickerAddInProgress) return false;
  const agentId = pickerAgentForAdd;
  pickerAddInProgress = false;
  pickerAgentForAdd = null;
  if (!agentId) return false;
  // Persist the assignment server-side (the same endpoint the agent Save
  // handler hits). Then refresh the agent detail so the trigger shows the
  // new model.
  if (createdIds.length === 1) {
    try {
      await authFetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: createdIds[0] }),
      });
    } catch (err) {
      console.error('Auto-assign new model failed:', err);
    }
  }
  // Re-fetch agents so the in-memory list has the new assignment.
  await fetchAgents();
  // Reopen the agent detail so the user lands back where they started.
  if (typeof openAgentDetail === 'function') {
    await openAgentDetail(agentId);
  }
  return true;
}

initApp();
