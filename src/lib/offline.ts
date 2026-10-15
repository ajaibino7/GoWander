// "Save offline": one tap before the trip saves what the trip page fetches as you go —
// weather, real travel times, the destination photo and nearby suggestions for every stop — so
// it all still works with no signal — plus the SOS card's nearest hospitals and police. The plan,
// progress, checklist and expenses already work offline through Firestore's offline copy. Map areas aren't pre-downloaded (OpenStreetMap's
// tile rules forbid bulk downloads); areas you've viewed stay saved as usual.
import type { Place, Trip } from './types';
import { tripWeather } from './weather';
import { tripLegs } from './routing';
import { autoCover, sizedUrl, smallUrl } from './autocover';
import { nearbyPlaces } from './nearby';
import { nearestHelp } from './sos';

export const PHOTO_CACHE = 'gw-photos';
const statusKey = (id: string) => `gw-offline-${id}`;

export interface OfflineStatus { at: number; places: number; failed: number }
export interface OfflineProgress { done: number; total: number; label: string }

export function offlineStatus(tripId: string): OfflineStatus | null {
  try { return JSON.parse(localStorage.getItem(statusKey(tripId)) || 'null'); } catch { return null; }
}

// Photos are fetched with CORS so the service worker can keep a real (not opaque) copy.
async function savePhoto(url: string): Promise<void> {
  if (!url || !('caches' in window)) return;
  const cache = await caches.open(PHOTO_CACHE);
  if (await cache.match(url)) return;
  const res = await fetch(url, { mode: 'cors' });
  if (res.ok) await cache.put(url, res);
}

/** days: the trip's days with stop ids (as the trip page prepares them). */
export async function makeOfflineReady(
  trip: Trip, days: { stops: { id: string; place: Place }[] }[], onProgress: (p: OfflineProgress) => void = () => {},
): Promise<OfflineStatus> {
  // Nearby places for each distinct place (same rounding as nearby.ts's cache, so the trip page
  // finds exactly what was saved).
  const spots = new Map<string, Place>();
  for (const d of days) {
    for (const s of d.stops) {
      if (!s.place || !Number.isFinite(s.place.lat)) continue;
      const k = `${s.place.lat.toFixed(4)},${s.place.lng.toFixed(4)}`;
      if (!spots.has(k)) spots.set(k, s.place);
    }
  }
  // SOS: hospitals, police and pharmacies around each day's area (sos.ts caches by ~1 km cell).
  const areas = new Map<string, Place>();
  for (const d of days) {
    const p = d.stops[0]?.place;
    if (p && Number.isFinite(p.lat)) areas.set(`${p.lat.toFixed(2)},${p.lng.toFixed(2)}`, p);
  }
  const total = 3 + spots.size + areas.size;
  let done = 0, failed = 0;
  const step = async (label: string, fn: () => Promise<unknown>) => {
    onProgress({ done, total, label });
    try { await fn(); } catch { failed++; }
    done++;
  };

  await step('Weather', () => tripWeather(trip));
  await step('Travel times', () => tripLegs(days));
  await step('Destination photo', async () => {
    const info = await autoCover(trip);
    // The header uses the full photo on computers and a 960 px copy on phones; cards use a small one.
    if (info) await Promise.all([...new Set([info.hero, sizedUrl(info.hero, 960), smallUrl(info.hero)])].map(savePhoto));
  });
  // One place at a time: the places service is free and shared, and slow when busy.
  let n = 0;
  for (const place of spots.values()) {
    n++;
    await step(`Nearby places ${n} of ${spots.size}`, () => nearbyPlaces(place));
  }
  for (const place of areas.values()) await step('Emergency help nearby', () => nearestHelp(place));
  onProgress({ done, total, label: 'Done' });

  const result: OfflineStatus = { at: Date.now(), places: spots.size, failed };
  try { localStorage.setItem(statusKey(trip.id), JSON.stringify(result)); } catch { /* storage full */ }
  return result;
}
