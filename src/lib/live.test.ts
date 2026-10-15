import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeTrip } from './store';
import type { Trip } from './types';

// live.ts reads test-mode settings from the address at load time.
(globalThis as { location?: unknown }).location ??= { search: '' };
const { computeStatus, live, prepare } = await import('./live');

const sample = (): Trip => {
  const raw = JSON.parse(readFileSync(new URL('../../public/data/trips.json', import.meta.url), 'utf8')) as { trips: unknown[] };
  return normalizeTrip(raw.trips[0]);
};

// The test panel's scenarios (src/app/TestKit.tsx), checked against the bundled Mumbai trip.
describe('live status scenarios', () => {
  const trip = sample();
  const p = prepare(trip);
  live.trip = trip;
  live.clock = p.clock;
  live.days = p.days;
  live.done = new Set();
  const placeOf = (d: number, i: number) => {
    const pl = p.days[d - 1]?.stops[i]?.place;
    if (!pl) throw new Error(`no stop ${d}.${i}`);
    return { lat: pl.lat, lng: pl.lng, accuracy: 25 };
  };
  const at = (lat: number, lng: number) => ({ lat, lng, accuracy: 25 });
  const cases: [string, string, ReturnType<typeof at> | null, string][] = [
    ['Before the trip', '2026-10-16T20:00', null, 'Countdown'],
    ['D1 · At CSMT on time', '2026-10-17T14:10', placeOf(1, 2), 'On track'],
    ['D1 · Still at Colaba Causeway, late', '2026-10-17T17:20', placeOf(1, 5), 'Running behind'],
    ['D1 · Marine Drive at night', '2026-10-17T20:30', placeOf(1, 8), 'On track'],
    ['D1 · Day over', '2026-10-17T23:45', null, 'Rest up'],
    ['D2 · Reaching Khandala', '2026-10-18T08:00', at(18.7548, 73.3767), 'On track'],
    ["D2 · At Tiger Point during Lion's", '2026-10-18T11:10', placeOf(2, 4), 'Ahead'],
    ['D2 · At Tiger Point', '2026-10-18T12:20', placeOf(2, 4), 'On track'],
    ['D2 · Location off', '2026-10-18T12:20', null, 'In progress'],
    ['D3 · Driving to Mumbai', '2026-10-19T09:30', at(18.80, 73.30), 'En route'],
    ['D3 · At Bandra Fort', '2026-10-19T16:45', placeOf(3, 6), 'On track'],
    ['D4 · Wrapping up at Juhu', '2026-10-20T17:30', placeOf(4, 1), 'Leave in'],
    ['D4 · Still at Juhu, too late', '2026-10-20T18:00', placeOf(4, 1), 'Leave now'],
    ['D4 · At LTT before the train', '2026-10-20T18:45', placeOf(4, 7), 'At the station'],
    ['After the trip', '2026-10-21T09:00', null, 'Complete'],
  ];
  it.each(cases)('%s', (_name, when, pos, expected) => {
    expect(computeStatus(p.clock.parseInput(when), pos).pill.text.startsWith(expected)).toBe(true);
  });
});
