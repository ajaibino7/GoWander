// Small, dependency-free charts for the expenses page: a donut with a legend, and labelled bars.
// Segments and bars animate in (CSS) and respect "Reduce motion".
import type { ReactNode } from 'react';

export interface Segment { key: string; label: string; value: number; color: string; icon?: string }

export function Donut({ segments, center, sub, format }: { segments: Segment[]; center: ReactNode; sub?: ReactNode; format: (n: number) => string }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <div className="donut">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="12" />
          {segments.map((s, i) => {
            const len = (s.value / total) * C;
            // A hairline gap between segments, unless there's only one.
            const gap = segments.length > 1 ? Math.min(1.2, len / 3) : 0;
            const el = (
              <circle
                key={s.key}
                className="donut-seg"
                style={{ animationDelay: `${i * 60}ms` }}
                cx="50" cy="50" r={R} fill="none" stroke={s.color} strokeWidth="12"
                strokeDasharray={`${Math.max(0, len - gap)} ${C}`} strokeDashoffset={-offset}
                transform="rotate(-90 50 50)"
              />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div className="donut-c"><strong>{center}</strong>{sub ? <span>{sub}</span> : null}</div>
      </div>
      <ul className="legend">
        {segments.map((s) => (
          <li key={s.key}>
            <span className="lg-dot" style={{ background: s.color }} />
            <span className="lg-l">{s.icon ? `${s.icon} ` : ''}{s.label}</span>
            <span className="lg-v">{format(s.value)}</span>
            <span className="lg-p">{Math.round((s.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface Bar { key: string; label: ReactNode; value: number; note?: ReactNode; color?: string }

/** Horizontal bars, scaled to the largest (or to `max`, e.g. a budget line). */
export function Bars({ bars, format, max, marker }: { bars: Bar[]; format: (n: number) => string; max?: number; marker?: { value: number; label: string } }) {
  const top = Math.max(max || 0, marker?.value || 0, ...bars.map((b) => b.value), 1);
  return (
    <ul className="bars">
      {bars.map((b, i) => (
        <li key={b.key}>
          <span className="bar-l">{b.label}</span>
          <span className="bar-track">
            <span className={`bar-fill${marker && b.value > marker.value ? ' over' : ''}`} style={{ width: `${(b.value / top) * 100}%`, background: b.color, animationDelay: `${i * 50}ms` }} />
            {marker ? <span className="bar-mark" style={{ left: `${(marker.value / top) * 100}%` }} title={marker.label} /> : null}
          </span>
          <span className="bar-v">{format(b.value)}{b.note ? <small>{b.note}</small> : null}</span>
        </li>
      ))}
    </ul>
  );
}
