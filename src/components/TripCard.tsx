// A trip on the home page: coloured banner (or a cover photo) with a dotted route, date badge and
// status, then title, dates, days and stops, members and actions.
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Trip } from '../lib/types';
import { THEMES, fmtRange } from '../lib/util';
import { tripStatus } from '../lib/tripStatus';
import { cardCover, useCovers } from '../app/covers';
import { Avatars, Icon } from './Icons';

interface Props {
  trip: Trip;
  index: number;
  badges?: ReactNode;
  actions?: ReactNode;
  members?: string[];
}

export function TripCard({ trip, index, badges, actions, members = [] }: Props) {
  useCovers();
  const st = tripStatus(trip);
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  const first = trip.days[0]?.date, last = trip.days[trip.days.length - 1]?.date;
  const day = first ? Number(first.split('-')[2]) : 0;
  const mon = first ? new Date(`${first}T12:00:00`).toLocaleString('en', { month: 'short' }) : '';
  const cover = cardCover(trip.id);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <article className={`trip-card theme-${THEMES[index % THEMES.length]}`}>
      <Link className="tc-main" to={`/trip/${encodeURIComponent(trip.id)}`}>
        <div className={`tc-banner${cover ? ' has-cover' : ''}`} style={cover ? { backgroundImage: `url("${cover.url}")` } : undefined} title={cover?.title}>
          <svg className="tc-route" viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true">
            <path d="M18 92 C 80 92, 90 40, 150 50 S 230 18, 282 20" fill="none" stroke="rgba(255,255,255,.55)" strokeWidth="2" strokeDasharray="5 6" />
            <circle cx="18" cy="92" r="4" fill="rgba(255,255,255,.8)" /><circle cx="150" cy="50" r="3" fill="rgba(255,255,255,.7)" />
          </svg>
          {first ? <div className="tc-date"><b>{day}</b><span>{mon}</span></div> : null}
          <span className={`chip st-${st.key}`}>{st.key === 'live' ? <span className="live-dot" /> : null}{st.label}</span>
        </div>
        <div className="tc-body">
          <h3>{trip.title}</h3>
          <div className="tc-meta">
            <span><Icon.cal />{fmtRange(first, last)}</span>
            <span><Icon.sun />{plural(trip.days.length, 'day')}</span>
            <span><Icon.pin />{plural(stops, 'stop')}</span>
          </div>
          {trip.subtitle ? <div className="tc-sub">{trip.subtitle}</div> : null}
        </div>
      </Link>
      <div className="tc-foot"><span className="badges"><Avatars emails={members} />{badges}</span><span className="tc-actions">{actions}</span></div>
    </article>
  );
}
