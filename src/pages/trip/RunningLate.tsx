// "Running late?": push the rest of today back by 15 min – 2 h. Shows exactly what moves, keeps
// fixed departures where they are, and warns about anything that no longer fits before them.
import { useState } from 'react';
import { savePlanChange } from '../../app/planActions';
import { Sheet } from '../../components/Sheet';
import { live, now, type LiveDay } from '../../lib/live';
import { isFixed, shiftRemaining } from '../../lib/plan';
import { fmtHHMM, toMin } from '../../lib/util';
import type { TripEntry, User } from '../../lib/types';

const DELAYS = [15, 30, 45, 60, 90, 120];
const label = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`);

export function RunningLateSheet({ day, entry, user, onClose }: { day: LiveDay; entry: TripEntry; user: User; onClose: () => void }) {
  const [delay, setDelay] = useState(30);
  const [saving, setSaving] = useState(false);
  const planDay = entry.trip.days.find((d) => d.date === day.date);
  if (!planDay) return null;
  // Now, in the trip's local time — or before the day starts, from its first stop.
  const t = now();
  const today = live.clock.dateKey(t) === day.date;
  const nowMin = today ? toMin(live.clock.inputValue(t).slice(11, 16)) : 0;
  const r = shiftRemaining(planDay.stops, nowMin, delay);
  const before = new Map(planDay.stops.map((s) => [s.id, s]));

  const apply = async () => {
    setSaving(true);
    const next = structuredClone(entry.trip);
    const d = next.days.find((x) => x.date === day.date);
    if (d) d.stops = r.stops.map((s) => structuredClone(s));
    const ok = await savePlanChange(user, entry, next, `Day ${day.n}: the rest of the day moved back ${label(delay)}.`);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Sheet
      title="Running late?"
      onClose={onClose}
      foot={(
        <>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="button" disabled={saving || !r.moved.length} onClick={apply}>{saving ? 'Saving…' : `Move ${r.moved.length} stop${r.moved.length === 1 ? '' : 's'}`}</button>
        </>
      )}
    >
      <p className="fine">Push the rest of Day {day.n} back. Fixed departures stay where they are, and everyone sees the new times.</p>
      <div className="seg" role="radiogroup" aria-label="How late">
        {DELAYS.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={delay === m} className={`seg-b${delay === m ? ' on' : ''}`} onClick={() => setDelay(m)}>+{label(m)}</button>
        ))}
      </div>
      {r.clashes.length ? (
        <div className="status-msg bad">
          {r.clashes.map((c) => <div key={c.stop.id}><strong>{c.stop.title}</strong> would now end at {fmtHHMM(c.stop.end)}, after <strong>{c.fixed.title}</strong> at {fmtHHMM(c.fixed.start)}. Trim or skip something before it.</div>)}
        </div>
      ) : null}
      {r.overflow.length ? <div className="status-msg warn">{r.overflow.map((s) => s.title).join(', ')} would run past midnight (kept to 11:59 PM).</div> : null}
      <ol className="shift-list">
        {r.stops.map((s) => {
          const old = before.get(s.id);
          const moved = old && (old.start !== s.start || old.end !== s.end);
          // Happening now: it keeps its start and just runs longer.
          const longer = moved && old?.start === s.start;
          const fixed = isFixed(s);
          const done = old && toMin(old.end) <= nowMin;
          return (
            <li key={s.id} className={`shift-row${moved ? ' moved' : ''}${done ? ' past' : ''}`}>
              <span className="shift-t">
                {moved && old && !longer ? <s>{fmtHHMM(old.start)}</s> : null}
                <strong>{fmtHHMM(s.start)}</strong>
              </span>
              <span className="shift-title">{s.title}{longer ? <small className="muted"> · now until {fmtHHMM(s.end)}</small> : null}</span>
              <span className="shift-tag">{fixed ? '🔒 Fixed' : longer ? 'Longer' : moved ? `+${label(delay)}` : done ? 'Done' : ''}</span>
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}
