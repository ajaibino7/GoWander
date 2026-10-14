// Automatic trip cover: a free photo of the place the trip mostly happens in, used whenever no
// one has uploaded a cover. Where = the area with the most stops (its name from OpenStreetMap
// Nominatim), or for a trip without stops yet, the place named in its title ("Goa",
// "Mumbai + Lonavala"). The photo comes from Wikivoyage's page for it, else Wikipedia's.
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

async function photoFor(names) {
  for (const name of names) {
    for (const wiki of ['en.wikivoyage.org', 'en.wikipedia.org']) {
      try {
        const hit = await pageImage(wiki, name);
        if (hit) return { ...hit, place: `${name.charAt(0).toUpperCase()}${name.slice(1)}` };
      } catch { /* try the next source */ }
    }
  }
  return null;
}

// Place names in a trip title: "Mumbai + Lonavala" → Mumbai, Lonavala; "Goa long weekend" → Goa.
// Generic trip words are dropped so "Family trip" finds nothing rather than a random photo.
const GENERIC = /\b(trip|trips|tour|travel|travels|journey|holiday|holidays|vacation|getaway|break|weekend|long|short|day|days|night|nights|week|family|friends|couple|honeymoon|road|solo|backpacking|summer|winter|monsoon|spring|autumn|plan|plans|visit|our|my|the|a|an|in|at|with|for|of|and|to|from|\d+)\b/gi;
export function titleNames(trip) {
  return [...new Set(String(trip.title || '')
    .split(/\s*(?:\+|&|,|\/|\||·|→|–|—|\s-\s|\band\b|\bto\b)\s*/i)
    .map((s) => s.replace(GENERIC, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 3))].slice(0, 3);
}

async function fromTitle(trip) {
  const names = titleNames(trip);
  if (!names.length) return null;
  const exact = await photoFor(names);
  if (exact) return exact;
  // "Kerala backwaters" isn't a page title: ask Wikivoyage's search, whose results are destinations.
  try {
    const j = await getJson(`https://en.wikivoyage.org/w/api.php?action=query&format=json&origin=*&list=search&srlimit=1&srnamespace=0&srsearch=${encodeURIComponent(names.join(' '))}`);
    const top = j.query?.search?.[0]?.title;
    return top ? await photoFor([top]) : null;
  } catch { return null; }
}

async function lookup(trip, place) {
  if (place) {
    const hit = await photoFor(await placeNames(place));
    if (hit) return hit;
  }
  return fromTitle(trip);
}

// A smaller copy for cards. Wikimedia thumbnails carry their width in the file name.
export const smallUrl = (url) => url.replace(/\/(\d+)px-([^/]+)$/, '/500px-$2');
export const creditUrl = (info) => `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(info.file)}`;

// { hero, file, page, place, source } for the trip, or null when there's nothing suitable.
export async function autoCover(trip) {
  const place = mainPlace(trip);
  const names = titleNames(trip);
  if (!place && !names.length) return null;
  const key = place ? `gw-auto-${place.lat.toFixed(2)},${place.lng.toFixed(2)}` : `gw-auto-t-${names.join('|').toLowerCase()}`;
  if (memo.has(key)) return memo.get(key);
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < (hit.info ? TTL : MISS_TTL)) { memo.set(key, hit.info); return hit.info; }
  } catch { /* storage unavailable */ }
  const p = lookup(trip, place).catch(() => undefined); // undefined = failed (offline etc.), don't cache
  memo.set(key, p);
  const info = await p;
  if (info === undefined) { memo.delete(key); return null; }
  memo.set(key, info);
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), info })); } catch { /* storage full */ }
  return info;
}
