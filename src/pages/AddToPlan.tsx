// "Add to plan": turns an idea or a poll's winner into a stop. Pick the day and time; the place
// comes along (or is chosen here). Saved straight to the trip for everyone.
import { useState } from 'react';
import { savePlanChange } from '../app/planActions';
import { Sheet } from '../components/Sheet';
import { nextSlot, withStop } from '../lib/plan';
import type { Place, StopKind, TripEntry, User } from '../lib/types';
import { KIND_LABELS, fmtHHMM, shortDate } from '../lib/util';
import { PlacePicker } from './editor/PlacePicker';

export interface PlanSeed { title: string; place: Place | null; note?: string; date?: string; kind?: StopKind }

export function AddToPlanSheet({ entry, user, seed, onClose, onAdded }: {
  entry: TripEntry; user: User; seed: PlanSeed; onClose: () => void; onAdded?: (dayN: number) => void;
}) {
  const days = entry.trip.days;
  const firstDate = days.find((d) => d.date === seed.date)?.date || days[0]?.date || '';
  const [date, setDate] = useState(firstDate);
  const slot = nextSlot(days.find((d) => d.date === firstDate));
  const [start, setStart] = useState(slot.start);
  const [end, setEnd] = useState(slot.end);
  const [kind, setKind] = useState<StopKind>(seed.kind || 'stop');
  const [title, setTitle] = useState(seed.title);
  const [place, setPlace] = useState<Place | null>(seed.place);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const recent = days.flatMap((d) => d.stops.map((s) => s.place));

  const pickDay = (d: string) => {
    setDate(d);
    const s = nextSlot(days.find((x) => x.date === d));
    setStart(s.start);
    setEnd(s.end);
  };
  const save = async () => {
    if (!title.trim()) { setErr('Give the stop a name.'); return; }
    if (!place) { setErr('Choose where it is.'); return; }
    if (!start || !end || end < start) { setErr('Check the times: it should end after it starts.'); return; }
    setErr('');
    setSaving(true);
    const n = days.findIndex((d) => d.date === date) + 1;
    try {
      const next = withStop(entry.trip, date, { title: title.trim(), start, end, kind, place, note: seed.note });
      const ok = await savePlanChange(user, entry, next, `Added “${title.trim()}” to Day ${n} at ${fmtHHMM(start)}`);
      if (ok) { onAdded?.(n); onClose(); }
    } catch (e) { setErr((e as Error).message); }
    setSaving(false);
  };

  if (!days.length) {
    return <Sheet title="Add to plan" onClose={onClose}><p className="fine">This trip has no days yet. Add a day in the editor first.</p></Sheet>;
  }
  return (
    <>
      <Sheet
        title="Add to plan"
        onClose={onClose}
        foot={(
          <>
            <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
            <button className="btn" type="button" disabled={saving} onClick={save}>{saving ? 'Adding…' : 'Add stop'}</button>
          </>
        )}
      >
        <label className="fld"><span>Day</span>
          <select value={date} onChange={(e) => pickDay(e.target.value)}>
            {days.map((d, i) => <option key={d.date} value={d.date}>Day {i + 1} · {shortDate(d.date)}{d.title ? ` · ${d.title}` : ''} ({d.stops.length} stops)</option>)}
          </select>
        </label>
        <div className="grid2">
          <label className="fld"><span>Starts</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
          <label className="fld"><span>Ends</span><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        </div>
        <label className="fld"><span>Name</span><input value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} /></label>
        <div className="grid2">
          <label className="fld"><span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as StopKind)}>
              {(Object.entries(KIND_LABELS) as [StopKind, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <div className="fld"><span>Place</span>
            <button type="button" className={`place-btn${place ? '' : ' missing'}`} onClick={() => setPicking(true)}>📍 {place ? place.name : 'Choose place'}</button>
          </div>
        </div>
        {err ? <p className="pp-err">{err}</p> : null}
      </Sheet>
      {picking ? <PlacePicker place={place} recent={recent} onClose={(p) => { setPicking(false); if (p) setPlace(p); }} /> : null}
    </>
  );
}
