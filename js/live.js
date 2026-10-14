// Live view for one trip: status card, day tabs, timeline and map.
import {
  esc, distM, fmtDist, estimateTravel, directionsUrl, isHere, fmtDur, fmtHHMM, makeClock,
  THEMES, THEME_COLORS, TAG_LABELS, weekdayOf, shortDate, dayMonth, fmtRange,
} from './util.js';
import { nearbyPlaces, forStop, intentFor, GENERAL, CATS } from './nearby.js';

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
  base: null, // null = real clock
  anchor: Date.now(),
  speed: Number(params.get('speed')) || 1,
  paused: false,
  loc: params.has('lat') && params.has('lng')
    ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')), accuracy: 25 }
    : null,
  follow: params.get('follow') === '1',
};
const TICK_MS = sim.enabled ? 1000 : 20_000;

export function now() {
  if (!sim.base) return new Date();
  if (sim.paused) return new Date(sim.base);
  return new Date(sim.base.getTime() + (Date.now() - sim.anchor) * sim.speed);
}
// Re-anchor the simulated clock so speed/pause changes don't make it jump.
export function setSimTime(d) { sim.base = new Date(d); sim.anchor = Date.now(); }

/* ---------- current trip ---------- */
export let TRIP = null;
export let DAYS = [];
export let clock = makeClock();

export const state = {
  pos: sim.loc,
  posSource: sim.loc || sim.follow ? 'sim' : null, // 'sim' | 'gps' | null
  loc: sim.loc || sim.follow ? 'on' : 'idle', // idle | asking | on | denied | unavailable | error
  watchId: null,
  selectedDay: null,
  selectedStop: null,
  done: new Set(),
  doneBy: new Map(), // stop id → email of the member who marked it (shared trips)
};

// Shared trips pass onDone so marks sync to all members; otherwise they stay on this device.
let doneHook = null;
export function setDone(byStop) {
  state.doneBy = byStop;
  state.done = new Set(byStop.keys());
  if (TRIP) render();
}

const samePlace = (a, b) => a.lat === b.lat && a.lng === b.lng;

function prepare(trip) {
  const c = makeClock(trip.timezone);
  const days = trip.days.filter((d) => d.stops.length).map((d, i) => {
    const day = { ...d, n: i + 1, theme: THEMES[i % THEMES.length], weekday: weekdayOf(d.date), label: shortDate(d.date) };
    day.stops = d.stops.map((s, j) => ({ ...s, id: s.id || `d${i + 1}-${j}`, idx: j, day, startAt: c.at(d.date, s.start), endAt: c.at(d.date, s.end) }));
    day.startAt = day.stops[0].startAt;
    day.endAt = day.stops[day.stops.length - 1].endAt;
    // A stop marked as a fixed departure (train, flight, bus) drives the "leave by" countdown.
    const dep = day.stops.find((s) => s.departure);
    if (dep) {
      day.deadline = {
        label: `Be at ${dep.place.name}`,
        place: dep.place,
        departsAt: dep.startAt,
        atAt: new Date(dep.startAt.getTime() - dep.departure.buffer * 60000),
      };
      // Without location: plan to leave when the schedule first heads there.
      const firstThere = day.stops.find((s) => samePlace(s.place, dep.place));
      const fallback = day.deadline.atAt.getTime() - 30 * 60000;
      day.deadline.plannedLeave = new Date(Math.min(firstThere.startAt.getTime(), fallback));
    }
    return day;
  });
  return { clock: c, days };
}

const doneKey = () => `mlt-done-${TRIP?.id}`;
function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(doneKey()) || '[]')); } catch { return new Set(); }
}
function saveDone() {
  try { localStorage.setItem(doneKey(), JSON.stringify([...state.done])); } catch { /* storage unavailable */ }
}

/* ============================================================
   Status engine
   ============================================================ */
function tripPhase(t) {
  if (!DAYS.length) return { phase: 'empty' };
  if (t < DAYS[0].startAt) return { phase: 'before' };
  if (t >= DAYS[DAYS.length - 1].endAt) return { phase: 'after' };
  const today = DAYS.find((d) => d.date === clock.dateKey(t));
  if (!today) return { phase: 'between', next: DAYS.find((d) => d.startAt > t) };
  if (t < today.startAt) return { phase: 'morning', day: today };
  if (t >= today.endAt) return { phase: 'night', day: today, next: DAYS.find((d) => d.startAt > t) };
  return { phase: 'live', day: today };
}

function stopState(s, t) {
  if (state.done.has(s.id)) return 'done';
  if (t >= s.endAt) return 'past';
  if (t >= s.startAt) return 'now';
  return 'upcoming';
}

