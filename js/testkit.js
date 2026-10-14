// Test panel — loaded only in test mode (?test). Lets you jump/fast-forward time,
// move your location, and run every key scenario in one go.
import {
  sim, state, DAYS, TRIP, clock, now, setSimTime, render, computeStatus,
  scheduledPosition, startWatch, stopWatch, getMap, refitMap,
} from './live.js';
import { esc } from './util.js';

// The scenario checks are written against the bundled Mumbai trip.
const SCENARIO_TRIP = 'mumbai-lonavala-2026';

const SPEEDS = [1, 10, 60, 300];
const stop = (d, i) => ({ ref: [d, i] }); // resolved against the open trip when used
const locOf = (sc) => (sc.loc?.ref ? DAYS[sc.loc.ref[0] - 1].stops[sc.loc.ref[1]].place : sc.loc);
const at = (lat, lng) => ({ lat, lng });

// Each scenario: a time, a location (null = location off), and the headline pill we expect.
// `expect` is matched as a prefix, so 'Leave in' matches 'Leave in 4 min'.
const SCENARIOS = [
  { name: 'Before the trip',                    now: '2026-10-16T20:00', loc: null,               expect: 'Countdown' },
  { name: 'D1 · At CSMT on time',               now: '2026-10-17T14:10', loc: stop(1, 2),         expect: 'On track' },
  { name: 'D1 · Still at Colaba Causeway, late', now: '2026-10-17T17:20', loc: stop(1, 5),         expect: 'Running behind' },
  { name: 'D1 · Marine Drive at night',         now: '2026-10-17T20:30', loc: stop(1, 8),         expect: 'On track' },
  { name: 'D1 · Day over',                      now: '2026-10-17T23:45', loc: null,               expect: 'Rest up' },
  { name: 'D2 · Reaching Khandala',             now: '2026-10-18T08:00', loc: at(18.7548, 73.3767), expect: 'On track' },
  { name: "D2 · At Tiger Point during Lion's",  now: '2026-10-18T11:10', loc: stop(2, 4),         expect: 'Ahead' },
  { name: 'D2 · At Tiger Point',                now: '2026-10-18T12:20', loc: stop(2, 4),         expect: 'On track' },
  { name: 'D2 · Location off',                  now: '2026-10-18T12:20', loc: null,               expect: 'In progress' },
  { name: 'D3 · Driving to Mumbai',             now: '2026-10-19T09:30', loc: at(18.80, 73.30),   expect: 'En route' },
  { name: 'D3 · At Bandra Fort',                now: '2026-10-19T16:45', loc: stop(3, 6),         expect: 'On track' },
  { name: 'D4 · Wrapping up at Juhu',           now: '2026-10-20T17:30', loc: stop(4, 1),         expect: 'Leave in' },
  { name: 'D4 · Still at Juhu, too late',       now: '2026-10-20T18:00', loc: stop(4, 1),         expect: 'Leave now' },
  { name: 'D4 · At LTT before the train',       now: '2026-10-20T18:45', loc: stop(4, 7),         expect: 'At the station' },
  { name: 'After the trip',                     now: '2026-10-21T09:00', loc: null,               expect: 'Complete' },
];

/* ---------- helpers ---------- */
const istInput = (d) => clock.inputValue(d);
const parseIST = (s) => clock.parseInput(s);
const fmtClock = (d) => clock.fmtClock(d);
const dayLabel = (d) => clock.fmtDay(d);

function setLocation(mode, pos) {
  sim.follow = mode === 'follow';
  if (mode === 'gps') {
    state.pos = null; state.posSource = null; state.loc = 'idle';
    startWatch();
  } else {
    stopWatch();
    state.pos = mode === 'fixed' ? { ...pos, accuracy: 25 } : null;
    state.posSource = mode === 'none' ? null : 'sim';
    state.loc = mode === 'none' ? 'idle' : 'on';
    if (sim.follow) state.pos = scheduledPosition(now());
  }
}

function syncUrl() {
  const q = new URLSearchParams({ test: '1', now: istInput(now()) });
  if (new URLSearchParams(location.search).has('emulator')) q.set('emulator', '1');
  if (sim.speed !== 1) q.set('speed', sim.speed);
  if (sim.follow) q.set('follow', '1');
  else if (state.posSource === 'sim' && state.pos) { q.set('lat', state.pos.lat.toFixed(5)); q.set('lng', state.pos.lng.toFixed(5)); }
  history.replaceState(null, '', `?${q}${location.hash}`);
}

