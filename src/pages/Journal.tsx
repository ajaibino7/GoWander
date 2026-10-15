// #/journal/:id — the trip's story: everyone adds memories (a line, a photo, or both) to a day or
// a stop, and they read back as a story, day by day. "Save as PDF" prints it as a keepsake.
import { useEffect, useRef, useState } from 'react';
import { TripSubPage, type TripCtx } from '../app/TripSubPage';
import { useLeaving, useNewItems, useReveal } from '../app/motion';
import { nameOf } from '../app/useTripWatch';
import { Avatars, Icon } from '../components/Icons';
import * as cloud from '../lib/cloud';
import { compressPhoto } from '../lib/editing';
import { ask, toast } from '../lib/toast';
import type { JournalEntry, TripEntry, User } from '../lib/types';
import { fmtHHMM, makeClock, shortDate } from '../lib/util';

export function JournalPage() {
  return (
    <TripSubPage
      viewId="view-journal"
      eyebrow="Trip journal"
      foot="Memories are shared with everyone on this trip."
      actions={() => <button className="hn-btn" type="button" onClick={() => window.print()}>Save as PDF</button>}
    >
      {(ctx) => (ctx.entry && ctx.user ? <JournalBody ctx={ctx} entry={ctx.entry} user={ctx.user} /> : null)}
    </TripSubPage>
  );
}

// Photos already loaded this session, by id.
const photos = new Map<string, string>();
function JournalPhoto({ tripId, id, alt }: { tripId: string; id: string; alt: string }) {
  const [src, setSrc] = useState<string | null | undefined>(photos.get(id));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (src !== undefined || !ref.current) return undefined;
    // Load when it comes near the screen.
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      cloud.getPhoto(tripId, id).then((d) => { if (d) photos.set(id, d); setSrc(d); });
    }, { rootMargin: '400px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [tripId, id, src]);
  return (
    <div ref={ref} className={`j-photo${src ? ' ready' : ''}`}>
      {src ? <img src={src} alt={alt} /> : src === null ? <span className="muted small">Photo not available offline</span> : null}
    </div>
  );
}

interface Draft { dayDate: string; stopId: string; text: string; photo: string | null; editing: string | null; hadPhoto: boolean }

