// Choosing a stop's location: search by name (OpenStreetMap), tap/drag on the map, paste a Google
// Maps link or "lat, lng", or reuse a place already in the trip. A bottom sheet on phones.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Map as LMap, Marker } from 'leaflet';
import { parseCoords } from '../../lib/editing';
import type { LatLng, Place } from '../../lib/types';

// Leaflet is loaded when the picker opens; markers are only made once the map exists.
let L!: typeof import('leaflet');

const RADII = [100, 200, 300, 400, 600, 800, 1200, 2000, 3000];
const AREA_TYPES = ['city', 'town', 'village', 'suburb', 'neighbourhood', 'quarter', 'administrative', 'hamlet'];
const nearestRadius = (r: number) => RADII.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), RADII[3] as number);
const fmtRadius = (r: number) => (r < 1000 ? `${r} m` : `${r / 1000} km`);

interface SearchHit { lat: string; lon: string; name?: string; display_name: string; type?: string; addresstype?: string }

export function PlacePicker({ place, recent, onClose }: { place: Place | null; recent: Place[]; onClose: (p: Place | null) => void }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const pin = useRef<LatLng | null>(place ? { lat: place.lat, lng: place.lng } : null);
  const [name, setName] = useState(place?.name || '');
  const [radius, setRadius] = useState(nearestRadius(place?.radius || 400));
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [meLabel, setMeLabel] = useState('📍 My current location');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  function setPin(lat: number, lng: number, { zoom = false, name: n, radius: r }: { zoom?: boolean; name?: string; radius?: number } = {}) {
    pin.current = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
    const m = map.current;
    if (m) {
      if (!marker.current) {
        const mk = L.marker([pin.current.lat, pin.current.lng], { draggable: true }).addTo(m);
        mk.on('dragend', () => { const ll = mk.getLatLng(); pin.current = { lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) }; });
        marker.current = mk;
      } else marker.current.setLatLng([pin.current.lat, pin.current.lng]);
      if (zoom) m.setView([pin.current.lat, pin.current.lng], Math.max(m.getZoom(), 16));
    }
    if (n) setName(n);
    if (r) setRadius(nearestRadius(r));
    setErr('');
  }

  // ---- map ----
  useEffect(() => {
    let gone = false, t: ReturnType<typeof setTimeout> | undefined;
    import('../../lib/leaflet').then((lf) => {
      if (gone || !mapEl.current) return;
      L = lf.default;
      const start = pin.current || recent[recent.length - 1] || null;
      const m = L.map(mapEl.current).setView(start ? [start.lat, start.lng] : [20.6, 78.9], start ? 15 : 4);
      L.tileLayer(lf.TILE_URL, { maxZoom: 19, attribution: lf.TILE_ATTRIBUTION }).addTo(m);
      map.current = m;
      if (pin.current) setPin(pin.current.lat, pin.current.lng);
      m.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng));
      t = setTimeout(() => m.invalidateSize(), 50);
    });
    return () => { gone = true; clearTimeout(t); map.current?.remove(); map.current = null; marker.current = null; };
  }, []);

  // Escape closes; the page behind doesn't scroll while the sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(null); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => { document.removeEventListener('keydown', onKey); if (!document.querySelector('.modal')) document.body.classList.remove('modal-open'); };
  }, []);

  // ---- search ----
  async function search() {
    const text = query.trim();
    if (!text) return;
    const coords = parseCoords(text);
    if (coords) { setPin(coords.lat, coords.lng, { zoom: true }); setResults(null); setMsg(''); return; }
    setResults(null);
    if (/goo\.gl|maps\.app/i.test(text)) {
      setMsg('Short links can\'t be read here. Open the link, then copy the full address from the browser bar (it contains the coordinates).');
      return;
    }
    setMsg('Searching…');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(text)}`);
      const items: SearchHit[] = await res.json();
      if (!items.length) { setMsg('No matches. Try adding the city, or tap the map instead.'); return; }
      setMsg('');
      setResults(items);
    } catch {
      setMsg('Search is unavailable right now. Tap the map or paste coordinates instead.');
    }
  }

  const titleOf = (r: SearchHit) => r.name || r.display_name.split(',')[0] || '';

  return createPortal(
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(null); }}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Choose a location">
        <div className="modal-h"><strong>Choose location</strong><button type="button" className="icon-btn" aria-label="Close" onClick={() => onClose(null)}>✕</button></div>
        {/* stopPropagation: React passes a portal's events up to its React parents, and the
            editor around this picker is a form whose submit saves the trip. */}
        <form className="pp-search" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); search(); }}>
          <input type="search" placeholder="Search a place, or paste a maps link" autoComplete="off" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn small" type="submit">Search</button>
        </form>
        <div className="pp-results">
          {msg ? <div className="pp-msg">{msg}</div> : null}
          {results?.map((r, i) => (
            <button key={i} type="button" className="pp-item" onClick={() => {
              setPin(Number(r.lat), Number(r.lon), { zoom: true, name: titleOf(r), radius: AREA_TYPES.includes(r.type || '') || r.addresstype === 'city' ? 1200 : 300 });
              setResults(null);
            }}>
              <strong>{titleOf(r)}</strong><span>{r.display_name}</span>
            </button>
          ))}
        </div>
        <div ref={mapEl} className="pp-map" />
        <div className="pp-hint">Tap the map to drop the pin, or drag it to fine-tune.</div>
        <div className="pp-chips">
          <button type="button" className="mini" onClick={() => {
            setMeLabel('Finding you…');
            navigator.geolocation?.getCurrentPosition(
              (p) => { setPin(p.coords.latitude, p.coords.longitude, { zoom: true }); setMeLabel('📍 My current location'); },
              () => setMeLabel('Location unavailable'),
              { enableHighAccuracy: true, timeout: 15000 },
            );
          }}>{meLabel}</button>
          {recent.map((p, i) => (
            <button key={i} type="button" className="mini" onClick={() => setPin(p.lat, p.lng, { zoom: true, name: p.name, radius: p.radius })}>{p.name}</button>
          ))}
        </div>
        <label className="fld"><span>Name</span><input maxLength={160} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Baga Beach" /></label>
        <label className="fld"><span>Counts as “arrived” within</span>
          <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {RADII.map((r) => <option key={r} value={r}>{fmtRadius(r)}</option>)}
          </select>
          <small>Use a bigger circle for beaches, markets, neighbourhoods or whole towns.</small>
        </label>
        {err ? <div className="pp-err">{err}</div> : null}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={() => onClose(null)}>Cancel</button>
          <button type="button" className="btn" onClick={() => {
            if (!pin.current) { setErr('Drop a pin on the map or pick a search result first.'); return; }
            onClose({ name: name.trim() || 'Pinned place', lat: pin.current.lat, lng: pin.current.lng, radius });
          }}>Use this place</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
