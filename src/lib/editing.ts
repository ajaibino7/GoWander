// Trip editing rules, kept separate from the editor screen so they can be tested on their own:
// reordering and moving stops, past-date rules, validation, and reading coordinates from links.
import type { DraftDay, DraftStop, DraftTrip, LatLng } from './types';
import { addDays, fromMin, makeClock, toMin, DEFAULT_TZ } from './util';
import { newStopId } from './store';

export const blankStop = (start = '09:00'): DraftStop => ({
  id: newStopId(), start, end: fromMin(toMin(start) + 60), kind: 'stop', title: '', note: '', place: null,
});

const hhmm = (s: string | undefined) => /^\d\d:\d\d$/.test(s || '');

/**
 * Swaps stops k and k+1 (in place). Stops are kept in time order, so the one moving up takes the
 * earlier slot: each keeps its duration and the gap between them, and the pair ends when it did before.
 */
export function swapStops(stops: DraftStop[], k: number): void {
  const a = stops[k], b = stops[k + 1];
  if (!a || !b) return;
  if (hhmm(a.start) && hhmm(a.end) && hhmm(b.start) && hhmm(b.end)) {
    const dur = (s: DraftStop) => Math.max(0, toMin(s.end) - toMin(s.start));
    const start = toMin(a.start);
    const gap = Math.max(0, toMin(b.start) - toMin(a.end));
    const da = dur(a), db = dur(b);
    b.start = fromMin(start);
    b.end = fromMin(start + db);
    a.start = fromMin(start + db + gap);
    a.end = fromMin(start + db + gap + da);
  }
  stops[k] = b;
  stops[k + 1] = a;
}

/**
 * Moves stop j of day i to day k (in place). It keeps its times and slots in among that day's
 * stops by start time. Returns its new position.
 */
export function moveStopToDay(days: DraftDay[], i: number, j: number, k: number): number {
  const from = days[i], to = days[k];
  if (!from || !to) return -1;
  const [stop] = from.stops.splice(j, 1);
  if (!stop) return -1;
  let at = to.stops.findIndex((s) => (s.start || '') > (stop.start || ''));
  if (at < 0) at = to.stops.length;
  to.stops.splice(at, 0, stop);
  return at;
}

/* ---------- dates ---------- */
/** "Today" in the trip's timezone. */
export const tzToday = (tz: string | undefined): string => makeClock(tz || DEFAULT_TZ).dateKey(new Date());

/**
 * Trip days can't be set in the past. Dates the trip already had stay allowed, so a trip in
 * progress or a finished one can still be edited and saved.
 */
export function dateRules(savedDates: Iterable<string>, tz: string | undefined) {
  const saved = new Set([...savedDates].filter(Boolean));
  return {
    pastNotAllowed: (date: string) => !!date && date < tzToday(tz) && !saved.has(date),
    /** The earliest date the picker offers for a day currently set to `date`. */
    minDate: (date: string) => (date && date < tzToday(tz) && saved.has(date) ? date : tzToday(tz)),
  };
}

/** The date for a new day: the day after the last one — or today, if that would be in the past. */
export function nextDayDate(days: DraftDay[], tz: string | undefined): string {
  const last = days[days.length - 1];
  const next = last?.date ? addDays(last.date, 1) : tzToday(tz);
  return next < tzToday(tz) ? tzToday(tz) : next;
}

/* ---------- validation ---------- */
export interface Validation {
  errors: string[];
  /** "day.stop" indexes of stops with a problem (highlighted in red). */
  badStops: Set<string>;
}

export function validateDraft(draft: DraftTrip, pastNotAllowed: (date: string) => boolean): Validation {
  const errors: string[] = [];
  const badStops = new Set<string>();
  if (!draft.title.trim()) errors.push('Give the trip a name.');
  if (!draft.days.length) errors.push('Add at least one day.');
  const seen = new Set<string>();
  draft.days.forEach((d, i) => {
    if (!d.date) errors.push(`Day ${i + 1}: choose a date.`);
    else if (pastNotAllowed(d.date)) errors.push(`Day ${i + 1}: ${d.date} has already passed. Pick today or a later date.`);
    else if (seen.has(d.date)) errors.push(`Day ${i + 1}: ${d.date} is used by another day.`);
    seen.add(d.date);
    d.stops.forEach((s, j) => {
      const where = `Day ${i + 1}, stop ${j + 1}`;
      const bad = (msg: string) => { errors.push(`${where}: ${msg}`); badStops.add(`${i}.${j}`); };
      if (!s.title.trim()) bad('add a title.');
      if (!s.start || !s.end) bad('set start and end times.');
      else if (s.end < s.start) bad('ends before it starts (stops can\'t run past midnight — split it across two days).');
      if (!s.place) bad('set a location.');
    });
    d.notes.forEach((n, k) => { if (!n.text.trim()) errors.push(`Day ${i + 1}, note ${k + 1}: write something or remove it.`); });
  });
  return { errors, badStops };
}

/** Before saving: stops in time order within each day, days in date order. */
export function sortDraft(draft: DraftTrip): void {
  for (const d of draft.days) d.stops.sort((a, b) => a.start.localeCompare(b.start));
  draft.days.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- locations ---------- */
// Pulls coordinates out of a Google/Apple/OSM maps URL or a plain "lat, lng".
export function parseCoords(s: string): LatLng | null {
  const pats = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, // Google place pin
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, // Google viewport
    /[?&](?:q|ll|query|destination|daddr|center)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/, // openstreetmap.org
    /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    }
  }
  return null;
}

/* ---------- cover image ---------- */
const COVER_MAX = 500 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const isCoverUrl = (u: unknown): u is string => typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(u);

const readDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Images up to 500 KB are used as they are. Bigger ones (e.g. phone photos) are resized and
// re-compressed as JPEG until they fit, so nobody has to shrink them by hand.
export async function prepareCover(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WebP).');
  if (COVER_TYPES.includes(file.type) && file.size <= COVER_MAX) return readDataUrl(file);
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image couldn\'t be opened. Try a JPG or PNG.'); }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('That image couldn\'t be opened. Try a JPG or PNG.');
  for (const width of [1920, 1600, 1280, 1024, 800]) {
    const scale = Math.min(1, width / bmp.width);
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    ctx.fillStyle = '#fff'; // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.75, 0.65]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= COVER_MAX) return readDataUrl(blob);
    }
  }
  throw new Error('That image is too detailed to fit in 500 KB. Try a smaller one.');
}

/**
 * A photo for a bill or a journal entry: always resized and re-compressed as JPEG to fit in
 * `max` bytes (default 280 KB, which stays under the 420,000-character limit in the rules once
 * written as a data URL).
 */
export async function compressPhoto(file: File, max = 280 * 1024): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo (JPG, PNG or WebP).');
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That photo couldn\'t be opened. Try a JPG or PNG.'); }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('That photo couldn\'t be opened. Try a JPG or PNG.');
  for (const width of [1600, 1280, 1024, 800, 640]) {
    const scale = Math.min(1, width / Math.max(bmp.width, bmp.height));
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.7, 0.6, 0.5]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= max) return readDataUrl(blob);
    }
  }
  throw new Error('That photo is too detailed to store. Try another one.');
}
