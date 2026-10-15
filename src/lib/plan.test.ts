import { describe, expect, it } from 'vitest';
import { dayMessage, nextSlot, packingFor, planAgain, recapOf, shiftDates, shiftRemaining, withStop } from './plan';
import { balances, guessCategory, myShare, pairwiseDebts, parts, settlements, spendByCategory, upiLink, isUpiId } from './expenses';
import { normalizeBooking, normalizeTrip } from './store';
import { emergencyFor, telOf } from './sos';
import type { Expense, Stop, Trip } from './types';
import type { DayWeather } from './weather';

const P = (name: string, lat = 15.5, lng = 73.8) => ({ name, lat, lng, radius: 300 });
const S = (id: string, start: string, end: string, title: string, extra: Partial<Stop> = {}): Stop =>
  ({ id, start, end, kind: 'stop', title, place: P(title, 15.5 + Number(id.slice(1)) / 100), ...extra });
const trip = (stops: Stop[][], extra: Partial<Trip> = {}): Trip => ({
  id: 't', title: 'Goa', subtitle: '', timezone: 'Asia/Kolkata',
  days: stops.map((s, i) => ({ date: `2030-01-0${i + 1}`, title: i ? '' : 'Beaches', stops: s, notes: [] })), ...extra,
});
const wx = (o: Partial<DayWeather> = {}): DayWeather => ({ icon: '⛅', label: 'Partly cloudy', max: 30, min: 24, rain: 10, hours: new Map(), ...o });

describe('running late', () => {
  const day = [
    S('s1', '09:00', '10:00', 'Breakfast'),
    S('s2', '10:30', '12:00', 'Fort'),
    S('s3', '13:00', '14:00', 'Lunch'),
    S('s4', '15:00', '15:30', 'Train', { departure: { buffer: 30 } }),
    S('s5', '16:00', '17:00', 'Later'),
  ];
  it('pushes what is ahead back, stretches the stop in progress, and keeps fixed stops', () => {
    const r = shiftRemaining(day, 11 * 60, 30); // 11:00, during the fort
    const at = (id: string) => r.stops.find((s) => s.id === id);
    expect([at('s1')?.start, at('s1')?.end]).toEqual(['09:00', '10:00']); // done already
    expect([at('s2')?.start, at('s2')?.end]).toEqual(['10:30', '12:30']); // runs longer
    expect([at('s3')?.start, at('s3')?.end]).toEqual(['13:30', '14:30']);
    expect([at('s4')?.start, at('s4')?.end]).toEqual(['15:00', '15:30']); // the train doesn't move
    expect(r.moved.map((s) => s.id)).toEqual(['s2', 's3', 's5']);
    expect(r.clashes).toEqual([]);
  });
  it('says what no longer fits before a fixed time, and what would run past midnight', () => {
    const r = shiftRemaining(day, 11 * 60, 90);
    expect(r.clashes.map((c) => `${c.stop.id}>${c.fixed.id}`)).toEqual(['s3>s4']); // lunch now ends 15:30
    const late = shiftRemaining([S('s1', '22:00', '23:30', 'Party')], 21 * 60, 60);
    expect(late.overflow.map((s) => s.end)).toEqual(['23:59']);
  });
});

describe('WhatsApp message', () => {
  it('lists the day with times, map links, highlights, tickets and notes', () => {
    const t = trip([[S('s1', '09:30', '11:00', 'Fort Aguada', { tag: 'must' }), S('s2', '17:30', '18:30', 'Train home', { booking: { pnr: '1234567890' } })]]);
    t.days[0]?.notes.push({ type: 'tip', title: 'Tip', text: 'Carry water' });
    const msg = dayMessage(t, t.days[0] as Trip['days'][0], 1, wx());
    expect(msg).toContain('*Goa*');
    expect(msg).toContain('*Day 1 · ');
    expect(msg).toContain('— Beaches');
    expect(msg).toContain('⛅ Partly cloudy · 30° / 24°');
    expect(msg).toContain('🕒 *9:30 AM* Fort Aguada ⭐');
    expect(msg).toContain('📍 Fort Aguada https://maps.google.com/?q=15.51000,73.80000');
    expect(msg).toContain('🎫 PNR 1234567890');
    expect(msg).toContain('_Tip:_ Carry water');
  });
});

