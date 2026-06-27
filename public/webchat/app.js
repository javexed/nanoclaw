import { marked } from '/marked.min.js';
import DOMPurify from '/dompurify.min.js';

marked.setOptions({ breaks: true, gfm: true });

const $ = (sel) => document.querySelector(sel);

// Inline Lucide icon referencing the SVG sprite in index.html. Returns an HTML
// string (safe — no user data); styling/color come from the .icon CSS class.
function lucide(name, cls = '') {
  return `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}
// Same icon as a detached DOM node, for inserting NEXT TO user-controlled text
// without resorting to innerHTML (keeps the surrounding text XSS-safe).
function lucideEl(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = lucide(name, cls);
  return t.content.firstChild;
}

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
    // Cache the server's auth mode so the connection-lost banner can suggest
    // Tailscale later, even if the network drops (authed users skip the login
    // screen where applyLoginHint would otherwise cache it).
    void cacheAuthHint();
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
    // Tailor the login subtitle to whichever auth methods the server has
    // configured. Best-effort: if the endpoint isn't there or the fetch
    // fails, the static "enter your token" subtitle stands.
    void applyLoginHint();
  }
}

// Whether this server uses Tailscale auth. Cached from /api/auth/info and
// persisted to localStorage so the connection-lost banner can suggest starting
// Tailscale even when the device is currently offline (cold start, no network).
let serverUsesTailscale = (() => {
  try {
    return localStorage.getItem('webchat-server-tailscale') === '1';
  } catch {
    return false;
  }
})();

function rememberServerAuthHint(methods) {
  if (!methods) return;
  serverUsesTailscale = !!methods.tailscale;
  try {
    localStorage.setItem('webchat-server-tailscale', serverUsesTailscale ? '1' : '0');
  } catch {}
}

// Best-effort: cache the server's auth mode even for already-authenticated
// users who never see the login screen (so applyLoginHint never runs for them).
async function cacheAuthHint() {
  try {
    const r = await fetch('/api/auth/info');
    if (r.ok) rememberServerAuthHint((await r.json()).methods);
  } catch {}
}

/**
 * Fetch `/api/auth/info` and rewrite the login subtitle so the user knows
 * what's expected (Tailscale on this device vs token entry vs server
 * misconfig) instead of facing a generic token prompt.
 *
 * The common failure mode is the client device (this phone / laptop) not
 * having Tailscale running — the server's almost always fine because the
 * operator had to install Tailscale to set up this server in the first
 * place. The copy reflects that.
 */
async function applyLoginHint() {
  let info;
  try {
    const r = await fetch('/api/auth/info');
    if (!r.ok) return;
    info = await r.json();
  } catch {
    return;
  }
  const subtitle = $('.login-subtitle');
  const m = info.methods || {};
  rememberServerAuthHint(m);

  // Hide the token entry path when the server has no bearer method
  // configured — a tailscale-only or proxy-only deployment shouldn't show
  // a token field that can never work.
  if (!m.bearer) {
    $('#login-form').hidden = true;
  }

  if (m.tailscale && info.tailscaleHealthy) {
    // The common case: tailscale is set up on the server; the user just
    // needs Tailscale running on the device they're reading this on.
    subtitle.innerHTML =
      'Tailscale should sign you in automatically. ' +
      'Make sure Tailscale is installed and running on this device (phone, laptop, etc.) and connected to the right tailnet, then refresh this page.' +
      (m.bearer ? '<br><br>Or enter a bearer token below.' : '');
  } else if (m.tailscale && !info.tailscaleHealthy) {
    // The rare case: server-side Tailscale is actually down.
    subtitle.innerHTML =
      "Tailscale sign-in isn't working on this server right now. " +
      'Whoever set this up will need to take a look.' +
      (m.bearer ? '<br><br>If you have an access token, you can use it below.' : '');
  } else if (m.proxy && !m.bearer) {
    subtitle.innerHTML =
      "Couldn't sign you in — your reverse proxy didn't pass an identity through. " +
      'Try refreshing, or ask whoever sent you the link.';
  } else if (m.bearer) {
    subtitle.textContent = 'Enter the access token you were given below.';
  } else {
    subtitle.textContent = "This server isn't ready to sign anyone in yet. Whoever installed it needs to finish setup.";
    $('#login-form').hidden = true;
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

// ── Workspace credentials policy (Settings → Member credentials, owner-only) ──
let credConfigWired = false;
async function renderCredentialsSettings() {
  const section = $('#settings-credentials');
  if (!section) return;
  let cfg;
  try {
    const r = await authFetch('/api/webchat/credentials-config');
    if (!r.ok) {
      section.hidden = true;
      return;
    }
    cfg = await r.json();
  } catch {
    section.hidden = true;
    return;
  }
  if (!cfg.canEdit) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  document.querySelectorAll('#cred-default-mode .setting-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === cfg.defaultMode);
  });
  const setChecked = (id, v) => {
    const el = $(id);
    if (el) el.checked = !!v;
  };
  setChecked('#cred-allow-anthropic-key', cfg.allowAnthropicKey);
  setChecked('#cred-allow-claude-oauth', cfg.allowClaudeOauth);
  setChecked('#cred-allow-openai-key', cfg.allowOpenaiKey);
  setChecked('#cred-allow-codex-oauth', cfg.allowCodexOauth);
  // Codex types are inert until the provider is installed — grey + disable them.
  const codexGroup = $('#cred-codex-group');
  if (codexGroup) codexGroup.classList.toggle('is-disabled', !cfg.codexAvailable);
  const codexHint = $('#cred-codex-hint');
  if (codexHint) codexHint.hidden = !!cfg.codexAvailable;
  ['#cred-allow-openai-key', '#cred-allow-codex-oauth'].forEach((s) => {
    const el = $(s);
    if (el) el.disabled = !cfg.codexAvailable;
  });

  if (credConfigWired) return;
  credConfigWired = true;
  const putConfig = async (patch) => {
    const r = await authFetch('/api/webchat/credentials-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Failed to save: ' + (err.error || r.statusText), { kind: 'error' });
      renderCredentialsSettings(); // resync to server truth
      return false;
    }
    return true;
  };
  document.querySelectorAll('#cred-default-mode .setting-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (await putConfig({ defaultMode: btn.dataset.value })) {
        document
          .querySelectorAll('#cred-default-mode .setting-option')
          .forEach((b) => b.classList.toggle('active', b === btn));
      }
    });
  });
  const wireCheck = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', async () => {
      if (!(await putConfig({ [key]: el.checked }))) el.checked = !el.checked;
    });
  };
  wireCheck('#cred-allow-anthropic-key', 'allowAnthropicKey');
  wireCheck('#cred-allow-claude-oauth', 'allowClaudeOauth');
  wireCheck('#cred-allow-openai-key', 'allowOpenaiKey');
  wireCheck('#cred-allow-codex-oauth', 'allowCodexOauth');
}

// Persist the @handle from the Settings field. Inline feedback (per DESIGN.md):
// success/taken/invalid all surface on the #handle-status line, not a toast.
async function saveHandle() {
  const input = $('#handle-input');
  const status = $('#handle-status');
  if (!input || !status) return;
  const next = input.value.trim().toLowerCase().replace(/^@/, '');
  const showStatus = (text, ok) => {
    status.hidden = false;
    status.textContent = text;
    status.classList.toggle('ok', !!ok);
    status.classList.toggle('err', !ok);
  };
  if (!/^[a-z0-9-]{1,32}$/.test(next)) {
    showStatus('Use 1–32 letters, numbers, or hyphens.', false);
    return;
  }
  if (next === myHandle) {
    showStatus('That’s already your handle.', true);
    return;
  }
  try {
    const res = await authFetch('/api/me/handle', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ handle: next }),
    });
    if (res.ok) {
      myHandle = (((await res.json()).handle || next) + '').toLowerCase();
      input.value = myHandle;
      renderHandleChip();
      // Keep the popover open briefly showing the inline "Saved." status,
      // consistent with the prior in-Settings behavior.
      showStatus('Saved.', true);
    } else if (res.status === 409) {
      showStatus('That handle is taken.', false);
    } else if (res.status === 400) {
      showStatus('Use 1–32 letters, numbers, or hyphens.', false);
    } else {
      showStatus('Couldn’t save — try again.', false);
    }
  } catch {
    showStatus('Couldn’t save — try again.', false);
  }
}

// ── Header @handle chip + popover ────────────────────────────────────────────
// The chip lives top-right in the header; clicking it opens a focused popover to
// edit + save the handle. The editor (same #handle-input/#handle-save/
// #handle-status ids) lives here, not in Settings. Inline status only.
function renderHandleChip() {
  const chip = $('#handle-chip');
  if (!chip) return;
  chip.textContent = myHandle ? `@${myHandle}` : '+ set @handle';
  chip.classList.toggle('is-unset', !myHandle);
}

function openHandlePopover() {
  const pop = $('#handle-popover');
  const input = $('#handle-input');
  const status = $('#handle-status');
  if (!pop) return;
  if (input) input.value = myHandle || '';
  if (status) {
    status.hidden = true;
    status.textContent = '';
    status.classList.remove('ok', 'err');
  }
  pop.hidden = false;
  $('#handle-chip')?.setAttribute('aria-expanded', 'true');
  if (input) input.focus();
}

function closeHandlePopover() {
  const pop = $('#handle-popover');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  $('#handle-chip')?.setAttribute('aria-expanded', 'false');
}

$('#handle-chip')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#handle-popover');
  if (pop && pop.hidden) openHandlePopover();
  else closeHandlePopover();
});
$('#handle-popover-close')?.addEventListener('click', closeHandlePopover);
// Click outside the popover (and not on the chip) closes it.
document.addEventListener('click', (e) => {
  const pop = $('#handle-popover');
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target) || e.target === $('#handle-chip')) return;
  closeHandlePopover();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeHandlePopover();
});

// Apply on load
applySettings();

// Settings modal open/close
function openSettings() {
  renderSettingsModal();
  renderCredentialsSettings();
  $('#settings-overlay').hidden = false;
  // Focus trap
  const modal = $('#settings-overlay .modal');
  const focusable = modal.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])');
  if (focusable.length) focusable[0].focus();
}
function closeSettings() {
  $('#settings-overlay').hidden = true;
}

// ── Sidebar overflow menu (Dashboard / Permissions / Settings) ──────────────
// Replaces the three unlabeled glyph buttons with one self-labeling menu, so
// the occasional surfaces are discoverable (no more cryptic ▦/key/⚙ icons).
function closeOverflowMenu() {
  const menu = $('#overflow-menu');
  if (!menu) return;
  menu.hidden = true;
  $('#overflow-btn')?.setAttribute('aria-expanded', 'false');
}
$('#overflow-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#overflow-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  $('#overflow-btn').setAttribute('aria-expanded', String(open));
});
$('#overflow-menu')?.addEventListener('click', (e) => {
  const item = e.target.closest('.overflow-item');
  if (!item) return;
  closeOverflowMenu();
  const action = item.dataset.action;
  if (action === 'agents') openManage('agents');
  else if (action === 'models') openManage('models');
  else if (action === 'topology') toggleTopology();
  else if (action === 'matrix') toggleMatrix();
  else if (action === 'dashboard') toggleDashboard();
  else if (action === 'permissions') togglePermissions();
  else if (action === 'settings') openSettings();
});
document.addEventListener('click', (e) => {
  const menu = $('#overflow-menu');
  if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== $('#overflow-btn')) closeOverflowMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverflowMenu();
});
$('#settings-close').addEventListener('click', closeSettings);
$('#settings-overlay').addEventListener('click', (e) => {
  if (e.target === $('#settings-overlay')) closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#settings-overlay').hidden) closeSettings();
});

// Image lightbox — opened from file-bubble image clicks. Closes via ×, backdrop tap,
// ESC, or device back gesture. pushState lets the OS back gesture / Android back
// button dismiss the viewer instead of leaving the app (the common mobile pain).
//
// Features: prev/next nav over all images in the current room, pinch-zoom +
// drag-to-pan on touch, native browser zoom on desktop, loading spinner for
// slow images, explicit download button, fade-out on close, body-scroll lock.
let lightboxOpen = false;
let lightboxImages = []; // [{ url, alt }] snapshot taken on open
let lightboxIndex = 0;
let prevBodyOverflow = '';
let lightboxCloseTimer = null;

// Transform state for pinch-zoom + pan.
const lightboxXf = { scale: 1, x: 0, y: 0 };
const lightboxGesture = {
  startScale: 1,
  startDist: 0,
  startX: 0,
  startY: 0,
  startTouchX: 0,
  startTouchY: 0,
  mode: null, // 'pinch' | 'pan' | null
};

function applyLightboxTransform() {
  const img = $('#lightbox-img');
  img.style.transform = `translate(${lightboxXf.x}px, ${lightboxXf.y}px) scale(${lightboxXf.scale})`;
}
function resetLightboxTransform() {
  lightboxXf.scale = 1;
  lightboxXf.x = 0;
  lightboxXf.y = 0;
  applyLightboxTransform();
}
function snapshotRoomImages() {
  // Snapshot all currently-rendered file-image-previews in DOM (top-to-bottom)
  // order so prev/next walks the room's image attachments.
  const imgs = document.querySelectorAll('#messages .file-image-preview');
  return Array.from(imgs).map((el) => ({ url: el.src, alt: el.alt || '' }));
}
function setLightboxImage(idx) {
  if (idx < 0 || idx >= lightboxImages.length) return;
  lightboxIndex = idx;
  const { url, alt } = lightboxImages[idx];
  const img = $('#lightbox-img');
  const spinner = $('#lightbox-spinner');
  resetLightboxTransform();
  spinner.hidden = false;
  img.style.visibility = 'hidden';
  // Assign via property (not addEventListener) so each new load cleanly
  // replaces the previous handler — rapid next/next doesn't stack callbacks.
  img.onload = img.onerror = () => {
    spinner.hidden = true;
    img.style.visibility = '';
  };
  img.src = url;
  img.alt = alt;
  // Download href tracks the current image. Filename derived from URL tail.
  const dl = $('#lightbox-download');
  dl.href = url;
  try {
    const tail = new URL(url, location.href).pathname.split('/').pop();
    if (tail) dl.setAttribute('download', tail);
  } catch {
    dl.setAttribute('download', '');
  }
  // Toggle prev/next visibility
  $('#lightbox-prev').hidden = idx <= 0;
  $('#lightbox-next').hidden = idx >= lightboxImages.length - 1;
}
function openLightbox(url, alt) {
  // If a previous close is still mid-fade, cancel its pending hide so we
  // don't slam the freshly-opened lightbox closed 150ms from now.
  if (lightboxCloseTimer) {
    clearTimeout(lightboxCloseTimer);
    lightboxCloseTimer = null;
  }
  lightboxImages = snapshotRoomImages();
  // Find which image was clicked. Match by URL; fall back to a 1-entry list.
  let idx = lightboxImages.findIndex((it) => it.url === url);
  if (idx === -1) {
    lightboxImages = [{ url, alt: alt || '' }];
    idx = 0;
  }
  const overlay = $('#lightbox');
  overlay.classList.remove('closing');
  overlay.hidden = false;
  lightboxOpen = true;
  prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  setLightboxImage(idx);
  history.pushState({ lightbox: true }, '');
  // Defer focus so the dialog is on-screen before focus moves
  requestAnimationFrame(() => $('#lightbox-close').focus());
}
function closeLightbox(fromPopstate = false) {
  if (!lightboxOpen) return;
  const overlay = $('#lightbox');
  lightboxOpen = false;
  overlay.classList.add('closing');
  document.body.style.overflow = prevBodyOverflow;
  lightboxCloseTimer = setTimeout(() => {
    lightboxCloseTimer = null;
    overlay.hidden = true;
    overlay.classList.remove('closing');
    $('#lightbox-img').src = '';
    $('#lightbox-img').style.transform = '';
    $('#lightbox-img').style.visibility = '';
  }, 150);
  if (!fromPopstate && history.state && history.state.lightbox) {
    history.back();
  }
}
function navigateLightbox(delta) {
  const next = lightboxIndex + delta;
  if (next < 0 || next >= lightboxImages.length) return;
  setLightboxImage(next);
}

$('#lightbox-close').addEventListener('click', () => closeLightbox());
$('#lightbox-prev').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateLightbox(-1);
});
$('#lightbox-next').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateLightbox(1);
});
$('#lightbox-download').addEventListener('click', (e) => e.stopPropagation());
$('#lightbox').addEventListener('click', (e) => {
  // Backdrop tap closes; tapping the image, toolbar, nav, or spinner does not.
  if (e.target === $('#lightbox')) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (!lightboxOpen) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') navigateLightbox(-1);
  else if (e.key === 'ArrowRight') navigateLightbox(1);
});
// ── View router ────────────────────────────────────────────────────────────
// Overlay surfaces (dashboard, permissions, …) stacked above the base
// rooms/chat view. Opening a surface pushes a history entry so the OS/browser
// back gesture closes it instead of exiting the PWA; the popstate handler below
// unwinds the stack. Programmatic closes (X buttons, in-app back) go through
// closeView() so the stack and history stay in sync.
const viewStack = []; // [{ name, teardown }]
function openView(name, teardown) {
  viewStack.push({ name, teardown });
  history.pushState({ viewDepth: viewStack.length }, '');
}
function closeView(name) {
  const idx = viewStack.map((v) => v.name).lastIndexOf(name);
  if (idx === -1) return;
  history.go(-(viewStack.length - idx)); // drives popstate, which runs teardown
}
window.addEventListener('popstate', (e) => {
  // The lightbox manages its own history entry — handle it first.
  if (lightboxOpen) {
    closeLightbox(true);
    return;
  }
  // Unwind overlay surfaces down to the depth the restored history state implies.
  const targetDepth = (e.state && e.state.viewDepth) || 0;
  while (viewStack.length > targetDepth) {
    const top = viewStack.pop();
    try {
      top.teardown();
    } catch (err) {
      console.error('view teardown failed', err);
    }
  }
});

// Pinch-zoom + drag-to-pan on the image. Native pinch-zoom on a fixed-position
// overlay doesn't work reliably on iOS Safari, so we handle touches ourselves.
function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}
const lightboxImg = $('#lightbox-img');
lightboxImg.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      lightboxGesture.mode = 'pinch';
      lightboxGesture.startScale = lightboxXf.scale;
      lightboxGesture.startDist = getTouchDist(e.touches);
      lightboxGesture.startX = lightboxXf.x;
      lightboxGesture.startY = lightboxXf.y;
      lightboxImg.classList.add('dragging');
    } else if (e.touches.length === 1 && lightboxXf.scale > 1) {
      e.preventDefault();
      lightboxGesture.mode = 'pan';
      lightboxGesture.startTouchX = e.touches[0].clientX;
      lightboxGesture.startTouchY = e.touches[0].clientY;
      lightboxGesture.startX = lightboxXf.x;
      lightboxGesture.startY = lightboxXf.y;
      lightboxImg.classList.add('dragging');
    }
  },
  { passive: false },
);
lightboxImg.addEventListener(
  'touchmove',
  (e) => {
    if (lightboxGesture.mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault();
      const dist = getTouchDist(e.touches);
      const ratio = dist / lightboxGesture.startDist;
      lightboxXf.scale = Math.max(0.5, Math.min(4, lightboxGesture.startScale * ratio));
      applyLightboxTransform();
    } else if (lightboxGesture.mode === 'pan' && e.touches.length === 1) {
      e.preventDefault();
      lightboxXf.x = lightboxGesture.startX + (e.touches[0].clientX - lightboxGesture.startTouchX);
      lightboxXf.y = lightboxGesture.startY + (e.touches[0].clientY - lightboxGesture.startTouchY);
      applyLightboxTransform();
    }
  },
  { passive: false },
);
lightboxImg.addEventListener('touchend', () => {
  lightboxGesture.mode = null;
  lightboxImg.classList.remove('dragging');
  // Snap back to 1x and centered if user zoomed out below ~identity.
  if (lightboxXf.scale < 1.05) resetLightboxTransform();
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
        showToast('Notifications need browser permission to turn on', { kind: 'info' });
        return;
      }
    }
    await enableWebPush({ interactive: true });
  } else {
    await disableWebPush();
  }
  settings.notifications = $('#notif-toggle').checked;
  saveSettings(settings);
});

// @handle save — button click and Enter-in-field both commit.
$('#handle-save')?.addEventListener('click', saveHandle);
$('#handle-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveHandle();
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

// Push setup is operational, not conversational — it must NOT write to the chat
// transcript (see DESIGN.md §4). Step-by-step progress goes to the console;
// only outcomes surface, and only for an explicit user action (the Settings
// toggle, interactive=true) via toast. The silent auto-resubscribe on reload
// stays quiet on success and logs failures to the console.
async function enableWebPush({ interactive = false } = {}) {
  const fail = (msg, err) => {
    console.warn('[push]', msg, err ?? '');
    if (interactive) showToast(msg, { kind: 'error' });
  };
  try {
    if (!('serviceWorker' in navigator)) return fail('Notifications aren’t supported in this browser');
    if (!('PushManager' in window)) {
      console.warn('[push] PushManager unavailable');
      if (interactive) {
        showToast('To enable notifications on iOS, add this app to your home screen and open it from there', {
          kind: 'info',
          timeout: 6000,
        });
      }
      return;
    }
    console.log('[push] fetching VAPID key');
    const keyRes = await authFetch('/api/push/vapid-public');
    if (!keyRes.ok) return fail('Couldn’t enable notifications — the server has no push key');
    const { key } = await keyRes.json();
    if (!key) return fail('Couldn’t enable notifications — the server has no push key');

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      console.log('[push] subscribing');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    } else {
      console.log('[push] reusing existing subscription');
    }

    const res = await authFetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) return fail('Couldn’t save your notification subscription');
    console.log('[push] subscribed', sub.endpoint.slice(-24));
    if (interactive) showToast('Notifications enabled', { kind: 'success' });
  } catch (err) {
    fail('Couldn’t enable notifications', err);
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
  myIdentity = '',
  myHandle = '';
const pendingMessages = new Map();
const typingUsers = new Map();
const unreadRooms = new Set();
const mentionedRooms = new Set(); // rooms with an unread @-mention of me (distinct badge)
let roomMentionPeople = []; // current room's human members as @ autocomplete candidates
let showArchived = sessionStorage.getItem('webchat:showArchived') === '1';
let showHidden = sessionStorage.getItem('webchat:showHidden') === '1';
let agentName = '';
let lastSeenMessageId = sessionStorage.getItem('lastSeenMessageId') || null;
let reconnectDelay = 1000;

function setLastSeenMessageId(id) {
  lastSeenMessageId = id;
  if (id) sessionStorage.setItem('lastSeenMessageId', id);
}

// Load my @-mention handle (server-stored, settable in Settings). Used to
// highlight + notify when a message @-mentions me. Best-effort.
async function fetchMyHandle() {
  try {
    const r = await authFetch('/api/me/handle');
    if (r.ok) myHandle = ((await r.json()).handle || '').toLowerCase();
  } catch {
    /* non-fatal — mentions just won't self-highlight until next load */
  }
  // Reflect the loaded handle in the header chip.
  renderHandleChip();
}

// True when `text` contains an @-mention of the current user's handle. Mirrors
// the token boundary used by decorateMentions so highlight + notify agree.
function messageMentionsMe(text) {
  if (!myHandle || typeof text !== 'string') return false;
  const re = new RegExp('(?:^|[^a-z0-9_-])@' + myHandle + '(?![a-z0-9-])', 'i');
  return re.test(text);
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
        // Seed persistent unread badges from the server's per-user read markers
        // so messages that arrived while away surface on reconnect — not just
        // live ones. Never dot the open room (the join that follows reads it).
        msg.rooms.forEach((r) => {
          if (r.unread && r.id !== currentRoom) unreadRooms.add(r.id);
          if (r.mention && r.id !== currentRoom) mentionedRooms.add(r.id);
          else if (!r.mention) mentionedRooms.delete(r.id);
          else unreadRooms.delete(r.id);
        });
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
        // (Re)load my @-mention handle so self-highlight/notify work this session.
        fetchMyHandle();
        // Reveal the Permissions header button if the caller is owner.
        // Idempotent: probe runs every reconnect, but the button only
        // toggles visible.
        probeIsOwner();
        // Wirings or prime designations may have changed — refresh the
        // mention-autocomplete caches for the active room.
        refreshWiredAgentsForCurrentRoom();
        fetchMentionablePeople();
        if (currentRoom) {
          // Rejoin after reconnect — catch up on missed messages
          ws.send(JSON.stringify({ type: 'join', room_id: currentRoom }));
          if (lastSeenMessageId) {
            authFetch(`/api/rooms/${currentRoom}/messages?after_id=${lastSeenMessageId}`)
              .then((r) => r.json())
              .then((missed) => {
                if (missed.length > 0) {
                  // Capture before append: if the user was scrolled up reading
                  // history when the WS dropped, don't yank them down on reconnect.
                  const wasNearBottom = isNearBottom();
                  missed.forEach((m) => appendMessage(m));
                  setLastSeenMessageId(missed[missed.length - 1].id);
                  if (wasNearBottom) scrollToBottom();
                  else updateScrollButton();
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
      case 'history': {
        $('#messages').innerHTML = '';
        msg.messages.forEach((m) => appendMessage(m));
        // Reset scroll-back pagination for the freshly loaded room. The oldest
        // rendered id anchors the first ?before_id= fetch; a window shorter than
        // the server's initial page (50) means there's nothing older to load.
        oldestMessageId = msg.messages.length ? msg.messages[0].id : null;
        noMoreOlder = msg.messages.length < 50;
        loadingOlder = false;
        if (msg.messages.length === 0) {
          $('#messages').innerHTML = '<div class="empty-state">No messages yet. Start the conversation!</div>';
        }
        if (msg.messages.length > 0) {
          setLastSeenMessageId(msg.messages[msg.messages.length - 1].id);
        }
        const jumpTo = pendingJumpMessageId;
        pendingJumpMessageId = null;
        if (jumpTo) {
          // Arrived from a search result — center + flash that message instead of
          // scrolling to the bottom (paging older history in if it's not loaded).
          void jumpToMessage(jumpTo);
        } else {
          scrollToBottom(true);
          requestAnimationFrame(() => scrollToBottom(true));
          // Extra scrolls for mobile layout settle
          setTimeout(() => scrollToBottom(true), 100);
          setTimeout(() => scrollToBottom(true), 300);
        }
        break;
      }
      case 'members':
        if (msg.room_id === currentRoom) {
          renderMembers(msg.members);
          // Membership may have changed (someone gained/lost access) — refresh
          // the @-mention candidate pool. (The pool itself comes from the
          // server, not this connected-members list — see fetchMentionablePeople.)
          fetchMentionablePeople();
        }
        break;
      case 'message': {
        // Bump the room's activity so it floats up in the Recent-sorted sidebar
        // without waiting for a server rooms refresh.
        if (msg.room_id && msg.created_at) {
          roomActivity.set(msg.room_id, Math.max(roomActivity.get(msg.room_id) || 0, msg.created_at));
          if (lastRoomsList.length) renderRooms(lastRoomsList);
        }
        // Snapshot the scroll position BEFORE appending. If we check after,
        // the newly-inserted message has already pushed the bottom past our
        // 80px threshold and `isNearBottom()` lies about the user's intent.
        // That's why long agent replies sometimes silently failed to scroll.
        const wasNearBottom = isNearBottom();
        // Desktop notification for messages from others when tab is not focused
        if (
          settings.notifications &&
          document.hidden &&
          msg.sender !== myIdentity &&
          msg.message_type !== 'a2a' &&
          msg.sender_type !== 'a2a'
        ) {
          try {
            const mentioned = messageMentionsMe(msg.content);
            new Notification(mentioned ? `${msg.sender} mentioned you` : `${msg.sender}`, {
              body: msg.content.slice(0, 100),
              tag: msg.id || 'nanoclaw-msg',
              requireInteraction: mentioned,
            });
          } catch {}
        }
        let appendedEl = null;
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
          appendedEl = appendMessage(msg);
        }
        if (msg.id && msg.room_id === currentRoom) {
          setLastSeenMessageId(msg.id);
          // Reading in the open, focused room: advance the server marker so the
          // badge stays cleared across this user's other devices too. Skip when
          // backgrounded — a hidden tab hasn't actually been seen.
          if (!document.hidden && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'read', room_id: currentRoom }));
          }
        }
        const shouldScroll = wasNearBottom || (forceScrollCount > 0 && !userScrolledAway);
        if (shouldScroll) {
          scrollToBottom();
          // Follow late-rendering content. Markdown + DOMPurify run sync, but
          // image loads / code-block toolbars / reflow can grow the message
          // after the initial scroll. Re-scroll at rAF + 200ms so the bottom
          // tracks the final height instead of stopping mid-message.
          requestAnimationFrame(() => {
            if (!userScrolledAway) scrollToBottom();
          });
          setTimeout(() => {
            if (!userScrolledAway) scrollToBottom();
          }, 200);
          // Catch images that load after the 200ms re-scroll window expires
          // (slow network, large attachments). Multiple images loading in
          // quick succession coalesce into a single rAF re-scroll so we don't
          // spam scrollTo calls if a message has many images.
          if (appendedEl) {
            appendedEl.querySelectorAll('img').forEach((img) => {
              if (img.complete) return;
              img.addEventListener('load', scheduleFollowScroll, { once: true });
            });
          }
          if (forceScrollCount > 0) forceScrollCount--;
        } else {
          incrementMissedMessages();
        }
        break;
      }
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
      case 'mention':
        // Server says an @-mention of me landed in a room I'm not viewing.
        // Distinct, higher-signal badge than plain unread.
        if (msg.room_id && msg.room_id !== currentRoom) {
          mentionedRooms.add(msg.room_id);
          unreadRooms.add(msg.room_id);
          updateUnreadDots();
        }
        break;
      case 'read_cleared': {
        // Another of this user's devices read the room — drop the stale badges.
        const cleared = (msg.room_id && unreadRooms.delete(msg.room_id)) | 0;
        const clearedMention = (msg.room_id && mentionedRooms.delete(msg.room_id)) | 0;
        if (cleared || clearedMention) updateUnreadDots();
        break;
      }
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
      case 'approval_resolved':
        handleApprovalResolvedEvent(msg);
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
    const banner = $('#connection-banner');
    banner.textContent = serverUsesTailscale
      ? 'Connection lost. Reconnecting… If it doesn’t recover, make sure Tailscale is running on this device and connected to the right tailnet.'
      : 'Connection lost. Reconnecting…';
    banner.classList.add('visible');
    myIdentity = '';
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };
}

// iOS/mobile: when the app returns from background, the WebSocket may be
// silently dead without onclose firing. Force a full reconnect on resume.
// Also: even when the socket is alive, browsers can throttle a backgrounded
// tab so that WS-pushed approvals never get rendered. On foreground, refetch
// the canonical pending-approvals list so anything that arrived while we
// were hidden surfaces immediately. (If we have to reconnect, fetchApprovals
// also runs from the system message handler — so this branch is the
// "WS still up but we may have missed an event" case.)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (ws && ws.readyState !== WebSocket.OPEN) {
    connect();
  } else {
    fetchApprovals();
    // Returning to a focused tab with a room open means its messages are now
    // seen — advance the server marker (and sync other devices). The reconnect
    // path already re-joins (which reads) when the socket was actually down.
    if (currentRoom) ws.send(JSON.stringify({ type: 'read', room_id: currentRoom }));
  }
});

// Safety-net poll for approvals. WS push + the reconnect/visibilitychange
// refetches above cover the common cases, but a *foreground* socket can go
// silently dead (zombie/throttled connection) and drop an `approval` push with
// no onclose, no reconnect, and no visibility change to trigger a catch-up — so
// the card would hang until the next unrelated push or a manual refocus. Poll
// the canonical pending list on a short interval while the tab is visible so a
// missed approval still surfaces within seconds. Cheap + idempotent
// (fetchApprovals just re-renders the scoped list); skipped while hidden since
// the visibilitychange handler already refetches on return to foreground.
const APPROVAL_POLL_MS = 10000;
setInterval(() => {
  if (document.visibilityState === 'visible') fetchApprovals();
}, APPROVAL_POLL_MS);

// ── Rooms ─────────────────────────────────────────────────────────────────
// ── Room ordering ─────────────────────────────────────────────────────────
// Live last-activity overrides keyed by room id. The rooms payload carries a
// server-computed `last_activity`; as messages arrive while the app is open we
// bump this map so the active room floats to the top without a server round-trip.
const roomActivity = new Map();
function activityOf(room) {
  return Math.max(room.last_activity || room.created_at || 0, roomActivity.get(room.id) || 0);
}

// Sentinel rendered as a horizontal rule between the pinned group and the rest.
const ROOM_DIVIDER = Symbol('room-divider');

function renderRooms(rooms) {
  const list = $('#room-list');
  list.innerHTML = '';

  // Recent-first: newest activity (last message) at the top. Pinned rooms are
  // lifted into a sticky group above a divider; the rest follow in activity
  // order. (Replaces the old manual drag-order, which lived only in this
  // browser's localStorage and never synced across devices.)
  const byActivity = (a, b) => activityOf(b) - activityOf(a);

  // Partition:
  //   - hidden (per-user "hide") — dropped unless `showHidden` is on.
  //   - archived (global flag) — collected in a collapsed "Archived" section at
  //     the bottom, revealed by the toggle.
  //   - active — split into pinned (top) and unpinned, each activity-sorted.
  const visibleRooms = showHidden ? [...rooms] : rooms.filter((r) => !r.hidden);
  const active = visibleRooms.filter((r) => !r.archived);
  const archived = visibleRooms.filter((r) => r.archived).sort(byActivity);
  const pinned = active.filter((r) => r.pinned).sort(byActivity);
  const unpinned = active.filter((r) => !r.pinned).sort(byActivity);
  const toggleBtn = $('#archived-toggle');
  if (archived.length === 0) {
    toggleBtn.hidden = true;
  } else {
    toggleBtn.hidden = false;
    toggleBtn.textContent = showArchived ? `Hide ${archived.length} archived` : `Show ${archived.length} archived`;
  }
  // Divider sentinel between the pinned group and the rest — only when both
  // groups are non-empty.
  const showDivider = pinned.length > 0 && unpinned.length > 0;
  const toRender = [...pinned, ...(showDivider ? [ROOM_DIVIDER] : []), ...unpinned, ...(showArchived ? archived : [])];

  for (let i = 0; i < toRender.length; i++) {
    const room = toRender[i];
    if (room === ROOM_DIVIDER) {
      const sep = document.createElement('li');
      sep.className = 'room-divider';
      sep.setAttribute('role', 'separator');
      list.appendChild(sep);
      continue;
    }
    const li = document.createElement('li');
    const color = roomColor(room.id);
    li.dataset.roomId = room.id;
    li.style.borderLeftColor = color;
    if (room.archived) li.classList.add('archived');

    const text = document.createElement('span');
    text.textContent = `#${room.id}`;
    text.style.flex = '1';
    li.appendChild(text);

    // A room where you were @-mentioned gets a distinct "@" badge that takes
    // precedence over the plain unread dot.
    if (mentionedRooms.has(room.id)) {
      const badge = document.createElement('span');
      badge.className = 'mention-dot';
      badge.textContent = '@';
      badge.title = 'You were mentioned here';
      li.appendChild(badge);
    } else if (unreadRooms.has(room.id)) {
      const dot = document.createElement('span');
      dot.className = 'unread-dot';
      dot.style.background = color;
      li.appendChild(dot);
    }

    if (room.pinned) {
      const pin = document.createElement('span');
      pin.className = 'room-pin-indicator';
      pin.innerHTML = lucide('pin');
      pin.setAttribute('aria-label', 'Pinned');
      li.appendChild(pin);
    }

    // Kebab — opens a tiny menu with up to two actions:
    //   - Hide / Unhide (per-user sidebar preference) — always present
    //     for anyone with room access.
    //   - Archive / Unarchive (global state) — present only when the
    //     caller can archive this room (owner / global admin / scoped
    //     admin of a wired agent). Server provides `room.canArchive`.
    // Archive is ALSO available in Room Settings (the gear icon at the
    // top of the chat header) for owners/admins; the kebab is the
    // shortcut.
    // Click stops propagation so it doesn't bubble to the `<li>` click
    // (which joins the room). Only one menu open at a time across the list.
    const kebab = document.createElement('button');
    kebab.className = 'room-kebab';
    kebab.type = 'button';
    kebab.innerHTML = lucide('ellipsis');
    kebab.setAttribute('aria-label', 'Room actions');
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      list.querySelectorAll('.room-menu').forEach((m) => m.remove());
      const menu = document.createElement('div');
      menu.className = 'room-menu';

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.textContent = room.pinned ? 'Unpin' : 'Pin';
      pinBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        menu.remove();
        await toggleRoomPin(room.id, !room.pinned);
      });
      menu.appendChild(pinBtn);

      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.textContent = room.hidden ? 'Unhide' : 'Hide';
      hideBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        menu.remove();
        await toggleRoomHide(room.id, !room.hidden);
      });
      menu.appendChild(hideBtn);

      if (room.canArchive) {
        const archiveBtn = document.createElement('button');
        archiveBtn.type = 'button';
        archiveBtn.textContent = room.archived ? 'Unarchive' : 'Archive';
        archiveBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          menu.remove();
          await toggleRoomArchive(room.id, !room.archived);
        });
        menu.appendChild(archiveBtn);
      }

      li.appendChild(menu);
      const close = () => {
        menu.remove();
        document.removeEventListener('click', close);
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    });
    li.appendChild(kebab);

    if (room.id === currentRoom) li.classList.add('active');
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');

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

