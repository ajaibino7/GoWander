// Real travel times between consecutive stops, by road, from the OSRM servers run by FOSSGIS
// (the ones openstreetmap.org uses for directions). One request per day per mode covers every
// leg. Roads rarely change, so results are cached on the device for a month.

const TTL = 30 * 86400000;
const BASE = 'https://routing.openstreetmap.de';
const memo = new Map();

// Be gentle with a free service: one request at a time, a short pause between.
let chain = Promise.resolve();
function politely(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 400)));
  return p;
}

async function route(profile, points) {
  const coords = points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const key = `gw-route-${profile}-${coords}`;
  if (memo.has(key)) return memo.get(key);
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < TTL) { memo.set(key, hit.legs); return hit.legs; }
  } catch { /* storage unavailable */ }
  const p = politely(async () => {
    const res = await fetch(`${BASE}/routed-${profile}/route/v1/driving/${coords}?overview=false&steps=false`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.code !== 'Ok') throw new Error(j.code);
    return j.routes[0].legs.map((l) => ({ s: l.duration, m: l.distance }));
  });
  memo.set(key, p);
  try {
    const legs = await p;
    memo.set(key, legs);
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), legs })); } catch { /* storage full */ }
    return legs;
  } catch (e) {
    memo.delete(key);
    throw e;
  }
}

const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

/**
 * For one day: Map of stop id → { drive: {s, m}, walk: {s, m} | null } for the leg that arrives
 * at that stop from the previous stop's place. Stops at the same place as the one before get none.
 */
export async function dayLegs(stops) {
  const points = [];
  const arrivals = []; // stop id for each leg
  for (const s of stops) {
    if (!s.place || !Number.isFinite(s.place.lat)) continue;
    const prev = points[points.length - 1];
    if (prev && same(prev, s.place)) continue;
    if (prev) arrivals.push(s.id);
    points.push(s.place);
  }
  const out = new Map();
  if (points.length < 2) return out;
  const [drive, walk] = await Promise.all([
    route('car', points),
    route('foot', points).catch(() => null), // walking is a bonus; driving is what matters
  ]);
  arrivals.forEach((id, i) => out.set(id, { drive: drive[i], walk: walk?.[i] || null }));
  return out;
}

// Map of stop id → leg, for every day of the trip. Days that fail are skipped.
export async function tripLegs(days) {
  const all = new Map();
  for (const d of days) {
    try { for (const [k, v] of await dayLegs(d.stops)) all.set(k, v); } catch { /* try again later */ }
  }
  return all;
}

// Walking if it's a short walk, else driving.
export function bestMode(leg) {
  if (leg.walk && leg.walk.s <= 25 * 60) return { mode: 'walk', icon: '🚶', ...leg.walk };
  return { mode: 'drive', icon: '🚗', ...leg.drive };
}
