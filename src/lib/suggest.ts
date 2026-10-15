// Smart tips for a trip day, worked out from what the app already knows: the plan itself (times,
// labels, stop types, places), the weather forecast, real travel times between stops, and nearby
// places already looked up on this device. No AI and no extra network requests, so every tip is
// grounded in real data and works offline.
import type { LatLng, NoteType, Place, StopKind, StopTag } from './types';
import type { DayWeather } from './weather';
import type { NearbyItem } from './nearby';
import { bestMode, type StopLeg } from './routing';
import { distM, fmtDist, fmtDur, fmtHHMM, fromMin, toMin, weekdayOf } from './util';

export interface SuggestStop {
  id: string;
  start: string;
  end: string;
  kind: StopKind;
  title: string;
  note?: string;
  tag?: StopTag;
  departure?: { buffer: number };
  place: Place;
}

export interface SuggestInput {
  /** YYYY-MM-DD. */
  date: string;
  stops: SuggestStop[];
  weather?: DayWeather | null;
  /** Stop id → travel time from the previous place (routing.ts). */
  legs?: Map<string, StopLeg>;
  /** Nearby places already known for a spot (no network), for "Also nearby". */
  nearby?: (p: LatLng) => NearbyItem[] | null;
  unit?: 'C' | 'F';
}

export type Tone = 'warn' | 'info' | 'good';

export interface Tip {
  /** Stable, so a tip someone hid stays hidden. */
  id: string;
  tone: Tone;
  icon: string;
  title: string;
  text: string;
  /** The day-note type it becomes when added to the plan. */
  noteType: NoteType;
  /** Still true later (not a forecast): fit to save as a day note. */
  lasting: boolean;
  /** Lower comes first. */
  rank: number;
}