// Where the plan says you'd be at time t — used by test mode's "follow the schedule".
// Inside a stop you're at its place; during travel or gaps you move in a straight line.
export function scheduledPosition(t) {
  const flat = DAYS.flatMap((d) => d.stops);
  if (!flat.length) return null;
  const lerp = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, accuracy: 20 });
  if (t < flat[0].startAt) return lerp(flat[0].place, flat[0].place, 0);
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i], prev = flat[i - 1];
    if (t >= s.startAt && t < s.endAt) {
      if (s.kind === 'travel' && prev) return lerp(prev.place, s.place, (t - s.startAt) / (s.endAt - s.startAt));
      return lerp(s.place, s.place, 0);
    }
    const next = flat[i + 1];
    if (next && t >= s.endAt && t < next.startAt) {
      // Overnight gaps: stay put rather than drifting across the map.
      if (s.day !== next.day) return lerp(s.place, s.place, 0);
      return lerp(s.place, next.place, (t - s.endAt) / (next.startAt - s.endAt));
    }
  }
  const last = flat[flat.length - 1].place;
  return lerp(last, last, 0);
}

// The headline pill for any time/position — shared by the UI and test mode's checks.
export function computeStatus(t, pos = state.pos) {
  const ph = tripPhase(t);
  const fixed = { empty: 'No stops', before: 'Countdown', after: 'Complete', morning: 'Good morning', between: 'Good morning', night: 'Rest up' }[ph.phase];
  if (fixed) return { phase: ph.phase, pill: { text: fixed } };
  return { phase: ph.phase, ...liveStatus(ph.day, t, pos) };
}

function liveStatus(day, t, pos = state.pos) {
  const fmtClock = clock.fmtClock;
  const open = day.stops.filter((s) => !state.done.has(s.id));
  const cur = open.find((s) => s.startAt <= t && t < s.endAt) || null;
  const next = open.find((s) => s.startAt > t) || null;
  const target = cur || next;
  const out = { day, cur, next, target, pill: { cls: 'info', text: 'On schedule' }, msg: null, stats: [] };

  if (cur) {
    out.stats.push({ k: cur.kind === 'travel' ? 'Arrive by' : 'Ends in', v: cur.kind === 'travel' ? fmtClock(cur.endAt) : fmtDur(cur.endAt - t), s: cur.kind === 'travel' ? '' : `at ${fmtClock(cur.endAt)}` });
  }
  if (next) out.stats.push({ k: 'Next up', v: fmtDur(next.startAt - t), s: next.title });

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
        out.msg = { cls: 'ok', html: `You're at <strong>${esc(target.place.name)}</strong>. Enjoy — you have ${fmtDur(cur.endAt - t)} here.` };
      } else if (cur === target) {
        out.pill = { cls: 'ok', text: 'Arrived' };
        out.msg = { cls: 'ok', html: `You've reached <strong>${esc(target.place.name)}</strong>${t < cur.endAt ? ` — ${fmtDur(cur.endAt - t)} ahead of the planned arrival` : ''}.` };
      } else {
        out.pill = { cls: 'ok', text: 'Early' };
        out.msg = { cls: 'ok', html: `You're already at <strong>${esc(target.place.name)}</strong> — ${fmtDur(target.startAt - t)} before it's scheduled.` };
      }
    } else {
      const ahead = hereStops.filter((s) => s.idx > target.idx);
      const behind = hereStops.filter((s) => s.idx < target.idx);
      const arriveAt = new Date(t.getTime() + travel.ms);
      const lateBy = arriveAt - dueAt;

      if (ahead.length && !behind.length) {
        out.pill = { cls: 'ok', text: 'Ahead' };
        out.msg = { cls: 'ok', html: `You're at <strong>${esc(ahead[0].title)}</strong> — ahead of schedule. Mark earlier stops done or skip them if you like.` };
      } else if (cur && cur.kind !== 'travel') {
        // Should be at the current stop but aren't.
        const into = t - cur.startAt;
        const where = behind.length ? `still near <strong>${esc(behind[behind.length - 1].place.name)}</strong>` : `${fmtDist(dTarget)} away`;
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
        const leaveIn = dueAt - t - travel.ms;
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
    out.msg = { cls: 'info', html: state.loc === 'denied'
      ? 'Location is blocked, so this follows the clock only. Allow location in your browser settings for live status.'
      : 'Turn on location to see whether you\'re on track and how far the next stop is.' };
  }

  // ---- fixed departure (train / flight / bus) ----
  const dl = day.deadline;
  if (dl && t < dl.departsAt) {
    let leaveBy;
    if (pos && !isHere(pos, dl.place)) {
      const tr = estimateTravel(distM(pos, dl.place));
      leaveBy = new Date(dl.atAt - tr.ms - 15 * 60000);
    } else if (!pos) {
      leaveBy = dl.plannedLeave;
    }
    if (leaveBy) {
      out.stats.push({ k: 'Leave by', v: fmtClock(leaveBy), s: `${dl.label} ${fmtClock(dl.atAt)}` });
      const left = leaveBy - t;
      if (left <= 0) {
        out.pill = { cls: 'bad', text: 'Leave now' };
        out.msg = { cls: 'bad', html: `<strong>Leave for ${esc(dl.place.name)} now.</strong> Departure ${fmtClock(dl.departsAt)}; aim to be there by ${fmtClock(dl.atAt)}.` };
      } else if (left < 45 * 60000) {
        out.pill = { cls: 'warn', text: `Leave in ${fmtDur(left)}` };
        out.msg = { cls: 'warn', html: `Start wrapping up — leave for <strong>${esc(dl.place.name)}</strong> by ${fmtClock(leaveBy)} (departure ${fmtClock(dl.departsAt)}).` };
      }
    } else if (pos && isHere(pos, dl.place)) {
      out.pill = { cls: 'ok', text: 'At the station' };
      out.msg = { cls: 'ok', html: `You're at <strong>${esc(dl.place.name)}</strong>. Departure ${fmtClock(dl.departsAt)} — ${fmtDur(dl.departsAt - t)} to go. Safe travels!` };
    }
  }

  out.progress = Math.min(1, Math.max(0, (t - day.startAt) / (day.endAt - day.startAt || 1)));
  return out;
}

