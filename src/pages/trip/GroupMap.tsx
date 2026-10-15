// "Where's everyone?": members can share their live location with the trip — until the end of
// the day or for an hour — and see each other on the trip map. Only trip members can see it, it
// stops by itself, and sharing only runs while the trip is open on your phone.
import { useEffect, useState } from 'react';
import * as cloud from '../../lib/cloud';
import { emit, live, useLive } from '../../lib/live';
import { toast } from '../../lib/toast';
import type { User } from '../../lib/types';
import { distM, fmtDist } from '../../lib/util';
import { Avatars } from '../../components/Icons';
import { mapFocusMember, setGroupSelf } from './TripMap';

const shareKey = (tripId: string) => `gw-share-${tripId}`;
const sharingUntil = (tripId: string): number => { try { return Number(localStorage.getItem(shareKey(tripId))) || 0; } catch { return 0; } };

/**
 * While the trip page is open: keeps your shared location fresh if you're sharing, and keeps
 * the group's locations in the live store while the group map is showing.
 */
export function useGroupSharing(tripId: string | null, user: User | null): void {
  useLive();
  const on = live.groupOn;
  // Everyone's locations, while the group map is open.
  useEffect(() => {
    if (!tripId || !user || !on) return undefined;
    setGroupSelf(user.email);
    let off: (() => void) | undefined, gone = false;
    cloud.watchLocations(tripId, (list) => { live.group = list.filter((l) => l.untilMs > Date.now()); emit(); }).then((u) => { if (gone) u(); else off = u; });
    return () => { gone = true; off?.(); live.group = []; };
  }, [tripId, user, on]);

  // Your own location, while you're sharing (checked every minute, so it stops on time).
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60000); return () => clearInterval(t); }, []);
  const sharing = !!tripId && sharingUntil(tripId) > Date.now();
  useEffect(() => {
    if (!tripId || !user || !sharing || !navigator.geolocation) return undefined;
    let last: { lat: number; lng: number; at: number } | null = null;
    const id = navigator.geolocation.watchPosition((p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      const until = sharingUntil(tripId);
      if (until <= Date.now()) return;
      // Write when moved ~40 m or a minute has passed: fresh enough, and light on battery and data.
      if (last && distM(last, pos) < 40 && Date.now() - last.at < 60000) return;
      last = { ...pos, at: Date.now() };
      cloud.shareLocation(user, tripId, pos, until).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [tripId, user, sharing, tick]);
}

export function GroupPanel({ tripId, user, members, endOfDay }: { tripId: string; user: User; members: string[]; endOfDay: number }) {
  useLive();
  const [, rerender] = useState(0);
  const until = sharingUntil(tripId);
  const sharing = until > Date.now();
  const others = live.group.filter((g) => g.email !== user.email);
  const quiet = members.filter((m) => m !== user.email && !others.some((g) => g.email === m)).length;

  const start = (ms: number) => {
    if (!navigator.geolocation) { toast('Location isn\'t available on this device.', 'bad'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      try { localStorage.setItem(shareKey(tripId), String(ms)); } catch { /* storage unavailable */ }
      cloud.shareLocation(user, tripId, { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }, ms)
        .then(() => toast(`Sharing your location with the trip until ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'ok'), (e: Error) => toast(e.message, 'bad'));
      rerender((n) => n + 1);
    }, () => toast('Couldn\'t get your location. Check that location is allowed for this site.', 'bad'), { enableHighAccuracy: true, timeout: 15000 });
  };
  const stop = () => {
    try { localStorage.removeItem(shareKey(tripId)); } catch { /* storage unavailable */ }
    cloud.stopSharingLocation(user, tripId).then(() => toast('Stopped sharing your location', 'ok'), () => {});
    rerender((n) => n + 1);
  };

  return (
    <div className="group-panel">
      <div className="gp-head">
        <strong>👥 Where's everyone?</strong>
        <button className="icon-btn" type="button" aria-label="Close the group map" onClick={() => { live.groupOn = false; emit(); }}>✕</button>
      </div>
      {sharing ? (
        <div className="gp-share on">
          <span className="gp-pulse" aria-hidden="true" />
          <span>Sharing your location until <strong>{new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong></span>
          <button className="btn ghost small" type="button" onClick={stop}>Stop</button>
        </div>
      ) : (
        <div className="gp-share">
          <span>Share your location with the trip:</span>
          <span className="gp-btns">
            <button className="btn small" type="button" onClick={() => start(endOfDay)}>Until tonight</button>
            <button className="btn ghost small" type="button" onClick={() => start(Date.now() + 3600000)}>For 1 hour</button>
          </span>
        </div>
      )}
      {others.length ? (
        <ul className="gp-list">
          {others.map((g) => {
            const ago = Math.round((Date.now() - g.atMs) / 60000);
            return (
              <li key={g.email}>
                <button type="button" className="gp-person" onClick={() => mapFocusMember(g.email)}>
                  <Avatars emails={[g.email]} />
                  <span className="gp-name">{g.email.split('@')[0]}</span>
                  <span className="muted small">{live.pos ? `${fmtDist(distM(live.pos, g))} away · ` : ''}{ago < 1 ? 'just now' : `${ago} min ago`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="fine">Nobody else is sharing right now.</p>}
      {quiet ? <p className="fine">{quiet} other{quiet === 1 ? ' isn\'t' : 's aren\'t'} sharing. Only people on this trip can see shared locations, and sharing stops by itself.</p> : null}
    </div>
  );
}