function JournalBody({ ctx, entry, user }: { ctx: TripCtx; entry: TripEntry; user: User }) {
  const trip = entry.trip;
  const [items, setItems] = useState<JournalEntry[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined, gone = false;
    cloud.watchJournal(ctx.id, setItems, (e) => toast(e, 'bad')).then((u) => { if (gone) u(); else off = u; });
    return () => { gone = true; off?.(); };
  }, [ctx.id]);
  useReveal(ref, '.j-entry', !!items);
  const isNew = useNewItems(items ? items.map((x) => x.id) : null);
  const [leaving, leave] = useLeaving();

  // Today's day if the trip is on, else the last day with stops.
  const today = makeClock(trip.timezone).dateKey(new Date());
  const defaultDay = trip.days.find((d) => d.date === today)?.date || (today > (trip.days[trip.days.length - 1]?.date || '') ? trip.days[trip.days.length - 1]?.date : trip.days[0]?.date) || today;
  const start = () => setDraft({ dayDate: defaultDay, stopId: '', text: '', photo: null, editing: null, hadPhoto: false });
  const stopsOf = (date: string) => trip.days.find((d) => d.date === date)?.stops || [];
  const stopTitle = (id: string) => trip.days.flatMap((d) => d.stops).find((s) => s.id === id);

  const pick = async (f: File | undefined) => {
    if (!f || !draft) return;
    try { setDraft({ ...draft, photo: await compressPhoto(f) }); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const text = draft.text.trim();
    const hasPhoto = !!draft.photo || (draft.hadPhoto && draft.photo !== '');
    if (!text && !hasPhoto) { toast('Write something or add a photo.', 'bad'); return; }
    setSaving(true);
    try {
      const id = await cloud.saveJournal(user, ctx.id, { dayDate: draft.dayDate, stopId: draft.stopId, text, hasPhoto }, draft.editing);
      if (draft.photo) { await cloud.setPhoto(user, ctx.id, `j-${id}`, draft.photo); photos.set(`j-${id}`, draft.photo); }
      else if (draft.hadPhoto && draft.photo === '') { await cloud.deletePhoto(ctx.id, `j-${id}`).catch(() => {}); photos.delete(`j-${id}`); }
      toast(draft.editing ? 'Memory updated' : 'Memory added to the journal', 'ok');
      setDraft(null);
    } catch (err) { toast((err as Error).message, 'bad'); }
    setSaving(false);
  };
  const remove = async (x: JournalEntry) => {
    if (!(await ask('Delete this memory?', { detail: x.hasPhoto ? 'Its photo goes too.' : undefined, ok: 'Delete', danger: true }))) return;
    await leave(x.id, async () => {
      try {
        await cloud.deleteSubDoc(ctx.id, 'journal', x.id);
        if (x.hasPhoto) cloud.deletePhoto(ctx.id, `j-${x.id}`).catch(() => {});
      } catch (err) { toast((err as Error).message, 'bad'); }
    });
  };

  const byDay = trip.days.map((d, i) => ({ d, n: i + 1, list: (items || []).filter((x) => x.dayDate === d.date).sort((a, b) => a.createdMs - b.createdMs) }));
  const outside = (items || []).filter((x) => !trip.days.some((d) => d.date === x.dayDate));
  const count = items?.length || 0;

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {draft ? (
        <section className="ed-card no-print">
          <h2 className="sec-h">{draft.editing ? 'Edit memory' : 'Add a memory'}</h2>
          <form className="form j-form" noValidate onSubmit={save}>
            <div className="grid2">
              <label className="fld"><span>Day</span>
                <select value={draft.dayDate} onChange={(e) => setDraft({ ...draft, dayDate: e.target.value, stopId: '' })}>
                  {trip.days.map((d, i) => <option key={d.date} value={d.date}>Day {i + 1} · {shortDate(d.date)}</option>)}
                </select>
              </label>
              <label className="fld"><span>Stop <small className="muted">(optional)</small></span>
                <select value={draft.stopId} onChange={(e) => setDraft({ ...draft, stopId: e.target.value })}>
                  <option value="">The whole day</option>
                  {stopsOf(draft.dayDate).map((s) => <option key={s.id} value={s.id}>{fmtHHMM(s.start)} · {s.title}</option>)}
                </select>
              </label>
            </div>
            <label className="fld"><span>What happened</span>
              <textarea rows={3} maxLength={1000} placeholder="The best moment, a funny story, what to remember…" value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            </label>
            <div className="bill-pick">
              {draft.photo ? <img className="bill-thumb" src={draft.photo} alt="" /> : draft.hadPhoto && draft.photo !== '' ? <span className="muted small">📷 A photo is saved.</span> : null}
              <button className="btn ghost small" type="button" onClick={() => fileRef.current?.click()}><Icon.camera /> {draft.photo || (draft.hadPhoto && draft.photo !== '') ? 'Replace photo' : 'Add a photo'}</button>
              {draft.photo || (draft.hadPhoto && draft.photo !== '') ? <button className="link-btn" type="button" onClick={() => setDraft({ ...draft, photo: draft.hadPhoto ? '' : null })}>Remove</button> : null}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <div className="form-acts">
              <button className="btn ghost" type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn" type="submit" disabled={saving}>{saving ? 'Saving…' : draft.editing ? 'Save' : 'Add to journal'}</button>
            </div>
          </form>
        </section>
      ) : (
        <button className="smart-btn add-big no-print" type="button" onClick={start}>
          <span className="smart-spark" aria-hidden="true">📸</span>
          <span><strong>Add a memory</strong><span className="muted small">A photo and a line about a stop or the day</span></span>
          <span aria-hidden="true"><Icon.plus /></span>
        </button>
      )}

      {items && !count && !draft ? (
        <section className="ed-card empty-card">
          <div className="empty-art" aria-hidden="true">📔</div>
          <strong>Your trip's story starts here</strong>
          <p className="fine">Add photos and moments as you go. Everyone's memories come together, day by day, into a story you can keep as a PDF.</p>
        </section>
      ) : null}

      {byDay.filter((x) => x.list.length).map(({ d, n, list }) => (
        <section key={d.date} className="j-day">
          <div className="j-day-h"><span className="j-day-n">Day {n}</span><span><strong>{d.title || shortDate(d.date)}</strong>{d.title ? <span className="muted small"> · {shortDate(d.date)}</span> : null}</span></div>
          {list.map((x) => {
            const s = x.stopId ? stopTitle(x.stopId) : undefined;
            const mine = x.createdBy === user.email;
            return (
              <article key={x.id} className={`j-entry${isNew(x.id) ? ' fresh' : ''}${leaving.has(x.id) ? ' leaving' : ''}`}>
                {x.hasPhoto ? <JournalPhoto tripId={ctx.id} id={`j-${x.id}`} alt={s?.title || 'Trip photo'} /> : null}
                <div className="j-body">
                  {s ? <span className="j-stop">📍 {s.title}</span> : null}
                  {x.text ? <p className="j-text">{x.text}</p> : null}
                  <div className="j-foot">
                    <Avatars emails={[x.createdBy]} /><span className="muted small">{nameOf(x.createdBy, user)}</span>
                    {mine || entry.meta.ownerUid === user.uid ? (
                      <span className="j-acts no-print">
                        {mine ? <button className="icon-link" type="button" aria-label="Edit memory" onClick={() => { setDraft({ dayDate: x.dayDate, stopId: x.stopId, text: x.text, photo: null, editing: x.id, hadPhoto: x.hasPhoto }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Icon.edit /></button> : null}
                        <button className="icon-link" type="button" aria-label="Delete memory" onClick={() => remove(x)}><Icon.trash /></button>
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ))}
      {outside.length ? <p className="fine">{outside.length} memor{outside.length === 1 ? 'y is' : 'ies are'} on dates no longer in the trip.</p> : null}
    </div>
  );
}
