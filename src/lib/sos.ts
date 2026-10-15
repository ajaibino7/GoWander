// SOS: the local emergency numbers (from the trip's timezone), and the nearest hospitals, police
// stations and pharmacies from OpenStreetMap. Places are cached on the device for a month, so
// once looked up (or saved for offline use) the card works without signal.
import { fetchOverpass, type OsmElement } from './nearby';
import { distM } from './util';
import type { LatLng } from './types';

export interface EmergencyNumber { label: string; number: string; icon: string }
interface Country { name: string; numbers: EmergencyNumber[] }

const n = (label: string, number: string, icon: string): EmergencyNumber => ({ label, number, icon });
const COUNTRIES: Record<string, Country> = {
  IN: { name: 'India', numbers: [n('Emergency (all services)', '112', '🆘'), n('Police', '100', '👮'), n('Ambulance', '108', '🚑'), n('Fire', '101', '🚒'), n('Women helpline', '1091', '🛡️'), n('Tourist helpline', '1363', 'ℹ️')] },
  LK: { name: 'Sri Lanka', numbers: [n('Police', '119', '👮'), n('Ambulance', '1990', '🚑'), n('Fire', '110', '🚒'), n('Tourist police', '1912', 'ℹ️')] },
  NP: { name: 'Nepal', numbers: [n('Police', '100', '👮'), n('Ambulance', '102', '🚑'), n('Fire', '101', '🚒'), n('Tourist police', '1144', 'ℹ️')] },
  AE: { name: 'UAE', numbers: [n('Police', '999', '👮'), n('Ambulance', '998', '🚑'), n('Fire', '997', '🚒')] },
  SG: { name: 'Singapore', numbers: [n('Police', '999', '👮'), n('Ambulance & fire', '995', '🚑')] },
  TH: { name: 'Thailand', numbers: [n('Police', '191', '👮'), n('Ambulance', '1669', '🚑'), n('Fire', '199', '🚒'), n('Tourist police', '1155', 'ℹ️')] },
  MY: { name: 'Malaysia', numbers: [n('Emergency', '999', '🆘'), n('From a mobile', '112', '📱')] },
  ID: { name: 'Indonesia', numbers: [n('Emergency', '112', '🆘'), n('Police', '110', '👮'), n('Ambulance', '118', '🚑'), n('Fire', '113', '🚒')] },
  JP: { name: 'Japan', numbers: [n('Police', '110', '👮'), n('Ambulance & fire', '119', '🚑')] },
  VN: { name: 'Vietnam', numbers: [n('Police', '113', '👮'), n('Fire', '114', '🚒'), n('Ambulance', '115', '🚑')] },
  MV: { name: 'Maldives', numbers: [n('Police', '119', '👮'), n('Ambulance', '102', '🚑'), n('Fire', '118', '🚒')] },
  GB: { name: 'United Kingdom', numbers: [n('Emergency', '999', '🆘'), n('Also works', '112', '📱'), n('Non-emergency medical', '111', '🩺')] },
  EU: { name: 'Europe', numbers: [n('Emergency (all services)', '112', '🆘')] },
  US: { name: 'United States & Canada', numbers: [n('Emergency (all services)', '911', '🆘')] },
  AU: { name: 'Australia', numbers: [n('Emergency (all services)', '000', '🆘'), n('From a mobile', '112', '📱')] },
};
const BY_TZ: Record<string, string> = {
  'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Colombo': 'LK', 'Asia/Kathmandu': 'NP', 'Asia/Katmandu': 'NP', 'Asia/Dubai': 'AE',
  'Asia/Singapore': 'SG', 'Asia/Bangkok': 'TH', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Makassar': 'ID', 'Asia/Jayapura': 'ID',
  'Asia/Tokyo': 'JP', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Saigon': 'VN', 'Indian/Maldives': 'MV', 'Europe/London': 'GB',
};

