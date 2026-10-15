// Plan helpers for the group features: shifting a day when you're running late, the day's plan as
// a message for WhatsApp, a packing list from the trip itself, adding a stop from an idea or a
// poll, and the numbers for the trip recap. Pure functions, so they're easy to test.
import type { Booking, Day, DraftStop, DraftTrip, Place, Review, Stop, StopKind, Trip } from './types';
import type { DayWeather } from './weather';
import { addDays, distM, fmtDist, fmtHHMM, fromMin, shortDate, toMin } from './util';
import { newStopId } from './store';

/* ============================================================
   Running late: push the rest of the day back
   ============================================================ */
export interface ShiftableStop { id: string; start: string; end: string; title: string; tag?: Stop['tag']; departure?: Stop['departure'] }
export interface ShiftResult<S> {
  stops: S[];
  /** Stops whose times changed. */
  moved: S[];
  /** A moved stop now ends after a fixed one (a departure or a "Be on time" stop) starts. */
  clashes: { stop: S; fixed: S }[];
  /** Moved stops that would now run past midnight (kept at 23:59). */
  overflow: S[];
}

/** Fixed stops (departures, "Be on time") keep their time when the day shifts. */
export const isFixed = (s: ShiftableStop): boolean => !!s.departure || s.tag === 'deadline';

/**
 * Pushes the stops still ahead (from `nowMin`, minutes since midnight) back by `delta` minutes.
 * A stop in progress just runs longer; fixed stops stay put. Returns new stop objects.
 */
export function shiftRemaining<S extends ShiftableStop>(stops: S[], nowMin: number, delta: number): ShiftResult<S> {
  const moved: S[] = [], overflow: S[] = [], clashes: { stop: S; fixed: S }[] = [];
  const clamp = (m: number) => Math.min(23 * 60 + 59, m);
  const out = stops.map((s) => {
    const start = toMin(s.start), end = toMin(s.end);
    if (end <= nowMin || isFixed(s) || !delta) return s;
    const next = { ...s };
    if (start < nowMin) next.end = fromMin(clamp(end + delta)); // happening now: it just runs longer
    else { next.start = fromMin(clamp(start + delta)); next.end = fromMin(clamp(end + delta)); }
    if (end + delta > 23 * 60 + 59) overflow.push(next);
    moved.push(next);
    return next;
  });
  for (const m of moved) {
    const orig = stops.find((s) => s.id === m.id) as S;
    for (const f of stops) {
      if (!isFixed(f) || toMin(f.start) < toMin(orig.start)) continue;
      if (toMin(m.end) > toMin(f.start)) { clashes.push({ stop: m, fixed: f }); break; }
    }
  }
  return { stops: [...out].sort((a, b) => a.start.localeCompare(b.start)), moved, clashes, overflow };
}

/* ============================================================
   The day's plan as a WhatsApp message
   ============================================================ */
