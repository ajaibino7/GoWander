// "Add to calendar": the itinerary as an .ics file (works with Google, Apple and Outlook
// calendars). Every stop becomes an event at its real time — times are converted from the
// trip's timezone to UTC, so the calendar shows them correctly wherever the phone is.
import type { ChecklistItem, Trip } from './types';
import { makeClock, directionsUrl, downloadFile, type Clock } from './util';

const utc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Text values escape \ ; , and newlines (RFC 5545).
const text = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 bytes are folded onto continuation lines that start with a space (RFC 5545).
// Counted in UTF-8 bytes and split between whole characters, so emoji and accented letters
// never get cut in half — Apple Calendar is strict about this.
const enc = new TextEncoder();
export const fold = (line: string): string => {
  const out: string[] = [];
  let cur = '', bytes = 0;
  for (const ch of line) { // iterates whole characters, not UTF-16 halves
    const n = enc.encode(ch).length;
    const max = out.length ? 74 : 75; // continuation lines lose a byte to the leading space
    if (bytes + n > max) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l)).join('\r\n');
};

// The trip's first moment: the earliest stop on the earliest day.
function tripStart(trip: Trip, clock: Clock): Date | null {
  const starts = trip.days.flatMap((d) => (d.stops || []).filter((s) => s.start).map((s) => clock.at(d.date, s.start).getTime()));
  return starts.length ? new Date(Math.min(...starts)) : null;
}

export interface IcsOptions {
  /** The shared checklist, for the "Pack & prepare" event. */
  checklist?: ChecklistItem[] | null;
  /** Link back to the checklist page. */
  checklistUrl?: string;
}

/**
 * "🎒 Pack & prepare" — an hour-long event ending when the trip starts, listing what's still
 * unpacked and the open to-dos, with reminders 8 h, 4 h and 1 h before the trip. Triggers count
 * from the event's start (an hour before the trip), the form Apple Calendar and Outlook support best.
 */
function prepEvent(trip: Trip, clock: Clock, now: string, { checklist = null, checklistUrl = '' }: IcsOptions = {}): string[] {
  const start = tripStart(trip, clock);
  if (!start) return [];
  const open = (list: string) => (checklist || []).filter((x) => x.list === list && !x.done).map((x) => `• ${x.text}`);
  const packing = open('packing'), todo = open('todo');
  const parts: string[] = [];
  if (packing.length) parts.push(`Still to pack (${packing.length}):\n${packing.join('\n')}`);
  if (todo.length) parts.push(`To-do (${todo.length}):\n${todo.join('\n')}`);
  if (!parts.length) parts.push(checklist?.length ? 'Everything on the checklist is done. Have a great trip!' : 'Pack, charge your phone and check your tickets.');
  if (checklistUrl) parts.push(`Shared checklist: ${checklistUrl}`);
  const left = packing.length + todo.length;
  const alarm = (trigger: string, when: string) => [
    'BEGIN:VALARM', 'ACTION:DISPLAY',
    `DESCRIPTION:${text(`${trip.title} starts in ${when}${left ? ` · ${left} item${left === 1 ? '' : 's'} left on the checklist` : ''}`)}`,
    `TRIGGER:${trigger}`, 'END:VALARM',
  ];
  return [
    'BEGIN:VEVENT',
    `UID:prep-${trip.id || 'trip'}@gowander`,
    `DTSTAMP:${now}`,
    `DTSTART:${utc(new Date(start.getTime() - 3600000))}`,
    `DTEND:${utc(start)}`,
    `SUMMARY:${text(`🎒 Pack & prepare for ${trip.title}`)}`,
    `DESCRIPTION:${text(parts.join('\n\n'))}`,
    ...alarm('-PT7H', '8 hours'),
    ...alarm('-PT3H', '4 hours'),
    ...alarm('PT0S', '1 hour'),
    'END:VEVENT',
  ];
}

export function tripToIcs(trip: Trip, opts: IcsOptions = {}): string {
  const clock = makeClock(trip.timezone);
  const now = utc(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GoWander//Trip planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${text(trip.title)}`];
  lines.push(...prepEvent(trip, clock, now, opts));
  trip.days.forEach((day, i) => {
    for (const s of day.stops || []) {
      if (!s.start || !s.end || !s.place) continue;
      const start = clock.at(day.date, s.start);
      let end = clock.at(day.date, s.end);
      if (end <= start) end = new Date(start.getTime() + 15 * 60000);
      const desc = [s.note, `Day ${i + 1}${day.title ? ` · ${day.title}` : ''}`, `Directions: ${directionsUrl(s.place)}`].filter(Boolean).join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${s.id || `${day.date}-${s.start}`}-${trip.id || 'trip'}@gowander`,
        `DTSTAMP:${now}`,
        `DTSTART:${utc(start)}`,
        `DTEND:${utc(end)}`,
        `SUMMARY:${text(s.title)}`,
        `LOCATION:${text(s.place.name)}`,
        `GEO:${s.place.lat.toFixed(6)};${s.place.lng.toFixed(6)}`,
        `DESCRIPTION:${text(desc)}`,
      );
      // Fixed departures (trains, flights) get a reminder when it's time to be there.
      if (s.departure) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(`Be at ${s.place.name} for ${s.title}`)}`, `TRIGGER:-PT${Math.max(0, Number(s.departure.buffer) || 0)}M`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
  });
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// iPhone / iPad (iPadOS reports itself as a Mac, but has a touch screen).
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Chrome, Firefox, Edge and in-app browsers (Google, Instagram, Facebook, Gmail…) on iOS can't
// hand a calendar to Apple Calendar; only Safari (and home-screen web apps, which are Safari) can.
const isIOSSafari = () => isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|Instagram|FBAN|FBAV|Line\/|GoogleApp/i.test(navigator.userAgent);

const CAL_CACHE = 'gw-calendar';
const slugOf = (trip: Trip) => (trip.title || 'trip').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'trip';

// Waits briefly for the service worker to take control (it claims the page right after installing).
async function swController(ms = 2500): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator) || !('caches' in window)) return null;
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  await Promise.race([
    new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
    new Promise((r) => setTimeout(r, ms)),
  ]);
  return navigator.serviceWorker.controller;
}

/**
 * Adds the trip to the phone's calendar. Resolves with how:
 *   'opened'      — iPhone/iPad Safari: the service worker serves the .ics at a real address
 *                   (…/calendar/<trip>.ics) and Safari opens Apple Calendar's "Add All" sheet.
 *                   iOS won't open calendars from downloads, data: or blob: links.
 *   'reload'      — iPhone, but the offline helper isn't running yet (first visit): reload once.
 *   'safari-only' — another browser on iPhone: only Safari can add to Apple Calendar.
 *   'downloaded'  — Android and computers: a .ics file the calendar app opens.
 */
export type IcsResult = 'opened' | 'reload' | 'safari-only' | 'downloaded';
export async function downloadIcs(trip: Trip, opts: IcsOptions = {}): Promise<IcsResult> {
  const ics = tripToIcs(trip, opts);
  if (isIOS()) {
    if (!isIOSSafari()) return 'safari-only';
    if (!(await swController())) return 'reload';
    const url = new URL(`calendar/${slugOf(trip)}.ics`, location.href).href;
    const cache = await caches.open(CAL_CACHE);
    for (const old of await cache.keys()) await cache.delete(old); // keep only the latest
    await cache.put(url, new Response(ics, {
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${slugOf(trip)}.ics"` },
    }));
    window.location.href = url;
    return 'opened';
  }
  downloadFile(`${slugOf(trip)}.ics`, ics, 'text/calendar;charset=utf-8');
  return 'downloaded';
}
