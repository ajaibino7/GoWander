// The live trip engine: the trip's timeline in real moments, the status engine (on track,
// running behind, leave now…), location tracking, and a small shared store. The trip page and
// the test panel both read and change this state; React components subscribe with useLive().
import { useSyncExternalStore } from 'react';
import type { Day, Place, Stop, Trip } from './types';
import {
  esc, distM, fmtDist, estimateTravel, isHere, fmtDur, makeClock, THEMES, weekdayOf, shortDate,
  type Clock, type Position, type Theme,
} from './util';
import { tripWeather, type DayWeather } from './weather';
import { tripLegs, type StopLeg } from './routing';
import { nearbyPlaces, forStop, intentFor, GENERAL, type Intent, type NearbyItem, type Cat } from './nearby';

/* ============================================================
   Test mode (only active via URL; see README):
     ?test                    open the test panel
     ?now=2026-10-18T12:15    pretend it's this time in the trip's timezone
     ?speed=60                run the clock 60× faster
     ?lat=18.7075&lng=73.372  pretend you're at this location
     ?follow=1                move along the planned route automatically
   ============================================================ */
const params = new URLSearchParams(location.search);
export const sim = {
  enabled: ['test', 'now', 'lat', 'speed', 'follow'].some((k) => params.has(k)),
  nowStr: params.get('now'),
  base: null as Date | null, // null = real clock
  anchor: Date.now(),
  speed: Number(params.get('speed')) || 1,
  paused: false,
  loc: params.has('lat') && params.has('lng')
    ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')), accuracy: 25 } as Position
    : null,
  follow: params.get('follow') === '1',
};
const TICK_MS = sim.enabled ? 1000 : 20_000;

export function now(): Date {
  if (!sim.base) return new Date();
  if (sim.paused) return new Date(sim.base);
  return new Date(sim.base.getTime() + (Date.now() - sim.anchor) * sim.speed);
}
// Re-anchor the simulated clock so speed/pause changes don't make it jump.
export function setSimTime(d: Date | number): void { sim.base = new Date(d); sim.anchor = Date.now(); }

/* ============================================================
   The trip in real moments
   ============================================================ */
export interface LiveStop extends Stop {
  idx: number;
  /** Day number (1-based) this stop belongs to. */
  dayN: number;
  startAt: Date;
  endAt: Date;
}
export interface Deadline { label: string; place: Place; departsAt: Date; atAt: Date; plannedLeave: Date }
export interface LiveDay extends Omit<Day, 'stops'> {
  n: number;
  theme: Theme;
  weekday: string;
  label: string;
  stops: LiveStop[];
  startAt: Date;
  endAt: Date;
  deadline?: Deadline;
}

const samePlace = (a: Place, b: Place) => a.lat === b.lat && a.lng === b.lng;

export function prepare(trip: Trip): { clock: Clock; days: LiveDay[] } {
  const c = makeClock(trip.timezone);
  const days = trip.days.filter((d) => d.stops.length).map((d, i): LiveDay => {
    const n = i + 1;
    const stops = d.stops.map((s, j): LiveStop => ({ ...s, id: s.id || `d${n}-${j}`, idx: j, dayN: n, startAt: c.at(d.date, s.start), endAt: c.at(d.date, s.end) }));
    const first = stops[0] as LiveStop, last = stops[stops.length - 1] as LiveStop;
    const day: LiveDay = {
      ...d, n, theme: THEMES[i % THEMES.length] as Theme, weekday: weekdayOf(d.date), label: shortDate(d.date),
      stops, startAt: first.startAt, endAt: last.endAt,
    };
    // A stop marked as a fixed departure (train, flight, bus) drives the "leave by" countdown.
    const dep = stops.find((s) => s.departure);
    if (dep?.departure) {
      const atAt = new Date(dep.startAt.getTime() - dep.departure.buffer * 60000);
      // Without location: plan to leave when the schedule first heads there.
      const firstThere = stops.find((s) => samePlace(s.place, dep.place)) || dep;
      const fallback = atAt.getTime() - 30 * 60000;
      day.deadline = {
        label: `Be at ${dep.place.name}`, place: dep.place, departsAt: dep.startAt, atAt,
        plannedLeave: new Date(Math.min(firstThere.startAt.getTime(), fallback)),
      };
    }
    return day;
  });
  return { clock: c, days };
}

