// Home: the logo header, your trips (live first), the sample trip, and sign-in when signed out.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { ensureAutoCover } from '../app/covers';
import { useReveal } from '../app/motion';
import { copyTrip, importFile } from '../app/actions';
import { AccountChip, signInWithToast } from '../components/Hero';
import { Page } from '../components/Page';
import { TripCard } from '../components/TripCard';
import { Icon } from '../components/Icons';
import * as cloud from '../lib/cloud';
import { sim } from '../lib/live';
import { byStatus, canEditTrip, tripStatus } from '../lib/tripStatus';
import type { Trip } from '../lib/types';

// Opening the app on the home page jumps into a trip that's happening right now (test mode opens
// the sample). Only for the first screen of a visit, and only if the link didn't ask for a page.
const openedOnHome = !location.hash || location.hash === '#' || location.hash === '#/';
let bootJumpDone = false;

// The sample trip sits behind a label until clicked; remembered while the app is open.
let samplesOpen = false;

export function SignInCard({ message = '' }: { message?: string }) {
  if (!cloud.available()) {
    return (
      <section className="ed-card">
        <h2 className="sec-h">Sign-in isn't set up yet</h2>
        <p className="fine">The site owner needs to connect Firebase (see the README → “Set up Firebase”). Until then you can browse the sample trip.</p>
      </section>
    );
  }
  return (
    <section className="ed-card signin-card">
      {message ? <div className="status-msg info">{message}</div> : null}
      <h2 className="sec-h">Plan together, follow live</h2>
      <p className="fine">Sign in with Google to create trips, keep them in sync across your devices, and invite friends to plan with you. Only the people you add can see or change a trip.</p>
      <div><button className="btn google" type="button" onClick={signInWithToast}><span className="g">G</span> Sign in with Google</button></div>
    </section>
  );
}

/** Placeholder cards while the trip list loads (index.html paints the same before the app starts). */
export function HomeSkeleton() {
  return (
    <div className="home-skel" aria-hidden="true">
      <div className="sk-line w40" /><div className="sk-line w25" />
      <div className="trip-list"><div className="sk-card" /><div className="sk-card" /><div className="sk-card" /></div>
    </div>
  );
}

function Samples({ samples, signedIn }: { samples: Trip[]; signedIn: boolean }) {
  const { user } = useAppData();
  const navigate = useNavigate();
  const [open, setOpen] = useState(samplesOpen);
  const [busy, setBusy] = useState(false);
  if (!samples.length) return null;
  return (
    <details className="samples" open={open} onToggle={(e) => { samplesOpen = (e.target as HTMLDetailsElement).open; setOpen(samplesOpen); }}>
      <summary><span className="list-h">Sample trip</span><span className="muted small">{open ? 'Hide' : 'Show'}</span></summary>
      <div className="trip-list">
        {samples.map((t, i) => (
          <TripCard
            key={t.id}
            trip={t}
            index={i + 1}
            badges={<span className="badge local">Sample · read-only</span>}
            actions={signedIn ? (
              <button className="mini" type="button" disabled={busy} onClick={async () => {
                if (!user) return; // Firebase is still starting
                setBusy(true);
                const id = await copyTrip(user, t);
                setBusy(false);
                if (id) navigate(`/trip/${encodeURIComponent(id)}`);
              }}>Copy to my trips</button>
            ) : null}
          />
        ))}
      </div>
    </details>
  );
}

