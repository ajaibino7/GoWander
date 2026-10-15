// The home screen's greeting: what to call you, and the time of day.
import type { User } from './types';

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : '');

/** Your first name: from your name in GoWander, else from your email ("ajai.bino7@…" → "Ajai"). */
export function firstName(user: User): string {
  const name = (user.name || '').trim();
  if (name && !name.includes('@')) return cap(name.split(/\s+/)[0] || name);
  const local = (user.email.split('@')[0] || '').replace(/[0-9._+-]+/g, ' ').trim().split(/\s+/)[0] || '';
  return cap(local);
}

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

export function dayPart(d: Date = new Date()): DayPart {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

export const GREETING: Record<DayPart, string> = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  night: 'Hi',
};