describe('smart packing', () => {
  it('works things out from places, departures, forecast and length, and skips what is listed', () => {
    const t = trip([
      [S('s1', '09:00', '20:30', 'Baga Beach'), S('s2', '21:00', '22:00', 'Flight', { departure: { buffer: 60 } })],
      [S('s3', '10:00', '12:00', 'Chapora Fort')],
    ]);
    const items = packingFor(t, new Map([['2030-01-01', wx({ rain: 70 })], ['2030-01-02', wx({ max: 36 })]]), ['Charger', 'sunscreen lotion']);
    const names = items.map((i) => i.text);
    expect(names).toEqual(expect.arrayContaining(['ID card', 'Tickets (printed or on phone)', 'Sunglasses', 'Comfortable walking shoes', 'Umbrella', 'Cap or hat', 'Power bank', 'Toiletries', 'Clothes for 2 days']));
    expect(names).not.toContain('Phone charger'); // "Charger" is on the list
    expect(names).not.toContain('Sunscreen');
    expect(names).not.toContain('Warm jacket');
    expect(items.find((i) => i.text === 'Umbrella')?.why).toBe('Rain in the forecast');
  });
});

describe('adding a stop', () => {
  it('slots it into the day in time order, and finds the next free hour', () => {
    const t = trip([[S('s1', '09:00', '10:00', 'A'), S('s2', '14:00', '15:00', 'B')]]);
    const next = withStop(t, '2030-01-01', { title: 'Idea', start: '11:00', end: '12:00', kind: 'meal', place: P('Cafe') });
    expect(next.days[0]?.stops.map((s) => s.title)).toEqual(['A', 'Idea', 'B']);
    expect(t.days[0]?.stops.length).toBe(2); // the original is untouched
    expect(() => withStop(t, '2031-01-01', { title: 'x', start: '09:00', end: '10:00', kind: 'stop', place: P('x') })).toThrow();
    expect(nextSlot(t.days[0])).toEqual({ start: '15:00', end: '16:00' });
    expect(nextSlot(undefined)).toEqual({ start: '10:00', end: '11:00' });
  });
});

describe('starting again', () => {
  it('moves a trip to new dates, keeping the gaps between days', () => {
    const t = trip([[S('s1', '09:00', '10:00', 'A')], [S('s2', '09:00', '10:00', 'B')]]);
    t.days[1] && (t.days[1].date = '2030-01-04'); // a gap of two days
    expect(shiftDates(t, '2031-02-27').days.map((d) => d.date)).toEqual(['2031-02-27', '2031-03-02']);
    expect(t.days[0]?.date).toBe('2030-01-01'); // the original is untouched
  });
  it('plans again without the thumbs-down stops, keeping notes from reviews', () => {
    const t = trip([[S('s1', '09:00', '10:00', 'Great fort', { note: 'Go early' }), S('s2', '11:00', '12:00', 'Tourist trap'), S('s3', '13:00', '14:00', 'Lunch')]]);
    const reviews = [
      { stopId: 's1', email: 'a', vote: 1 as const, note: 'Sunrise view!' },
      { stopId: 's2', email: 'a', vote: -1 as const, note: '' },
      { stopId: 's2', email: 'b', vote: -1 as const, note: 'Overpriced' },
      { stopId: 's3', email: 'a', vote: 1 as const, note: '' },
      { stopId: 's3', email: 'b', vote: -1 as const, note: '' }, // a tie stays
    ];
    const { draft, dropped } = planAgain(t, reviews, '2031-05-01');
    expect(dropped).toEqual(['Tourist trap']);
    expect(draft.title).toBe('Goa (again)');
    expect(draft.days[0]?.date).toBe('2031-05-01');
    expect(draft.days[0]?.stops.map((s) => s.title)).toEqual(['Great fort', 'Lunch']);
    expect(draft.days[0]?.stops[0]?.note).toBe('Go early · 👍 Sunrise view!');
    expect(draft.days[0]?.stops[0]?.id).not.toBe('s1'); // a separate trip
  });
});

describe('recap', () => {
  it('counts days, stops, places, done, distance and the busiest day', () => {
    const t = trip([[S('s1', '09:00', '10:00', 'A'), S('s2', '11:00', '12:00', 'B')], [S('s3', '09:00', '10:00', 'C')]]);
    const r = recapOf(t, new Set(['s1', 'x']), new Map([['s2', 2500]]));
    expect(r).toMatchObject({ days: 2, stops: 3, places: 3, done: 1, distance: 2500, busiest: { n: 1, stops: 2 } });
  });
});