async function toggleRoomArchive(roomId, archive) {
  // GLOBAL archive (owner + admin only). Optimistic: flip locally and
  // re-render immediately; server success replays the same state via
  // broadcastRooms; failure rolls back.
  const target = lastRoomsList.find((r) => r.id === roomId);
  if (target) target.archived = archive;
  renderRooms(lastRoomsList);
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${archive ? 'archive' : 'unarchive'}`, {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('toggleRoomArchive failed:', err);
    if (target) target.archived = !archive; // roll back
    renderRooms(lastRoomsList);
  }
}

async function toggleRoomPin(roomId, pin) {
  // PER-USER pin. Optimistic flip + re-render, same pattern as hide/archive.
  // The server replays authoritative state via broadcastRooms (which also syncs
  // the pin to this user's other devices).
  const target = lastRoomsList.find((r) => r.id === roomId);
  if (target) target.pinned = pin;
  renderRooms(lastRoomsList);
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${pin ? 'pin' : 'unpin'}`, {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('toggleRoomPin failed:', err);
    if (target) target.pinned = !pin; // roll back
    renderRooms(lastRoomsList);
  }
}

async function toggleRoomHide(roomId, hide) {
  // PER-USER hide. Optimistic flip, same pattern as toggleRoomArchive.
  // Lives on a separate endpoint and table from archive so the two
  // concepts don't conflate.
  const target = lastRoomsList.find((r) => r.id === roomId);
  if (target) target.hidden = hide;
  renderRooms(lastRoomsList);
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/${hide ? 'hide' : 'unhide'}`, {
      method: 'POST',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('toggleRoomHide failed:', err);
    if (target) target.hidden = !hide; // roll back
    renderRooms(lastRoomsList);
  }
}

let pendingJumpMessageId = null;
function joinRoom(roomId, roomName, jumpMessageId) {
  // When set (e.g. from a search-result click), the `history` handler lands on
  // this message instead of scrolling to the bottom.
  pendingJumpMessageId = jumpMessageId || null;
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  // Reset any in-progress turn state from the previous room so its bubbles /
  // elapsed timer / reasoning traces can't leak into the new room.
  endAllAgentTurns();
  currentRoom = roomId;
  unreadRooms.delete(roomId);
  mentionedRooms.delete(roomId);
  updateUnreadDots();
  updateByokBanner(roomId);
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
  $('#messages').innerHTML = '<div class="empty-state">Loading…</div>';
  ws.send(JSON.stringify({ type: 'join', room_id: roomId }));
  sessionStorage.setItem('lastRoom', roomId);
  $('#room-name').textContent = `#${roomId}`;
  $('#message-input').disabled = false;
  $('#message-form button[type=submit]').disabled = false;
  showRoomSettingsToggle(true);
  document.querySelectorAll('#room-list li').forEach((li) => {
    li.classList.toggle('active', li.dataset.roomId === roomId);
  });
  // Prime the mention-autocomplete caches so the first '@' the user types
  // doesn't have to wait on a fetch.
  refreshWiredAgentsForCurrentRoom();
  fetchMentionablePeople();
}

