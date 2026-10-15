import { describe, expect, it } from 'vitest';
import { dateRules, moveStopToDay, nextDayDate, parseCoords, sortDraft, swapStops, tzToday, validateDraft } from './editing';
import type { DraftDay, DraftStop, DraftTrip } from './types';
import { addDays } from './util';

const place = { name: 'X', lat: 1, lng: 2, radius: 100 };
const stop = (id: string, start: string, end: string, extra: Partial<DraftStop> = {}): DraftStop =>
  ({ id, start, end, kind: 'stop', title: id, note: '', place, ...extra });
const day = (date: string, stops: DraftStop[] = []): DraftDay => ({ date, title: '', stops, notes: [] });

describe('swapStops', () => {
  it('swaps two stops, keeping each duration and the gap between them', () => {
    const stops = [stop('a', '09:00', '10:00'), stop('b', '10:30', '12:30')];
    swapStops(stops, 0);
    expect(stops.map((s) => [s.id, s.start, s.end])).toEqual([['b', '09:00', '11:00'], ['a', '11:30', '12:30']]);
  });
  it('just swaps when times are missing, and ignores out-of-range indexes', () => {
    const stops = [stop('a', '', ''), stop('b', '10:00', '11:00')];
    swapStops(stops, 0);
    expect(stops.map((s) => s.id)).toEqual(['b', 'a']);
    expect(stops[0]?.start).toBe('10:00');
    swapStops(stops, 1);
    expect(stops.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('moveStopToDay', () => {
  it('slots the stop in by start time and returns its position', () => {
    const days = [day('2030-01-01', [stop('a', '12:00', '13:00')]), day('2030-01-02', [stop('b', '09:00', '10:00'), stop('c', '15:00', '16:00')])];
    expect(moveStopToDay(days, 0, 0, 1)).toBe(1);
    expect(days[0]?.stops).toEqual([]);
    expect(days[1]?.stops.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
  it('goes last when it starts after everything, and -1 for bad indexes', () => {
    const days = [day('2030-01-01', [stop('a', '20:00', '21:00')]), day('2030-01-02', [stop('b', '09:00', '10:00')])];
    expect(moveStopToDay(days, 0, 0, 1)).toBe(1);
    expect(moveStopToDay(days, 0, 5, 1)).toBe(-1);
    expect(moveStopToDay(days, 0, 0, 9)).toBe(-1);
  });
});

describe('dates', () => {
  const tz = 'Asia/Kolkata';
  const today = tzToday(tz);
  const yesterday = addDays(today, -1);
  it('blocks past dates unless the trip already had them', () => {
    const rules = dateRules(['2020-05-05'], tz);
    expect(rules.pastNotAllowed(yesterday)).toBe(true);
    expect(rules.pastNotAllowed('2020-05-05')).toBe(false);
    expect(rules.pastNotAllowed(today)).toBe(false);
    expect(rules.pastNotAllowed('')).toBe(false);
    expect(rules.minDate('2020-05-05')).toBe('2020-05-05');
    expect(rules.minDate(yesterday)).toBe(today);
    expect(rules.minDate('')).toBe(today);
  });
  it('a new day follows the last one, but never lands in the past', () => {
    expect(nextDayDate([day('2999-01-01')], tz)).toBe('2999-01-02');
    expect(nextDayDate([day('2001-01-01')], tz)).toBe(today);
    expect(nextDayDate([], tz)).toBe(today);
  });
});

describe('validateDraft', () => {
  const base = (): DraftTrip => ({ id: 't', title: 'Trip', subtitle: '', timezone: 'Asia/Kolkata', days: [day('2999-01-01', [stop('a', '09:00', '10:00')])] });
  const never = () => false;
  it('accepts a complete trip', () => {
    expect(validateDraft(base(), never).errors).toEqual([]);
  });
  it('reports every problem, and which stops are wrong', () => {
    const d = base();
    d.title = ' ';
    d.days.push(day('2999-01-01', [stop('b', '11:00', '10:00', { title: '', place: null })]));
    d.days[1]?.notes.push({ type: 'tip', title: '', text: '' });
    const v = validateDraft(d, never);
    expect(v.errors).toEqual([
      'Give the trip a name.',
      'Day 2: 2999-01-01 is used by another day.',
      'Day 2, stop 1: add a title.',
      'Day 2, stop 1: ends before it starts (stops can\'t run past midnight — split it across two days).',
      'Day 2, stop 1: set a location.',
      'Day 2, note 1: write something or remove it.',
    ]);
    expect([...v.badStops]).toEqual(['1.0']);
  });
  it('rejects past dates and missing days', () => {
    expect(validateDraft(base(), () => true).errors).toEqual(['Day 1: 2999-01-01 has already passed. Pick today or a later date.']);
    expect(validateDraft({ ...base(), days: [] }, never).errors).toEqual(['Add at least one day.']);
  });
});

describe('sortDraft', () => {
  it('orders stops by time and days by date', () => {
    const d: DraftTrip = { id: 't', title: 'T', subtitle: '', timezone: '', days: [day('2030-01-02', [stop('b', '12:00', '13:00'), stop('a', '08:00', '09:00')]), day('2030-01-01')] };
    sortDraft(d);
    expect(d.days.map((x) => x.date)).toEqual(['2030-01-01', '2030-01-02']);
    expect(d.days[1]?.stops.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('parseCoords', () => {
  it('reads map links and plain coordinates', () => {
    expect(parseCoords('https://www.google.com/maps/place/X/@18.9,72.8,15z/data=!3d18.9220!4d72.8347')).toEqual({ lat: 18.922, lng: 72.8347 });
    expect(parseCoords('https://www.google.com/maps/@18.95,72.82,14z')).toEqual({ lat: 18.95, lng: 72.82 });
    expect(parseCoords('https://maps.apple.com/?ll=18.5,73.8&q=Pune')).toEqual({ lat: 18.5, lng: 73.8 });
    expect(parseCoords('https://www.openstreetmap.org/?mlat=18.7&mlon=73.4#map=15/18.7/73.4')).toEqual({ lat: 18.7, lng: 73.4 });
    expect(parseCoords(' 18.7548, 73.3767 ')).toEqual({ lat: 18.7548, lng: 73.3767 });
    expect(parseCoords('-33.86 151.2')).toEqual({ lat: -33.86, lng: 151.2 });
  });
  it('rejects text and out-of-range values', () => {
    expect(parseCoords('Gateway of India')).toBeNull();
    expect(parseCoords('95, 10')).toBeNull();
  });
});
