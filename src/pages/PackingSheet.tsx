// "Pack from the trip": packing items worked out from the trip itself — beaches, treks, places of
// worship, trains and flights, how many nights, and the forecast — grouped by why, all ticked.
// One tap adds them to the shared packing list.
import { useEffect, useState } from 'react';
import { Sheet } from '../components/Sheet';
import * as cloud from '../lib/cloud';
import { packingFor, type PackingSuggestion } from '../lib/plan';
import { toast } from '../lib/toast';
import type { Trip, User } from '../lib/types';
import { tripWeather, UNIT } from '../lib/weather';

export function PackingSheet({ trip, user, existing, onClose }: { trip: Trip; user: User; existing: string[]; onClose: () => void }) {
  const [items, setItems] = useState<PackingSuggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let gone = false;
    // The forecast if it's available (cached or quick); the rest works without it.
    type Wx = Awaited<ReturnType<typeof tripWeather>>;
    const none = (): Wx => new Map();
    const wx = Promise.race([tripWeather(trip), new Promise<Wx>((r) => setTimeout(() => r(none()), 4000))]).catch(none);
    wx.then((weather) => {
      if (gone) return;
      const list = packingFor(trip, weather, existing, UNIT);
      setItems(list);
      setPicked(new Set(list.map((x) => x.text)));
    });
    return () => { gone = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = new Map<string, PackingSuggestion[]>();
  for (const x of items || []) groups.set(x.why, [...(groups.get(x.why) || []), x]);
  const toggle = (t: string) => setPicked((p) => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  const add = async () => {
    setAdding(true);
    const chosen = (items || []).filter((x) => picked.has(x.text));
    try {
      for (const x of chosen) await cloud.addChecklistItem(user, trip.id, 'packing', x.text);
      toast(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} to the packing list`, 'ok');
      onClose();
    } catch (e) { toast((e as Error).message, 'bad'); setAdding(false); }
  };

  return (
    <Sheet
      title="✨ Pack from the trip"
      onClose={onClose}
      foot={items?.length ? (
        <>
          <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn" type="button" disabled={adding || !picked.size} onClick={add}>{adding ? 'Adding…' : `Add ${picked.size} item${picked.size === 1 ? '' : 's'}`}</button>
        </>
      ) : undefined}
    >
      {!items ? (
        <div className="home-skel"><div className="sk-line w40" /><div className="sk-line" /><div className="sk-line" /><div className="sk-line w25" /></div>
      ) : !items.length ? (
        <p className="fine">Your packing list already covers everything this trip suggests. 🎉</p>
      ) : (
        <>
          <p className="fine">Worked out from your stops, the forecast and how long you're away. Untick anything you don't need.</p>
          {[...groups].map(([why, list]) => (
            <div key={why} className="pk-group">
              <div className="pk-why">{why}</div>
              <div className="pk-items">
                {list.map((x) => (
                  <label key={x.text} className={`pk-item${picked.has(x.text) ? ' on' : ''}`}>
                    <input type="checkbox" checked={picked.has(x.text)} onChange={() => toggle(x.text)} />
                    <span>{x.text}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </Sheet>
  );
}