// ── Message search (FTS) ────────────────────────────────────────────────────
// Sidebar search across the user's accessible rooms. Results replace the room
// list while a query is active; clearing the box (or picking a result) restores
// it. Backend: GET /api/search (scoped server-side to rooms the user can see).
let searchDebounce = null;

function clearRoomSearch() {
  const list = $('#search-results');
  if (list) {
    list.hidden = true;
    list.innerHTML = '';
  }
  const roomList = $('#room-list');
  if (roomList) roomList.hidden = false;
  const close = $('#room-search-close');
  if (close) close.hidden = true;
}

function renderSearchResults(results) {
  const list = $('#search-results');
  if (!list) return;
  if (!results || results.length === 0) {
    list.innerHTML = '<li class="search-empty">No matches</li>';
  } else {
    list.innerHTML = results
      .map((r) => {
        // snippet carries «…» highlight delimiters from FTS5 — escape the text
        // first (XSS-safe), then turn the markers into <mark>.
        const snip = esc(r.snippet || '')
          .replace(/«/g, '<mark>')
          .replace(/»/g, '</mark>');
        return `<li class="search-result" data-room-id="${esc(r.roomId)}" data-room-name="${esc(r.roomName)}" data-message-id="${esc(r.id)}">
            <div class="search-result-head">
              <span class="search-result-room">#${esc(r.roomName)}</span>
              <span class="search-result-time">${esc(relativeTime(r.createdAt))}</span>
            </div>
            <div class="search-result-snip"><span class="search-result-sender">${esc(r.sender)}:</span> ${snip}</div>
          </li>`;
      })
      .join('');
  }
  list.hidden = false;
  const roomList = $('#room-list');
  if (roomList) roomList.hidden = true;
}

$('#room-search')?.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  // Show the close/back affordance whenever a query is active (immediate, not
  // debounced) so the dismissal control is there the moment search begins.
  const closeBtn = $('#room-search-close');
  if (closeBtn) closeBtn.hidden = !q;
  clearTimeout(searchDebounce);
  if (!q) {
    clearRoomSearch();
    return;
  }
  searchDebounce = setTimeout(async () => {
    try {
      const r = await authFetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) return renderSearchResults([]); // e.g. backend without the route yet
      const body = await r.json();
      renderSearchResults(body.results || []);
    } catch {
      renderSearchResults([]);
    }
  }, 250);
});

// Close/back button — the visible dismissal affordance the search pane lacked.
// Mobile has no Escape key and the native search clear is unreliable, so this is
// the tap target that returns you to the room list (same effect as Escape).
$('#room-search-close')?.addEventListener('click', () => {
  const input = $('#room-search');
  if (input) input.value = '';
  clearRoomSearch();
  if (input) input.blur();
});

$('#search-results')?.addEventListener('click', (e) => {
  const li = e.target.closest('.search-result');
  if (!li) return;
  const { roomId, roomName, messageId } = li.dataset;
  // Keep the search pane open so you can jump through several hits in a row.
  // Mark the one you're viewing; close via Escape or by clearing the search box.
  $('#search-results .search-result.active')?.classList.remove('active');
  li.classList.add('active');
  joinRoom(roomId, roomName, messageId);
});

// Escape closes the search pane (DESIGN §3 dismissal contract — same key that
// closes settings / lightbox / modals). Clearing the box also closes it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const list = $('#search-results');
  if (!list || list.hidden) return;
  const input = $('#room-search');
  if (input) input.value = '';
  clearRoomSearch();
});

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

// Stable per-name colour for a2a side-channel agent labels. Hashes the name to
// a hue so the same agent is always tinted the same; fixed saturation/lightness
// stay legible on both the light and dark themes.
function agentColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 60%, 55%)`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Today's messages stay time-only to avoid clutter; anything older gets a date
  // so you can tell at a glance how old it is.
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  // Same calendar year → "Jun 20, 14:32"; older → include the year.
  const dateOpts =
    d.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return `${d.toLocaleDateString([], dateOpts)}, ${time}`;
}

// Render an in-room approval card. Actionable (approve/deny buttons) only for
// users in the card's `approvers` list — others see a read-only "pending" note.
// A resolved card renders as a static note. Tagged with data-question-id so the
// approval_resolved handler can update it in place.
function appendApprovalCard(msg, beforeNode) {
  let data = {};
  try {
    data = JSON.parse(msg.content) || {};
  } catch {
    data = {};
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg approval-msg';
  wrap.dataset.questionId = data.questionId || msg.id;
  const resolved = msg.message_type === 'approval_resolved' || !!data.resolvedBy;
  const eligible = Array.isArray(data.approvers) && data.approvers.includes(myIdentity);
  if (resolved) {
    const who = data.resolvedBy ? ' by ' + String(data.resolvedBy).split(':').pop().split('@')[0] : '';
    const note = document.createElement('div');
    note.className = 'approval-inroom-note resolved';
    note.textContent = `🔒 ${data.title || 'Approval'} — resolved${who}`;
    wrap.appendChild(note);
  } else if (eligible) {
    wrap.appendChild(
      renderApprovalCard(
        { questionId: data.questionId, title: data.title, payload: data.question, options: data.options },
        {},
      ),
    );
  } else {
    const note = document.createElement('div');
    note.className = 'approval-inroom-note';
    note.textContent = `🔒 ${data.title || 'Approval requested'} — awaiting an admin`;
    wrap.appendChild(note);
  }
  const tb = $('#messages .thinking-bubble');
  if (beforeNode) $('#messages').insertBefore(wrap, beforeNode);
  else if (tb) $('#messages').insertBefore(wrap, tb);
  else $('#messages').appendChild(wrap);
}

// `beforeNode`, when given, inserts the message before that node instead of at
// the bottom — used to PREPEND older messages during scroll-back pagination.
function appendMessage(msg, statusText, beforeNode) {
  if (msg.type === 'system') {
    appendSystem(msg.message);
    return;
  }
  // In-room approval cards (actionable for eligible approvers; the action still
  // posts to the same /respond endpoint, and resolution clears it everywhere).
  if (msg.message_type === 'approval' || msg.message_type === 'approval_resolved') {
    appendApprovalCard(msg, beforeNode);
    return;
  }
  const div = document.createElement('div');
  const isMine = msg.sender === myIdentity;
  // Side-channel a2a copy (agent→agent surfaced into a shared room). Marked via
  // message_type/sender_type='a2a'; content is {to, text}. Rendered distinctly
  // and NOT treated as an agent message (so it never removes the thinking bubble
  // or counts as the room's active agent reply).
  const isA2a = msg.message_type === 'a2a' || msg.sender_type === 'a2a';
  const isAgent = !isA2a && msg.sender_type === 'agent';
  let a2aTo = null;
  let a2aText = msg.content;
  if (isA2a) {
    try {
      const parsed = JSON.parse(msg.content);
      a2aTo = parsed.to ?? null;
      a2aText = typeof parsed.text === 'string' ? parsed.text : msg.content;
    } catch {
      /* legacy/plain content — render as-is */
    }
  }
  // An agent message means the turn produced output — end the turn (clears the
  // bubble + elapsed timer). Covers reconnect catch-up too. Snapshot the turn's
  // reasoning so it can be folded onto THIS reply as a "Thoughts" disclosure,
  // then clear it so only the first reply of the turn carries it.
  let thoughtsForThisMsg = null;
  if (isAgent) {
    // Fold THIS agent's reasoning onto its reply and clear ITS bubble only — not
    // another agent's that may still be thinking. Match the reply's sender to its
    // bubble by name; if there's a lone bubble (single-agent room), use it even
    // on a name mismatch.
    let senderBubble = bubbleFor(msg.sender);
    if (!senderBubble) {
      const all = document.querySelectorAll('#messages .thinking-bubble');
      if (all.length === 1) senderBubble = all[0];
    }
    if (senderBubble) {
      const log = senderBubble._turn && senderBubble._turn.reasoningLog;
      if (log && log.length > 0) thoughtsForThisMsg = log.slice();
      endAgentTurn(senderBubble.dataset.agent);
    }
  }
  div.className = isA2a ? 'msg a2a' : isMine ? 'msg mine' : isAgent ? 'msg agent' : 'msg other';
  // Highlight messages that @-mention me (not my own). Bubble-level accent +
  // the per-token .mention-me chip from decorateMentions.
  if (!isMine && messageMentionsMe(isA2a ? a2aText : msg.content)) div.classList.add('mentions-me');
  if (msg.id) div.dataset.messageId = msg.id;
  if (isA2a) {
    // Tint the card's accent bar in the sending agent's colour (see .msg.a2a
    // border-left in style.css). The header names below carry the same colours.
    div.style.setProperty('--a2a-accent', agentColor(msg.sender));
  }

  const sender = document.createElement('div');
  sender.className = 'sender';
  if (isA2a) {
    // "from → to" header — each agent name tinted by a stable per-name colour;
    // the accent bar already signals this is a side-channel, so no icon needed.
    sender.classList.add('a2a-label');
    const fromSpan = document.createElement('span');
    fromSpan.className = 'a2a-agent';
    fromSpan.textContent = msg.sender;
    fromSpan.style.color = agentColor(msg.sender);
    sender.appendChild(fromSpan);
    if (a2aTo) {
      const arrow = document.createElement('span');
      arrow.className = 'a2a-arrow';
      arrow.textContent = '→';
      sender.appendChild(arrow);
      const toSpan = document.createElement('span');
      toSpan.className = 'a2a-agent';
      toSpan.textContent = a2aTo;
      toSpan.style.color = agentColor(a2aTo);
      sender.appendChild(toSpan);
    }
  } else {
    if (isAgent) {
      sender.textContent = '';
      sender.appendChild(lucideEl('bot'));
      sender.append(' ' + msg.sender);
    } else {
      sender.textContent = isMine ? 'You' : msg.sender;
    }
  }
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
  } else if (isMine) {
    // User's own messages are rendered as plain text — preserves whitespace,
    // tabs, and code indentation exactly as typed. Only agent replies need
    // Markdown interpretation.
    bubble.textContent = msg.content;
  } else {
    // Markdown render is best-effort: a malformed message must not crash the
    // whole render loop and leave #messages half-populated. Fall back to
    // text-content (escaped by the DOM, no XSS risk) if marked or DOMPurify
    // throws.
    try {
      bubble.innerHTML = DOMPurify.sanitize(marked.parse(a2aText));
      decorateCodeBlocks(bubble);
      decorateMentions(bubble);
    } catch (err) {
      console.error('Message render failed; falling back to plain text', err);
      bubble.textContent = a2aText;
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

  // Fold this turn's reasoning onto the reply as a collapsible disclosure.
  if (thoughtsForThisMsg && thoughtsForThisMsg.length > 0) {
    div.appendChild(buildThoughtsDisclosure(thoughtsForThisMsg));
  }

  // Timestamp
  const timeStr = formatTime(msg.created_at);
  if (timeStr) {
    const time = document.createElement('div');
    time.className = 'timestamp';
    time.textContent = timeStr;
    // Full date + time on hover, for exact age regardless of the compact label.
    if (msg.created_at) time.title = new Date(msg.created_at).toLocaleString();
    div.appendChild(time);
  }
  if (isMine && statusText) {
    const status = document.createElement('div');
    status.className = 'status' + (statusText === '✓✓' ? ' delivered' : '');
    status.textContent = statusText;
    div.appendChild(status);
  }
  // Prepend (older-message pagination) inserts before the given node; otherwise
  // insert before the thinking bubble so live messages stay at the bottom.
  const thinkingBubble = $('#messages .thinking-bubble');
  if (beforeNode) {
    $('#messages').insertBefore(div, beforeNode);
  } else if (thinkingBubble) {
    $('#messages').insertBefore(div, thinkingBubble);
  } else {
    $('#messages').appendChild(div);
  }
  // a2a cards clamp to ~5 lines (measured now that the element is attached).
  if (isA2a) applyA2aClamp(bubble, div);
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

// Collapsible "Thoughts" disclosure folded onto an agent reply — the full
// reasoning trace captured during the turn. Collapsed by default.
function buildThoughtsDisclosure(lines) {
  const details = document.createElement('details');
  details.className = 'thoughts';
  const summary = document.createElement('summary');
  summary.appendChild(lucideEl('sparkles'));
  summary.append(` Thoughts (${lines.length})`);
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'thoughts-body';
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = 'thoughts-line';
    row.textContent = line;
    body.appendChild(row);
  }
  details.appendChild(body);
  return details;
}

// Clamp an a2a side-channel card to ~5 lines with a show more/less toggle.
// Must run AFTER the element is attached to the DOM (needs layout to measure).
function applyA2aClamp(bubble, container) {
  bubble.classList.add('a2a-clamp', 'collapsed');
  // Fits within the clamp → no toggle needed; drop the clamp classes.
  if (bubble.scrollHeight <= bubble.clientHeight + 4) {
    bubble.classList.remove('a2a-clamp', 'collapsed');
    return;
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'a2a-more';
  toggle.textContent = 'Show more';
  toggle.addEventListener('click', () => {
    const collapsed = bubble.classList.toggle('collapsed');
    toggle.textContent = collapsed ? 'Show more' : 'Show less';
  });
  container.appendChild(toggle);
}

// ── Scroll-back (older-message pagination) ──────────────────────────────────
// Join loads only the most recent window; older history (it's all in SQLite)
// is fetched on demand when the user scrolls to the top, via ?before_id=. State
// is reset per room in the `history` handler above.
let oldestMessageId = null;
let loadingOlder = false;
let noMoreOlder = false;
// During a search-jump we page older history in a tight loop; suppress
// loadOlderMessages' per-page scroll re-pin so the viewport doesn't bounce —
// jumpToMessage does one clean scroll at the end instead.
let suppressScrollRestore = false;

async function loadOlderMessages() {
  if (loadingOlder || noMoreOlder || !currentRoom || !oldestMessageId) return;
  loadingOlder = true;
  const el = $('#messages');
  // Snapshot scroll geometry so the viewport stays pinned to the same message
  // after prepending — on desktop #messages scrolls, on mobile the window does.
  const prevElHeight = el.scrollHeight;
  const prevElTop = el.scrollTop;
  const prevDocHeight = document.documentElement.scrollHeight;
  const prevWinY = window.scrollY;
  try {
    const r = await authFetch(
      `/api/rooms/${encodeURIComponent(currentRoom)}/messages?before_id=${encodeURIComponent(oldestMessageId)}`,
    );
    if (!r.ok) return;
    const older = await r.json();
    if (!Array.isArray(older) || older.length === 0) {
      noMoreOlder = true;
      return;
    }
    // Dedupe against what's already rendered: guards page-boundary overlaps and
    // stays correct if the request hit a backend that doesn't honor before_id
    // (it would echo recent messages — all already on screen → nothing fresh).
    const fresh = older.filter((m) => !m.id || !el.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`));
    if (fresh.length === 0) {
      noMoreOlder = true;
      return;
    }
    const anchor = el.firstChild; // current oldest rendered node
    fresh.forEach((m) => appendMessage(m, undefined, anchor));
    oldestMessageId = older[0].id; // advance from the oldest FETCHED id (paging anchor)
    if (older.length < 50) noMoreOlder = true; // short page → reached the start
    // Restore position: add the height the prepend introduced. Skipped during a
    // search-jump — jumpToMessage scrolls to the target once at the end, so
    // per-page re-pinning would just make the viewport bounce.
    if (!suppressScrollRestore) {
      requestAnimationFrame(() => {
        el.scrollTop = prevElTop + (el.scrollHeight - prevElHeight);
        window.scrollTo(0, prevWinY + (document.documentElement.scrollHeight - prevDocHeight));
      });
    }
  } catch {
    /* leave noMoreOlder false so a later scroll-to-top retries */
  } finally {
    loadingOlder = false;
  }
}

