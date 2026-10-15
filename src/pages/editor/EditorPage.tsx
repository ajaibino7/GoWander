// #/edit/:id (or #/edit/new) — the trip editor: details and cover, days, stops (with locations,
// reordering, moving between days), notes and fixed departures. Warns before leaving unsaved.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router-dom';
import { useAppData } from '../../app/AppData';
import { ensureAutoCover, firstUploadedCover } from '../../app/covers';
import { BackLink } from '../../components/Hero';
import { Page } from '../../components/Page';
import * as cloud from '../../lib/cloud';
import { ask, toast } from '../../lib/toast';
import { canEditTrip } from '../../lib/tripStatus';
import { addDays, deviceTz, makeClock } from '../../lib/util';
import type { DraftTrip, Trip } from '../../lib/types';
import type { CoverInfo } from '../../lib/autocover';
import { HomePage } from '../Home';
import { EditorForm, type EditorNotice } from './EditorForm';
import { clearPendingDraft, peekPendingDraft } from '../../app/pendingDraft';

function blankTrip(): DraftTrip {
  const tz = deviceTz();
  const today = makeClock(tz).dateKey(new Date());
  return { id: 'new', title: '', subtitle: '', timezone: tz, days: [{ date: addDays(today, 7), title: '', stops: [], notes: [] }] };
}

export function EditorPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { user, authReady, samples, myTrips, myTripsLoaded } = useAppData();
  const navigate = useNavigate();
  const entry = isNew ? null : myTrips.find((e) => e.trip.id === id) || null;
  // Bumped by "Load their version" to start again from the latest saved trip.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user || isNew) return;
    if (samples.some((t) => t.id === id)) { navigate(`/trip/${encodeURIComponent(id)}`, { replace: true }); return; }
    if (!myTripsLoaded) return;
    if (!entry) { toast('Trip not found, or you\'re not a member.', 'bad'); navigate('/', { replace: true }); return; }
    if (!canEditTrip(entry.meta, user)) {
      toast('You have view-only access to this trip. Ask the owner if you need to edit it.', 'info');
      navigate(`/trip/${encodeURIComponent(id)}`, { replace: true });
    }
  }, [user, isNew, id, samples, myTripsLoaded, entry, navigate]);

  if (!authReady) return null;
  if (!user) return <HomePage message="Sign in to create and edit trips." />;
  if (!isNew && (!myTripsLoaded || !entry || !canEditTrip(entry.meta, user))) return null;
  return <EditorSession key={`${id}:${reloadKey}`} isNew={isNew} id={id} trip={entry?.trip ?? null} baseMs={entry?.meta.updatedAtMs ?? 0} owner={entry?.meta.ownerUid === user.uid} shared={(entry?.meta.memberEmails.length ?? 1) > 1} onReload={() => setReloadKey((n) => n + 1)} />;
}

interface SessionProps {
  isNew: boolean;
  id: string;
  trip: Trip | null;
  /** When the trip was last saved as we started editing (to spot someone else's save). */
  baseMs: number;
  owner: boolean;
  /** Other people are in this trip. */
  shared: boolean;
  onReload: () => void;
}

