// #/ideas/:id — the group's "maybe" list: places someone would like to visit. Everyone adds and
// ❤️s ideas; the most loved rise to the top, and anyone who can edit the plan adds one to a day.
import { useEffect, useRef, useState } from 'react';
import { TripSubPage, type TripCtx } from '../app/TripSubPage';
import { useLeaving, useNewItems, useReveal } from '../app/motion';
import { nameOf } from '../app/useTripWatch';
import { Avatars, Icon } from '../components/Icons';
import * as cloud from '../lib/cloud';
import { mapsLink } from '../lib/plan';
import { ask, toast } from '../lib/toast';
import type { Idea, Place, TripEntry, User } from '../lib/types';
import { AddToPlanSheet } from './AddToPlan';
import { PlacePicker } from './editor/PlacePicker';

export function IdeasPage() {
  return (
    <TripSubPage viewId="view-ideas" eyebrow="Ideas board" foot="Shared with everyone on this trip. Changes sync live, and work offline too.">
      {(ctx) => (ctx.entry && ctx.user ? <IdeasBody ctx={ctx} entry={ctx.entry} user={ctx.user} /> : null)}
    </TripSubPage>
  );
}

interface Draft { title: string; note: string; link: string; place: Place | null }
const blank: Draft = { title: '', note: '', link: '', place: null };

