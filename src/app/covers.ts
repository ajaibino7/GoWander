// Trip cover photos, shared by the header and the trip cards. An uploaded cover wins; otherwise
// a photo of the trip's main destination (autocover.ts); otherwise the default artwork.
import { useEffect, useSyncExternalStore } from 'react';
import * as cloud from '../lib/cloud';
import { autoCover, creditUrl, isAutoUrl, sizedUrl, smallUrl, type CoverInfo, type CoverTrip } from '../lib/autocover';
import { bootSnapshot } from './bootCache';

const uploaded = new Map<string, string>(); // trip id → image data URL
const auto = new Map<string, CoverInfo>(); // trip id → destination photo
// Last visit's photos, so trip cards and headers have them on the first frame.
for (const [id, info] of Object.entries(bootSnapshot()?.covers || {})) auto.set(id, info);

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
/** Re-renders when any cover arrives or changes. */
export const useCovers = (): number => useSyncExternalStore(subscribe, () => version);
/** Calls cb whenever a cover arrives or changes (without re-rendering anything). */
export const onCoversChange = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

const isDataImage = (u: string | null): u is string => !!u && /^data:image\/(jpeg|png|webp);base64,/.test(u);

/** Keeps a trip's uploaded cover up to date while the component is shown. */
export function useUploadedCover(tripId: string | null | undefined): void {
  useEffect(() => {
    if (!tripId) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    cloud.watchCover(tripId, (url) => {
      if (isDataImage(url)) uploaded.set(tripId, url); else uploaded.delete(tripId);
      emit();
    }).then((u) => { if (cancelled) u(); else off = u; }, () => {});
    return () => { cancelled = true; off?.(); };
  }, [tripId]);
}

/** The current uploaded cover (null if none), resolving once the first value arrives. */
export function firstUploadedCover(tripId: string): Promise<string | null> {
  return new Promise((resolve) => {
    let off: (() => void) | undefined;
    let done = false;
    cloud.watchCover(tripId, (url) => {
      if (isDataImage(url)) uploaded.set(tripId, url); else uploaded.delete(tripId);
      emit();
      if (!done) { done = true; resolve(isDataImage(url) ? url : null); }
      off?.();
    }).then((u) => { off = u; if (done) u(); }, () => resolve(null));
  });
}

/** Looks up (or recalls) the destination photo for a trip. */
export function ensureAutoCover(trip: CoverTrip & { id?: string }): Promise<CoverInfo | null> {
  const id = trip.id;
  if (!id) return Promise.resolve(null);
  return autoCover(trip).then((info) => {
    const had = auto.get(id);
    if (info) auto.set(id, info); else auto.delete(id);
    if (had?.hero !== info?.hero) emit();
    return info;
  }, () => null);
}

export function autoCoverOf(tripId: string): CoverInfo | null { return auto.get(tripId) || null; }

/** The destination photos known for these trips (for the start-up snapshot). */
export function autoCoversFor(ids: string[]): Record<string, CoverInfo> {
  const out: Record<string, CoverInfo> = {};
  for (const id of ids) { const a = auto.get(id); if (a) out[id] = a; }
  return out;
}

/** The header background for a trip, and the photo credit when it's a destination photo. */
export function heroCover(tripId: string | null | undefined): { url: string | null; credit: { text: string; href: string } | null } {
  if (!tripId) return { url: null, credit: null };
  const own = uploaded.get(tripId);
  if (own) return { url: own, credit: null };
  const a = auto.get(tripId);
  if (!a || !isAutoUrl(a.hero)) return { url: null, credit: null };
  // Phones get a 960 px copy of the destination photo: a quarter of the pixels to decode.
  const url = innerWidth < 700 ? sizedUrl(a.hero, 960) : a.hero;
  return { url, credit: { text: `Photo: ${a.place} · ${a.source}`, href: creditUrl(a) } };
}

/** A card banner: an uploaded cover already loaded this session (the list doesn't download every
 *  trip's photo), else a small copy of the destination photo. */
export function cardCover(tripId: string): { url: string; title?: string } | null {
  const own = uploaded.get(tripId);
  if (own) return { url: own };
  const a = auto.get(tripId);
  if (a && isAutoUrl(a.hero)) return { url: smallUrl(a.hero), title: `Photo: ${a.place} · ${a.source}` };
  return null;
}
