// Offline support: app files are network-first (so updates show up straight away),
// Leaflet, the Firebase SDK and map tiles are cache-first (versioned / static, so safe to keep).
const CACHE = 'mlt-v3';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './css/app.css',
  './js/main.js',
  './js/util.js',
  './js/store.js',
  './js/live.js',
  './js/editor.js',
  './js/placepicker.js',
  './js/cloud.js',
  './js/firebase-config.js',
  './data/trips.json',
  './manifest.webmanifest',
  './icons/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))),
    );
    return;
  }

  if (url.hostname === 'unpkg.com' || url.hostname.endsWith('tile.openstreetmap.org')
      || (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/'))) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
  }
});
