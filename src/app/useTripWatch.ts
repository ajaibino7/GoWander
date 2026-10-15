// Watching one of your trips from a page about it (members, checklist, expenses): live updates,
// the cover photo, and what to do if you're not a member or the trip is deleted.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as cloud from '../lib/cloud';
import { toast } from '../lib/toast';
import type { TripEntry, User } from '../lib/types';
import { ensureAutoCover, useUploadedCover } from './covers';

export function useTripWatch(id: string, user: User | null): { entry: TripEntry | null; denied: boolean; retry: () => void } {
  const navigate = useNavigate();
  const [entry, setEntry] = useState<TripEntry | null>(null);
  const [denied, setDenied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useUploadedCover(user ? id : null);

  useEffect(() => {
    setEntry(null);
    setDenied(false);
    if (!user) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    cloud.watchTrip(id, (e) => {
      if (!e) { toast('This trip was deleted, or you were removed from it.', 'bad'); navigate('/', { replace: true }); return; }
      setDenied(false);
      setEntry(e);
      ensureAutoCover(e.trip);
    }, (err) => { if (err === 'denied') setDenied(true); else toast(err, 'bad'); })
      .then((u) => { if (cancelled) u(); else off = u; });
    return () => { cancelled = true; off?.(); };
  }, [id, user, navigate, attempt]);

  return { entry, denied, retry: () => setAttempt((n) => n + 1) };
}

export const nameOf = (email: string, user: User | null): string => (email === user?.email ? 'You' : (email || '').split('@')[0] || '');
