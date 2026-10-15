// Shared-expense maths: balances per person and the fewest payments that settle everyone up.
import type { Expense, ExpenseInput, Trip } from './types';

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

// Per currency: net balance per person (+ = is owed, − = owes). Expenses and settlements use the
// same rule: the payer is credited the amount; everyone in the split is debited an equal share.
export function balances(expenses: Pick<ExpenseInput, 'amount' | 'currency' | 'paidBy' | 'split' | 'kind'>[]): Map<string, CurrencyTotals> {
  const by = new Map<string, CurrencyTotals>();
  for (const x of expenses) {
    const c = by.get(x.currency) || { bal: new Map<string, number>(), spent: 0 };
    by.set(x.currency, c);
    if (x.kind !== 'settlement') c.spent += x.amount;
    c.bal.set(x.paidBy, (c.bal.get(x.paidBy) || 0) + x.amount);
    if (!x.split.length) continue;
    for (const p of x.split) c.bal.set(p, (c.bal.get(p) || 0) - x.amount / x.split.length);
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

/** Your share of real spending in a currency. */
export function myShare(expenses: Expense[], me: string, cur: string): number {
  return expenses
    .filter((x) => x.currency === cur && x.kind !== 'settlement' && x.split.includes(me))
    .reduce((s, x) => s + x.amount / x.split.length, 0);
}