// Center + briefly flash a specific message (used by search-result clicks). If
// the target isn't in the loaded window, page older history in until it appears
// (or we run out / hit a safety cap), then scroll to it. Reuses the same
// ?before_id= pagination as scroll-back, so no backend change is needed.
async function jumpToMessage(messageId) {
  if (!messageId) return;
  const find = () => $('#messages').querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  let el = find();
  if (!el) {
    // Off-screen hit: page older history in (no per-page re-pin) until it appears.
    suppressScrollRestore = true;
    try {
      let guard = 0;
      while (!el && !noMoreOlder && guard < 40) {
        const before = oldestMessageId;
        await loadOlderMessages();
        el = find();
        if (oldestMessageId === before) break; // no progress (error / nothing fresh) — stop
        guard++;
      }
    } finally {
      suppressScrollRestore = false;
    }
  }
  if (!el) {
    showToast('Couldn’t find that message — it may be too old to load.', { kind: 'info' });
    return;
  }
  // Let the prepends/layout settle, then do ONE definitive scroll + flash so the
  // message is stably centered (and in view) for the whole highlight.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  el.scrollIntoView({ block: 'center' });
  el.classList.add('jump-highlight');
  setTimeout(() => el.classList.remove('jump-highlight'), 2500);
}

// ── Toasts + confirm modal ────────────────────────────────────────────────
// One feedback vocabulary for the whole app. showToast replaces post-action
// alert()s; showConfirmModal replaces destructive confirm()s. Both reuse the
// existing modal-overlay / toast container styling so there are no native
// browser dialogs in the installed PWA.

/**
 * Transient corner notification. `kind` is 'info' (default), 'success', or
 * 'error'. Errors linger longer and must be dismissed-or-time-out; all toasts
 * are click-to-dismiss. Returns the element so callers can remove it early.
 */
// ── BYOK: per-member key banner ───────────────────────────────────────────
// Shown in a room whose credential_mode is optional/required when the current
// user hasn't connected their own Anthropic key. Connecting onboards the key
// into the OneCLI vault (host-side) so the member's turns bill their account.
async function updateByokBanner(roomId) {
  const banner = $('#byok-banner');
  const chip = $('#byok-chip');
  if (!banner || !roomId) return;
  const hideAll = () => {
    banner.hidden = true;
    if (chip) chip.hidden = true;
  };
  try {
    const r = await authFetch(`/api/byok/credential?roomId=${encodeURIComponent(roomId)}`);
    if (!r.ok) {
      hideAll();
      return;
    }
    const { connected, mode, oauthAllowed, apiKeyAllowed = true } = await r.json();
    // API keys are offered only when the room is on AND the workspace accepts them.
    const apiOffered = mode !== 'disabled' && apiKeyAllowed;
    // BYOK is surfaced when the room offers API keys OR the workspace allows OAuth.
    if (!apiOffered && !oauthAllowed) {
      hideAll();
      return;
    }

    // Connected → collapse to a small key chip in the header; the full banner
    // is only the actionable "connect" prompt, which is done once connected.
    if (connected) {
      banner.hidden = true;
      if (chip) {
        chip.hidden = false;
        chip.title = 'Your member credential · click to disconnect';
      }
      return;
    }

    // Not connected → show the actionable banner, hide the chip.
    if (chip) chip.hidden = true;
    const text = $('#byok-banner-text');
    const connectBtn = $('#byok-connect-btn');
    const oauthBtn = $('#byok-oauth-btn');
    const input = $('#byok-key-input');
    const oauthForm = $('#byok-oauth-form');
    banner.hidden = false;
    input.hidden = true;
    input.value = '';
    if (oauthForm) oauthForm.hidden = true;
    // Generic "member credentials" wording; the buttons below say HOW (the
    // Claude-subscription helper, or an API key).
    if (text)
      text.textContent =
        mode === 'required'
          ? 'This room requires your member credentials.'
          : 'Connect your member credentials to bill this room to your own account.';
    connectBtn.hidden = !apiOffered;
    if (oauthBtn) oauthBtn.hidden = !oauthAllowed;
  } catch {
    hideAll();
  }
}

$('#byok-connect-btn')?.addEventListener('click', async () => {
  const input = $('#byok-key-input');
  // First click reveals the input; second (with a value) submits.
  if (input.hidden) {
    input.hidden = false;
    input.focus();
    return;
  }
  const apiKey = input.value.trim();
  if (!apiKey) return;
  const r = await authFetch('/api/byok/credential', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ roomId: currentRoom, apiKey }),
  });
  if (r.ok) {
    showToast('Connected your Anthropic key.', { kind: 'success' });
    await updateByokBanner(currentRoom);
  } else {
    const err = await r.json().catch(() => ({}));
    showToast('Failed to connect key: ' + (err.error || r.statusText), { kind: 'error' });
  }
});

$('#byok-key-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#byok-connect-btn').click();
});

async function disconnectByok() {
  const r = await authFetch('/api/byok/credential', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ roomId: currentRoom }),
  });
  if (r.ok) {
    showToast('Disconnected your key from this room.', { kind: 'success' });
    await updateByokBanner(currentRoom);
  } else {
    const err = await r.json().catch(() => ({}));
    showToast('Failed to disconnect: ' + (err.error || r.statusText), { kind: 'error' });
  }
}

// The connected state lives as a compact key chip in the header; clicking it
// disconnects (after a confirm), so the full banner no longer sits over the chat.
$('#byok-chip')?.addEventListener('click', async () => {
  const confirmed = await showConfirmModal({
    title: 'Disconnect your credential?',
    body: 'Your turns in this room will stop billing your own account and fall back to the shared key (or be declined if the room requires your own).',
    confirmLabel: 'Disconnect',
    destructive: true,
  });
  if (confirmed) await disconnectByok();
});

// ── BYOK OAuth: connect a Claude subscription token ────────────────────────
// Browser-mint OAuth: no terminal. Opening the form starts a server-side mint
// (a throwaway container runs `claude setup-token`), surfaces the sign-in URL,
// takes the pasted code, and onboards the resulting token per-member.
let byokOauthSessionId = null;

function byokOauthStatus(msg, kind) {
  const el = $('#byok-oauth-status');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = 'byok-oauth-status' + (kind ? ' ' + kind : '');
}

$('#byok-oauth-btn')?.addEventListener('click', async () => {
  const form = $('#byok-oauth-form');
  if (!form) return;
  form.hidden = false;
  $('#byok-oauth-step2').hidden = true;
  $('#byok-oauth-submit').hidden = true;
  const code = $('#byok-oauth-code');
  if (code) code.value = '';
  const ack = $('#byok-oauth-ack');
  if (ack) ack.checked = false;
  byokOauthStatus('Preparing sign-in…', '');
  try {
    const r = await authFetch('/api/byok/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ roomId: currentRoom }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    byokOauthSessionId = data.sessionId;
    $('#byok-oauth-link').href = data.url;
    $('#byok-oauth-step2').hidden = false;
    $('#byok-oauth-submit').hidden = false;
    byokOauthStatus('', '');
    $('#byok-oauth-link').focus();
  } catch (err) {
    byokOauthStatus(err.message || 'Could not start sign-in.', 'error');
  }
});

$('#byok-oauth-cancel')?.addEventListener('click', () => {
  if (byokOauthSessionId) {
    authFetch('/api/byok/oauth/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ sessionId: byokOauthSessionId }),
    }).catch(() => {});
    byokOauthSessionId = null;
  }
  const form = $('#byok-oauth-form');
  if (form) form.hidden = true;
});

$('#byok-oauth-submit')?.addEventListener('click', async () => {
  const code = ($('#byok-oauth-code')?.value || '').trim();
  const acknowledged = !!$('#byok-oauth-ack')?.checked;
  if (!code || !byokOauthSessionId) return;
  if (!acknowledged) {
    showToast('Please tick the acknowledgment to continue.', { kind: 'error' });
    return;
  }
  const btn = $('#byok-oauth-submit');
  btn.disabled = true;
  byokOauthStatus('Saving your subscription… (this can take a few seconds)', '');
  try {
    const r = await authFetch('/api/byok/oauth/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ roomId: currentRoom, sessionId: byokOauthSessionId, code, acknowledged }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    byokOauthSessionId = null;
    showToast('Connected your Claude subscription.', { kind: 'success' });
    $('#byok-oauth-form').hidden = true;
    await updateByokBanner(currentRoom);
  } catch (err) {
    byokOauthStatus(err.message || 'Could not connect.', 'error');
  } finally {
    btn.disabled = false;
  }
});

function showToast(message, { kind = 'info', timeout } = {}) {
  const container = $('#toasts');
  if (!container) return null;
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  const remove = () => {
    if (!toast.parentNode) return;
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 180);
  };
  toast.addEventListener('click', remove);
  container.appendChild(toast);
  const ms = timeout ?? (kind === 'error' ? 7000 : 4000);
  setTimeout(remove, ms);
  return toast;
}

/**
 * Promise-based confirmation modal. Resolves true on confirm, false on
 * cancel / backdrop / Escape. `body` may be a string or an HTMLElement (use an
 * element when the message contains user-supplied text, so it stays escaped).
 * `destructive` styles the confirm button as a delete action and focuses
 * Cancel by default.
 */
function showConfirmModal({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = title || 'Confirm';
    header.appendChild(titleSpan);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    const message = document.createElement('div');
    message.className = 'confirm-message';
    if (body instanceof HTMLElement) message.appendChild(body);
    else message.textContent = body || '';
    bodyEl.appendChild(message);

    const footer = document.createElement('div');
    footer.className = 'confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-cancel';
    cancelBtn.textContent = cancelLabel;
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = destructive ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = confirmLabel;
    footer.append(cancelBtn, confirmBtn);

    modal.append(header, bodyEl, footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener('keydown', onKey);
    // Focus Cancel for destructive actions so an accidental Enter doesn't delete.
    (destructive ? cancelBtn : confirmBtn).focus();
  });
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
    img.addEventListener('click', () => openLightbox(meta.url, meta.filename));
    wrap.appendChild(img);
  }
  const info = document.createElement('div');
  info.className = 'file-info';
  const icon = isImage ? lucide('image') : meta.mime?.includes('pdf') ? lucide('file-text') : lucide('paperclip');
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
  dl.innerHTML = lucide('download');
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
      ? `Add a message about ${file.name}…`
      : `Add a message about ${pendingFiles.length} files…`;
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
        ? `Add a message about ${pendingFiles[0].file.name}…`
        : `Add a message about ${pendingFiles.length} files…`;
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
  $('#message-input').placeholder = 'Message…';
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
      html += `<span class="file-preview-icon">${lucide('paperclip')}</span>`;
    }
    html += `<span class="file-preview-name">${esc(file.name)}</span>`;
    html += `<span class="file-preview-size">${formatFileSize(file.size)}</span>`;
    html += `<button class="file-preview-remove" data-remove-id="${id}">${lucide('x')}</button>`;
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

// crypto.randomUUID is only exposed in secure contexts (HTTPS / localhost).
// Webchat is commonly served over plain HTTP on a tailnet hostname where it
// is absent — fall back to a getRandomValues-based v4 builder, which IS
// available in non-secure contexts. Format matches the server's UUID regex
// in src/channels/webchat/files.ts (handleChunkedUpload).
function uuidv4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function uploadFileChunked(file, caption) {
  const uploadId = uuidv4();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const statusMsg = appendSystem(`Uploading ${file.name} (0/${totalChunks})…`);

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
    if (statusMsg) statusMsg.textContent = `Uploading ${file.name} (${i + 1}/${totalChunks})…`;
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

// Coalesce multiple image-load re-scroll requests into a single rAF call so
// many simultaneous loads don't queue up overlapping scrollTo invocations.
let pendingFollowScroll = false;
function scheduleFollowScroll() {
  if (pendingFollowScroll) return;
  pendingFollowScroll = true;
  requestAnimationFrame(() => {
    pendingFollowScroll = false;
    if (!userScrolledAway) scrollToBottom();
  });
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

// Show/hide scroll-to-bottom button; detect user scrolling away.
//
// Programmatic scrolls (our scrollToBottom) fire scroll events too. Without
// gating, those mid-animation events see "not at bottom yet" and flip
// userScrolledAway=true / forceScrollCount=0 — which then prevents
// late-arriving thinking bubbles from auto-scrolling. Only treat a scroll
// event as user-driven if the user actually did something to cause it
// (wheel, touch, or a scroll-relevant key) recently.
//
// Touch is tracked specially: iOS momentum scrolling continues to fire scroll
// events for up to ~1s after touchend with no touchmove in between. We arm a
// `momentumUntil` window when a real flick gesture ends so those events still
// count as user-driven.
let lastUserScrollAt = 0;
let touchMovedThisGesture = false;
let momentumUntil = 0;
const markUserScroll = () => {
  lastUserScrollAt = Date.now();
};
window.addEventListener('wheel', markUserScroll, { passive: true });
window.addEventListener(
  'touchstart',
  () => {
    touchMovedThisGesture = false;
  },
  { passive: true },
);
window.addEventListener(
  'touchmove',
  () => {
    touchMovedThisGesture = true;
    markUserScroll();
  },
  { passive: true },
);
window.addEventListener(
  'touchend',
  () => {
    if (touchMovedThisGesture) {
      momentumUntil = Date.now() + 1000;
    }
    touchMovedThisGesture = false;
  },
  { passive: true },
);
window.addEventListener('keydown', (e) => {
  // Skip when the user is typing into an input — space, arrows, home/end
  // are all editing keys there, not scroll intent. Without this gate, every
  // space typed in the message textarea would mark scroll-intent and trip
  // the very bug this whole module exists to prevent.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (
    e.key === 'ArrowUp' ||
    e.key === 'ArrowDown' ||
    e.key === 'PageUp' ||
    e.key === 'PageDown' ||
    e.key === 'Home' ||
    e.key === 'End' ||
    e.key === ' '
  ) {
    markUserScroll();
  }
});

function handleScroll() {
  updateScrollButton();
  // Near the top → pull in older history. #messages scrolls on desktop, the
  // window scrolls on mobile; check whichever actually overflows so we don't
  // false-trigger on the axis that never moves.
  const el = $('#messages');
  const elScrolls = el.scrollHeight - el.clientHeight > 4;
  const winScrolls = document.documentElement.scrollHeight - window.innerHeight > 4;
  if ((elScrolls && el.scrollTop < 80) || (winScrolls && window.scrollY < 80)) loadOlderMessages();
  const now = Date.now();
  const userDriven = now - lastUserScrollAt < 300 || now < momentumUntil;
  if (!isNearBottom()) {
    if (userDriven) {
      userScrolledAway = true;
      forceScrollCount = 0;
    }
  } else {
    // Always reset when we land at bottom — programmatic or not, we're caught up.
    userScrolledAway = false;
  }
}
$('#messages').addEventListener('scroll', handleScroll);
window.addEventListener('scroll', handleScroll);
$('#scroll-bottom').addEventListener('click', () => {
  missedMsgCount = 0;
  userScrolledAway = false;
  // Clear input markers so the imminent smooth scroll doesn't get tagged as
  // user-driven by a stale wheel/touch from just before the click.
  lastUserScrollAt = 0;
  momentumUntil = 0;
  $('#unread-badge').textContent = '';
  scrollToBottom();
});

let clientMsgSeq = 0;

function sendCurrentMessage() {
  const input = $('#message-input');
  const text = input.value.trimEnd(); // trimEnd not trim — preserves leading indentation
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
  // Clear input markers so the smooth scroll below isn't mistaken for
  // user-driven by a stale wheel/touch immediately before send.
  lastUserScrollAt = 0;
  momentumUntil = 0;
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

// People you can @-mention here: anyone with a handle who can access the room,
// online or not (mentions notify on return). Sourced from the server, NOT the
// connected-members list — so you can mention offline teammates and the list
// isn't empty just because you're the only one currently in the room.
async function fetchMentionablePeople() {
  const roomId = currentRoom;
  if (!roomId) {
    roomMentionPeople = [];
    return;
  }
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/mentionable`);
    if (!res.ok) return; // leave stale on error rather than blanking
    const people = await res.json();
    if (currentRoom === roomId) {
      roomMentionPeople = people.map((p) => ({ folder: p.handle, name: p.name, isUser: true }));
    }
  } catch {
    // network blip — leave stale cache
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
    if (agent.isUser) {
      const badge = document.createElement('span');
      badge.className = 'mention-popover-person';
      badge.textContent = 'person';
      item.appendChild(badge);
    } else if (agent.is_prime) {
      const badge = document.createElement('span');
      badge.className = 'mention-popover-prime';
      badge.textContent = 'default';
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
  // Candidates: wired agents (trigger the agent) + human members with handles
  // (notify/surface only). De-dup by folder so a handle that collides with an
  // agent folder doesn't double-list.
  const seen = new Set();
  const mentionPool = [];
  for (const a of [...wiredAgentsForCurrentRoom, ...roomMentionPeople]) {
    const key = (a.folder || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    mentionPool.push(a);
  }
  if (mentionPool.length === 0) {
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
  mentionMatches = mentionPool.filter((a) => a.folder.toLowerCase().startsWith(token)).slice(0, 8);
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
      if (myHandle && m[2].toLowerCase() === myHandle) span.classList.add('mention-me');
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

let membersFilter = ''; // lowercased; filters the room members list

function renderMembers(members) {
  currentMembers = members;
  const toggle = $('#members-toggle');
  toggle.textContent = members.length; // full count — independent of the filter
  toggle.hidden = !currentRoom;
  paintMembersList();
}

// Render #members-list from currentMembers, applying the search filter. Split
// from renderMembers so the search box can re-paint without a re-fetch.
function paintMembersList() {
  const list = $('#members-list');
  list.innerHTML = '';
  let sorted = [...currentMembers].sort((a, b) => {
    if (a.identity_type !== b.identity_type) return a.identity_type === 'agent' ? -1 : 1;
    return a.identity.localeCompare(b.identity);
  });
  if (membersFilter) {
    sorted = sorted.filter((m) => `${m.identity} ${m.handle || ''}`.toLowerCase().includes(membersFilter));
  }
  if (sorted.length === 0) {
    list.innerHTML = '<li class="member-empty">No members match.</li>';
    return;
  }
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
    } else if (m.handle) {
      // Show how to @-mention this person, right-aligned like the AGENT tag.
      const handle = document.createElement('span');
      handle.className = 'member-handle';
      handle.textContent = `@${m.handle}`;
      li.appendChild(handle);
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
$('#members-search')?.addEventListener('input', (e) => {
  membersFilter = e.target.value.trim().toLowerCase();
  paintMembersList();
});
$('#members-overlay').addEventListener('click', toggleMembersPanel);

// ── Detail-panel backdrop (mobile-only via CSS) ─────────────────────────────
// Shared tap-to-close for #agent-detail / #room-detail / #model-detail. There
// are 14-ish call sites that toggle `.hidden` on those panels; rather than
// patch each one, a MutationObserver mirrors panel state onto the backdrop.
(function () {
  const overlay = $('#detail-overlay');
  if (!overlay) return; // index.html older than this build — graceful no-op
  const panels = ['#agent-detail', '#room-detail', '#model-detail'].map((s) => $(s)).filter(Boolean);
  const app = $('#app');
  let detailViewSynced = false;
  const closeAllDetailPanels = () => {
    $('#agent-detail').hidden = true;
    $('#room-detail').hidden = true;
    $('#model-detail').hidden = true;
  };
  const sync = () => {
    const allHidden = panels.every((p) => p.hidden);
    overlay.hidden = allHidden;
    // The three detail panels are nested inside <section id="chat">, which
    // mobile CSS hides (`display: none`) unless `#app.in-room`. Without this
    // class the panels stay invisible while the backdrop (a sibling of #chat)
    // dims the screen — looked like a frozen grey UI when opened from a
    // sidebar tab. Toggling `detail-open` keeps #chat displayed for the
    // panel's lifetime.
    if (app) app.classList.toggle('detail-open', !allHidden);
    // Router: a detail pane is an overlay surface, so the OS/browser back
    // gesture closes it (and, when opened over Manage, returns there). Guarded
    // by detailViewSynced so the teardown's own .hidden writes don't recurse.
    if (!allHidden && !detailViewSynced) {
      detailViewSynced = true;
      openView('detail', () => {
        detailViewSynced = false;
        closeAllDetailPanels();
      });
    } else if (allHidden && detailViewSynced) {
      detailViewSynced = false;
      closeView('detail');
    }
  };
  const obs = new MutationObserver(sync);
  for (const p of panels) obs.observe(p, { attributes: true, attributeFilter: ['hidden'] });
  sync();
  // Tap on backdrop closes whichever panel(s) are currently open. The close
  // functions each set their own `.hidden = true`, which fires the observer
  // and hides the backdrop on the next tick.
  overlay.addEventListener('click', () => {
    if (!$('#agent-detail').hidden) closeAgentDetail();
    if (!$('#room-detail').hidden) closeRoomDetail();
    if (!$('#model-detail').hidden) closeModelDetail();
  });
})();

