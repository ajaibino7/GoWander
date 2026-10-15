// A stop's tickets and booking details: PNR (with a status check), booking reference, phone and
// link — each a tap to copy, call or open. Shown on the trip timeline and the Tickets page.
import type { Booking } from '../lib/types';
import { toast } from '../lib/toast';
import { Icon } from './Icons';

/** Live PNR status for Indian Railways (the official site can't be opened with the PNR filled in). */
export const pnrStatusUrl = (pnr: string): string => `https://www.confirmtkt.com/pnr-status/${encodeURIComponent(pnr)}`;
const tel = (phone: string) => phone.replace(/[^\d+]/g, '');
const hostOf = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return 'Open link'; } };

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'ok'); } catch { toast(`${what}: ${text}`, 'info'); }
}

export function BookingCard({ booking, compact = false }: { booking: Booking; compact?: boolean }) {
  const b = booking;
  return (
    <div className={`booking${compact ? ' compact' : ''}`}>
      {b.pnr ? (
        <div className="bk-row">
          <span className="bk-k">PNR</span>
          <button className="bk-v mono" type="button" title="Copy PNR" onClick={() => copy(b.pnr || '', 'PNR')}>{b.pnr} <Icon.copy /></button>
          <a className="mini" href={pnrStatusUrl(b.pnr)} target="_blank" rel="noopener">Check status</a>
        </div>
      ) : null}
      {b.ref ? (
        <div className="bk-row">
          <span className="bk-k">Booking ref</span>
          <button className="bk-v mono" type="button" title="Copy booking reference" onClick={() => copy(b.ref || '', 'Booking reference')}>{b.ref} <Icon.copy /></button>
        </div>
      ) : null}
      {b.phone ? (
        <div className="bk-row">
          <span className="bk-k">Phone</span>
          <a className="bk-v" href={`tel:${tel(b.phone)}`}><Icon.phone /> {b.phone}</a>
        </div>
      ) : null}
      {b.link ? (
        <div className="bk-row">
          <span className="bk-k">Ticket</span>
          <a className="bk-v link" href={b.link} target="_blank" rel="noopener"><Icon.link /> {hostOf(b.link)}</a>
        </div>
      ) : null}
      {b.note ? <div className="bk-note">{b.note}</div> : null}
    </div>
  );
}
