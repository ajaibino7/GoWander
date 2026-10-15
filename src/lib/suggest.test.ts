import { describe, expect, it } from 'vitest';
import { listOf, suggestDay, withoutNotes, type SuggestStop } from './suggest';
import type { DayWeather, HourWeather } from './weather';
import type { StopLeg } from './routing';
import type { NearbyItem } from './nearby';

const P = (name: string, lat: number, lng: number) => ({ name, lat, lng, radius: 300 });
const stop = (id: string, start: string, end: string, title: string, extra: Partial<SuggestStop> = {}): SuggestStop =>
  ({ id, start, end, kind: 'stop', title, place: P(title, 15.5 + Number(id.slice(1)) / 100, 73.8), ...extra });
const leg = (min: number, walkMin?: number): StopLeg => ({ drive: { s: min * 60, m: min * 600 }, walk: walkMin ? { s: walkMin * 60, m: walkMin * 80 } : null });
const weather = (o: Partial<DayWeather> = {}, hours: Record<string, Partial<HourWeather>> = {}): DayWeather => ({
  icon: '⛅', label: 'Partly cloudy', max: 31, min: 24, rain: 10,
  hours: new Map(Object.entries(hours).map(([h, v]) => [h, { icon: '', label: '', temp: 30, rain: 0, ...v }])),
  ...o,
});
const ids = (tips: { id: string }[]) => tips.map((t) => t.id);

describe('listOf', () => {
  it('joins names like a sentence', () => {
    expect(listOf(['A'])).toBe('A');
    expect(listOf(['A', 'B'])).toBe('A and B');
    expect(listOf(['A', 'B', 'C'])).toBe('A, B and C');
    expect(listOf(['A', 'B', 'C', 'D', 'A'])).toBe('A, B and 2 more');
  });
});

