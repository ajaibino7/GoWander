// Automatic trip cover: a free photo of the place the trip mostly happens in, used whenever no
// one has uploaded a cover. Where = the area with the most stops; its name comes from
// OpenStreetMap (Nominatim), the photo from Wikivoyage's page for it, else Wikipedia's.
// Results are cached on the device, so each place is looked up once a month at most.

const TTL = 30 * 86400000;
const MISS_TTL = 86400000; // retry places without a photo after a day
const memo = new Map();

// The area with the most stops (about 50 km cells), and the first place in it.
export function mainPlace(trip) {
  const cells = new Map();
  for (const d of trip.days || []) {
    for (const s of d.stops || []) {
      if (!s.place || !Number.isFinite(s.place.lat)) continue;
      const k = `${Math.round(s.place.lat * 2)},${Math.round(s.place.lng * 2)}`;
      if (!cells.has(k)) cells.set(k, { n: 0, place: s.place });
      cells.get(k).n++;
    }
  }
  return [...cells.values()].sort((a, b) => b.n - a.n)[0]?.place || null;
}

// Nominatim allows one request a second: queue them.
let chain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function politely(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {}).then(() => sleep(1100));
  return p;
}

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Most specific name first. Big cities often come back only as "<City> City District".
async function placeNames({ lat, lng }) {
  const r = await politely(() => getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&accept-language=en`));
  const a = r.address || {};
  const clean = (s) => (s || '').replace(/\s+(City\s+)?(District|Subdistrict|Taluka|Tehsil)$/i, '').trim();
  return [...new Set([a.city, a.town, a.village, clean(a.state_district), clean(a.county), a.state].filter(Boolean))].slice(0, 4);
}

// Real photos only: page images are sometimes maps, flags or coats of arms.
const isPhoto = (file) => /\.jpe?g$/i.test(file || '') && !/(map|locator|flag|seal|emblem|coat[_ ]of[_ ]arms|logo|montage|collage)/i.test(file);

async function pageImage(wiki, title) {
  const j = await getJson(`https://${wiki}/w/api.php?action=query&format=json&origin=*&redirects=1&prop=pageimages&piprop=thumbnail|name&pithumbsize=1920&pilicense=free&titles=${encodeURIComponent(title)}`);
  const page = Object.values(j.query?.pages || {})[0];
  if (!page?.thumbnail?.source || !isPhoto(page.pageimage)) return null;
  return { hero: page.thumbnail.source, file: page.pageimage, page: page.title, source: wiki.startsWith('en.wikivoyage') ? 'Wikivoyage' : 'Wikipedia' };
}

async function lookup(place) {
  for (const name of await placeNames(place)) {
    for (const wiki of ['en.wikivoyage.org', 'en.wikipedia.org']) {
      try {
        const hit = await pageImage(wiki, name);
        if (hit) return { ...hit, place: name };
      } catch { /* try the next source */ }
    }
  }
  return null;
}

// A smaller copy for cards. Wikimedia thumbnails carry their width in the file name.
export const smallUrl = (url) => url.replace(/\/(\d+)px-([^/]+)$/, '/500px-$2');
export const creditUrl = (info) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(info.file)}`;

// { hero, file, page, place, source } for the trip, or null when there's nothing suitable.
export async function autoCover(trip) {
  const place = mainPlace(trip);
  if (!place) return null;
  const key = `gw-auto-${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;
  if (memo.has(key)) return memo.get(key);
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < (hit.info ? TTL : MISS_TTL)) { memo.set(key, hit.info); return hit.info; }
  } catch { /* storage unavailable */ }
  const p = lookup(place).catch(() => undefined); // undefined = failed (offline etc.), don't cache
  memo.set(key, p);
  const info = await p;
  if (info === undefined) { memo.delete(key); return null; }
  memo.set(key, info);
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), info })); } catch { /* storage full */ }
  return info;
}
