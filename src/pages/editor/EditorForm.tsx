// The editor form. Works on a draft copy of the trip; nothing is stored until "Save trip".
import { useEffect, useMemo, useRef, useState } from 'react';
import { ask, toast } from '../../lib/toast';
import { KIND_LABELS, NOTE_LABELS, TAG_LABELS, shortDate, weekdayOf } from '../../lib/util';
import { isAutoUrl, smallUrl, type CoverInfo } from '../../lib/autocover';
import {
  blankStop, dateRules, isCoverUrl, moveStopToDay, nextDayDate, prepareCover, sortDraft, swapStops, validateDraft,
} from '../../lib/editing';
import type { DraftStop, DraftTrip, NoteType, Place, StopKind, StopTag } from '../../lib/types';
import { PlacePicker } from './PlacePicker';

const TIMEZONES: string[] = (() => {
  try { return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone'); } catch {
    return ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
  }
})();

export type EditorNotice = { kind: 'saved'; who: string } | { kind: 'deleted' };

interface Props {
  start: DraftTrip;
  /** The dates the trip already had (they stay allowed even once they're in the past). */
  savedDates: string[];
  isNew: boolean;
  canDelete: boolean;
  coverP: Promise<string | null>;
  autoP: Promise<CoverInfo | null>;
  notice: EditorNotice | null;
  onDirty: (dirty: boolean) => void;
  /** Resolves false if the save was cancelled (e.g. after a conflict). */
  onSave: (draft: DraftTrip, cover: string | null | undefined) => Promise<boolean>;
  onCancel: () => void;
  onReload: () => void;
  onDelete: () => void;
  onDuplicate: (copy: DraftTrip) => void;
}

const radiusLabel = (r: number) => (r < 1000 ? `${r} m` : `${r / 1000} km`);
const placeKey = (p: Place) => `${p.lat},${p.lng}`;

