// Settle-up reminders on the open trip ("Asha reminded you to pay ₹200"), live. Kept per trip,
// so going back and forth between the trip and its Expenses page shows them straight away.
import { useEffect, useState } from 'react';
import * as cloud from '../lib/cloud';
import type { Reminder } from '../lib/types';

const cache = new Map<string, Reminder[]>();

export function useReminders(tripId: string | null): Reminder[] {
  const [list, setList] = useState<Reminder[]>(() => (tripId && cache.get(tripId)) || []);
  useEffect(() => {
    if (!tripId) { setList([]); return undefined; }
    setList(cache.get(tripId) || []);
    let off: (() => void) | undefined, gone = false;
    cloud.watchReminders(tripId, (r) => { cache.set(tripId, r); if (!gone) setList(r); })
      .then((u) => { if (gone) u(); else off = u; }, () => {});
    return () => { gone = true; off?.(); };
  }, [tripId]);
  return list;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
