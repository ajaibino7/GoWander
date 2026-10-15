// #/expenses/:id — shared money for the trip, in three tabs:
//   Overview: totals, the budget (estimated vs actual, per day), where the money went (by
//     category and by person), and settling up: what's still owed, person to person, with a
//     Pay button that opens your UPI app with the person and amount filled in.
//   Add: what, how much, category, who paid, split equally or by amount, and a bill photo.
//   All: every expense and settlement, with the bill photo a tap away. Only whoever added an
//     expense (or recorded a payment) can edit or delete it.
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TripSubPage, type TripCtx } from '../app/TripSubPage';
import { useLeaving, useNewItems, useReveal } from '../app/motion';
import { useProfiles } from '../app/names';
import { useReminders } from '../app/reminders';
import { nameOf } from '../app/useTripWatch';
import { Bars, Donut } from '../components/Charts';
import { Avatars, Icon, avatarColor } from '../components/Icons';
import { Sheet } from '../components/Sheet';
import * as cloud from '../lib/cloud';
import { compressPhoto } from '../lib/editing';
import {
  CATEGORY_INFO, CATEGORY_KEYS, CURRENCIES, balances, categoryOf, guessCategory, money, myShare, rememberCurrency, round2,
  spendByCategory, spendByDay, spendByPerson, tripCurrency,
} from '../lib/expenses';
import { ask, toast } from '../lib/toast';
import { dayMonth, fmtRange, makeClock } from '../lib/util';
import type { Budget, Expense, ExpenseCategory, ExpenseInput, Profile, Reminder, TripEntry, User } from '../lib/types';
import { SettleUp } from './SettleUp';

type Tab = 'overview' | 'add' | 'all';
interface FormState {
  title: string; amount: string; currency: string; paidBy: string; split: string[]; date: string;
  category: ExpenseCategory | null; mode: 'equal' | 'amount'; shares: Record<string, string>;
  /** A new photo (data URL), '' to remove the saved one, or null for no change. */
  bill: string | null; hadBill: boolean;
}

export function ExpensesPage() {
  return (
    <TripSubPage viewId="view-expenses" eyebrow="Expenses" foot="Shared with everyone on this trip. Changes sync live, and work offline too.">
      {(ctx) => (ctx.entry && ctx.user ? <ExpensesBody ctx={ctx} entry={ctx.entry} user={ctx.user} /> : null)}
    </TripSubPage>
  );
}

let lastTab: Tab = 'overview';