// ── Sidebar tabs ──────────────────────────────────────────────────────────
// ── Manage section (Agents / Models) ────────────────────────────────────────
// Full-screen surface reached from the ⋯ menu — replaces the old sidebar
// Agents/Models tabs (the sidebar is now Rooms-only). Router-managed so the
// back gesture returns to chat; detail panes (z-index above) overlay it.
let manageActive = false;
function openManage(tab = 'agents') {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  manageActive = true;
  $('#manage').hidden = false;
  $('#overflow-btn')?.classList.add('active');
  switchManageTab(tab);
  if (!viewStack.some((v) => v.name === 'manage')) openView('manage', teardownManage);
}
function teardownManage() {
  manageActive = false;
  $('#manage').hidden = true;
  $('#overflow-btn')?.classList.remove('active');
}
function switchManageTab(tab) {
  document.querySelectorAll('.manage-tab').forEach((t) => {
    const on = t.dataset.mtab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  $('#mtab-agents').hidden = tab !== 'agents';
  $('#mtab-models').hidden = tab !== 'models';
  if (tab === 'agents') fetchAgents();
  else if (tab === 'models') fetchModels();
}
$('#manage-back')?.addEventListener('click', () => closeView('manage'));
document.querySelectorAll('.manage-tab').forEach((t) => {
  t.addEventListener('click', () => switchManageTab(t.dataset.mtab));
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
  const optionList =
    Array.isArray(a.options) && a.options.length
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

// Fired when another admin handled an approval that was fanned out to us.
// Drop the card from local state, re-render the list, and clear any toast.
function handleApprovalResolvedEvent(msg) {
  // msg shape: { type: 'approval_resolved', approvalId, resolvedBy }
  const approvalId = msg.approvalId;
  if (!approvalId) return;
  pendingApprovals = pendingApprovals.filter((a) => a.questionId !== approvalId);
  renderApprovalsList();
  document.querySelectorAll(`.approval-toast[data-question-id="${approvalId}"]`).forEach((el) => el.remove());
  // Flip any in-room card to a resolved note.
  document.querySelectorAll(`.approval-msg[data-question-id="${approvalId}"]`).forEach((el) => {
    const who = msg.resolvedBy ? ' by ' + String(msg.resolvedBy).split(':').pop().split('@')[0] : '';
    el.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'approval-inroom-note resolved';
    note.textContent = `🔒 Approval — resolved${who}`;
    el.appendChild(note);
  });
}

function handleApprovalEvent(msg) {
  // msg shape: { type: 'approval', questionId, title, question, options, ... }
  // We re-fetch the canonical list so we don't drift if multiple events
  // arrive close together; the toast is purely for live visibility.
  showApprovalToast(msg);
  fetchApprovals();
  // Desktop notification when settings allow + tab not focused.
  if (
    settings.notifications &&
    document.hidden &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    try {
      new Notification(msg.title || 'Approval requested', { body: msg.question || '' });
    } catch {}
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
      if (cardEl) {
        cardEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
        // Inline error so the user actually sees why nothing happened.
        let errEl = cardEl.querySelector('.approval-error');
        if (!errEl) {
          errEl = document.createElement('div');
          errEl.className = 'approval-error';
          cardEl.appendChild(errEl);
        }
        errEl.textContent = `Couldn't respond (${r.status}): ${body.error || r.statusText}`;
      }
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

// The full-width surfaces (dashboard/permissions/topology/matrix) are flex
// siblings of #chat — only one may be visible at a time, or they'd split the
// pane. Each opener hides its peers synchronously (the router stack still
// unwinds normally on back).
function hideOtherFullViews(keep) {
  if (keep !== 'dashboard' && dashboardActive) {
    dashboardActive = false;
    $('#dashboard').hidden = true;
    $('#dash-btn')?.classList.remove('active');
  }
  if (keep !== 'permissions' && permsActive) {
    permsActive = false;
    $('#permissions').hidden = true;
  }
  if (keep !== 'topology' && topologyActive) {
    topologyActive = false;
    $('#topology').hidden = true;
  }
  if (keep !== 'matrix' && matrixActive) {
    matrixActive = false;
    $('#matrix').hidden = true;
  }
}

function openDashboard() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  hideOtherFullViews('dashboard');
  dashboardActive = true;
  $('#chat').hidden = true;
  $('#dashboard').hidden = false;
  $('#dash-btn')?.classList.add('active');
  $('#app').classList.add('in-dashboard');
  $('#app').classList.remove('in-room');
  refreshDashboard();
  openView('dashboard', teardownDashboard);
}
function teardownDashboard() {
  dashboardActive = false;
  $('#chat').hidden = false;
  $('#dashboard').hidden = true;
  $('#dash-btn')?.classList.remove('active');
  $('#app').classList.remove('in-dashboard');
}
function toggleDashboard() {
  if (dashboardActive) closeView('dashboard');
  else openDashboard();
}

$('#dash-btn')?.addEventListener('click', toggleDashboard); // ▦ quick-toggle, left of the ⋯ menu
$('#dash-back').addEventListener('click', toggleDashboard);
$('#dash-refresh').addEventListener('click', refreshDashboard);

// ── Topology (room → agent → model explore graph) ──────────────────────────
// Full-width SVG view (no graph library): fixed three columns, barycenter
// ordering to minimize edge crossings. Fan-in = load; a node with no lines is
// unused. Data: GET /api/topology (access-scoped server-side).
let topologyActive = false;
function openTopology() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  hideOtherFullViews('topology');
  topologyActive = true;
  $('#chat').hidden = true;
  $('#topology').hidden = false;
  $('#app').classList.add('in-dashboard'); // reuse the full-view mobile layout
  $('#app').classList.remove('in-room');
  refreshTopology();
  openView('topology', teardownTopology);
}
function teardownTopology() {
  topologyActive = false;
  $('#chat').hidden = false;
  $('#topology').hidden = true;
  $('#app').classList.remove('in-dashboard');
}
function toggleTopology() {
  if (topologyActive) closeView('topology');
  else openTopology();
}
$('#topology-back')?.addEventListener('click', toggleTopology);
$('#topology-refresh')?.addEventListener('click', refreshTopology);

async function refreshTopology() {
  const canvas = $('#topology-canvas');
  if (!canvas) return;
  canvas.textContent = 'Loading…';
  try {
    const r = await authFetch('/api/topology');
    if (!r.ok) {
      canvas.textContent = 'Could not load topology.';
      return;
    }
    renderTopology(await r.json());
  } catch {
    canvas.textContent = 'Could not load topology.';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function renderTopology(data) {
  const canvas = $('#topology-canvas');
  if (!canvas) return;
  canvas.textContent = '';
  const rooms = data.rooms || [];
  const agents = data.agents || [];
  const models = data.models || [];
  const edges = data.edges || [];
  if (rooms.length === 0) {
    canvas.textContent = 'No rooms yet.';
    return;
  }

  // Adjacency.
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  const agentRooms = new Map();
  const roomAgents = new Map();
  const modelAgents = new Map();
  for (const e of edges) {
    push(agentRooms, e.agent, e.room);
    push(roomAgents, e.room, e.agent);
  }
  for (const a of agents) if (a.modelId) push(modelAgents, a.modelId, a.id);

  // Barycenter ordering: average a node's y over its neighbors. Orphans (no
  // neighbors) sink to the bottom. Forward (agents←rooms, models←agents), one
  // reverse (rooms←agents), then re-settle — two-ish passes cut most crossings.
  const indexMap = (arr) => new Map(arr.map((x, i) => [x.id, i]));
  const bary = (neighbors, posMap) =>
    !neighbors || neighbors.length === 0
      ? Number.POSITIVE_INFINITY
      : neighbors.reduce((s, n) => s + (posMap.get(n) ?? 0), 0) / neighbors.length;
  const reorder = (items, neighborsOf, posMap) => {
    const ranked = items.map((it, i) => ({ id: it.id, b: bary(neighborsOf(it.id), posMap), i }));
    ranked.sort((x, y) => x.b - y.b || x.i - y.i); // stable on ties
    return new Map(ranked.map((r, i) => [r.id, i]));
  };
  let roomY = indexMap(rooms);
  let agentY = reorder(agents, (id) => agentRooms.get(id), roomY);
  let modelY = reorder(models, (id) => modelAgents.get(id), agentY);
  roomY = reorder(rooms, (id) => roomAgents.get(id), agentY);
  agentY = reorder(agents, (id) => agentRooms.get(id), roomY);
  modelY = reorder(models, (id) => modelAgents.get(id), agentY);

  // Pixel layout.
  const ROW = 46;
  const PAD = 28;
  const COLW = 240;
  const cols = { room: PAD, agent: PAD + COLW, model: PAD + COLW * 2 };
  const rowsCount = Math.max(rooms.length, agents.length, models.length, 1);
  const W = cols.model + COLW;
  const H = PAD * 2 + 20 + rowsCount * ROW;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'topology-svg', preserveAspectRatio: 'xMidYMin meet' });
  const NODE_X = 6; // circle radius; line attaches just past the label gap
  const LABEL_W = 84; // px reserved before an edge leaves a node's right side
  const yPx = (yMap, id) => PAD + 20 + (yMap.get(id) ?? 0) * ROW + ROW / 2;

  // Column headers.
  for (const [label, x] of [
    ['Rooms', cols.room],
    ['Agents', cols.agent],
    ['Models', cols.model],
  ]) {
    const h = svgEl('text', { x, y: PAD, class: 'topo-col-head' });
    h.textContent = label;
    svg.appendChild(h);
  }

  // Edges (under nodes). Room→agent edges are tinted with the room's own color
  // (the same palette as the sidebar dots) so you can trace each room's fan-out
  // at a glance. Inline style beats the `.topo-edge` CSS stroke. Agent→model
  // edges stay neutral — an agent can belong to several rooms, so there's no one
  // room color to give them.
  const edgeLine = (x1, y1, x2, y2, stroke) => {
    const ln = svgEl('line', { x1, y1, x2, y2, class: 'topo-edge' });
    if (stroke) ln.style.stroke = stroke;
    return svg.appendChild(ln);
  };
  for (const e of edges)
    edgeLine(cols.room + LABEL_W, yPx(roomY, e.room), cols.agent - NODE_X, yPx(agentY, e.agent), roomColor(e.room));
  for (const a of agents)
    if (a.modelId) edgeLine(cols.agent + LABEL_W, yPx(agentY, a.id), cols.model - NODE_X, yPx(modelY, a.modelId));

  // Nodes.
  const drawNode = (x, yMap, item, kind, degree, stroke) => {
    const y = yPx(yMap, item.id);
    const g = svgEl('g', { class: `topo-node topo-${kind}${degree === 0 ? ' topo-orphan' : ''}` });
    const c = svgEl('circle', { cx: x, cy: y, r: NODE_X });
    // Match the room node to its edge color (skip orphans — they keep the
    // red-dashed "unused" treatment).
    if (stroke && degree > 0) c.style.stroke = stroke;
    g.appendChild(c);
    const t = svgEl('text', { x: x + 11, y: y + 4, class: 'topo-label' });
    t.textContent = degree > 0 ? `${item.name} · ${degree}` : item.name;
    g.appendChild(t);
    svg.appendChild(g);
  };
  for (const r of rooms) drawNode(cols.room, roomY, r, 'room', (roomAgents.get(r.id) || []).length, roomColor(r.id));
  for (const a of agents) drawNode(cols.agent, agentY, a, 'agent', (agentRooms.get(a.id) || []).length);
  for (const m of models) drawNode(cols.model, modelY, m, 'model', (modelAgents.get(m.id) || []).length);

  canvas.appendChild(svg);
}

// ── Wiring matrix (rooms × agents management console) ──────────────────────
// Same /api/topology data as the graph, rendered as a grid: tap a cell to
// wire/unwire via the existing endpoints. Empty cells make gaps visible. Agents
// shown are those in use (wired somewhere); brand-new unwired agents appear once
// wired via a room's add-agent flow. Plain table — sticky headers, scrolls on
// mobile.
let matrixActive = false;
let matrixWired = new Set(); // "roomId|agentId" for currently-wired pairs
function openMatrix() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  hideOtherFullViews('matrix');
  matrixActive = true;
  $('#chat').hidden = true;
  $('#matrix').hidden = false;
  $('#app').classList.add('in-dashboard');
  $('#app').classList.remove('in-room');
  refreshMatrix();
  openView('matrix', teardownMatrix);
}
function teardownMatrix() {
  matrixActive = false;
  $('#chat').hidden = false;
  $('#matrix').hidden = true;
  $('#app').classList.remove('in-dashboard');
}
function toggleMatrix() {
  if (matrixActive) closeView('matrix');
  else openMatrix();
}
$('#matrix-back')?.addEventListener('click', toggleMatrix);
$('#matrix-refresh')?.addEventListener('click', refreshMatrix);

async function refreshMatrix() {
  const canvas = $('#matrix-canvas');
  if (!canvas) return;
  canvas.textContent = 'Loading…';
  try {
    const r = await authFetch('/api/topology');
    if (!r.ok) {
      canvas.textContent = 'Could not load wiring.';
      return;
    }
    renderMatrix(await r.json());
  } catch {
    canvas.textContent = 'Could not load wiring.';
  }
}

function renderMatrix(data) {
  const canvas = $('#matrix-canvas');
  if (!canvas) return;
  canvas.textContent = '';
  const rooms = data.rooms || [];
  const agents = data.agents || [];
  if (rooms.length === 0 || agents.length === 0) {
    canvas.textContent = 'Nothing to wire yet — create a room and an agent first.';
    return;
  }
  matrixWired = new Set((data.edges || []).map((e) => `${e.room}|${e.agent}`));

  const table = document.createElement('table');
  table.className = 'matrix-table';

  // Header row: corner + one column per agent (name + model chip).
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'matrix-corner';
  corner.textContent = 'Room \\ Agent';
  hr.appendChild(corner);
  for (const a of agents) {
    const th = document.createElement('th');
    th.className = 'matrix-agent-head';
    const name = document.createElement('div');
    name.className = 'matrix-agent-name';
    name.textContent = a.name;
    th.appendChild(name);
    const chip = document.createElement('div');
    chip.className = 'matrix-model-chip' + (a.modelName ? '' : ' none');
    chip.textContent = a.modelName || 'no model';
    th.appendChild(chip);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  // One row per room; cells toggle wiring.
  const tbody = document.createElement('tbody');
  for (const room of rooms) {
    const tr = document.createElement('tr');
    const rh = document.createElement('th');
    rh.className = 'matrix-room-head';
    rh.textContent = room.name;
    tr.appendChild(rh);
    for (const a of agents) {
      const td = document.createElement('td');
      const on = matrixWired.has(`${room.id}|${a.id}`);
      td.className = 'matrix-cell' + (on ? ' on' : '');
      td.dataset.room = room.id;
      td.dataset.agent = a.id;
      td.title = `${room.name} ↔ ${a.name}`;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  canvas.appendChild(table);
}

$('#matrix-canvas')?.addEventListener('click', async (e) => {
  const cell = e.target.closest('.matrix-cell');
  if (!cell || cell.classList.contains('pending')) return;
  const roomId = cell.dataset.room;
  const agentId = cell.dataset.agent;
  const wantWired = !cell.classList.contains('on');
  cell.classList.add('pending');
  cell.classList.toggle('on', wantWired); // optimistic
  try {
    const r = wantWired
      ? await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'existing', id: agentId }),
        })
      : await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
        });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    matrixWired[wantWired ? 'add' : 'delete'](`${roomId}|${agentId}`);
  } catch (err) {
    cell.classList.toggle('on', !wantWired); // revert
    showToast('Could not update wiring: ' + (err.message || err), { kind: 'error' });
  } finally {
    cell.classList.remove('pending');
  }
});

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
let isOwnerView = false; // set by probeIsOwner — gates owner-only write controls (e.g. room assignment)