/* ============================================================
   Shared live state
   ============================================================ */
export type LocState = 'idle' | 'asking' | 'on' | 'denied' | 'unavailable' | 'error';
export interface NearbyState {
  stop: LiveStop;
  intent: Intent;
  status: 'loading' | 'ok' | 'error';
  items: NearbyItem[];
  filter: Cat | 'all';
  fellBack?: boolean;
  error?: string;
  /** Changes whenever the map should re-fit to the results. */
  fitKey: number;
}

export const live = {
  trip: null as Trip | null,
  clock: makeClock(),
  days: [] as LiveDay[],
  pos: sim.loc as Position | null,
  posSource: (sim.loc || sim.follow ? 'sim' : null) as 'sim' | 'gps' | null,
  loc: (sim.loc || sim.follow ? 'on' : 'idle') as LocState,
  watchId: null as number | null,
  selectedDay: null as number | null,
  selectedStop: null as string | null,
  done: new Set<string>(),
  doneBy: new Map<string, string>(), // stop id → email of the member who marked it (shared trips)
  weather: new Map<string, DayWeather>(), // date → forecast
  legs: new Map<string, StopLeg>(), // stop id → road travel time from the previous place
  nearby: null as NearbyState | null,
  /** Bumped when the map should fit the whole day again. */
  refit: 0,
  /** The Leaflet map, once built (the test panel's "click map to place me" uses it). */
  map: null as import('leaflet').Map | null,
};

let version = 0;
const listeners = new Set<() => void>();
/** Tells every subscribed component that the live state changed. */
export function emit(): void {
  version++;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
/** Re-renders the component whenever the live state changes; returns the change counter. */
export function useLive(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/* ============================================================
   Status engine
   ============================================================ */
export type Phase =
  | { phase: 'empty' } | { phase: 'before' } | { phase: 'after' }
  | { phase: 'between'; next: LiveDay | undefined }
  | { phase: 'morning'; day: LiveDay }
  | { phase: 'night'; day: LiveDay; next: LiveDay | undefined }
  | { phase: 'live'; day: LiveDay };

export function tripPhase(t: Date): Phase {
  const days = live.days;
  const first = days[0], last = days[days.length - 1];
  if (!first || !last) return { phase: 'empty' };
  if (t < first.startAt) return { phase: 'before' };
  if (t >= last.endAt) return { phase: 'after' };
  const today = days.find((d) => d.date === live.clock.dateKey(t));
  if (!today) return { phase: 'between', next: days.find((d) => d.startAt > t) };
  if (t < today.startAt) return { phase: 'morning', day: today };
  if (t >= today.endAt) return { phase: 'night', day: today, next: days.find((d) => d.startAt > t) };
  return { phase: 'live', day: today };
}

export type StopState = 'done' | 'past' | 'now' | 'upcoming';
export function stopState(s: LiveStop, t: Date): StopState {
  if (live.done.has(s.id)) return 'done';
  if (t >= s.endAt) return 'past';
  if (t >= s.startAt) return 'now';
  return 'upcoming';
}

// Where the plan says you'd be at time t — used by test mode's "follow the schedule".
// Inside a stop you're at its place; during travel or gaps you move in a straight line.
export function scheduledPosition(t: Date): Position | null {
  const flat = live.days.flatMap((d) => d.stops);
  const first = flat[0], lastStop = flat[flat.length - 1];
  if (!first || !lastStop) return null;
  const lerp = (a: Place, b: Place, f: number): Position => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, accuracy: 20 });
  if (t < first.startAt) return lerp(first.place, first.place, 0);
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i] as LiveStop, prev = flat[i - 1];
    if (t >= s.startAt && t < s.endAt) {
      if (s.kind === 'travel' && prev) return lerp(prev.place, s.place, (t.getTime() - s.startAt.getTime()) / (s.endAt.getTime() - s.startAt.getTime()));
      return lerp(s.place, s.place, 0);
    }
    const next = flat[i + 1];
    if (next && t >= s.endAt && t < next.startAt) {
      // Overnight gaps: stay put rather than drifting across the map.
      if (s.dayN !== next.dayN) return lerp(s.place, s.place, 0);
      return lerp(s.place, next.place, (t.getTime() - s.endAt.getTime()) / (next.startAt.getTime() - s.endAt.getTime()));
    }
  }
  return lerp(lastStop.place, lastStop.place, 0);
}

