// #/expenses/:id — shared expenses: who paid, split between whom, balances, and the fewest
// payments to settle up ("Mark paid" records a settlement).
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { useLeaving, useNewItems, useReveal } from '../app/motion';
import { nameOf, useTripWatch } from '../app/useTripWatch';
import { BackLink } from '../components/Hero';
import { Page, PageLoading } from '../components/Page';
import { Avatars, Icon } from '../components/Icons';
import * as cloud from '../lib/cloud';
import { CURRENCIES, balances, money, myShare, rememberCurrency, round2, settlements, tripCurrency, type Settlement } from '../lib/expenses';
import { ask, toast } from '../lib/toast';
import { fmtRange, makeClock } from '../lib/util';
import type { Expense, ExpenseInput } from '../lib/types';
import { HomePage } from './Home';
import { JoinTrip } from './trip/JoinTrip';

interface FormState { title: string; amount: string; currency: string; paidBy: string; split: string[]; date: string }

export function ExpensesPage() {
  const { id = '' } = useParams();
  const { user, authReady } = useAppData();
  const { entry, denied, retry } = useTripWatch(id, user);
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!user || !entry) return undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    cloud.watchExpenses(id, setExpenses, (err) => toast(err, 'bad')).then((u) => { if (cancelled) u(); else off = u; });
    return () => { cancelled = true; off?.(); };
  }, [id, user, !!entry]); // eslint-disable-line react-hooks/exhaustive-deps

  // The form starts with the trip's currency, today's date, you as the payer and everyone sharing.
  const members = entry?.meta.memberEmails ?? [];
  const today = entry ? makeClock(entry.trip.timezone).dateKey(new Date()) : '';
  const blankForm = (): FormState => ({
    title: '', amount: '', currency: entry ? tripCurrency(entry.trip) : 'INR', paidBy: user?.email || '', split: [...members], date: today,
  });
  useEffect(() => { if (entry && !form) setForm(blankForm()); }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps
  // Members can change while the page is open: keep the form to people still in the trip.
  useEffect(() => {
    if (!form) return;
    const split = form.split.filter((m) => members.includes(m));
    const paidBy = members.includes(form.paidBy) ? form.paidBy : user?.email || '';
    if (split.length !== form.split.length || paidBy !== form.paidBy) setForm({ ...form, split: split.length ? split : [...members], paidBy });
  }, [members.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useReveal(ref, '.ex-row, .ex-bal li, .ex-moves li', !!expenses);
  // Expenses someone adds slide in; deleted ones slide away.
  const isNew = useNewItems(expenses ? expenses.map((x) => x.id) : null);
  const [leaving, leave] = useLeaving();

  if (!authReady) return <PageLoading viewId="view-expenses" eyebrow="Expenses" back={<BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />} tripId={id} />;
  if (!user) return <HomePage message="Sign in with Google to open this trip." />;
  if (denied) return <JoinTrip id={id} onJoined={retry} />;
  if (!entry || !form) return <PageLoading viewId="view-expenses" eyebrow="Expenses" back={<BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />} tripId={id} />;

  const list = expenses || [];
  const by = balances(list);
  const me = user.email;
  const moves = [...by].flatMap(([cur, c]) => settlements(c.bal).map((m) => ({ ...m, cur })));
  const rows = [...list].sort((a, b) => b.date.localeCompare(a.date) || b.createdMs - a.createdMs);
  const who = (e: string) => nameOf(e, user);
  const resetForm = () => { setEditing(null); setForm(blankForm()); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = form.title.trim();
    const amount = round2(Number(form.amount));
    if (!title) { toast('Say what the expense was for.', 'bad'); titleRef.current?.focus(); return; }
    if (!(amount > 0)) { toast('Enter an amount above zero.', 'bad'); amountRef.current?.focus(); return; }
    if (!form.split.length) { toast('Pick at least one person to split it with.', 'bad'); return; }
    const expense: ExpenseInput = { title, amount, currency: form.currency, paidBy: form.paidBy, split: form.split, date: form.date || today, kind: 'expense' };
    rememberCurrency(id, expense.currency);
    const wasEditing = editing;
    setEditing(null);
    setForm({ ...blankForm(), currency: expense.currency });
    try {
      await cloud.saveExpense(user, id, expense, wasEditing);
      toast(wasEditing ? 'Expense updated' : `Added ${money(amount, expense.currency)} · ${title}`, 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); }
  };

  const markPaid = async (m: Settlement & { cur: string }) => {
    if (!(await ask(`${who(m.from)} paid ${who(m.to)} ${money(m.amount, m.cur)}?`, { detail: 'This records the payment and updates everyone\'s balance.', ok: 'Mark paid' }))) return;
    try {
      await cloud.saveExpense(user, id, {
        title: `${m.from.split('@')[0]} paid back ${m.to.split('@')[0]}`,
        amount: m.amount, currency: m.cur, paidBy: m.from, split: [m.to], date: today, kind: 'settlement',
      });
      toast('Payment recorded', 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); }
  };

  return (
    <Page
      viewId="view-expenses"
      hero={{ eyebrow: 'Expenses', title: entry.trip.title, nav: <BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />, tripId: id }}
      foot="Shared with everyone on this trip. Changes sync live, and work offline too."
    >
      <div ref={ref} style={{ display: 'contents' }}>
        <section className="ed-card ex-summary">
          {by.size ? [...by].map(([cur, c]) => {
            const mine = round2(c.bal.get(me) || 0);
            return (
              <div key={cur} style={{ display: 'contents' }}>
                <div className="ex-stats">
                  <div className="stat"><div className="k">Total spent</div><div className="v">{money(c.spent, cur)}</div></div>
                  <div className="stat"><div className="k">Your share</div><div className="v">{money(myShare(list, me, cur), cur)}</div></div>
                  <div className={`stat ${mine > 0.009 ? 'pos' : mine < -0.009 ? 'neg' : ''}`.trim()}>
                    <div className="k">{mine > 0.009 ? 'You are owed' : mine < -0.009 ? 'You owe' : 'Your balance'}</div>
                    <div className="v">{mine > 0.009 || mine < -0.009 ? money(Math.abs(mine), cur) : 'Settled'}</div>
                  </div>
                </div>
                <ul className="ex-bal">
                  {[...c.bal].filter(([, v]) => Math.abs(v) > 0.009).sort((a, b) => b[1] - a[1]).map(([p, v]) => (
                    <li key={p}><span><Avatars emails={[p]} /> {who(p)}</span><span className={v > 0 ? 'pos' : 'neg'}>{v > 0 ? 'gets back' : 'owes'} {money(Math.abs(v), cur)}</span></li>
                  ))}
                </ul>
              </div>
            );
          }) : (
            <div className="ex-empty">
              <div className="empty-art" aria-hidden="true">🧾</div>
              <strong>No expenses yet</strong>
              <p className="fine">Log what each person pays. GoWander works out who owes whom, with the fewest payments.</p>
            </div>
          )}
        </section>

        {moves.length ? (
          <section className="ed-card">
            <h2 className="sec-h">Settle up</h2>
            <p className="fine">The fewest payments that square everyone up.</p>
            <ul className="ex-moves">
              {moves.map((m, i) => (
                <li key={`${m.cur}:${m.from}:${m.to}:${i}`}>
                  <span><Avatars emails={[m.from]} /> <strong>{who(m.from)}</strong> pays <strong>{who(m.to)}</strong> <Avatars emails={[m.to]} /></span>
                  <span className="ex-move-r"><strong>{money(m.amount, m.cur)}</strong>
                    <button className="btn ghost small" type="button" onClick={() => markPaid(m)}>Mark paid</button></span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="ed-card">
          <h2 className="sec-h">{editing ? 'Edit expense' : 'Add an expense'}</h2>
          <form ref={formRef} className="form ex-form" noValidate onSubmit={submit}>
            <div className="grid2">
              <label className="fld"><span>What for</span><input ref={titleRef} maxLength={120} placeholder="e.g. Dinner at Colaba" autoComplete="off" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
              <div className="ex-amt">
                <label className="fld"><span>Amount</span><input ref={amountRef} type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
                <label className="fld"><span>Currency</span>
                  <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                    {[...new Set([form.currency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <div className="grid2">
              <label className="fld"><span>Paid by</span>
                <select value={form.paidBy} onChange={(e) => setForm({ ...form, paidBy: e.target.value })}>
                  {members.map((m) => <option key={m} value={m}>{who(m)}{m === me ? '' : ` (${m})`}</option>)}
                </select>
              </label>
              <label className="fld"><span>Date</span><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
            </div>
            <div className="fld"><span>Split equally between</span>
              <div className="ex-split">
                {members.map((m) => (
                  <label key={m} className="chk ex-who">
                    <input type="checkbox" checked={form.split.includes(m)} onChange={(e) => setForm({ ...form, split: e.target.checked ? [...form.split, m] : form.split.filter((x) => x !== m) })} /> {who(m)}
                  </label>
                ))}
              </div>
            </div>
            <div className="home-actions">
              <button className="btn" type="submit">{editing ? 'Save changes' : 'Add expense'}</button>
              {editing ? <button className="btn ghost" type="button" onClick={resetForm}>Cancel edit</button> : null}
            </div>
          </form>
        </section>

        <section className="ed-card">
          <h2 className="sec-h">All expenses</h2>
          <ul className="ex-list">
            {rows.length ? rows.map((x) => (
              <li key={x.id} className={`ex-row${x.kind === 'settlement' ? ' settle' : ''}${isNew(x.id) ? ' fresh' : ''}${leaving.has(x.id) ? ' leaving' : ''}`}>
                <span className="ex-ic" aria-hidden="true">{x.kind === 'settlement' ? '🤝' : '🧾'}</span>
                <span className="ex-main">
                  <span className="ex-title">{x.title}</span>
                  <span className="ex-meta">{fmtRange(x.date, x.date)} · {x.kind === 'settlement'
                    ? `${who(x.paidBy)} paid ${who(x.split[0] || '')}`
                    : `Paid by ${who(x.paidBy)} · ${x.split.length === members.length ? 'split with everyone' : `split ${x.split.length} way${x.split.length === 1 ? '' : 's'}`}`}</span>
                </span>
                <span className="ex-amtv">{money(x.amount, x.currency)}</span>
                <span className="ex-actions">
                  {x.kind === 'settlement' ? null : (
                    <button className="icon-link" type="button" title="Edit" aria-label={`Edit ${x.title}`} onClick={() => {
                      setEditing(x.id);
                      setForm({ title: x.title, amount: String(x.amount), currency: x.currency, paidBy: x.paidBy, split: [...x.split], date: x.date });
                      formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}><Icon.edit /></button>
                  )}
                  <button className="icon-btn" type="button" title="Delete" aria-label={`Delete ${x.title}`} onClick={async () => {
                    if (!(await ask(`Delete “${x.title}”?`, { detail: 'Balances update for everyone.', ok: 'Delete', danger: true }))) return;
                    if (editing === x.id) resetForm();
                    await leave(x.id, () => cloud.deleteListItem(id, 'expenses', x.id).catch((err: Error) => toast(err.message, 'bad')));
                  }}>✕</button>
                </span>
              </li>
            )) : <li className="muted small">Expenses you add appear here.</li>}
          </ul>
        </section>
      </div>
    </Page>
  );
}
