// #/recap/:id — the trip in numbers: days, stops visited, distance, money spent, memories, the
// group's favourite stops (and the ones to skip next time). Share it as a picture, or plan the
// trip again with just the favourites.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { setPendingDraft } from '../app/pendingDraft';
import { TripSubPage, type TripCtx } from '../app/TripSubPage';
import { Icon } from '../components/Icons';
import * as cloud from '../lib/cloud';
import { CATEGORY_INFO, money, spendByCategory } from '../lib/expenses';
import { fmtKm, planAgain, recapOf } from '../lib/plan';
import { recapImage } from '../lib/recapImage';
import { tripLegs } from '../lib/routing';
import { toast } from '../lib/toast';
import type { Expense, JournalEntry, Review, TripEntry } from '../lib/types';
import { addDays, fmtRange, makeClock } from '../lib/util';

export function RecapPage() {
  return (
    <TripSubPage viewId="view-recap" eyebrow="Trip recap" foot="Numbers come from the plan, ticked-off stops, expenses, the journal and everyone's 👍 / 👎.">
      {(ctx) => (ctx.entry && ctx.user ? <RecapBody ctx={ctx} entry={ctx.entry} /> : null)}
    </TripSubPage>
  );
}

function RecapBody({ ctx, entry }: { ctx: TripCtx; entry: TripEntry }) {
  const trip = entry.trip;
  const navigate = useNavigate();
  const [done, setDone] = useState<Set<string>>(new Set());
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [road, setRoad] = useState<Map<string, number>>(new Map());
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    const offs: (() => void)[] = [];
    let gone = false;
    const keep = (u: () => void) => { if (gone) u(); else offs.push(u); };
    cloud.watchProgress(ctx.id, (m) => setDone(new Set(m.keys()))).then(keep);
    cloud.watchExpenses(ctx.id, setExpenses).then(keep);
    cloud.watchJournal(ctx.id, setJournal).then(keep);
    cloud.watchReviews(ctx.id, setReviews).then(keep);
    // Road distances (cached on the device once the trip page has looked them up).
    tripLegs(trip.days).then((legs) => { if (!gone) setRoad(new Map([...legs].map(([k, v]) => [k, v.drive.m]))); }, () => {});
    return () => { gone = true; offs.forEach((u) => u()); };
  }, [ctx.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const r = recapOf(trip, done, road);
  const range = fmtRange(trip.days[0]?.date, trip.days[trip.days.length - 1]?.date);
  const real = expenses.filter((x) => x.kind !== 'settlement');
  const curs = [...new Set(real.map((x) => x.currency))];
  const main = curs.sort((a, b) => real.filter((x) => x.currency === b).length - real.filter((x) => x.currency === a).length)[0];
  const spent = main ? real.filter((x) => x.currency === main).reduce((s, x) => s + x.amount, 0) : 0;
  const topCat = main ? spendByCategory(real, main)[0] : undefined;
  const allStops = trip.days.flatMap((d) => d.stops);
  const score = new Map<string, { up: number; down: number; notes: string[] }>();
  for (const v of reviews) {
    const e = score.get(v.stopId) || { up: 0, down: 0, notes: [] };
    if (v.vote === 1) e.up++; else e.down++;
    if (v.note) e.notes.push(`${v.vote === 1 ? '👍' : '👎'} ${v.note}`);
    score.set(v.stopId, e);
  }
  const ranked = allStops.map((s) => ({ s, sc: score.get(s.id) })).filter((x) => x.sc);
  const favourites = ranked.filter((x) => (x.sc?.up || 0) > (x.sc?.down || 0)).sort((a, b) => ((b.sc?.up || 0) - (b.sc?.down || 0)) - ((a.sc?.up || 0) - (a.sc?.down || 0))).slice(0, 5);
  const skip = ranked.filter((x) => (x.sc?.down || 0) > (x.sc?.up || 0));
  const photos = journal.filter((j) => j.hasPhoto).length;
  const members = entry.meta.memberEmails.length;

  const stats = [
    { icon: '🗓️', value: String(r.days), label: r.days === 1 ? 'day' : 'days' },
    { icon: '📍', value: `${r.done}/${r.stops}`, label: 'stops ticked off' },
    { icon: '🛣️', value: r.distance ? fmtKm(r.distance) : '—', label: 'travelled' },
    { icon: '💰', value: main ? money(Math.round(spent), main) : '—', label: 'spent together' },
    { icon: '📸', value: String(journal.length), label: `memor${journal.length === 1 ? 'y' : 'ies'}${photos ? ` · ${photos} photo${photos === 1 ? '' : 's'}` : ''}` },
    { icon: '👥', value: String(members), label: members === 1 ? 'traveller' : 'travellers' },
  ];

  const share = async () => {
    setSharing(true);
    try {
      const blob = await recapImage({
        title: trip.title, dates: `${range} · ${r.places} places`,
        stats: [stats[0], stats[2], stats[3], stats[1]].map((s) => ({ value: s?.value || '', label: s?.label || '' })),
        favourites: favourites.map((f) => f.s.title),
      });
      const file = new File([blob], `${trip.title.replace(/[^\w-]+/g, '-').toLowerCase()}-recap.jpg`, { type: 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${trip.title} recap` });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('Recap picture saved', 'ok');
      }
    } catch (e) { if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'bad'); }
    setSharing(false);
  };
  const again = () => {
    const first = addDays(makeClock(trip.timezone).dateKey(new Date()), 14);
    const { draft, dropped } = planAgain(trip, reviews, first);
    setPendingDraft(draft);
    toast(dropped.length ? `New trip from the favourites: left out ${dropped.length} thumbs-down stop${dropped.length === 1 ? '' : 's'}. Pick your dates, then save.` : 'New trip from this one. Pick your dates, then save.', 'ok', { duration: 7000 });
    navigate('/edit/new');
  };

  return (
    <>
      <section className="recap-hero">
        <div className="rc-k">{range}</div>
        <h2 className="rc-title">Your trip in numbers</h2>
        <div className="rc-grid">
          {stats.map((s) => (
            <div key={s.label} className="rc-stat"><span className="rc-ic" aria-hidden="true">{s.icon}</span><strong>{s.value}</strong><span>{s.label}</span></div>
          ))}
        </div>
        <div className="rc-acts">
          <button className="btn light" type="button" disabled={sharing} onClick={share}><Icon.share /> {sharing ? 'Drawing…' : 'Share recap'}</button>
          <button className="btn ghost light" type="button" onClick={again}>↻ Plan it again</button>
        </div>
      </section>

      {r.busiest || topCat ? (
        <section className="ed-card ov-card rc-facts">
          {r.busiest && r.busiest.stops ? <div><span>🏃</span><span>Busiest day: <strong>Day {r.busiest.n}</strong> with {r.busiest.stops} stops</span></div> : null}
          {topCat && main ? <div><span>{CATEGORY_INFO[topCat[0]].icon}</span><span>Most money went on <strong>{CATEGORY_INFO[topCat[0]].label.toLowerCase()}</strong>: {money(Math.round(topCat[1]), main)}</span></div> : null}
          {r.places ? <div><span>🗺️</span><span><strong>{r.places}</strong> different places on the map</span></div> : null}
        </section>
      ) : null}

      <section className="ed-card ov-card">
        <h2 className="sec-h">★ Group favourites</h2>
        {favourites.length ? (
          <ol className="fav-list">
            {favourites.map(({ s, sc }) => (
              <li key={s.id}>
                <span className="fav-t"><strong>{s.title}</strong><span className="muted small">📍 {s.place.name}</span>{sc?.notes.length ? <span className="fav-notes">{sc.notes.slice(0, 2).join(' · ')}</span> : null}</span>
                <span className="fav-score">👍 {sc?.up}</span>
              </li>
            ))}
          </ol>
        ) : <p className="fine">Rate stops with 👍 / 👎 on the trip page (open a stop once it's started) and the favourites show up here.</p>}
        {skip.length ? (
          <>
            <h3 className="sub-h">Skip next time</h3>
            <ul className="skip-list">{skip.map(({ s, sc }) => <li key={s.id}><strong>{s.title}</strong> <span className="muted small">👎 {sc?.down}{sc?.notes.length ? ` · ${sc.notes[0]}` : ''}</span></li>)}</ul>
          </>
        ) : null}
      </section>
      <p className="fine rc-again">“Plan it again” starts a new trip from this one in two weeks' time, without the thumbs-down stops and with everyone's notes on the rest. You choose the dates before saving.</p>
    </>
  );
}
