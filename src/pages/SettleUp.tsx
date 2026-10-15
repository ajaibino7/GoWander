// Settling up: what each person still owes each other person — netted both ways, minus what's
// already been paid back — so only the remaining amount ever shows. "Pay" opens your UPI app with
// that person and the amount filled in; when you come back, one tap records the payment and the
// balances update for everyone.
import { useEffect, useState } from 'react';
import { displayName } from '../app/names';
import { Avatars } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import * as cloud from '../lib/cloud';
import { isUpiId, money, pairwiseDebts, round2, upiLink, type Debt } from '../lib/expenses';
import { ask, toast } from '../lib/toast';
import type { Expense, Profile, TripEntry, User } from '../lib/types';
import { makeClock } from '../lib/util';
import qrcode from 'qrcode-generator';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isPhone = () => matchMedia('(pointer: coarse)').matches;

/** Records "from paid to" as a settlement: their balances update for everyone. */
async function recordPayment(user: User, entry: TripEntry, d: Debt, amount: number) {
  const today = makeClock(entry.trip.timezone).dateKey(new Date());
  await cloud.saveExpense(user, entry.trip.id, {
    title: `${displayName(d.from)} paid ${displayName(d.to)}`.slice(0, 120),
    amount: round2(amount), currency: d.currency, paidBy: d.from, split: [d.to], date: today, kind: 'settlement',
  });
}