export interface Pill { cls?: 'info' | 'ok' | 'warn' | 'bad'; text: string }
export interface Stat { k: string; v: string; s?: string }
export interface LiveStatus {
  day: LiveDay;
  cur: LiveStop | null;
  next: LiveStop | null;
  target: LiveStop | null;
  pill: Pill;
  /** html is escaped text with <strong> highlights. */
  msg: { cls: 'info' | 'ok' | 'warn' | 'bad'; html: string } | null;
  stats: Stat[];
  progress: number;
}

// The headline pill for any time/position — shared by the UI and test mode's checks.
export function computeStatus(t: Date, pos: Position | null = live.pos): { phase: Phase['phase']; pill: Pill } & Partial<LiveStatus> {
  const ph = tripPhase(t);
  const fixed: Partial<Record<Phase['phase'], string>> = { empty: 'No stops', before: 'Countdown', after: 'Complete', morning: 'Good morning', between: 'Good morning', night: 'Rest up' };
  const text = fixed[ph.phase];
  if (text || ph.phase !== 'live') return { phase: ph.phase, pill: { text: text || '' } };
  return { phase: ph.phase, ...liveStatus(ph.day, t, pos) };
}

export function liveStatus(day: LiveDay, t: Date, pos: Position | null = live.pos): LiveStatus {
  const fmtClock = live.clock.fmtClock;
  const open = day.stops.filter((s) => !live.done.has(s.id));
  const cur = open.find((s) => s.startAt <= t && t < s.endAt) || null;
  const next = open.find((s) => s.startAt > t) || null;
  const target = cur || next;
  const out: LiveStatus = { day, cur, next, target, pill: { cls: 'info', text: 'On schedule' }, msg: null, stats: [], progress: 0 };
  const ms = (a: Date, b: Date) => a.getTime() - b.getTime();

  if (cur) {
    out.stats.push({ k: cur.kind === 'travel' ? 'Arrive by' : 'Ends in', v: cur.kind === 'travel' ? fmtClock(cur.endAt) : fmtDur(ms(cur.endAt, t)), s: cur.kind === 'travel' ? '' : `at ${fmtClock(cur.endAt)}` });
  }
  if (next) out.stats.push({ k: 'Next up', v: fmtDur(ms(next.startAt, t)), s: next.title });

  // ---- location-aware comparison ----
  if (pos && target) {
    const dTarget = distM(pos, target.place);
    const atTarget = isHere(pos, target.place);
    const hereStops = day.stops.filter((s) => isHere(pos, s.place));
    const travel = estimateTravel(dTarget);
    const dueAt = cur ? (cur.kind === 'travel' ? cur.endAt : cur.startAt) : target.startAt;

    if (!atTarget) {
      out.stats.push({ k: 'Distance', v: fmtDist(dTarget), s: `~${fmtDur(travel.ms)} ${travel.mode} (est.)` });
    }

    if (atTarget) {
      if (cur === target && cur.kind !== 'travel') {
        out.pill = { cls: 'ok', text: 'On track' };
        out.msg = { cls: 'ok', html: `You're at <strong>${esc(target.place.name)}</strong>. Enjoy — you have ${fmtDur(ms(cur.endAt, t))} here.` };
      } else if (cur === target) {
        out.pill = { cls: 'ok', text: 'Arrived' };
        out.msg = { cls: 'ok', html: `You've reached <strong>${esc(target.place.name)}</strong>${t < cur.endAt ? ` — ${fmtDur(ms(cur.endAt, t))} ahead of the planned arrival` : ''}.` };
      } else {
        out.pill = { cls: 'ok', text: 'Early' };
        out.msg = { cls: 'ok', html: `You're already at <strong>${esc(target.place.name)}</strong> — ${fmtDur(ms(target.startAt, t))} before it's scheduled.` };
      }
    } else {
      const ahead = hereStops.filter((s) => s.idx > target.idx);
      const behind = hereStops.filter((s) => s.idx < target.idx);
      const arriveAt = new Date(t.getTime() + travel.ms);
      const lateBy = ms(arriveAt, dueAt);
      const firstAhead = ahead[0];

      if (firstAhead && !behind.length) {
        out.pill = { cls: 'ok', text: 'Ahead' };
        out.msg = { cls: 'ok', html: `You're at <strong>${esc(firstAhead.title)}</strong> — ahead of schedule. Mark earlier stops done or skip them if you like.` };
      } else if (cur && cur.kind !== 'travel') {
        // Should be at the current stop but aren't.
        const into = ms(t, cur.startAt);
        const lastBehind = behind[behind.length - 1];
        const where = lastBehind ? `still near <strong>${esc(lastBehind.place.name)}</strong>` : `${fmtDist(dTarget)} away`;
        out.pill = into > 30 * 60000 ? { cls: 'bad', text: 'Running behind' } : { cls: 'warn', text: 'Running behind' };
        out.msg = { cls: into > 30 * 60000 ? 'bad' : 'warn', html: `<strong>${esc(cur.title)}</strong> started ${fmtDur(into)} ago and you're ${where}. ETA ~${fmtClock(arriveAt)}. If time is tight, skip it and mark it done.` };
      } else if (lateBy > 10 * 60000) {
        out.pill = { cls: lateBy > 30 * 60000 ? 'bad' : 'warn', text: `~${fmtDur(lateBy)} late` };
        out.msg = { cls: lateBy > 30 * 60000 ? 'bad' : 'warn', html: `Head to <strong>${esc(target.place.name)}</strong> now — at this distance you'd arrive around ${fmtClock(arriveAt)}, ${fmtDur(lateBy)} after the plan.` };
      } else if (cur && cur.kind === 'travel') {
        out.pill = { cls: 'ok', text: 'En route' };
        out.msg = { cls: 'info', html: `On the way to <strong>${esc(target.place.name)}</strong> — ${fmtDist(dTarget)} to go, arriving ~${fmtClock(arriveAt)} (planned ${fmtClock(dueAt)}).` };
      } else {
        out.pill = { cls: 'ok', text: 'On track' };
        const leaveIn = ms(dueAt, t) - travel.ms;
        out.msg = {
          cls: 'info',
          html: leaveIn > 10 * 60000
            ? `Next stop <strong>${esc(target.place.name)}</strong> is ${fmtDist(dTarget)} away. Leave in about ${fmtDur(leaveIn)} to arrive on time.`
            : `On the way to <strong>${esc(target.place.name)}</strong> — ${fmtDist(dTarget)} to go, arriving ~${fmtClock(arriveAt)}.`,
        };
      }
    }
  } else if (target) {
    out.pill = { cls: 'info', text: cur ? 'In progress' : 'Up next' };
    out.msg = { cls: 'info', html: live.loc === 'denied'
      ? 'Location is blocked, so this follows the clock only. Allow location in your browser settings for live status.'
      : 'Turn on location to see whether you\'re on track and how far the next stop is.' };
  }

  // ---- fixed departure (train / flight / bus) ----
  const dl = day.deadline;
  if (dl && t < dl.departsAt) {
    let leaveBy: Date | undefined;
    if (pos && !isHere(pos, dl.place)) {
      const tr = estimateTravel(distM(pos, dl.place));
      leaveBy = new Date(dl.atAt.getTime() - tr.ms - 15 * 60000);
    } else if (!pos) {
      leaveBy = dl.plannedLeave;
    }
    if (leaveBy) {
      out.stats.push({ k: 'Leave by', v: fmtClock(leaveBy), s: `${dl.label} ${fmtClock(dl.atAt)}` });
      const left = ms(leaveBy, t);
      if (left <= 0) {
        out.pill = { cls: 'bad', text: 'Leave now' };
        out.msg = { cls: 'bad', html: `<strong>Leave for ${esc(dl.place.name)} now.</strong> Departure ${fmtClock(dl.departsAt)}; aim to be there by ${fmtClock(dl.atAt)}.` };
      } else if (left < 45 * 60000) {
        out.pill = { cls: 'warn', text: `Leave in ${fmtDur(left)}` };
        out.msg = { cls: 'warn', html: `Start wrapping up — leave for <strong>${esc(dl.place.name)}</strong> by ${fmtClock(leaveBy)} (departure ${fmtClock(dl.departsAt)}).` };
      }
    } else if (pos && isHere(pos, dl.place)) {
      out.pill = { cls: 'ok', text: 'At the station' };
      out.msg = { cls: 'ok', html: `You're at <strong>${esc(dl.place.name)}</strong>. Departure ${fmtClock(dl.departsAt)} — ${fmtDur(ms(dl.departsAt, t))} to go. Safe travels!` };
    }
  }

  out.progress = Math.min(1, Math.max(0, ms(t, day.startAt) / (ms(day.endAt, day.startAt) || 1)));
  return out;
}

