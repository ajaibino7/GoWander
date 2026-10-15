// Shared-expense maths: balances per person and the fewest payments that settle everyone up.
import type { Expense, ExpenseCategory, ExpenseInput, Trip } from './types';

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'THB', 'MYR', 'IDR', 'LKR', 'NPR', 'JPY', 'AUD', 'CAD', 'CHF', 'VND'];

// A sensible default from the trip's timezone; after that, whatever was used last on this trip.
export function tripCurrency(trip: Pick<Trip, 'id' | 'timezone'>): string {
  try { const last = localStorage.getItem(`gw-cur-${trip.id}`); if (last) return last; } catch { /* storage unavailable */ }
  const tz = trip.timezone || '';
  const byTz: Record<string, string> = {
    'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR', 'Asia/Dubai': 'AED', 'Asia/Singapore': 'SGD', 'Asia/Bangkok': 'THB', 'Asia/Kuala_Lumpur': 'MYR',
    'Asia/Jakarta': 'IDR', 'Asia/Makassar': 'IDR', 'Asia/Colombo': 'LKR', 'Asia/Kathmandu': 'NPR', 'Asia/Tokyo': 'JPY', 'Europe/London': 'GBP', 'Europe/Zurich': 'CHF', 'Asia/Ho_Chi_Minh': 'VND',
  };
  const known = byTz[tz];
  if (known) return known;
  if (tz.startsWith('Europe/')) return 'EUR';
  if (tz.startsWith('Australia/')) return 'AUD';
  if (/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax)/.test(tz)) return 'CAD';
  if (tz.startsWith('America/')) return 'USD';
  return 'INR';
}
export function rememberCurrency(tripId: string, currency: string): void {
  try { localStorage.setItem(`gw-cur-${tripId}`, currency); } catch { /* storage unavailable */ }
}

export function money(n: number, cur: string): string {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n); } catch { return `${cur} ${n.toFixed(2)}`; }
}
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CurrencyTotals {
  /** Net per person: + is owed money, − owes money. */
  bal: Map<string, number>;
  /** Real spending (settlements don't count). */
  spent: number;
}

type Splittable = Pick<ExpenseInput, 'amount' | 'split' | 'shares'>;

/** Each person's part of an expense: their exact amount when split by amount, else an equal share. */
export function parts(x: Splittable): Map<string, number> {
  const out = new Map<string, number>();
  if (x.shares && Object.keys(x.shares).length) {
    for (const [p, v] of Object.entries(x.shares)) if (v > 0) out.set(p, v);
    return out;
  }
  for (const p of x.split) out.set(p, x.amount / x.split.length);
  return out;
}

// Per currency: net balance per person (+ = is owed, − = owes). Expenses and settlements use the
// same rule: the payer is credited the amount; everyone in the split is debited their part.
export function balances(expenses: Pick<ExpenseInput, 'amount' | 'currency' | 'paidBy' | 'split' | 'kind' | 'shares'>[]): Map<string, CurrencyTotals> {
  const by = new Map<string, CurrencyTotals>();
  for (const x of expenses) {
    const c = by.get(x.currency) || { bal: new Map<string, number>(), spent: 0 };
    by.set(x.currency, c);
    if (x.kind !== 'settlement') c.spent += x.amount;
    c.bal.set(x.paidBy, (c.bal.get(x.paidBy) || 0) + x.amount);
    for (const [p, v] of parts(x)) c.bal.set(p, (c.bal.get(p) || 0) - v);
  }
  return by;
}

export interface Settlement { from: string; to: string; amount: number }

// The fewest payments that settle everyone up: repeatedly match the biggest debtor with the biggest creditor.
export function settlements(bal: Map<string, number>): Settlement[] {
  const owe = [...bal].filter(([, v]) => v < -0.009).map(([p, v]) => ({ p, v: -v })).sort((a, b) => b.v - a.v);
  const get = [...bal].filter(([, v]) => v > 0.009).map(([p, v]) => ({ p, v })).sort((a, b) => b.v - a.v);
  const out: Settlement[] = [];
  while (owe.length && get.length) {
    const a = owe[0] as { p: string; v: number }, b = get[0] as { p: string; v: number };
    const amt = round2(Math.min(a.v, b.v));
    if (amt >= 0.01) out.push({ from: a.p, to: b.p, amount: amt });
    a.v -= amt; b.v -= amt;
    if (a.v < 0.01) owe.shift();
    if (b.v < 0.01) get.shift();
  }
  return out;
}

export interface Debt { from: string; to: string; amount: number; currency: string }

/**
 * What each person still owes each other person, after netting both ways and taking off what's
 * already been paid back. For every expense, each person in the split owes the payer their part;
 * a settlement ("Asha paid Ravi ₹200") pays that down. "You owe Asha ₹300, she owes you ₹100"
 * becomes one debt: you owe Asha ₹200.
 */
