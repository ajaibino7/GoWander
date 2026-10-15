// #/polls/:id — quick group decisions: "Dinner: Thalassa or Fisherman's Wharf?" Anyone starts a
// poll and votes (tap again to take it back); results update live. The person who started it, or
// anyone who can edit the plan, closes it — and editors add the winner to a day.
import { useEffect, useRef, useState } from 'react';
import { TripSubPage, type TripCtx } from '../app/TripSubPage';
import { useLeaving, useNewItems, useReveal } from '../app/motion';
import { nameOf } from '../app/useTripWatch';
import { Avatars, Icon } from '../components/Icons';
import * as cloud from '../lib/cloud';
import { ask, toast } from '../lib/toast';
import type { Place, Poll, PollOption, TripEntry, User } from '../lib/types';
import { shortDate } from '../lib/util';
import { AddToPlanSheet, type PlanSeed } from './AddToPlan';
import { PlacePicker } from './editor/PlacePicker';

export function PollsPage() {
  return (
    <TripSubPage viewId="view-polls" eyebrow="Group polls" foot="Everyone on the trip can vote. Results update live.">
      {(ctx) => (ctx.entry && ctx.user ? <PollsBody ctx={ctx} entry={ctx.entry} user={ctx.user} /> : null)}
    </TripSubPage>
  );
}

const optId = () => Math.random().toString(36).slice(2, 8);
interface Draft { question: string; dayDate: string; options: PollOption[] }

/** The leading option (null if no votes, or a tie at the top). */
export function leader(p: Poll): PollOption | null {
  const counts = p.options.map((o) => ({ o, n: Object.values(p.votes).filter((v) => v === o.id).length }));
  const max = Math.max(0, ...counts.map((c) => c.n));
  const top = counts.filter((c) => c.n === max);
  return max > 0 && top.length === 1 ? top[0]?.o ?? null : null;
}

