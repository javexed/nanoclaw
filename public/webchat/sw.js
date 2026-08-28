/* nanoclaw-web service worker — offline app shell, no push.
   The cache name below is a placeholder stamped at serve time with a content
   hash of every served asset, so the cache busts exactly when an asset
   changes (see computeSwCacheVersion — and note the server substitutes the
   FIRST occurrence, which is why this comment never names it). */
const CACHE = '__CACHE_VERSION__';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/marked.min.js',
  '/dompurify.min.js',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept the API or the socket — realtime must hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            // Cache successful same-origin asset fetches (the emitted /js/ modules
            // aren't in the precache list — they land here on first load).
            if (res.ok && url.origin === location.origin) {
              const clone = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, clone));
            }
            return res;
          })
          .catch(() => caches.match('/index.html').then((shell) => shell || Response.error())),
    ),
  );
});
