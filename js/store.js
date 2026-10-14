// Trip data helpers: validation, the bundled sample trips, share links and backup files.
// Signed-in trips live in Firestore (see cloud.js).
import { DEFAULT_TZ, validTz, newId } from './util.js';

const SAMPLES_URL = 'data/trips.json';

/* ============================================================
   Validation — every trip from a file, link or the repo passes through here
   ============================================================ */
const KINDS = ['stop', 'meal', 'travel', 'stay'];
const TAGS = ['must', 'key', 'optional', 'closing', 'deadline'];
const NOTE_TYPES = ['star', 'tip', 'warn'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : dflt);

export function normalizeTrip(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.days)) throw new Error('That doesn\'t look like a trip.');
  const trip = {
    id: str(raw.id, 80).replace(/[^\w-]/g, '') || newId(raw.title),
    title: str(raw.title, 120) || 'Untitled trip',
    subtitle: str(raw.subtitle, 300),
    timezone: validTz(raw.timezone || DEFAULT_TZ),
    updatedAt: str(raw.updatedAt, 40) || new Date().toISOString(),
    days: [],
  };
  for (const d of raw.days.slice(0, 60)) {
    if (!d || !DATE.test(d.date)) continue;
    const day = { date: d.date, title: str(d.title, 160), stops: [], notes: [] };
    for (const s of Array.isArray(d.stops) ? d.stops.slice(0, 80) : []) {
      if (!s || !HHMM.test(s.start) || !HHMM.test(s.end)) continue;
      const p = s.place || {};
      const lat = Number(p.lat), lng = Number(p.lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) continue;
      const stop = {
        start: s.start,
        end: s.end < s.start ? s.start : s.end,
        kind: KINDS.includes(s.kind) ? s.kind : 'stop',
        title: str(s.title, 160) || 'Stop',
        place: { name: str(p.name, 160) || 'Pinned place', lat, lng, radius: clamp(p.radius, 50, 5000, 400) },
      };
      if (p.approx) stop.place.approx = true;
      const note = str(s.note, 300);
      if (note) stop.note = note;
      if (TAGS.includes(s.tag)) stop.tag = s.tag;
      if (s.departure) stop.departure = { buffer: clamp(s.departure.buffer, 0, 360, 60) };
      day.stops.push(stop);
    }
    for (const n of Array.isArray(d.notes) ? d.notes.slice(0, 10) : []) {
      const text = str(n?.text, 600);
      if (text) day.notes.push({ type: NOTE_TYPES.includes(n.type) ? n.type : 'tip', title: str(n.title, 60) || 'Note', text });
    }
    day.stops.sort((a, b) => a.start.localeCompare(b.start));
    trip.days.push(day);
  }
  trip.days.sort((a, b) => a.date.localeCompare(b.date));
  return trip;
}

function normalizeDoc(raw) {
  const trips = [];
  for (const t of Array.isArray(raw?.trips) ? raw.trips : []) {
    try { trips.push(normalizeTrip(t)); } catch { /* skip broken entries */ }
  }
  return { version: 1, trips };
}

/* ============================================================
   Sample trips (read-only, bundled with the site)
   ============================================================ */
let samplesP = null;
export function loadSamples() {
  samplesP ??= fetch(SAMPLES_URL, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : { trips: [] }))
    .then((raw) => normalizeDoc(raw).trips)
    .catch(() => []);
  return samplesP;
}

/* ============================================================
   Share links & backup files
   ============================================================ */
const toB64url = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function encodeShare(trip) {
  const json = JSON.stringify(trip);
  if (!('CompressionStream' in window)) return `u${toB64url(new TextEncoder().encode(json))}`;
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `z${toB64url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
}
export async function decodeShare(payload) {
  const kind = payload[0], bytes = fromB64url(payload.slice(1));
  let json;
  if (kind === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    json = await new Response(stream).text();
  } else if (kind === 'u') {
    json = new TextDecoder().decode(bytes);
  } else throw new Error('Unrecognised share link.');
  return normalizeTrip(JSON.parse(json));
}
export async function shareUrl(trip) {
  return `${location.origin}${location.pathname}#/import/${await encodeShare(trip)}`;
}

export function downloadJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Accepts a whole trips.json ({ trips: [...] }) or a single trip.
export async function readTripsFile(file) {
  const raw = JSON.parse(await file.text());
  const list = Array.isArray(raw?.trips) ? raw.trips : [raw];
  const trips = [];
  for (const t of list) { try { trips.push(normalizeTrip(t)); } catch { /* skip */ } }
  if (!trips.length) throw new Error('No trips found in that file.');
  return trips;
}
