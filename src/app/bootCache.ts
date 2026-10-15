// A snapshot of the home screen (who was signed in, their trips, the trips' destination photos),
// kept on this device so the next visit draws real trip cards on the very first frame. Firebase
// takes a moment to confirm the sign-in and fetch the list; until it does, the app shows the
// snapshot, then the live data quietly takes over.
//
// index.html reads a tiny hint (HINT_KEY) before the app has even loaded: whether a snapshot
// exists (so it skips the placeholder cards) and when each trip is happening (so a trip that's
// live right now opens straight away).
import type { CoverInfo } from '../lib/autocover';
import type { TripEntry, User } from '../lib/types';
import { tripWindow } from '../lib/tripStatus';

const KEY = 'gw-boot-v1';
const HINT_KEY = 'gw-boot-hint'; // also read by the inline script in index.html
const MAX_CHARS = 1_500_000; // stay well inside localStorage's ~5 MB (other caches live there too)

export interface BootSnapshot {
  /** null = nobody was signed in. */
  user: User | null;
  trips: TripEntry[];
  /** Destination photos by trip id, so covers show without waiting for the lookup. */
  covers: Record<string, CoverInfo>;
}

function read(): BootSnapshot | null {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || 'null') as BootSnapshot | null;
    return j && Array.isArray(j.trips) && typeof j.covers === 'object' ? j : null;
  } catch { return null; }
}

// Read once at startup: it describes the last visit, not what's live now.
const atStart = read();
export const bootSnapshot = (): BootSnapshot | null => atStart;

export function saveBoot(user: User | null, trips: TripEntry[], covers: Record<string, CoverInfo>): void {
  try {
    const snap: BootSnapshot = {
      user,
      trips: user ? trips.map((e) => ({ trip: e.trip, meta: { ...e.meta, pending: false } })) : [],
      covers: user ? covers : {},
    };
    const json = JSON.stringify(snap);
    if (json.length > MAX_CHARS) { clearBoot(); return; } // too big to be worth it: placeholders instead
    const live = snap.trips.flatMap((e) => {
      const w = tripWindow(e.trip);
      return w ? [[e.trip.id, w.start.getTime(), w.end.getTime()] as const] : [];
    });
    localStorage.setItem(KEY, json);
    localStorage.setItem(HINT_KEY, JSON.stringify({ signedIn: !!user, live }));
  } catch { /* storage full or unavailable: the app just starts with placeholders */ }
}

/** Forget the snapshot (signing out: the next person on this device mustn't see these trips). */
export function clearBoot(): void {
  try { localStorage.removeItem(KEY); localStorage.removeItem(HINT_KEY); } catch { /* unavailable */ }
}