function openPermissions() {
  closeAgentDetail();
  closeRoomDetail();
  closeModelDetail();
  hideOtherFullViews('permissions');
  permsActive = true;
  $('#chat').hidden = true;
  $('#permissions').hidden = false;
  $('#overflow-btn')?.classList.add('active');
  $('#app').classList.add('in-dashboard');
  $('#app').classList.remove('in-room');
  permsShowList();
  refreshPermissions();
  openView('permissions', teardownPermissions);
}
function teardownPermissions() {
  permsActive = false;
  $('#chat').hidden = false;
  $('#permissions').hidden = true;
  $('#overflow-btn')?.classList.remove('active');
  $('#app').classList.remove('in-dashboard');
}
function togglePermissions() {
  if (permsActive) closeView('permissions');
  else openPermissions();
}

async function probeIsOwner() {
  try {
    const [check, users] = await Promise.all([authFetch('/api/auth/check'), authFetch('/api/users')]);
    if (check.ok) {
      const body = await check.json();
      if (body && typeof body.userId === 'string') myUserId = body.userId;
    }
    if (users.ok) {
      // /api/users is now open to any admin (not just owners), so its success
      // only means "I can see the permissions panel". Reveal the toggle for
      // every admin, but derive true-owner status from my own roles in the
      // response — isOwnerView must stay owner-only since it gates owner-only
      // write controls (e.g. room assignment).
      $('#overflow-permissions').hidden = false;
      const list = await users.json().catch(() => []);
      const me = Array.isArray(list) ? list.find((u) => u.id === myUserId) : null;
      isOwnerView = !!(me && userIsOwner(me));
      return true;
    }
  } catch {}
  isOwnerView = false;
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

let permsUserFilter = ''; // lowercased; filters the user list by name + id

function renderPermsUserList() {
  const list = $('#perms-user-list');
  list.innerHTML = '';
  if (permsUsers.length === 0) {
    list.innerHTML =
      '<li class="perms-empty" style="padding:16px;">No users yet — anyone who authenticates will appear here.</li>';
    return;
  }
  // Sort: you first, then owners, then admins, then everyone else, alphabetical
  // within each tier. Cheap stable enough for personal-scale.
  const sorted = [...permsUsers].sort((a, b) => {
    const tier = (u) =>
      u.id === myUserId ? 0 : userIsOwner(u) ? 1 : userIsGlobalAdmin(u) || userScopedAdminCount(u) ? 2 : 3;
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return userDisplayName(a).localeCompare(userDisplayName(b));
  });
  // Filter by the search box — match on display name AND the namespaced id, so
  // you can find someone by handle/email or by channel prefix (e.g. "slack:").
  const rows = permsUserFilter
    ? sorted.filter((u) => `${userDisplayName(u)} ${u.id}`.toLowerCase().includes(permsUserFilter))
    : sorted;
  if (rows.length === 0) {
    list.innerHTML = '<li class="perms-empty" style="padding:16px;">No users match.</li>';
    return;
  }
  rows.forEach((u) => {
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

$('#perms-user-search')?.addEventListener('input', (e) => {
  permsUserFilter = e.target.value.trim().toLowerCase();
  renderPermsUserList();
});

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
  globalEl.appendChild(
    buildToggleRow(u, 'Owner', '👑 ', findRole(u, 'owner', null), () =>
      togglePerm(u.id, 'owner', null, !findRole(u, 'owner', null)),
    ),
  );
  globalEl.appendChild(
    buildToggleRow(u, 'Global admin', '', findRole(u, 'admin', null), () =>
      togglePerm(u.id, 'admin', null, !findRole(u, 'admin', null)),
    ),
  );

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

  // ── Delete user button ──────────────────────────────────────────────────
  // Always show the danger zone (except for yourself). Disable the button
  // with an explanation if roles or memberships are still present — the
  // server would reject it anyway, but this surfaces the blocker upfront.
  const deleteZone = $('#perms-delete-zone');
  const deleteBtn = $('#perms-delete-btn');
  const isSelf = u.id === myUserId;
  const hasRolesOrMemberships = u.roles.length > 0 || u.memberships.length > 0;
  if (deleteZone) {
    deleteZone.hidden = isSelf;
    if (deleteBtn) {
      deleteBtn.disabled = hasRolesOrMemberships;
      deleteBtn.title = hasRolesOrMemberships ? 'Revoke all roles and memberships before deleting' : '';
    }
  }
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
      showToast('Revoke failed: ' + (err.error || r.statusText), { kind: 'error' });
      return false;
    }
    return true;
  } catch (err) {
    showToast('Revoke failed: ' + err.message, { kind: 'error' });
    return false;
  }
}

async function deleteUser(targetUserId) {
  const confirmed = await showConfirmModal({
    title: 'Delete user',
    body: `Delete ${targetUserId}? This removes the user record. They will be re-added automatically if they authenticate again.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const r = await authFetch(`/api/users/${encodeURIComponent(targetUserId)}`, {
      method: 'DELETE',
      headers: { 'X-Webchat-CSRF': '1' },
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Delete failed: ' + (err.error || r.statusText), { kind: 'error' });
      return;
    }
    showToast(`Deleted user ${targetUserId}.`, { kind: 'success' });
    permsSelectedUserId = null;
    await refreshPermissions();
    permsShowList();
  } catch (err) {
    showToast('Delete failed: ' + err.message, { kind: 'error' });
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
// ── + New User wizard: auth-aware id defaults ────────────────────────────────
// The composed user_id must match EXACTLY what the auth layer mints at login.
// We default the channel prefix to whatever this install actually uses (from
// /api/auth/info) so admins don't, e.g., create a Tailscale-shaped id on an
// SSO/Entra install. Fetched once, best-effort.
let serverAuthMethods = null;
let permsCreateChannelTouched = false;
async function ensureServerAuthMethods() {
  if (serverAuthMethods) return serverAuthMethods;
  try {
    const r = await fetch('/api/auth/info');
    if (r.ok) serverAuthMethods = (await r.json()).methods || null;
  } catch {}
  return serverAuthMethods;
}
// Mirror of normalizeId() in src/channels/webchat/auth.ts — fold a webchat
// handle to the canonical (lowercased, restricted-charset) form so the live
// preview shows the id the server will actually store and match.
function normalizeWebchatHandle(raw) {
  return raw.toLowerCase().replace(/[^a-z0-9._@+-]/g, '-');
}
function applyCreateAuthDefault() {
  const m = serverAuthMethods || {};
  // Don't clobber a prefix the admin picked by hand (the change listener marks
  // it touched); this only steers the untouched default.
  if (!permsCreateChannelTouched) {
    $('#perms-create-channel').value = m.tailscale ? 'webchat:tailscale' : 'webchat';
  }
  const hint = $('#perms-create-method-hint');
  if (m.tailscale) {
    hint.textContent = 'This install signs people in via Tailscale — they appear as webchat:tailscale:<email>.';
  } else if (m.proxy) {
    hint.textContent =
      'This install signs people in via SSO / reverse proxy (e.g. Entra ID) — they appear as webchat:<email>.';
  } else if (m.bearer) {
    hint.textContent =
      'This install uses a shared bearer token — per-user ids only differ when a proxy or Tailscale also fronts it.';
  } else {
    hint.textContent = '';
  }
  permsRefreshCreateUI();
}
function permsShowCreate() {
  $('#perms-body').dataset.mode = 'detail';
  $('#perms-detail-empty').hidden = true;
  $('#perms-detail-view').hidden = true;
  $('#perms-create-view').hidden = false;
  // Reset the wizard fields each time it opens.
  permsCreateChannelTouched = false;
  $('#perms-create-handle').value = '';
  $('#perms-create-raw').value = '';
  $('#perms-create-kind').value = 'member';
  $('#perms-create-group').value = '';
  // Only owners can grant admin/owner roles — hide those options for everyone
  // else so the wizard matches the server's member-only rule for non-owners.
  const me = permsUsers.find((u) => u.id === myUserId);
  const canGrantRoles = !!(me && userIsOwner(me));
  const kindSel = $('#perms-create-kind');
  if (kindSel) {
    kindSel.querySelectorAll('option').forEach((opt) => {
      opt.hidden = !canGrantRoles && opt.value !== 'member';
    });
    if (!canGrantRoles) kindSel.value = 'member';
  }
  applyCreateAuthDefault();
  ensureServerAuthMethods().then(applyCreateAuthDefault);
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
      showToast('Grant failed: ' + (err.error || r.statusText), { kind: 'error' });
      return false;
    }
    return true;
  } catch (err) {
    showToast('Grant failed: ' + err.message, { kind: 'error' });
    return false;
  }
}

async function revokePerm(targetUserId, kind, agentGroupId) {
  const label = `${kind}${agentGroupId ? ' · ' + agentLabel(agentGroupId) : ''}`;
  const confirmed = await showConfirmModal({
    title: 'Revoke access',
    body: `Revoke ${label} from ${targetUserId}?`,
    confirmLabel: 'Revoke',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const r = await authFetch('/api/permissions/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
      body: JSON.stringify({ userId: targetUserId, kind, agentGroupId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showToast('Revoke failed: ' + (err.error || r.statusText), { kind: 'error' });
      return;
    }
    showToast(`Revoked ${label} from ${targetUserId}.`, { kind: 'success' });
    refreshPermissions();
  } catch (err) {
    showToast('Revoke failed: ' + err.message, { kind: 'error' });
  }
}

// Wiring
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
  let handle = $('#perms-create-handle').value.trim();
  if (!handle) return '';
  // Webchat ids are case/charset-folded by the auth layer; fold here too so the
  // preview and the stored grant match the eventual login.
  if (channel === 'webchat' || channel.startsWith('webchat:')) handle = normalizeWebchatHandle(handle);
  return `${channel}:${handle}`;
}
function permsRefreshCreateUI() {
  const channel = $('#perms-create-channel').value;
  const isRaw = channel === '__raw__';
  $('#perms-create-handle-label').hidden = isRaw;
  $('#perms-create-raw-label').hidden = !isRaw;
  const composed = permsCreateComposedId();
  $('#perms-create-preview').textContent = composed ? `Resolved id: ${composed}` : 'Resolved id will appear here.';
  // Show/hide the agent-group selector based on initial-role choice.
  const kind = $('#perms-create-kind').value;
  const wantsGroup = kind === 'admin' || kind === 'member';
  $('#perms-create-group-label').hidden = !wantsGroup;
}
$('#perms-create-channel').addEventListener('change', () => {
  permsCreateChannelTouched = true;
  permsRefreshCreateUI();
});
$('#perms-create-handle').addEventListener('input', permsRefreshCreateUI);
$('#perms-create-raw').addEventListener('input', permsRefreshCreateUI);
$('#perms-create-kind').addEventListener('change', permsRefreshCreateUI);

$('#perms-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = permsCreateComposedId();
  if (!userId) {
    showToast('Enter a handle / email (or pick "raw user_id" and enter the full id).', { kind: 'error' });
    return;
  }
  if (!userId.includes(':')) {
    showToast('user_id must be namespaced (channel:handle).', { kind: 'error' });
    return;
  }
  const kind = $('#perms-create-kind').value;
  const groupVal = $('#perms-create-group').value;
  const agentGroupId = groupVal || null;
  if (kind === 'owner' && agentGroupId) {
    showToast('owner role is always global — pick "— global —".', { kind: 'error' });
    return;
  }
  if (kind === 'member' && !agentGroupId) {
    showToast('member role requires an agent group.', { kind: 'error' });
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
  const all = perRoom
    .flat()
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 50);
  if (all.length === 0) {
    showDetail('Messages (24h)', '<div class="metric-sub">No messages in the last 24 hours</div>');
    return;
  }
  const rows = all
    .map((m) => {
      const time = new Date(m.created_at).toLocaleTimeString();
      const icon = m.sender_type === 'agent' ? lucide('bot') : lucide('user');
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
// Archived agents are hidden by default (server-side). The Agents tab can opt
// in to see them so they can be unarchived; pickers/topology never do.
let showArchivedAgents = false;

async function fetchAgents() {
  try {
    const res = await authFetch('/api/agents' + (showArchivedAgents ? '?includeArchived=1' : ''));
    allAgents = await res.json();
    renderAgents();
  } catch (err) {
    console.error('Failed to fetch agents:', err);
  }
}

// Status labels + the one-line hint shown under the detail control.
const AGENT_STATUS_HINTS = {
  active: 'Responds normally and appears everywhere.',
  paused: 'Wiring is kept, but the agent never responds. Still listed.',
  archived: 'Retired: never responds and hidden from lists, pickers, and the map.',
};

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
    icon.innerHTML = lucide('bot');
    li.appendChild(icon);

    const info = document.createElement('span');
    info.className = 'agent-info';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'agent-info-name';
    nameSpan.textContent = agent.name;
    info.appendChild(nameSpan);
    // Badge for any non-active state so paused/archived agents read at a glance.
    const status = agent.status || 'active';
    if (status !== 'active') {
      const badge = document.createElement('span');
      badge.className = 'agent-status-badge status-' + status;
      badge.textContent = status;
      info.appendChild(badge);
    }
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

  // "Show / hide archived" toggle. Always available from the Agents tab so
  // archived agents can be brought back; pickers and the map never show them.
  const toggle = $('#agent-show-archived');
  if (toggle) {
    toggle.hidden = false;
    toggle.textContent = showArchivedAgents ? 'Hide archived agents' : 'Show archived agents';
  }
}

// Reflect the agent's status on the 3-button segmented control + hint.
function setAgentStatusControl(status) {
  const s = status || 'active';
  document.querySelectorAll('#agent-status-control .agent-status-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === s);
  });
  const hint = $('#agent-status-hint');
  if (hint) hint.textContent = AGENT_STATUS_HINTS[s] || '';
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

  setAgentStatusControl(agent.status);

  // Load instructions
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(id)}/instructions`);
    if (res.ok) {
      const { content } = await res.json();
      $('#agent-instructions').value = content;
    }
  } catch {}

  // Rooms this agent is wired to (assign / unassign).
  await loadAgentRooms(id);

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

// Status control: each button PUTs the new status, then refreshes the list so
// the badge + (if archived) visibility update immediately.
$('#agent-status-control').addEventListener('click', async (e) => {
  const btn = e.target.closest('.agent-status-btn');
  if (!btn || !selectedAgentId) return;
  const status = btn.dataset.status;
  const agent = allAgents.find((b) => b.id === selectedAgentId);
  if (agent && (agent.status || 'active') === status) return;
  setAgentStatusControl(status); // optimistic
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error('status ' + res.status);
    if (agent) agent.status = status;
    showToast(`Agent ${status === 'active' ? 'activated' : status}`);
    renderAgents();
  } catch (err) {
    console.error('Failed to set agent status:', err);
    showToast('Could not change status');
    if (agent) setAgentStatusControl(agent.status); // revert
  }
});

// Show / hide archived agents in the list.
$('#agent-show-archived').addEventListener('click', async () => {
  showArchivedAgents = !showArchivedAgents;
  await fetchAgents();
});

// ── Agent ↔ Room wiring (agent-centric; mirror of the room-detail panel) ──────
// Read = GET /api/agents/:id/rooms (any admin of the agent). Writes go to
// POST/DELETE /api/rooms/:roomId/agents, which allow owners plus scoped admins
// of this agent (the backend enforces per-room access). The GET succeeding
// (res.ok) already means the caller administers this agent, so we reuse it as
// the signal for showing the assign / remove controls — no owner-only gate.
let agentDetailRooms = [];
let canManageAgentRooms = false;

async function loadAgentRooms(agentId) {
  $('#agent-add-room-form').hidden = true;
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(agentId)}/rooms`);
    canManageAgentRooms = res.ok;
    agentDetailRooms = res.ok ? await res.json() : [];
  } catch {
    canManageAgentRooms = false;
    agentDetailRooms = [];
  }
  renderAgentWiredRooms();
  $('#agent-rooms-section').hidden = false;
}

function renderAgentWiredRooms() {
  const list = $('#agent-wired-rooms');
  list.innerHTML = '';
  if (agentDetailRooms.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'Not assigned to any room yet.';
    list.appendChild(li);
  }
  for (const room of agentDetailRooms) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'room-wired-name';
    name.textContent = room.name;
    if (room.is_prime) {
      const badge = document.createElement('span');
      badge.className = 'room-wired-prime-badge';
      badge.textContent = ' default';
      name.appendChild(badge);
    }
    li.appendChild(name);
    if (canManageAgentRooms) {
      const onlyAgent = room.agent_count <= 1;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'room-wired-remove';
      removeBtn.innerHTML = lucide('x');
      removeBtn.title = onlyAgent
        ? "Cannot unassign — this agent is the room's only agent (delete the room instead)"
        : `Remove this agent from ${room.name}`;
      removeBtn.disabled = onlyAgent;
      removeBtn.addEventListener('click', () => removeRoomFromAgent(room.id, room.name));
      li.appendChild(removeBtn);
    }
    list.appendChild(li);
  }
  // Assign control: any admin of this agent (owner or scoped). The backend
  // limits the actual targets to rooms the caller can access.
  $('#agent-add-room-toggle').hidden = !canManageAgentRooms;
}

async function populateAssignRoomSelect() {
  let rooms = [];
  try {
    const res = await authFetch('/api/rooms');
    rooms = res.ok ? await res.json() : [];
  } catch {}
  const wiredIds = new Set(agentDetailRooms.map((r) => r.id));
  const candidates = rooms.filter((r) => !wiredIds.has(r.id));
  const list = $('#agent-add-room-list');
  list.innerHTML = '';
  if (candidates.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = 'Already assigned to every room.';
    list.appendChild(li);
    updateAssignRoomSubmit();
    return;
  }
  const sorted = [...candidates].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  for (const room of sorted) {
    const li = document.createElement('li');
    li.className = 'room-add-agent-row';
    li.dataset.roomName = (room.name || room.id).toLowerCase();
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = room.id;
    cb.id = `agent-add-room-${room.id}`;
    cb.addEventListener('change', updateAssignRoomSubmit);
    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.textContent = room.name;
    li.appendChild(cb);
    li.appendChild(lbl);
    list.appendChild(li);
  }
  updateAssignRoomSubmit();
}

function updateAssignRoomSubmit() {
  const n = $('#agent-add-room-list').querySelectorAll('input[type=checkbox]:checked').length;
  const btn = $('#agent-add-room-submit');
  btn.disabled = n === 0;
  btn.textContent = n === 0 ? 'Wire selected' : `Wire ${n} room${n === 1 ? '' : 's'}`;
}

async function assignSelectedRooms() {
  if (!selectedAgentId) return;
  const checked = [...$('#agent-add-room-list').querySelectorAll('input[type=checkbox]:checked')];
  const roomIds = checked.map((cb) => cb.value);
  if (roomIds.length === 0) return;
  $('#agent-add-room-submit').disabled = true;
  try {
    for (const roomId of roomIds) {
      const res = await authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'existing', id: selectedAgentId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast('Failed to assign room: ' + (err.error || res.statusText), { kind: 'error' });
        break;
      }
    }
  } finally {
    $('#agent-add-room-form').hidden = true;
    await loadAgentRooms(selectedAgentId);
  }
}

async function removeRoomFromAgent(roomId, roomName) {
  if (!selectedAgentId) return;
  const confirmed = await showConfirmModal({
    title: 'Remove from room',
    body: `Remove this agent from "${roomName}"? The room and its other agents are unaffected.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const res = await authFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(selectedAgentId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Failed to remove from room: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    showToast(`Removed from "${roomName}".`, { kind: 'success' });
    await loadAgentRooms(selectedAgentId);
  } catch (err) {
    showToast('Failed to remove from room: ' + err.message, { kind: 'error' });
  }
}

