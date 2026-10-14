// "Add to calendar": the itinerary as an .ics file (works with Google, Apple and Outlook
// calendars). Every stop becomes an event at its real time — times are converted from the
// trip's timezone to UTC, so the calendar shows them correctly wherever the phone is.
import { makeClock, directionsUrl } from './util.js';

const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Text values escape \ ; , and newlines (RFC 5545).
const text = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Lines longer than 75 characters are folded onto continuation lines that start with a space.
const fold = (line) => {
  const out = [];
  for (let i = 0; i < line.length; i += i ? 74 : 75) out.push((i ? ' ' : '') + line.slice(i, i + (i ? 74 : 75)));
  return out.join('\r\n');
};

export function tripToIcs(trip) {
  const clock = makeClock(trip.timezone);
  const now = utc(new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GoWander//Trip planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${text(trip.title)}`];
  trip.days.forEach((day, i) => {
    for (const s of day.stops || []) {
      if (!s.start || !s.end || !s.place) continue;
      const start = clock.at(day.date, s.start);
      let end = clock.at(day.date, s.end);
      if (end <= start) end = new Date(start.getTime() + 15 * 60000);
      const desc = [s.note, `Day ${i + 1}${day.title ? ` · ${day.title}` : ''}`, `Directions: ${directionsUrl(s.place)}`].filter(Boolean).join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${s.id || `${day.date}-${s.start}`}-${trip.id || 'trip'}@gowander`,
        `DTSTAMP:${now}`,
        `DTSTART:${utc(start)}`,
        `DTEND:${utc(end)}`,
        `SUMMARY:${text(s.title)}`,
        `LOCATION:${text(s.place.name)}`,
        `GEO:${s.place.lat.toFixed(6)};${s.place.lng.toFixed(6)}`,
        `DESCRIPTION:${text(desc)}`,
      );
      // Fixed departures (trains, flights) get a reminder when it's time to be there.
      if (s.departure) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(`Be at ${s.place.name} for ${s.title}`)}`, `TRIGGER:-PT${Math.max(0, Number(s.departure.buffer) || 0)}M`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
  });
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadIcs(trip) {
  const blob = new Blob([tripToIcs(trip)], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(trip.title || 'trip').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'trip'}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