function ExpensesBody({ ctx, entry, user }: { ctx: TripCtx; entry: TripEntry; user: User }) {
  const id = ctx.id;
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [budget, setBudgetState] = useState<Budget | null | undefined>(undefined);
  const profiles = useProfiles();
  const reminders = useReminders(id);
  // "?pay=<email>" (a reminder's Pay button on the trip page): open that payment once.
  const [params, setParams] = useSearchParams();
  const [payTo] = useState(() => params.get('pay'));
  useEffect(() => { if (params.has('pay')) setParams({}, { replace: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTabState] = useState<Tab>(payTo ? 'overview' : lastTab);
  const setTab = (t: Tab) => { lastTab = t; setTabState(t); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const [editing, setEditing] = useState<string | null>(null);
  const [viewBill, setViewBill] = useState<Expense | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const offs: (() => void)[] = [];
    let gone = false;
    const keep = (u: () => void) => { if (gone) u(); else offs.push(u); };
    cloud.watchExpenses(id, setExpenses, (e) => toast(e, 'bad')).then(keep);
    cloud.watchBudget(id, setBudgetState).then(keep);
    return () => { gone = true; offs.forEach((u) => u()); };
  }, [id]);

  const members = entry.meta.memberEmails;
  const today = makeClock(entry.trip.timezone).dateKey(new Date());
  const blankForm = (): FormState => ({
    title: '', amount: '', currency: tripCurrency(entry.trip), paidBy: user.email, split: [...members], date: today,
    category: null, mode: 'equal', shares: {}, bill: null, hadBill: false,
  });
  const [form, setForm] = useState<FormState>(blankForm);
  // Members can change while the page is open: keep the form to people still in the trip.
  useEffect(() => {
    const split = form.split.filter((m) => members.includes(m));
    const paidBy = members.includes(form.paidBy) ? form.paidBy : user.email;
    if (split.length !== form.split.length || paidBy !== form.paidBy) setForm({ ...form, split: split.length ? split : [...members], paidBy });
  }, [members.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  useReveal(ref, '.ex-row, .ex-moves li, .ov-card', !!expenses);
  const isNew = useNewItems(expenses ? expenses.map((x) => x.id) : null);
  const [leaving, leave] = useLeaving();

  const list = expenses || [];
  const who = (e: string) => nameOf(e, user);
  const mine = (x: Expense) => x.createdBy === user.email;
  const startEdit = (x: Expense) => {
    if (!mine(x)) return;
    setEditing(x.id);
    setForm({
      title: x.title, amount: String(x.amount), currency: x.currency, paidBy: x.paidBy, split: [...x.split], date: x.date,
      category: x.category ?? null, mode: x.shares ? 'amount' : 'equal',
      shares: x.shares ? Object.fromEntries(Object.entries(x.shares).map(([k, v]) => [k, String(v)])) : {},
      bill: null, hadBill: !!x.hasBill,
    });
    setTab('add');
  };
  const removeExpense = async (x: Expense) => {
    if (!mine(x)) return;
    if (!(await ask(`Delete “${x.title}”?`, { detail: 'Balances update for everyone.', ok: 'Delete', danger: true }))) return;
    if (editing === x.id) { setEditing(null); setForm(blankForm()); }
    await leave(x.id, async () => {
      try {
        await cloud.deleteListItem(id, 'expenses', x.id);
        if (x.hasBill) cloud.deletePhoto(id, `bill-${x.id}`).catch(() => {});
      } catch (err) { toast((err as Error).message, 'bad'); }
    });
  };

  const tabs: [Tab, string][] = [['overview', 'Overview'], ['add', editing ? 'Edit' : 'Add expense'], ['all', `All${list.length ? ` (${list.length})` : ''}`]];

  return (
    <div ref={ref} style={{ display: 'contents' }}>
      <div className="ex-tabs" role="tablist" aria-label="Expenses" style={{ '--i': tabs.findIndex(([t]) => t === tab) } as React.CSSProperties}>
        {/* The highlight that slides to the chosen tab. */}
        <span className="ex-ind" aria-hidden="true" />
        {tabs.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`ex-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {tab === 'overview' ? (
        <Overview ctx={ctx} entry={entry} user={user} list={list} budget={budget} profiles={profiles} reminders={reminders} payTo={payTo} who={who} onAdd={() => setTab('add')} />
      ) : tab === 'add' ? (
        <AddForm
          entry={entry} user={user} form={form} setForm={setForm} editing={editing} who={who}
          onCancel={() => { setEditing(null); setForm(blankForm()); setTab(editing ? 'all' : 'overview'); }}
          onSaved={(wasEditing) => { setEditing(null); setForm({ ...blankForm(), currency: form.currency }); if (wasEditing) setTab('all'); }}
        />
      ) : (
        <section className="ed-card">
          <h2 className="sec-h">All expenses</h2>
          <ul className="ex-list">
            {list.length ? [...list].sort((a, b) => b.date.localeCompare(a.date) || b.createdMs - a.createdMs).map((x) => {
              const cat = CATEGORY_INFO[categoryOf(x)];
              return (
                <li key={x.id} className={`ex-row${x.kind === 'settlement' ? ' settle' : ''}${isNew(x.id) ? ' fresh' : ''}${leaving.has(x.id) ? ' leaving' : ''}`}>
                  <span className="ex-ic" aria-hidden="true" style={x.kind === 'settlement' ? undefined : { background: `color-mix(in srgb, ${cat.color} 16%, var(--surface))` }}>{x.kind === 'settlement' ? '🤝' : cat.icon}</span>
                  <span className="ex-main">
                    <span className="ex-title">{x.kind === 'settlement' ? `${who(x.paidBy)} paid ${who(x.split[0] || '')}` : x.title}</span>
                    <span className="ex-meta">{fmtRange(x.date, x.date)} · {x.kind === 'settlement'
                      ? 'Settle-up payment'
                      : `Paid by ${who(x.paidBy)} · ${x.shares ? 'split by amount' : x.split.length === members.length ? 'split with everyone' : `split ${x.split.length} way${x.split.length === 1 ? '' : 's'}`}`}
                      {!mine(x) && x.createdBy !== x.paidBy ? ` · added by ${who(x.createdBy)}` : ''}</span>
                  </span>
                  <span className="ex-amtv">{money(x.amount, x.currency)}</span>
                  <span className="ex-actions">
                    {x.hasBill ? <button className="icon-link" type="button" title="See the bill" aria-label={`Bill for ${x.title}`} onClick={() => setViewBill(x)}><Icon.camera /></button> : null}
                    {mine(x) && x.kind !== 'settlement' ? <button className="icon-link" type="button" title="Edit" aria-label={`Edit ${x.title}`} onClick={() => startEdit(x)}><Icon.edit /></button> : null}
                    {mine(x) ? <button className="icon-btn" type="button" title="Delete" aria-label={`Delete ${x.title}`} onClick={() => removeExpense(x)}>✕</button> : null}
                  </span>
                </li>
              );
            }) : <li className="muted small">Expenses you add appear here.</li>}
          </ul>
          {list.some((x) => !mine(x)) ? <p className="fine">Only the person who added an expense can edit or delete it.</p> : null}
        </section>
      )}

      {viewBill ? <BillSheet tripId={id} expense={viewBill} onClose={() => setViewBill(null)} /> : null}
    </div>
  );
}

/* ============================================================
   Overview: totals, budget, settle up, charts
   ============================================================ */
function Overview({ ctx, entry, user, list, budget, profiles, reminders, payTo, who, onAdd }: {
  ctx: TripCtx; entry: TripEntry; user: User; list: Expense[]; budget: Budget | null | undefined; profiles: Map<string, Profile>;
  reminders: Reminder[]; payTo: string | null; who: (e: string) => string; onAdd: () => void;
}) {
  const by = balances(list);
  const me = user.email;
  // The main currency: the budget's, else whichever was used most.
  const curs = [...by.keys()];
  const main = budget?.currency || [...curs].sort((a, b) => (by.get(b)?.spent || 0) - (by.get(a)?.spent || 0))[0] || tripCurrency(entry.trip);
  const fmt = (n: number) => money(round2(n), main);
  const cats = spendByCategory(list, main);
  const people = spendByPerson(list, main);

  if (!list.length) {
    return (
      <>
        <section className="ed-card empty-card ov-card">
          <div className="empty-art" aria-hidden="true">🧾</div>
          <strong>No expenses yet</strong>
          <p className="fine">Log what each person pays. GoWander keeps track of who owes whom, and you can pay each other back with UPI in a tap.</p>
          <div><button className="btn" type="button" onClick={onAdd}><Icon.plus /> Add the first expense</button></div>
        </section>
        <BudgetCard ctx={ctx} entry={entry} user={user} budget={budget} list={list} />
      </>
    );
  }

  return (
    <>
      <section className="ed-card ex-summary ov-card">
        {[...by].map(([cur, c]) => {
          const mine = round2(c.bal.get(me) || 0);
          return (
            <div key={cur} className="ex-stats">
              <div className="stat"><div className="k">Total spent</div><div className="v">{money(c.spent, cur)}</div></div>
              <div className="stat"><div className="k">Your share</div><div className="v">{money(myShare(list, me, cur), cur)}</div></div>
              <div className={`stat ${mine > 0.009 ? 'pos' : mine < -0.009 ? 'neg' : ''}`.trim()}>
                <div className="k">{mine > 0.009 ? 'You are owed' : mine < -0.009 ? 'You owe' : 'Your balance'}</div>
                <div className="v">{mine > 0.009 || mine < -0.009 ? money(Math.abs(mine), cur) : 'Settled'}</div>
              </div>
            </div>
          );
        })}
      </section>

      <BudgetCard ctx={ctx} entry={entry} user={user} budget={budget} list={list} />

      <SettleUp entry={entry} user={user} list={list} profiles={profiles} reminders={reminders} payTo={payTo} />

      {cats.length ? (
        <section className="ed-card ov-card">
          <h2 className="sec-h">Where the money went</h2>
          <Donut
            segments={cats.map(([k, v]) => ({ key: k, label: CATEGORY_INFO[k].label, icon: CATEGORY_INFO[k].icon, value: v, color: CATEGORY_INFO[k].color }))}
            center={fmt(cats.reduce((s, [, v]) => s + v, 0))}
            sub={curs.length > 1 ? `in ${main} only` : 'spent'}
            format={fmt}
          />
          <h3 className="sub-h">Each person's share</h3>
          <Bars
            bars={[...people].sort((a, b) => b[1] - a[1]).map(([p, v]) => ({ key: p, label: <><Avatars emails={[p]} /> {who(p)}</>, value: v, color: avatarColor(p) }))}
            format={fmt}
            marker={budget && budget.currency === main && budget.perPerson ? { value: budget.perPerson, label: 'Budget per person' } : undefined}
          />
        </section>
      ) : null}

    </>
  );
}

/* ---------- budget ---------- */
function BudgetCard({ ctx, entry, user, budget, list }: { ctx: TripCtx; entry: TripEntry; user: User; budget: Budget | null | undefined; list: Expense[] }) {
  const [edit, setEdit] = useState(false);
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(tripCurrency(entry.trip));
  if (budget === undefined) return null; // still loading
  const members = entry.meta.memberEmails.length;
  const startEdit = () => { setAmount(budget ? String(budget.perPerson) : ''); setCur(budget?.currency || tripCurrency(entry.trip)); setEdit(true); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = round2(Number(amount));
    if (!(n > 0)) { toast('Enter a budget per person above zero.', 'bad'); return; }
    setEdit(false);
    try { await cloud.setBudget(user, ctx.id, { perPerson: n, currency: cur }); toast('Budget saved', 'ok'); } catch (err) { toast((err as Error).message, 'bad'); }
  };

  if (edit) {
    return (
      <section className="ed-card ov-card">
        <h2 className="sec-h">Trip budget</h2>
        <form className="form budget-form" noValidate onSubmit={save}>
          <div className="ex-amt">
            <label className="fld"><span>Per person</span><input type="number" inputMode="decimal" min="1" step="1" placeholder="e.g. 15000" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
            <label className="fld"><span>Currency</span>
              <select value={cur} onChange={(e) => setCur(e.target.value)}>{[...new Set([cur, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}</select>
            </label>
          </div>
          <p className="fine">For {members} {members === 1 ? 'person' : 'people'}: {amount && Number(amount) > 0 ? money(Number(amount) * members, cur) : '—'} in total.</p>
          <div className="form-acts">
            {budget ? <button className="btn ghost danger" type="button" onClick={async () => { setEdit(false); await cloud.setBudget(user, ctx.id, null).catch((err: Error) => toast(err.message, 'bad')); }}>Remove budget</button> : null}
            <button className="btn ghost" type="button" onClick={() => setEdit(false)}>Cancel</button>
            <button className="btn" type="submit">Save budget</button>
          </div>
        </form>
      </section>
    );
  }
  if (!budget) {
    return ctx.canEdit ? (
      <button className="smart-btn ov-card" type="button" onClick={startEdit}>
        <span className="smart-spark" aria-hidden="true">🎯</span>
        <span><strong>Set a trip budget</strong><span className="muted small">See spending against it, day by day, with a heads-up before you go over</span></span>
        <span aria-hidden="true">›</span>
      </button>
    ) : null;
  }

  const total = budget.perPerson * members;
  const spent = list.filter((x) => x.currency === budget.currency && x.kind !== 'settlement').reduce((s, x) => s + x.amount, 0);
  const pct = total ? spent / total : 0;
  const tone = pct >= 1 ? 'bad' : pct >= 0.85 ? 'warn' : 'ok';
  const days = entry.trip.days;
  const perDay = days.length ? total / days.length : 0;
  const byDay = spendByDay(list, budget.currency);
  const fmt = (n: number) => money(round2(n), budget.currency);
  const other = list.some((x) => x.currency !== budget.currency && x.kind !== 'settlement');
  return (
    <section className="ed-card ov-card budget">
      <div className="sec-row">
        <h2 className="sec-h">Trip budget</h2>
        {ctx.canEdit ? <button className="link-btn" type="button" onClick={startEdit}>Change</button> : null}
      </div>
      <div className="budget-nums">
        <div><span className="k">Spent</span><strong>{fmt(spent)}</strong></div>
        <div><span className="k">{spent > total ? 'Over by' : 'Left'}</span><strong className={tone}>{fmt(Math.abs(total - spent))}</strong></div>
        <div><span className="k">Budget</span><strong>{fmt(total)}</strong><small>{fmt(budget.perPerson)} × {members}</small></div>
      </div>
      <div className={`budget-bar ${tone}`} role="progressbar" aria-label="Budget used" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </div>
      {tone !== 'ok' ? (
        <div className={`status-msg ${tone}`}>{tone === 'bad' ? `You're over budget by ${fmt(spent - total)}.` : `Heads up: ${Math.round(pct * 100)}% of the budget is spent.`}</div>
      ) : null}
      {days.length ? (
        <>
          <h3 className="sub-h">Day by day <span className="muted small">· about {fmt(perDay)} a day planned</span></h3>
          <Bars
            bars={dayBars(days.map((d) => d.date), byDay)}
            format={fmt}
            marker={{ value: perDay, label: 'Planned per day' }}
          />
        </>
      ) : null}
      {other ? <p className="fine">Only expenses in {budget.currency} count towards the budget.</p> : null}
    </section>
  );
}

// Spending per trip day — plus what was spent before it started (bookings, tickets) and after.
function dayBars(dates: string[], byDay: Map<string, number>) {
  const first = dates[0] || '', last = dates[dates.length - 1] || '';
  let before = 0, after = 0;
  for (const [d, v] of byDay) { if (d < first) before += v; else if (d > last) after += v; }
  return [
    ...(before ? [{ key: 'before', label: <span className="muted">Before the trip</span>, value: before, color: 'var(--t-slate)' }] : []),
    ...dates.map((d, i) => ({ key: d, label: <>Day {i + 1} <span className="muted small">{dayMonth(d)}</span></>, value: byDay.get(d) || 0 })),
    ...(after ? [{ key: 'after', label: <span className="muted">After</span>, value: after, color: 'var(--t-slate)' }] : []),
  ];
}

/* ============================================================
   Add / edit an expense
   ============================================================ */
function AddForm({ entry, user, form, setForm, editing, who, onCancel, onSaved }: {
  entry: TripEntry; user: User; form: FormState; setForm: (f: FormState) => void; editing: string | null; who: (e: string) => string;
  onCancel: () => void; onSaved: (wasEditing: boolean) => void;
}) {
  const members = entry.meta.memberEmails;
  const titleRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const amount = round2(Number(form.amount) || 0);
  const category = form.category ?? guessCategory(form.title);
  const assigned = round2(Object.entries(form.shares).filter(([k]) => members.includes(k)).reduce((s, [, v]) => s + (Number(v) || 0), 0));
  const left = round2(amount - assigned);
  const billSaved = form.hadBill && form.bill !== '';

  const fillRest = () => {
    const empty = members.filter((m) => !(Number(form.shares[m]) > 0));
    if (!empty.length || left <= 0) return;
    const each = Math.floor((left / empty.length) * 100) / 100;
    const shares = { ...form.shares };
    empty.forEach((m, i) => { shares[m] = String(i === empty.length - 1 ? round2(left - each * (empty.length - 1)) : each); });
    setForm({ ...form, shares });
  };
  const pickBill = async (file: File | undefined) => {
    if (!file) return;
    try { setForm({ ...form, bill: await compressPhoto(file) }); } catch (e) { toast((e as Error).message, 'bad'); }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = form.title.trim();
    if (!title) { toast('Say what the expense was for.', 'bad'); titleRef.current?.focus(); return; }
    if (!(amount > 0)) { toast('Enter an amount above zero.', 'bad'); amountRef.current?.focus(); return; }
    let split = form.split;
    let shares: Record<string, number> | undefined;
    if (form.mode === 'amount') {
      shares = {};
      for (const m of members) { const v = round2(Number(form.shares[m]) || 0); if (v > 0) shares[m] = v; }
      split = Object.keys(shares);
      if (!split.length) { toast('Enter how much each person had.', 'bad'); return; }
      if (Math.abs(left) > 0.01) { toast(left > 0 ? `${money(left, form.currency)} still to assign.` : `That's ${money(-left, form.currency)} more than the total.`, 'bad'); return; }
    } else if (!split.length) { toast('Pick at least one person to split it with.', 'bad'); return; }
    const hasBill = !!form.bill || billSaved;
    const expense: ExpenseInput = { title, amount, currency: form.currency, paidBy: form.paidBy, split, date: form.date, kind: 'expense', category, shares, hasBill: hasBill || undefined };
    rememberCurrency(entry.trip.id, expense.currency);
    setBusy(true);
    try {
      const xid = await cloud.saveExpense(user, entry.trip.id, expense, editing);
      if (form.bill) await cloud.setPhoto(user, entry.trip.id, `bill-${xid}`, form.bill);
      else if (form.hadBill && form.bill === '') await cloud.deletePhoto(entry.trip.id, `bill-${xid}`).catch(() => {});
      toast(editing ? 'Expense updated' : `Added ${money(amount, expense.currency)} · ${title}`, 'ok');
      onSaved(!!editing);
    } catch (err) { toast((err as Error).message, 'bad'); }
    setBusy(false);
  };

  return (
    <section className="ed-card">
      <h2 className="sec-h">{editing ? 'Edit expense' : 'Add an expense'}</h2>
      <form className="form ex-form" noValidate onSubmit={submit}>
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
        <div className="fld"><span>Category{form.category ? null : <small className="muted"> · guessed from the name</small>}</span>
          <div className="cat-chips" role="radiogroup" aria-label="Category">
            {CATEGORY_KEYS.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={category === k} className={`cat-chip${category === k ? ' on' : ''}`} style={{ '--c': CATEGORY_INFO[k].color } as React.CSSProperties} onClick={() => setForm({ ...form, category: k })}>
                {CATEGORY_INFO[k].icon} {CATEGORY_INFO[k].label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid2">
          <label className="fld"><span>Paid by</span>
            <select value={form.paidBy} onChange={(e) => setForm({ ...form, paidBy: e.target.value })}>
              {members.map((m) => <option key={m} value={m}>{who(m)}{m === user.email ? '' : ` (${m})`}</option>)}
            </select>
          </label>
          <label className="fld"><span>Date</span><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
        </div>
        <div className="fld">
          <span>Split</span>
          <div className="seg" role="radiogroup" aria-label="How to split">
            <button type="button" role="radio" aria-checked={form.mode === 'equal'} className={`seg-b${form.mode === 'equal' ? ' on' : ''}`} onClick={() => setForm({ ...form, mode: 'equal' })}>Equally</button>
            <button type="button" role="radio" aria-checked={form.mode === 'amount'} className={`seg-b${form.mode === 'amount' ? ' on' : ''}`} onClick={() => setForm({ ...form, mode: 'amount' })}>By amount</button>
          </div>
          {form.mode === 'equal' ? (
            <div className="ex-split">
              {members.map((m) => (
                <label key={m} className="chk ex-who">
                  <input type="checkbox" checked={form.split.includes(m)} onChange={(e) => setForm({ ...form, split: e.target.checked ? [...form.split, m] : form.split.filter((x) => x !== m) })} /> {who(m)}
                </label>
              ))}
              {form.split.length && amount ? <span className="muted small ex-each">{money(amount / form.split.length, form.currency)} each</span> : null}
            </div>
          ) : (
            <div className="share-grid">
              {members.map((m) => (
                <label key={m} className="share-row">
                  <span className="share-who"><Avatars emails={[m]} /> {who(m)}</span>
                  <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="0" value={form.shares[m] || ''} onChange={(e) => setForm({ ...form, shares: { ...form.shares, [m]: e.target.value } })} aria-label={`${who(m)}'s part`} />
                </label>
              ))}
              <div className={`share-left${Math.abs(left) <= 0.01 && amount ? ' ok' : left < 0 ? ' bad' : ''}`}>
                <span>{!amount ? 'Enter the total first' : Math.abs(left) <= 0.01 ? '✓ All assigned' : left > 0 ? `${money(left, form.currency)} left to assign` : `${money(-left, form.currency)} too much`}</span>
                {left > 0.01 ? <button className="link-btn" type="button" onClick={fillRest}>Split the rest equally</button> : null}
              </div>
            </div>
          )}
        </div>
        <div className="fld"><span>Bill photo <small className="muted">(optional)</small></span>
          <div className="bill-pick">
            {form.bill ? <img className="bill-thumb" src={form.bill} alt="Bill" /> : billSaved ? <span className="muted small">📎 A bill photo is saved.</span> : null}
            <button className="btn ghost small" type="button" onClick={() => fileRef.current?.click()}><Icon.camera /> {form.bill || billSaved ? 'Replace' : 'Add bill photo'}</button>
            {form.bill || billSaved ? <button className="link-btn" type="button" onClick={() => setForm({ ...form, bill: form.hadBill ? '' : null })}>Remove</button> : null}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { pickBill(e.target.files?.[0]); e.target.value = ''; }} />
          </div>
        </div>
        <div className="form-acts">
          {editing ? <button className="btn ghost" type="button" onClick={onCancel}>Cancel edit</button> : null}
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add expense'}</button>
        </div>
      </form>
    </section>
  );
}

function BillSheet({ tripId, expense, onClose }: { tripId: string; expense: Expense; onClose: () => void }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => { cloud.getPhoto(tripId, `bill-${expense.id}`).then(setSrc); }, [tripId, expense.id]);
  return (
    <Sheet title={`Bill · ${expense.title}`} onClose={onClose}>
      {src === undefined ? <div className="home-skel"><div className="sk-card" /></div>
        : src ? <img className="bill-full" src={src} alt={`Bill for ${expense.title}`} />
        : <p className="fine">The photo isn't available right now. It may still be uploading, or you're offline.</p>}
      <p className="fine">{money(expense.amount, expense.currency)} · {fmtRange(expense.date, expense.date)}</p>
    </Sheet>
  );
}