/** Applies test mode's "follow the schedule" before reading the state for a render. */
export function syncFollow(t: Date): void {
  if (sim.follow) { live.pos = scheduledPosition(t); live.posSource = 'sim'; live.loc = 'on'; }
}

/* ============================================================
   Done / skip marks
   ============================================================ */
// Shared trips pass onDone so marks sync to all members; otherwise they stay on this device.
let doneHook: ((stopId: string, on: boolean) => void) | null = null;
const doneKey = () => `mlt-done-${live.trip?.id}`;
function loadDone(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(doneKey()) || '[]')); } catch { return new Set(); }
}
function saveDone(): void {
  try { localStorage.setItem(doneKey(), JSON.stringify([...live.done])); } catch { /* storage unavailable */ }
}
/** Marks from Firestore (shared trips): stop id → who marked it. */
export function setDoneMarks(byStop: Map<string, string>): void {
  live.doneBy = byStop;
  live.done = new Set(byStop.keys());
  emit();
}
export function toggleDone(id: string): void {
  const on = !live.done.has(id);
  if (on) live.done.add(id); else live.done.delete(id);
  if (doneHook) doneHook(id, on); else saveDone();
  emit();
}
export function clearDone(): void {
  live.done.clear();
  try { localStorage.removeItem(doneKey()); } catch { /* ignore */ }
  emit();
}