/* ============================================================
   Rendering
   ============================================================ */
const $ = (id) => document.getElementById(id);

export function render() {
  if (!TRIP) return;
  const t = now();
  if (sim.follow) { state.pos = scheduledPosition(t); state.posSource = 'sim'; state.loc = 'on'; }
  const ph = tripPhase(t);
  if (state.selectedDay == null && DAYS.length) state.selectedDay = (ph.day || ph.next || (ph.phase === 'after' ? DAYS[DAYS.length - 1] : DAYS[0])).n;

  renderPhaseLine(ph, t);
  renderStatus(ph, t);
  renderLocButton();
  renderTabs(ph);
  renderDay(t, ph);
  renderMap(t);
}

function renderPhaseLine(ph, t) {
  const range = fmtRange(DAYS[0]?.date, DAYS[DAYS.length - 1]?.date);
  const line = {
    empty: 'No stops yet',
    before: `Starts in ${fmtDur(DAYS[0]?.startAt - t)} · ${range}`,
    after: `Trip complete · ${range}`,
  }[ph.phase] || `Day ${(ph.day || ph.next).n} of ${DAYS.length} · ${clock.fmtClock(t)} ${clock.label}`;
  $('hero-sub').textContent = line;
}

function setPill(p, live) {
  const el = $('status-pill');
  el.className = `pill ${p.cls || 'info'}${live ? ' live' : ''}`;
  el.textContent = p.text;
}

function statsHtml(stats) {
  if (!stats.length) return '';
  return `<div class="stats">${stats.map((s) => `<div class="stat"><div class="k">${esc(s.k)}</div><div class="v">${esc(s.v)}</div>${s.s ? `<div class="s">${esc(s.s)}</div>` : ''}</div>`).join('')}</div>`;
}