// Filter the assign-room checklist by typed text. Hides/shows rows rather than
// re-rendering, so checkbox selections survive filtering.
function filterAssignRoomList(text) {
  const q = (text || '').trim().toLowerCase();
  for (const li of $('#agent-add-room-list').querySelectorAll('li.room-add-agent-row')) {
    li.hidden = q !== '' && !(li.dataset.roomName || '').includes(q);
  }
}

$('#agent-add-room-toggle').addEventListener('click', async () => {
  const form = $('#agent-add-room-form');
  if (form.hidden) {
    await populateAssignRoomSelect();
    $('#agent-add-room-search').value = '';
    filterAssignRoomList('');
    form.hidden = false;
    $('#agent-add-room-search').focus();
  } else {
    form.hidden = true;
  }
});
$('#agent-add-room-search').addEventListener('input', (e) => filterAssignRoomList(e.target.value));
$('#agent-add-room-submit').addEventListener('click', assignSelectedRooms);

// Save existing agent
$('#agent-detail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedAgentId) return;
  const btn = $('#agent-detail-form button.btn-primary');
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
    const currentModel = allAgents.find((b) => b.id === selectedAgentId)?.assigned_model_id || null;
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
    showToast('Failed to save agent: ' + (err.message || 'Unknown error'), { kind: 'error' });
    btn.textContent = originalLabel;
    btn.classList.remove('success');
    btn.disabled = false;
  }
});

// Delete agent
$('#agent-delete').addEventListener('click', async () => {
  if (!selectedAgentId) return;
  const agent = allAgents.find((b) => b.id === selectedAgentId);
  const confirmed = await showConfirmModal({
    title: 'Delete agent',
    body: `Delete "${agent?.name}"? This removes the agent, its workspace, and all session history. This cannot be undone.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const res = await authFetch(`/api/agents/${encodeURIComponent(selectedAgentId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`Failed to delete agent: ${err.error || res.statusText}`, { kind: 'error' });
      return;
    }
    showToast(`Deleted "${agent?.name}".`, { kind: 'success' });
    closeAgentDetail();
    await fetchAgents();
  } catch (err) {
    showToast(`Failed to delete agent: ${err.message}`, { kind: 'error' });
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
      showToast('Failed to create agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    await fetchAgents();
    closeAgentDetail();
  } catch (err) {
    showToast('Failed to create agent: ' + err.message, { kind: 'error' });
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
    showToast('Type a description first, e.g. "An agent that helps me draft replies to emails".', { kind: 'error' });
    return;
  }
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = lucide('sparkles') + ' Drafting…';
  try {
    const res = await authFetch('/api/agents/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast('Drafter failed: ' + (body.error || res.statusText), { kind: 'error' });
      return;
    }
    if (nameEl) nameEl.value = body.name || '';
    if (instructionsEl) instructionsEl.value = body.instructions || '';
    nameEl?.focus();
    nameEl?.select();
  } catch (err) {
    showToast('Drafter failed: ' + err.message, { kind: 'error' });
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ── Room management ─────────────────────────────────────────────────────────

let selectedRoomId = null;
let roomDetailWiredAgents = [];

function showRoomSettingsToggle(visible) {
  // The room name itself is the settings affordance (Telegram/WhatsApp pattern);
  // `.has-settings` adds the pointer + chevron and gates the click.
  $('#room-name').classList.toggle('has-settings', visible);
}

async function openRoomDetail(roomId) {
  selectedRoomId = roomId;
  closeAgentDetail();
  $('#room-create-view').hidden = true;
  $('#room-edit-view').hidden = false;

  const room = lastRoomsList.find((r) => r.id === roomId);
  $('#room-detail-title').textContent = room ? `${room.name} — settings` : 'Room settings';

  // Rename field — owner-only (the server also enforces). Prefilled with the
  // current name; saving PUTs /name and the server's broadcastRooms refreshes
  // the sidebar + this panel's title.
  const renameField = $('#room-rename-field');
  if (isOwnerView && room) {
    renameField.hidden = false;
    $('#room-rename-input').value = room.name || '';
  } else {
    renameField.hidden = true;
  }

  // Hide the add-agent form when opening
  $('#room-add-agent-form').hidden = true;

  // Archive toggle: server tells us per room whether the caller can
  // archive (owner / admin / scoped-admin-of-wired-agent). Show the
  // button only when allowed; flip label based on current state.
  const archiveBtn = $('#room-archive-toggle');
  if (room && room.canArchive) {
    archiveBtn.hidden = false;
    archiveBtn.textContent = room.archived ? 'Unarchive Room' : 'Archive Room';
  } else {
    archiveBtn.hidden = true;
  }

  await refreshRoomWiredAgents(roomId);

  // BYOK credential-mode selector — admin/owner only (canArchive implies that).
  const credSection = $('#room-credential-mode-section');
  if (credSection) {
    if (room && room.canArchive) {
      credSection.hidden = false;
      authFetch(`/api/rooms/${encodeURIComponent(roomId)}/credential-mode`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          // d.mode is the per-room override ('inherit' when unset); d.defaultMode
          // is the workspace default shown on the Default option.
          const radio = document.querySelector(`input[name="room-credential-mode"][value="${d.mode}"]`);
          if (radio) radio.checked = true;
          const hint = $('#room-cred-default-hint');
          if (hint) hint.textContent = d.defaultMode ? `(${d.defaultMode})` : '';
        })
        .catch(() => {});
    } else {
      credSection.hidden = true;
    }
  }

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

// Rename the selected room. Owner-only (the field is hidden otherwise, and the
// server re-checks). The server's broadcastRooms() pushes the new name, so the
// sidebar + panel title update via the 'rooms' handler — no manual refresh.
async function saveRoomName() {
  const id = selectedRoomId;
  if (!id) return;
  const name = $('#room-rename-input').value.trim();
  if (!name) {
    showToast('Enter a room name', { kind: 'error' });
    return;
  }
  try {
    const r = await authFetch(`/api/rooms/${encodeURIComponent(id)}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    showToast('Room renamed', { kind: 'success' });
  } catch (err) {
    showToast('Rename failed: ' + (err.message || err), { kind: 'error' });
  }
}

// Engage mode for the currently-loaded room. Populated alongside the agents
// list. Two values surface here: 'mention-only' (default — only @-mentioned
// agents fire) and 'broadcast' (legacy — every agent fires on every message).
// The PWA never sets 'broadcast'; operators who want it can hit the API
// directly. Mode-aware rendering is in renderRoomWiredAgents.
let roomDetailEngageMode = 'mention-only';

async function refreshRoomWiredAgents(roomId) {
  try {
    const [agentsRes, modeRes] = await Promise.all([
      authFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents`),
      authFetch(`/api/rooms/${encodeURIComponent(roomId)}/engage-mode`),
    ]);
    roomDetailWiredAgents = await agentsRes.json();
    const modeBody = await modeRes.json().catch(() => ({ mode: 'mention-only' }));
    roomDetailEngageMode = modeBody.mode === 'broadcast' ? 'broadcast' : 'mention-only';
  } catch (err) {
    console.error('Failed to fetch wired agents:', err);
    roomDetailWiredAgents = [];
    roomDetailEngageMode = 'mention-only';
  }
  renderRoomWiredAgents();
  await populateAddAgentSelect();
}

function renderRoomWiredAgents() {
  const list = $('#room-wired-agents');
  list.innerHTML = '';
  const anyPrime = roomDetailWiredAgents.some((a) => a.is_prime);
  // The effective mode the operator sees: prime if anyone's starred, otherwise
  // whatever engage_default is set to. With this build's UI never producing
  // 'broadcast', the no-prime case is 'mention-only' in practice.
  const effectiveMode = anyPrime ? 'prime' : roomDetailEngageMode;
  for (const agent of roomDetailWiredAgents) {
    const li = document.createElement('li');

    // Prime toggle (★) — clicking sets this agent as prime, or clears if already prime.
    // Always shown now: even a single-agent room in mention-only mode benefits
    // from showing the toggle, because clicking ★ flips the room into prime
    // mode (the one agent then answers everything, regardless of @-mention).
    const primeBtn = document.createElement('button');
    primeBtn.type = 'button';
    primeBtn.className = 'room-wired-prime' + (agent.is_prime ? ' active' : '');
    primeBtn.innerHTML = agent.is_prime ? lucide('star', 'icon--fill') : lucide('star');
    primeBtn.title = agent.is_prime
      ? `Stop ${agent.name} replying to everything — back to only when @-mentioned`
      : `Make ${agent.name} the default — replies to all messages (not just @-mentions)`;
    primeBtn.addEventListener('click', () => togglePrimeAgent(agent));
    li.appendChild(primeBtn);

    const onlyOne = roomDetailWiredAgents.length <= 1;
    const name = document.createElement('span');
    name.className = 'room-wired-name';
    name.textContent = agent.name;
    if (agent.is_prime) {
      const badge = document.createElement('span');
      badge.className = 'room-wired-prime-badge';
      badge.textContent = ' default';
      name.appendChild(badge);
    }
    li.appendChild(name);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'room-wired-remove';
    removeBtn.innerHTML = lucide('x');
    removeBtn.title = onlyOne ? 'Cannot remove the last agent (delete the room instead)' : `Remove ${agent.name}`;
    removeBtn.disabled = onlyOne;
    removeBtn.addEventListener('click', () => removeAgentFromRoom(agent.id, agent.name));
    li.appendChild(removeBtn);

    list.appendChild(li);
  }

  // Mode indicator pill above the helper note — shows the current engage state
  // at a glance so the operator never has to infer it from "is anything starred".
  let badge = $('#room-mode-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'room-mode-badge';
    badge.className = 'room-mode-badge';
    list.parentElement?.insertBefore(badge, list.nextSibling);
  }
  badge.className = `room-mode-badge mode-${effectiveMode}`;
  badge.textContent =
    effectiveMode === 'prime'
      ? `Replies to everything: ${roomDetailWiredAgents.find((a) => a.is_prime)?.name ?? 'unknown'}`
      : effectiveMode === 'broadcast'
        ? 'All agents reply to every message (legacy)'
        : 'Only replies when @-mentioned';

  // Helper line below the badge explains what the mode does. Always shown so
  // the operator's mental model stays current as they ★ / unstar.
  let note = $('#room-prime-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'room-prime-note';
    note.className = 'room-prime-note';
    list.parentElement?.insertBefore(note, badge.nextSibling);
  }
  note.hidden = false;
  note.textContent =
    effectiveMode === 'prime'
      ? 'The default agent replies to every message — except ones that @-mention a different agent.'
      : effectiveMode === 'broadcast'
        ? 'Every wired agent responds to every message. (Legacy mode — not produced by this UI.)'
        : 'Agents reply only when @-mentioned. Star an agent to make it the default (replies to everything).';
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
      showToast('Could not update the default agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    await refreshRoomWiredAgents(selectedRoomId);
  } catch (err) {
    showToast('Could not update the default agent: ' + err.message, { kind: 'error' });
  }
}

async function populateAddAgentSelect() {
  // Make sure allAgents is fresh for the picker (avoid showing stale list).
  if (allAgents.length === 0) await fetchAgents();
  const wiredIds = new Set(roomDetailWiredAgents.map((a) => a.id));
  // Never offer archived agents for wiring (even if the list toggle is on).
  const candidates = allAgents.filter((a) => !wiredIds.has(a.id) && a.status !== 'archived');
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
  btn.textContent = n > 0 ? `Wire selected (${n})` : 'Wire selected';
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
      showToast('Failed to add agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    $('#room-add-agent-form').hidden = true;
    $('#room-add-agent-new-name').value = '';
    $('#room-add-agent-new-instructions').value = '';
    // Refresh agents (in case a new one was created), then re-render wirings.
    await fetchAgents();
    await refreshRoomWiredAgents(roomId);
  } catch (err) {
    showToast('Failed to add agent: ' + err.message, { kind: 'error' });
  }
}

async function removeAgentFromRoom(agentId, agentName) {
  if (!selectedRoomId) return;
  const confirmed = await showConfirmModal({
    title: 'Remove agent',
    body: `Remove "${agentName}" from this room? The agent itself will not be deleted.`,
    confirmLabel: 'Remove',
    destructive: true,
  });
  if (!confirmed) return;
  try {
    const res = await authFetch(
      `/api/rooms/${encodeURIComponent(selectedRoomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Failed to remove agent: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    showToast(`Removed "${agentName}" from the room.`, { kind: 'success' });
    await refreshRoomWiredAgents(selectedRoomId);
  } catch (err) {
    showToast('Failed to remove agent: ' + err.message, { kind: 'error' });
  }
}

async function deleteCurrentRoom() {
  if (!selectedRoomId) return;
  const room = lastRoomsList.find((r) => r.id === selectedRoomId);
  const label = room ? room.name : selectedRoomId;
  const confirmed = await showConfirmModal({
    title: 'Delete room',
    body: `Delete room "${label}"? Wired agents will be preserved — delete them separately if you want them gone.`,
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!confirmed) return;
  const roomToClose = selectedRoomId;
  try {
    const res = await authFetch(`/api/rooms/${encodeURIComponent(roomToClose)}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Failed to delete room: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    showToast(`Deleted room "${label}".`, { kind: 'success' });
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
    showToast('Failed to delete room: ' + err.message, { kind: 'error' });
  }
}

// Wire up room-detail UI.
// Tapping the room name opens/closes room settings (frees the chat-header slot
// and kills the duplicate ⚙). Keyboard-accessible since it's a role="button".
function toggleRoomSettings() {
  if (!currentRoom) return;
  if (selectedRoomId === currentRoom && !$('#room-detail').hidden) closeRoomDetail();
  else openRoomDetail(currentRoom);
}
$('#room-name').addEventListener('click', toggleRoomSettings);
$('#room-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleRoomSettings();
  }
});
$('#room-detail-close').addEventListener('click', closeRoomDetail);
$('#room-delete').addEventListener('click', deleteCurrentRoom);
$('#room-credential-modes')?.addEventListener('change', async (e) => {
  if (!selectedRoomId || e.target.name !== 'room-credential-mode') return;
  const mode = e.target.value;
  const r = await authFetch(`/api/rooms/${encodeURIComponent(selectedRoomId)}/credential-mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Webchat-CSRF': '1' },
    body: JSON.stringify({ mode }),
  });
  if (r.ok) {
    showToast(`Member credentials set to "${mode}".`, { kind: 'success' });
    if (selectedRoomId === currentRoom) updateByokBanner(currentRoom);
  } else {
    const err = await r.json().catch(() => ({}));
    showToast('Failed to set mode: ' + (err.error || r.statusText), { kind: 'error' });
  }
});
// Per-room credential TYPES moved to Settings → Member credentials (global); the
// room only sets the mode override above.
$('#room-rename-save')?.addEventListener('click', saveRoomName);
$('#room-rename-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveRoomName();
  }
});
$('#room-archive-toggle').addEventListener('click', async () => {
  if (!selectedRoomId) return;
  const room = lastRoomsList.find((r) => r.id === selectedRoomId);
  if (!room) return;
  await toggleRoomArchive(selectedRoomId, !room.archived);
  // Refresh the panel so the button label flips.
  if (!$('#room-detail').hidden) openRoomDetail(selectedRoomId);
});
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
  const sorted = [...allAgents].filter((a) => a.status !== 'archived').sort((a, b) => a.name.localeCompare(b.name));
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
$('#archived-toggle').addEventListener('click', () => {
  showArchived = !showArchived;
  sessionStorage.setItem('webchat:showArchived', showArchived ? '1' : '0');
  if (lastRoomsList.length) renderRooms(lastRoomsList);
});
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
    showToast('Pick at least one existing agent or create a new one inline.', { kind: 'error' });
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
      showToast('Failed to create room: ' + (err.error || res.statusText), { kind: 'error' });
      return;
    }
    const body = await res.json();
    closeRoomDetail();
    await fetchAgents();
    // The broadcastRooms() server-side will push the updated list via WS,
    // but join immediately so the user lands in the new room.
    if (body.room) joinRoom(body.room.id, body.room.name);
  } catch (err) {
    showToast('Failed to create room: ' + err.message, { kind: 'error' });
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
  const userTypers = entries.filter(([, v]) => v.identity_type !== 'agent');
  const typingAgents = entries.filter(([, v]) => v.identity_type === 'agent').map(([n]) => n);

  // Per-agent thinking bubbles persist while EITHER an authoritative status turn
  // owns them (data-statusLive, cleared by removal on 'done') OR the heartbeat
  // typing signal says that agent is working (covers pre-status warm containers).
  // So a quiet typing stretch never drops a live turn's bubble. Ensure a bubble
  // for each typing agent; remove only bubbles that are neither status-live nor
  // currently typing.
  for (const name of typingAgents) {
    if (!bubbleFor(name)) ensureThinkingBubble(name);
  }
  for (const b of document.querySelectorAll('#messages .thinking-bubble')) {
    if (b.dataset.statusLive === '1') continue;
    if (typingAgents.includes(b.dataset.agent)) continue;
    b.remove();
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

// Status frames carry fine-grained turn activity from the agent (see
// src/channels/webchat/index.ts sendStatus). `event` is the kind:
//   start     → a turn began; show the bubble and keep it up until done/stalled
//   tool      → text = tool name, detail = target (file/command/query)
//   progress  → text = milestone message
//   reasoning → text = a reasoning summary line (rendered by the fading feed)
//   done      → turn finished cleanly; clear the bubble
//   stalled   → turn ended abnormally (agent died/killed); notice + clear
function handleStatusEvent(msg) {
  if (msg.room_id !== currentRoom) return;
  // Each frame names its agent (host stamps agent_name); fall back to the room's
  // single agent name so old/unattributed frames still land on one bubble.
  const name = msg.agent_name || agentName || 'Agent';
  switch (msg.event) {
    case 'start':
      beginAgentTurn(name);
      break;
    case 'tool': {
      markTurnActivity(name);
      const verb = msg.text ? TOOL_LABELS[msg.text] || `Using ${msg.text}` : 'Working';
      updateThinkingBubble(name, verb, msg.detail || null);
      break;
    }
    case 'progress':
      markTurnActivity(name);
      if (msg.text) setThinkingMilestone(name, msg.text);
      break;
    case 'reasoning':
      markTurnActivity(name);
      if (msg.text) pushReasoning(name, msg.text);
      break;
    case 'done':
      endAgentTurn(name);
      break;
    case 'stalled':
      endAgentTurn(name);
      appendSystem(msg.text || 'The agent stopped responding. You may want to resend your message.');
      break;
  }
}

// ── Turn liveness ─────────────────────────────────────────────────────────
// The thinking bubble is tied to the actual turn lifecycle (start → done/
// stalled), NOT the heartbeat-driven typing signal — so it stays up through
// long quiet operations and only clears on a real terminal signal. While a
// turn is active an elapsed counter ticks so liveness is always explicit.
// Per-agent turn state lives ON each bubble element (._turn = {startedAt,
// lastActivityAt, reasoningLog}), keyed by agent name (data-agent). A
// multi-agent room shows one bubble per agent instead of interleaving everyone's
// activity into one; a single-agent room is unchanged. One shared ticker updates
// every live bubble's elapsed counter.
const TURN_QUIET_MS = 5000; // after this much silence, say "still working"
const REASONING_LOG_MAX = 500; // cap a single agent's retained reasoning lines
let turnElapsedTimer = null;

// Selector-safe lookup of a specific agent's bubble.
function bubbleFor(name) {
  const k = window.CSS && CSS.escape ? CSS.escape(name || 'Agent') : name || 'Agent';
  return $(`#messages .thinking-bubble[data-agent="${k}"]`);
}
function ensureElapsedTimer() {
  if (!turnElapsedTimer) turnElapsedTimer = setInterval(updateTurnElapsed, 1000);
}

function beginAgentTurn(name) {
  const bubble = ensureThinkingBubble(name);
  bubble._turn = { startedAt: Date.now(), lastActivityAt: Date.now(), reasoningLog: [] };
  // Mark the bubble as owned by an active status turn so the typing-heartbeat
  // path won't remove it during a quiet stretch; cleared by removal on 'done'.
  bubble.dataset.statusLive = '1';
  ensureElapsedTimer();
  updateTurnElapsed();
  return bubble;
}

function endAgentTurn(name) {
  const bubble = bubbleFor(name);
  if (bubble) bubble.remove();
  if (turnElapsedTimer && !$('#messages .thinking-bubble')) {
    clearInterval(turnElapsedTimer);
    turnElapsedTimer = null;
  }
}

// Remove every agent's bubble (room switch / reset).
function endAllAgentTurns() {
  for (const b of document.querySelectorAll('#messages .thinking-bubble')) b.remove();
  if (turnElapsedTimer) {
    clearInterval(turnElapsedTimer);
    turnElapsedTimer = null;
  }
}

function markTurnActivity(name) {
  const bubble = bubbleFor(name);
  if (bubble && bubble._turn) bubble._turn.lastActivityAt = Date.now();
}

function updateTurnElapsed() {
  let any = false;
  for (const bubble of document.querySelectorAll('#messages .thinking-bubble')) {
    any = true;
    const t = bubble._turn;
    const el = bubble.querySelector('.thinking-elapsed');
    if (!t || !el) continue;
    const secs = Math.floor((Date.now() - t.startedAt) / 1000);
    if (secs < 2) {
      el.textContent = '';
      continue;
    }
    const quiet = Date.now() - t.lastActivityAt > TURN_QUIET_MS;
    el.textContent = quiet ? ` · still working ${secs}s` : ` · ${secs}s`;
  }
  if (!any && turnElapsedTimer) {
    clearInterval(turnElapsedTimer);
    turnElapsedTimer = null;
  }
}

const THINKING_DETAIL_MAX = 64;

// Interrupt ONE agent's in-progress turn (per-agent Stop) — sends a "stop" over
// the WS targeting that agent (the host resolves the name to its session). The
// GUI equivalent of the CLI's ESC. Removes that agent's bubble optimistically;
// the host's stream-abort + 'done' keep it gone.
function interruptAgent(name) {
  if (!currentRoom || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'interrupt', room_id: currentRoom, agent_name: name || null }));
  endAgentTurn(name);
  appendSystem(name ? `Stopped ${name}.` : 'Stopped.');
}

// Ensure the thinking bubble exists and is laid out with: a verb in the sender
// line, a target line (the file/command/query), a milestone line (latest
// progress), and the animated dots. Shared with the heartbeat typing path —
// both create-or-reuse the single `.thinking-bubble`, so activity persists
// through the turn and clears when the agent's message lands.
function ensureThinkingBubble(name) {
  const key = name || agentName || 'Agent';
  let bubble = bubbleFor(key);
  if (bubble) return bubble;
  // Same shouldScroll formula as the 'message' handler — honors forceScrollCount
  // so the bubble follows even when a smooth scroll is still mid-animation.
  const shouldScroll = isNearBottom() || (forceScrollCount > 0 && !userScrolledAway);
  bubble = document.createElement('div');
  bubble.className = 'msg agent thinking-bubble';
  bubble.dataset.agent = key; // one bubble per agent, keyed by name
  bubble._turn = { startedAt: Date.now(), lastActivityAt: Date.now(), reasoningLog: [] };
  // Sender line: icon + "{agent} — " + a verb span (refined by tool events) +
  // an elapsed span (ticked while the turn is active). Verb/elapsed live in
  // their own spans so each updates without clobbering the other.
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.appendChild(lucideEl('bot'));
  sender.appendChild(document.createTextNode(` ${key} — `));
  const verb = document.createElement('span');
  verb.className = 'thinking-verb';
  verb.textContent = 'Thinking';
  sender.appendChild(verb);
  const elapsed = document.createElement('span');
  elapsed.className = 'thinking-elapsed';
  sender.appendChild(elapsed);
  // Chevron affordance — the bubble is click-to-expand into the full trace.
  const chevron = document.createElement('span');
  chevron.className = 'thinking-chevron';
  chevron.appendChild(lucideEl('chevron-right'));
  sender.appendChild(chevron);
  // Stop button — interrupt the in-progress turn (the GUI equivalent of CLI ESC).
  // stopPropagation so it doesn't also fire the bubble's expand-toggle handler.
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'thinking-stop';
  stop.title = 'Stop the agent';
  stop.setAttribute('aria-label', 'Stop the agent');
  stop.innerHTML = '<span class="stop-square" aria-hidden="true"></span>Stop';
  stop.addEventListener('click', (e) => {
    e.stopPropagation();
    interruptAgent(key);
  });
  sender.appendChild(stop);
  bubble.appendChild(sender);
  const content = document.createElement('div');
  content.className = 'bubble';
  // .thinking-feed = compact fading window (collapsed view); .thinking-fulltrace
  // = the whole turn's reasoning, scrollable (expanded view). CSS swaps them on
  // the bubble's .expanded class.
  content.innerHTML =
    '<div class="thinking-milestone" hidden></div>' +
    '<div class="thinking-target" hidden></div>' +
    '<div class="thinking-feed" hidden></div>' +
    '<div class="thinking-fulltrace"></div>' +
    '<span class="dots"><span></span><span></span><span></span></span>';
  bubble.appendChild(content);
  // Click toggles the full reasoning trace. Ignore clicks on links/buttons so
  // selecting text or tapping a link inside doesn't toggle.
  bubble.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    toggleThinkingExpanded(bubble);
  });
  $('#messages').appendChild(bubble);
  if (shouldScroll) scrollToBottom();
  return bubble;
}

