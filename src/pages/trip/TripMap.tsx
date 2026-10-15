// The trip map: numbered pins for the selected day's places, the dotted route, your location,
// and the "What to do nearby" pins. Leaflet is driven imperatively from the live state; markers
// are only rebuilt when something visible changed, so open popups survive the clock tick.
import { useEffect, useRef } from 'react';
import type { Map as LMap, LayerGroup, Marker, LatLngExpression, LatLngTuple } from 'leaflet';
import { emit, live, stopState, now, useLive, type LiveStop, type NearbyState } from '../../lib/live';
import { intentFor } from '../../lib/nearby';
import { esc, directionsUrl, fmtDist, fmtHHMM, prefersReducedMotion, THEME_COLORS } from '../../lib/util';
import { avatarColor } from '../../components/Icons';
import { displayName } from '../../app/names';

// Leaflet arrives with the map (see TripMap); everything below runs only once the map exists.
let L!: typeof import('leaflet');
let layer: LayerGroup | null = null, meLayer: LayerGroup | null = null, nearLayer: LayerGroup | null = null, groupLayer: LayerGroup | null = null;
let lastGroupSig = '', groupFitted = false;
let lastMapDay: number | null = null, lastMapSig = '', lastRefit = -1, lastNearbyKey: unknown = null, lastNearbySig = '';
const stopMarkers = new Map<string, Marker>();
const nearMarkers = new Map<string, Marker>();

// One stop at this pin: search for what it's for. Several (check-in, dinner, breakfast…): the general list.
function nearbyPopupBtn(stops: LiveStop[]): string {
  const first = stops[0];
  if (!first) return '';
  const one = stops.length === 1;
  return `<button type="button" class="link-btn" data-nearby="${esc(first.id)}"${one ? '' : ' data-nb-general'}>${esc(one ? intentFor(first).button : 'What to do nearby')}</button>`;
}

