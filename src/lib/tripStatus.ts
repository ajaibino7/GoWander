// A trip's status for cards and the home header: live now, in N days, completed, or no stops yet.
import type { Trip, TripMeta, User } from './types';
import { makeClock } from './util';

export interface TripStatus { key: 'live' | 'soon' | 'past' | 'empty'; label: string; order: number; at?: number }

export function tripWindow(trip: Trip): { start: Date; end: Date } | null {
  const days = trip.days.filter((d) => d.stops.length);
  const first = days[0], last = days[days.length - 1];
  if (!first || !last) return null;
  const c = makeClock(trip.timezone);
  const firstStop = first.stops[0], lastStop = last.stops[last.stops.length - 1];
  if (!firstStop || !lastStop) return null;
  return { start: c.at(first.date, firstStop.start), end: c.at(last.date, lastStop.end) };
}

export function tripStatus(trip: Trip, t: Date = new Date()): TripStatus {
  const w = tripWindow(trip);
  if (!w) return { key: 'empty', label: 'No stops yet', order: 3 };
  if (t >= w.start && t < w.end) return { key: 'live', label: 'Live now', order: 0 };
  if (t < w.start) {
    const days = Math.ceil((w.start.getTime() - t.getTime()) / 86400000);
    return { key: 'soon', label: days <= 1 ? 'Starts tomorrow' : `In ${days} days`, order: 1, at: w.start.getTime() };
  }
  return { key: 'past', label: 'Completed', order: 2, at: w.end.getTime() };
}

/** Live first, then soonest upcoming, then most recently finished, then trips without stops. */
export const byStatus = (a: { st: TripStatus }, b: { st: TripStatus }): number =>
  a.st.order - b.st.order || (a.st.key === 'past' ? (b.st.at || 0) - (a.st.at || 0) : (a.st.at || 0) - (b.st.at || 0));

/** Owners always edit; other members unless the owner made them view-only. */
export const canEditTrip = (meta: TripMeta | null | undefined, user: User | null): boolean =>
  !!meta && !!user && !meta.viewerEmails.includes(user.email);