function EditorSession({ isNew, id, trip, baseMs, owner, shared, onReload }: SessionProps) {
  const { user } = useAppData();
  const navigate = useNavigate();
  // A new trip starts blank — or from a template / "plan again", handed over in memory.
  const [prepared] = useState(() => (trip ? null : peekPendingDraft()));
  const start = useMemo<DraftTrip>(() => (trip ? structuredClone(trip) : prepared ?? blankTrip()), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => clearPendingDraft(), []);
  // A prepared trip isn't saved yet: leaving asks first.
  const [dirty, setDirty] = useState(!!prepared);
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [coverP] = useState<Promise<string | null>>(() => (isNew ? Promise.resolve(null) : firstUploadedCover(id)));
  const [autoP] = useState<Promise<CoverInfo | null>>(() => (isNew || !trip ? Promise.resolve(null) : ensureAutoCover(trip)));
  const leaving = useRef(false);

  // Tell the editor when another member saves this trip, so nobody edits a stale copy unknowingly.
  useEffect(() => {
    if (isNew || !user) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    cloud.watchTrip(id, (e) => {
      if (!e) { setNotice({ kind: 'deleted' }); return; }
      if (e.meta.updatedAtMs && e.meta.updatedAtMs !== baseMs && !e.meta.pending) {
        setNotice({ kind: 'saved', who: e.meta.updatedBy === user.email ? 'You (on another device)' : e.meta.updatedBy });
      }
    }).then((u) => { if (cancelled) u(); else off = u; });
    return () => { cancelled = true; off?.(); };
  }, [isNew, id, user, baseMs]);

  // Leaving with unsaved changes asks first (closing the tab, too).
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    ask('Leave without saving your changes?', { ok: 'Leave', cancel: 'Keep editing', danger: true })
      .then((yes) => (yes ? blocker.proceed() : blocker.reset()));
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const go = (to: string) => { leaving.current = true; navigate(to); };

  if (!user) return null;

  // The plan is already saved when the cover goes up, so a failed cover is reported, not thrown:
  // throwing would let "Save" run again and, for a new trip, create it twice.
  const saveCover = async (tripId: string, cover: string | null | undefined) => {
    if (cover === undefined) return;
    try { await cloud.setCover(user, tripId, cover); } catch (e) { toast(`Trip saved, but the cover image wasn't: ${(e as Error).message}`, 'bad'); }
  };

  const onSave = async (draft: DraftTrip, cover: string | null | undefined): Promise<boolean> => {
    if (isNew) {
      const newId = await cloud.createTrip(user, draft);
      await saveCover(newId, cover);
      toast('Trip created', 'ok');
      go(`/trip/${encodeURIComponent(newId)}`);
      return true;
    }
    try {
      await cloud.updateTrip(user, id, draft, baseMs);
    } catch (e) {
      if (!(e instanceof cloud.ConflictError)) throw e;
      if (!(await ask(`${e.by || 'Another member'} changed this trip while you were editing.`, {
        detail: 'Overwrite their changes with yours, or keep editing and load their version first.',
        ok: 'Overwrite',
        cancel: 'Keep editing',
        danger: true,
      }))) return false;
      await cloud.updateTrip(user, id, draft, baseMs, { force: true });
    }
    await saveCover(id, cover);
    toast('Saved', 'ok');
    go(`/trip/${encodeURIComponent(id)}`);
    return true;
  };

  const title = isNew ? 'New trip' : trip?.title || '';
  return (
    <Page
      viewId="view-edit"
      hero={{
        eyebrow: isNew ? 'New trip' : 'Edit trip',
        title,
        sub: isNew ? 'Add days, then stops with times and places.' : shared ? 'Members see your changes as soon as you save.' : 'Changes sync to all your devices.',
        nav: <BackLink to={isNew ? '/' : `/trip/${encodeURIComponent(id)}`} label={isNew ? 'All trips' : 'Back to trip'} />,
        tripId: isNew ? null : id,
      }}
      foot="Place search by OpenStreetMap Nominatim."
    >
      <EditorForm
        start={start}
        savedDates={trip?.days.map((d) => d.date) ?? []}
        isNew={isNew}
        canDelete={owner}
        coverP={coverP}
        autoP={autoP}
        notice={notice}
        onDirty={setDirty}
        onSave={onSave}
        onCancel={() => go(isNew ? '/' : `/trip/${encodeURIComponent(id)}`)}
        onReload={() => { leaving.current = true; onReload(); }}
        onDelete={async () => { leaving.current = true; await cloud.deleteTrip(id); toast('Trip deleted', 'ok'); navigate('/'); }}
        onDuplicate={async (copy) => {
          copy.title = `${copy.title} (copy)`;
          const newId = await cloud.createTrip(user, copy);
          toast('Copy created — only you are a member', 'ok');
          go(`/edit/${encodeURIComponent(newId)}`);
        }}
      />
    </Page>
  );
}