function IdeasBody({ ctx, entry, user }: { ctx: TripCtx; entry: TripEntry; user: User }) {
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [planning, setPlanning] = useState<Idea | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined, gone = false;
    cloud.watchIdeas(ctx.id, setIdeas, (e) => toast(e, 'bad')).then((u) => { if (gone) u(); else off = u; });
    return () => { gone = true; off?.(); };
  }, [ctx.id]);
  useReveal(ref, '.idea', !!ideas);
  const isNew = useNewItems(ideas ? ideas.map((x) => x.id) : null);
  const [leaving, leave] = useLeaving();
  useEffect(() => { if (draft) titleRef.current?.focus(); }, [!!draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = [...(ideas || [])].sort((a, b) => b.likes.length - a.likes.length || b.createdMs - a.createdMs);
  const recent = entry.trip.days.flatMap((d) => d.stops.map((s) => s.place));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) { toast('Give the idea a name.', 'bad'); titleRef.current?.focus(); return; }
    const link = draft.link.trim();
    if (link && !/^https?:\/\/\S+$/i.test(link)) { toast('Links start with https://', 'bad'); return; }
    const id = editing;
    setDraft(null);
    setEditing(null);
    try {
      await cloud.saveIdea(user, ctx.id, { title, note: draft.note.trim(), link, place: draft.place }, id);
      toast(id ? 'Idea updated' : `Added “${title}”`, 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); }
  };
  const like = (x: Idea) => cloud.likeIdea(user, ctx.id, x.id, !x.likes.includes(user.email)).catch((e: Error) => toast(e.message, 'bad'));
  const remove = async (x: Idea) => {
    if (!(await ask(`Remove “${x.title}”?`, { ok: 'Remove', danger: true }))) return;
    await leave(x.id, () => cloud.deleteSubDoc(ctx.id, 'ideas', x.id).catch((e: Error) => toast(e.message, 'bad')));
  };

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {draft ? (
        <section className="ed-card">
          <h2 className="sec-h">{editing ? 'Edit idea' : 'New idea'}</h2>
          <form className="form idea-form" noValidate onSubmit={save}>
            <label className="fld"><span>What</span><input ref={titleRef} maxLength={120} placeholder="e.g. Sunset at Chapora Fort" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
            <label className="fld"><span>Why it's worth it <small className="muted">(optional)</small></span><input maxLength={500} placeholder="e.g. Best view in North Goa, go before 6" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></label>
            <div className="grid2">
              <div className="fld"><span>Place <small className="muted">(optional)</small></span>
                <button type="button" className="place-btn" onClick={() => setPicking(true)}>📍 {draft.place ? draft.place.name : 'Choose on map'}</button>
              </div>
              <label className="fld"><span>Link <small className="muted">(optional)</small></span><input type="url" maxLength={500} placeholder="https://…" value={draft.link} onChange={(e) => setDraft({ ...draft, link: e.target.value })} /></label>
            </div>
            <div className="form-acts">
              <button className="btn ghost" type="button" onClick={() => { setDraft(null); setEditing(null); }}>Cancel</button>
              <button className="btn" type="submit">{editing ? 'Save' : 'Add idea'}</button>
            </div>
          </form>
        </section>
      ) : (
        <button className="smart-btn add-big" type="button" onClick={() => setDraft({ ...blank })}>
          <span className="smart-spark" aria-hidden="true">💡</span>
          <span><strong>Add an idea</strong><span className="muted small">A place, food or activity you'd like to try</span></span>
          <span aria-hidden="true"><Icon.plus /></span>
        </button>
      )}

      {ideas && !ideas.length && !draft ? (
        <section className="ed-card empty-card">
          <div className="empty-art" aria-hidden="true">💡</div>
          <strong>Your group's wish list</strong>
          <p className="fine">Drop places you'd like to visit. Everyone can add and ❤️ ideas, and the favourites make it into the plan.</p>
        </section>
      ) : null}

      <div className="idea-list">
        {sorted.map((x, i) => {
          const mine = x.createdBy === user.email;
          const liked = x.likes.includes(user.email);
          return (
            <article key={x.id} className={`idea${isNew(x.id) ? ' fresh' : ''}${leaving.has(x.id) ? ' leaving' : ''}`}>
              {i === 0 && x.likes.length > 1 ? <span className="idea-top">🔥 Group favourite</span> : null}
              <div className="idea-main">
                <h3>{x.title}</h3>
                {x.note ? <p className="idea-note">{x.note}</p> : null}
                <div className="idea-meta">
                  {x.place ? <a className="chip-link" href={mapsLink(x.place)} target="_blank" rel="noopener">📍 {x.place.name}</a> : null}
                  {x.link ? <a className="chip-link" href={x.link} target="_blank" rel="noopener"><Icon.link /> Link</a> : null}
                  <span className="muted small">Added by {nameOf(x.createdBy, user)}</span>
                </div>
              </div>
              <div className="idea-foot">
                <button className={`like-btn${liked ? ' on' : ''}`} type="button" aria-pressed={liked} onClick={() => like(x)}>
                  <Icon.heart /> <span>{x.likes.length || ''}</span>
                </button>
                <Avatars emails={x.likes} />
                <span className="idea-acts">
                  {ctx.canEdit ? <button className="btn small" type="button" onClick={() => setPlanning(x)}>Add to plan</button> : null}
                  {mine ? <button className="icon-link" type="button" title="Edit" aria-label={`Edit ${x.title}`} onClick={() => { setEditing(x.id); setDraft({ title: x.title, note: x.note, link: x.link, place: x.place }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><Icon.edit /></button> : null}
                  {mine || ctx.canEdit ? <button className="icon-link" type="button" title="Remove" aria-label={`Remove ${x.title}`} onClick={() => remove(x)}><Icon.trash /></button> : null}
                </span>
              </div>
            </article>
          );
        })}
      </div>

      {picking && draft ? <PlacePicker place={draft.place} recent={recent} onClose={(p) => { setPicking(false); if (p) setDraft({ ...draft, place: p }); }} /> : null}
      {planning ? (
        <AddToPlanSheet
          entry={entry}
          user={user}
          seed={{ title: planning.title, place: planning.place, note: planning.note || undefined }}
          onClose={() => setPlanning(null)}
          onAdded={() => { const x = planning; cloud.deleteSubDoc(ctx.id, 'ideas', x.id).catch(() => {}); }}
        />
      ) : null}
    </div>
  );
}
