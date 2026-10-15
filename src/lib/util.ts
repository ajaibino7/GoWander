// Shared helpers: escaping, geo maths, durations, and timezone-aware trip clocks.
import type { LatLng, NoteType, Place, StopKind, StopTag } from './types';

/** Escapes text for HTML strings (used for map popups, which Leaflet takes as HTML). */
export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const DEFAULT_TZ = 'Asia/Kolkata';
export const THEMES = ['navy', 'green', 'coral', 'gold'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COLORS: Record<Theme, string> = { navy: '#1f4e79', green: '#2f7a59', coral: '#c4553b', gold: '#b8801c' };
export const KIND_LABELS: Record<StopKind, string> = { stop: 'Sightseeing', meal: 'Food', travel: 'Travel', stay: 'Stay / rest' };
export const TAG_LABELS: Record<StopTag, string> = { must: 'Must see', key: 'Main attraction', optional: 'Optional', closing: 'Before closing', deadline: 'Be on time' };
export const NOTE_LABELS: Record<NoteType, string> = { star: 'Highlight', tip: 'Tip', warn: 'Warning' };

/* ---------- geo ---------- */
export function distM(a: LatLng, b: LatLng): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export const fmtDist = (m: number): string => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

// Rough travel-time estimate from straight-line distance. Deliberately pessimistic for city traffic.
export function estimateTravel(m: number): { ms: number; mode: 'walk' | 'drive' } {
  const road = m * 1.35;
  if (road < 1500) return { ms: (road / 4500) * 3600000, mode: 'walk' };
  const kmh = road > 30000 ? 45 : 18;
  return { ms: (road / 1000 / kmh) * 3600000 + 5 * 60000, mode: 'drive' };
}
export const directionsUrl = (p: LatLng): string => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

/** A GPS fix: position plus accuracy in metres. */
export interface Position extends LatLng { accuracy?: number; ts?: number }
export const isHere = (pos: Position | null | undefined, place: Place): boolean =>
  !!pos && distM(pos, place) <= place.radius + Math.min(pos.accuracy || 0, 150);

/* ---------- durations & plain times ---------- */
export function fmtDur(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}
export function fmtHHMM(hhmm: string): string {
  const [hRaw = 0, m = 0] = hhmm.split(':').map(Number);
  const ap = hRaw >= 12 ? 'PM' : 'AM';
  const h = hRaw % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
export const toMin = (hhmm: string): number => { const [h = 0, m = 0] = hhmm.split(':').map(Number); return h * 60 + m; };
export function fromMin(m: number): string {
  const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(m)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/* ---------- plain calendar dates (YYYY-MM-DD, no timezone) ---------- */
const noonUTC = (date: string) => new Date(`${date}T12:00:00Z`);
const fmtUTC = (date: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(noonUTC(date));
export const weekdayOf = (date: string): string => fmtUTC(date, { weekday: 'long' });
export const shortDate = (date: string): string => fmtUTC(date, { weekday: 'short', day: 'numeric', month: 'short' }); // "Sat 17 Oct"
export const dayMonth = (date: string): string => fmtUTC(date, { day: 'numeric', month: 'short' }); // "17 Oct"
export function addDays(date: string, n: number): string {
  const d = noonUTC(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function fmtRange(first: string | undefined, last: string | undefined): string {
  if (!first) return 'No dates yet';
  const end = last || first;
  const y = (d: string) => d.slice(0, 4);
  if (first === end) return `${fmtUTC(first, { day: 'numeric', month: 'short' })} ${y(first)}`;
  if (first.slice(0, 7) === end.slice(0, 7)) return `${Number(first.slice(8))}–${fmtUTC(end, { day: 'numeric', month: 'short' })} ${y(end)}`;
  if (y(first) === y(end)) return `${dayMonth(first)} – ${dayMonth(end)} ${y(end)}`;
  return `${dayMonth(first)} ${y(first)} – ${dayMonth(end)} ${y(end)}`;
}

/* ---------- timezone-aware clock for a trip ---------- */
export function validTz(tz: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}
export const deviceTz = (): string => validTz(Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ);

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
function partsIn(tz: string, d: Date): Parts {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) p[x.type] = x.value;
  p.hour = String(Number(p.hour) % 24).padStart(2, '0');
  return p as Parts;
}
function tzOffsetMs(tz: string, d: Date): number {
  const p = partsIn(tz, d);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - (d.getTime() - d.getMilliseconds());
}
export function tzLabel(tz: string): string {
  if (tz === 'Asia/Kolkata') return 'IST';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || tz;
  } catch { return tz; }
}

export interface Clock {
  tz: string;
  label: string;
  /** The moment a local date + "HH:MM" happens in the trip's timezone. */
  at: (date: string, hhmm: string) => Date;
  dateKey: (d: Date) => string;
  inputValue: (d: Date) => string;
  parseInput: (s: string) => Date;
  fmtClock: (d: Date) => string;
  fmtDay: (d: Date) => string;
}

// All trip times are wall-clock times in the trip's timezone, whatever the phone is set to.
export function makeClock(tzIn: string = DEFAULT_TZ): Clock {
  const tz = validTz(tzIn);
  const at = (date: string, hhmm: string): Date => {
    const [y = 1970, mo = 1, da = 1] = date.split('-').map(Number);
    const [h = 0, mi = 0] = hhmm.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, da, h, mi);
    let t = guess - tzOffsetMs(tz, new Date(guess));
    t = guess - tzOffsetMs(tz, new Date(t)); // second pass settles DST edges
    return new Date(t);
  };
  return {
    tz,
    label: tzLabel(tz),
    at,
    dateKey: (d) => { const p = partsIn(tz, d); return `${p.year}-${p.month}-${p.day}`; },
    inputValue: (d) => { const p = partsIn(tz, d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; },
    parseInput: (s) => at(s.slice(0, 10), s.slice(11, 16)),
    fmtClock: (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d),
    fmtDay: (d) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d),
  };
}

/* ---------- misc ---------- */
export function newId(title = 'trip'): string {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'trip';
  return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Saves text as a file (backup downloads, calendar files on Android/desktop). */
export function downloadFile(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
