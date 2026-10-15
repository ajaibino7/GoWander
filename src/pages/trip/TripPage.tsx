// The trip page: a sample trip, one of your trips (live from Firestore, with shared done/skip
// marks), or a preview of a shared copy. Not a member yet → the join screen.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAppData } from '../../app/AppData';
import { ensureAutoCover, useUploadedCover } from '../../app/covers';
import { useReveal } from '../../app/motion';
import { copyTrip } from '../../app/actions';
import { AccountChip, BackLink } from '../../components/Hero';
import { Page } from '../../components/Page';
import * as cloud from '../../lib/cloud';
import {
  closeNearby, emit, live, mountTrip, now, openNearby, refitMap, setDoneMarks, syncFollow, tripPhase, unmountTrip, useLive, type LiveDay,
} from '../../lib/live';
import { canEditTrip } from '../../lib/tripStatus';
import { fmtDur, fmtRange } from '../../lib/util';
import { toast } from '../../lib/toast';
import type { Trip, TripEntry } from '../../lib/types';
import { HomePage } from '../Home';
import { JoinTrip } from './JoinTrip';
import { StatusCard } from './StatusCard';
import { DayTabs, DayView } from './DayView';
import { TripMap } from './TripMap';
import { NearbyPanel, scrollToMapCard } from './NearbyPanel';
import { TripTools } from './TripTools';
import { RunningLateSheet } from './RunningLate';
import { GroupPanel, useGroupSharing } from './GroupMap';

interface ViewProps {
  trip: Trip;
  entry?: TripEntry;
  sample?: boolean;
  /** A shared copy being looked at before saving: no tools, no cover, nothing stored. */
  preview?: boolean;
  onDone?: ((stopId: string, on: boolean) => void) | null;
  /** Shown instead of "All trips" in the header (the preview goes back to the import screen). */
  back?: React.ReactNode;
}

