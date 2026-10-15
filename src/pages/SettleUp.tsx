// Settling up: what each person still owes each other person — netted both ways, minus what's
// already been paid back — so only the remaining amount ever shows. "Pay" opens your UPI app with
// that person and the amount filled in; when you come back, one tap records the payment and the
// balances update for everyone. "Remind" nudges someone in the app, or by a message in any chat app.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { displayName } from '../app/names';
import { ago } from '../app/reminders';
import { Avatars } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import * as cloud from '../lib/cloud';
import { isUpiId, money, pairwiseDebts, round2, upiLink, type Debt } from '../lib/expenses';
import { ask, toast } from '../lib/toast';
import type { Expense, Profile, Reminder, TripEntry, User } from '../lib/types';
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

const quiet = (p: Promise<unknown>) => { p.catch(() => {}); };

export function SettleUp({ entry, user, list, profiles, reminders, payTo }: {
  entry: TripEntry; user: User; list: Expense[]; profiles: Map<string, Profile>; reminders: Reminder[];
  /** Open the payment to this person straight away (from a reminder on the trip page). */
  payTo?: string | null;
}) {
  const me = user.email;
  const tripId = entry.trip.id;
  const debts = pairwiseDebts(list);
  const [paying, setPaying] = useState<Debt | null>(null);
  // Opened from a reminder: open that payment as soon as the balance with them is known.
  const pendingPay = useRef(payTo || null);
  const payToDebt = pendingPay.current ? debts.find((d) => d.from === me && d.to === pendingPay.current) : undefined;
  useEffect(() => { if (payToDebt) { pendingPay.current = null; setPaying(payToDebt); } }, [payToDebt]);
  const [reminding, setReminding] = useState<Debt | null>(null);
  // The open payment follows the live balance (someone else may record a payment meanwhile).
  const payingNow = paying && debts.find((d) => d.from === paying.from && d.to === paying.to && d.currency === paying.currency);
  useEffect(() => { if (paying && !payingNow) setPaying(null); }, [paying, payingNow]);
  const mine = debts.filter((d) => d.from === me);
  const toMe = debts.filter((d) => d.to === me);
  const others = debts.filter((d) => d.from !== me && d.to !== me);
  const myUpi = profiles.get(me)?.upi || '';
  const anyReal = list.some((x) => x.kind !== 'settlement');
  const reminderFor = (from: string, to: string) => reminders.find((r) => r.from === from && r.to === to);
  const remindingNow = reminding && toMe.find((d) => d.from === reminding.from && d.currency === reminding.currency);
  useEffect(() => { if (reminding && !remindingNow) setReminding(null); }, [reminding, remindingNow]);

  // Reminders about debts that are now paid off have done their job: clear them.
  const stale = reminders.filter((r) => (r.to === me || r.from === me) && !debts.some((d) => d.from === r.to && d.to === r.from));
  const staleKey = stale.map((r) => `${r.from}>${r.to}`).join();
  useEffect(() => {
    if (anyReal) stale.forEach((r) => quiet(cloud.clearReminder(tripId, r.from, r.to)));
  }, [staleKey, anyReal]); // eslint-disable-line react-hooks/exhaustive-deps

  const received = async (d: Debt) => {
    if (!(await ask(`Did ${displayName(d.from)} pay you ${money(d.amount, d.currency)}?`, { detail: 'This records the payment, and their balance with you goes to zero.', ok: 'Yes, I got it' }))) return;
    try { await recordPayment(user, entry, d, d.amount); toast('Payment recorded', 'ok'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const markOthers = async (d: Debt) => {
    if (!(await ask(`${displayName(d.from)} paid ${displayName(d.to)} ${money(d.amount, d.currency)}?`, { detail: 'Records the payment for both of them.', ok: 'Mark paid' }))) return;
    try { await recordPayment(user, entry, d, d.amount); toast('Payment recorded', 'ok'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  if (!anyReal) return null;
  return (
    <section className="ed-card ov-card settle">
      <h2 className="sec-h">Settle up</h2>
      {!debts.length ? (
        <div className="su-done"><span aria-hidden="true">🎉</span><div><strong>All settled up</strong><span className="muted small">Nobody owes anybody anything.</span></div></div>
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
                    <span className="su-who">
                      <strong>{displayName(d.to)}</strong>
                      <ReminderNote r={reminderFor(d.to, me)} prefix="Reminded you" fallback={profiles.get(d.to)?.upi && d.currency === 'INR' ? `UPI · ${profiles.get(d.to)?.upi}` : ''} ask />
                    </span>
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
                    <span className="su-who">
                      <strong>{displayName(d.from)}</strong>
                      <ReminderNote r={reminderFor(me, d.from)} prefix="Reminded" />
                    </span>
                    <strong className="su-amt pos">{money(d.amount, d.currency)}</strong>
                    <span className="su-acts">
                      <button className="btn ghost small" type="button" onClick={() => setReminding(d)}>Remind</button>
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
      {remindingNow ? <RemindSheet entry={entry} user={user} debt={remindingNow} myUpi={myUpi} last={reminderFor(me, remindingNow.from)} onClose={() => setReminding(null)} /> : null}
      {payingNow ? <PaySheet entry={entry} user={user} debt={payingNow} payee={profiles.get(payingNow.to)} onClose={() => setPaying(null)} /> : null}
    </section>
  );
}

// "🔔 Reminded 2 h ago" under a name (or other small print when there's no reminder).
function ReminderNote({ r, prefix, fallback = '', ask: incoming = false }: { r: Reminder | undefined; prefix: string; fallback?: string; ask?: boolean }) {
  if (r) return <span className={`su-note${incoming ? ' ask' : ''}`}>🔔 {prefix} {ago(r.atMs)}</span>;
  return fallback ? <span className="muted small">{fallback}</span> : null;
}

/* ---------- reminding someone ---------- */
function RemindSheet({ entry, user, debt, myUpi, last, onClose }: {
  entry: TripEntry; user: User; debt: Debt; myUpi: string; last: Reminder | undefined; onClose: () => void;
}) {
  const [sending, setSending] = useState(false);
  const name = displayName(debt.from);
  const amount = money(debt.amount, debt.currency);
  const text = `Hi ${name}! A gentle reminder for our trip “${entry.trip.title}”: you owe me ${amount}.`
    + (myUpi && debt.currency === 'INR' ? ` My UPI ID is ${myUpi}.` : '')
    + ' You can pay me from the trip’s Expenses page in GoWander. Thanks!';
  // One in-app reminder an hour is plenty.
  const recent = !!last && Date.now() - last.atMs < 3600000;

  const inApp = async () => {
    setSending(true);
    try {
      await cloud.sendReminder(user, entry.trip.id, debt.from, debt.amount, debt.currency);
      toast(`Reminder sent. ${name} will see it in GoWander.`, 'ok');
      onClose();
    } catch (e) { toast((e as Error).message, 'bad'); setSending(false); }
  };
  const share = async () => {
    try { await navigator.share({ text }); } catch { /* closed the share sheet */ }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast('Message copied. Paste it into any chat.', 'ok'); } catch { toast('Couldn’t copy. Select the message and copy it.', 'bad'); }
  };

  return (
    <Sheet title={`Remind ${name}`} onClose={onClose} className="remind-sheet">
      <div className="pay-head">
        <Avatars emails={[debt.from]} />
        <div><strong>{name}</strong><span className="muted small">owes you <strong className="su-amt pos">{amount}</strong></span></div>
      </div>

      <div className="rm-opt">
        <div className="rm-row">
          <span className="rm-ic" aria-hidden="true">🔔</span>
          <div className="rm-body">
            <strong>Remind in GoWander</strong>
            <span className="muted small">{name} sees it on the trip and in Expenses, with a button to pay you.</span>
            {last ? <span className="su-note">Last reminded {ago(last.atMs)}</span> : null}
          </div>
        </div>
        <button className="btn" type="button" disabled={sending || recent} onClick={inApp}>
          {sending ? 'Sending…' : recent ? 'Reminder sent ✓' : last ? 'Remind again' : 'Send reminder'}
        </button>
      </div>

      <div className="rm-opt">
        <div className="rm-row">
          <span className="rm-ic" aria-hidden="true">💬</span>
          <div className="rm-body">
            <strong>Send a message</strong>
            <span className="muted small">On WhatsApp or any other app.</span>
          </div>
        </div>
        <blockquote className="rm-msg">{text}</blockquote>
        <div className="rm-btns">
          <a className="btn wa" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">WhatsApp</a>
          {typeof navigator.share === 'function' ? <button className="btn ghost" type="button" onClick={share}>Other apps…</button> : null}
          <button className="btn ghost" type="button" onClick={copy}>Copy</button>
        </div>
      </div>
    </Sheet>
  );
}

/* ---------- paying someone ---------- */
function PaySheet({ entry, user, debt, payee, onClose }: { entry: TripEntry; user: User; debt: Debt; payee: Profile | undefined; onClose: () => void }) {
  // The full amount owed, following the live balance, until you type a different one.
  const [typed, setAmount] = useState<string | null>(null);
  const amount = typed ?? String(debt.amount);
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
      if (n >= debt.amount - 0.01) quiet(cloud.clearReminder(entry.trip.id, debt.to, debt.from));
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


/* ---------- on the trip page: "Asha is reminding you to pay" ---------- */
export function ReminderCard({ tripId, reminders, user }: { tripId: string; reminders: Reminder[]; user: User }) {
  const forMe = reminders.filter((r) => r.to === user.email).sort((a, b) => b.atMs - a.atMs);
  if (!forMe.length) return null;
  return (
    <section className="ed-card rm-card" aria-label="Payment reminders">
      {forMe.map((r) => (
        <div key={r.from} className="rm-item">
          <span className="rm-bell" aria-hidden="true">🔔</span>
          <span className="rm-text">
            <span><strong>{displayName(r.from)}</strong> is reminding you to pay <strong>{money(r.amount, r.currency)}</strong></span>
            <span className="muted small">{ago(r.atMs)}</span>
          </span>
          <Link className="btn small pay" to={`/expenses/${encodeURIComponent(tripId)}?pay=${encodeURIComponent(r.from)}`}>Pay</Link>
          <button className="icon-btn" type="button" aria-label={`Dismiss ${displayName(r.from)}'s reminder`} title="Dismiss" onClick={() => quiet(cloud.clearReminder(tripId, r.from, r.to))}>✕</button>
        </div>
      ))}
    </section>
  );
}
