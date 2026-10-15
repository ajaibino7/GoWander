// Test panel — loaded only in test mode (?test). Lets you jump/fast-forward time, move your
// location, and run every key scenario in one go. Shown while a trip is open.
import { useEffect, useRef, useState } from 'react';
import '../styles/testkit.css';
import {
  clearDone, computeStatus, live, now, refitMap, setSimLocation, setSimTime, sim, useLive,
} from '../lib/live';
import type { LatLng } from '../lib/types';

// The scenario checks are written against the bundled Mumbai trip.
const SCENARIO_TRIP = 'mumbai-lonavala-2026';

const SPEEDS = [1, 10, 60, 300];
type Loc = { ref: [number, number] } | LatLng;
const stop = (d: number, i: number): Loc => ({ ref: [d, i] }); // resolved against the open trip when used
const at = (lat: number, lng: number): Loc => ({ lat, lng });
function locOf(loc: Loc): LatLng {
  if ('ref' in loc) {
    const p = live.days[loc.ref[0] - 1]?.stops[loc.ref[1]]?.place;
    if (!p) throw new Error(`No stop ${loc.ref.join('.')} in this trip`);
    return { lat: p.lat, lng: p.lng };
  }
  return loc;
}

interface Scenario { name: string; now: string; loc: Loc | null; expect: string }
// Each scenario: a time, a location (null = location off), and the headline pill we expect.
// `expect` is matched as a prefix, so 'Leave in' matches 'Leave in 4 min'.
const SCENARIOS: Scenario[] = [
  { name: 'Before the trip', now: '2026-10-16T20:00', loc: null, expect: 'Countdown' },
  { name: 'D1 · At CSMT on time', now: '2026-10-17T14:10', loc: stop(1, 2), expect: 'On track' },
  { name: 'D1 · Still at Colaba Causeway, late', now: '2026-10-17T17:20', loc: stop(1, 5), expect: 'Running behind' },
  { name: 'D1 · Marine Drive at night', now: '2026-10-17T20:30', loc: stop(1, 8), expect: 'On track' },
  { name: 'D1 · Day over', now: '2026-10-17T23:45', loc: null, expect: 'Rest up' },
  { name: 'D2 · Reaching Khandala', now: '2026-10-18T08:00', loc: at(18.7548, 73.3767), expect: 'On track' },
  { name: "D2 · At Tiger Point during Lion's", now: '2026-10-18T11:10', loc: stop(2, 4), expect: 'Ahead' },
  { name: 'D2 · At Tiger Point', now: '2026-10-18T12:20', loc: stop(2, 4), expect: 'On track' },
  { name: 'D2 · Location off', now: '2026-10-18T12:20', loc: null, expect: 'In progress' },
  { name: 'D3 · Driving to Mumbai', now: '2026-10-19T09:30', loc: at(18.80, 73.30), expect: 'En route' },
  { name: 'D3 · At Bandra Fort', now: '2026-10-19T16:45', loc: stop(3, 6), expect: 'On track' },
  { name: 'D4 · Wrapping up at Juhu', now: '2026-10-20T17:30', loc: stop(4, 1), expect: 'Leave in' },
  { name: 'D4 · Still at Juhu, too late', now: '2026-10-20T18:00', loc: stop(4, 1), expect: 'Leave now' },
  { name: 'D4 · At LTT before the train', now: '2026-10-20T18:45', loc: stop(4, 7), expect: 'At the station' },
  { name: 'After the trip', now: '2026-10-21T09:00', loc: null, expect: 'Complete' },
];
interface Result extends Scenario { got: string; pass: boolean }

function syncUrl(): void {
  const q = new URLSearchParams({ test: '1', now: live.clock.inputValue(now()) });
  if (new URLSearchParams(location.search).has('emulator')) q.set('emulator', '1');
  if (sim.speed !== 1) q.set('speed', String(sim.speed));
  if (sim.follow) q.set('follow', '1');
  else if (live.posSource === 'sim' && live.pos) { q.set('lat', live.pos.lat.toFixed(5)); q.set('lng', live.pos.lng.toFixed(5)); }
  history.replaceState(history.state, '', `?${q}${location.hash}`);
}

function update(): void {
  live.selectedDay = null; // re-pick today's tab
  live.selectedStop = null;
  syncUrl();
  refitMap(); // re-renders everything
}

