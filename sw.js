// Offline support and cache control.
//   • Versioned files (?v=<content hash>) never change, so they're served cache-first.
//   • Pages, trip data and the manifest are network-first (bypassing the HTTP cache), so a
//     new deploy shows up on the next load; the cached copy is only used offline.
//   • Each release gets its own cache (named by VERSION); old ones are deleted on activate.
// VERSION and SHELL are written by scripts/stamp.mjs — don't edit between the build markers.

// build:version
const VERSION = '31f59e32';
// /build:version
const CACHE = `gowander-${VERSION}`;

// build:shell
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './data/trips.json',
  './icons/favicon-64.png',
  './icons/logo.webp',
  './css/app.css?v=58151d1c9b',
  './css/styles.css?v=f2e0c79fbe',
  './js/autocover.js?v=8afe28294f',
  './js/calendar.js?v=0309c30dc1',
  './js/cloud.js?v=007f8bcbfe',
  './js/editor.js?v=5b40e8f392',
  './js/firebase-config.js?v=caeca71f59',
  './js/live.js?v=33d55cb787',
  './js/main.js?v=965d726ab6',
  './js/nearby.js?v=8656ebc47c',
  './js/offline.js?v=73a89c5e7d',
  './js/placepicker.js?v=3594d48934',
  './js/routing.js?v=165c00c8ee',
  './js/store.js?v=085676b855',
  './js/testkit.js?v=cd1f1e95d1',
  './js/util.js?v=80527bd589',
  './js/weather.js?v=f3ec1a4ad6'
];
// /build:shell

const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([...SHELL.map((u) => new Request(u, { cache: 'reload' })), ...CDN]))
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
    if (url.searchParams.has('v')) { e.respondWith(cacheFirst(req)); return; }

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

  // Third-party static files: versioned CDN libraries, the Firebase SDK and map tiles.
  if (url.hostname === 'unpkg.com' || url.hostname.endsWith('tile.openstreetmap.org')
      || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // Destination photos: served from the copy "Make offline-ready" saved (gw-photos), else the
  // network. Not cached here, because page-loaded images are opaque and bloat storage.
  if (url.hostname === 'upload.wikimedia.org' || url.hostname === 'thumb.wikimedia.org') {
    e.respondWith(caches.match(req.url).then((hit) => hit || fetch(req)));
  }
});