function renderStatus(ph, t) {
  const body = $('status-body');
  if (ph.phase === 'empty') {
    setPill({ cls: 'info', text: 'No stops' });
    body.innerHTML = `<div class="now-title">This trip has no stops yet</div><div class="now-meta">Tap <strong>Edit</strong> to add days and places.</div>`;
    return;
  }
  if (ph.phase === 'before') {
    const first = DAYS[0].stops[0];
    setPill({ cls: 'info', text: 'Countdown' });
    body.innerHTML = `
      <div class="now-title">Trip starts in ${esc(fmtDur(first.startAt - t))}</div>
      <div class="now-meta">${esc(DAYS[0].weekday)}, ${esc(dayMonth(DAYS[0].date))} · ${esc(fmtHHMM(first.start))} — ${esc(first.title)}</div>
      <div class="status-msg info">Live status switches on automatically once the trip begins. Turn on location now so it's ready.</div>`;
    return;
  }
  if (ph.phase === 'after') {
    setPill({ cls: 'ok', text: 'Complete' });
    body.innerHTML = `<div class="now-title">Hope it was a great trip!</div><div class="now-meta">All ${DAYS.length} days are done. The itinerary stays here for reference.</div>`;
    return;
  }
  if (ph.phase === 'morning' || ph.phase === 'night' || ph.phase === 'between') {
    const nd = ph.phase === 'morning' ? ph.day : ph.next;
    const first = nd.stops[0];
    setPill({ cls: 'info', text: ph.phase === 'night' ? 'Rest up' : 'Good morning' });
    body.innerHTML = `
      <div class="now-title">Day ${nd.n} starts ${ph.phase === 'night' ? 'tomorrow' : 'soon'}</div>
      <div class="now-meta">${esc(fmtHHMM(first.start))} — ${esc(first.title)} · in ${esc(fmtDur(first.startAt - t))}</div>
      ${statsHtml([{ k: 'First stop', v: fmtHHMM(first.start), s: first.place.name }, ...(state.pos ? [{ k: 'Distance', v: fmtDist(distM(state.pos, first.place)), s: 'to first stop' }] : [])])}
      <div class="actions"><a class="btn" href="${directionsUrl(first.place)}" target="_blank" rel="noopener">Directions</a></div>`;
    return;
  }

  const st = liveStatus(ph.day, t);
  setPill(st.pill, true);
  const focus = st.cur || st.next;
  body.innerHTML = focus ? `
    <div class="now-title">${st.cur ? '' : '<span style="color:var(--muted);font-size:.7em">Up next · </span>'}${esc(focus.title)}</div>
    <div class="now-meta">${esc(fmtHHMM(focus.start))} – ${esc(fmtHHMM(focus.end))} · ${esc(focus.place.name)}${focus.note ? ` · ${esc(focus.note)}` : ''}</div>
    ${st.msg ? `<div class="status-msg ${st.msg.cls}">${st.msg.html}</div>` : ''}
    ${statsHtml(st.stats)}
    <div class="progress" title="Day progress"><span style="width:${(st.progress * 100).toFixed(1)}%"></span></div>
    <div class="actions">
      <a class="btn" href="${directionsUrl(focus.place)}" target="_blank" rel="noopener">Directions</a>
      <button class="btn ghost" type="button" data-nearby="${focus.id}">${esc(intentFor(focus).button)}</button>
      <button class="btn ghost" type="button" data-done="${focus.id}">${st.cur ? 'Done / skip' : 'Skip this'}</button>
    </div>` : `
    <div class="now-title">That's everything for today</div>
    <div class="now-meta">All of Day ${st.day.n}'s stops are done.</div>`;
}

function renderLocButton() {
  const dot = $('loc-dot'), label = $('loc-label');
  dot.className = 'loc-dot';
  const acc = state.pos?.accuracy;
  switch (state.loc) {
    case 'on': dot.classList.add('on'); label.textContent = state.posSource === 'sim' ? (sim.follow ? 'Following schedule' : 'Simulated location') : `Location on${acc ? ` · ±${Math.round(acc)} m` : ''}`; break;
    case 'asking': label.textContent = 'Finding you…'; break;
    case 'denied': dot.classList.add('err'); label.textContent = 'Location blocked'; break;
    case 'unavailable': dot.classList.add('err'); label.textContent = 'Location unavailable'; break;
    case 'error': dot.classList.add('err'); label.textContent = 'Retry location'; break;
    default: label.textContent = 'Use my location';
  }
  $('me-btn').disabled = !state.pos;
}

function renderTabs(ph) {
  const todayN = ph.day?.n;
  $('tabs').innerHTML = DAYS.map((d) => `
    <button class="tab theme-${d.theme}" role="tab" type="button" data-day="${d.n}" aria-selected="${d.n === state.selectedDay}">
      <div class="tn">${d.n}</div>
      <div class="td">${esc(d.label)}${d.n === todayN ? '<span class="today" title="Today"></span>' : ''}</div>
    </button>`).join('');
}

