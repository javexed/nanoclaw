// Cache name is derived at serve time: the webchat server replaces this
// placeholder with a hash of the served assets (see computeSwCacheVersion in
// server.ts), so the cache busts exactly when an asset changes — no
// hand-bumped version constant to conflict across branches. The literal
// fallback only survives if sw.js is served without that substitution.
const CACHE = '__CACHE_VERSION__';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/marked.min.js',
  '/dompurify.min.js',
  '/logo-dark.svg',
  '/logo-light.svg',
];
const VENDORED = new Set(['/marked.min.js', '/dompurify.min.js', '/logo-dark.svg', '/logo-light.svg']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// IndexedDB-backed unread counter shared between the SW and the page.
function badgeDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nanoclaw-badge', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('state');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function badgeIncrement() {
  const db = await badgeDB();
  return new Promise((resolve) => {
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    const getReq = store.get('count');
    getReq.onsuccess = () => {
      const next = (getReq.result || 0) + 1;
      store.put(next, 'count');
      tx.oncomplete = () => resolve(next);
    };
  });
}

async function applyBadge(n) {
  if ('setAppBadge' in self.navigator) {
    try {
      await self.navigator.setAppBadge(n);
    } catch {}
  }
}

self.addEventListener('push', (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    /* best-effort */
  }
  const title = data.title || 'NanoClaw';
  const body = data.body || 'New message';
  const tag = data.tag || 'nanoclaw-msg';
  const roomId = data.roomId || '';
  e.waitUntil(
    (async () => {
      // Only bump the badge if no visible PWA window exists — otherwise the
      // user is already looking at the app and the unread count should stay 0.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const hasVisible = clients.some((c) => c.visibilityState === 'visible');
      if (!hasVisible) {
        const n = await badgeIncrement();
        await applyBadge(n);
      }
      await self.registration.showNotification(title, {
        body,
        tag,
        data: { roomId },
        badge: '/logo-light.svg',
        icon: '/logo-dark.svg',
      });
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const roomId = (e.notification.data && e.notification.data.roomId) || '';
  const targetUrl = roomId ? `/?room=${encodeURIComponent(roomId)}` : '/';
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (c.url.includes(self.registration.scope.replace(/\/$/, ''))) {
          await c.focus();
          if (roomId) c.postMessage({ type: 'open-room', roomId });
          return;
        }
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/ws')) return;

  const url = new URL(e.request.url);

  // Vendored libs: cache-first (they never change)
  if (VENDORED.has(url.pathname)) {
    e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
    return;
  }

  // App files: cache-first. The CACHE name is a content hash of every asset
  // (computeSwCacheVersion in server.ts), so a cached asset is immutable within
  // a version — any change ships a new sw.js with a new CACHE name, and the
  // install/activate cycle re-caches + evicts. That means serving from cache is
  // always fresh AND skips a network round-trip on every load (the old
  // network-first path re-downloaded the whole growing bundle each time, even
  // when nothing changed). On a cache miss we fetch and populate.
  //
  // Only KNOWN shell paths are cached, keyed by pathname — so query-string
  // deep-links (e.g. /?room=X from a notification) reuse the single '/' entry
  // instead of each accumulating a redundant shell copy. Anything else
  // (dynamic/unknown non-/api/ responses) is fetched but never cached, so the
  // app cache can't grow unboundedly.
  const cacheKey = ASSETS.includes(url.pathname) ? url.pathname : null;
  e.respondWith(
    caches.match(cacheKey || e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((res) => {
        if (cacheKey && res.ok && res.type !== 'opaque') {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(cacheKey, clone));
        }
        return res;
      });
    }),
  );
});
