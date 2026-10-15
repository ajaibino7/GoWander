// #/tickets/:id — every ticket and booking in the trip, day by day: PNRs (with a status check),
// booking references, phone numbers and links. Part of the plan, so it works offline.
import { Link } from 'react-router-dom';
import { TripSubPage } from '../app/TripSubPage';
import { BookingCard } from '../components/BookingCard';
import { Icon } from '../components/Icons';
import { KIND_LABELS, fmtHHMM, shortDate } from '../lib/util';

const KIND_ICON = { stop: '📍', meal: '🍽️', travel: '🚆', stay: '🏨' } as const;

export function TicketsPage() {
  return (
    <TripSubPage
      viewId="view-tickets"
      eyebrow="Tickets & bookings"
      allowSample
      foot="Saved with the trip, so they're here even without signal."
      sub={({ trip }) => {
        const n = trip.days.reduce((k, d) => k + d.stops.filter((s) => s.booking).length, 0);
        return n ? `${n} booking${n === 1 ? '' : 's'}` : 'No bookings yet';
      }}
      actions={({ canEdit, id }) => (canEdit ? <Link className="hn-btn" to={`/edit/${encodeURIComponent(id)}`}>Edit</Link> : null)}
    >
      {({ trip, canEdit, id }) => {
        const days = trip.days.map((d, i) => ({ d, n: i + 1, stops: d.stops.filter((s) => s.booking) })).filter((x) => x.stops.length);
        if (!days.length) {
          return (
            <section className="ed-card empty-card">
              <div className="empty-art" aria-hidden="true">🎫</div>
              <strong>Keep your tickets here</strong>
              <p className="fine">Add train PNRs, flight and hotel booking references, phone numbers and e-ticket links to stops. They show up here and on the stop, even offline.</p>
              {canEdit ? <div><Link className="btn" to={`/edit/${encodeURIComponent(id)}`}><Icon.edit /> Add in the editor</Link></div> : null}
              {canEdit ? <p className="fine">In the editor, open a stop's <strong>🎫 Tickets &amp; booking</strong> section.</p> : null}
            </section>
          );
        }
        return days.map(({ d, n, stops }) => (
          <section className="ed-card tk-day" key={d.date}>
            <h2 className="sec-h">Day {n} <span className="muted small">· {shortDate(d.date)}</span></h2>
            <ul className="tk-list">
              {stops.map((s) => (
                <li key={s.id} className="tk-item">
                  <div className="tk-head">
                    <span className="tk-ic" aria-hidden="true">{KIND_ICON[s.kind]}</span>
                    <span className="tk-t">
                      <strong>{s.title}</strong>
                      <span className="muted small">{fmtHHMM(s.start)} · {s.place.name} · {KIND_LABELS[s.kind]}</span>
                    </span>
                  </div>
                  {s.booking ? <BookingCard booking={s.booking} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ));
      }}
    </TripSubPage>
  );
}