/** The emergency numbers where the trip is. Falls back to 112, which works from most mobiles. */
export function emergencyFor(timezone: string): Country {
  const code = BY_TZ[timezone]
    ?? (timezone.startsWith('Europe/') ? 'EU' : timezone.startsWith('America/') ? 'US' : timezone.startsWith('Australia/') ? 'AU' : '');
  return (code && COUNTRIES[code]) || { name: '', numbers: [n('Emergency (most countries, from a mobile)', '112', '🆘')] };
}

export type HelpKind = 'hospital' | 'police' | 'pharmacy';
export interface HelpPlace extends LatLng { id: string; kind: HelpKind; name: string; dist: number; phone: string; open24: boolean }

const TTL = 30 * 86400000;
const keyOf = (p: LatLng) => `gw-sos-${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;

/** Nearest help around a point (from the device's copy when there is one). */
export function cachedHelp(p: LatLng): HelpPlace[] | null {
  try {
    const hit = JSON.parse(localStorage.getItem(keyOf(p)) || 'null');
    return hit && Array.isArray(hit.items) ? sortFrom(hit.items, p) : null;
  } catch { return null; }
}

const sortFrom = (items: HelpPlace[], p: LatLng) => items.map((x) => ({ ...x, dist: distM(p, x) })).sort((a, b) => a.dist - b.dist);

// One lookup at a time per area (the screen and "Save offline" can ask together).
const inflight = new Map<string, Promise<HelpPlace[]>>();

export function nearestHelp(p: LatLng): Promise<HelpPlace[]> {
  try {
    const hit = JSON.parse(localStorage.getItem(keyOf(p)) || 'null');
    if (hit && Date.now() - hit.at < TTL) return Promise.resolve(sortFrom(hit.items, p));
  } catch { /* storage unavailable */ }
  const key = keyOf(p);
  const running = inflight.get(key);
  if (running) return running.then((items) => sortFrom(items, p));
  const job = lookupHelp(p).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function lookupHelp(p: LatLng): Promise<HelpPlace[]> {
  // About 4.5 km around, in one light query (busy servers time out on heavier ones).
  const r = 4500;
  const dLat = r / 111320, dLng = r / (111320 * Math.cos((p.lat * Math.PI) / 180));
  const box = `(${(p.lat - dLat).toFixed(4)},${(p.lng - dLng).toFixed(4)},${(p.lat + dLat).toFixed(4)},${(p.lng + dLng).toFixed(4)})`;
  const q = `[out:json][timeout:20];nwr["amenity"~"^(hospital|police|pharmacy)$"]${box};out center tags 200;`;
  const data = await fetchOverpass(q);
  const items: HelpPlace[] = [];
  for (const e of (data.elements || []) as OsmElement[]) {
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    const t = e.tags || {};
    const kind = t.amenity as HelpKind;
    if (lat == null || lng == null || !['hospital', 'police', 'pharmacy'].includes(kind)) continue;
    items.push({
      id: `${e.type}/${e.id}`, kind, lat, lng, dist: 0,
      name: t['name:en'] || t.name || (kind === 'hospital' ? 'Hospital' : kind === 'police' ? 'Police station' : 'Pharmacy'),
      phone: t.phone || t['contact:phone'] || t['emergency:phone'] || '',
      open24: t.opening_hours === '24/7' || t.emergency === 'yes',
    });
  }
  // Keep the nearest few of each kind.
  const sorted = sortFrom(items, p);
  const keep = (['hospital', 'police', 'pharmacy'] as HelpKind[]).flatMap((k) => sorted.filter((x) => x.kind === k && x.name).slice(0, 4));
  try { localStorage.setItem(keyOf(p), JSON.stringify({ at: Date.now(), items: keep })); } catch { /* storage full */ }
  return sortFrom(keep, p);
}

/** A phone number fit for a tel: link (several numbers: the first). */
export const telOf = (phone: string): string => (phone.split(/[;,/]/)[0] || '').replace(/[^\d+]/g, '');
