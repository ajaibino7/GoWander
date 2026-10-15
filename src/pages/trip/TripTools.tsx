// The tools bar on a trip: Checklist, Expenses, Add to calendar, Save offline.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as cloud from '../../lib/cloud';
import { downloadIcs, type IcsResult } from '../../lib/calendar';
import { makeOfflineReady, offlineStatus } from '../../lib/offline';
import { live } from '../../lib/live';
import { toast } from '../../lib/toast';
import type { ChecklistItem, Trip } from '../../lib/types';
import { Icon } from '../../components/Icons';

// While saving for offline use (kept across visits to the trip page).
let offlineRun: { tripId: string; done: number; total: number } | null = null;

export function TripTools({ trip, sample = false }: { trip: Trip; sample?: boolean }) {
  const [, rerender] = useState(0);
  const refresh = () => rerender((n) => n + 1);
  const st = offlineStatus(trip.id);
  const busy = offlineRun?.tripId === trip.id;
  const label = busy && offlineRun
    ? `Saving ${Math.min(offlineRun.done + 1, offlineRun.total)} of ${offlineRun.total}…`
    : st ? 'Saved offline' : 'Save offline';

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
        : `Ready offline: weather, travel times, photo and nearby places for ${r.places} place${r.places === 1 ? '' : 's'}.`, r.failed ? 'info' : 'ok');
    } finally {
      offlineRun = null;
      refresh();
    }
  };

  const id = encodeURIComponent(trip.id);
  return (
    <nav className="trip-tools" aria-label="Trip tools">
      {sample ? null : (
        <>
          <Link className="tool" to={`/checklist/${id}`}><Icon.check /><span>Checklist</span></Link>
          <Link className="tool" to={`/expenses/${id}`}><Icon.wallet /><span>Expenses</span></Link>
        </>
      )}
      <button className="tool" type="button" onClick={addToCalendar}><Icon.calplus /><span>Add to calendar</span></button>
      <button
        className={`tool${st && !busy ? ' ok' : ''}`}
        type="button"
        disabled={busy}
        onClick={saveOffline}
        title={st ? `Saved ${new Date(st.at).toLocaleString()} · tap to update` : 'Save weather, travel times, photos and nearby places for use without signal'}
      >
        {st && !busy ? <Icon.done /> : <Icon.download />}<span>{label}</span>
      </button>
    </nav>
  );
}
