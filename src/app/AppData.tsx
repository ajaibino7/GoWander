// App-wide data: who's signed in, the trips they're a member of (live from Firestore), and the
// bundled sample trips.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as cloud from '../lib/cloud';
import { loadSamples } from '../lib/store';
import { toast } from '../lib/toast';
import type { Trip, TripEntry, User } from '../lib/types';

export interface AppDataValue {
  user: User | null;
  /** Firebase has said who's signed in (or that nobody is). */
  authReady: boolean;
  samples: Trip[];
  samplesReady: boolean;
  myTrips: TripEntry[];
  /** The first trip list arrived (until then the home page shows placeholders). */
  myTripsLoaded: boolean;
}

const Ctx = createContext<AppDataValue | null>(null);

export function useAppData(): AppDataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData outside AppDataProvider');
  return v;
}

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [samples, setSamples] = useState<Trip[]>([]);
  const [samplesReady, setSamplesReady] = useState(false);
  const [myTrips, setMyTrips] = useState<TripEntry[]>([]);
  const [myTripsLoaded, setMyTripsLoaded] = useState(false);

  useEffect(() => {
    loadSamples().then((s) => { setSamples(s); setSamplesReady(true); });
  }, []);

  useEffect(() => {
    let off: (() => void) | void;
    let cancelled = false;
    cloud.onUserChange((u) => {
      // Same person again (e.g. a token refresh): keep the existing object so nothing re-renders.
      setUser((prev) => (prev?.uid === u?.uid && prev?.email === u?.email ? prev : u));
      setAuthReady(true);
    }).then((unsub) => { if (cancelled) unsub?.(); else off = unsub; });
    return () => { cancelled = true; off?.(); };
  }, []);

  // The signed-in person's trips, live.
  useEffect(() => {
    setMyTrips([]);
    setMyTripsLoaded(false);
    if (!user) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    cloud.watchMyTrips(user, (list) => { setMyTrips(list); setMyTripsLoaded(true); }, (err) => { setMyTripsLoaded(true); toast(err, 'bad'); })
      .then((u) => { if (cancelled) u(); else off = u; });
    return () => { cancelled = true; off?.(); };
  }, [user]);

  return (
    <Ctx.Provider value={{ user, authReady, samples, samplesReady, myTrips, myTripsLoaded }}>
      {children}
    </Ctx.Provider>
  );
}
