// The top of the home screen: a greeting by name for the time of day, today's date, a line
// about what's next (a trip in progress, the next one, or a nudge to plan one) and the weather
// where you are. Its colours follow the time of day.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GREETING, dayPart, firstName, type DayPart } from '../lib/greeting';
import { cachedLocalWeather, fetchLocalWeather, isFresh, locationPermission, type LocalWeather } from '../lib/localWeather';
import { UNIT } from '../lib/weather';
import { makeClock } from '../lib/util';
import type { Trip, User } from '../lib/types';
import type { TripStatus } from '../lib/tripStatus';

const PART_ICON: Record<DayPart, string> = { morning: '🌅', afternoon: '☀️', evening: '🌇', night: '🌙' };

// Re-render on the minute, so the greeting and date roll over by themselves.
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function HomeToday({ user, rows }: { user: User; rows: { trip: Trip; st: TripStatus }[] }) {
  const now = useMinute();
  const part = dayPart(now);
  const name = firstName(user);
  const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <section className={`today ed-card tod-${part}`} aria-label="Today">
      <div className="td-hi">
        <div className="td-k"><span aria-hidden="true">{PART_ICON[part]}</span> {date}</div>
        <h2 className="td-name">{GREETING[part]}{name ? <>, <span className="td-you">{name}</span></> : null}<span className="td-wave" aria-hidden="true"> 👋</span></h2>
      </div>
      <NextUp rows={rows} />
      <WeatherTile />
    </section>
  );
}

// One line about what's next, with a way straight there.
function NextUp({ rows }: { rows: { trip: Trip; st: TripStatus }[] }) {
  const live = rows.find((r) => r.st.key === 'live');
  const soon = rows.find((r) => r.st.key === 'soon');
  if (live) {
    const today = makeClock(live.trip.timezone).dateKey(new Date());
    const n = live.trip.days.findIndex((d) => d.date === today) + 1;
    return (
      <p className="td-line">
        {n ? <>You're on <strong>Day {n}</strong> of <strong>{live.trip.title}</strong>. Have a wonderful day!</> : <><strong>{live.trip.title}</strong> is under way. Enjoy it!</>}
        {' '}<Link className="td-go" to={`/trip/${encodeURIComponent(live.trip.id)}`}>Open trip →</Link>
      </p>
    );
  }
  if (soon) {
    const days = soon.st.at ? Math.ceil((soon.st.at - Date.now()) / 86400000) : 99;
    const when = days <= 1 ? 'tomorrow' : `in ${days} days`;
    return (
      <p className="td-line">
        <strong>{soon.trip.title}</strong> starts {when}.{days <= 7 ? ' Time to start packing? 🎒' : ''}
        {' '}<Link className="td-go" to={`/trip/${encodeURIComponent(soon.trip.id)}`}>{days <= 7 ? 'Get ready →' : 'View plan →'}</Link>
      </p>
    );
  }
  return (
    <p className="td-line">
      Where to next? Plan your next getaway in a few minutes.
      {' '}<Link className="td-go" to="/new">Plan a trip →</Link>
    </p>
  );
}

// The weather where you are: shown straight away from the last reading, refreshed in the
// background. Location is only used if you've allowed it (or tap to allow it).
function WeatherTile() {
  const [wx, setWx] = useState<LocalWeather | null>(cachedLocalWeather);
  const [perm, setPerm] = useState<PermissionState | 'unsupported' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    locationPermission().then((p) => {
      if (gone) return;
      setPerm(p);
      if (p === 'granted' && !isFresh(cachedLocalWeather())) {
        setBusy(true);
        fetchLocalWeather().then((w) => { if (!gone) { if (w) setWx(w); setBusy(false); } });
      }
    });
    return () => { gone = true; };
  }, []);

  const ask = () => {
    setBusy(true);
    fetchLocalWeather().then((w) => {
      setBusy(false);
      if (w) { setWx(w); setPerm('granted'); } else locationPermission().then(setPerm);
    });
  };

  if (wx) {
    return (
      <div className="td-wx" title={`Updated ${new Date(wx.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}>
        <span className="td-wx-ic" aria-hidden="true">{wx.icon}</span>
        <span className="td-wx-t">{wx.temp}°<small>{UNIT}</small></span>
        {wx.place ? <span className="td-wx-p">📍 {wx.place}</span> : null}
        <span className="td-wx-l">{wx.label}</span>
        {Number.isFinite(wx.max) ? <span className="td-wx-hl"><span title="Today's high">↑ {wx.max}°</span><span title="Today's low">↓ {wx.min}°</span></span> : null}
      </div>
    );
  }
  if (busy || perm === null) return <div className="td-wx loading" aria-label="Loading the weather"><span className="td-sk" /><span className="td-sk s" /></div>;
  if (perm === 'denied' || perm === 'unsupported') return null;
  return (
    <button className="td-wx ask" type="button" onClick={ask}>
      <span className="td-wx-ic" aria-hidden="true">🌤️</span>
      <span className="td-wx-p">Local weather</span>
      <span className="td-wx-l">Tap to use your location</span>
    </button>
  );
}