// Toggle the bubble between the compact fading feed and the full scrollable
// reasoning trace. Rebuilds the trace from reasoningLog on expand so it always
// reflects everything captured this turn.
function toggleThinkingExpanded(bubble) {
  const expanded = bubble.classList.toggle('expanded');
  if (expanded) renderFullTrace(bubble);
}

function renderFullTrace(bubble) {
  const el = bubble.querySelector('.thinking-fulltrace');
  if (!el) return;
  const log = (bubble._turn && bubble._turn.reasoningLog) || [];
  if (log.length === 0) {
    el.textContent = 'No reasoning captured for this turn yet.';
  } else {
    el.textContent = '';
    for (const line of log) {
      const row = document.createElement('div');
      row.className = 'thinking-fulltrace-line';
      row.textContent = line;
      el.appendChild(row);
    }
  }
  el.scrollTop = el.scrollHeight;
}

function updateThinkingBubble(name, label, detail) {
  const bubble = ensureThinkingBubble(name);
  const verbEl = bubble.querySelector('.thinking-verb');
  if (verbEl) verbEl.textContent = label;
  const target = bubble.querySelector('.thinking-target');
  if (target) {
    if (detail) {
      const trimmed = detail.length > THINKING_DETAIL_MAX ? `${detail.slice(0, THINKING_DETAIL_MAX - 1)}…` : detail;
      target.textContent = trimmed;
      target.hidden = false;
    } else {
      target.hidden = true;
    }
  }
}

function setThinkingMilestone(name, text) {
  const bubble = ensureThinkingBubble(name);
  const el = bubble.querySelector('.thinking-milestone');
  if (el) {
    el.textContent = text;
    el.hidden = false;
  }
}

const REASONING_FEED_BUFFER = 40; // max lines kept in the DOM (scroll history)
const REASONING_FEED_TTL = 7000; // ms a line lingers before it fades out
const REASONING_FADE_MS = 500; // fade-out transition duration (matches CSS)

// Append one reasoning line to the bubble's feed. The feed is a fixed-height
// window (CSS max-height + overflow): new lines land at the bottom and the
// window auto-scrolls to follow, so longer reasoning scrolls upward and fades
// under the top gradient mask. Each line also self-fades after REASONING_FEED_TTL
// so the feed drains when reasoning pauses; the whole thing clears with the
// bubble when the agent's message lands. A bounded DOM buffer caps memory.
function pushReasoning(name, text) {
  const bubble = ensureThinkingBubble(name);
  if (!bubble._turn) bubble._turn = { startedAt: Date.now(), lastActivityAt: Date.now(), reasoningLog: [] };

  // Retain the full line for the click-to-expand view and the reply disclosure.
  bubble._turn.reasoningLog.push(text);
  if (bubble._turn.reasoningLog.length > REASONING_LOG_MAX) bubble._turn.reasoningLog.shift();
  // If the user is currently viewing the expanded trace, keep it live.
  if (bubble.classList.contains('expanded')) renderFullTrace(bubble);

  const feed = bubble.querySelector('.thinking-feed');
  if (!feed) return;
  feed.hidden = false;

  const line = document.createElement('div');
  line.className = 'thinking-feed-line';
  line.textContent = text;
  feed.appendChild(line);

  // Trim the DOM buffer — drop the oldest (already scrolled out of view),
  // cancelling its pending fade timer so it can't fire after removal.
  while (feed.children.length > REASONING_FEED_BUFFER) {
    const oldest = feed.firstChild;
    if (oldest._fadeTimer) clearTimeout(oldest._fadeTimer);
    feed.removeChild(oldest);
  }

  // Follow the newest line within the feed's own scroll viewport.
  feed.scrollTop = feed.scrollHeight;

  line._fadeTimer = setTimeout(() => {
    line.classList.add('fading');
    setTimeout(() => {
      line.remove();
      if (feed.children.length === 0) feed.hidden = true;
    }, REASONING_FADE_MS);
  }, REASONING_FEED_TTL);

  const shouldScroll = isNearBottom() || (forceScrollCount > 0 && !userScrolledAway);
  if (shouldScroll) scrollToBottom();
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
    li.textContent = 'No models registered. Click "+ New model" to add one.';
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
    showToast('Enter a URL or host first (e.g. localhost:11434, api.anthropic.com).', { kind: 'error' });
    return;
  }
  // Scheme is optional — server races http+https when omitted. Reject only
  // obvious garbage (whitespace, angle brackets) early so we don't burn a
  // round-trip on malformed input.
  if (/\s|[<>]/.test(url)) {
    showToast('URL contains invalid characters.', { kind: 'error' });
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
    showToast('Select at least one model.', { kind: 'error' });
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
      showToast('Bulk add failed: ' + (out.error || res.statusText), { kind: 'error' });
      return;
    }
    if (out.failed && out.failed.length > 0) {
      const lines = out.failed.map((f) => `  • ${items[f.index].model_id}: ${f.error}`).join('\n');
      showToast(`Added ${out.created_count}, ${out.failed.length} failed:\n${lines}`, { kind: 'error' });
    }
    await fetchModels();
    closeModelDetail();
    // If the picker kicked off this add, return user to the agent detail
    // and auto-assign the new model when there's exactly one.
    const createdIds = (out.created || []).map((m) => m.id);
    await maybeAssignAfterPickerAdd(createdIds);
  } catch (err) {
    showToast('Bulk add failed: ' + err.message, { kind: 'error' });
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
      showToast('Enter an Ollama endpoint first (e.g. http://localhost:11434)', { kind: 'error' });
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
      if (models.length === 0) showToast('No models found at that endpoint.', { kind: 'error' });
      select.onchange = () => {
        if (select.value) {
          $(modelIdInput).value = select.value;
          select.hidden = true;
        }
      };
    } catch (err) {
      showToast('Discover failed: ' + err.message, { kind: 'error' });
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
    showToast('Name and Model ID are required.', { kind: 'error' });
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
      showToast('Failed to create model: ' + (out.error || res.statusText), { kind: 'error' });
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
    showToast('Failed to create model: ' + err.message, { kind: 'error' });
  }
});

$('#model-detail-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!selectedModelId) return;
  const btn = $('#model-detail-form button.btn-primary');
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
      showToast('Failed to save model: ' + (out.error || res.statusText), { kind: 'error' });
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
    showToast('Failed to save model: ' + err.message, { kind: 'error' });
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
      const impact = await res.json();
      const n = (impact.assigned_agent_group_ids || []).length;
      const confirmed = await showConfirmModal({
        title: 'Delete model',
        body:
          `"${model.name}" is assigned to ${n} agent${n === 1 ? '' : 's'}. ` +
          `They will fall back to the default Anthropic credential + default model on their next session spawn.`,
        confirmLabel: 'Delete anyway',
        destructive: true,
      });
      if (!confirmed) return;
      const force = await authFetch(`/api/models/${encodeURIComponent(selectedModelId)}?force=1`, { method: 'DELETE' });
      if (!force.ok) {
        const err = await force.json().catch(() => ({}));
        showToast(`Failed to delete: ${err.error || force.statusText}`, { kind: 'error' });
        return;
      }
    } else if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`Failed to delete: ${err.error || res.statusText}`, { kind: 'error' });
      return;
    }
    showToast(`Deleted model "${model.name}".`, { kind: 'success' });
    closeModelDetail();
    await fetchModels();
    // Refresh the agents list too — assigned_model_id may have changed for some.
    if (allAgents.length > 0) await fetchAgents();
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, { kind: 'error' });
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