function renderStops(map: LMap): void {
  if (!layer) return;
  const t = now();
  const day = live.days.find((d) => d.n === live.selectedDay);
  if (!day) { layer.clearLayers(); stopMarkers.clear(); map.setView([20.6, 78.9], 4); lastMapSig = ''; return; }
  const color = THEME_COLORS[day.theme];
  // Only rebuild markers when something visible changed, so open popups survive the clock tick.
  const sig = `${live.trip?.id}|${day.n}|${day.stops.map((s) => `${s.id}:${s.place.lat},${s.place.lng}:${stopState(s, t)}`).join(',')}`;
  const refit = lastRefit !== live.refit || lastMapDay !== day.n;
  if (sig !== lastMapSig) {
    lastMapSig = sig;
    layer.clearLayers();
    stopMarkers.clear();
    // One marker per distinct place, numbered by first appearance.
    const seen = new Map<string, { place: LiveStop['place']; stops: LiveStop[] }>();
    for (const s of day.stops) {
      const key = `${s.place.lat},${s.place.lng}`;
      const g = seen.get(key) || { place: s.place, stops: [] };
      g.stops.push(s);
      seen.set(key, g);
    }
    [...seen.values()].forEach((g, i) => {
      const states = g.stops.map((s) => stopState(s, t));
      const cls = states.includes('now') ? 'now' : states.every((x) => x === 'done' || x === 'past') ? 'done' : '';
      const icon = L.divIcon({ className: '', html: `<div class="num-marker ${cls}" style="background:${color}">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const popup = `<strong>${esc(g.place.name)}</strong><br>${g.stops.map((s) => `${esc(fmtHHMM(s.start))} · ${esc(s.title)}`).join('<br>')}<div class="pop-actions"><a href="${directionsUrl(g.place)}" target="_blank" rel="noopener">Directions</a>${nearbyPopupBtn(g.stops)}</div>`;
      const m = L.marker([g.place.lat, g.place.lng], { icon }).bindPopup(popup).addTo(layer as LayerGroup);
      for (const s of g.stops) stopMarkers.set(s.id, m);
    });
    const route: LatLngTuple[] = [];
    for (const s of day.stops) {
      const p: LatLngTuple = [s.place.lat, s.place.lng];
      const last = route[route.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) route.push(p);
    }
    L.polyline(route, { color, weight: 3, opacity: 0.55, dashArray: '6 8' }).addTo(layer);
  }
  if (refit) {
    lastRefit = live.refit;
    lastMapDay = day.n;
    const pts = day.stops.map((s): LatLngTuple => [s.place.lat, s.place.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  }
}

function renderMe(): void {
  if (!meLayer) return;
  meLayer.clearLayers();
  const pos = live.pos;
  if (!pos) return;
  const ll: LatLngExpression = [pos.lat, pos.lng];
  if (pos.accuracy) L.circle(ll, { radius: pos.accuracy, color: '#2b7de9', weight: 1, fillOpacity: 0.1 }).addTo(meLayer);
  L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), zIndexOffset: 1000 })
    .bindPopup('You are here').addTo(meLayer);
}

// "Where's everyone?": members sharing their location, as their avatar (faded when it's old).
const STALE = 15 * 60000;
function renderGroup(map: LMap): void {
  if (!groupLayer) return;
  const people = live.groupOn ? live.group.filter((g) => g.email !== groupSelf) : [];
  const sig = people.map((g) => `${g.email}:${displayName(g.email)}:${g.lat},${g.lng}:${Date.now() - g.atMs > STALE}`).join('|');
  if (sig !== lastGroupSig) {
    lastGroupSig = sig;
    groupLayer.clearLayers();
    for (const g of people) {
      const stale = Date.now() - g.atMs > STALE;
      const name = displayName(g.email);
      const icon = L.divIcon({ className: '', html: `<div class="grp-marker${stale ? ' stale' : ''}" style="background:${avatarColor(g.email)}">${esc((name[0] || '?').toUpperCase())}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] });
      const ago = Math.round((Date.now() - g.atMs) / 60000);
      L.marker([g.lat, g.lng], { icon, zIndexOffset: 900 }).bindPopup(`<strong>${esc(name)}</strong><br>${ago < 1 ? 'Just now' : `${ago} min ago`}<div class="pop-actions"><a href="${directionsUrl(g)}" target="_blank" rel="noopener">Directions</a></div>`).addTo(groupLayer);
    }
  }
  // Opening the group map: fit everyone (and you) in view, once.
  if (live.groupOn && !groupFitted && people.length) {
    groupFitted = true;
    const pts: LatLngTuple[] = people.map((g) => [g.lat, g.lng]);
    if (live.pos) pts.push([live.pos.lat, live.pos.lng]);
    setTimeout(() => (pts.length > 1 ? map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 }) : map.setView(pts[0] as LatLngTuple, 15)), 0);
  }
  if (!live.groupOn) groupFitted = false;
}
/** Your email, so your own shared location isn't drawn twice (you're the blue dot). */
let groupSelf = '';
export function setGroupSelf(email: string): void { groupSelf = email; }
/** Centre the map on a member. */
export function mapFocusMember(email: string): void {
  const g = live.group.find((x) => x.email === email);
  if (g && live.map) live.map.setView([g.lat, g.lng], Math.max(live.map.getZoom(), 16));
}

const shownNearby = (nb: NearbyState) => (nb.filter === 'all' ? nb.items : nb.items.filter((x) => x.cat === nb.filter));