function update() {
  state.selectedDay = null; // re-pick today's tab
  state.selectedStop = null;
  refitMap();
  render();
  syncUrl();
  paint();
}

/* ---------- UI ---------- */
const CSS = `
.tk-fab { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 1000;
  background: #6b3fa0; color: #fff; border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700;
  box-shadow: 0 4px 16px rgba(0,0,0,.3); cursor: pointer; }
.tk { position: fixed; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom)); z-index: 1000; width: 340px;
  max-width: calc(100vw - 32px); max-height: min(78vh, 680px); overflow: auto; background: var(--surface);
  color: var(--ink); border: 2px solid #6b3fa0; border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.35); font-size: 13px; }
.tk-h { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center; padding: 10px 12px;
  background: #6b3fa0; color: #fff; font-weight: 700; z-index: 1; }
.tk-h button { background: none; border: 0; color: #fff; font-size: 18px; cursor: pointer; line-height: 1; }
.tk-s { padding: 10px 12px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
.tk-s:last-child { border-bottom: 0; }
.tk-l { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.tk-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tk input, .tk select { font: inherit; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 8px; padding: 6px 8px; min-width: 0; flex: 1; }
.tk button.b { font: inherit; background: var(--surface-2); color: var(--ink); border: 1px solid var(--line);
  border-radius: 8px; padding: 5px 9px; cursor: pointer; }
.tk button.b:hover { border-color: #6b3fa0; }
.tk button.b.on { background: #6b3fa0; color: #fff; border-color: #6b3fa0; }
.tk button.b.primary { background: #6b3fa0; color: #fff; border-color: #6b3fa0; font-weight: 700; }
.tk-clock { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tk-list { display: grid; gap: 4px; }
.tk-sc { display: grid; grid-template-columns: 18px 1fr auto; gap: 6px; align-items: center; text-align: left;
  font: inherit; color: var(--ink); background: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 6px; cursor: pointer; }
.tk-sc:hover { background: var(--surface-2); border-color: var(--line); }
.tk-sc .r { font-size: 11px; color: var(--muted); white-space: nowrap; }
.tk-sc .pass { color: var(--ok); font-weight: 700; }
.tk-sc .fail { color: var(--bad); font-weight: 700; }
.tk-sum { font-weight: 700; }
.tk-hint { color: var(--muted); font-size: 12px; }
.tk-pick { cursor: crosshair !important; }
`;

let root, fab, banner, pickMode = false, results = null, visible = true, minimised = false;

export function show(on) {
  visible = on;
  if (!root) return;
  root.hidden = !on || minimised;
  fab.hidden = !on || !minimised;
  banner.hidden = !on;
  if (on) { buildDynamic(); paint(); }
}

export function mount() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  banner = document.getElementById('sim-banner');
  banner.hidden = false;

  fab = document.createElement('button');
  fab.className = 'tk-fab';
  fab.textContent = 'Test panel';
  fab.hidden = true;
  fab.onclick = () => { minimised = false; show(visible); };

  root = document.createElement('div');
  root.className = 'tk';
  root.innerHTML = `
    <div class="tk-h"><span>Test panel</span><button type="button" data-a="close" aria-label="Minimise">–</button></div>

    <div class="tk-s">
      <div class="tk-l" id="tk-time-label">Time</div>
      <div class="tk-row"><span class="tk-clock" id="tk-clock"></span></div>
      <div class="tk-row"><input type="datetime-local" id="tk-time" step="60"></div>
      <div class="tk-row">
        <button class="b" data-shift="-60">−1h</button><button class="b" data-shift="-15">−15m</button>
        <button class="b" data-shift="15">+15m</button><button class="b" data-shift="60">+1h</button>
        <button class="b" data-a="next">Next stop ⏭</button>
      </div>
      <div class="tk-row" id="tk-days"></div>
      <div class="tk-row"><span class="tk-l" style="margin-right:4px">Speed</span><span id="tk-speeds" class="tk-row"></span>
        <button class="b" data-a="pause" id="tk-pause"></button></div>
    </div>

    <div class="tk-s">
      <div class="tk-l">Location</div>
      <div class="tk-row"><select id="tk-loc"></select></div>
      <div class="tk-row"><button class="b" data-a="pick" id="tk-pick">Click map to place me</button></div>
      <div class="tk-hint">“Follow schedule” moves you along the plan — pair it with 60× or 300× to watch a whole day play out.</div>
    </div>

    <div class="tk-s" id="tk-scen">
      <div class="tk-row" style="justify-content:space-between">
        <span class="tk-l">Scenarios (Mumbai trip)</span>
        <button class="b primary" data-a="run">Run all checks</button>
      </div>
      <div class="tk-sum" id="tk-sum"></div>
      <div class="tk-list" id="tk-list"></div>
    </div>

    <div class="tk-s">
      <div class="tk-row">
        <button class="b" data-a="realtime">Real time</button>
        <button class="b" data-a="cleardone">Clear done/skip marks</button>
        <a class="b" href="./" style="text-decoration:none;color:inherit;border:1px solid var(--line);border-radius:8px;padding:5px 9px">Exit test mode</a>
      </div>
    </div>`;
  document.body.append(root, fab);

  // Speed buttons
  root.querySelector('#tk-speeds').innerHTML = SPEEDS.map((s) => `<button class="b" data-speed="${s}">${s}×</button>`).join('');
  buildDynamic();
  renderScenarioList();
  wire();
  paint();
  setInterval(paint, 500);
}

