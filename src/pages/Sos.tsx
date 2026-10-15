// #/sos/:id — help, fast: the local emergency numbers (tap to call), the nearest hospitals,
// police stations and pharmacies (from OpenStreetMap, saved on the device so it works offline),
// your stay's name and address big enough to show a driver, and your location to send someone.
import { useEffect, useState } from 'react';
import { TripSubPage, type TripCtx } from '../app/TripSubPage';
import { Icon } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import { mapsLink } from '../lib/plan';
import { cachedHelp, emergencyFor, nearestHelp, telOf, type HelpKind, type HelpPlace } from '../lib/sos';
import { toast } from '../lib/toast';
import type { LatLng, Place } from '../lib/types';
import { directionsUrl, fmtDist, makeClock } from '../lib/util';

const KINDS: { k: HelpKind; label: string; icon: string }[] = [
  { k: 'hospital', label: 'Hospitals', icon: '🏥' },
  { k: 'police', label: 'Police', icon: '👮' },
  { k: 'pharmacy', label: 'Pharmacies', icon: '💊' },
];

export function SosPage() {
  return (
    <TripSubPage viewId="view-sos" eyebrow="SOS · Help nearby" allowSample foot="Numbers and places are saved on this device after the first look, so they work without signal.">
      {(ctx) => <SosBody ctx={ctx} />}
    </TripSubPage>
  );
}

// Where to look from, until you share your location: today's (or the first) day's first stop.
function tripCentre(ctx: TripCtx): Place | null {
  const today = makeClock(ctx.trip.timezone).dateKey(new Date());
  const day = ctx.trip.days.find((d) => d.date === today && d.stops.length) || ctx.trip.days.find((d) => d.stops.length);
  return day?.stops[0]?.place || null;
}

