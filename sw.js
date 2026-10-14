// Offline support and cache control.
//   • Versioned files (?v=<content hash>) never change, so they're served cache-first.
//   • Pages, trip data and the manifest are network-first (bypassing the HTTP cache), so a
//     new deploy shows up on the next load; the cached copy is only used offline.
//   • Each release gets its own cache (named by VERSION); old ones are deleted on activate.
// VERSION and SHELL are written by scripts/stamp.mjs — don't edit between the build markers.

// build:version
const VERSION = 'be7fe47e';
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
  './css/app.css?v=99ffba6b58',
  './css/styles.css?v=8b049819ca',
  './js/autocover.js?v=8afe28294f',
  './js/calendar.js?v=2878c14752',
  './js/cloud.js?v=3956b81144',
  './js/editor.js?v=5b40e8f392',
  './js/firebase-config.js?v=caeca71f59',
  './js/live.js?v=099883dea9',
  './js/main.js?v=cb0cdaff7b',
  './js/nearby.js?v=8656ebc47c',
  './js/offline.js?v=8a40b2d162',
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
