// Weather for each trip day from Open-Meteo (free, no key): a daily summary for the day's main
// area plus hourly readings, so each stop can show the weather at its start time. Forecasts only
// reach ~16 days ahead; days further out simply have none yet. Results are cached on the device
// (fresh for 3 hours, and kept for offline use for 3 days).
import type { Day, Place, Trip } from './types';

const FRESH = 3 * 3600000;
const KEEP = 3 * 86400000;
const AHEAD_DAYS = 15;

export interface WeatherLook { icon: string; label: string }
export interface HourWeather extends WeatherLook { temp: number; rain: number | null }
export interface DayWeather extends WeatherLook {
  max: number;
  min: number;
  rain: number | null;
  /** "HH" (trip time) → that hour's reading. */
  hours: Map<string, HourWeather>;
}

const WMO: [number[], string, string][] = [
  [[0], '☀️', 'Clear'], [[1], '🌤️', 'Mostly clear'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Cloudy'],
  [[45, 48], '🌫️', 'Fog'], [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 66], '🌧️', 'Rain'], [[65, 67], '🌧️', 'Heavy rain'],
  [[71, 73, 75, 77], '🌨️', 'Snow'], [[80, 81], '🌦️', 'Showers'], [[82], '🌧️', 'Heavy showers'], [[85, 86], '🌨️', 'Snow showers'],
  [[95], '⛈️', 'Thunderstorm'], [[96, 99], '⛈️', 'Storm with hail'],
];
export function describe(code: number | undefined): WeatherLook {
  const hit = WMO.find(([codes]) => code !== undefined && codes.includes(code));
  return hit ? { icon: hit[1], label: hit[2] } : { icon: '🌡️', label: '' };
}

// °F only for devices actually set up in the US (US English is also the default on many laptops
// elsewhere, so the language alone isn't enough); °C everywhere else.
const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
export const UNIT: 'C' | 'F' = (navigator.language || '').toLowerCase() === 'en-us' && /^(America|US|Pacific\/Honolulu)/.test(deviceTz) ? 'F' : 'C';

const dateAdd = (key: string, n: number): string => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const todayKey = () => new Date().toISOString().slice(0, 10);
/** The first date a forecast for this day becomes available. */
export const forecastFrom = (dateKey: string): string => dateAdd(dateKey, -AHEAD_DAYS);

// The day's main area: the ~10 km cell with the most stops.
function dayPlace(day: Day): Place | null {
  const cells = new Map<string, { n: number; place: Place }>();
  for (const s of day.stops || []) {
    if (!s.place || !Number.isFinite(s.place.lat)) continue;
    const k = `${s.place.lat.toFixed(1)},${s.place.lng.toFixed(1)}`;
    const cell = cells.get(k) || { n: 0, place: s.place };
    cell.n++;
    cells.set(k, cell);
  }
  return [...cells.values()].sort((a, b) => b.n - a.n)[0]?.place || null;
}

interface MeteoResult {
  daily?: { time?: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max?: (number | null)[] };
  hourly?: { time?: string[]; weather_code: number[]; temperature_2m: number[]; precipitation_probability?: (number | null)[] };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const memo = new Map<string, MeteoResult[]>();

// One request for every area of the trip (Open-Meteo accepts several locations at once, and
// answers parallel requests with "busy"). Returns one result per place, in order.
async function fetchAll(places: Place[], start: string, end: string, tz: string): Promise<MeteoResult[]> {
  const coords = places.map((p) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`).join(';');
  const key = `gw-wx-${coords},${start},${end},${UNIT}`;
  const known = memo.get(key);
  if (known) return known;
  let cached: { at: number; data: MeteoResult[] } | null = null;
  try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* storage unavailable */ }
  if (cached && Date.now() - cached.at < FRESH) { memo.set(key, cached.data); return cached.data; }
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${places.map((p) => p.lat.toFixed(3)).join(',')}&longitude=${places.map((p) => p.lng.toFixed(3)).join(',')}`
    + `&timezone=${encodeURIComponent(tz)}&start_date=${start}&end_date=${end}${UNIT === 'F' ? '&temperature_unit=fahrenheit' : ''}`
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&hourly=weather_code,temperature_2m,precipitation_probability';
  try {
    let res = await fetch(url);
    if (res.status >= 500) { await sleep(1500); res = await fetch(url); } // busy: one retry
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data: MeteoResult[] = Array.isArray(json) ? json : [json];
    memo.set(key, data);
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })); } catch { /* storage full */ }
    return data;
  } catch (e) {
    // Offline or the service is down: an older copy is better than nothing.
    if (cached && Date.now() - cached.at < KEEP) return cached.data;
    throw e;
  }
}

/** Date → forecast, for the trip days that have one. */
export async function tripWeather(trip: Trip): Promise<Map<string, DayWeather>> {
  const today = todayKey();
  const last = dateAdd(today, AHEAD_DAYS);
  // Group days by area so a city break is one request, and a two-city trip is two.
  const groups = new Map<string, { place: Place; dates: string[] }>();
  for (const day of trip.days || []) {
    if (!day.date || day.date < dateAdd(today, -1) || day.date > last) continue;
    const place = dayPlace(day);
    if (!place) continue;
    const k = `${place.lat.toFixed(1)},${place.lng.toFixed(1)}`;
    const g = groups.get(k) || { place, dates: [] };
    g.dates.push(day.date);
    groups.set(k, g);
  }
  const out = new Map<string, DayWeather>();
  const list = [...groups.values()];
  if (!list.length) return out;
  const all = list.flatMap((g) => g.dates).sort();
  let results: MeteoResult[];
  try { results = await fetchAll(list.map((g) => g.place), all[0] as string, all[all.length - 1] as string, trip.timezone || 'auto'); } catch { return out; }
  list.forEach(({ dates }, gi) => {
    const data = results[gi] || {};
    const d = data.daily, h = data.hourly;
    if (!d) return;
    (d.time || []).forEach((date, i) => {
      if (!dates.includes(date)) return;
      const hours = new Map<string, HourWeather>();
      (h?.time || []).forEach((t, j) => {
        if (h && t.startsWith(date)) {
          hours.set(t.slice(11, 13), { ...describe(h.weather_code[j]), temp: Math.round(h.temperature_2m[j] ?? 0), rain: h.precipitation_probability?.[j] ?? null });
        }
      });
      out.set(date, {
        ...describe(d.weather_code[i]),
        max: Math.round(d.temperature_2m_max[i] ?? 0),
        min: Math.round(d.temperature_2m_min[i] ?? 0),
        rain: d.precipitation_probability_max?.[i] ?? null,
        hours,
      });
    });
  });
  return out;
}
