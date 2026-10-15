import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { balances, myShare, settlements } from './expenses';
import { fold, tripToIcs } from './calendar';
import { titleNames } from './autocover';
import { GENERAL, intentFor } from './nearby';
import { byStatus, canEditTrip, tripStatus } from './tripStatus';
import { decodeShare, encodeShare, normalizeTrip } from './store';
import type { Expense, Trip, TripMeta } from './types';

const sample = (): Trip => {
  const raw = JSON.parse(readFileSync(new URL('../../public/data/trips.json', import.meta.url), 'utf8')) as { trips: unknown[] };
  return normalizeTrip(raw.trips[0]);
};

describe('expenses', () => {
  const x = (paidBy: string, amount: number, split: string[], kind: Expense['kind'] = 'expense', currency = 'INR') =>
    ({ id: Math.random().toString(), paidBy, amount, split, kind, currency, title: '', date: '', createdMs: 0, createdBy: paidBy } as unknown as Expense);
  it('balances: payer credited, everyone in the split debited equally', () => {
    const by = balances([x('a', 300, ['a', 'b', 'c']), x('b', 60, ['b', 'c'])]);
    const inr = by.get('INR');
    expect(inr?.spent).toBe(360);
    expect(Object.fromEntries(inr?.bal ?? [])).toEqual({ a: 200, b: -70, c: -130 });
  });
  it('settlements: fewest payments, settlements not counted as spending', () => {
    const list = [x('a', 300, ['a', 'b', 'c']), x('b', 60, ['b', 'c'])];
    const s = settlements(balances(list).get('INR')?.bal ?? new Map());
    expect(s).toEqual([{ from: 'c', to: 'a', amount: 130 }, { from: 'b', to: 'a', amount: 70 }]);
    const after = balances([...list, x('c', 130, ['a'], 'settlement'), x('b', 70, ['a'], 'settlement')]).get('INR');
    expect(after?.spent).toBe(360);
    expect(settlements(after?.bal ?? new Map())).toEqual([]);
    expect(myShare(list, 'c', 'INR')).toBe(130);
  });
  it('keeps currencies apart', () => {
    const by = balances([x('a', 10, ['b'], 'expense', 'USD'), x('b', 100, ['a'])]);
    expect([...by.keys()].sort()).toEqual(['INR', 'USD']);
  });
});

describe('calendar', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  it('folds long lines at 75 bytes without splitting characters', () => {
    const line = `SUMMARY:${'🎒é'.repeat(40)}`;
    const out = fold(line).split('\r\n');
    expect(out.length).toBeGreaterThan(1);
    for (const l of out) expect(bytes(l)).toBeLessThanOrEqual(75);
    expect(out.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(line);
    expect(fold('SHORT')).toBe('SHORT');
  });
  it('exports every stop plus the packing reminder with 8 h, 4 h and 1 h alarms', () => {
    const trip = sample();
    const ics = tripToIcs(trip, { checklist: [{ id: '1', list: 'packing', text: 'Charger', done: false, doneBy: '', createdMs: 0, createdBy: '' }], checklistUrl: 'https://x/#/checklist/t' });
    const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(stops + 1);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:🎒 Pack & prepare for Mumbai + Lonavala');
    expect(unfolded).toContain('Still to pack (1):\\n• Charger');
    for (const t of ['TRIGGER:-PT7H', 'TRIGGER:-PT3H', 'TRIGGER:PT0S']) expect(unfolded).toContain(t);
    // 11:00 in Mumbai (UTC+5:30) is 05:30 UTC; the prep event is the hour before.
    expect(unfolded).toContain('DTSTART:20261017T043000Z');
    expect(unfolded).toContain('DTSTART:20261017T053000Z');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});

describe('auto cover title names', () => {
  it('pulls places out of trip titles and drops generic words', () => {
    expect(titleNames({ title: 'Mumbai + Lonavala' })).toEqual(['Mumbai', 'Lonavala']);
    expect(titleNames({ title: 'Goa long weekend' })).toEqual(['Goa']);
    expect(titleNames({ title: 'Family trip' })).toEqual([]);
    expect(titleNames({ title: 'Delhi to Agra and Jaipur' })).toEqual(['Delhi', 'Agra', 'Jaipur']);
    expect(titleNames({ title: 'Bangkok 2026' })).toEqual(['Bangkok']);
  });
});

describe('nearby intent', () => {
  it('reads what the stop is for', () => {
    expect(intentFor({ title: 'Lunch in Fort', kind: 'meal' }).key).toBe('lunch');
    expect(intentFor({ title: 'Pub, live music or café hopping', kind: 'stop' }).key).toBe('drinks');
    expect(intentFor({ title: 'Dinner, music & a relaxed evening', kind: 'meal' }).key).toBe('dinner');
    expect(intentFor({ title: 'Around Colaba', note: 'grab breakfast', kind: 'meal' }).key).toBe('breakfast');
    expect(intentFor({ title: 'Tiger Point', note: 'Valley views and roadside snacks', kind: 'stop' })).toBe(GENERAL);
    expect(intentFor({ title: 'Colaba Causeway', note: 'street shopping', kind: 'stop' }).key).toBe('shop');
    expect(intentFor({ title: 'Somewhere', kind: 'meal' }).key).toBe('eat');
  });
});

describe('trip status', () => {
  const trip = sample();
  it('live, soon, past and empty', () => {
    expect(tripStatus(trip, new Date('2026-10-17T06:00:00Z')).key).toBe('live');
    expect(tripStatus(trip, new Date('2026-10-16T06:00:00Z')).label).toBe('Starts tomorrow');
    expect(tripStatus(trip, new Date('2026-10-10T06:00:00Z')).label).toBe('In 7 days');
    expect(tripStatus(trip, new Date('2026-11-01T00:00:00Z')).key).toBe('past');
    expect(tripStatus({ ...trip, days: [] }).key).toBe('empty');
  });
  it('sorts live first, then soonest, then latest finished, then empty', () => {
    const st = (key: 'live' | 'soon' | 'past' | 'empty', order: number, at?: number) => ({ st: { key, label: '', order, at } });
    const list = [st('past', 2, 1), st('empty', 3), st('soon', 1, 50), st('past', 2, 9), st('soon', 1, 10), st('live', 0)];
    expect(list.sort(byStatus).map((x) => `${x.st.key}${x.st.at ?? ''}`)).toEqual(['live', 'soon10', 'soon50', 'past9', 'past1', 'empty']);
  });
  it('view-only members cannot edit', () => {
    const meta = { viewerEmails: ['v@x.com'] } as TripMeta;
    const u = (email: string) => ({ uid: email, email, name: '', photo: '' });
    expect(canEditTrip(meta, u('e@x.com'))).toBe(true);
    expect(canEditTrip(meta, u('v@x.com'))).toBe(false);
    expect(canEditTrip(null, u('e@x.com'))).toBe(false);
  });
});

describe('share links', () => {
  it('round-trip a whole trip', async () => {
    const trip = sample();
    expect(await decodeShare(await encodeShare(trip))).toEqual(trip);
    await expect(decodeShare('not-a-trip')).rejects.toThrow();
  });
  it('give stops stable ids', () => {
    const a = sample(), b = sample();
    expect(a.days[0]?.stops[0]?.id).toBeTruthy();
    expect(a.days.map((d) => d.stops.map((s) => s.id))).toEqual(b.days.map((d) => d.stops.map((s) => s.id)));
  });
});
