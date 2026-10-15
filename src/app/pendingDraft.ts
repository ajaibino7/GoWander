// A trip to start the editor with (from a template, or "plan again with the favourites"), handed
// over in memory: the editor for a new trip opens with it instead of a blank trip.
import type { DraftTrip } from '../lib/types';

let pending: DraftTrip | null = null;
export const setPendingDraft = (d: DraftTrip): void => { pending = structuredClone(d); };
/** Read without clearing (React may build the editor's first state twice in development). */
export const peekPendingDraft = (): DraftTrip | null => (pending ? structuredClone(pending) : null);
export const clearPendingDraft = (): void => { pending = null; };