function renderNearby(map: LMap): void {
  if (!nearLayer) return;
  const nb = live.nearby;
  const sig = nb ? `${nb.stop.id}|${nb.status}|${nb.filter}|${nb.items.length}` : '';
  if (sig === lastNearbySig && nb?.fitKey === lastNearbyKey) return;
  lastNearbySig = sig;
  nearLayer.clearLayers();
  nearMarkers.clear();
  if (!nb) { lastNearbyKey = null; return; }
  const { stop, intent, filter } = nb;
  const shown = nb.status === 'ok' ? shownNearby(nb) : [];
  // Pins for what's listed, plus a ring around the stop they're near.
  L.circle([stop.place.lat, stop.place.lng], { radius: 80, color: '#e8704f', weight: 2, fillOpacity: 0.08 }).addTo(nearLayer);
  for (const x of shown) {
    const icon = L.divIcon({ className: '', html: `<div class="nb-marker${x.famous ? ' pop' : ''}">${x.icon}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const popup = `<strong>${esc(x.name)}</strong><br>${esc(x.label)} · ${fmtDist(x.dist)} from ${esc(stop.place.name)}<div class="pop-actions"><a href="${directionsUrl(x)}" target="_blank" rel="noopener">Directions</a>${x.wiki ? `<a href="${esc(x.wiki)}" target="_blank" rel="noopener">About</a>` : ''}</div>`;
    nearMarkers.set(x.id, L.marker([x.lat, x.lng], { icon }).bindPopup(popup).addTo(nearLayer));
  }
  if (nb.fitKey !== lastNearbyKey) {
    lastNearbyKey = nb.fitKey;
    // Meals zoom in on the closest handful, so the map shows the spots right around the stop.
    const focus = intent.cat === filter && (filter === 'eat' || filter === 'drink') ? shown.slice(0, 6) : shown;
    const pts: LatLngTuple[] = [[stop.place.lat, stop.place.lng], ...focus.map((x): LatLngTuple => [x.lat, x.lng])];
    setTimeout(() => (pts.length > 1 ? map.fitBounds(pts, { padding: [30, 30], maxZoom: 17 }) : map.setView(pts[0] as LatLngTuple, 16)), 0);
  }
}

/** Opening a stop: centre on its pin and open the popup. */
export function mapFocusStop(stopId: string): void {
  const map = live.map;
  const s = live.days.flatMap((d) => d.stops).find((x) => x.id === stopId);
  if (!map || !s) return;
  map.setView([s.place.lat, s.place.lng], Math.max(map.getZoom(), 15));
  stopMarkers.get(stopId)?.openPopup();
}

/** Tapping a nearby place in the list: centre on its pin and open the popup. */
export function mapFocusNearby(id: string): void {
  const map = live.map;
  const x = live.nearby?.items.find((i) => i.id === id);
  const m = nearMarkers.get(id);
  if (!x || !m || !map) return;
  map.setView([x.lat, x.lng], Math.max(map.getZoom(), 16));
  m.openPopup();
  document.getElementById('map')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function TripMap() {
  const v = useLive();
  const el = useRef<HTMLDivElement>(null);

  // Building the map (and loading its tiles) is the heaviest work here; let the screen's slide-in
  // finish first so it stays smooth on phones.
  useEffect(() => {
    let gone = false;
    const timer = setTimeout(async () => {
      const lf = await import('../../lib/leaflet');
      if (gone || !el.current || live.map) return;
      L = lf.default;
      const map = L.map(el.current, { zoomControl: true, attributionControl: true });
      L.tileLayer(lf.TILE_URL, { maxZoom: 19, attribution: lf.TILE_ATTRIBUTION }).addTo(map);
      layer = L.layerGroup().addTo(map);
      nearLayer = L.layerGroup().addTo(map);
      meLayer = L.layerGroup().addTo(map);
      groupLayer = L.layerGroup().addTo(map);
      live.map = map;
      lastMapDay = null; lastMapSig = ''; lastRefit = -1; lastNearbyKey = null; lastNearbySig = '';
      emit();
    }, prefersReducedMotion() ? 0 : 480);
    return () => {
      gone = true;
      clearTimeout(timer);
      live.map?.remove();
      live.map = null;
      layer = meLayer = nearLayer = groupLayer = null;
      lastGroupSig = '';
      groupFitted = false;
      stopMarkers.clear();
      nearMarkers.clear();
    };
  }, []);

  useEffect(() => {
    const map = live.map;
    if (!map) return;
    renderStops(map);
    renderNearby(map);
    renderMe();
    renderGroup(map);
  }, [v]);

  return <div id="map" ref={el} role="region" aria-label="Map of the day's stops" />;
}