export function HomePage({ message = '' }: { message?: string }) {
  const { user, authReady, samples, samplesReady, myTrips, myTripsLoaded, cached, shownUser } = useAppData();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Until Firebase has confirmed the sign-in and sent the list, last visit's trips stand in
  // (so the first frame shows real cards, not placeholders).
  const me = shownUser;
  const list = myTripsLoaded ? myTrips : cached?.trips ?? [];
  const rows = me ? list.map((e) => ({ ...e, st: tripStatus(e.trip) })).sort(byStatus) : [];
  const loading = !cached && (!authReady || (!!user && !myTripsLoaded));

  // Jump into a trip that's live right now (or the sample, in test mode) when the app opens on home.
  useEffect(() => {
    if (bootJumpDone || !openedOnHome || !authReady || !samplesReady) return;
    if (sim.enabled) {
      bootJumpDone = true;
      if (samples[0]) navigate(`/trip/${encodeURIComponent(samples[0].id)}`, { replace: true });
      return;
    }
    if (user && !myTripsLoaded) return; // wait for the list
    bootJumpDone = true;
    const live = user ? myTrips.find((e) => tripStatus(e.trip).key === 'live') : null;
    if (live) navigate(`/trip/${encodeURIComponent(live.trip.id)}`, { replace: true });
  }, [authReady, samplesReady, user, myTripsLoaded, myTrips, samples, navigate]);

  // Destination photos for the cards; looked up once per place, then remembered.
  useEffect(() => {
    for (const t of [...myTrips.map((e) => e.trip), ...samples]) ensureAutoCover(t);
  }, [myTrips, samples]);

  useReveal(listRef, '.trip-list > .trip-card, .empty', !loading);

  // The header points at what matters now: a trip in progress, else the next one.
  const focus = rows.find((r) => r.st.key === 'live') || rows.find((r) => r.st.key === 'soon');
  const sub = (
    <>
      {focus ? (
        <Link className={`hero-pill${focus.st.key === 'live' ? ' live' : ''}`} to={`/trip/${encodeURIComponent(focus.trip.id)}`}>
          <span className="hp-dot" /><span className="hp-k">{focus.st.key === 'live' ? 'Live now' : 'Up next'}</span>
          <span className="hp-v">{focus.trip.title}{focus.st.key === 'soon' ? ` · ${focus.st.label.toLowerCase()}` : ''}</span><span aria-hidden="true">→</span>
        </Link>
      ) : null}
      {me ? <div className="hero-who">Signed in as {me.email}</div> : null}
    </>
  );

  const live = rows.filter((r) => r.st.key === 'live').length;
  const soon = rows.filter((r) => r.st.key === 'soon').length;
  const summary = [`${rows.length} trip${rows.length === 1 ? '' : 's'}`, live && `${live} live now`, soon && `${soon} coming up`].filter(Boolean).join(' · ');

  let body;
  if (loading) {
    body = <HomeSkeleton />;
  } else if (!me) {
    body = <><SignInCard message={message} /><Samples samples={samples} signedIn={false} /></>;
  } else {
    body = (
      <>
        <div className="home-head">
          <div>
            <h2 className="list-h">Your trips</h2>
            <div className="home-sum">{summary}</div>
          </div>
          <div className="home-actions">
            <button className="btn ghost" type="button" onClick={() => fileRef.current?.click()}><Icon.upload /> Import</button>
            <Link className="btn" to="/new"><Icon.plus /> New trip</Link>
          </div>
        </div>
        <div className="trip-list">
          {rows.length ? rows.map(({ trip, meta }, i) => {
            const owner = meta.ownerUid === me.uid;
            const canEdit = canEditTrip(meta, me);
            return (
              <TripCard
                key={trip.id}
                trip={trip}
                index={i}
                members={meta.memberEmails}
                badges={<>
                  {owner ? <span className="badge pub">Owner</span> : <span className="badge local" title={meta.ownerEmail}>Shared by {meta.ownerEmail.split('@')[0]}</span>}
                  {canEdit ? null : <span className="badge view">View only</span>}
                  {meta.pending ? <span className="badge dirty">Syncing…</span> : null}
                </>}
                actions={<>
                  {canEdit ? <Link className="icon-link" to={`/edit/${encodeURIComponent(trip.id)}`} title="Edit trip" aria-label={`Edit ${trip.title}`}><Icon.edit /></Link> : null}
                  <Link className="icon-link" to={`/members/${encodeURIComponent(trip.id)}`} title="Members" aria-label={`Members of ${trip.title}`}><Icon.users /></Link>
                </>}
              />
            );
          }) : (
            <div className="empty">
              <div className="empty-art" aria-hidden="true">🧭</div>
              <div className="empty-t">Your next adventure starts here</div>
              <p>Create a trip, copy the sample, or import a trips file. Trips friends share with you appear here too.</p>
              <div className="home-actions center"><Link className="btn" to="/new"><Icon.plus /> Plan a trip</Link></div>
            </div>
          )}
        </div>
        <Samples samples={samples} signedIn />
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file && user) await importFile(user, file);
          }}
        />
      </>
    );
  }

  return (
    <Page
      viewId="view-home"
      hero={{ logo: true, desc: 'Plan together · Travel smarter · Follow it live', sub, nav: <><span /><AccountChip /></> }}
      foot={cloud.emulatorMode ? 'Using local Firebase emulators.' : 'Trips are private to their members. Your location never leaves your device.'}
    >
      <div ref={listRef} style={{ display: 'contents' }}>{body}</div>
    </Page>
  );
}
