/*
 * Heat Shield dashboard service worker.
 *
 * Goal: make the dashboard installable as a home-screen web app
 * (iOS / Android) and resilient to brief network drops — WITHOUT
 * ever serving stale live data.
 *
 * Strategy:
 *   - App shell (HTML, JS, CSS, icon, manifest): stale-while-
 *     revalidate. Fast load from cache, refreshed in the background.
 *   - Everything under /api/ (state, stream, discover, config, …):
 *     network-only. Live data and SSE must never be cached.
 *   - Navigation requests: try network first, fall back to the
 *     cached shell so the installed app opens offline.
 */

const CACHE = 'heatshield-shell-v1';
const SHELL = ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache the API or the SSE stream.
  if (url.pathname.startsWith('/api/')) {
    return; // default: go to network
  }

  // Navigations: network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  // Static shell assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
