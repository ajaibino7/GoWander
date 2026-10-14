// "Make offline-ready": one tap before the trip saves what the trip page fetches as you go —
// weather, real travel times, the destination photo and nearby suggestions for every stop — so
// it all still works with no signal. The plan, progress, checklist and expenses already work
// offline through Firestore's offline copy. Map areas aren't pre-downloaded (OpenStreetMap's
// tile rules forbid bulk downloads); areas you've viewed stay saved as usual.
import { tripWeather } from './weather.js';
import { tripLegs } from './routing.js';
import { autoCover, smallUrl } from './autocover.js';
import { nearbyPlaces } from './nearby.js';

export const PHOTO_CACHE = 'gw-photos';
const statusKey = (id) => `gw-offline-${id}`;

export function offlineStatus(tripId) {
  try { return JSON.parse(localStorage.getItem(statusKey(tripId)) || 'null'); } catch { return null; }
}

// Photos are fetched with CORS so the service worker can keep a real (not opaque) copy.
async function savePhoto(url) {
  if (!url || !('caches' in window)) return;
  const cache = await caches.open(PHOTO_CACHE);
  if (await cache.match(url)) return;
  const res = await fetch(url, { mode: 'cors' });
  if (res.ok) await cache.put(url, res);
}

/**
 * trip: the stored trip; days: the trip's days with stop ids (as the trip page prepares them).
 * onProgress({ done, total, label }). Resolves with { places, failed }.
 */
export async function makeOfflineReady(trip, days, onProgress = () => {}) {
  // Nearby places for each distinct place (same rounding as nearby.js's cache, so the trip page
  // finds exactly what was saved).
  const spots = new Map();
  for (const d of days) {
    for (const s of d.stops) {
      if (!s.place || !Number.isFinite(s.place.lat)) continue;
      const k = `${s.place.lat.toFixed(4)},${s.place.lng.toFixed(4)}`;
      if (!spots.has(k)) spots.set(k, s.place);
    }
  }
  const total = 3 + spots.size;
  let done = 0, failed = 0;
  const step = async (label, fn) => {
    onProgress({ done, total, label });
    try { await fn(); } catch { failed++; }
    done++;
  };

  await step('Weather', () => tripWeather(trip));
  await step('Travel times', () => tripLegs(days));
  await step('Destination photo', async () => {
    const info = await autoCover(trip);
    if (info) await Promise.all([savePhoto(info.hero), savePhoto(smallUrl(info.hero))]);
  });
  // One place at a time: the places service is free and shared, and slow when busy.
  let n = 0;
  for (const place of spots.values()) {
    n++;
    await step(`Nearby places ${n} of ${spots.size}`, () => nearbyPlaces(place));
  }
  onProgress({ done, total, label: 'Done' });

  const result = { at: Date.now(), places: spots.size, failed };
  try { localStorage.setItem(statusKey(trip.id), JSON.stringify(result)); } catch { /* storage full */ }
  return result;
}
