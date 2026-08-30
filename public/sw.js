// Cortex — single-cache service worker.
//
// Everything the site precaches lives under ONE cache name (CACHE_NAME).
// To make another file load instantly on repeat visits, add its path to
// PRECACHE_URLS below — it joins the same cache, it does not get a cache
// of its own. Bump the version suffix on CACHE_NAME (v1 -> v2) whenever
// you change PRECACHE_URLS or edit a cached file, so visitors pick up the
// new copy instead of a stale one.

const CACHE_NAME = 'cortex-static-v2';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/site.webmanifest',
  '/favicon.svg',
  '/favicon.ico',
  '/favicon-32.png',
  '/favicon-180.png',
  '/css/theme.css',
  '/js/nav.js',
  '/js/toast.js',
  '/js/overlay.js',
  '/js/storage-shim.js',
  '/js/file-input-enhance.js',
  '/js/trend-chart.js'
  // add more same-origin files here as the app grows —
  // they all join CACHE_NAME above, none of them get a cache of their own.
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((name) => name !== CACHE_NAME) // drop any older-versioned cache
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept third-party (fonts, API) calls

  // API calls: always go straight to the network. These were slipping into
  // the cache-first branch below (it only excludes cross-origin, not /api/
  // paths), so a signed-in user could see a stale canManage flag, stale
  // team membership, or stale track list until a background refresh caught
  // up — confusing right after a deploy or a role/permission change.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // HTML: network-first, so signed-in redirects and copy edits show up
  // immediately, falling back to the cached page only if offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (css/js/icons): cache-first for speed, refreshed in the
  // background so the cache doesn't go stale forever.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

/* ---------------- push notifications ---------------- */
// Fires when a push arrives from the server (see lib/push.js /
// netlify/functions/generate-recommendations.js). This only *displays* the
// notification — subscribing/unsubscribing happens in public/js/notifications.js.

self.addEventListener('push', (event) => {
  let data = { title: 'Cortex', body: 'You have a new notification.', url: '/dashboard.html' };
  if (event.data) {
    try { data = Object.assign(data, event.data.json()); } catch (e) { /* keep defaults */ }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon-180.png',
      badge: '/favicon-32.png',
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