export function TripView({ trip, entry, sample = false, preview = false, onDone = null, back }: ViewProps) {
  const { user } = useAppData();
  const navigate = useNavigate();
  const [copying, setCopying] = useState(false);
  const [lateDay, setLateDay] = useState<LiveDay | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useLive();
  // Opening a trip: the status card, tools and the day's stops rise in one after another.
  useReveal(wrap, '.status-card, .hub, .tabs, .day-band, .timeline > li');
  // Shared trips: your location for the group map (when you share it), and everyone else's.
  const shared = !!entry && !!user && !sample && !preview;
  useGroupSharing(shared ? trip.id : null, shared ? user : null);

  // Start the live engine for this trip before the first paint; a new version of the same trip
  // (another member's edit) keeps your place in the page.
  useLayoutEffect(() => { mountTrip(trip, { onDone }); }, [trip, onDone]);
  useEffect(() => () => unmountTrip(), []);
  useEffect(() => { if (!preview) ensureAutoCover(trip); }, [trip, preview]);

  // The map card grows a panel for nearby places: tell the map its size changed.
  const nearbyOpen = !!live.nearby;
  const groupOpen = live.groupOn;
  useEffect(() => { setTimeout(() => live.map?.invalidateSize(), 0); }, [nearbyOpen, groupOpen]);

  if (live.trip?.id !== trip.id) return null; // the engine starts in the layout effect, before paint
  const t = now();
  syncFollow(t);
  const phase = tripPhase(t);
  const days = live.days;
  // Open on today's day (or the next, the last after the trip, else the first).
  if (live.selectedDay == null && days.length) {
    const pick = ('day' in phase ? phase.day : undefined) || ('next' in phase ? phase.next : undefined) || (phase.phase === 'after' ? days[days.length - 1] : days[0]);
    live.selectedDay = pick?.n ?? null;
  }

  const range = fmtRange(days[0]?.date, days[days.length - 1]?.date);
  const firstStart = days[0]?.startAt;
  const cur = 'day' in phase ? phase.day : 'next' in phase ? phase.next : undefined;
  const phaseLine = phase.phase === 'empty' ? 'No stops yet'
    : phase.phase === 'before' ? `Starts in ${fmtDur((firstStart?.getTime() ?? 0) - t.getTime())} · ${range}`
    : phase.phase === 'after' ? `Trip complete · ${range}`
    : `Day ${cur?.n ?? ''} of ${days.length} · ${live.clock.fmtClock(t)} ${live.clock.label}`;

  const meta = entry?.meta;
  const n = meta?.memberEmails.length || 1;
  const nav = preview ? (back || <BackLink />)
    : sample ? (
      <>
        <BackLink />
        <span className="hn-right">
          {user ? (
            <button className="hn-btn" type="button" disabled={copying} onClick={async () => {
              setCopying(true);
              const id = await copyTrip(user, trip);
              setCopying(false);
              if (id) navigate(`/trip/${encodeURIComponent(id)}`);
            }}>Copy to my trips</button>
          ) : null}
        </span>
      </>
    ) : (
      <>
        <BackLink />
        <span className="hn-right">
          <Link className="hn-btn" to={`/members/${encodeURIComponent(trip.id)}`}>👥 {n}</Link>
          {canEditTrip(meta, user)
            ? <Link className="hn-btn" to={`/edit/${encodeURIComponent(trip.id)}`}>Edit</Link>
            : <span className="hn-btn hn-static" title="The owner gave you view-only access">👁 View only</span>}
        </span>
      </>
    );

  const onNearby = () => scrollToMapCard();
  // "Group map": open the panel under the map and bring it into view (on a wide screen the map
  // column stays put, so the panel would otherwise open out of sight).
  const openGroup = () => {
    live.groupOn = true;
    emit();
    setTimeout(() => document.querySelector('.group-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  };

  return (
    <Page
      viewId="view-trip"
      layout="wrap"
      hero={{ eyebrow: sample ? 'Sample trip' : 'GoWander · live', title: trip.title, desc: trip.subtitle, sub: phaseLine, nav, tripId: preview ? null : trip.id }}
      foot={`Times are in trip time (${live.clock.label}). Your location stays on your device and is never uploaded.`}
    >
      {/* Map popups are Leaflet HTML: their "What to do nearby" buttons are handled here. */}
      <div
        ref={wrap}
        style={{ display: 'contents' }}
        onClick={(e) => {
          const b = (e.target as HTMLElement).closest<HTMLElement>('.leaflet-popup [data-nearby]');
          if (!b?.dataset.nearby) return;
          openNearby(b.dataset.nearby, { general: 'nbGeneral' in b.dataset });
          onNearby();
        }}
      >
        <div className="col-main">
          <StatusCard onNearby={onNearby} onLate={entry && user && canEditTrip(entry.meta, user) ? setLateDay : undefined} />
          {preview ? null : <TripTools trip={trip} sample={sample} onGroup={openGroup} />}
          <DayTabs phase={phase} />
          <DayView
            phase={phase}
            onNearby={onNearby}
            review={shared && user ? { me: user.email, save: (stopId, vote, note) => { cloud.setReview(user, trip.id, stopId, vote, note).catch((e: Error) => toast(e.message, 'bad')); } } : undefined}
          />
        </div>
        <aside className="col-map">
          <div className={`map-card${nearbyOpen ? ' has-nearby' : ''}${groupOpen ? ' has-group' : ''}`}>
            <TripMap />
            <div className="map-foot">
              <button type="button" className="link-btn" onClick={() => { closeNearby(false); refitMap(); }}>Show all stops</button>
              <button type="button" className="link-btn" disabled={!live.pos} onClick={() => { if (live.pos && live.map) live.map.setView([live.pos.lat, live.pos.lng], 16); }}>Centre on me</button>
            </div>
            <NearbyPanel />
            {live.groupOn && shared && entry && user ? (
              <GroupPanel tripId={trip.id} user={user} members={entry.meta.memberEmails} endOfDay={live.clock.at(live.clock.dateKey(now()), '23:59').getTime()} />
            ) : null}
          </div>
        </aside>
      </div>
      {lateDay && entry && user ? <RunningLateSheet day={lateDay} entry={entry} user={user} onClose={() => setLateDay(null)} /> : null}
    </Page>
  );
}

/** #/trip/:id — a sample, one of your trips, or the join screen. */
export function TripPage() {
  const { id = '' } = useParams();
  const { user, authReady, samples, samplesReady, myTrips, cached } = useAppData();
  const navigate = useNavigate();
  const [entry, setEntry] = useState<TripEntry | null>(null);
  const [denied, setDenied] = useState(false);
  // Bumped after joining, to listen to the trip again (the "no access" listener has ended).
  const [attempt, setAttempt] = useState(0);
  const sample = samples.find((t) => t.id === id);
  const shared = !sample && !!user;
  useUploadedCover(shared ? id : null);

  // Done/skip marks are shared: ticking a stop shows up for every member.
  const userRef = useRef(user);
  userRef.current = user;
  const [onDone] = useState(() => (stopId: string, on: boolean) => {
    const u = userRef.current;
    if (u) cloud.setStopDone(u, id, stopId, on).catch((e: Error) => toast(e.message, 'bad'));
    else toast('Still connecting. Try that again in a moment.', 'info');
  });

  useEffect(() => {
    setEntry(null);
    setDenied(false);
    if (!shared || !user) return undefined;
    const offs: (() => void)[] = [];
    let cancelled = false;
    let progressStarted = false;
    const keep = (u: () => void) => { if (cancelled) u(); else offs.push(u); };
    cloud.watchTrip(id, (e) => {
      if (!e) {
        toast('This trip was deleted, or you were removed from it.', 'bad');
        navigate('/', { replace: true });
        return;
      }
      setDenied(false);
      setEntry(e);
      if (!progressStarted) {
        progressStarted = true;
        cloud.watchProgress(id, setDoneMarks).then(keep);
        cloud.watchReviews(id, (r) => { live.reviews = r; emit(); }).then(keep);
      }
    }, (err) => {
      if (err === 'denied') setDenied(true);
      else toast(err, 'bad');
    }).then(keep);
    return () => { cancelled = true; offs.forEach((u) => u()); };
  }, [id, shared, user, navigate, attempt]);

  // Until the trip's own live connection answers, show it from what the app already has: the
  // trip list (opening it from home) or last visit's snapshot (opening the app) — no placeholder.
  const known = denied ? undefined : myTrips.find((e) => e.trip.id === id) ?? cached?.trips.find((e) => e.trip.id === id);

  if (sample) return <TripView trip={sample} sample />;
  if (!authReady || (!samplesReady && !known)) {
    return known ? <TripView trip={known.trip} entry={known} onDone={onDone} /> : <Loading id={sample ? null : id} />; // still starting up
  }
  if (!user) return <HomePage message="Sign in with Google to open or join this trip." />;
  if (denied) return <JoinTrip id={id} onJoined={() => setAttempt((n) => n + 1)} />;
  const shown = entry ?? known;
  if (!shown) return <Loading id={id} />;
  return <TripView trip={shown.trip} entry={shown} onDone={onDone} />;
}

function Loading({ id }: { id: string | null }) {
  return (
    <Page viewId="view-trip" hero={{ eyebrow: 'GoWander · live', title: '', nav: <><BackLink /><AccountChip /></>, tripId: id }}>
      <div className="home-skel" aria-hidden="true"><div className="sk-card" /></div>
    </Page>
  );
}