export function EditorForm(props: Props) {
  const { isNew, canDelete, notice, onDirty } = props;
  const [draft, setDraft] = useState<DraftTrip>(() => structuredClone(props.start));
  const [errors, setErrors] = useState<string[]>([]);
  const [badStops, setBadStops] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const [picker, setPicker] = useState<{ i: number; j: number } | null>(null);
  // Cover: what the trip has now, the edit (undefined = unchanged, data URL = new, null = back to
  // the default), and the destination photo used when nothing is uploaded.
  const [coverSaved, setCoverSaved] = useState<string | null>(null);
  const [coverEdit, setCoverEdit] = useState<string | null | undefined>(undefined);
  const [coverBusy, setCoverBusy] = useState(false);
  const [auto, setAuto] = useState<CoverInfo | null>(null);
  const coverFile = useRef<HTMLInputElement>(null);
  const [flash, setFlash] = useState<{ id: string; dir?: string; scroll: 'nearest' | 'center'; n: number } | null>(null);
  const [errScroll, setErrScroll] = useState(0);

  useEffect(() => { props.coverP.then((u) => setCoverSaved(isCoverUrl(u) ? u : null)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { props.autoP.then((a) => setAuto(a || null)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setDirty = () => { if (!dirty) { setDirtyState(true); onDirty(true); } };
  const clean = () => { setDirtyState(false); onDirty(false); };
  /** Changes the draft (on a copy) and marks the editor as having unsaved changes. */
  const update = (fn: (d: DraftTrip) => void) => {
    setDraft((prev) => { const next = structuredClone(prev); fn(next); return next; });
    setDirty();
  };

  const rules = useMemo(() => dateRules(props.savedDates, draft.timezone), [props.savedDates, draft.timezone]);

  // Keep a stop that just moved in view and flash it, so it's easy to follow.
  useEffect(() => {
    if (!flash) return;
    const el = document.querySelector<HTMLElement>(`[data-stop-id="${CSS.escape(flash.id)}"]`);
    if (!el) return;
    el.classList.remove('moved');
    void el.offsetWidth; // restart the animation
    el.classList.add('moved');
    el.scrollIntoView({ block: flash.scroll, behavior: 'smooth' });
    if (flash.dir) el.querySelector<HTMLButtonElement>(`[data-dir="${flash.dir}"]:not(:disabled)`)?.focus({ preventScroll: true });
  }, [flash]);
  useEffect(() => { if (errScroll) document.getElementById('ed-errors')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [errScroll]);

  // Distinct places already used in this trip, most recent last — quick picks in the place picker.
  const recentPlaces = (except: Place | null): Place[] => {
    const seen = new Map<string, Place>();
    for (const d of draft.days) for (const s of d.stops) if (s.place) seen.set(placeKey(s.place), s.place);
    return [...seen.values()].filter((p) => !except || placeKey(p) !== placeKey(except)).slice(-8);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validateDraft(draft, rules.pastNotAllowed);
    setErrors(v.errors);
    setBadStops(v.badStops);
    if (v.errors.length) { setErrScroll((n) => n + 1); return; }
    const out = structuredClone(draft);
    sortDraft(out);
    setDraft(out);
    setSaving(true);
    clean();
    try {
      if (!(await props.onSave(out, coverEdit))) setDirty(); // cancelled (e.g. after a conflict)
    } catch (err) {
      setDirty();
      setErrors([(err as Error).message || 'Couldn\'t save.']);
      setErrScroll((n) => n + 1);
    } finally {
      setSaving(false);
    }
  };

  const coverNow = coverEdit === undefined ? coverSaved : coverEdit;
  const hasCover = !!coverNow;
  const autoThumb = auto && isAutoUrl(auto.hero) ? smallUrl(auto.hero) : '';
  const coverLabel = auto ? `Photo of ${auto.place} · ${auto.source}` : 'Default cover';
  const previewUrl = isCoverUrl(coverNow) ? coverNow : autoThumb;
  const tzs = TIMEZONES.includes(draft.timezone) ? TIMEZONES : [draft.timezone, ...TIMEZONES];

  const stopRow = (s: DraftStop, i: number, j: number, count: number) => {
    const setStop = (fn: (st: DraftStop) => void) => update((d) => { const st = d.days[i]?.stops[j]; if (st) fn(st); });
    return (
      <div key={s.id} className={`ed-stop${badStops.has(`${i}.${j}`) ? ' err' : ''}`} data-stop-id={s.id}>
        <div className="ed-row">
          <input type="time" className="t" value={s.start} aria-label="Start time" required onChange={(e) => setStop((st) => { st.start = e.target.value; })} />
          <span className="dash">–</span>
          <input type="time" className="t" value={s.end} aria-label="End time" required onChange={(e) => setStop((st) => { st.end = e.target.value; })} />
          <select value={s.kind} aria-label="Type" onChange={(e) => setStop((st) => { st.kind = e.target.value as StopKind; })}>
            {(Object.entries(KIND_LABELS) as [StopKind, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="ed-move">
            {(['-1', '1'] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                className="icon-btn"
                data-dir={dir}
                title={dir === '-1' ? 'Move earlier' : 'Move later'}
                aria-label={`Move stop ${j + 1} ${dir === '-1' ? 'earlier' : 'later'}`}
                disabled={dir === '-1' ? j === 0 : j === count - 1}
                onClick={() => {
                  const to = j + Number(dir);
                  update((d) => { const day = d.days[i]; if (day) swapStops(day.stops, Math.min(j, to)); });
                  setBadStops(new Set()); // indexes changed; validation runs again on save
                  setFlash((f) => ({ id: s.id, dir, scroll: 'nearest', n: (f?.n || 0) + 1 }));
                }}
              >{dir === '-1' ? '↑' : '↓'}</button>
            ))}
          </span>
          <button type="button" className="icon-btn" title="Remove stop" aria-label="Remove stop" onClick={() => update((d) => { d.days[i]?.stops.splice(j, 1); })}>✕</button>
        </div>
        <input className="title-in" value={s.title} maxLength={160} placeholder="What's the plan? e.g. Sunset at Chapora Fort" aria-label="Stop title" onChange={(e) => setStop((st) => { st.title = e.target.value; })} />
        <input value={s.note || ''} maxLength={300} placeholder="Note (optional)" aria-label="Note" onChange={(e) => setStop((st) => { st.note = e.target.value; })} />
        <div className="ed-row">
          <button type="button" className={`place-btn${s.place ? '' : ' missing'}`} onClick={() => setPicker({ i, j })}>
            📍 {s.place ? <>{s.place.name} <small>· {radiusLabel(s.place.radius)}</small></> : 'Set location'}
          </button>
          <select value={s.tag || ''} aria-label="Label" onChange={(e) => setStop((st) => { if (e.target.value) st.tag = e.target.value as StopTag; else delete st.tag; })}>
            <option value="">No label</option>
            {(Object.entries(TAG_LABELS) as [StopTag, string][]).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {draft.days.length > 1 ? (
            <select
              className="move-day"
              value=""
              aria-label="Move this stop to another day"
              onChange={(e) => {
                if (e.target.value === '') return;
                const k = Number(e.target.value);
                update((d) => { moveStopToDay(d.days, i, j, k); });
                setBadStops(new Set());
                setFlash((f) => ({ id: s.id, scroll: 'center', n: (f?.n || 0) + 1 }));
                toast(`Moved “${s.title || 'stop'}” to Day ${k + 1}. Check its times fit that day.`, 'ok');
              }}
            >
              <option value="">Move to day…</option>
              {draft.days.map((d, k) => (k === i ? null : <option key={k} value={k}>Day {k + 1}{d.date ? ` · ${shortDate(d.date)}` : ''}</option>))}
            </select>
          ) : null}
        </div>
        <label className="chk">
          <input type="checkbox" checked={!!s.departure} onChange={(e) => setStop((st) => { if (e.target.checked) st.departure = { buffer: 60 }; else delete st.departure; })} /> Fixed departure (train, flight, bus) — show a “leave by” countdown
        </label>
        {s.departure ? (
          <label className="chk sub">Be there <input type="number" className="num" min={0} max={360} step={5} value={s.departure.buffer} onChange={(e) => setStop((st) => { st.departure = { buffer: Number(e.target.value) }; })} /> minutes early</label>
        ) : null}
      </div>
    );
  };

  const pickerStop = picker ? draft.days[picker.i]?.stops[picker.j] : undefined;

  return (
    <form className="editor" noValidate onSubmit={submit}>
      {notice ? (
        <div className="ed-notice" role="status">
          {notice.kind === 'deleted' ? 'This trip was just deleted by its owner.' : (
            <>
              <strong>{notice.who}</strong> just saved changes to this trip. Saving now will warn before overwriting.{' '}
              <button type="button" className="mini" onClick={async () => {
                if (dirty && !(await ask('Load the latest version?', { detail: 'Your unsaved edits will be lost.', ok: 'Load latest', danger: true }))) return;
                clean();
                props.onReload();
              }}>Load their version</button>
            </>
          )}
        </div>
      ) : null}
      {errors.length ? (
        <div className="ed-errors" id="ed-errors" role="alert"><strong>Fix these before saving:</strong><ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
      ) : null}

      <section className="ed-card">
        <label className="fld"><span>Trip name</span><input value={draft.title} maxLength={120} placeholder="e.g. Goa long weekend" required onChange={(e) => update((d) => { d.title = e.target.value; })} /></label>
        <label className="fld"><span>Short description</span><input value={draft.subtitle || ''} maxLength={300} placeholder="Optional one-liner shown on the trip card" onChange={(e) => update((d) => { d.subtitle = e.target.value; })} /></label>
        <div className="fld cover-fld">
          <span>Cover image (optional)</span>
          <div className="cover-pick">
            <div className={`cover-prev${hasCover || auto ? ' has' : ''}`} role="img" aria-label={hasCover ? 'Cover image preview' : coverLabel} style={previewUrl ? { backgroundImage: `url("${previewUrl}")` } : undefined}>
              {hasCover ? null : <span>{coverLabel}</span>}
            </div>
            <div className="cover-actions">
              <button type="button" className="btn ghost small" disabled={coverBusy} onClick={() => coverFile.current?.click()}>{coverBusy ? 'Preparing…' : hasCover ? 'Change image' : 'Upload image'}</button>
              {hasCover ? <button type="button" className="btn ghost small" onClick={() => { setCoverEdit(null); setDirty(); }}>{auto ? 'Use destination photo' : 'Use default'}</button> : null}
            </div>
          </div>
          <small>JPG, PNG or WebP, up to 500 KB. Bigger photos are shrunk to fit automatically. Without an upload, the trip shows a photo of its main destination.</small>
          <input
            ref={coverFile}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setCoverBusy(true);
              try { setCoverEdit(await prepareCover(file)); setDirty(); } catch (err) { toast((err as Error).message, 'bad'); }
              setCoverBusy(false);
            }}
          />
        </div>
        <label className="fld"><span>Destination timezone</span>
          <select value={draft.timezone} onChange={(e) => update((d) => { d.timezone = e.target.value; })}>
            {tzs.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
          <small>All times you enter are local times at the destination.</small>
        </label>
      </section>

      {draft.days.map((d, i) => (
        <section className="ed-day" key={i}>
          <div className="ed-day-h">
            <strong>Day {i + 1}</strong>
            <span className="muted">{d.date ? weekdayOf(d.date) : ''}</span>
            <button type="button" className="icon-btn" title="Remove day" aria-label={`Remove day ${i + 1}`} onClick={async () => {
              if (d.stops.length && !(await ask(`Remove Day ${i + 1}?`, { detail: `Its ${d.stops.length} stop(s) will be removed too.`, ok: 'Remove day', danger: true }))) return;
              update((x) => { x.days.splice(i, 1); });
            }}>✕</button>
          </div>
          <div className="grid2">
            <label className="fld"><span>Date</span><input type="date" value={d.date} min={rules.minDate(d.date)} required onChange={(e) => update((x) => { const day = x.days[i]; if (day) day.date = e.target.value; })} /></label>
            <label className="fld"><span>Day title</span><input value={d.title} maxLength={160} placeholder="e.g. North Goa beaches" onChange={(e) => update((x) => { const day = x.days[i]; if (day) day.title = e.target.value; })} /></label>
          </div>
          <div className="ed-stops">
            {d.stops.length ? d.stops.map((s, j) => stopRow(s, i, j, d.stops.length)) : <div className="muted small">No stops yet.</div>}
          </div>
          <button type="button" className="btn ghost small" onClick={() => update((x) => {
            const stops = x.days[i]?.stops;
            if (stops) stops.push(blankStop(stops.length ? stops[stops.length - 1]?.end : '09:00'));
          })}>+ Add stop</button>
          <details className="ed-notes" open={d.notes.length > 0 || undefined}>
            <summary>Notes &amp; tips ({d.notes.length})</summary>
            {d.notes.map((n, k) => (
              <div className="ed-note" key={k}>
                <div className="ed-row">
                  <select value={n.type} aria-label="Note type" onChange={(e) => update((x) => { const note = x.days[i]?.notes[k]; if (note) note.type = e.target.value as NoteType; })}>
                    {(Object.entries(NOTE_LABELS) as [NoteType, string][]).map(([t, v]) => <option key={t} value={t}>{v}</option>)}
                  </select>
                  <input value={n.title} maxLength={60} placeholder="Heading, e.g. Don't miss" aria-label="Note heading" onChange={(e) => update((x) => { const note = x.days[i]?.notes[k]; if (note) note.title = e.target.value; })} />
                  <button type="button" className="icon-btn" title="Remove note" aria-label="Remove note" onClick={() => update((x) => { x.days[i]?.notes.splice(k, 1); })}>✕</button>
                </div>
                <textarea rows={2} maxLength={600} placeholder="Tip or reminder for this day" aria-label="Note text" value={n.text} onChange={(e) => update((x) => { const note = x.days[i]?.notes[k]; if (note) note.text = e.target.value; })} />
              </div>
            ))}
            <button type="button" className="btn ghost small" onClick={() => update((x) => { x.days[i]?.notes.push({ type: 'tip', title: '', text: '' }); })}>+ Add note</button>
          </details>
        </section>
      ))}
      <button type="button" className="btn ghost wide" onClick={() => update((x) => { x.days.push({ date: nextDayDate(x.days, x.timezone), title: '', stops: [], notes: [] }); })}>+ Add day</button>

      {isNew ? null : (
        <section className="ed-card ed-more">
          <button type="button" className="btn ghost small" onClick={() => props.onDuplicate(structuredClone(draft))}>Duplicate trip</button>
          {canDelete ? (
            <button type="button" className="btn ghost small danger" onClick={async () => {
              if (!(await ask(`Delete “${draft.title || 'this trip'}”?`, { detail: 'It\'s deleted for everyone and members lose access. This can\'t be undone.', ok: 'Delete trip', danger: true }))) return;
              clean();
              props.onDelete();
            }}>Delete trip</button>
          ) : null}
        </section>
      )}

      <div className="ed-bar">
        <button type="button" className="btn ghost" onClick={async () => {
          if (dirty && !(await ask('Discard your unsaved changes?', { ok: 'Discard', cancel: 'Keep editing', danger: true }))) return;
          clean();
          props.onCancel();
        }}>Cancel</button>
        <button type="submit" className="btn" disabled={saving}>Save trip</button>
      </div>

      {picker && pickerStop ? (
        <PlacePicker
          place={pickerStop.place}
          recent={recentPlaces(pickerStop.place)}
          onClose={(place) => {
            const at = picker;
            setPicker(null);
            if (!place) return;
            update((x) => { const st = x.days[at.i]?.stops[at.j]; if (st) st.place = place; });
            setBadStops((b) => { const n = new Set(b); n.delete(`${at.i}.${at.j}`); return n; });
          }}
        />
      ) : null}
    </form>
  );
}
