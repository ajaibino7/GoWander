// #/import/:payload — someone sent a copy of a trip (the whole plan is in the link). Save it to
// your trips, or just look at it first.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { BackLink, signInWithToast } from '../components/Hero';
import { Page, PageLoading } from '../components/Page';
import * as cloud from '../lib/cloud';
import * as store from '../lib/store';
import { toast } from '../lib/toast';
import type { Trip } from '../lib/types';
import { fmtRange } from '../lib/util';
import { TripView } from './trip/TripPage';

export function ImportSharedPage() {
  const { payload = '' } = useParams();
  const { user } = useAppData();
  const navigate = useNavigate();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTrip(null);
    store.decodeShare(payload).then((t) => { if (!cancelled) setTrip(t); }, () => {
      if (cancelled) return;
      toast('That link is broken or incomplete.', 'bad');
      navigate('/', { replace: true });
    });
    return () => { cancelled = true; };
  }, [payload, navigate]);

  if (!trip) return <PageLoading viewId="view-import" eyebrow="Shared trip" back={<BackLink />} />;
  if (preview) {
    return <TripView trip={trip} preview back={<button className="hn-btn" type="button" onClick={() => setPreview(false)}>‹ Back</button>} />;
  }

  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  return (
    <Page
      viewId="view-import"
      hero={{
        eyebrow: 'Shared trip',
        title: trip.title,
        desc: trip.subtitle,
        sub: `${fmtRange(trip.days[0]?.date, trip.days[trip.days.length - 1]?.date)} · ${trip.days.length} days · ${stops} stops`,
        nav: <BackLink />,
      }}
    >
      <section className="ed-card">
        <h2 className="sec-h">Someone sent you a copy of a trip</h2>
        <ul className="import-days">
          {trip.days.map((d, i) => (
            <li key={i}><strong>Day {i + 1}</strong> · {fmtRange(d.date, d.date)}{d.title ? ` — ${d.title}` : ''} <span className="muted">({d.stops.length} stops)</span></li>
          ))}
        </ul>
        <div className="home-actions">
          {user ? (
            <button className="btn" type="button" disabled={saving} onClick={async () => {
              setSaving(true);
              try {
                const id = await cloud.createTrip(user, trip);
                toast('Trip saved to your account', 'ok');
                navigate(`/trip/${encodeURIComponent(id)}`, { replace: true });
              } catch (err) { setSaving(false); toast((err as Error).message, 'bad'); }
            }}>Save to my trips</button>
          ) : cloud.available() ? <button className="btn" type="button" onClick={signInWithToast}>Sign in to save it</button> : null}
          <button className="btn ghost" type="button" onClick={() => { setPreview(true); window.scrollTo({ top: 0, behavior: 'instant' }); }}>Just view it</button>
        </div>
        <p className="fine">{user ? 'It becomes your own trip — only you are a member until you add others.' : 'You can view it without signing in. Saving needs a Google sign-in.'}</p>
      </section>
    </Page>
  );
}
