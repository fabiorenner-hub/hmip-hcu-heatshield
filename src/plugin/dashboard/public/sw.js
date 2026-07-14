/*
 * Heat Shield dashboard service worker.
 *
 * Goal: make the dashboard installable as a home-screen web app
 * (iOS / Android) and resilient to brief network drops - without
 * ever serving stale live data.
 *
 * Strategy:
 *   - App shell (HTML, JS, CSS, icon, manifest): network-first, with
 *     the cache as an offline fallback (avoids stale JS/CSS after an
 *     update).
 *   - Everything under /api/ (state, stream, discover, config, ...):
 *     network-only. Live data and SSE must never be cached.
 *   - Navigation requests: try network first, fall back to the
 *     cached shell so the installed app opens offline.
 */

const CACHE = 'heatshield-shell-v191';

const SHELL = ['/', '/app.js', '/styles.css', '/liquid-glass.css', '/liquid-glass2.css', '/manifest.webmanifest', '/icon.svg'];

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

  // Static shell assets: network-first (always latest when online, cache is a
  // fallback for offline). Avoids serving stale JS/CSS after an update.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error())),
  );
});