function PollsBody({ ctx, entry, user }: { ctx: TripCtx; entry: TripEntry; user: User }) {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [plan, setPlan] = useState<PlanSeed | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const qRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let off: (() => void) | undefined, gone = false;
    cloud.watchPolls(ctx.id, setPolls, (e) => toast(e, 'bad')).then((u) => { if (gone) u(); else off = u; });
    return () => { gone = true; off?.(); };
  }, [ctx.id]);
  useReveal(ref, '.poll', !!polls);
  const isNew = useNewItems(polls ? polls.map((x) => x.id) : null);
  const [leaving, leave] = useLeaving();
  useEffect(() => { if (draft) qRef.current?.focus(); }, [!!draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = [...(polls || [])].sort((a, b) => Number(a.closed) - Number(b.closed) || b.createdMs - a.createdMs);
  const recent = entry.trip.days.flatMap((d) => d.stops.map((s) => s.place));
  const startDraft = () => setDraft({ question: '', dayDate: '', options: [{ id: optId(), text: '', place: null }, { id: optId(), text: '', place: null }] });
  const setOpt = (i: number, patch: Partial<PollOption>) => draft && setDraft({ ...draft, options: draft.options.map((o, k) => (k === i ? { ...o, ...patch } : o)) });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const question = draft.question.trim();
    const options = draft.options.map((o) => ({ ...o, text: o.text.trim() })).filter((o) => o.text);
    if (!question) { toast('Ask a question.', 'bad'); qRef.current?.focus(); return; }
    if (options.length < 2) { toast('Give at least two options.', 'bad'); return; }
    setDraft(null);
    try { await cloud.createPoll(user, ctx.id, { question, options, dayDate: draft.dayDate }); toast('Poll started. Everyone can vote now.', 'ok'); }
    catch (err) { toast((err as Error).message, 'bad'); }
  };
  const vote = (p: Poll, o: PollOption) => {
    if (p.closed) return;
    const mine = p.votes[user.email];
    cloud.votePoll(user, ctx.id, p.id, mine === o.id ? null : o.id).catch((e: Error) => toast(e.message, 'bad'));
  };
  const remove = async (p: Poll) => {
    if (!(await ask('Delete this poll?', { detail: 'Its votes go too.', ok: 'Delete', danger: true }))) return;
    await leave(p.id, () => cloud.deleteSubDoc(ctx.id, 'polls', p.id).catch((e: Error) => toast(e.message, 'bad')));
  };

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      {draft ? (
        <section className="ed-card">
          <h2 className="sec-h">New poll</h2>
          <form className="form poll-form" noValidate onSubmit={create}>
            <label className="fld"><span>Question</span><input ref={qRef} maxLength={160} placeholder="e.g. Dinner on Day 2?" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} /></label>
            <label className="fld"><span>For a day <small className="muted">(optional)</small></span>
              <select value={draft.dayDate} onChange={(e) => setDraft({ ...draft, dayDate: e.target.value })}>
                <option value="">Any day</option>
                {entry.trip.days.map((d, i) => <option key={d.date} value={d.date}>Day {i + 1} · {shortDate(d.date)}</option>)}
              </select>
            </label>
            <div className="fld"><span>Options</span>
              <div className="poll-opts-edit">
                {draft.options.map((o, i) => (
                  <div key={o.id} className="poll-opt-edit">
                    <span className="poll-n">{i + 1}</span>
                    <input maxLength={80} placeholder={i === 0 ? 'e.g. Thalassa' : i === 1 ? "e.g. Fisherman's Wharf" : 'Another option'} value={o.text} onChange={(e) => setOpt(i, { text: e.target.value })} aria-label={`Option ${i + 1}`} />
                    <button type="button" className={`icon-link${o.place ? ' on' : ''}`} title={o.place ? o.place.name : 'Add a place'} aria-label={`Place for option ${i + 1}`} onClick={() => setPicking(i)}><Icon.pin /></button>
                    {draft.options.length > 2 ? <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} onClick={() => setDraft({ ...draft, options: draft.options.filter((_, k) => k !== i) })}>✕</button> : null}
                  </div>
                ))}
              </div>
              {draft.options.length < 8 ? <button type="button" className="link-btn" onClick={() => setDraft({ ...draft, options: [...draft.options, { id: optId(), text: '', place: null }] })}>+ Add option</button> : null}
            </div>
            <div className="form-acts">
              <button className="btn ghost" type="button" onClick={() => setDraft(null)}>Cancel</button>
              <button className="btn" type="submit">Start poll</button>
            </div>
          </form>
        </section>
      ) : (
        <button className="smart-btn add-big" type="button" onClick={startDraft}>
          <span className="smart-spark" aria-hidden="true">🗳️</span>
          <span><strong>Start a poll</strong><span className="muted small">Let the group decide: where to eat, what to do, when to leave</span></span>
          <span aria-hidden="true"><Icon.plus /></span>
        </button>
      )}

      {polls && !polls.length && !draft ? (
        <section className="ed-card empty-card">
          <div className="empty-art" aria-hidden="true">🗳️</div>
          <strong>Decide together</strong>
          <p className="fine">Start a poll and everyone votes with one tap. The winner can go straight into the plan.</p>
        </section>
      ) : null}

      {sorted.map((p) => {
        const total = Object.keys(p.votes).length;
        const mine = p.votes[user.email];
        const top = leader(p);
        const canManage = p.createdBy === user.email || ctx.canEdit;
        const day = entry.trip.days.findIndex((d) => d.date === p.dayDate);
        return (
          <section key={p.id} className={`ed-card poll${p.closed ? ' closed' : ''}${isNew(p.id) ? ' fresh' : ''}${leaving.has(p.id) ? ' leaving' : ''}`}>
            <div className="poll-head">
              <h2 className="poll-q">{p.question}</h2>
              <span className={`badge ${p.closed ? 'local' : 'pub'}`}>{p.closed ? 'Closed' : 'Open'}</span>
            </div>
            <div className="muted small">
              {nameOf(p.createdBy, user)} asked{day >= 0 ? ` · Day ${day + 1}` : ''} · {total} vote{total === 1 ? '' : 's'}{!p.closed && !mine ? ' · tap an option to vote' : ''}
            </div>
            <div className="poll-opts" role="group" aria-label={p.question}>
              {p.options.map((o) => {
                const voters = Object.entries(p.votes).filter(([, v]) => v === o.id).map(([e]) => e);
                const pct = total ? Math.round((voters.length / total) * 100) : 0;
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`poll-opt${mine === o.id ? ' mine' : ''}${top?.id === o.id ? ' lead' : ''}`}
                    aria-pressed={mine === o.id}
                    disabled={p.closed}
                    onClick={() => vote(p, o)}
                  >
                    <span className="poll-bar" style={{ width: `${pct}%` }} />
                    <span className="poll-txt">
                      <span className="poll-check" aria-hidden="true">{mine === o.id ? '✓' : ''}</span>
                      <span className="poll-label">{o.text}{o.place ? <span className="muted small"> · 📍 {o.place.name}</span> : null}</span>
                    </span>
                    <span className="poll-right"><Avatars emails={voters} /><strong>{pct}%</strong></span>
                  </button>
                );
              })}
            </div>
            {canManage || (ctx.canEdit && top) ? (
              <div className="poll-acts">
                {ctx.canEdit && top ? (
                  <button className="btn small" type="button" onClick={() => setPlan({ title: top.text, place: top.place, date: p.dayDate || undefined, note: `Picked in a poll: ${p.question}` })}>
                    🏆 Add “{top.text}” to plan
                  </button>
                ) : null}
                {canManage ? <button className="btn ghost small" type="button" onClick={() => cloud.closePoll(user, ctx.id, p.id, !p.closed).catch((e: Error) => toast(e.message, 'bad'))}>{p.closed ? 'Reopen' : 'Close poll'}</button> : null}
                {canManage ? <button className="icon-link" type="button" title="Delete poll" aria-label="Delete poll" onClick={() => remove(p)}><Icon.trash /></button> : null}
              </div>
            ) : null}
          </section>
        );
      })}

      {picking !== null && draft ? (
        <PlacePicker place={draft.options[picking]?.place ?? null} recent={recent} onClose={(pl: Place | null) => { const i = picking; setPicking(null); if (pl) setOpt(i, { place: pl, text: draft.options[i]?.text || pl.name }); }} />
      ) : null}
      {plan ? <AddToPlanSheet entry={entry} user={user} seed={plan} onClose={() => setPlan(null)} /> : null}
    </div>
  );
}