describe('expenses: split by amount, categories, UPI', () => {
  const x = (o: Partial<Expense>): Expense => ({ id: '1', title: 'Dinner', amount: 900, currency: 'INR', paidBy: 'a', split: ['a', 'b', 'c'], date: '2030-01-01', kind: 'expense', createdBy: 'a', createdMs: 0, ...o });
  it('uses exact amounts when split by amount', () => {
    const e = x({ shares: { a: 500, b: 400 } }); // c had nothing
    expect(Object.fromEntries(parts(e))).toEqual({ a: 500, b: 400 });
    const bal = balances([e]).get('INR')?.bal ?? new Map();
    expect(Object.fromEntries(bal)).toEqual({ a: 400, b: -400 });
    expect(settlements(bal)).toEqual([{ from: 'b', to: 'a', amount: 400 }]);
    expect(myShare([e], 'c', 'INR')).toBe(0);
  });
  it('nets what each pair owes, minus what was paid back', () => {
    const list = [
      x({ paidBy: 'a', amount: 900, split: ['a', 'b', 'c'] }), // b and c each owe a 300
      x({ paidBy: 'b', amount: 200, split: ['a', 'b'] }), // a owes b 100
      x({ paidBy: 'c', amount: 300, split: ['b', 'c'], shares: { b: 300 } }), // b owes c 300
    ];
    // a↔b: b owes 300, a owes 100 → b owes a 200. c owes a 300. b owes c 300.
    const key = (d: { from: string; to: string; amount: number }) => `${d.from}>${d.to}:${d.amount}`;
    expect(pairwiseDebts(list).map(key).sort()).toEqual(['b>a:200', 'b>c:300', 'c>a:300']);
    // b pays a back 150: 50 left. c pays a 300 in full: gone. Overpaying flips the debt.
    const paid = [...list, x({ kind: 'settlement', paidBy: 'b', split: ['a'], amount: 150 }), x({ kind: 'settlement', paidBy: 'c', split: ['a'], amount: 300 })];
    expect(pairwiseDebts(paid).map(key).sort()).toEqual(['b>a:50', 'b>c:300']);
    expect(pairwiseDebts([...paid, x({ kind: 'settlement', paidBy: 'b', split: ['a'], amount: 80 })]).map(key).sort()).toEqual(['a>b:30', 'b>c:300']);
    // Different currencies never mix.
    expect(pairwiseDebts([x({ paidBy: 'a', amount: 100, split: ['b'] }), x({ paidBy: 'b', amount: 50, split: ['a'], currency: 'USD' })]).map((d) => `${d.from}>${d.to}:${d.amount}${d.currency}`).sort())
      .toEqual(['a>b:50USD', 'b>a:100INR']);
  });
  it('guesses categories and sums spending by category', () => {
    expect(guessCategory('Taxi to CSMT')).toBe('travel');
    expect(guessCategory('Fish thali')).toBe('food');
    expect(guessCategory('Fort entry tickets')).toBe('tickets');
    expect(guessCategory('Hotel night 2')).toBe('stay');
    expect(guessCategory('Misc')).toBe('other');
    expect(spendByCategory([x({}), x({ title: 'Cab', amount: 300 }), x({ title: 'Lunch', amount: 100, category: 'food' })], 'INR')).toEqual([['food', 1000], ['travel', 300]]);
  });
  it('builds UPI links and checks UPI IDs', () => {
    expect(upiLink({ vpa: 'ravi@okicici', name: 'Ravi', amount: 350, note: 'Goa trip' })).toBe('upi://pay?pa=ravi@okicici&pn=Ravi&am=350.00&cu=INR&tn=Goa%20trip');
    expect(isUpiId('ravi.k@okicici')).toBe(true);
    expect(isUpiId('not a upi')).toBe(false);
  });
});

describe('bookings and SOS', () => {
  it('keeps only clean booking details', () => {
    expect(normalizeBooking({ pnr: '123-456-7890', ref: ' ABC123 ', phone: 'tel: +91 98765 43210', link: 'javascript:alert(1)', junk: 1 })).toEqual({ pnr: '1234567890', ref: 'ABC123', phone: '+91 98765 43210' });
    expect(normalizeBooking({})).toBeUndefined();
    const t = normalizeTrip({ title: 'x', days: [{ date: '2030-01-01', stops: [{ start: '09:00', end: '10:00', title: 'Train', place: P('LTT'), booking: { pnr: '1234567890', link: 'https://irctc.co.in/x' } }] }] });
    expect(t.days[0]?.stops[0]?.booking).toEqual({ pnr: '1234567890', link: 'https://irctc.co.in/x' });
  });
  it('knows local emergency numbers', () => {
    expect(emergencyFor('Asia/Kolkata').numbers[0]?.number).toBe('112');
    expect(emergencyFor('Asia/Bangkok').name).toBe('Thailand');
    expect(emergencyFor('Europe/Paris').numbers[0]?.number).toBe('112');
    expect(emergencyFor('America/New_York').numbers[0]?.number).toBe('911');
    expect(emergencyFor('Pacific/Fiji').numbers[0]?.number).toBe('112');
    expect(telOf('+91 832 2458727; +91 832 2458728')).toBe('+918322458727');
  });
});
