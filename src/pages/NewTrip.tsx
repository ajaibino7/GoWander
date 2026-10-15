// #/new — starting a trip: from scratch, or from a ready-made plan (Goa, Manali, Jaipur…) moved to
// your dates. A template opens in the editor with everything filled in, to change as you like.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { ensureAutoCover } from '../app/covers';
import { setPendingDraft } from '../app/pendingDraft';
import { useReveal } from '../app/motion';
import { BackLink } from '../components/Hero';
import { Icon } from '../components/Icons';
import { Page } from '../components/Page';
import { Sheet } from '../components/Sheet';
import { TripCard } from '../components/TripCard';
import { shiftDates } from '../lib/plan';
import { loadTemplates, type Template } from '../lib/store';
import { addDays, deviceTz, fmtRange, makeClock } from '../lib/util';
import { HomePage } from './Home';

export function NewTripPage() {
  const { user, authReady } = useAppData();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [picked, setPicked] = useState<Template | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { loadTemplates().then((t) => { setTemplates(t); t.forEach((x) => ensureAutoCover(x.trip)); }); }, []);
  useReveal(ref, '.tpl', !!templates);

  if (authReady && !user) return <HomePage message="Sign in to create trips." />;
  const today = makeClock(deviceTz()).dateKey(new Date());

  return (
    <Page viewId="view-new" hero={{ eyebrow: 'New trip', title: 'Where to?', sub: 'Start from scratch, or from a ready-made plan', nav: <BackLink /> }} foot="Templates are a starting point: change anything before you save.">
      <div ref={ref} style={{ display: 'contents' }}>
        <Link className="smart-btn add-big" to="/edit/new">
          <span className="smart-spark" aria-hidden="true">✏️</span>
          <span><strong>Blank trip</strong><span className="muted small">Add your own days and stops</span></span>
          <span aria-hidden="true"><Icon.plus /></span>
        </Link>
        <h2 className="list-h">Start from a template</h2>
        {!templates ? (
          <div className="home-skel"><div className="trip-list"><div className="sk-card" /><div className="sk-card" /></div></div>
        ) : (
          <div className="trip-list">
            {templates.map((t, i) => {
              const stops = t.trip.days.reduce((n, d) => n + d.stops.length, 0);
              return (
                <div key={t.trip.id} className="tpl">
                  <TripCard
                    trip={t.trip}
                    index={i}
                    linkTo={null}
                    onOpen={() => setPicked(t)}
                    badges={<span className="badge local">{t.emoji} {t.tagline || `${t.trip.days.length} days · ${stops} stops`}</span>}
                    actions={<button className="btn small" type="button" onClick={() => setPicked(t)}>Use this</button>}
                    hideDate
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {picked ? <StartSheet template={picked} today={today} onClose={() => setPicked(null)} onStart={(first) => {
        const t = shiftDates(picked.trip, first);
        setPendingDraft({ ...t, id: 'new' });
        navigate('/edit/new');
      }} /> : null}
    </Page>
  );
}

function StartSheet({ template, today, onClose, onStart }: { template: Template; today: string; onClose: () => void; onStart: (first: string) => void }) {
  const [first, setFirst] = useState(addDays(today, 14));
  const n = template.trip.days.length;
  const last = addDays(first, n - 1);
  return (
    <Sheet
      title={`${template.emoji} ${template.trip.title}`}
      onClose={onClose}
      foot={(
        <>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="button" disabled={!first || first < today} onClick={() => onStart(first)}>Open in editor</button>
        </>
      )}
    >
      <p className="fine">{template.trip.subtitle}</p>
      <label className="fld"><span>First day</span><input type="date" min={today} value={first} onChange={(e) => setFirst(e.target.value)} /></label>
      <p className="fine">{n} day{n === 1 ? '' : 's'}: <strong>{fmtRange(first, last)}</strong></p>
      <ol className="tpl-days">
        {template.trip.days.map((d, i) => <li key={d.date}><strong>Day {i + 1}</strong> · {d.title} <span className="muted small">({d.stops.length} stops)</span></li>)}
      </ol>
    </Sheet>
  );
}
