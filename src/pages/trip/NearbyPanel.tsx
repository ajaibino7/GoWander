// "What to do nearby": the panel under the map. The stop's title decides what's shown first
// ("Lunch in Fort" → lunch spots closest to the stop); filters switch between categories.
import { CATS, GENERAL, type Cat } from '../../lib/nearby';
import { closeNearby, live, openNearby, setNearbyFilter } from '../../lib/live';
import { directionsUrl, fmtDist, fmtHHMM } from '../../lib/util';
import { mapFocusNearby } from './TripMap';

export function NearbyPanel() {
  const nb = live.nearby;
  if (!nb) return null;
  const { stop, intent, status, items, filter } = nb;
  const shown = filter === 'all' ? items : items.filter((x) => x.cat === filter);
  const count = (c: Cat) => items.filter((x) => x.cat === c).length;
  const near = intent === GENERAL ? 'What to do near' : `${intent.title} near`;

  const head = (
    <div className="nb-head">
      <div>
        <div className="nb-eyebrow">{intent.icon} {near}</div>
        <strong>{stop.place.name}</strong>
        <div className="nb-for">For “{stop.title}” · {fmtHHMM(stop.start)}</div>
      </div>
      <button className="icon-btn" type="button" aria-label="Close nearby places" onClick={() => closeNearby()}>✕</button>
    </div>
  );

  let body;
  if (status === 'loading') {
    body = <p className="nb-msg">Finding {intent === GENERAL ? 'things to do' : intent.title.toLowerCase()} around here… This can take a few seconds.</p>;
  } else if (status === 'error') {
    body = (
      <>
        <p className="nb-msg">{nb.error}</p>
        <div className="nb-pad"><button className="mini" type="button" onClick={() => openNearby(stop.id, { general: intent === GENERAL })}>Try again</button></div>
      </>
    );
  } else if (!items.length) {
    body = <p className="nb-msg">Nothing listed on OpenStreetMap within 3 km of this stop.</p>;
  } else {
    const chips: [Cat | 'all', string, number][] = [['all', 'All', items.length], ...(Object.entries(CATS) as [Cat, { label: string; icon: string }][]).map(([k, c]): [Cat, string, number] => [k, `${c.icon} ${c.label}`, count(k)])];
    body = (
      <>
        {nb.fellBack ? <p className="nb-msg nb-fallback">No {intent.title.toLowerCase()} are listed on the map this close to the stop. Here's what else is around.</p> : null}
        <div className="nb-filters" role="tablist" aria-label="Filter nearby places">
          {chips.filter(([k, , n]) => k === 'all' || n).map(([k, label, n]) => (
            <button key={k} className="nb-chip" type="button" role="tab" aria-selected={filter === k} onClick={() => setNearbyFilter(k)}>{label} <span>{n}</span></button>
          ))}
        </div>
        <ul className="nb-list">
          {shown.map((x) => (
            <li
              key={x.id}
              tabIndex={0}
              onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) mapFocusNearby(x.id); }}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); mapFocusNearby(x.id); } }}
            >
              <span className="nb-ic" aria-hidden="true">{x.icon}</span>
              <span className="nb-main">
                <span className="nb-name">{x.name}{x.famous ? <> <span className="nb-pop" title="Well known: has a Wikipedia entry">★ Popular</span></> : null}</span>
                <span className="nb-meta">{x.label} · {fmtDist(x.dist)} from stop</span>
                {x.hours && x.cat !== 'see' ? <span className="nb-hours">🕒 {x.hours}</span> : null}
              </span>
              <a className="mini" href={directionsUrl(x)} target="_blank" rel="noopener">Go</a>
            </li>
          ))}
        </ul>
        <p className="nb-foot">From OpenStreetMap. {intent.cat === 'eat' || intent.cat === 'drink' ? 'Closest to the stop first.' : 'Well-known places first, then the closest.'} Check opening hours before you go.</p>
      </>
    );
  }

  return <div className="nearby">{head}{body}</div>;
}

/** Brings the map (and the panel under it) into view — on phones the map sits above the timeline. */
export function scrollToMapCard(): void {
  document.querySelector('.map-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
