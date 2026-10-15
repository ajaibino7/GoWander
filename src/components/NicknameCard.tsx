// "Your name on this trip": the nickname everyone sees instead of your email — in expenses,
// polls, the journal, the group map. On the Members page, and as a one-time nudge on the trip page.
import { useState } from 'react';
import { lastNickname, rememberNickname } from '../app/names';
import * as cloud from '../lib/cloud';
import { firstName } from '../lib/greeting';
import { toast } from '../lib/toast';
import type { User } from '../lib/types';

export function NicknameCard({ tripId, user, current, onDismiss }: {
  tripId: string; user: User; current: string;
  /** Shown as a nudge (trip page): a ✕ to hide it, and it hides itself once saved. */
  onDismiss?: () => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Suggest the name you used last time, else your first name.
  const shown = value ?? (current || lastNickname() || firstName(user));
  const changed = shown.trim() !== current;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = shown.trim().replace(/\s+/g, ' ').slice(0, 30);
    if (onDismiss && !n) return;
    setSaving(true);
    try {
      await cloud.setMyProfile(user, tripId, { nickname: n });
      if (n) rememberNickname(n);
      setValue(null);
      toast(n ? `The group now sees you as “${n}”` : 'Nickname removed. The group sees your email name again.', 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); }
    setSaving(false);
  };
  return (
    <section className={`ed-card nick-card${current ? '' : ' empty'}${onDismiss ? ' nudge' : ''}`}>
      <div className="nick-top">
        <h2 className="sec-h">{onDismiss ? 'What should the group call you?' : 'Your name on this trip'}</h2>
        {onDismiss ? <button className="icon-btn" type="button" aria-label="Not now" title="Not now" onClick={onDismiss}>✕</button> : null}
      </div>
      <p className="fine">{current ? 'Shown to everyone instead of your email.' : 'Pick a name the group sees instead of your email: in expenses, polls, the journal and on the group map.'}</p>
      <form className="nick-form" noValidate onSubmit={save}>
        <span className="nick-av" aria-hidden="true">{(shown.trim()[0] || user.email[0] || '?').toUpperCase()}</span>
        <input maxLength={30} placeholder="e.g. Ravi, Mom, Captain" value={shown} onChange={(e) => setValue(e.target.value)} aria-label="Your nickname on this trip" autoComplete="nickname" />
        <button className="btn" type="submit" disabled={saving || !changed || (!!onDismiss && !shown.trim())}>{saving ? 'Saving…' : current ? 'Update' : 'Save'}</button>
      </form>
    </section>
  );
}
