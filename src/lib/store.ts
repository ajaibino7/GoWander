// Trip data helpers: validation, the bundled sample trips, share links and backup files.
// Signed-in trips live in Firestore (see cloud.ts).
import type { Day, DayNote, NoteType, Stop, StopKind, StopTag, Trip } from './types';
import { DEFAULT_TZ, validTz, newId, downloadFile } from './util';

const SAMPLES_URL = 'data/trips.json';

/* ============================================================
   Validation — every trip from a file, link or the network passes through here
   ============================================================ */
const KINDS: StopKind[] = ['stop', 'meal', 'travel', 'stay'];
const TAGS: StopTag[] = ['must', 'key', 'optional', 'closing', 'deadline'];
const NOTE_TYPES: NoteType[] = ['star', 'tip', 'warn'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
  (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

// Every stop keeps a stable id so shared progress (done/skip) survives edits and reordering.
// Stops saved before ids existed get a deterministic one from their date, time and title.
const STOP_ID = /^[\w-]{1,40}$/;
function derivedStopId(date: string, start: string, title: unknown): string {
  let h = 2166136261;
  for (const ch of `${date}|${start}|${String(title ?? '')}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return `s${(h >>> 0).toString(36)}`;
}
export const newStopId = (): string => `s${Math.random().toString(36).slice(2, 10)}`;

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object';

export function normalizeTrip(raw: unknown): Trip {
  if (!isObj(raw) || !Array.isArray(raw.days)) throw new Error('That doesn\'t look like a trip.');
  const usedIds = new Set<string>();
  const trip: Trip = {
    id: str(raw.id, 80).replace(/[^\w-]/g, '') || newId(str(raw.title) || 'trip'),
    title: str(raw.title, 120) || 'Untitled trip',
    subtitle: str(raw.subtitle, 300),
    timezone: validTz(str(raw.timezone) || DEFAULT_TZ),
    updatedAt: str(raw.updatedAt, 40) || new Date().toISOString(),
    days: [],
  };
  for (const d of raw.days.slice(0, 60)) {
    if (!isObj(d) || typeof d.date !== 'string' || !DATE.test(d.date)) continue;
    const day: Day = { date: d.date, title: str(d.title, 160), stops: [], notes: [] };
    for (const s of Array.isArray(d.stops) ? d.stops.slice(0, 80) : []) {
      if (!isObj(s) || typeof s.start !== 'string' || typeof s.end !== 'string' || !HHMM.test(s.start) || !HHMM.test(s.end)) continue;
      const p = isObj(s.place) ? s.place : {};
      const lat = Number(p.lat), lng = Number(p.lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) continue;
      let id = typeof s.id === 'string' && STOP_ID.test(s.id) ? s.id : derivedStopId(d.date, s.start, s.title);
      for (let n = 2; usedIds.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
      usedIds.add(id);
      const stop: Stop = {
        id,
        start: s.start,
        end: s.end < s.start ? s.start : s.end,
        kind: KINDS.includes(s.kind as StopKind) ? (s.kind as StopKind) : 'stop',
        title: str(s.title, 160) || 'Stop',
        place: { name: str(p.name, 160) || 'Pinned place', lat, lng, radius: clamp(p.radius, 50, 5000, 400) },
      };
      if (p.approx) stop.place.approx = true;
      const note = str(s.note, 300);
      if (note) stop.note = note;
      if (TAGS.includes(s.tag as StopTag)) stop.tag = s.tag as StopTag;
      if (isObj(s.departure)) stop.departure = { buffer: clamp(s.departure.buffer, 0, 360, 60) };
      day.stops.push(stop);
    }
    for (const n of Array.isArray(d.notes) ? d.notes.slice(0, 10) : []) {
      const text = str(isObj(n) ? n.text : '', 600);
      if (!text || !isObj(n)) continue;
      const note: DayNote = { type: NOTE_TYPES.includes(n.type as NoteType) ? (n.type as NoteType) : 'tip', title: str(n.title, 60) || 'Note', text };
      day.notes.push(note);
    }
    day.stops.sort((a, b) => a.start.localeCompare(b.start));
    trip.days.push(day);
  }
  trip.days.sort((a, b) => a.date.localeCompare(b.date));
  return trip;
}

function normalizeDoc(raw: unknown): { version: 1; trips: Trip[] } {
  const trips: Trip[] = [];
  for (const t of isObj(raw) && Array.isArray(raw.trips) ? raw.trips : []) {
    try { trips.push(normalizeTrip(t)); } catch { /* skip broken entries */ }
  }
  return { version: 1, trips };
}

/* ============================================================
   Sample trips (read-only, bundled with the site)
   ============================================================ */
let samplesP: Promise<Trip[]> | null = null;
export function loadSamples(): Promise<Trip[]> {
  samplesP ??= fetch(SAMPLES_URL, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : { trips: [] }))
    .then((raw) => normalizeDoc(raw).trips)
    .catch(() => []);
  return samplesP;
}

/* ============================================================
   Share links & backup files
   ============================================================ */
const toB64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function encodeShare(trip: Trip): Promise<string> {
  const json = JSON.stringify(trip);
  if (!('CompressionStream' in globalThis)) return `u${toB64url(new TextEncoder().encode(json))}`;
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `z${toB64url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
}
export async function decodeShare(payload: string): Promise<Trip> {
  const kind = payload[0], bytes = fromB64url(payload.slice(1));
  let json: string;
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    json = await new Response(stream).text();
  } else if (kind === 'u') {
    json = new TextDecoder().decode(bytes);
  } else throw new Error('Unrecognised share link.');
  return normalizeTrip(JSON.parse(json));
}
export async function shareUrl(trip: Trip): Promise<string> {
  return `${location.origin}${location.pathname}#/import/${await encodeShare(trip)}`;
}

export function downloadJson(filename: string, data: unknown): void {
  downloadFile(filename, `${JSON.stringify(data, null, 2)}\n`, 'application/json');
}

// Accepts a whole trips.json ({ trips: [...] }) or a single trip.
export async function readTripsFile(file: File): Promise<Trip[]> {
  const raw: unknown = JSON.parse(await file.text());
  const list = isObj(raw) && Array.isArray(raw.trips) ? raw.trips : [raw];
  const trips: Trip[] = [];
  for (const t of list) { try { trips.push(normalizeTrip(t)); } catch { /* skip */ } }
  if (!trips.length) throw new Error('No trips found in that file.');
  return trips;
}