export const mapsLink = (p: { lat: number; lng: number }): string => `https://maps.google.com/?q=${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

const bookingLine = (b: Booking | undefined): string => {
  if (!b) return '';
  const bits = [b.pnr ? `PNR ${b.pnr}` : '', b.ref ? `Ref ${b.ref}` : '', b.phone ? `📞 ${b.phone}` : ''].filter(Boolean);
  return bits.length ? `   🎫 ${bits.join(' · ')}` : '';
};

/** WhatsApp formatting: *bold*, _italic_. Times are local to the trip. */
export function dayMessage(trip: Pick<Trip, 'title'>, day: Day, n: number, weather?: DayWeather | null): string {
  const lines = [`*${trip.title}*`, `*Day ${n} · ${shortDate(day.date)}*${day.title ? ` — ${day.title}` : ''}`];
  if (weather) lines.push(`${weather.icon} ${weather.label} · ${weather.max}° / ${weather.min}°${weather.rain != null ? ` · 💧 ${weather.rain}%` : ''}`);
  lines.push('');
  for (const s of day.stops) {
    const star = s.tag === 'must' || s.tag === 'key' ? ' ⭐' : '';
    lines.push(`🕒 *${fmtHHMM(s.start)}* ${s.title}${star}`);
    lines.push(`   📍 ${s.place.name} ${mapsLink(s.place)}`);
    const b = bookingLine(s.booking);
    if (b) lines.push(b);
  }
  const notes = day.notes.filter((x) => x.text.trim());
  if (notes.length) {
    lines.push('');
    for (const x of notes) lines.push(`_${x.title}:_ ${x.text}`);
  }
  lines.push('', '— shared from GoWander');
  return lines.join('\n');
}

/* ============================================================
   Smart packing list
   ============================================================ */
export interface PackingSuggestion { text: string; why: string }

const has = (stops: Stop[], re: RegExp, kinds?: StopKind[]) =>
  stops.some((s) => (!kinds || kinds.includes(s.kind)) && re.test(`${s.title} ${s.note || ''} ${s.place.name}`));

/**
 * Things to pack, worked out from the trip: its places, stop types, departures, length and the
 * forecast. Leaves out what's already on the list.
 */
export function packingFor(trip: Trip, weather: Map<string, DayWeather>, existing: string[] = [], unit: 'C' | 'F' = 'C'): PackingSuggestion[] {
  const stops = trip.days.flatMap((d) => d.stops);
  const out: PackingSuggestion[] = [];
  const add = (why: string, ...items: string[]) => { for (const text of items) out.push({ text, why }); };
  const nights = Math.max(0, trip.days.length - 1);
  const wx = [...weather.values()];
  const F = unit === 'F';

  add('Every trip', 'Phone charger', 'ID card');
  if (stops.some((s) => s.departure) || has(stops, /\b(train|flight|airport|station|railway|bus)\b/i)) add('Trains, flights or buses', 'Tickets (printed or on phone)', 'Neck pillow');
  if (has(stops, /\b(beach|beaches|coast|shore|seaside|pool|swim)\b/i, ['stop', 'meal'])) add('Beach stops', 'Sunscreen', 'Sunglasses', 'Swimwear', 'Beach towel');
  if (has(stops, /\b(fort|trek|trekking|hike|hiking|hill|peak|point|viewpoint|falls|waterfall|caves?|summit)\b/i, ['stop'])) add('Forts, treks and viewpoints', 'Comfortable walking shoes', 'Water bottle');
  if (has(stops, /\b(temple|church|basilica|cathedral|mosque|masjid|gurudwara|shrine|monastery|dargah)\b/i, ['stop'])) add('Places of worship', 'Scarf or stole to cover shoulders');
  if (has(stops, /\b(market|bazaar|flea|shopping)\b/i, ['stop'])) add('Markets', 'Cash in small notes', 'Foldable tote bag');
  if (wx.some((w) => (w.rain ?? 0) >= 50 || /rain|shower|drizzle|storm/i.test(w.label))) add('Rain in the forecast', 'Umbrella', 'Light rain jacket');
  if (wx.some((w) => w.max >= (F ? 91 : 33))) add('Hot days ahead', 'Cap or hat', 'ORS / electrolytes');
  if (wx.some((w) => w.min <= (F ? 50 : 10))) add('Cool nights', 'Warm jacket');
  if (wx.some((w) => w.min <= (F ? 37 : 3) || /snow/i.test(w.label))) add('Freezing temperatures', 'Thermals', 'Gloves', 'Woollen cap');
  if (trip.days.some((d) => d.stops.length && toMin(d.stops[d.stops.length - 1]?.end || '00:00') - toMin(d.stops[0]?.start || '00:00') >= 11 * 60)) add('Long days out', 'Power bank');
  if (nights > 0) add(`${nights} night${nights === 1 ? '' : 's'} away`, 'Toiletries', `Clothes for ${trip.days.length} days`, 'Medicines');

  // Drop what's already on the list (loosely: "Charger" covers "Phone charger").
  const have = existing.map((x) => x.toLowerCase());
  const covered = (t: string) => {
    const key = t.toLowerCase().replace(/\(.*?\)/g, '').split(/\s+or\s+|\s*\/\s*/)[0]?.trim() || '';
    const last = key.split(' ').pop() || key;
    return have.some((h) => h.includes(key) || key.includes(h) || (last.length > 3 && h.includes(last)));
  };
  const seen = new Set<string>();
  return out.filter((x) => !covered(x.text) && !seen.has(x.text) && seen.add(x.text));
}

/* ============================================================
   Adding a stop (from an idea or a poll)
   ============================================================ */
export interface NewStop { title: string; start: string; end: string; kind: StopKind; place: Place; note?: string }

/** A copy of the trip with the stop added to the day on `date`, in time order. */
export function withStop(trip: Trip, date: string, s: NewStop): Trip {
  const t = structuredClone(trip);
  const day = t.days.find((d) => d.date === date);
  if (!day) throw new Error('That day is no longer in the trip.');
  const stop: Stop = { id: newStopId(), start: s.start, end: s.end < s.start ? s.start : s.end, kind: s.kind, title: s.title, place: s.place };
  if (s.note) stop.note = s.note;
  day.stops.push(stop);
  day.stops.sort((a, b) => a.start.localeCompare(b.start));
  return t;
}

/** A free slot for a new stop on a day: after the last stop, an hour long. */
export function nextSlot(day: Pick<Day, 'stops'> | undefined): { start: string; end: string } {
  const last = day?.stops[day.stops.length - 1];
  const start = last ? Math.min(toMin(last.end), 22 * 60) : 10 * 60;
  return { start: fromMin(start), end: fromMin(Math.min(start + 60, 23 * 60 + 59)) };
}

/* ============================================================
   Starting a new trip from an old one or a template
   ============================================================ */
const dayNum = (date: string) => Math.round(Date.parse(`${date}T12:00:00Z`) / 86400000);

/** The same trip, moved so its first day is `firstDate` (gaps between days are kept). */
export function shiftDates<T extends { days: { date: string }[] }>(trip: T, firstDate: string): T {
  const t = structuredClone(trip);
  const base = t.days[0]?.date;
  if (!base) return t;
  const delta = dayNum(firstDate) - dayNum(base);
  for (const d of t.days) d.date = addDays(d.date, delta);
  return t;
}

/**
 * "Plan it again with the favourites": a new trip from this one, leaving out the stops the group
 * gave a thumbs-down to on balance, and keeping their notes on the stops they rated. New ids for
 * everything, so it's a separate trip.
 */
export function planAgain(trip: Trip, reviews: Review[], firstDate: string): { draft: DraftTrip; dropped: string[] } {
  const net = new Map<string, number>();
  for (const r of reviews) net.set(r.stopId, (net.get(r.stopId) || 0) + r.vote);
  const dropped: string[] = [];
  const t = shiftDates(trip, firstDate);
  const draft: DraftTrip = {
    id: 'new', title: `${trip.title} (again)`.slice(0, 120), subtitle: trip.subtitle, timezone: trip.timezone,
    days: t.days.map((d) => ({
      date: d.date, title: d.title, notes: d.notes.map((n) => ({ ...n })),
      stops: d.stops.filter((s) => {
        if ((net.get(s.id) || 0) < 0) { dropped.push(s.title); return false; }
        return true;
      }).map((s) => {
        const said = reviews.filter((r) => r.stopId === s.id && r.note).map((r) => `${r.vote === 1 ? '👍' : '👎'} ${r.note}`);
        const note = [s.note, ...said].filter(Boolean).join(' · ').slice(0, 300);
        const copy: DraftStop = { ...structuredClone(s), id: newStopId() };
        if (note) copy.note = note;
        return copy;
      }),
    })),
  };
  return { draft, dropped };
}

/* ============================================================
   Recap
   ============================================================ */
export interface Recap {
  days: number;
  stops: number;
  places: number;
  /** Stops ticked off. */
  done: number;
  /** Metres, by road where known, else as the crow flies between consecutive places. */
  distance: number;
  busiest: { n: number; date: string; stops: number } | null;
}

export function recapOf(trip: Trip, doneIds: Set<string>, roadMetres: Map<string, number> = new Map()): Recap {
  let distance = 0;
  const placeKeys = new Set<string>();
  let busiest: Recap['busiest'] = null;
  trip.days.forEach((d, i) => {
    if (!busiest || d.stops.length > busiest.stops) busiest = { n: i + 1, date: d.date, stops: d.stops.length };
    d.stops.forEach((s, j) => {
      placeKeys.add(`${s.place.lat.toFixed(3)},${s.place.lng.toFixed(3)}`);
      const prev = d.stops[j - 1];
      if (!prev || distM(prev.place, s.place) < 50) return;
      distance += roadMetres.get(s.id) ?? distM(prev.place, s.place);
    });
  });
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  return { days: trip.days.length, stops, places: placeKeys.size, done: [...doneIds].filter((id) => trip.days.some((d) => d.stops.some((s) => s.id === id))).length, distance, busiest };
}
export const fmtKm = (m: number): string => (m < 1000 ? fmtDist(m) : `${Math.round(m / 1000).toLocaleString()} km`);