function runChecks(): Result[] {
  const savedDone = live.done;
  live.done = new Set(); // checks assume nothing has been skipped
  try {
    const results = SCENARIOS.map((sc) => {
      const pos = sc.loc ? { ...locOf(sc.loc), accuracy: 25 } : null;
      const got = computeStatus(live.clock.parseInput(sc.now), pos).pill.text;
      return { ...sc, got, pass: got.startsWith(sc.expect) };
    });
    console.table(results.map((r) => ({ scenario: r.name, expected: r.expect, got: r.got, pass: r.pass })));
    return results;
  } finally {
    live.done = savedDone;
  }
}

/** The purple strip at the top: what time and place the app thinks it is. */
export function SimBanner() {
  useLive();
  if (!live.trip) return null;
  const t = now();
  const real = !sim.base;
  const locTxt = sim.follow ? 'following schedule' : live.posSource === 'sim' ? 'simulated location' : live.posSource === 'gps' ? 'real GPS' : 'no location';
  return (
    <div className="sim-banner">
      {`Test mode · ${live.clock.fmtDay(t)} ${live.clock.fmtClock(t)} ${live.clock.label}${real ? ' (real)' : ''}${sim.speed !== 1 && !real ? ` · ${sim.speed}×` : ''}${sim.paused ? ' · paused' : ''} · ${locTxt}`}
    </div>
  );
}

