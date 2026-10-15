// Offline support and cache control.
//   • Built files in assets/ have a content hash in their name, so they never change and are
//     served cache-first.
//   • Pages, trip data and the manifest are network-first (bypassing the HTTP cache), so a
//     new deploy shows up on the next load; the cached copy is only used offline.
//   • Each release gets its own cache (named by VERSION); old ones are deleted on activate.
// VERSION and SHELL are written by scripts/postbuild.mjs after `vite build` — don't edit
// between the build markers.

// build:version
const VERSION = 'dev';
// /build:version
const CACHE = `gowander-${VERSION}`;

// build:shell
const SHELL = ['./', './index.html'];
// /build:shell

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gowander-') || k.startsWith('mlt-')).filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cacheFirst = (req) => caches.match(req).then((hit) => hit || fetch(req).then((res) => {
  if (res.ok || res.type === 'opaque') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    // "Add to calendar" on iPhone: the page leaves the trip's .ics in the gw-calendar cache and
    // opens this address, so Safari receives a real calendar file from a real https address
    // (it won't open calendars from data: or blob: links) and shows Apple Calendar's "Add All".
    if (url.pathname.includes('/calendar/') && url.pathname.endsWith('.ics')) {
      e.respondWith(caches.open('gw-calendar')
        .then((c) => c.match(url.origin + url.pathname))
        .then((hit) => hit || new Response('This calendar link has expired. Go back to the trip and tap "Add to calendar" again.', {
          status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })));
      return;
    }
    if (url.pathname.endsWith('/version.json')) return; // always straight from the network
    // Built files never change once named, so the cached copy is always right.
    if (url.pathname.includes('/assets/')) { e.respondWith(cacheFirst(req)); return; }

    // Network first, skipping the browser's HTTP cache (GitHub Pages caches for 10 minutes).
    const fresh = req.mode === 'navigate'
      ? new Request(url.pathname + url.search, { cache: 'no-cache', credentials: 'same-origin' })
      : new Request(req, { cache: 'no-cache' });
    e.respondWith(
      fetch(fresh)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? './index.html' : req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req.mode === 'navigate' ? './index.html' : req).then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  // Map tiles you've looked at stay available offline.
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // Destination photos: served from the copy "Save offline" saved (gw-photos), else the
  // network. Not cached here, because page-loaded images are opaque and bloat storage.
  if (url.hostname === 'upload.wikimedia.org' || url.hostname === 'thumb.wikimedia.org') {
    e.respondWith(caches.match(req.url).then((hit) => hit || fetch(req)));
  }
});