describe('suggestDay', () => {
  it('says when to be at a departure and when to leave the stop before it', () => {
    const stops = [
      stop('s1', '13:00', '14:00', 'Lunch in Panaji', { kind: 'meal' }),
      stop('s2', '17:30', '18:30', 'Flight home', { kind: 'travel', departure: { buffer: 120 }, place: P('Dabolim Airport', 15.38, 73.83) }),
    ];
    const [tip] = suggestDay({ date: '2030-01-07', stops, legs: new Map([['s2', leg(40)]]) });
    expect(tip?.id).toBe('dep-s2');
    expect(tip?.icon).toBe('✈️');
    // 5:30 PM − 2 h = 3:30 PM at the airport; − 40 min drive − 10 min slack = 2:40 PM.
    expect(tip?.text).toBe('Be at Dabolim Airport by 3:30 PM, 2 h before Flight home at 5:30 PM. Leave Lunch in Panaji by 2:40 PM (40 min drive).');
  });

  it('plans the journey to a station the plan reaches with an earlier "arrive" stop', () => {
    const station = P('LTT', 19.07, 72.89);
    const stops = [
      stop('s1', '15:00', '17:00', 'Juhu shopping'),
      stop('s2', '18:00', '19:00', 'Arrive at LTT', { tag: 'deadline', place: station }),
      stop('s3', '19:30', '20:00', 'Train home', { kind: 'travel', departure: { buffer: 60 }, place: station }),
    ];
    const tips = suggestDay({ date: '2030-01-08', stops, legs: new Map([['s2', leg(45)]]) });
    // Arrival planned for 6:00 PM (earlier than 6:30): 6:00 − 45 min − 10 min = 5:05 PM.
    expect(tips[0]?.text).toBe('Be at LTT by 6:30 PM, 1 h before Train home at 7:30 PM. Leave Juhu shopping by 5:05 PM (45 min drive).');
    expect(tips.map((t) => t.id)).not.toContain('fixed'); // the departure tip covers the station
    expect(suggestDay({ date: '2030-01-08', stops: [{ ...(stops[2] as SuggestStop), tag: 'must' }] }).map((t) => t.id)).not.toContain('highlights');
    // A travel stop ("Head to LTT", 5:00 PM) is the journey: you leave when it starts.
    const head = [stops[0] as SuggestStop, stop('s2', '17:00', '18:00', 'Head to LTT', { kind: 'travel', place: station }), stops[2] as SuggestStop];
    expect(suggestDay({ date: '2030-01-08', stops: head, legs: new Map([['s2', leg(45)]]) })[0]?.text).toContain('Leave Juhu shopping by 5:00 PM (45 min drive).');
  });

  it('flags connections the plan leaves no time for, and long days on the road', () => {
    const stops = [stop('s1', '09:00', '10:00', 'Fort'), stop('s2', '10:10', '11:00', 'Beach'), stop('s3', '11:00', '12:00', 'Cafe')];
    const tips = suggestDay({ date: '2030-01-07', stops, legs: new Map([['s2', leg(70)], ['s3', leg(60, 10)]]) });
    const tight = tips.find((t) => t.id === 'tight');
    expect(tight?.title).toBe('Tight connection'); // the 10 min walk to the café is fine
    expect(tight?.text).toContain('Fort → Beach takes about 1 h 10 min by road, only 10 min planned');
    expect(ids(tips)).not.toContain('road'); // 70 min of driving: under 2 h
  });

  it('reads the forecast: rain at a stop, heat, and a good day — none saved as notes', () => {
    const stops = [stop('s1', '09:00', '11:00', 'Fort'), stop('s2', '15:00', '17:00', 'Beach')];
    const wet = suggestDay({ date: '2030-01-07', stops, weather: weather({ max: 38 }, { '15': { rain: 70 } }) });
    const rain = wet.find((t) => t.id === 'wx-rain');
    expect(rain?.text).toBe('70% chance of rain around 3:00 PM (Beach). Carry an umbrella or a light rain jacket.');
    expect(ids(wet)).toContain('wx-hot');
    expect(wet.filter((t) => t.id.startsWith('wx-')).every((t) => !t.lasting)).toBe(true);
    const fine = suggestDay({ date: '2030-01-07', stops, weather: weather() });
    expect(ids(fine)).toContain('wx-good');
    expect(suggestDay({ date: '2030-01-07', stops, weather: weather({ max: 95 }), unit: 'F' }).some((t) => t.id === 'wx-hot')).toBe(true);
  });

  it('turns labels and stop types into highlights and know-before-you-go', () => {
    const stops = [
      stop('s1', '08:30', '10:00', 'Basilica of Bom Jesus', { tag: 'must' }),
      stop('s2', '10:30', '12:00', 'Fort Aguada', { tag: 'closing' }),
      stop('s3', '16:00', '18:00', 'Sunset at Baga Beach', { tag: 'key' }),
    ];
    const tips = suggestDay({ date: '2030-01-07', stops });
    expect(tips.find((t) => t.id === 'highlights')?.text).toBe("Basilica of Bom Jesus and Sunset at Baga Beach: today's highlights.");
    expect(tips.find((t) => t.id === 'highlights')?.noteType).toBe('star');
    expect(ids(tips)).toEqual(expect.arrayContaining(['closing', 'know-beach', 'know-worship', 'know-climb', 'lunch']));
  });

  it('notices the shape of the day: early, late, long, and no lunch', () => {
    const stops = [stop('s1', '06:00', '12:00', 'Hike'), stop('s2', '12:00', '23:00', 'Party')];
    expect(ids(suggestDay({ date: '2030-01-07', stops }))).toEqual(expect.arrayContaining(['early', 'late', 'long', 'lunch']));
    const withLunch = [...stops, stop('s3', '12:30', '13:30', 'Thali', { kind: 'meal' })];
    expect(ids(suggestDay({ date: '2030-01-07', stops: withLunch }))).not.toContain('lunch');
  });

  it('warns that museums may be shut on a Monday', () => {
    const stops = [stop('s1', '10:00', '12:00', 'City Museum')];
    expect(suggestDay({ date: '2030-01-07', stops }).find((t) => t.id === 'opening')?.title).toBe('Closed on Mondays?'); // 7 Jan 2030 is a Monday
    expect(suggestDay({ date: '2030-01-08', stops }).find((t) => t.id === 'opening')?.title).toBe('Opening days');
  });

  it('suggests a famous place right next to a stop, from nearby places already looked up', () => {
    const s1 = stop('s1', '10:00', '11:00', 'Fort Aguada');
    const near = (name: string, dLat: number, famous = true): NearbyItem => ({ id: name, name, lat: s1.place.lat + dLat, lng: s1.place.lng, dist: 0, cat: 'see', type: 'beach', icon: '🏖️', label: 'Beach', famous, wiki: '', hours: '', detailed: false } as NearbyItem);
    const tips = suggestDay({ date: '2030-01-08', stops: [s1], nearby: () => [near('Tiny Cafe', 0.001, false), near('Sinquerim Beach', 0.003), near('Far Fort', 0.05)] });
    expect(tips.find((t) => t.id === 'nearby')?.text).toBe('Sinquerim Beach, 330 m from Fort Aguada.');
  });

  it('avoids false matches: a neighbourhood called Fort, a hotel called Palace', () => {
    const stops = [
      stop('s1', '09:00', '10:00', 'Arrive in Mumbai', { kind: 'travel', place: P('ISRA Comfort, Fort', 18.93, 72.83) }),
      stop('s2', '13:00', '14:00', 'Lunch in Fort', { kind: 'meal' }),
      stop('s3', '15:00', '16:00', 'Taj Mahal Palace'),
    ];
    const got = suggestDay({ date: '2030-01-07', stops }).map((t) => t.id);
    expect(got).not.toContain('know-climb');
    expect(got).not.toContain('opening');
  });

  it("skips tips the day's notes already cover", () => {
    const stops = [stop('s1', '09:00', '10:00', 'Fort Aguada', { tag: 'must' })];
    const tips = suggestDay({ date: '2030-01-08', stops });
    expect(tips.map((t) => t.id)).toContain('highlights');
    const left = withoutNotes(tips, [{ title: "Don't miss", text: 'Our own words.' }]).map((t) => t.id);
    expect(left).not.toContain('highlights');
    expect(left).toContain('know-climb');
  });

  it('gives nothing for an empty day', () => {
    expect(suggestDay({ date: '2030-01-07', stops: [] })).toEqual([]);
  });
});
