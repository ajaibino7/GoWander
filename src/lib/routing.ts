// Real travel times between consecutive stops, by road, from the OSRM servers run by FOSSGIS
// (the ones openstreetmap.org uses for directions). One request per day per mode covers every
// leg. Roads rarely change, so results are cached on the device for a month.
import type { LatLng, Place } from './types';

const TTL = 30 * 86400000;
const BASE = 'https://routing.openstreetmap.de';

/** Seconds and metres. */
export interface Leg { s: number; m: number }
export interface StopLeg { drive: Leg; walk: Leg | null }
export interface BestLeg extends Leg { mode: 'walk' | 'drive'; icon: string }

// Be gentle with a free service: one request at a time, a short pause between.
let chain: Promise<unknown> = Promise.resolve();
function politely<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 400)));
  return p;
}

const memo = new Map<string, Leg[] | Promise<Leg[]>>();

async function route(profile: 'car' | 'foot', points: LatLng[]): Promise<Leg[]> {
  const coords = points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const key = `gw-route-${profile}-${coords}`;
  const known = memo.get(key);
  if (known) return known;
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < TTL) { memo.set(key, hit.legs); return hit.legs; }
  } catch { /* storage unavailable */ }
  const p = politely(async () => {
    const res = await fetch(`${BASE}/routed-${profile}/route/v1/driving/${coords}?overview=false&steps=false`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.code !== 'Ok') throw new Error(j.code);
    return (j.routes[0].legs as { duration: number; distance: number }[]).map((l) => ({ s: l.duration, m: l.distance }));
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

const same = (a: LatLng, b: LatLng) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;

/**
 * For one day: stop id → the leg that arrives at that stop from the previous stop's place.
 * Stops at the same place as the one before get none.
 */
export async function dayLegs(stops: { id: string; place: Place | null }[]): Promise<Map<string, StopLeg>> {
  const points: Place[] = [];
  const arrivals: string[] = []; // stop id for each leg
  for (const s of stops) {
    if (!s.place || !Number.isFinite(s.place.lat)) continue;
    const prev = points[points.length - 1];
    if (prev && same(prev, s.place)) continue;
    if (prev) arrivals.push(s.id);
    points.push(s.place);
  }
  const out = new Map<string, StopLeg>();
  if (points.length < 2) return out;
  const [drive, walk] = await Promise.all([
    route('car', points),
    route('foot', points).catch(() => null), // walking is a bonus; driving is what matters
  ]);
  arrivals.forEach((id, i) => {
    const d = drive[i];
    if (d) out.set(id, { drive: d, walk: walk?.[i] || null });
  });
  return out;
}

// Stop id → leg, for every day of the trip. Days that fail are skipped.
export async function tripLegs(days: { stops: { id: string; place: Place | null }[] }[]): Promise<Map<string, StopLeg>> {
  const all = new Map<string, StopLeg>();
  for (const d of days) {
    try { for (const [k, v] of await dayLegs(d.stops)) all.set(k, v); } catch { /* try again later */ }
  }
  return all;
}

// Walking if it's a short walk, else driving.
export function bestMode(leg: StopLeg): BestLeg {
  if (leg.walk && leg.walk.s <= 25 * 60) return { mode: 'walk', icon: '🚶', ...leg.walk };
  return { mode: 'drive', icon: '🚗', ...leg.drive };
}
