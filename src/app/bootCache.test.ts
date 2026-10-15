import { beforeEach, describe, expect, it } from 'vitest';
import type { TripEntry, TripMeta } from '../lib/types';

// A minimal localStorage, installed before the module reads it.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
};
const { saveBoot, clearBoot } = await import('./bootCache');

const user = { uid: 'u1', email: 'a@x.com', name: 'A', photo: '' };
const place = { name: 'P', lat: 18.9, lng: 72.8, radius: 300 };
const entry = (id: string, date: string): TripEntry => ({
  trip: { id, title: id, subtitle: '', timezone: 'Asia/Kolkata', days: [{ date, title: '', notes: [], stops: [{ id: 's1', start: '10:00', end: '12:00', kind: 'stop', title: 'x', place }] }] },
  meta: { ownerUid: 'u1', ownerEmail: 'a@x.com', memberEmails: ['a@x.com'], viewerEmails: [], linkJoin: false, linkRole: 'edit', updatedAtMs: 1, updatedBy: 'a@x.com', pending: true } as TripMeta,
});

describe('start-up snapshot', () => {
  beforeEach(() => mem.clear());

  it('saves the trips, and a hint index.html can read: signed in + when each trip runs', () => {
    saveBoot(user, [entry('t1', '2030-01-05')], {});
    const snap = JSON.parse(mem.get('gw-boot-v1') || '{}');
    expect(snap.user.uid).toBe('u1');
    expect(snap.trips[0].meta.pending).toBe(false); // never shows "Syncing…" from an old visit
    const hint = JSON.parse(mem.get('gw-boot-hint') || '{}');
    expect(hint.signedIn).toBe(true);
    // 10:00–12:00 in Mumbai (UTC+5:30) = 04:30–06:30 UTC.
    expect(hint.live).toEqual([['t1', Date.UTC(2030, 0, 5, 4, 30), Date.UTC(2030, 0, 5, 6, 30)]]);
  });

  it('remembers a signed-out visit without any trips', () => {
    saveBoot(null, [entry('t1', '2030-01-05')], {});
    expect(JSON.parse(mem.get('gw-boot-v1') || '{}').trips).toEqual([]);
    expect(JSON.parse(mem.get('gw-boot-hint') || '{}')).toEqual({ signedIn: false, live: [] });
  });

  it('skips a snapshot that would be too big, and clears on sign-out', () => {
    const big = entry('t1', '2030-01-05');
    big.trip.subtitle = 'x'.repeat(1_600_000);
    saveBoot(user, [big], {});
    expect(mem.has('gw-boot-v1')).toBe(false);
    saveBoot(user, [entry('t2', '2030-01-05')], {});
    clearBoot();
    expect(mem.size).toBe(0);
  });
});