export function SettleUp({ entry, user, list, profiles }: { entry: TripEntry; user: User; list: Expense[]; profiles: Map<string, Profile> }) {
  const me = user.email;
  const debts = pairwiseDebts(list);
  const [paying, setPaying] = useState<Debt | null>(null);
  // The open payment follows the live balance (someone else may record a payment meanwhile).
  const payingNow = paying && debts.find((d) => d.from === paying.from && d.to === paying.to && d.currency === paying.currency);
  useEffect(() => { if (paying && !payingNow) setPaying(null); }, [paying, payingNow]);
  const mine = debts.filter((d) => d.from === me);
  const toMe = debts.filter((d) => d.to === me);
  const others = debts.filter((d) => d.from !== me && d.to !== me);
  const myUpi = profiles.get(me)?.upi || '';
  const anyReal = list.some((x) => x.kind !== 'settlement');

  const received = async (d: Debt) => {
    if (!(await ask(`Did ${displayName(d.from)} pay you ${money(d.amount, d.currency)}?`, { detail: 'This records the payment, and their balance with you goes to zero.', ok: 'Yes, I got it' }))) return;
    try { await recordPayment(user, entry, d, d.amount); toast('Payment recorded', 'ok'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const markOthers = async (d: Debt) => {
    if (!(await ask(`${displayName(d.from)} paid ${displayName(d.to)} ${money(d.amount, d.currency)}?`, { detail: 'Records the payment for both of them.', ok: 'Mark paid' }))) return;
    try { await recordPayment(user, entry, d, d.amount); toast('Payment recorded', 'ok'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const remind = async (d: Debt) => {
    const text = `Hi ${displayName(d.from)}! For our trip “${entry.trip.title}”, you owe me ${money(d.amount, d.currency)}.${myUpi && d.currency === 'INR' ? ` My UPI ID: ${myUpi}` : ''} (You can also pay from the trip's Expenses page in GoWander.)`;
    try {
      if (typeof navigator.share === 'function') await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('Reminder copied. Paste it into a chat.', 'ok'); }
    } catch (e) { if ((e as Error).name !== 'AbortError') window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener'); }
  };

  if (!anyReal) return null;
  return (
    <section className="ed-card ov-card settle">
      <h2 className="sec-h">Settle up</h2>
      {!debts.length ? (
        <div className="settled"><span aria-hidden="true">🎉</span><div><strong>All settled up</strong><span className="muted small">Nobody owes anybody anything.</span></div></div>
      ) : (
        <>
          <p className="fine">What's left to pay, person to person. Payments already made are taken off.</p>
          {mine.length ? (
            <div className="su-group">
              <h3 className="su-h owe">You owe</h3>
              <ul className="su-list">
                {mine.map((d) => (
                  <li key={`${d.currency}:${d.to}`} className="su-row">
                    <Avatars emails={[d.to]} />
                    <span className="su-who"><strong>{displayName(d.to)}</strong>{profiles.get(d.to)?.upi && d.currency === 'INR' ? <span className="muted small">UPI · {profiles.get(d.to)?.upi}</span> : null}</span>
                    <strong className="su-amt neg">{money(d.amount, d.currency)}</strong>
                    <button className="btn small pay" type="button" onClick={() => setPaying(d)}>Pay</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {toMe.length ? (
            <div className="su-group">
              <h3 className="su-h owed">Owed to you</h3>
              <ul className="su-list">
                {toMe.map((d) => (
                  <li key={`${d.currency}:${d.from}`} className="su-row">
                    <Avatars emails={[d.from]} />
                    <span className="su-who"><strong>{displayName(d.from)}</strong></span>
                    <strong className="su-amt pos">{money(d.amount, d.currency)}</strong>
                    <span className="su-acts">
                      <button className="btn ghost small" type="button" onClick={() => remind(d)}>Remind</button>
                      <button className="btn ghost small" type="button" onClick={() => received(d)}>Received</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {others.length ? (
            <div className="su-group">
              <h3 className="su-h">Between others</h3>
              <ul className="su-list">
                {others.map((d) => (
                  <li key={`${d.currency}:${d.from}:${d.to}`} className="su-row">
                    <Avatars emails={[d.from]} />
                    <span className="su-who"><span><strong>{displayName(d.from)}</strong> → <strong>{displayName(d.to)}</strong></span></span>
                    <strong className="su-amt">{money(d.amount, d.currency)}</strong>
                    <button className="btn ghost small" type="button" onClick={() => markOthers(d)}>Mark paid</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
      {toMe.some((d) => d.currency === 'INR') || myUpi ? <UpiCard tripId={entry.trip.id} user={user} current={myUpi} prompt={toMe.some((d) => d.currency === 'INR') && !myUpi} /> : null}
      {payingNow ? <PaySheet entry={entry} user={user} debt={payingNow} payee={profiles.get(payingNow.to)} onClose={() => setPaying(null)} /> : null}
    </section>
  );
}

/* ---------- paying someone ---------- */
function PaySheet({ entry, user, debt, payee, onClose }: { entry: TripEntry; user: User; debt: Debt; payee: Profile | undefined; onClose: () => void }) {
  const [amount, setAmount] = useState(String(debt.amount));
  const [launched, setLaunched] = useState(false);
  const [back, setBack] = useState(false);
  const [saving, setSaving] = useState(false);
  const n = round2(Number(amount) || 0);
  const name = displayName(debt.to);
  const vpa = payee?.upi || '';
  const inr = debt.currency === 'INR';
  const valid = n > 0 && n <= debt.amount + 0.01;

  // Back from the UPI app: ask whether it went through.
  useEffect(() => {
    if (!launched) return undefined;
    const onVisible = () => { if (!document.hidden) setBack(true); };
    document.addEventListener('visibilitychange', onVisible);
    const t = setTimeout(() => setBack(true), 5000);
    return () => { document.removeEventListener('visibilitychange', onVisible); clearTimeout(t); };
  }, [launched]);

  const link = (scheme: string) => {
    const base = upiLink({ vpa, name, amount: n, note: `${entry.trip.title} · GoWander` });
    return base.replace(/^upi:\/\/pay/, scheme);
  };
  const open = (href: string) => { setLaunched(true); location.href = href; };
  const done = async () => {
    setSaving(true);
    try {
      await recordPayment(user, entry, debt, n);
      toast(n < debt.amount ? `Recorded ${money(n, debt.currency)}. ${money(debt.amount - n, debt.currency)} left to pay ${name}.` : `Paid ${name} ${money(n, debt.currency)}. You're settled up.`, 'ok');
      onClose();
    } catch (e) { toast((e as Error).message, 'bad'); setSaving(false); }
  };

  const qr = (() => {
    if (!inr || !vpa || isPhone() || !valid) return '';
    const q = qrcode(0, 'M');
    q.addData(link('upi://pay'));
    q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  })();

  return (
    <Sheet title={`Pay ${name}`} onClose={onClose} className="pay-sheet">
      <div className="pay-head">
        <Avatars emails={[debt.to]} />
        <div><strong>{name}</strong>{vpa && inr ? <span className="muted small mono">{vpa}</span> : null}</div>
      </div>
      <label className="fld pay-amt"><span>Amount{n < debt.amount && valid ? <small className="muted"> · part of {money(debt.amount, debt.currency)}</small> : null}</span>
        <span className="pay-amt-in"><span className="pay-cur">{inr ? '₹' : debt.currency}</span><input type="number" inputMode="decimal" min="1" step="0.01" max={debt.amount} value={amount} onChange={(e) => { setAmount(e.target.value); setBack(false); }} /></span>
      </label>
      {!valid ? <p className="pp-err">{n > debt.amount ? `That's more than you owe (${money(debt.amount, debt.currency)}).` : 'Enter an amount.'}</p> : null}

      {back || (launched && !isPhone()) ? (
        <div className="pay-confirm">
          <strong>Did the payment of {money(n, debt.currency)} go through?</strong>
          <div className="pay-btns">
            <button className="btn" type="button" disabled={saving || !valid} onClick={done}>{saving ? 'Saving…' : 'Yes, mark as paid'}</button>
            <button className="btn ghost" type="button" onClick={() => { setBack(false); setLaunched(false); }}>No, try again</button>
          </div>
        </div>
      ) : !inr ? (
        <p className="fine">UPI works in rupees only. Pay {name} your usual way, then mark it as paid.</p>
      ) : !vpa ? (
        <div className="status-msg warn">{name} hasn't added a UPI ID yet. Ask them to add it on this trip's Expenses page (under Settle up), or pay another way and mark it as paid.</div>
      ) : isPhone() ? (
        <div className="pay-apps">
          {isIOS() ? (
            <>
              <button className="pay-app" type="button" disabled={!valid} onClick={() => open(link('gpay://upi/pay'))}><span className="pa-ic gpay">G</span>Google Pay</button>
              <button className="pay-app" type="button" disabled={!valid} onClick={() => open(link('phonepe://pay'))}><span className="pa-ic phonepe">पे</span>PhonePe</button>
              <button className="pay-app" type="button" disabled={!valid} onClick={() => open(link('paytmmp://pay'))}><span className="pa-ic paytm">P</span>Paytm</button>
              <button className="pay-app" type="button" disabled={!valid} onClick={() => open(link('upi://pay'))}><span className="pa-ic upi">₹</span>Other UPI app</button>
            </>
          ) : (
            <button className="btn pay-main" type="button" disabled={!valid} onClick={() => open(link('upi://pay'))}>Pay {money(n, debt.currency)} with a UPI app</button>
          )}
          <p className="fine">Your UPI app opens with {name} and the amount filled in. Check both, then enter your UPI PIN there.</p>
        </div>
      ) : (
        <>
          {qr ? <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} /> : null}
          <p className="fine">Scan with any UPI app on your phone: {name} and the amount are filled in.</p>
          <button className="btn ghost" type="button" onClick={() => setLaunched(true)}>I've scanned and paid</button>
        </>
      )}

      {!back && !(launched && !isPhone()) ? (
        <button className="link-btn pay-other" type="button" disabled={!valid || saving} onClick={done}>Paid another way (cash, bank)? Mark {money(n || 0, debt.currency)} as paid</button>
      ) : null}
    </Sheet>
  );
}

/* ---------- your UPI ID ---------- */
function UpiCard({ tripId, user, current, prompt }: { tripId: string; user: User; current: string; prompt: boolean }) {
  const [edit, setEdit] = useState(prompt);
  const [vpa, setVpa] = useState(current);
  useEffect(() => { if (prompt) setEdit(true); }, [prompt]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = vpa.trim();
    if (v && !isUpiId(v)) { toast('A UPI ID looks like name@bank, e.g. ravi@okicici.', 'bad'); return; }
    setEdit(false);
    try { await cloud.setMyProfile(user, tripId, { upi: v }); toast(v ? 'UPI ID saved. Friends can now pay you in one tap.' : 'UPI ID removed', 'ok'); } catch (err) { toast((err as Error).message, 'bad'); }
  };
  if (!edit) {
    return (
      <div className="upi-me">
        <span>💳 Your UPI ID: <strong>{current}</strong></span>
        <button className="link-btn" type="button" onClick={() => { setVpa(current); setEdit(true); }}>Change</button>
      </div>
    );
  }
  return (
    <form className="upi-form" noValidate onSubmit={save}>
      <label className="fld"><span>💳 Your UPI ID, so friends can pay you in one tap</span>
        <input inputMode="email" autoCapitalize="off" spellCheck={false} placeholder="yourname@okicici" value={vpa} onChange={(e) => setVpa(e.target.value)} />
      </label>
      <div className="form-acts">
        {current ? <button className="btn ghost" type="button" onClick={() => setEdit(false)}>Cancel</button> : null}
        <button className="btn" type="submit">Save</button>
      </div>
    </form>
  );
}

