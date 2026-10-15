// What to call people on the open trip: the nickname they chose for it, else the start of their
// email ("asha" for asha@gmail.com). Also each member's UPI ID. Screens about a trip call
// useTripProfiles(id); everything below them uses displayName(email).
import { useEffect, useSyncExternalStore } from 'react';
import * as cloud from '../lib/cloud';
import type { Profile } from '../lib/types';

const EMPTY = new Map<string, Profile>();
const cache = new Map<string, Map<string, Profile>>(); // trip id → profiles, so names show at once on return
let current: { tripId: string | null; profiles: Map<string, Profile> } = { tripId: null, profiles: EMPTY };

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Keeps the trip's members' profiles live while the screen is open; returns them. */
export function useTripProfiles(tripId: string | null): Map<string, Profile> {
  useEffect(() => {
    if (!tripId) return undefined;
    current = { tripId, profiles: cache.get(tripId) || EMPTY };
    emit();
    let off: (() => void) | undefined, gone = false;
    cloud.watchProfiles(tripId, (p) => {
      cache.set(tripId, p);
      if (current.tripId === tripId) { current = { tripId, profiles: p }; emit(); }
    }).then((u) => { if (gone) u(); else off = u; }, () => {});
    return () => { gone = true; off?.(); };
  }, [tripId]);
  useSyncExternalStore(subscribe, () => version);
  return tripId && current.tripId === tripId ? current.profiles : EMPTY;
}

/** Re-renders when names change (for components below a screen that called useTripProfiles). */
export const useNames = (): number => useSyncExternalStore(subscribe, () => version);

/** A member's nickname on the open trip, else the start of their email. */
export function displayName(email: string): string {
  const nick = current.profiles.get(email)?.nickname?.trim();
  return nick || (email || '').split('@')[0] || email;
}
/** The open trip's profiles (for components below a screen that called useTripProfiles). */
export function useProfiles(): Map<string, Profile> { useNames(); return current.profiles; }
/** Whether the trip's profiles have arrived (so "no nickname yet" is known, not just loading). */
export const profilesLoaded = (tripId: string): boolean => cache.has(tripId);
export const profileOf = (email: string): Profile | undefined => current.profiles.get(email);

// The nickname you last chose (on any trip), to suggest on the next one.
const LAST = 'gw-last-nickname';
export const lastNickname = (): string => { try { return localStorage.getItem(LAST) || ''; } catch { return ''; } };
export const rememberNickname = (n: string): void => { try { localStorage.setItem(LAST, n); } catch { /* storage unavailable */ } };
