// The card at the top of the trip page: where you are in the trip right now — countdown, the
// stop in progress, whether you're on track, when to leave, and quick actions.
import { distM, directionsUrl, dayMonth, fmtDist, fmtDur, fmtHHMM } from '../../lib/util';
import { live, liveStatus, startWatch, toggleDone, openNearby, now, tripPhase, type Pill, type Stat, type LocState } from '../../lib/live';
import { intentFor } from '../../lib/nearby';
import { sim } from '../../lib/live';

function Stats({ stats }: { stats: Stat[] }) {
  if (!stats.length) return null;
  return (
    <div className="stats">
      {stats.map((s, i) => (
        <div className="stat" key={i}><div className="k">{s.k}</div><div className="v">{s.v}</div>{s.s ? <div className="s">{s.s}</div> : null}</div>
      ))}
    </div>
  );
}

function PillBadge({ pill, liveDot = false }: { pill: Pill; liveDot?: boolean }) {
  return <span className={`pill ${pill.cls || 'info'}${liveDot ? ' live' : ''}`}>{pill.text}</span>;
}

function locLabel(loc: LocState): { cls: string; text: string } {
  const acc = live.pos?.accuracy;
  switch (loc) {
    case 'on': return { cls: 'on', text: live.posSource === 'sim' ? (sim.follow ? 'Following schedule' : 'Simulated location') : `Location on${acc ? ` · ±${Math.round(acc)} m` : ''}` };
    case 'asking': return { cls: '', text: 'Finding you…' };
    case 'denied': return { cls: 'err', text: 'Location blocked' };
    case 'unavailable': return { cls: 'err', text: 'Location unavailable' };
    case 'error': return { cls: 'err', text: 'Retry location' };
    default: return { cls: '', text: 'Use my location' };
  }
}

export function StatusCard({ onNearby }: { onNearby: (stopId: string) => void }) {
  const t = now();
  const ph = tripPhase(t);
  const days = live.days;
  const loc = locLabel(live.loc);
  const locBtn = (
    <button className="loc-btn" type="button" onClick={() => {
      if (live.posSource === 'sim' || live.loc === 'on' || live.loc === 'asking') return;
      startWatch();
    }}>
      <span className={`loc-dot ${loc.cls}`.trim()} /><span>{loc.text}</span>
    </button>
  );

  let pill: Pill = { cls: 'info', text: 'Loading…' };
  let livePill = false;
  let body: React.ReactNode = null;
  const first = days[0];

  if (ph.phase === 'empty' || !first) {
    pill = { cls: 'info', text: 'No stops' };
    body = <><div className="now-title">This trip has no stops yet</div><div className="now-meta">Tap <strong>Edit</strong> to add days and places.</div></>;
  } else if (ph.phase === 'before') {
    const s = first.stops[0];
    pill = { cls: 'info', text: 'Countdown' };
    body = s ? (
      <>
        <div className="now-title">Trip starts in {fmtDur(s.startAt.getTime() - t.getTime())}</div>
        <div className="now-meta">{first.weekday}, {dayMonth(first.date)} · {fmtHHMM(s.start)} — {s.title}</div>
        <div className="status-msg info">Live status switches on automatically once the trip begins. Turn on location now so it's ready.</div>
      </>
    ) : null;
  } else if (ph.phase === 'after') {
    pill = { cls: 'ok', text: 'Complete' };
    body = <><div className="now-title">Hope it was a great trip!</div><div className="now-meta">All {days.length} days are done. The itinerary stays here for reference.</div></>;
  } else if (ph.phase === 'morning' || ph.phase === 'night' || ph.phase === 'between') {
    const nd = ph.phase === 'morning' ? ph.day : ph.next;
    const s = nd?.stops[0];
    pill = { cls: 'info', text: ph.phase === 'night' ? 'Rest up' : 'Good morning' };
    body = nd && s ? (
      <>
        <div className="now-title">Day {nd.n} starts {ph.phase === 'night' ? 'tomorrow' : 'soon'}</div>
        <div className="now-meta">{fmtHHMM(s.start)} — {s.title} · in {fmtDur(s.startAt.getTime() - t.getTime())}</div>
        <Stats stats={[{ k: 'First stop', v: fmtHHMM(s.start), s: s.place.name }, ...(live.pos ? [{ k: 'Distance', v: fmtDist(distM(live.pos, s.place)), s: 'to first stop' }] : [])]} />
        <div className="actions"><a className="btn" href={directionsUrl(s.place)} target="_blank" rel="noopener">Directions</a></div>
      </>
    ) : null;
  } else {
    const st = liveStatus(ph.day, t);
    pill = st.pill;
    livePill = true;
    const focus = st.cur || st.next;
    body = focus ? (
      <>
        <div className="now-title">{st.cur ? null : <span style={{ color: 'var(--muted)', fontSize: '.7em' }}>Up next · </span>}{focus.title}</div>
        <div className="now-meta">{fmtHHMM(focus.start)} – {fmtHHMM(focus.end)} · {focus.place.name}{focus.note ? ` · ${focus.note}` : ''}</div>
        {/* The message is escaped text with <strong> highlights (live.ts). */}
        {st.msg ? <div className={`status-msg ${st.msg.cls}`} dangerouslySetInnerHTML={{ __html: st.msg.html }} /> : null}
        <Stats stats={st.stats} />
        <div className="progress" title="Day progress"><span style={{ width: `${(st.progress * 100).toFixed(1)}%` }} /></div>
        <div className="actions">
          <a className="btn" href={directionsUrl(focus.place)} target="_blank" rel="noopener">Directions</a>
          <button className="btn ghost" type="button" onClick={() => { openNearby(focus.id); onNearby(focus.id); }}>{intentFor(focus).button}</button>
          <button className="btn ghost" type="button" onClick={() => toggleDone(focus.id)}>{st.cur ? 'Done / skip' : 'Skip this'}</button>
        </div>
      </>
    ) : (
      <><div className="now-title">That's everything for today</div><div className="now-meta">All of Day {st.day.n}'s stops are done.</div></>
    );
  }

  return (
    <section className="status-card" id="status" aria-live="polite">
      <div className="status-top">
        <PillBadge key={pill.cls || 'info'} pill={pill} liveDot={livePill} />
        {locBtn}
      </div>
      <div>{body}</div>
    </section>
  );
}
