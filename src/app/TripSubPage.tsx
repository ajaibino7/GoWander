// The frame for a trip's own screens (ideas, polls, tickets, journal, recap, SOS…): header with
// the trip's photo and "Back to trip", plus the states every one of them needs — still loading,
// signed out, not a member yet (join), or the sample trip where that makes sense. Shows the trip
// straight away from what the app already has, while the live connection catches up.
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useAppData } from './AppData';
import { useTripWatch } from './useTripWatch';
import { useTripProfiles } from './names';
import { BackLink } from '../components/Hero';
import { Page, PageLoading } from '../components/Page';
import { canEditTrip } from '../lib/tripStatus';
import type { Trip, TripEntry, User } from '../lib/types';
import { HomePage } from '../pages/Home';
import { JoinTrip } from '../pages/trip/JoinTrip';

export interface TripCtx {
  id: string;
  trip: Trip;
  /** null for the sample trip. */
  entry: TripEntry | null;
  /** null when signed out (sample trip only). */
  user: User | null;
  sample: boolean;
  /** Can change the plan (owner or editor). */
  canEdit: boolean;
}

interface Props {
  viewId: string;
  eyebrow: string;
  foot?: string;
  /** Works on the sample trip too (no shared data needed). */
  allowSample?: boolean;
  sub?: (ctx: TripCtx) => ReactNode;
  /** Header buttons on the right. */
  actions?: (ctx: TripCtx) => ReactNode;
  children: (ctx: TripCtx) => ReactNode;
}

export function TripSubPage({ viewId, eyebrow, foot, allowSample = false, sub, actions, children }: Props) {
  const { id = '' } = useParams();
  const { user, authReady, samples, samplesReady, myTrips, cached } = useAppData();
  const sample = allowSample ? samples.find((t) => t.id === id) : undefined;
  const { entry, denied, retry } = useTripWatch(sample ? '' : id, sample ? null : user);
  // Members' nicknames (and UPI IDs) for everything on the screen.
  useTripProfiles(!sample && user ? id : null);
  const back = <BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />;
  const loading = <PageLoading viewId={viewId} eyebrow={eyebrow} back={back} tripId={id} />;

  let ctx: TripCtx | null = null;
  if (sample) {
    ctx = { id, trip: sample, entry: null, user, sample: true, canEdit: false };
  } else {
    if (!samplesReady && allowSample) return loading;
    const known = denied ? undefined : entry ?? myTrips.find((e) => e.trip.id === id) ?? cached?.trips.find((e) => e.trip.id === id);
    if (!authReady) {
      if (!known) return loading;
    } else if (!user) {
      return <HomePage message="Sign in with Google to open this trip." />;
    } else if (denied) {
      return <JoinTrip id={id} onJoined={retry} />;
    }
    if (!known) return loading;
    ctx = { id, trip: known.trip, entry: known, user, sample: false, canEdit: canEditTrip(known.meta, user) };
  }

  return (
    <Page
      viewId={viewId}
      hero={{
        eyebrow,
        title: ctx.trip.title,
        sub: sub?.(ctx),
        nav: <>{back}{actions ? <span className="hn-right">{actions(ctx)}</span> : null}</>,
        tripId: id,
      }}
      foot={foot}
    >
      {children(ctx)}
    </Page>
  );
}
