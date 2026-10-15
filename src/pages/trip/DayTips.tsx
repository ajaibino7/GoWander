// "Smart tips" for the selected day: weather, timing, highlights and know-before-you-go, worked
// out on the device (lib/suggest.ts). Shows the most important few; the rest are a tap away. A
// tip someone hides stays hidden on this device; tips already saved as day notes aren't repeated.
import { useState } from 'react';
import { useLeaving } from '../../app/motion';
import { cachedNearby } from '../../lib/nearby';
import { suggestDay, withoutNotes } from '../../lib/suggest';
import { UNIT } from '../../lib/weather';
import { live, type LiveDay } from '../../lib/live';

const SHOW = 3;
const hiddenKey = (tripId: string) => `gw-tips-off-${tripId}`;
const OPEN_KEY = 'gw-tips-open';

function readHidden(tripId: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(hiddenKey(tripId)) || '[]') as string[]); } catch { return new Set(); }
}
function writeHidden(tripId: string, ids: Set<string>): void {
  try { localStorage.setItem(hiddenKey(tripId), JSON.stringify([...ids])); } catch { /* storage unavailable */ }
}
const readOpen = (): boolean => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } };

export function DayTips({ day, tripId }: { day: LiveDay; tripId: string }) {
  const [hidden, setHidden] = useState(() => readHidden(tripId));
  const [open, setOpen] = useState(readOpen);
  const [all, setAll] = useState(false);
  const [leaving, leave] = useLeaving();

  // Not repeating what the day's notes already say.
  const tips = withoutNotes(suggestDay({ date: day.date, stops: day.stops, weather: live.weather.get(day.date), legs: live.legs, nearby: cachedNearby, unit: UNIT }), day.notes || []);
  // Hidden per day: the same kind of tip on another day is a different tip.
  const key = (id: string) => `${day.date}:${id}`;
  const shown = tips.filter((t) => !hidden.has(key(t.id)));
  const hiddenHere = tips.length - shown.length;
  if (!tips.length) return null;

  const visible = all ? shown : shown.slice(0, SHOW);
  const toggleOpen = () => {
    const v = !open;
    setOpen(v);
    try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ }
  };
  const hide = (id: string) => leave(id, async () => {
    const next = new Set(hidden).add(key(id));
    writeHidden(tripId, next);
    setHidden(next);
  });
  const restore = () => {
    const next = new Set([...hidden].filter((k) => !k.startsWith(`${day.date}:`)));
    writeHidden(tripId, next);
    setHidden(next);
  };
  const warnings = shown.filter((t) => t.tone === 'warn').length;

  return (
    <section className={`tips${open ? ' open' : ''}`} aria-label="Tips for this day">
      <button className="tips-h" type="button" aria-expanded={open} onClick={toggleOpen}>
        <span className="tips-spark" aria-hidden="true">✨</span>
        <span className="tips-title">Travel Insights</span>
        {shown.length ? <span className={`tips-count${warnings ? ' warn' : ''}`}>{shown.length}</span> : null}
        <span className="tips-sub">{warnings ? `${warnings} to check` : 'For this day'}</span>
        <span className="tips-chev" aria-hidden="true" />
      </button>
      {open ? (
        <div className="tips-body">
          {visible.length ? (
            <ul className="tips-list">
              {visible.map((t, i) => (
                <li key={t.id} className={`tip ${t.tone}${leaving.has(t.id) ? ' leaving' : ''}`} style={{ '--i': i } as React.CSSProperties}>
                  <span className="tip-ic" aria-hidden="true">{t.icon}</span>
                  <span className="tip-c">
                    <span className="tip-t">{t.title}</span>
                    <span className="tip-x">{t.text}</span>
                  </span>
                  <button className="tip-hide" type="button" title="Hide this tip" aria-label={`Hide tip: ${t.title}`} onClick={() => hide(t.id)}>✕</button>
                </li>
              ))}
            </ul>
          ) : <p className="tips-empty">All tips for this day are hidden.</p>}
          <div className="tips-foot">
            {shown.length > SHOW ? (
              <button className="link-btn" type="button" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${shown.length - SHOW} more`}</button>
            ) : <span />}
            {hiddenHere ? <button className="link-btn" type="button" onClick={restore}>Show {hiddenHere} hidden</button> : null}
          </div>
          <p className="tips-note">Worked out from the forecast, travel times and your plan.</p>
        </div>
      ) : null}
    </section>
  );
}