// Parts of the panel that depend on which trip is open.
let builtFor = null;
function buildDynamic() {
  if (!TRIP || builtFor === TRIP) return;
  builtFor = TRIP;
  root.querySelector('#tk-time-label').textContent = `Time (${clock.label})`;
  root.querySelector('#tk-scen').hidden = TRIP.id !== SCENARIO_TRIP;
  // Day jump buttons
  root.querySelector('#tk-days').innerHTML = `<span class="tk-l" style="margin-right:4px">Jump</span>` +
    DAYS.map((d) => `<button class="b" data-day-jump="${d.n}">Day ${d.n}</button>`).join('');
  // Location options
  const opts = DAYS.map((d) => {
    const seen = new Set();
    const items = d.stops.filter((s) => { const k = `${s.place.lat},${s.place.lng}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((s) => `<option value="p:${d.n}:${s.idx}">${esc(s.place.name)}</option>`).join('');
    return `<optgroup label="Day ${d.n}">${items}</optgroup>`;
  }).join('');
  root.querySelector('#tk-loc').innerHTML = `
    <option value="follow">Follow schedule (auto)</option>
    <option value="none">Location off</option>
    <option value="gps">Real GPS</option>
    <option value="custom" disabled>Custom point</option>${opts}`;

}

function wire() {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.shift) { setSimTime(now().getTime() + Number(b.dataset.shift) * 60000); return update(); }
    if (b.dataset.speed) { setSimTime(now()); sim.speed = Number(b.dataset.speed); return update(); }
    if (b.dataset.dayJump) { const d = DAYS[b.dataset.dayJump - 1]; setSimTime(d.startAt.getTime() - 15 * 60000); return update(); }
    if (b.dataset.scenario) return loadScenario(SCENARIOS[b.dataset.scenario]);
    switch (b.dataset.a) {
      case 'close': minimised = true; show(visible); break;
      case 'pause': setSimTime(now()); sim.paused = !sim.paused; update(); break;
      case 'next': {
        const t = now();
        const nx = DAYS.flatMap((d) => d.stops).find((s) => s.startAt > t);
        if (nx) { setSimTime(nx.startAt.getTime() + 60000); update(); }
        break;
      }
      case 'pick': setPick(!pickMode); break;
      case 'run': runChecks(); break;
      case 'realtime': sim.base = null; sim.speed = 1; sim.paused = false; update(); break;
      case 'cleardone': state.done.clear(); try { localStorage.removeItem(`mlt-done-${TRIP.id}`); } catch { /* ignore */ } update(); break;
    }
  });

  root.querySelector('#tk-time').addEventListener('change', (e) => {
    if (!e.target.value) return;
    setSimTime(parseIST(e.target.value));
    update();
  });

  root.querySelector('#tk-loc').addEventListener('change', (e) => {
    const v = e.target.value;
    if (v.startsWith('p:')) {
      const [, d, i] = v.split(':').map(Number);
      setLocation('fixed', DAYS[d - 1].stops[i].place);
    } else setLocation(v);
    update();
  });

  const map = getMap();
  if (map) {
    map.on('click', (e) => {
      if (!pickMode) return;
      setLocation('fixed', { lat: e.latlng.lat, lng: e.latlng.lng });
      setPick(false);
      render(); syncUrl(); paint();
    });
  }
}

function setPick(on) {
  pickMode = on;
  document.getElementById('map').classList.toggle('tk-pick', on);
  paint();
}

function loadScenario(sc) {
  setSimTime(parseIST(sc.now));
  sim.paused = true;
  if (sc.loc) setLocation('fixed', locOf(sc)); else setLocation('none');
  update();
}

/* ---------- checks ---------- */
function runChecks() {
  const savedDone = state.done;
  state.done = new Set(); // checks assume nothing has been skipped
  try {
    results = SCENARIOS.map((sc) => {
      const pos = sc.loc ? { ...locOf(sc), accuracy: 25 } : null;
      const got = computeStatus(parseIST(sc.now), pos).pill.text;
      return { ...sc, got, pass: got.startsWith(sc.expect) };
    });
  } finally {
    state.done = savedDone;
  }
  console.table(results.map((r) => ({ scenario: r.name, expected: r.expect, got: r.got, pass: r.pass })));
  renderScenarioList();
}

function renderScenarioList() {
  const list = root.querySelector('#tk-list');
  list.innerHTML = SCENARIOS.map((sc, i) => {
    const r = results?.[i];
    const mark = r ? (r.pass ? '<span class="pass">✓</span>' : '<span class="fail">✗</span>') : '<span style="color:var(--faint)">•</span>';
    const right = r ? (r.pass ? r.got : `got “${r.got}”, want “${r.expect}”`) : sc.expect;
    return `<button class="tk-sc" type="button" data-scenario="${i}" title="Load this scenario">${mark}<span>${sc.name}</span><span class="r">${right}</span></button>`;
  }).join('');
  const sum = root.querySelector('#tk-sum');
  if (results) {
    const ok = results.filter((r) => r.pass).length;
    sum.innerHTML = `<span class="${ok === results.length ? 'pass' : 'fail'}" style="color:var(${ok === results.length ? '--ok' : '--bad'})">${ok}/${results.length} passed</span>`;
  } else sum.textContent = '';
}

/* ---------- live readouts ---------- */
function paint() {
  if (!TRIP || !visible) return;
  const t = now();
  const real = !sim.base;
  root.querySelector('#tk-clock').textContent = `${dayLabel(t)} · ${fmtClock(t)}${real ? ' (real time)' : ''}`;
  const ti = root.querySelector('#tk-time');
  if (document.activeElement !== ti) ti.value = istInput(t);
  root.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === sim.speed && !real));
  const pb = root.querySelector('#tk-pause');
  pb.textContent = sim.paused ? '▶ Play' : '⏸ Pause';
  pb.disabled = real;
  root.querySelector('#tk-pick').classList.toggle('on', pickMode);
  root.querySelector('#tk-pick').textContent = pickMode ? 'Now click the map…' : 'Click map to place me';

  const sel = root.querySelector('#tk-loc');
  if (document.activeElement !== sel) {
    if (sim.follow) sel.value = 'follow';
    else if (state.posSource === 'gps' || state.watchId != null) sel.value = 'gps';
    else if (!state.pos) sel.value = 'none';
    else {
      const match = [...sel.querySelectorAll('option[value^="p:"]')].find((o) => {
        const [, d, i] = o.value.split(':').map(Number);
        const p = DAYS[d - 1].stops[i].place;
        return Math.abs(p.lat - state.pos.lat) < 1e-5 && Math.abs(p.lng - state.pos.lng) < 1e-5;
      });
      sel.value = match ? match.value : 'custom';
    }
  }

  const locTxt = sim.follow ? 'following schedule' : state.posSource === 'sim' ? 'simulated location' : state.posSource === 'gps' ? 'real GPS' : 'no location';
  banner.textContent = `Test mode · ${dayLabel(t)} ${fmtClock(t)} ${clock.label}${real ? ' (real)' : ''}${sim.speed !== 1 && !real ? ` · ${sim.speed}×` : ''}${sim.paused ? ' · paused' : ''} · ${locTxt}`;
}
