// Saving a change to the plan made outside the editor (an idea or poll winner added to a day,
// the day shifted because you're running late). If someone else saved since this copy of the
// trip arrived, ask before overwriting their change.
import * as cloud from '../lib/cloud';
import { ask, toast } from '../lib/toast';
import type { Trip, TripEntry, User } from '../lib/types';

export async function savePlanChange(user: User, entry: TripEntry, next: Trip, done: string): Promise<boolean> {
  try {
    await cloud.updateTrip(user, entry.trip.id, next, entry.meta.updatedAtMs);
  } catch (e) {
    if (e instanceof cloud.ConflictError) {
      const who = e.by ? e.by.split('@')[0] : 'Someone';
      if (!(await ask(`${who} just changed the plan.`, { detail: 'Apply your change on top of the version you were looking at? Their latest edits to this day may be replaced.', ok: 'Apply anyway' }))) return false;
      try { await cloud.updateTrip(user, entry.trip.id, next, entry.meta.updatedAtMs, { force: true }); } catch (e2) { toast((e2 as Error).message, 'bad'); return false; }
    } else {
      toast((e as Error).message, 'bad');
      return false;
    }
  }
  toast(done, 'ok');
  return true;
}