function SosBody({ ctx }: { ctx: TripCtx }) {
  const country = emergencyFor(ctx.trip.timezone);
  const [me, setMe] = useState<(LatLng & { accuracy?: number }) | null>(null);
  const [locating, setLocating] = useState(false);
  const centre = me || tripCentre(ctx);
  const [help, setHelp] = useState<HelpPlace[] | null>(() => (centre ? cachedHelp(centre) : null));
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [kind, setKind] = useState<HelpKind>('hospital');
  const [driver, setDriver] = useState<{ title: string; place: Place } | null>(null);

  useEffect(() => {
    if (!centre) return;
    let gone = false;
    const known = cachedHelp(centre);
    if (known) setHelp(known);
    if (!navigator.onLine) { if (!known) setStatus('error'); return undefined; }
    setStatus('loading');
    nearestHelp(centre).then((items) => { if (!gone) { setHelp(items); setStatus('idle'); } }, () => { if (!gone) setStatus(known ? 'idle' : 'error'); });
    return () => { gone = true; };
  }, [centre?.lat, centre?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const locate = () => {
    if (!navigator.geolocation) { toast('Location isn\'t available on this device.', 'bad'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocating(false); setMe({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
      () => { setLocating(false); toast('Couldn\'t get your location. Check that location is allowed for this site.', 'bad'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };
  const sendMyLocation = async () => {
    if (!me) { locate(); return; }
    const text = `I'm here: ${mapsLink(me)}`;
    try {
      if (typeof navigator.share === 'function') await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('Location link copied. Paste it into a message.', 'ok'); }
    } catch (e) { if ((e as Error).name !== 'AbortError') toast(text, 'info', { duration: 12000 }); }
  };

  // Where you're staying: stay stops, then anything that sounds like a hotel.
  const stays = new Map<string, { title: string; place: Place; phone?: string }>();
  for (const d of ctx.trip.days) {
    for (const s of d.stops) {
      if (s.kind === 'stay' || /\b(hotel|resort|hostel|homestay|villa|stay|airbnb|lodge)\b/i.test(`${s.title} ${s.place.name}`)) {
        const k = `${s.place.lat.toFixed(4)},${s.place.lng.toFixed(4)}`;
        if (!stays.has(k)) stays.set(k, { title: s.place.name, place: s.place, phone: s.booking?.phone });
      }
    }
  }
  const list = (help || []).filter((x) => x.kind === kind);

  return (
    <>
      <section className="ed-card sos-numbers">
        <h2 className="sec-h">Emergency numbers{country.name ? <span className="muted small"> · {country.name}</span> : null}</h2>
        <div className="sos-grid">
          {country.numbers.map((x, i) => (
            <a key={x.number + x.label} className={`sos-call${i === 0 ? ' main' : ''}`} href={`tel:${x.number}`}>
              <span className="sos-ic" aria-hidden="true">{x.icon}</span>
              <span className="sos-num">{x.number}</span>
              <span className="sos-l">{x.label}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="ed-card">
        <div className="sec-row">
          <h2 className="sec-h">Nearest help</h2>
          <button className="btn ghost small" type="button" disabled={locating} onClick={locate}>{locating ? 'Finding you…' : me ? '📍 Update my location' : '📍 Use my location'}</button>
        </div>
        <p className="fine">{me ? `Around you${me.accuracy ? ` (±${fmtDist(me.accuracy)})` : ''}.` : tripCentre(ctx) ? `Around ${tripCentre(ctx)?.name}. Use your location for what's closest to you.` : 'Use your location to find what\'s closest.'}</p>
        <div className="seg" role="tablist" aria-label="Kind of help">
          {KINDS.map((x) => (
            <button key={x.k} type="button" role="tab" aria-selected={kind === x.k} className={`seg-b${kind === x.k ? ' on' : ''}`} onClick={() => setKind(x.k)}>{x.icon} {x.label}</button>
          ))}
        </div>
        {status === 'loading' && !help ? <div className="home-skel"><div className="sk-line" /><div className="sk-line w40" /></div> : null}
        {status === 'error' && !help ? <p className="status-msg warn">Couldn't look up nearby places{navigator.onLine ? '. The map service may be busy; try again in a minute.' : ' while offline. Save the trip for offline use next time you have signal.'}</p> : null}
        {help ? (
          list.length ? (
            <ul className="help-list">
              {list.map((x) => (
                <li key={x.id} className="help-item">
                  <span className="help-main">
                    <strong>{x.name}</strong>
                    <span className="muted small">{fmtDist(x.dist)} away{x.open24 ? ' · 24 hours' : ''}</span>
                  </span>
                  <span className="help-act">
                    {x.phone ? <a className="btn ghost small" href={`tel:${telOf(x.phone)}`} aria-label={`Call ${x.name}`}><Icon.phone /></a> : null}
                    <a className="btn small" href={directionsUrl(x)} target="_blank" rel="noopener">Go</a>
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="fine">None found within about 4 km on OpenStreetMap.</p>
        ) : null}
      </section>

      <section className="ed-card">
        <h2 className="sec-h">Show the driver</h2>
        <p className="fine">Your stay's name and address in big letters, and your location to send someone.</p>
        <div className="driver-list">
          {[...stays.values()].map((s) => (
            <button key={s.title} className="driver-btn" type="button" onClick={() => setDriver(s)}>
              <span aria-hidden="true">🏨</span><span><strong>{s.title}</strong>{s.phone ? <span className="muted small"> · {s.phone}</span> : null}</span><span aria-hidden="true">›</span>
            </button>
          ))}
          {!stays.size ? <p className="fine">Add your hotel as a <strong>Stay / rest</strong> stop and it shows up here.</p> : null}
          <button className="btn ghost" type="button" onClick={sendMyLocation}>📤 Send my location</button>
        </div>
      </section>

      {driver ? (
        <Sheet title="Please take me here" onClose={() => setDriver(null)} className="driver-sheet">
          <div className="driver-big">{driver.place.name}</div>
          <div className="driver-coords mono">{driver.place.lat.toFixed(5)}, {driver.place.lng.toFixed(5)}</div>
          <div className="driver-acts">
            <a className="btn" href={directionsUrl(driver.place)} target="_blank" rel="noopener">Open in Maps</a>
            <a className="btn ghost" href={mapsLink(driver.place)} target="_blank" rel="noopener">Show on map</a>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
