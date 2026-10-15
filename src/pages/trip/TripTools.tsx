// The trip hub under the status card: every tool for the trip as a tile — lists and money,
// planning together, on the go, and memories — plus Add to calendar and Save offline.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import * as cloud from '../../lib/cloud';
import { downloadIcs, type IcsResult } from '../../lib/calendar';
import { makeOfflineReady, offlineStatus } from '../../lib/offline';
import { live, useLive } from '../../lib/live';
import { toast } from '../../lib/toast';
import type { ChecklistItem, Trip } from '../../lib/types';
import { Icon } from '../../components/Icons';
import { ShareDaySheet } from './ShareDay';

// While saving for offline use (kept across visits to the trip page).
let offlineRun: { tripId: string; done: number; total: number } | null = null;

type Tone = 'sea' | 'coral' | 'green' | 'gold' | 'violet' | 'red' | 'slate';
function Tile({ to, onClick, icon, label, tone, busy, ok, title, badge }: {
  to?: string; onClick?: () => void; icon: ReactNode; label: string; tone: Tone; busy?: boolean; ok?: boolean; title?: string; badge?: ReactNode;
}) {
  const inner = (
    <>
      <span className={`hub-ic ${tone}${ok ? ' ok' : ''}`}>{icon}{badge ? <span className="hub-badge">{badge}</span> : null}</span>
      <span className="hub-l">{label}</span>
    </>
  );
  return to
    ? <Link className="hub-tile" to={to} title={title}>{inner}</Link>
    : <button className="hub-tile" type="button" onClick={onClick} disabled={busy} title={title}>{inner}</button>;
}

export function TripTools({ trip, sample = false, onGroup }: { trip: Trip; sample?: boolean; onGroup?: () => void }) {
  useLive();
  const [, rerender] = useState(0);
  const [sharing, setSharing] = useState(false);
  const refresh = () => rerender((n) => n + 1);
  const st = offlineStatus(trip.id);
  const busy = offlineRun?.tripId === trip.id;
  const offlineLabel = busy && offlineRun
    ? `Saving ${Math.min(offlineRun.done + 1, offlineRun.total)}/${offlineRun.total}`
    : st ? 'Offline ✓' : 'Offline';

  const addToCalendar = async () => {
    const n = trip.days.reduce((k, d) => k + d.stops.length, 0);
    // The shared checklist goes into a "Pack & prepare" event with reminders before the trip.
    let checklist: ChecklistItem[] | null = null;
    if (!sample) { try { checklist = await cloud.getChecklist(trip.id); } catch { /* still add the reminder */ } }
    const checklistUrl = sample ? '' : `${location.origin}${location.pathname}#/checklist/${encodeURIComponent(trip.id)}`;
    let how: IcsResult | 'failed';
    try { how = await downloadIcs(trip, { checklist, checklistUrl }); } catch { how = 'failed'; }
    if (how === 'downloaded') toast(`Calendar file downloaded. Open it to add ${n} stop${n === 1 ? '' : 's'}, plus packing reminders 8, 4 and 1 hour before you leave.`, 'ok');
    else if (how === 'safari-only') toast('On iPhone, only Safari can add events to Apple Calendar. Open this trip in Safari and tap Add to calendar again.', 'info', { duration: 9000 });
    else if (how === 'reload') toast('Almost ready: reload this page once, then tap Add to calendar again.', 'info', { duration: 9000, action: { label: 'Reload', onClick: () => location.reload() } });
    else if (how === 'failed') toast('Couldn\'t prepare the calendar. Please try again.', 'bad');
    // 'opened': iOS shows its own "Add All" calendar sheet.
  };

  const saveOffline = async () => {
    if (offlineRun) return;
    if (!navigator.onLine) { toast('You\'re offline. Connect first, then save the trip for offline use.', 'bad'); return; }
    offlineRun = { tripId: trip.id, done: 0, total: 1 };
    refresh();
    try {
      const r = await makeOfflineReady(trip, live.days, ({ done, total }) => { offlineRun = { tripId: trip.id, done, total }; refresh(); });
      toast(r.failed
        ? `Saved for offline use, but ${r.failed} item${r.failed === 1 ? '' : 's'} couldn't be fetched. Tap again later to finish.`
        : `Ready offline: weather, travel times, photos, nearby places and SOS info for ${r.places} place${r.places === 1 ? '' : 's'}.`, r.failed ? 'info' : 'ok');
    } finally {
      offlineRun = null;
      refresh();
    }
  };

  const id = encodeURIComponent(trip.id);
  const day = live.days.find((d) => d.n === live.selectedDay) || live.days[0];
  const tripDay = day ? trip.days.find((d) => d.date === day.date) : undefined;
  const bookings = trip.days.reduce((k, d) => k + d.stops.filter((s) => s.booking).length, 0);

  return (
    <nav className="hub" aria-label="Trip tools">
      {sample ? null : (
        <>
          <Tile to={`/checklist/${id}`} icon={<Icon.check />} label="Checklist" tone="green" />
          <Tile to={`/expenses/${id}`} icon={<Icon.wallet />} label="Expenses" tone="gold" />
          <Tile to={`/ideas/${id}`} icon={<Icon.idea />} label="Ideas" tone="violet" />
          <Tile to={`/polls/${id}`} icon={<Icon.poll />} label="Polls" tone="sea" />
        </>
      )}
      <Tile to={`/tickets/${id}`} icon={<Icon.ticket />} label="Tickets" tone="coral" badge={bookings || null} />
      <Tile onClick={() => setSharing(true)} icon={<Icon.share />} label="Share day" tone="green" title="Send the day's plan to WhatsApp" />
      {sample ? null : <Tile onClick={onGroup} icon={<Icon.group />} label="Group map" tone="sea" title="Where's everyone?" />}
      <Tile to={`/sos/${id}`} icon={<Icon.sos />} label="SOS" tone="red" title="Emergency numbers, nearest hospital and police" />
      {sample ? null : (
        <>
          <Tile to={`/journal/${id}`} icon={<Icon.book />} label="Journal" tone="violet" />
          <Tile to={`/recap/${id}`} icon={<Icon.trophy />} label="Recap" tone="gold" />
        </>
      )}
      <Tile onClick={addToCalendar} icon={<Icon.calplus />} label="Calendar" tone="slate" title="Add every stop to your calendar" />
      <Tile
        onClick={saveOffline}
        busy={busy}
        ok={!!st && !busy}
        icon={st && !busy ? <Icon.done /> : <Icon.download />}
        label={offlineLabel}
        tone="slate"
        title={st ? `Saved ${new Date(st.at).toLocaleString()} · tap to update` : 'Save weather, travel times, photos, nearby places and SOS info for use without signal'}
      />
      {sharing && tripDay && day ? <ShareDaySheet trip={trip} day={tripDay} n={day.n} weather={live.weather.get(day.date)} onClose={() => setSharing(false)} /> : null}
    </nav>
  );
}