function renderDay(t, ph) {
  const el = $('day');
  const day = DAYS.find((d) => d.n === state.selectedDay);
  if (!day) { el.className = 'day'; el.innerHTML = ''; return; }
  const isToday = ph.day === day;
  el.className = `day theme-${day.theme}`;

  el.innerHTML = `
    <div class="day-band">
      <div class="num">${String(day.n).padStart(2, '0')}</div>
      <div class="eyebrow">Day ${day.n} · ${esc(day.weekday)}, ${esc(dayMonth(day.date))}</div>
      <h2>${esc(day.title || `Day ${day.n}`)}</h2>
    </div>
    <ol class="timeline">
      ${day.stops.map((s) => {
        const ss = stopState(s, t);
        const here = isToday && isHere(state.pos, s.place);
        const cls = ['tl', s.kind, ss === 'done' || ss === 'past' ? 'done' : '', ss === 'now' ? 'now' : '', here ? 'here' : '', state.selectedStop === s.id ? 'selected' : ''].join(' ');
        const dist = state.pos ? fmtDist(distM(state.pos, s.place)) : null;
        return `
        <li class="${cls}" data-stop="${s.id}" tabindex="0">
          <div class="t">${esc(fmtHHMM(s.start))}<small>to ${esc(fmtHHMM(s.end))}</small></div>
          <div class="d"></div>
          <div class="c">
            <div class="w">${esc(s.title)}${s.tag ? `<span class="tag ${s.tag}">${TAG_LABELS[s.tag]}</span>` : ''}${s.departure ? '<span class="tag deadline">Departure</span>' : ''}${ss === 'now' ? '<span class="tag nowtag">Now</span>' : ''}${here ? '<span class="tag heretag">You\'re here</span>' : ''}</div>
            ${s.note ? `<div class="n">${esc(s.note)}</div>` : ''}
            <div class="m"><span>📍 ${esc(s.place.name)}${s.place.approx ? ' (approx.)' : ''}</span>${dist ? `<span>${dist} away</span>` : ''}${state.doneBy.has(s.id) ? `<span class="done-by">✓ ${esc(state.doneBy.get(s.id).split('@')[0])}</span>` : ''}</div>
            ${state.selectedStop === s.id ? `
              <div class="stop-actions">
                <a class="mini" href="${directionsUrl(s.place)}" target="_blank" rel="noopener">Directions</a>
                <button class="mini" type="button" data-nearby="${s.id}">${intentFor(s).icon} ${esc(intentFor(s).button)}</button>
                <button class="mini" type="button" data-done="${s.id}">${state.done.has(s.id) ? 'Undo done' : 'Mark done / skip'}</button>
              </div>` : ''}
          </div>
        </li>`;
      }).join('')}
    </ol>
    ${day.notes?.length ? `<div class="notes">${day.notes.map((n) => `<div class="note ${n.type}"><b>${esc(n.title)}</b>${esc(n.text)}</div>`).join('')}</div>` : ''}`;
}

/* ---------- map ---------- */
let map, layer, meLayer, nearLayer, lastMapDay = null, lastMapSig = '';
export const getMap = () => map;
export function refitMap() { lastMapDay = null; lastMapSig = ''; }

