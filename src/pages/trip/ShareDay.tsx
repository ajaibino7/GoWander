// "Share today's plan": the day as a ready-to-send WhatsApp message (times, places with map
// links, tickets, notes), with a preview. WhatsApp opens with the text filled in; Copy and the
// phone's own share sheet work for any other app.
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { dayMessage } from '../../lib/plan';
import { toast } from '../../lib/toast';
import type { Day, Trip } from '../../lib/types';
import type { DayWeather } from '../../lib/weather';

export function ShareDaySheet({ trip, day, n, weather, onClose }: { trip: Trip; day: Day; n: number; weather?: DayWeather | null; onClose: () => void }) {
  const [text, setText] = useState(() => dayMessage(trip, day, n, weather));
  const canShare = typeof navigator.share === 'function';
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into any chat.', 'ok'); } catch { toast('Couldn\'t copy. Select the text and copy it instead.', 'bad'); }
  };
  const share = async () => {
    try { await navigator.share({ text }); onClose(); } catch (e) { if ((e as Error).name !== 'AbortError') copy(); }
  };
  return (
    <Sheet
      title={`Share Day ${n}`}
      onClose={onClose}
      className="share-sheet"
      foot={(
        <>
          <button className="btn ghost" type="button" onClick={copy}>Copy</button>
          {canShare ? <button className="btn ghost" type="button" onClick={share}>More apps…</button> : null}
          <a className="btn wa" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener" onClick={onClose}>
            <span className="wa-ic" aria-hidden="true">💬</span> WhatsApp
          </a>
        </>
      )}
    >
      <p className="fine">The day's plan with times and map links. Edit the message before sending if you like.</p>
      <textarea className="share-text" value={text} onChange={(e) => setText(e.target.value)} rows={12} aria-label="Message" spellCheck={false} />
    </Sheet>
  );
}