/* ============================================================
   Selection
   ============================================================ */
export function selectDay(n: number): void {
  live.selectedDay = n;
  live.selectedStop = null;
  closeNearby(false);
  emit();
}
export function toggleStop(id: string): void {
  live.selectedStop = live.selectedStop === id ? null : id;
  emit();
}
export function refitMap(): void { live.refit++; emit(); }

/* ============================================================
   Weather and travel times — load in the background, re-render when they arrive. They're
   fetched again only when the dates, times or places change.
   ============================================================ */
let extrasSig = '';
function loadExtras(): void {
  const trip = live.trip;
  if (!trip) return;
  const id = trip.id;
  const sig = JSON.stringify([id, live.days.map((d) => [d.date, d.stops.map((s) => [s.id, s.start, s.end, s.place.lat, s.place.lng])])]);
  if (sig === extrasSig) return;
  extrasSig = sig;
  const days = live.days;
  tripWeather(trip).then((w) => { if (live.trip?.id === id) { live.weather = w; emit(); } }, () => {});
  tripLegs(days).then((l) => { if (live.trip?.id === id) { live.legs = l; emit(); } }, () => {});
}

/* ============================================================
   What to do nearby
   ============================================================ */
let nearbyReq = 0;
// The stop's title and note decide what to look for: "Lunch in Fort" opens on lunch spots
// closest to the stop, "Lonavala Market" on shops, anything else on sights first.
export async function openNearby(stopId: string, { general = false } = {}): Promise<void> {
  const stop = live.days.flatMap((d) => d.stops).find((s) => s.id === stopId);
  if (!stop) return;
  const intent = general ? GENERAL : intentFor(stop);
  const req = ++nearbyReq;
  live.nearby = { stop, intent, status: 'loading', items: [], filter: intent.cat, fitKey: req };
  live.map?.closePopup();
  emit();
  try {
    const items = forStop(await nearbyPlaces(stop.place), intent);
    if (req !== nearbyReq || !live.nearby) return;
    // Nothing of the kind mapped here (e.g. no bars): show everything rather than an empty list.
    const fellBack = intent.cat !== 'all' && !items.some((x) => x.cat === intent.cat);
    live.nearby = { ...live.nearby, status: 'ok', items, filter: fellBack ? 'all' : intent.cat, fellBack, fitKey: req + 0.5 };
  } catch (e) {
    if (req !== nearbyReq || !live.nearby) return;
    live.nearby = { ...live.nearby, status: 'error', error: (e as Error).message };
  }
  emit();
}
export function closeNearby(notify = true): void {
  nearbyReq++;
  live.nearby = null;
  if (notify) emit();
}
export function setNearbyFilter(filter: Cat | 'all'): void {
  if (!live.nearby) return;
  live.nearby = { ...live.nearby, filter, fitKey: live.nearby.fitKey + 0.01 };
  emit();
}

