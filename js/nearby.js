// "What to do nearby": named sights, nature, food and shopping around a place, from
// OpenStreetMap via the Overpass API (free, no key). Results are cached on the device for a
// week so they still show with patchy signal on the trip.
import { distM } from './util.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const TTL = 7 * 86400000;
const RADIUS = { see: 3000, eat: 1000, shop: 1500 }; // metres from the stop
const memo = new Map();

export const CATS = {
  see: { label: 'Sights', icon: '🏛️' },
  eat: { label: 'Food', icon: '🍽️' },
  shop: { label: 'Shopping', icon: '🛍️' },
};
const KEEP = { see: 18, eat: 12, shop: 8 };

// tag=value → [icon, label]. The first match wins, so more specific tags come first.
const KINDS = [
  ['tourism=museum', '🏛️', 'Museum'], ['tourism=gallery', '🖼️', 'Gallery'], ['tourism=viewpoint', '🔭', 'Viewpoint'],
  ['tourism=zoo', '🦁', 'Zoo'], ['tourism=aquarium', '🐠', 'Aquarium'], ['tourism=theme_park', '🎢', 'Theme park'],
  ['historic=castle', '🏰', 'Castle'], ['historic=fort', '🏰', 'Fort'], ['historic=palace', '🏰', 'Palace'],
  ['historic=ruins', '🏚️', 'Ruins'], ['historic=archaeological_site', '🏺', 'Archaeological site'],
  ['historic=monument', '🗿', 'Monument'], ['historic=memorial', '🗿', 'Memorial'], ['historic=city_gate', '🚪', 'City gate'],
  ['natural=beach', '🏖️', 'Beach'], ['natural=waterfall', '💧', 'Waterfall'], ['natural=peak', '⛰️', 'Peak'],
  ['natural=cave_entrance', '🕳️', 'Cave'], ['natural=bay', '🌊', 'Bay'],
  ['leisure=water_park', '🌊', 'Water park'], ['leisure=nature_reserve', '🌿', 'Nature reserve'],
  ['leisure=garden', '🌷', 'Garden'], ['leisure=park', '🌳', 'Park'],
  ['amenity=place_of_worship', '🛕', 'Place of worship'],
  ['tourism=attraction', '⭐', 'Attraction'],
  ['amenity=cafe', '☕', 'Café'], ['amenity=ice_cream', '🍦', 'Ice cream'], ['amenity=food_court', '🍜', 'Food court'],
  ['amenity=restaurant', '🍽️', 'Restaurant'],
  ['amenity=marketplace', '🛒', 'Market'], ['shop=mall', '🛍️', 'Mall'], ['shop=department_store', '🛍️', 'Department store'],
  ['shop=souvenir', '🎁', 'Souvenirs'], ['shop=gift', '🎁', 'Gifts'], ['shop=books', '📚', 'Bookshop'],
  ['shop=art', '🎨', 'Art shop'], ['shop=craft', '🧵', 'Crafts'],
];

// Bounding boxes, not around:, which is far slower and makes busy servers time out.
// Results are trimmed back to a circle in toItems.
function query({ lat, lng }) {
  const box = (r) => {
    const dLat = r / 111320, dLng = r / (111320 * Math.cos((lat * Math.PI) / 180));
    return `(${(lat - dLat).toFixed(5)},${(lng - dLng).toFixed(5)},${(lat + dLat).toFixed(5)},${(lng + dLng).toFixed(5)})`;
  };
  const see = box(RADIUS.see), eat = box(RADIUS.eat), shop = box(RADIUS.shop);
  return `[out:json][timeout:25];
(
  nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["name"]${see};
  nwr["historic"~"^(monument|castle|fort|memorial|ruins|archaeological_site|palace|city_gate)$"]["name"]${see};
  nwr["leisure"~"^(park|garden|nature_reserve|water_park)$"]["name"]${see};
  nwr["natural"~"^(beach|peak|waterfall|cave_entrance|bay)$"]["name"]${see};
  nwr["amenity"="place_of_worship"]["name"]["wikidata"]${see};
)->.see;
.see out center tags 120;
nwr["amenity"~"^(restaurant|cafe|ice_cream|food_court)$"]["name"]${eat}->.eat;
.eat out center tags 120;
(
  nwr["shop"~"^(mall|department_store|gift|souvenir|books|art|craft)$"]["name"]${shop};
  nwr["amenity"="marketplace"]["name"]${shop};
)->.shop;
.shop out center tags 60;`;
}

function classify(tags) {
  for (const [kv, icon, label] of KINDS) {
    const [k, v] = kv.split('=');
    if (tags[k] === v) {
      const cat = k === 'shop' || v === 'marketplace' ? 'shop' : ['restaurant', 'cafe', 'ice_cream', 'food_court'].includes(v) ? 'eat' : 'see';
      return { cat, icon, label };
    }
  }
  return null;
}

const wikiUrl = (w) => {
  const m = /^([a-z-]+):(.+)$/.exec(w || '');
  return m ? `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}` : '';
};

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
    const famous = !!(t.wikidata || t.wikipedia);
    let label = kind.label;
    if (kind.cat === 'eat' && t.cuisine) {
      const c = t.cuisine.split(';')[0].replace(/_/g, ' ').trim();
      label += ` · ${c.charAt(0).toUpperCase()}${c.slice(1)}`;
    }
    // "Recommended" = well-known places first (they have a Wikipedia/Wikidata entry), then the closest.
    const score = (famous ? 3000 : 0) + (['Museum', 'Viewpoint', 'Fort', 'Castle', 'Palace', 'Beach', 'Waterfall'].includes(kind.label) ? 600 : 0)
      + (kind.cat === 'eat' ? (t.cuisine ? 150 : 0) + (t.opening_hours ? 100 : 0) + (t.website ? 100 : 0) : 0) - dist;
    out.push({ id: `${el.type}/${el.id}`, name, lat, lng, cat: kind.cat, icon: kind.icon, label, dist, famous, score, wiki: wikiUrl(t.wikipedia) });
  }
  return Object.keys(KEEP).flatMap((c) => out.filter((x) => x.cat === c).sort((a, b) => b.score - a.score).slice(0, KEEP[c]));
}

const cacheKey = (p) => `gw-near-${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;

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

// Things to do around a place, best first within each category.
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
