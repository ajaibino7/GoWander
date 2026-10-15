// The weather where you are right now, for the home screen: temperature, conditions, today's
// high / low and the name of the place. Uses your approximate location only (rounded to ~1 km
// before it's sent to Open-Meteo and OpenStreetMap), and only once you've allowed location.
// Results are kept on the device: shown at once next time, refreshed every 30 minutes.
import { UNIT, describe, type WeatherLook } from './weather';

export interface LocalWeather extends WeatherLook {
  temp: number;
  max: number;
  min: number;
  place: string;
  at: number;
}

const KEY = 'gw-local-wx';
const FRESH = 30 * 60000;
const KEEP = 6 * 3600000;

const read = (): LocalWeather | null => {
  try {
    const w = JSON.parse(localStorage.getItem(KEY) || 'null') as LocalWeather | null;
    return w && Date.now() - w.at < KEEP ? w : null;
  } catch { return null; }
};
const write = (w: LocalWeather) => { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* storage full */ } };

/** The last reading on this device (up to 6 hours old), for an instant first paint. */
export const cachedLocalWeather = (): LocalWeather | null => read();
export const isFresh = (w: LocalWeather | null): boolean => !!w && Date.now() - w.at < FRESH;

/** Whether location is already allowed ('granted'), refused ('denied'), or not asked yet ('prompt'). */
export async function locationPermission(): Promise<PermissionState | 'unsupported'> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unsupported';
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return 'prompt'; }
}

const position = () => new Promise<GeolocationPosition>((resolve, reject) =>
  navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 10 * 60000, timeout: 15000 }));

// Night-time clear skies get the moon instead of the sun.
function look(code: number, isDay: boolean): WeatherLook {
  const l = describe(code);
  if (isDay) return l;
  if (code === 0) return { icon: '🌙', label: 'Clear night' };
  if (code === 1 || code === 2) return { icon: '☁️', label: code === 1 ? 'Mostly clear' : 'Partly cloudy' };
  return l;
}

async function placeName(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&accept-language=en`);
    if (!res.ok) return '';
    const a: Record<string, string | undefined> = (await res.json()).address || {};
    // Big cities often come back only as "<City> City District" (e.g. Mumbai): use that before
    // falling back to the county or state.
    const clean = (s: string | undefined) => (s || '').replace(/\s+(City\s+)?(District|Subdistrict|Taluka|Tehsil)$/i, '').trim();
    return a.city || a.town || a.village || clean(a.state_district) || a.suburb || clean(a.county) || a.state || '';
  } catch { return ''; }
}

let inFlight: Promise<LocalWeather | null> | null = null;

/** Fresh local weather (asks for location if it hasn't been allowed yet). Null if unavailable. */
export function fetchLocalWeather(): Promise<LocalWeather | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const p = await position();
      // ~1 km: plenty for the weather and the town's name, and kinder to your privacy.
      const lat = Math.round(p.coords.latitude * 100) / 100;
      const lng = Math.round(p.coords.longitude * 100) / 100;
      const old = read();
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat}&longitude=${lng}&timezone=auto&forecast_days=1${UNIT === 'F' ? '&temperature_unit=fahrenheit' : ''}`
        + '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min';
      const [res, place] = await Promise.all([fetch(url), placeName(lat, lng)]);
      if (!res.ok) return old;
      const j = await res.json();
      const code = Number(j.current?.weather_code);
      const w: LocalWeather = {
        ...look(code, j.current?.is_day !== 0),
        temp: Math.round(Number(j.current?.temperature_2m)),
        max: Math.round(Number(j.daily?.temperature_2m_max?.[0])),
        min: Math.round(Number(j.daily?.temperature_2m_min?.[0])),
        place: place || old?.place || '',
        at: Date.now(),
      };
      if (!Number.isFinite(w.temp)) return old;
      write(w);
      return w;
    } catch {
      return read();
    } finally {
      setTimeout(() => { inFlight = null; }, 0);
    }
  })();
  return inFlight;
}
