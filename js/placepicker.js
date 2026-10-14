// Modal for choosing a stop's location: search by name (OpenStreetMap), tap/drag on the map,
// paste a Google Maps link or "lat, lng", or reuse a place already in the trip.
import { esc } from './util.js';

const RADII = [100, 200, 300, 400, 600, 800, 1200, 2000, 3000];
const AREA_TYPES = ['city', 'town', 'village', 'suburb', 'neighbourhood', 'quarter', 'administrative', 'hamlet'];

// Pulls coordinates out of a Google/Apple/OSM maps URL or a plain "lat, lng".
export function parseCoords(s) {
  const pats = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/, // Google place pin
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/, // Google viewport
    /[?&](?:q|ll|query|destination|daddr|center)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i,
    /[?&]mlat=(-?\d+(?:\.\d+)?)&mlon=(-?\d+(?:\.\d+)?)/, // openstreetmap.org
    /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    }
  }
  return null;
}

export function openPlacePicker({ place = null, recent = [] } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('modal');
    let pin = place ? { lat: place.lat, lng: place.lng } : null;
    const nearestRadius = (r) => RADII.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), RADII[3]);

    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Choose a location">
        <div class="modal-h"><strong>Choose location</strong><button type="button" class="icon-btn" data-a="x" aria-label="Close">✕</button></div>
        <form class="pp-search" data-a="search-form">
          <input id="pp-q" type="search" placeholder="Search a place, or paste a maps link" autocomplete="off">
          <button class="btn small" type="submit">Search</button>
        </form>
        <div id="pp-results" class="pp-results"></div>
        <div id="pp-map" class="pp-map"></div>
        <div class="pp-hint">Tap the map to drop the pin, or drag it to fine-tune.</div>
        <div class="pp-chips">
          <button type="button" class="mini" data-a="me">📍 My current location</button>
          ${recent.map((p, i) => `<button type="button" class="mini" data-recent="${i}">${esc(p.name)}</button>`).join('')}
        </div>
        <label class="fld"><span>Name</span><input id="pp-name" maxlength="160" value="${esc(place?.name || '')}" placeholder="e.g. Baga Beach"></label>
        <label class="fld"><span>Counts as “arrived” within</span>
          <select id="pp-radius">${RADII.map((r) => `<option value="${r}">${r < 1000 ? `${r} m` : `${r / 1000} km`}</option>`).join('')}</select>
          <small>Use a bigger circle for beaches, markets, neighbourhoods or whole towns.</small>
        </label>
        <div class="pp-err" id="pp-err" hidden></div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-a="x">Cancel</button>
          <button type="button" class="btn" data-a="ok">Use this place</button>
        </div>
      </div>`;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const q = (sel) => modal.querySelector(sel);
    q('#pp-radius').value = String(nearestRadius(place?.radius || 400));

    // ---- map ----
    const start = pin || recent[recent.length - 1] || null;
    const map = L.map(q('#pp-map')).setView(start ? [start.lat, start.lng] : [20.6, 78.9], start ? 15 : 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    let marker = null;
    function setPin(lat, lng, { zoom = false, name, radius } = {}) {
      pin = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
      if (!marker) {
        marker = L.marker([pin.lat, pin.lng], { draggable: true }).addTo(map);
        marker.on('dragend', () => { const ll = marker.getLatLng(); pin = { lat: Number(ll.lat.toFixed(6)), lng: Number(ll.lng.toFixed(6)) }; });
      } else marker.setLatLng([pin.lat, pin.lng]);
      if (zoom) map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 16));
      if (name) q('#pp-name').value = name;
      if (radius) q('#pp-radius').value = String(nearestRadius(radius));
      q('#pp-err').hidden = true;
    }
    if (pin) setPin(pin.lat, pin.lng);
    map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng));
    setTimeout(() => map.invalidateSize(), 50);

    // ---- search ----
    async function search() {
      const text = q('#pp-q').value.trim();
      const out = q('#pp-results');
      if (!text) return;
      const coords = parseCoords(text);
      if (coords) { setPin(coords.lat, coords.lng, { zoom: true }); out.innerHTML = ''; return; }
      if (/goo\.gl|maps\.app/i.test(text)) {
        out.innerHTML = '<div class="pp-msg">Short links can\'t be read here. Open the link, then copy the full address from the browser bar (it contains the coordinates).</div>';
        return;
      }
      out.innerHTML = '<div class="pp-msg">Searching…</div>';
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=en&q=${encodeURIComponent(text)}`);
        const items = await res.json();
        if (!items.length) { out.innerHTML = '<div class="pp-msg">No matches. Try adding the city, or tap the map instead.</div>'; return; }
        out.innerHTML = items.map((r, i) => `<button type="button" class="pp-item" data-res="${i}"><strong>${esc(r.name || r.display_name.split(',')[0])}</strong><span>${esc(r.display_name)}</span></button>`).join('');
        out.onclick = (e) => {
          const b = e.target.closest('[data-res]');
          if (!b) return;
          const r = items[Number(b.dataset.res)];
          setPin(Number(r.lat), Number(r.lon), { zoom: true, name: r.name || r.display_name.split(',')[0], radius: AREA_TYPES.includes(r.type) || r.addresstype === 'city' ? 1200 : 300 });
          out.innerHTML = '';
        };
      } catch {
        out.innerHTML = '<div class="pp-msg">Search is unavailable right now. Tap the map or paste coordinates instead.</div>';
      }
    }

    function close(result) {
      map.remove();
      modal.hidden = true;
      modal.innerHTML = '';
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);

    q('[data-a="search-form"]').addEventListener('submit', (e) => { e.preventDefault(); search(); });
    modal.querySelector('.modal-card').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.recent) {
        const p = recent[Number(b.dataset.recent)];
        setPin(p.lat, p.lng, { zoom: true, name: p.name, radius: p.radius });
        return;
      }
      switch (b.dataset.a) {
        case 'x': close(null); break;
        case 'me':
          b.textContent = 'Finding you…';
          navigator.geolocation?.getCurrentPosition(
            (p) => { setPin(p.coords.latitude, p.coords.longitude, { zoom: true }); b.textContent = '📍 My current location'; },
            () => { b.textContent = 'Location unavailable'; },
            { enableHighAccuracy: true, timeout: 15000 },
          );
          break;
        case 'ok': {
          if (!pin) { const err = q('#pp-err'); err.textContent = 'Drop a pin on the map or pick a search result first.'; err.hidden = false; return; }
          close({ name: q('#pp-name').value.trim() || 'Pinned place', lat: pin.lat, lng: pin.lng, radius: Number(q('#pp-radius').value) });
          break;
        }
      }
    });
    modal.onclick = (e) => { if (e.target === modal) close(null); };
    q('#pp-q').focus();
  });
}