function initMap() {
  if (!window.L) { $('map').innerHTML = '<p style="padding:16px;color:var(--muted)">Map unavailable offline.</p>'; return; }
  map = L.map('map', { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  nearLayer = L.layerGroup().addTo(map);
  meLayer = L.layerGroup().addTo(map);
}

function renderMap(t) {
  if (!map) return;
  const day = DAYS.find((d) => d.n === state.selectedDay);
  if (!day) { layer.clearLayers(); map.setView([20.6, 78.9], 4); renderMe(); return; }
  const color = THEME_COLORS[day.theme];
  // Only rebuild markers when something visible changed, so open popups survive the clock tick.
  const sig = `${TRIP.id}|${day.n}|${day.stops.map((s) => stopState(s, t)).join(',')}`;
  if (sig === lastMapSig && lastMapDay === day.n) { renderMe(); return; }
  lastMapSig = sig;
  layer.clearLayers();

  // One marker per distinct place, numbered by first appearance.
  const seen = new Map();
  day.stops.forEach((s) => {
    const key = `${s.place.lat},${s.place.lng}`;
    if (!seen.has(key)) seen.set(key, { place: s.place, stops: [] });
    seen.get(key).stops.push(s);
  });

  const pts = [];
  [...seen.values()].forEach((g, i) => {
    const states = g.stops.map((s) => stopState(s, t));
    const cls = states.includes('now') ? 'now' : states.every((x) => x === 'done' || x === 'past') ? 'done' : '';
    const icon = L.divIcon({ className: '', html: `<div class="num-marker ${cls}" style="background:${color}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const popup = `<strong>${esc(g.place.name)}</strong><br>${g.stops.map((s) => `${esc(fmtHHMM(s.start))} · ${esc(s.title)}`).join('<br>')}<div class="pop-actions"><a href="${directionsUrl(g.place)}" target="_blank" rel="noopener">Directions</a>${nearbyPopupBtn(g.stops)}</div>`;
    const m = L.marker([g.place.lat, g.place.lng], { icon }).bindPopup(popup).addTo(layer);
    g.stops.forEach((s) => { s._marker = m; });
    pts.push([g.place.lat, g.place.lng]);
  });
  const route = [];
  day.stops.forEach((s) => {
    const p = [s.place.lat, s.place.lng];
    const last = route[route.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) route.push(p);
  });
  L.polyline(route, { color, weight: 3, opacity: 0.55, dashArray: '6 8' }).addTo(layer);

  if (lastMapDay !== day.n) {
    lastMapDay = day.n;
    map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  }
  renderMe();
}

// One stop at this pin: search for what it's for. Several (check-in, dinner, breakfast…): the general list.
function nearbyPopupBtn(stops) {
  const one = stops.length === 1;
  return `<button type="button" class="link-btn" data-nearby="${stops[0].id}"${one ? '' : ' data-nb-general'}>${esc(one ? intentFor(stops[0]).button : 'What to do nearby')}</button>`;
}

function renderMe() {
  if (!map) return;
  meLayer.clearLayers();
  if (!state.pos) return;
  const ll = [state.pos.lat, state.pos.lng];
  if (state.pos.accuracy) L.circle(ll, { radius: state.pos.accuracy, color: '#2b7de9', weight: 1, fillOpacity: 0.1 }).addTo(meLayer);
  L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 })
    .bindPopup('You are here').addTo(meLayer);
}

/* ============================================================
   What to do nearby — panel under the map plus icon pins
   ============================================================ */
// { stop, intent, status: 'loading' | 'ok' | 'error', items, filter, fellBack, error }
let nearby = null;
let nearbyReq = 0;
const nearMarkers = new Map();

// The stop's title and note decide what to look for: "Lunch in Fort" opens on lunch spots
// closest to the stop, "Lonavala Market" on shops, anything else on sights first.
async function openNearby(stopId, { general = false } = {}) {
  const stop = DAYS.flatMap((d) => d.stops).find((s) => s.id === stopId);
  if (!stop) return;
  const intent = general ? GENERAL : intentFor(stop);
  const req = ++nearbyReq;
  nearby = { stop, intent, status: 'loading', items: [], filter: intent.cat };
  map?.closePopup();
  renderNearby({ fit: true });
  // Phones show the map above the timeline: bring it into view.
  $('nearby').closest('.map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const items = forStop(await nearbyPlaces(stop.place), intent);
    if (req !== nearbyReq) return;
    // Nothing of the kind mapped here (e.g. no bars): show everything rather than an empty list.
    const fellBack = intent.cat !== 'all' && !items.some((x) => x.cat === intent.cat);
    nearby = { ...nearby, status: 'ok', items, filter: fellBack ? 'all' : intent.cat, fellBack };
  } catch (e) {
    if (req !== nearbyReq) return;
    nearby = { ...nearby, status: 'error', error: e.message };
  }
  renderNearby({ fit: true });
}

function closeNearby() {
  nearbyReq++;
  nearby = null;
  renderNearby();
}

function renderNearby({ fit = false } = {}) {
  const el = $('nearby');
  const card = el.closest('.map-card');
  nearLayer?.clearLayers();
  nearMarkers.clear();
  const wasOpen = card.classList.contains('has-nearby');
  card.classList.toggle('has-nearby', !!nearby);
  if (!nearby) {
    el.hidden = true;
    el.innerHTML = '';
    if (wasOpen) setTimeout(() => map?.invalidateSize(), 0);
    return;
  }
  el.hidden = false;
  const { stop, intent, status, items, filter } = nearby;
  const shown = filter === 'all' ? items : items.filter((x) => x.cat === filter);
  const count = (c) => items.filter((x) => x.cat === c).length;
  const near = intent === GENERAL ? 'What to do near' : `${intent.title} near`;
  const head = `
    <div class="nb-head">
      <div>
        <div class="nb-eyebrow">${intent.icon} ${esc(near)}</div>
        <strong>${esc(stop.place.name)}</strong>
        <div class="nb-for">For “${esc(stop.title)}” · ${esc(fmtHHMM(stop.start))}</div>
      </div>
      <button class="icon-btn" type="button" data-nb-close aria-label="Close nearby places">✕</button>
    </div>`;

  if (status === 'loading') {
    el.innerHTML = `${head}<p class="nb-msg">Finding ${esc(intent === GENERAL ? 'things to do' : intent.title.toLowerCase())} around here… This can take a few seconds.</p>`;
  } else if (status === 'error') {
    el.innerHTML = `${head}<p class="nb-msg">${esc(nearby.error)}</p><div class="nb-pad"><button class="mini" type="button" data-nb-retry>Try again</button></div>`;
  } else if (!items.length) {
    el.innerHTML = `${head}<p class="nb-msg">Nothing listed on OpenStreetMap within 3 km of this stop.</p>`;
  } else {
    el.innerHTML = `${head}
      ${nearby.fellBack ? `<p class="nb-msg nb-fallback">No ${esc(intent.title.toLowerCase())} are listed on the map this close to the stop. Here's what else is around.</p>` : ''}
      <div class="nb-filters" role="tablist" aria-label="Filter nearby places">
        ${[['all', 'All', items.length], ...Object.entries(CATS).map(([k, c]) => [k, `${c.icon} ${c.label}`, count(k)])]
          .filter(([k, , n]) => k === 'all' || n)
          .map(([k, label, n]) => `<button class="nb-chip" type="button" role="tab" data-nb-filter="${k}" aria-selected="${filter === k}">${label} <span>${n}</span></button>`).join('')}
      </div>
      <ul class="nb-list">
        ${shown.map((x) => `
          <li data-nb-item="${esc(x.id)}" tabindex="0">
            <span class="nb-ic" aria-hidden="true">${x.icon}</span>
            <span class="nb-main">
              <span class="nb-name">${esc(x.name)}${x.famous ? ' <span class="nb-pop" title="Well known: has a Wikipedia entry">★ Popular</span>' : ''}</span>
              <span class="nb-meta">${esc(x.label)} · ${fmtDist(x.dist)} from stop</span>
              ${x.hours && x.cat !== 'see' ? `<span class="nb-hours">🕒 ${esc(x.hours)}</span>` : ''}
            </span>
            <a class="mini" href="${directionsUrl(x)}" target="_blank" rel="noopener">Go</a>
          </li>`).join('')}
      </ul>
      <p class="nb-foot">From OpenStreetMap. ${intent.cat === 'eat' || intent.cat === 'drink' ? 'Closest to the stop first.' : 'Well-known places first, then the closest.'} Check opening hours before you go.</p>`;
  }

  if (!map) return;
  // Pins for what's listed, plus a ring around the stop they're near.
  L.circle([stop.place.lat, stop.place.lng], { radius: 80, color: '#e8704f', weight: 2, fillOpacity: 0.08 }).addTo(nearLayer);
  for (const x of shown) {
    const icon = L.divIcon({ className: '', html: `<div class="nb-marker${x.famous ? ' pop' : ''}">${x.icon}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const popup = `<strong>${esc(x.name)}</strong><br>${esc(x.label)} · ${fmtDist(x.dist)} from ${esc(stop.place.name)}<div class="pop-actions"><a href="${directionsUrl(x)}" target="_blank" rel="noopener">Directions</a>${x.wiki ? `<a href="${esc(x.wiki)}" target="_blank" rel="noopener">About</a>` : ''}</div>`;
    nearMarkers.set(x.id, L.marker([x.lat, x.lng], { icon }).bindPopup(popup).addTo(nearLayer));
  }
  if (!wasOpen) setTimeout(() => map.invalidateSize(), 0);
  if (fit) {
    // Meals zoom in on the closest handful, so the map shows the spots right around the stop.
    const focus = intent.cat === filter && (filter === 'eat' || filter === 'drink') ? shown.slice(0, 6) : shown;
    const pts = [[stop.place.lat, stop.place.lng], ...focus.map((x) => [x.lat, x.lng])];
    setTimeout(() => (pts.length > 1 ? map.fitBounds(pts, { padding: [30, 30], maxZoom: 17 }) : map.setView(pts[0], 16)), 0);
  }
}

function focusNearby(id) {
  const x = nearby?.items.find((i) => i.id === id);
  const m = nearMarkers.get(id);
  if (!x || !m || !map) return;
  map.setView([x.lat, x.lng], Math.max(map.getZoom(), 16));
  m.openPopup();
  $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============================================================
   Location
   ============================================================ */
export function startWatch() {
  if (!('geolocation' in navigator)) { state.loc = 'unavailable'; render(); return; }
  if (state.watchId != null) return;
  state.loc = 'asking';
  if (TRIP) renderLocButton();
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      if (state.posSource === 'sim') return; // test mode location wins
      const first = !state.pos;
      state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, ts: p.timestamp };
      state.posSource = 'gps';
      state.loc = 'on';
      render();
      if (first && map && TRIP) map.setView([state.pos.lat, state.pos.lng], Math.max(map.getZoom(), 14));
    },
    (err) => {
      state.loc = err.code === err.PERMISSION_DENIED ? 'denied' : 'error';
      stopWatch();
      render();
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
  );
}

export function stopWatch() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
}

async function initLocation() {
  if (state.posSource === 'sim') return;
  if (!('geolocation' in navigator)) { state.loc = 'unavailable'; return; }
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm?.state === 'granted') startWatch();
    else if (perm?.state === 'denied') state.loc = 'denied';
  } catch { /* Permissions API unsupported (older Safari) — wait for the button */ }
}

/* ============================================================
   Events (bound once)
   ============================================================ */
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  $('view-trip').addEventListener('click', (e) => {
    const doneBtn = e.target.closest('[data-done]');
    if (doneBtn) {
      const id = doneBtn.dataset.done;
      const on = !state.done.has(id);
      if (on) state.done.add(id); else state.done.delete(id);
      if (doneHook) doneHook(id, on); else saveDone();
      render();
      return;
    }
    const nb = e.target.closest('[data-nearby], [data-nb-close], [data-nb-retry], [data-nb-filter], [data-nb-item]');
    if (nb && !e.target.closest('a')) {
      if (nb.dataset.nearby) openNearby(nb.dataset.nearby, { general: 'nbGeneral' in nb.dataset });
      else if ('nbClose' in nb.dataset) closeNearby();
      else if ('nbRetry' in nb.dataset) openNearby(nearby.stop.id, { general: nearby.intent === GENERAL });
      else if (nb.dataset.nbFilter) { nearby.filter = nb.dataset.nbFilter; renderNearby({ fit: true }); }
      else if (nb.dataset.nbItem) focusNearby(nb.dataset.nbItem);
      return;
    }
    const tab = e.target.closest('[data-day]');
    if (tab) {
      state.selectedDay = Number(tab.dataset.day);
      state.selectedStop = null;
      closeNearby();
      render();
      return;
    }
    const stop = e.target.closest('[data-stop]');
    if (stop && !e.target.closest('a')) {
      const id = stop.dataset.stop;
      state.selectedStop = state.selectedStop === id ? null : id;
      render();
      const s = DAYS.flatMap((d) => d.stops).find((x) => x.id === id);
      if (state.selectedStop && map && s) {
        map.setView([s.place.lat, s.place.lng], Math.max(map.getZoom(), 15));
        s._marker?.openPopup();
      }
    }
  });
  $('view-trip').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-stop], [data-nb-item]')) { e.preventDefault(); e.target.click(); }
  });
  $('loc-btn').addEventListener('click', () => {
    if (state.posSource === 'sim' || state.loc === 'on' || state.loc === 'asking') return;
    startWatch();
  });
  $('fit-btn').addEventListener('click', () => { refitMap(); render(); });
  $('me-btn').addEventListener('click', () => { if (state.pos && map) map.setView([state.pos.lat, state.pos.lng], 16); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

/* ============================================================
   Mount / unmount
   ============================================================ */
let timer = null, testkit = null;

export function mountTrip(trip, { onDone = null } = {}) {
  // Same trip again = a live update from another member: keep the user's place in the UI.
  const update = TRIP?.id === trip.id;
  doneHook = onDone;
  TRIP = trip;
  ({ clock, days: DAYS } = prepare(trip));
  if (sim.nowStr && !sim.base) setSimTime(clock.parseInput(sim.nowStr));
  if (sim.speed !== 1 && !sim.base) setSimTime(new Date());
  if (update) {
    lastMapSig = '';
    if (!DAYS.some((d) => d.n === state.selectedDay)) state.selectedDay = null;
    render();
    return;
  }
  state.selectedDay = null;
  state.selectedStop = null;
  closeNearby();
  state.done = onDone ? new Set() : loadDone();
  state.doneBy = new Map();
  refitMap();
  $('site-foot').textContent = `Times are in trip time (${clock.label}). Your location stays on your device and is never uploaded.`;

  wire();
  if (!map) initMap();
  else setTimeout(() => { map.invalidateSize(); refitMap(); render(); }, 0);
  render();
  timer ??= setInterval(render, TICK_MS);
  initLocation().then(render);

  if (sim.enabled) {
    testkit ??= import('./testkit.js').then((m) => { m.mount(); return m; });
    testkit.then((m) => m.show(true));
  }
}

export function unmountTrip() {
  TRIP = null;
  closeNearby();
  clearInterval(timer);
  timer = null;
  if (state.posSource === 'gps') { stopWatch(); state.pos = null; state.posSource = null; state.loc = 'idle'; }
  testkit?.then((m) => m.show(false));
}
