// "What to do nearby": named sights, food, bars and shopping around a stop, from
// OpenStreetMap via the Overpass API (free, no key). What the stop is for ("Lunch in Fort",
// "Pub, live music…", "Lonavala Market") decides what's shown first. Results are cached on the
// device for a week so they still show with patchy signal on the trip.
import { distM } from './util.js';

// The main server sits behind a load balancer and sometimes fails one request but answers the
// next, so it's tried twice.
const MAIN = 'https://overpass-api.de/api/interpreter';
const ENDPOINTS = [MAIN, 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', MAIN, 'https://overpass.private.coffee/api/interpreter'];
const TTL = 7 * 86400000;
const RADIUS = { see: 3000, eat: 1000, drink: 1500, shop: 1500 }; // metres from the stop
const memo = new Map();

export const CATS = {
  see: { label: 'Sights', icon: '🏛️' },
  eat: { label: 'Food', icon: '🍽️' },
  drink: { label: 'Bars', icon: '🍸' },
  shop: { label: 'Shopping', icon: '🛍️' },
};
const POOL = { see: 30, eat: 50, drink: 20, shop: 15 }; // kept per place, before ranking for a stop
const SHOW = { see: 18, eat: 15, drink: 12, shop: 10 }; // listed per category

// tag=value → icon, label, category. The first match wins, so more specific tags come first.
const KINDS = [
  ['tourism=museum', '🏛️', 'Museum', 'see'], ['tourism=gallery', '🖼️', 'Gallery', 'see'], ['tourism=viewpoint', '🔭', 'Viewpoint', 'see'],
  ['tourism=zoo', '🦁', 'Zoo', 'see'], ['tourism=aquarium', '🐠', 'Aquarium', 'see'], ['tourism=theme_park', '🎢', 'Theme park', 'see'],
  ['historic=castle', '🏰', 'Castle', 'see'], ['historic=fort', '🏰', 'Fort', 'see'], ['historic=palace', '🏰', 'Palace', 'see'],
  ['historic=ruins', '🏚️', 'Ruins', 'see'], ['historic=archaeological_site', '🏺', 'Archaeological site', 'see'],
  ['historic=monument', '🗿', 'Monument', 'see'], ['historic=memorial', '🗿', 'Memorial', 'see'], ['historic=city_gate', '🚪', 'City gate', 'see'],
  ['natural=beach', '🏖️', 'Beach', 'see'], ['natural=waterfall', '💧', 'Waterfall', 'see'], ['natural=peak', '⛰️', 'Peak', 'see'],
  ['natural=cave_entrance', '🕳️', 'Cave', 'see'], ['natural=bay', '🌊', 'Bay', 'see'],
  ['leisure=water_park', '🌊', 'Water park', 'see'], ['leisure=nature_reserve', '🌿', 'Nature reserve', 'see'],
  ['leisure=garden', '🌷', 'Garden', 'see'], ['leisure=park', '🌳', 'Park', 'see'],
  ['amenity=place_of_worship', '🛕', 'Place of worship', 'see'],
  ['tourism=attraction', '⭐', 'Attraction', 'see'],
  ['amenity=restaurant', '🍽️', 'Restaurant', 'eat'], ['amenity=food_court', '🍜', 'Food court', 'eat'],
  ['amenity=cafe', '☕', 'Café', 'eat'], ['shop=bakery', '🥐', 'Bakery', 'eat'], ['amenity=ice_cream', '🍦', 'Ice cream', 'eat'],
  ['amenity=fast_food', '🥟', 'Quick bites', 'eat'],
  ['amenity=pub', '🍺', 'Pub', 'drink'], ['amenity=bar', '🍸', 'Bar', 'drink'], ['amenity=biergarten', '🍺', 'Beer garden', 'drink'],
  ['amenity=nightclub', '🎶', 'Nightclub', 'drink'],
  ['amenity=marketplace', '🛒', 'Market', 'shop'], ['shop=mall', '🛍️', 'Mall', 'shop'], ['shop=department_store', '🛍️', 'Department store', 'shop'],
  ['shop=souvenir', '🎁', 'Souvenirs', 'shop'], ['shop=gift', '🎁', 'Gifts', 'shop'], ['shop=books', '📚', 'Bookshop', 'shop'],
  ['shop=art', '🎨', 'Art shop', 'shop'], ['shop=craft', '🧵', 'Crafts', 'shop'],
].map(([kv, icon, label, cat]) => { const [k, v] = kv.split('='); return { k, v, icon, label, cat }; });

/* ============================================================
   What a stop is for
   ============================================================ */
// Checked in order against the stop's title, so "Pub, live music or café hopping" is about bars
// and "Dinner, music & a relaxed evening" is about dinner. prefer = place types that suit it.
const INTENTS = [
  { key: 'breakfast', re: /breakfast|brunch/i, cat: 'eat', title: 'Breakfast spots', button: 'Find breakfast spots', icon: '🥐', prefer: ['cafe', 'bakery', 'restaurant'] },
  { key: 'lunch', re: /\blunch/i, cat: 'eat', title: 'Lunch spots', button: 'Find lunch spots', icon: '🍽️', prefer: ['restaurant', 'food_court'] },
  { key: 'dinner', re: /dinner|supper/i, cat: 'eat', title: 'Dinner spots', button: 'Find dinner spots', icon: '🍽️', prefer: ['restaurant'] },
  { key: 'drinks', re: /\b(pubs?|bars?|nightlife|drinks?|cocktails?|beers?|clubs?|clubbing|live music)\b/i, cat: 'drink', title: 'Bars & nightlife', button: 'Find bars & pubs', icon: '🍸', prefer: ['pub', 'bar'] },
  { key: 'cafe', re: /caf[eé]s?\b|coffee|\btea\b|\bchai\b|desserts?|ice cream/i, cat: 'eat', title: 'Cafés & desserts', button: 'Find cafés', icon: '☕', prefer: ['cafe', 'ice_cream', 'bakery'] },
  { key: 'snacks', re: /snacks?|street food|quick bite/i, cat: 'eat', title: 'Snacks & quick bites', button: 'Find snacks', icon: '🥟', prefer: ['fast_food', 'cafe', 'bakery'] },
  { key: 'shop', re: /shopping|\bmarket|bazaar|\bmall\b|souvenirs?|\bshops?\b/i, cat: 'shop', title: 'Places to shop', button: 'Find shops', icon: '🛍️' },
];
const MEAL = { key: 'eat', cat: 'eat', title: 'Places to eat', button: 'Find places to eat', icon: '🍽️', prefer: ['restaurant'] };
export const GENERAL = { key: 'see', cat: 'all', title: 'What to do nearby', button: 'What to do nearby', icon: '✨' };

export function intentFor(stop) {
  const title = stop.title || '', note = stop.note || '';
  const hit = INTENTS.find((i) => i.re.test(title));
  if (hit) return hit;
  // A note only steers meals ("Around Colaba" stays generic); for other stops only a clear
  // shopping or nightlife note does, so "Valley views and roadside snacks" stays a viewpoint.
  const fromNote = INTENTS.find((i) => (stop.kind === 'meal' || i.cat === 'shop' || i.cat === 'drink') && i.re.test(note));
  if (fromNote) return fromNote;
  return stop.kind === 'meal' ? MEAL : GENERAL;
}

/* ============================================================
   Fetching
   ============================================================ */
// Bounding boxes, not around:, which is far slower and makes busy servers time out.
// Results are trimmed back to a circle in toItems.
function query({ lat, lng }) {
  const box = (r) => {
    const dLat = r / 111320, dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
    return `(${(lat - dLat).toFixed(5)},${(lng - dLng).toFixed(5)},${(lat + dLat).toFixed(5)},${(lng + dLng).toFixed(5)})`;
  };
  const see = box(RADIUS.see), eat = box(RADIUS.eat), drink = box(RADIUS.drink), shop = box(RADIUS.shop);
  return `[out:json][timeout:25];
(
  nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["name"]${see};
  nwr["historic"~"^(monument|castle|fort|memorial|ruins|archaeological_site|palace|city_gate)$"]["name"]${see};
  nwr["leisure"~"^(park|garden|nature_reserve|water_park)$"]["name"]${see};
  nwr["natural"~"^(beach|peak|waterfall|cave_entrance|bay)$"]["name"]${see};
  nwr["amenity"="place_of_worship"]["name"]["wikidata"]${see};
)->.see;
.see out center tags 120;
(
  nwr["amenity"~"^(restaurant|cafe|ice_cream|food_court|fast_food)$"]["name"]${eat};
  nwr["shop"="bakery"]["name"]${eat};
)->.eat;
.eat out center tags 200;
nwr["amenity"~"^(bar|pub|biergarten|nightclub)$"]["name"]${drink}->.drink;
.drink out center tags 60;
(
  nwr["shop"~"^(mall|department_store|gift|souvenir|books|art|craft)$"]["name"]${shop};
  nwr["amenity"="marketplace"]["name"]${shop};
)->.shop;
.shop out center tags 60;`;
}

const classify = (tags) => KINDS.find((x) => tags[x.k] === x.v) || null;

const wikiUrl = (w) => {
  const m = /^([a-z-]+):(.+)$/.exec(w || '');
  return m ? `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}` : '';
};

const cap = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

function toItems(elements, from) {
  const found = elements
    .map((el) => ({ el, lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon }))
    .filter((x) => x.lat != null && x.lng != null)
    .map((x) => ({ ...x, dist: distM(from, x) }))
    .sort((a, b) => a.dist - b.dist);
  const seen = new Set();
  const out = [];
  for (const { el, lat, lng, dist } of found) {
    const t = el.tags || {};
    const name = t['name:en'] || t.name;
    const kind = classify(t);
    if (!name || !kind || dist > RADIUS[kind.cat]) continue;
    // Same place mapped twice (e.g. as a point and a building), or a chain's branches: keep the closest.
    const key = `${name.toLowerCase()}|${kind.cat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cuisine = t.cuisine ? cap(t.cuisine.split(';')[0].replace(/_/g, ' ').trim()) : '';
    out.push({
      id: `${el.type}/${el.id}`, name, lat, lng, dist,
      cat: kind.cat, type: kind.v, icon: kind.icon, label: cuisine ? `${kind.label} · ${cuisine}` : kind.label,
      famous: !!(t.wikidata || t.wikipedia), wiki: wikiUrl(t.wikipedia),
      hours: (t.opening_hours || '').slice(0, 60), detailed: !!(t.cuisine || t.website || t.phone || t['contact:phone']),
    });
  }
  // Already nearest first; keep a generous pool per category for ranking per stop.
  return Object.keys(POOL).flatMap((c) => out.filter((x) => x.cat === c).slice(0, POOL[c]));
}

/* ============================================================
   Ranking for a stop
   ============================================================ */
// Sights: well-known places first (they have a Wikipedia entry), then the closest.
// Food and drink for a meal: the closest that suit it ("exact location"), nudged towards places
// with details on the map, which tend to be real, open businesses.
function score(x, intent) {
  if (x.cat === 'see') {
    return (x.famous ? 3000 : 0) + (['museum', 'viewpoint', 'fort', 'castle', 'palace', 'beach', 'waterfall'].includes(x.type) ? 600 : 0) - x.dist;
  }
  const fits = intent.cat === x.cat && intent.prefer?.includes(x.type);
  return (fits ? 400 : 0) + (x.famous ? 300 : 0) + (x.hours ? 80 : 0) + (x.detailed ? 80 : 0)
    - (x.type === 'fast_food' && !fits ? 300 : 0) - x.dist;
}

// The stop's own category first, each category best first and trimmed for the list.
export function forStop(items, intent) {
  const order = intent.cat === 'all' ? Object.keys(CATS) : [intent.cat, ...Object.keys(CATS).filter((c) => c !== intent.cat)];
  return order.flatMap((c) => items
    .filter((x) => x.cat === c)
    .map((x) => ({ ...x, score: score(x, intent) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHOW[c]));
}

const cacheKey = (p) => `gw-near2-${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

// The public servers are volunteer-run and often busy. Ask the first; if it fails, or hasn't
// answered within a few seconds, also ask the next. The first good answer wins.
function fetchOverpass(body) {
  return new Promise((resolve, reject) => {
    const ctls = [];
    let next = 0, failed = 0, settled = false, hedge;
    const finish = (fn, v) => { settled = true; clearTimeout(hedge); ctls.forEach((c) => c.abort()); fn(v); };
    const start = () => {
      if (settled || next >= ENDPOINTS.length) return;
      const url = ENDPOINTS[next++];
      const ctl = new AbortController();
      ctls.push(ctl);
      const timeout = setTimeout(() => ctl.abort(), 25000);
      clearTimeout(hedge);
      hedge = setTimeout(start, 6000);
      fetch(url, { method: 'POST', body: new URLSearchParams({ data: body }), signal: ctl.signal })
        .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
        .then((json) => { if (!settled) finish(resolve, json); })
        .catch((e) => {
          if (settled) return;
          if (++failed === ENDPOINTS.length) finish(reject, e);
          else start();
        })
        .finally(() => clearTimeout(timeout));
    };
    start();
  });
}

// Everything worth suggesting around a place, nearest first. Rank it for a stop with forStop.
export async function nearbyPlaces(place) {
  const key = cacheKey(place);
  if (memo.has(key)) return memo.get(key);
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < TTL) { memo.set(key, hit.items); return hit.items; }
  } catch { /* storage unavailable */ }

  if (!navigator.onLine) throw new Error('You\'re offline. Nearby places load once you\'re back online.');
  let data;
  try {
    data = await fetchOverpass(query(place));
  } catch {
    throw new Error('Couldn\'t reach the OpenStreetMap places service. It may be busy. Try again in a minute.');
  }
  const items = toItems(data.elements || [], place);
  memo.set(key, items);
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), items })); } catch { /* storage full */ }
  return items;
}