export function pairwiseDebts(expenses: Pick<ExpenseInput, 'amount' | 'currency' | 'paidBy' | 'split' | 'kind' | 'shares'>[]): Debt[] {
  const owe = new Map<string, number>(); // "currency|from|to" → amount
  const add = (cur: string, from: string, to: string, v: number) => {
    if (from === to || !v) return;
    const k = `${cur}|${from}|${to}`;
    owe.set(k, (owe.get(k) || 0) + v);
  };
  for (const x of expenses) {
    if (x.kind === 'settlement') {
      // The payer handed money to split[0]: that's the same as split[0] now owing it back.
      const to = x.split[0];
      if (to) add(x.currency, to, x.paidBy, x.amount);
    } else {
      for (const [p, v] of parts(x)) add(x.currency, p, x.paidBy, v);
    }
  }
  const out: Debt[] = [];
  const seen = new Set<string>();
  for (const k of owe.keys()) {
    const [cur = '', a = '', b = ''] = k.split('|');
    const pair = `${cur}|${[a, b].sort().join('|')}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const net = round2((owe.get(`${cur}|${a}|${b}`) || 0) - (owe.get(`${cur}|${b}|${a}`) || 0));
    if (net >= 0.01) out.push({ from: a, to: b, amount: net, currency: cur });
    else if (net <= -0.01) out.push({ from: b, to: a, amount: -net, currency: cur });
  }
  return out.sort((x, y) => y.amount - x.amount);
}

/** Your share of real spending in a currency. */
export function myShare(expenses: Expense[], me: string, cur: string): number {
  return expenses
    .filter((x) => x.currency === cur && x.kind !== 'settlement')
    .reduce((s, x) => s + (parts(x).get(me) || 0), 0);
}

/* ---------- categories and summaries ---------- */
export const CATEGORY_INFO: Record<ExpenseCategory, { label: string; icon: string; color: string }> = {
  food: { label: 'Food', icon: '🍽️', color: '#e8704f' },
  travel: { label: 'Travel', icon: '🚕', color: '#1f6f8b' },
  stay: { label: 'Stay', icon: '🏨', color: '#6a4fb3' },
  tickets: { label: 'Tickets', icon: '🎟️', color: '#b8801c' },
  shopping: { label: 'Shopping', icon: '🛍️', color: '#3c8d6b' },
  other: { label: 'Other', icon: '🧾', color: '#8a8f99' },
};
export const CATEGORY_KEYS = Object.keys(CATEGORY_INFO) as ExpenseCategory[];

// A best guess from what it was for, so most expenses need no extra tap.
const GUESS: [ExpenseCategory, RegExp][] = [
  ['food', /\b(food|lunch|dinner|breakfast|brunch|snacks?|tea|chai|coffee|cafe|café|restaurant|meal|thali|drinks?|beer|bar|pub|ice ?cream|dessert|biryani|pizza|groceries|water)\b/i],
  ['travel', /\b(taxi|cab|uber|ola|auto|rickshaw|bus|train|flight|fuel|petrol|diesel|toll|parking|metro|ferry|scooter|bike|car|rental|transfer)\b/i],
  ['stay', /\b(hotel|stay|hostel|room|airbnb|resort|homestay|villa|check.?in|lodge)\b/i],
  ['tickets', /\b(tickets?|entry|entrance|museum|fort|park|show|tour|guide|cruise|activity|pass)\b/i],
  ['shopping', /\b(shopping|souvenirs?|market|clothes|gift|mall|bought)\b/i],
];
export function guessCategory(title: string): ExpenseCategory {
  return GUESS.find(([, re]) => re.test(title))?.[0] ?? 'other';
}
export const categoryOf = (x: Pick<Expense, 'category' | 'title'>): ExpenseCategory => x.category ?? guessCategory(x.title);

/** Real spending in one currency, by category (largest first). */
export function spendByCategory(expenses: Expense[], cur: string): [ExpenseCategory, number][] {
  const m = new Map<ExpenseCategory, number>();
  for (const x of expenses) if (x.currency === cur && x.kind !== 'settlement') m.set(categoryOf(x), (m.get(categoryOf(x)) || 0) + x.amount);
  return [...m].sort((a, b) => b[1] - a[1]);
}
/** Real spending in one currency, by date. */
export function spendByDay(expenses: Expense[], cur: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of expenses) if (x.currency === cur && x.kind !== 'settlement') m.set(x.date, (m.get(x.date) || 0) + x.amount);
  return m;
}
/** Each member's part of real spending in one currency. */
export function spendByPerson(expenses: Expense[], cur: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of expenses) {
    if (x.currency !== cur || x.kind === 'settlement') continue;
    for (const [p, v] of parts(x)) m.set(p, (m.get(p) || 0) + v);
  }
  return m;
}

/* ---------- UPI ---------- */
export const isUpiId = (s: string): boolean => /^[A-Za-z0-9._-]{2,}@[A-Za-z0-9.-]{2,}$/.test(s.trim());
/** A UPI payment link: opens GPay, PhonePe, Paytm… with the amount filled in (INR only). */
export function upiLink({ vpa, name, amount, note }: { vpa: string; name: string; amount: number; note: string }): string {
  const q = new URLSearchParams({ pa: vpa.trim(), pn: name, am: amount.toFixed(2), cu: 'INR', tn: note.slice(0, 50) });
  // Spaces as %20, and the UPI ID's "@" kept as is (some UPI apps don't decode %40 in it).
  return `upi://pay?${q.toString().replace(/\+/g, '%20').replace(/^pa=([^&]*)%40/, 'pa=$1@')}`;
}
