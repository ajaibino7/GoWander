// Small line icons (inherit the text colour).
import type { ReactNode } from 'react';

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const Icon = {
  cal: () => <Svg><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Svg>,
  sun: () => <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
  pin: () => <Svg><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></Svg>,
  edit: () => <Svg><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></Svg>,
  users: () => <Svg><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></Svg>,
  plus: () => <Svg><path d="M12 5v14M5 12h14" /></Svg>,
  upload: () => <Svg><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5M12 3v12" /></Svg>,
  download: () => <Svg><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></Svg>,
  check: () => <Svg><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12l3 3 5-6" /></Svg>,
  wallet: () => <Svg><path d="M20 7H5a2 2 0 0 1 0-4h13v4" /><path d="M3 5v14a2 2 0 0 0 2 2h15V7" /><circle cx="16" cy="14" r="1.5" /></Svg>,
  calplus: () => <Svg><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M12 13v5M9.5 15.5h5" /></Svg>,
  done: () => <Svg><path d="M20 6L9 17l-5-5" /></Svg>,
};

// Members as overlapping initials, coloured per person.
const AVATAR_COLORS = ['#1f6f8b', '#e8704f', '#3c8d6b', '#b8801c', '#6a4fb3', '#c4553b'];
const hue = (e: string) => AVATAR_COLORS[[...e].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

export function Avatars({ emails }: { emails: string[] }) {
  if (!emails.length) return null;
  return (
    <span className="avatars">
      {emails.slice(0, 4).map((e) => (
        <span key={e} className="av" style={{ background: hue(e) }} title={e}>{(e[0] || '?').toUpperCase()}</span>
      ))}
      {emails.length > 4 ? <span className="av more">+{emails.length - 4}</span> : null}
    </span>
  );
}
