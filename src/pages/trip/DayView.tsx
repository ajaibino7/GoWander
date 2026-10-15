// Day tabs and the selected day's timeline: stops with times, notes, distance, weather at the
// stop's start, road travel time from the previous place, and actions when a stop is opened.
import { useRef } from 'react';
import { bestMode } from '../../lib/routing';
import { forecastFrom } from '../../lib/weather';
import { intentFor } from '../../lib/nearby';
import { TAG_LABELS, dayMonth, directionsUrl, distM, fmtDist, fmtDur, fmtHHMM, isHere } from '../../lib/util';
import {
  live, now, openNearby, selectDay, stopState, toggleDone, toggleStop, type LiveDay, type LiveStop, type Phase,
} from '../../lib/live';
import { mapFocusStop } from './TripMap';
import { DayTips } from './DayTips';

export function DayTabs({ phase }: { phase: Phase }) {
  const todayN = 'day' in phase ? phase.day.n : undefined;
  return (
    <nav className="tabs" role="tablist" aria-label="Trip days">
      {live.days.map((d) => {
        const wx = live.weather.get(d.date);
        return (
          <button
            key={d.n}
            className={`tab theme-${d.theme}`}
            role="tab"
            type="button"
            aria-selected={d.n === live.selectedDay}
            onClick={(e) => {
              if (d.n === live.selectedDay) return;
              selectDay(d.n);
              (e.currentTarget as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            }}
          >
            <div className="tn">{d.n}</div>
            <div className="td">{d.label}{d.n === todayN ? <span className="today" title="Today" /> : null}</div>
            {wx ? <div className="tw" title={wx.label}>{wx.icon} {wx.max}°</div> : null}
          </button>
        );
      })}
    </nav>
  );
}

// The weather at the stop's start time (from the day's hourly forecast).
function StopWeather({ day, s }: { day: LiveDay; s: LiveStop }) {
  const h = live.weather.get(day.date)?.hours.get(s.start.slice(0, 2));
  if (!h) return null;
  return <span className="m-wx" title={`${h.label}${h.rain ? ` · ${h.rain}% chance of rain` : ''}`}>{h.icon} {h.temp}°</span>;
}

// How long it takes to get here from the previous place, by road — and a warning when the plan
// doesn't leave enough time. For a travel stop the journey happens during the stop itself.
function Leg({ day, s }: { day: LiveDay; s: LiveStop }) {
  const leg = live.legs.get(s.id);
  if (!leg?.drive) return null;
  const best = bestMode(leg);
  const prev = day.stops[s.idx - 1];
  const mins = Math.round(best.s / 60);
  let warn = '';
  if (prev) {
    // Only flag real shortfalls: a short walk between back-to-back stops is normal planning.
    const planned = Math.round(((s.startAt.getTime() - prev.endAt.getTime()) + (s.kind === 'travel' ? s.endAt.getTime() - s.startAt.getTime() : 0)) / 60000);
    if (mins - Math.max(0, planned) >= 20) warn = planned > 0 ? `only ${fmtDur(planned * 60000)} planned` : 'no time planned';
  }
  return (
    <div className={`leg${warn ? ' tight' : ''}`}>
      {best.icon} {fmtDur(best.s * 1000)} {best.mode === 'walk' ? 'walk' : 'drive'} · {fmtDist(best.m)}
      {warn ? <> <span className="leg-warn">· {warn}</span></> : null}
    </div>
  );
}

export function DayView({ phase, onNearby }: { phase: Phase; onNearby: (stopId: string) => void }) {
  const t = now();
  const day = live.days.find((d) => d.n === live.selectedDay);
  // Slide the day in from the side of the tab that was picked.
  const prevDay = useRef<number | null>(null);
  const slide = useRef('');
  if (day && prevDay.current !== day.n) {
    slide.current = prevDay.current == null ? '' : day.n > prevDay.current ? 'slide-next' : 'slide-prev';
    prevDay.current = day.n;
  }
  if (!day) return <section className="day" />;
  const isToday = 'day' in phase && phase.day === day;
  const wx = live.weather.get(day.date);
  const from = forecastFrom(day.date);

  return (
    <section className={`day theme-${day.theme} ${slide.current}`.trim()} key={day.n}>
      <div className="day-band">
        <div className="num">{String(day.n).padStart(2, '0')}</div>
        <div className="eyebrow">Day {day.n} · {day.weekday}, {dayMonth(day.date)}</div>
        <h2>{day.title || `Day ${day.n}`}</h2>
        {wx ? (
          <div className="day-wx" title="Forecast for the day's main area">{wx.icon} {wx.label} · {wx.max}° / {wx.min}°{wx.rain != null ? ` · 💧 ${wx.rain}%` : ''}</div>
        ) : from > live.clock.dateKey(t) ? (
          <div className="day-wx soft">Forecast from {dayMonth(from)}</div>
        ) : null}
      </div>
      {live.trip ? <DayTips day={day} tripId={live.trip.id} /> : null}
      <ol className="timeline">
        {day.stops.map((s) => {
          const ss = stopState(s, t);
          const here = isToday && isHere(live.pos, s.place);
          const selected = live.selectedStop === s.id;
          const cls = ['tl', s.kind, ss === 'done' || ss === 'past' ? 'done' : '', ss === 'now' ? 'now' : '', here ? 'here' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
          const doneBy = live.doneBy.get(s.id);
          const open = () => {
            const opening = live.selectedStop !== s.id;
            toggleStop(s.id);
            if (opening) mapFocusStop(s.id);
          };
          return (
            <li
              key={s.id}
              className={cls}
              tabIndex={0}
              onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) open(); }}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } }}
            >
              <div className="t">{fmtHHMM(s.start)}<small>to {fmtHHMM(s.end)}</small></div>
              <div className="d" />
              <div className="c">
                <div className="w">
                  {s.title}
                  {s.tag ? <span className={`tag ${s.tag}`}>{TAG_LABELS[s.tag]}</span> : null}
                  {s.departure ? <span className="tag deadline">Departure</span> : null}
                  {ss === 'now' ? <span className="tag nowtag">Now</span> : null}
                  {here ? <span className="tag heretag">You're here</span> : null}
                </div>
                {s.note ? <div className="n">{s.note}</div> : null}
                <div className="m">
                  <span>📍 {s.place.name}{s.place.approx ? ' (approx.)' : ''}</span>
                  {live.pos ? <span>{fmtDist(distM(live.pos, s.place))} away</span> : null}
                  <StopWeather day={day} s={s} />
                  {doneBy ? <span className="done-by">✓ {doneBy.split('@')[0]}</span> : null}
                </div>
                <Leg day={day} s={s} />
                {selected ? (
                  // Created when the stop opens and kept while it's open, so the ease-in plays once.
                  <div className="stop-actions opening">
                    <a className="mini" href={directionsUrl(s.place)} target="_blank" rel="noopener">Directions</a>
                    <button className="mini" type="button" onClick={() => { openNearby(s.id); onNearby(s.id); }}>{intentFor(s).icon} {intentFor(s).button}</button>
                    <button className="mini" type="button" onClick={() => toggleDone(s.id)}>{live.done.has(s.id) ? 'Undo done' : 'Mark done / skip'}</button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {day.notes?.length ? (
        <div className="notes">
          {day.notes.map((n, i) => <div key={i} className={`note ${n.type}`}><b>{n.title}</b>{n.text}</div>)}
        </div>
      ) : null}
    </section>
  );
}