/** "A", "A and B", "A, B and C", "A, B and 2 more". */
export function listOf(names: string[], max = 3): string {
  const u = [...new Set(names.filter(Boolean))];
  if (u.length <= 1) return u[0] || '';
  if (u.length <= max) return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`;
  return `${u.slice(0, max - 1).join(', ')} and ${u.length - (max - 1)} more`;
}

const words = (s: SuggestStop) => `${s.title} ${s.note || ''} ${s.place.name}`;
const at = (min: number) => fmtHHMM(fromMin(min));
const mins = (ms: number) => Math.round(ms / 60000);

// Things to know for kinds of places, matched on the stop's title, note and place name.
// Only for the kinds of stop where it makes sense (a "Lunch in Fort" isn't a climb).
const KNOW: { id: string; re: RegExp; kinds: StopKind[]; icon: string; title: string; text: (names: string) => string }[] = [
  { id: 'beach', kinds: ['stop', 'meal'], re: /\b(beach|beaches|coast|shore|seaside)\b/i, icon: '🏖️', title: 'Beach day',
    text: () => 'Pack sunscreen, sunglasses, a towel and a change of clothes.' },
  { id: 'worship', kinds: ['stop'], re: /\b(temple|church|basilica|cathedral|mosque|masjid|gurudwara|shrine|monastery|dargah|chapel)\b/i, icon: '🛕', title: 'Places of worship',
    text: (n) => `${n}: wear clothes that cover shoulders and knees, and expect to remove shoes at some.` },
  { id: 'climb', kinds: ['stop'], re: /\b(fort|trek|trekking|hike|hiking|hill|peak|point|viewpoint|falls|waterfall|caves?|summit)\b/i, icon: '🥾', title: 'Walking & climbs',
    text: (n) => `${n}: comfortable shoes and a bottle of water will help.` },
  { id: 'market', kinds: ['stop'], re: /\b(market|bazaar|flea|shopping|souvenirs?)\b/i, icon: '🛍️', title: 'Shopping',
    text: () => 'Carry some cash for small stalls; bargaining is normal at street markets.' },
  { id: 'night', kinds: ['stop', 'meal'], re: /\b(pubs?|bars?|clubs?|clubbing|nightlife|party|live music)\b/i, icon: '🌃', title: 'Night out',
    text: () => 'Keep an ID handy and plan a safe ride back.' },
];
// ("Palace" is left out: too many hotels are called one.)
const OPENING = /\b(museum|gallery|zoo|aquarium|planetarium|science centre|science center)\b/i;
const MEAL_WORDS = /\b(lunch|brunch|meal|food|thali|restaurant|cafe|café|eat)\b/i;

export function suggestDay(input: SuggestInput): Tip[] {
  const stops = [...input.stops].filter((s) => s.place && s.start && s.end).sort((a, b) => a.start.localeCompare(b.start));
  if (!stops.length) return [];
  const tips: Tip[] = [];
  const add = (t: Omit<Tip, 'lasting'> & { lasting?: boolean }) => tips.push({ lasting: true, ...t });
  const legs = input.legs || new Map<string, StopLeg>();
  const first = stops[0] as SuggestStop, last = stops[stops.length - 1] as SuggestStop;
  const startMin = toMin(first.start), endMin = toMin(last.end);
  const weekday = weekdayOf(input.date);

  /* ---------- fixed departures: when to be there, and when to leave ---------- */
  for (const s of stops) {
    if (!s.departure) continue;
    const beAt = toMin(s.start) - s.departure.buffer;
    const icon = /flight|airport|fly/i.test(words(s)) ? '✈️' : /train|station|railway|rail/i.test(words(s)) ? '🚆' : /\bbus\b/i.test(words(s)) ? '🚌' : '🧳';
    let text = `Be at ${s.place.name} by ${at(beAt)}, ${fmtDur(s.departure.buffer * 60000)} before ${s.title} at ${fmtHHMM(s.start)}.`;
    // The plan may reach the place with an earlier stop ("Arrive at the station"): the journey
    // there is the leg into whichever stop gets there first.
    let k = stops.indexOf(s);
    while (k > 0 && distM((stops[k - 1] as SuggestStop).place, s.place) <= 150) k--;
    const arrive = stops[k] as SuggestStop, prev = stops[k - 1];
    const leg = legs.get(arrive.id);
    if (leg && prev) {
      const best = bestMode(leg);
      const travel = mins(best.s * 1000);
      // An earlier travel stop ("Head to the station") is the journey itself, so it starts when
      // you leave. Otherwise leave in time to arrive by the earlier of the two, with a little
      // slack for traffic and parking. (The departure itself is the train or flight, not the trip there.)
      const leave = arrive !== s && arrive.kind === 'travel' ? toMin(arrive.start) : Math.min(beAt, toMin(arrive.start)) - travel - 10;
      text += ` Leave ${prev.place.name} by ${at(leave)} (${fmtDur(travel * 60000)} ${best.mode === 'walk' ? 'walk' : 'drive'}).`;
    }
    add({ id: `dep-${s.id}`, tone: 'warn', icon, title: 'Departure', text, noteType: 'warn', rank: 0 });
  }

  /* ---------- connections the plan doesn't leave time for ---------- */
  const tight: string[] = [];
  let road = 0;
  stops.forEach((s, i) => {
    const leg = legs.get(s.id);
    const prev = stops[i - 1];
    if (!leg?.drive) return;
    const best = bestMode(leg);
    const travel = mins(best.s * 1000);
    if (best.mode === 'drive') road += travel;
    if (!prev) return;
    // Same rule as the timeline: only real shortfalls, not a short walk between back-to-back stops.
    const planned = toMin(s.start) - toMin(prev.end) + (s.kind === 'travel' ? toMin(s.end) - toMin(s.start) : 0);
    if (travel - Math.max(0, planned) >= 20) {
      tight.push(`${prev.title} → ${s.title} takes about ${fmtDur(travel * 60000)} ${best.mode === 'walk' ? 'on foot' : 'by road'}, ${planned > 0 ? `only ${fmtDur(planned * 60000)} planned` : 'with no time planned'}`);
    }
  });
  if (tight.length) {
    add({
      id: 'tight', tone: 'warn', icon: '⏱️', title: tight.length > 1 ? `${tight.length} tight connections` : 'Tight connection',
      text: `${tight.slice(0, 2).join('. ')}${tight.length > 2 ? `. And ${tight.length - 2} more.` : '.'} Start earlier or trim a stop.`,
      noteType: 'warn', rank: 1,
    });
  }
  if (road >= 120) {
    add({ id: 'road', tone: 'info', icon: '🚗', title: 'On the road', text: `About ${fmtDur(road * 60000)} of driving today. Download offline maps and keep water and snacks handy.`, noteType: 'tip', rank: 6 });
  }

  /* ---------- weather (forecasts change, so these aren't saved as notes) ---------- */
  const wx = input.weather;
  if (wx) {
    const F = input.unit === 'F';
    const hot = F ? 95 : 35, cold = F ? 41 : 5;
    let weatherTip = false;
    if (/thunder|storm/i.test(wx.label)) {
      weatherTip = true;
      add({ id: 'wx-storm', tone: 'warn', icon: '⛈️', title: 'Storms forecast', text: 'Thunderstorms are forecast. Keep outdoor plans flexible, and stay off beaches and viewpoints during a storm.', noteType: 'warn', lasting: false, rank: 2 });
    }
    const wet = stops.filter((s) => (wx.hours.get(s.start.slice(0, 2))?.rain ?? 0) >= 50);
    const firstWet = wet[0];
    if (firstWet) {
      weatherTip = true;
      const chance = wx.hours.get(firstWet.start.slice(0, 2))?.rain;
      add({
        id: 'wx-rain', tone: 'info', icon: '☔', title: 'Rain likely',
        text: `${chance}% chance of rain around ${fmtHHMM(firstWet.start)} (${listOf(wet.map((s) => s.title), 2)}). Carry an umbrella or a light rain jacket.`,
        noteType: 'tip', lasting: false, rank: 3,
      });
    } else if ((wx.rain ?? 0) >= 50) {
      weatherTip = true;
      add({ id: 'wx-rain', tone: 'info', icon: '☔', title: 'Rain likely', text: `${wx.rain}% chance of rain today. Carry an umbrella or a light rain jacket.`, noteType: 'tip', lasting: false, rank: 3 });
    }
    if (wx.max >= hot) {
      weatherTip = true;
      add({ id: 'wx-hot', tone: 'warn', icon: '🥵', title: 'Hot day', text: `Up to ${wx.max}°. Drink plenty of water, wear sunscreen, and keep outdoor stops for before noon or after 4 PM.`, noteType: 'warn', lasting: false, rank: 3 });
    }
    if (wx.min <= cold) {
      weatherTip = true;
      add({ id: 'wx-cold', tone: 'info', icon: '🧥', title: 'Cold', text: `Down to ${wx.min}°. Wear layers, especially early and late.`, noteType: 'tip', lasting: false, rank: 4 });
    }
    if (/fog/i.test(wx.label)) {
      weatherTip = true;
      add({ id: 'wx-fog', tone: 'info', icon: '🌫️', title: 'Fog', text: 'Fog is likely. Allow extra time on the road, especially in the morning.', noteType: 'tip', lasting: false, rank: 4 });
    }
    if (!weatherTip && /clear|partly/i.test(wx.label)) {
      add({ id: 'wx-good', tone: 'good', icon: '☀️', title: 'Good weather', text: `${wx.label}, ${wx.min}° to ${wx.max}°. A great day for the outdoor stops.`, noteType: 'tip', lasting: false, rank: 20 });
    }
  }

  /* ---------- the plan's own labels ---------- */
  // Sights, not journeys: a "must" train is covered by the departure tip.
  const highlights = stops.filter((s) => (s.tag === 'must' || s.tag === 'key') && s.kind !== 'travel' && !s.departure);
  if (highlights.length) {
    add({ id: 'highlights', tone: 'good', icon: '⭐', title: "Don't miss", text: `${listOf(highlights.map((s) => s.title))}: today's highlights.`, noteType: 'star', rank: 5 });
  }
  const closing = stops.filter((s) => s.tag === 'closing');
  if (closing.length) {
    add({ id: 'closing', tone: 'info', icon: '🔒', title: 'Closes early', text: `${listOf(closing.map((s) => `${s.title} (${fmtHHMM(s.start)})`))}: check today's closing time before you go.`, noteType: 'tip', rank: 7 });
  }
  // Fixed times, except those at a departure's place (the departure tip covers them).
  const departures = stops.filter((s) => s.departure);
  const fixed = stops.filter((s) => s.tag === 'deadline' && !s.departure && !departures.some((d) => distM(d.place, s.place) <= 150));
  if (fixed.length) {
    add({ id: 'fixed', tone: 'warn', icon: '⏰', title: 'Fixed time', text: `${listOf(fixed.map((s) => `${s.title} (${fmtHHMM(s.start)})`))}. Leave some slack in the stops before ${fixed.length > 1 ? 'them' : 'it'}.`, noteType: 'warn', rank: 2 });
  }

  /* ---------- the shape of the day ---------- */
  if (startMin < 7 * 60 + 30) {
    add({ id: 'early', tone: 'info', icon: '🌅', title: 'Early start', text: `First stop at ${fmtHHMM(first.start)} (${first.title}). Pack the night before and set an alarm.`, noteType: 'tip', rank: 8 });
  }
  if (endMin > 22 * 60 + 30) {
    add({ id: 'late', tone: 'info', icon: '🌙', title: 'Late finish', text: `The day ends at ${fmtHHMM(last.end)}. Arrange your ride back in advance.`, noteType: 'tip', rank: 8 });
  }
  if (endMin - startMin >= 12 * 60) {
    add({ id: 'long', tone: 'info', icon: '🔋', title: 'Long day', text: `${fmtDur((endMin - startMin) * 60000)} from the first stop to the last. Carry a power bank and take a break or two.`, noteType: 'tip', rank: 9 });
  }
  const hasLunch = stops.some((s) => (s.kind === 'meal' || MEAL_WORDS.test(s.title)) && toMin(s.start) < 15 * 60 && toMin(s.end) > 11 * 60 + 30);
  if (!hasLunch && startMin <= 12 * 60 + 30 && endMin >= 14 * 60) {
    add({ id: 'lunch', tone: 'info', icon: '🍽️', title: 'No lunch planned', text: 'Nothing is planned for lunch between 12 and 2 PM. Open a stop and use "Find places to eat".', noteType: 'tip', rank: 10 });
  }

  /* ---------- know before you go ---------- */
  for (const k of KNOW) {
    const hits = stops.filter((s) => k.kinds.includes(s.kind) && k.re.test(words(s)));
    if (hits.length) add({ id: `know-${k.id}`, tone: 'info', icon: k.icon, title: k.title, text: k.text(listOf(hits.map((s) => s.title), 2)), noteType: 'tip', rank: 12 });
  }
  const opening = stops.filter((s) => s.kind === 'stop' && OPENING.test(words(s)));
  if (opening.length) {
    const monday = weekday === 'Monday';
    add({
      id: 'opening', tone: monday ? 'warn' : 'info', icon: '🎟️', title: monday ? 'Closed on Mondays?' : 'Opening days',
      text: `${listOf(opening.map((s) => s.title), 2)}: many museums close one day a week${monday ? ', often Monday (today)' : ''}. Check before you go.`,
      noteType: monday ? 'warn' : 'tip', rank: monday ? 2 : 11,
    });
  }

  /* ---------- well-known places next to the plan ---------- */
  if (input.nearby) {
    const planned = stops.map((s) => `${s.title} ${s.place.name}`.toLowerCase());
    const seen = new Set<string>();
    const extras: string[] = [];
    for (const s of stops) {
      const items = input.nearby(s.place);
      const pick = items?.find((x) => x.famous && x.cat === 'see' && distM(x, s.place) <= 800 && !seen.has(x.name)
        && !planned.some((p) => p.includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(s.place.name.toLowerCase())));
      if (!pick) continue;
      seen.add(pick.name);
      extras.push(`${pick.name}, ${fmtDist(distM(pick, s.place))} from ${s.place.name}`);
      if (extras.length >= 3) break;
    }
    if (extras.length) add({ id: 'nearby', tone: 'good', icon: '📍', title: 'Also nearby', text: `${extras.join('; ')}.`, noteType: 'tip', rank: 13 });
  }

  return tips.sort((a, b) => a.rank - b.rank);
}

/** Leaves out tips the day's own notes already cover (the same text, or a note with the same heading). */
export function withoutNotes(tips: Tip[], notes: { title: string; text: string }[]): Tip[] {
  const texts = new Set(notes.map((n) => n.text.trim()));
  const titles = new Set(notes.map((n) => n.title.trim().toLowerCase()).filter(Boolean));
  return tips.filter((t) => !texts.has(t.text) && !titles.has(t.title.toLowerCase()));
}