export default function TestKit() {
  useLive();
  const [minimised, setMinimised] = useState(false);
  const [pick, setPick] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const timeInput = useRef<HTMLInputElement>(null);
  const locSelect = useRef<HTMLSelectElement>(null);
  const trip = live.trip;
  const map = live.map;
  const t = now();
  const real = !sim.base;

  // "Click map to place me".
  useEffect(() => {
    if (!map) return undefined;
    const onClick = (e: import('leaflet').LeafletMouseEvent) => {
      if (!pickRef.current) return;
      setSimLocation('fixed', { lat: e.latlng.lat, lng: e.latlng.lng });
      setPick(false);
      syncUrl();
      refitMap();
    };
    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, [map]);
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    document.getElementById('map')?.classList.toggle('tk-pick', pick);
  }, [pick, map]);
  useEffect(() => { setPick(false); setResults(null); }, [trip?.id]);

  // Keep the time box and location picker in step with the clock, unless you're using them.
  const locValue = (() => {
    if (sim.follow) return 'follow';
    if (live.posSource === 'gps' || live.watchId != null) return 'gps';
    if (!live.pos) return 'none';
    for (const d of live.days) {
      for (const s of d.stops) {
        if (Math.abs(s.place.lat - live.pos.lat) < 1e-5 && Math.abs(s.place.lng - live.pos.lng) < 1e-5) return `p:${d.n}:${s.idx}`;
      }
    }
    return 'custom';
  })();
  useEffect(() => {
    const ti = timeInput.current;
    if (ti && document.activeElement !== ti) ti.value = live.clock.inputValue(t);
    const sel = locSelect.current;
    if (sel && document.activeElement !== sel) {
      sel.value = locValue;
      // A stop shared by several days is listed once: fall back to its first listing.
      if (sel.value !== locValue) sel.value = 'custom';
    }
  });

  if (!trip) return null;
  if (minimised) return <button className="tk-fab" type="button" onClick={() => setMinimised(false)}>Test panel</button>;

  const shift = (min: number) => { setSimTime(now().getTime() + min * 60000); update(); };
  const loadScenario = (sc: Scenario) => {
    setSimTime(live.clock.parseInput(sc.now));
    sim.paused = true;
    if (sc.loc) setSimLocation('fixed', locOf(sc.loc)); else setSimLocation('none');
    update();
  };
  const ok = results ? results.filter((r) => r.pass).length : 0;

  return (
    <div className="tk">
      <div className="tk-h"><span>Test panel</span><button type="button" aria-label="Minimise" onClick={() => setMinimised(true)}>–</button></div>

      <div className="tk-s">
        <div className="tk-l">Time ({live.clock.label})</div>
        <div className="tk-row"><span className="tk-clock">{`${live.clock.fmtDay(t)} · ${live.clock.fmtClock(t)}${real ? ' (real time)' : ''}`}</span></div>
        <div className="tk-row">
          <input ref={timeInput} type="datetime-local" step={60} onChange={(e) => {
            if (!e.target.value) return;
            setSimTime(live.clock.parseInput(e.target.value));
            update();
          }} />
        </div>
        <div className="tk-row">
          <button className="b" type="button" onClick={() => shift(-60)}>−1h</button>
          <button className="b" type="button" onClick={() => shift(-15)}>−15m</button>
          <button className="b" type="button" onClick={() => shift(15)}>+15m</button>
          <button className="b" type="button" onClick={() => shift(60)}>+1h</button>
          <button className="b" type="button" onClick={() => {
            const nx = live.days.flatMap((d) => d.stops).find((s) => s.startAt > now());
            if (nx) { setSimTime(nx.startAt.getTime() + 60000); update(); }
          }}>Next stop ⏭</button>
        </div>
        <div className="tk-row">
          <span className="tk-l" style={{ marginRight: 4 }}>Jump</span>
          {live.days.map((d) => (
            <button key={d.n} className="b" type="button" onClick={() => { setSimTime((d.startAt?.getTime() ?? now().getTime()) - 15 * 60000); update(); }}>Day {d.n}</button>
          ))}
        </div>
        <div className="tk-row">
          <span className="tk-l" style={{ marginRight: 4 }}>Speed</span>
          <span className="tk-row">
            {SPEEDS.map((s) => (
              <button key={s} className={`b${s === sim.speed && !real ? ' on' : ''}`} type="button" onClick={() => { setSimTime(now()); sim.speed = s; update(); }}>{s}×</button>
            ))}
          </span>
          <button className="b" type="button" disabled={real} onClick={() => { setSimTime(now()); sim.paused = !sim.paused; update(); }}>{sim.paused ? '▶ Play' : '⏸ Pause'}</button>
        </div>
      </div>

      <div className="tk-s">
        <div className="tk-l">Location</div>
        <div className="tk-row">
          <select ref={locSelect} defaultValue={locValue} onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('p:')) {
              const [, d, i] = v.split(':').map(Number) as [number, number, number];
              const p = live.days[d - 1]?.stops[i]?.place;
              if (p) setSimLocation('fixed', p);
            } else setSimLocation(v as 'follow' | 'gps' | 'none');
            update();
          }}>
            <option value="follow">Follow schedule (auto)</option>
            <option value="none">Location off</option>
            <option value="gps">Real GPS</option>
            <option value="custom" disabled>Custom point</option>
            {live.days.map((d) => {
              const seen = new Set<string>();
              return (
                <optgroup key={d.n} label={`Day ${d.n}`}>
                  {d.stops.filter((s) => { const k = `${s.place.lat},${s.place.lng}`; if (seen.has(k)) return false; seen.add(k); return true; })
                    .map((s) => <option key={s.idx} value={`p:${d.n}:${s.idx}`}>{s.place.name}</option>)}
                </optgroup>
              );
            })}
          </select>
        </div>
        <div className="tk-row">
          <button className={`b${pick ? ' on' : ''}`} type="button" onClick={() => setPick(!pick)}>{pick ? 'Now click the map…' : 'Click map to place me'}</button>
        </div>
        <div className="tk-hint">“Follow schedule” moves you along the plan — pair it with 60× or 300× to watch a whole day play out.</div>
      </div>

      {trip.id === SCENARIO_TRIP ? (
        <div className="tk-s">
          <div className="tk-row" style={{ justifyContent: 'space-between' }}>
            <span className="tk-l">Scenarios (Mumbai trip)</span>
            <button className="b primary" type="button" onClick={() => setResults(runChecks())}>Run all checks</button>
          </div>
          <div className="tk-sum">
            {results ? <span className={ok === results.length ? 'pass' : 'fail'} style={{ color: `var(${ok === results.length ? '--ok' : '--bad'})` }}>{ok}/{results.length} passed</span> : null}
          </div>
          <div className="tk-list">
            {SCENARIOS.map((sc, i) => {
              const r = results?.[i];
              return (
                <button key={sc.name} className="tk-sc" type="button" title="Load this scenario" onClick={() => loadScenario(sc)}>
                  {r ? (r.pass ? <span className="pass">✓</span> : <span className="fail">✗</span>) : <span style={{ color: 'var(--faint)' }}>•</span>}
                  <span>{sc.name}</span>
                  <span className="r">{r ? (r.pass ? r.got : `got “${r.got}”, want “${r.expect}”`) : sc.expect}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="tk-s">
        <div className="tk-row">
          <button className="b" type="button" onClick={() => { sim.base = null; sim.speed = 1; sim.paused = false; update(); }}>Real time</button>
          <button className="b" type="button" onClick={() => clearDone()}>Clear done/skip marks</button>
          <a className="b" href="./" style={{ textDecoration: 'none', color: 'inherit', border: '1px solid var(--line)', borderRadius: 8, padding: '5px 9px' }}>Exit test mode</a>
        </div>
      </div>
    </div>
  );
}