/* ============================================================
   Location
   ============================================================ */
export function startWatch(): void {
  if (!('geolocation' in navigator)) { live.loc = 'unavailable'; emit(); return; }
  if (live.watchId != null) return;
  live.loc = 'asking';
  emit();
  live.watchId = navigator.geolocation.watchPosition(
    (p) => {
      if (live.posSource === 'sim') return; // test mode location wins
      const first = !live.pos;
      live.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: p.timestamp };
      live.posSource = 'gps';
      live.loc = 'on';
      emit();
      if (first && live.map && live.trip) live.map.setView([live.pos.lat, live.pos.lng], Math.max(live.map.getZoom(), 14));
    },
    (err) => {
      live.loc = err.code === err.PERMISSION_DENIED ? 'denied' : 'error';
      stopWatch();
      emit();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
  );
}

export function stopWatch(): void {
  if (live.watchId != null) navigator.geolocation.clearWatch(live.watchId);
  live.watchId = null;
}

async function initLocation(): Promise<void> {
  if (live.posSource === 'sim') return;
  if (!('geolocation' in navigator)) { live.loc = 'unavailable'; return; }
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (perm?.state === 'granted') startWatch();
    else if (perm?.state === 'denied') live.loc = 'denied';
  } catch { /* Permissions API unsupported (older Safari) — wait for the button */ }
}

/** Test mode: where you are — 'fixed' (a point), 'follow' (the plan), 'gps' or 'none'. */
export function setSimLocation(mode: 'fixed' | 'follow' | 'gps' | 'none', pos?: { lat: number; lng: number }): void {
  sim.follow = mode === 'follow';
  if (mode === 'gps') {
    live.pos = null; live.posSource = null; live.loc = 'idle';
    startWatch();
  } else {
    stopWatch();
    live.pos = mode === 'fixed' && pos ? { ...pos, accuracy: 25 } : null;
    live.posSource = mode === 'none' ? null : 'sim';
    live.loc = mode === 'none' ? 'idle' : 'on';
    if (sim.follow) live.pos = scheduledPosition(now());
  }
}

/* ============================================================
   Mount / unmount
   ============================================================ */
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => { if (!document.hidden) emit(); };

export function mountTrip(trip: Trip, { onDone = null as ((stopId: string, on: boolean) => void) | null } = {}): void {
  // Same trip again = a live update from another member: keep the user's place in the UI.
  const update = live.trip?.id === trip.id;
  doneHook = onDone;
  live.trip = trip;
  const p = prepare(trip);
  live.clock = p.clock;
  live.days = p.days;
  if (sim.nowStr && !sim.base) setSimTime(live.clock.parseInput(sim.nowStr));
  if (sim.speed !== 1 && !sim.base) setSimTime(new Date());
  if (update) {
    if (!live.days.some((d) => d.n === live.selectedDay)) live.selectedDay = null;
    loadExtras();
    emit();
    return;
  }
  live.selectedDay = null;
  live.selectedStop = null;
  live.nearby = null;
  nearbyReq++;
  live.done = onDone ? new Set() : loadDone();
  live.doneBy = new Map();
  live.weather = new Map();
  live.legs = new Map();
  live.refit++;
  loadExtras();
  timer ??= setInterval(emit, TICK_MS);
  document.addEventListener('visibilitychange', onVisible);
  initLocation().then(emit);
  emit();
}

export function unmountTrip(): void {
  live.trip = null;
  extrasSig = '';
  live.nearby = null;
  nearbyReq++;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  if (live.posSource === 'gps') { stopWatch(); live.pos = null; live.posSource = null; live.loc = 'idle'; }
  emit();
}
