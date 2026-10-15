// #/checklist/:id — the shared packing list and to-dos. Everyone on the trip can add, tick and
// remove items; changes show up live for everyone and work offline.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { useLeaving, useNewItems, useReveal } from '../app/motion';
import { nameOf, useTripWatch } from '../app/useTripWatch';
import { useTripProfiles } from '../app/names';
import { BackLink } from '../components/Hero';
import { Page, PageLoading } from '../components/Page';
import * as cloud from '../lib/cloud';
import { toast } from '../lib/toast';
import type { ChecklistItem, ChecklistList } from '../lib/types';
import { HomePage } from './Home';
import { JoinTrip } from './trip/JoinTrip';
import { PackingSheet } from './PackingSheet';

const CHECKLISTS: Record<ChecklistList, { title: string; placeholder: string; noun: string; ideas: string[] }> = {
  packing: {
    title: '🎒 Packing', placeholder: 'Add something to pack', noun: 'packed',
    ideas: ['Phone charger', 'Power bank', 'ID / passport', 'Tickets', 'Medicines', 'Sunscreen', 'Sunglasses', 'Umbrella or raincoat', 'Toiletries', 'Comfortable shoes', 'Cash & cards', 'Water bottle'],
  },
  todo: {
    title: '📝 To-do', placeholder: 'Add a to-do, e.g. Book a cab to the airport', noun: 'done',
    ideas: ['Book stays', 'Book tickets', 'Check the weather', 'Make the trip offline-ready', 'Share the trip link', 'Keep ID copies'],
  },
};

export function ChecklistPage() {
  const { id = '' } = useParams();
  const { user, authReady } = useAppData();
  const { entry, denied, retry } = useTripWatch(id, user);
  useTripProfiles(user ? id : null);
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  // Items ticked just now get a little "pop" (the list redraws on every change).
  const [justTicked, setJustTicked] = useState<string | null>(null);
  const [packing, setPacking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user || !entry) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    cloud.watchChecklist(id, setItems, (err) => toast(err, 'bad')).then((u) => { if (cancelled) u(); else off = u; });
    return () => { cancelled = true; off?.(); };
  }, [id, user, !!entry]); // eslint-disable-line react-hooks/exhaustive-deps

  useReveal(ref, '.cl-item', !!items);
  // Items someone adds slide in; removed ones slide away.
  const isNew = useNewItems(items ? items.map((x) => x.id) : null);
  const [leaving, leave] = useLeaving();

  if (!authReady) return <PageLoading viewId="view-checklist" eyebrow="Checklist" back={<BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />} tripId={id} />;
  if (!user) return <HomePage message="Sign in with Google to open this trip." />;
  if (denied) return <JoinTrip id={id} onJoined={retry} />;
  if (!entry) return <PageLoading viewId="view-checklist" eyebrow="Checklist" back={<BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />} tripId={id} />;

  const add = async (list: ChecklistList, text: string) => {
    try { await cloud.addChecklistItem(user, id, list, text); } catch (err) { toast((err as Error).message, 'bad'); }
  };

  return (
    <Page
      viewId="view-checklist"
      hero={{ eyebrow: 'Checklist', title: entry.trip.title, nav: <BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />, tripId: id }}
      foot="Shared with everyone on this trip. Changes sync live, and work offline too."
    >
      <div ref={ref} style={{ display: 'contents' }}>
        {(Object.entries(CHECKLISTS) as [ChecklistList, typeof CHECKLISTS.packing][]).map(([list, c]) => {
          const mine = (items || []).filter((x) => x.list === list)
            .sort((a, b) => Number(a.done) - Number(b.done) || a.createdMs - b.createdMs);
          const done = mine.filter((x) => x.done).length;
          const have = new Set(mine.map((x) => x.text.toLowerCase()));
          const ideas = c.ideas.filter((t) => !have.has(t.toLowerCase())).slice(0, 8);
          return (
            <section className="ed-card cl-card" key={list}>
              <div className="cl-head"><h2 className="sec-h">{c.title}</h2><span className="cl-count muted small">{mine.length ? `${done} of ${mine.length} ${c.noun}` : ''}</span></div>
              <div className="cl-bar" aria-hidden="true"><span style={{ width: mine.length ? `${(done / mine.length) * 100}%` : '0' }} /></div>
              <ul className="cl-items">
                {mine.length ? mine.map((x) => (
                  <li key={x.id} className={`cl-item${x.done ? ' done' : ''}${x.done && justTicked === x.id ? ' pop' : ''}${isNew(x.id) ? ' fresh' : ''}${leaving.has(x.id) ? ' leaving' : ''}`}>
                    <label>
                      <input type="checkbox" checked={x.done} onChange={async (e) => {
                        const on = e.target.checked;
                        if (on) setJustTicked(x.id);
                        try { await cloud.updateChecklistItem(user, id, x.id, { done: on, doneBy: on ? user.email : '' }); } catch (err) { toast((err as Error).message, 'bad'); }
                      }} />
                      <span className="cl-text">{x.text}</span>
                    </label>
                    {x.done && x.doneBy ? <span className="cl-by" title={x.doneBy}>✓ {nameOf(x.doneBy, user)}</span> : null}
                    <button className="icon-btn" type="button" title="Remove" aria-label={`Remove ${x.text}`} disabled={leaving.has(x.id)} onClick={() => leave(x.id, () =>
                      cloud.deleteListItem(id, 'checklist', x.id).catch((err: Error) => toast(err.message, 'bad')))}>✕</button>
                  </li>
                )) : <li className="cl-empty muted small">Nothing here yet. Add your own, or pick from the ideas below.</li>}
              </ul>
              {list === 'packing' ? (
                <button className="smart-btn" type="button" onClick={() => setPacking(true)}>
                  <span className="smart-spark" aria-hidden="true">✨</span>
                  <span><strong>Pack from the trip</strong><span className="muted small">Suggestions from your stops, the forecast and trip length</span></span>
                  <span aria-hidden="true">›</span>
                </button>
              ) : null}
              <AddForm placeholder={c.placeholder} onAdd={(text) => add(list, text)} />
              {ideas.length ? (
                <div className="cl-ideas">
                  {ideas.map((t) => <button key={t} className="chip-btn" type="button" onClick={() => add(list, t)}>+ {t}</button>)}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
      {packing ? <PackingSheet trip={entry.trip} user={user} existing={(items || []).filter((x) => x.list === 'packing').map((x) => x.text)} onClose={() => setPacking(false)} /> : null}
    </Page>
  );
}

function AddForm({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  return (
    <form className="cl-add form" noValidate onSubmit={(e) => {
      e.preventDefault();
      const t = text.trim();
      if (!t) return;
      setText('');
      input.current?.focus();
      onAdd(t);
    }}>
      <input ref={input} maxLength={200} placeholder={placeholder} aria-label={placeholder} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn" type="submit">Add</button>
    </form>
  );
}
