// The page header: sunset sky (or the trip's cover photo), title and navigation. The home page
// shows the GoWander logo over a dawn coastline instead (styles.css → Home header).
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { heroCover, useCovers } from '../app/covers';
import { useAppData } from '../app/AppData';
import * as cloud from '../lib/cloud';
import { toast } from '../lib/toast';
import { useImageReady } from './FadeImg';

export interface HeroProps {
  eyebrow?: string;
  title?: string;
  /** The home page header: logo instead of a title. */
  logo?: boolean;
  desc?: string;
  sub?: ReactNode;
  nav?: ReactNode;
  /** The trip this page is about, so its cover photo (if any) fills the header. */
  tripId?: string | null;
}

// index.html paints the home header before the app starts; its logo has already played its
// entrance, so the app's first header doesn't play it again.
let staticLogoShown = document.documentElement.dataset.staticPaint === 'home';

// "Mumbai + Lonavala" → the "+" in the accent colour.
function FancyTitle({ title }: { title: string }) {
  const parts = title.split(/ (\+|&) /);
  return <>{parts.map((p, i) => (i % 2 ? <em key={i}> {p} </em> : p))}</>;
}

export const LOGO_ALT = 'GoWander trip planner';

export function Hero({ eyebrow = 'GoWander', title = 'Trips', logo = false, desc = '', sub, nav, tripId = null, enter = '' }: HeroProps & { enter?: string }) {
  useCovers();
  const { url, credit } = heroCover(tripId);
  // Decided once per header: re-renders (data arriving) must not drop the class, or the logo's
  // entrance would restart mid-load.
  const [settled] = useState(() => logo && staticLogoShown);
  useEffect(() => { staticLogoShown = false; }, []);
  useEffect(() => { document.title = !title || title === 'Trips' || logo ? 'GoWander' : `${title} · GoWander`; }, [title, logo]);

  // The photo fades in over the sunset artwork once it has loaded.
  const photo = useImageReady(url);
  // Trip headers are tall enough for a photo from the start, so nothing below moves when it arrives.
  const classes = ['hero', logo ? 'home' : '', tripId ? 'trip' : '', url ? 'has-cover' : '', photo ? 'photo-on' : ''].filter(Boolean).join(' ');
  return (
    <header className={classes}>
      {url ? <div key={url} className={`hero-photo ${photo}`.trim()} style={{ backgroundImage: `url("${url}")` }} aria-hidden="true" /> : null}
      <svg className="skyline" viewBox="0 0 800 120" preserveAspectRatio="none" aria-hidden="true">
        <path fill="rgba(10,22,44,.45)" d="M0 120 V82 H30 V66 H48 V82 H70 V50 H86 V30 H96 V50 H110 V74 H140 V58 H160 V40 H170 V58 H190 V80 H220 V62 h10 V44 l12 -18 l12 18 V62 h10 V80 H290 V54 H312 V70 H340 V34 H352 V14 H362 V34 H374 V68 H400 V82 H430 V60 H460 V42 H470 V60 H500 V76 H530 V56 l18 -26 l18 26 V76 H600 V62 H624 V46 H640 V62 H660 V78 H700 V58 H720 V38 H732 V58 H760 V74 H800 V120 Z" />
        <path fill="var(--bg)" d="M0 120 V106 C120 98 220 112 330 104 C450 96 560 114 680 102 C730 98 770 104 800 100 V120 Z" />
      </svg>
      {logo ? <HomeScene /> : null}
      {credit && url ? <a className="hero-credit" href={credit.href} target="_blank" rel="noopener">{credit.text}</a> : null}
      <div className={`hero-inner ${enter}`}>
        {nav ? <nav className="hero-nav" aria-label="Page">{nav}</nav> : null}
        {logo ? null : <div className="eyebrow">{eyebrow}</div>}
        <h1>{logo ? <img className={`brand-logo${settled ? ' settled' : ''}`} src="icons/logo.webp" alt={LOGO_ALT} width={900} height={624} /> : <FancyTitle title={title} />}</h1>
        {desc ? <div className="hero-desc">{desc}</div> : null}
        <div className="hero-sub">{sub}</div>
      </div>
    </header>
  );
}

// Home page only: a dawn coastline — far peaks, green hills, the sea, and the page's edge.
// Colours come from CSS variables, so dark mode turns it into a moonlit night.
function HomeScene() {
  const cloud = 'M20 44h82a16 16 0 0 0 0-32 22 22 0 0 0-41-6 18 18 0 0 0-31 12A13 13 0 0 0 20 44z';
  return (
    <>
      <div className="home-clouds" aria-hidden="true">
        {['c1', 'c2', 'c3'].map((c) => <svg key={c} className={`cloud ${c}`} viewBox="0 0 120 50"><path d={cloud} /></svg>)}
      </div>
      <svg className="home-scene" viewBox="0 0 1440 220" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="hs-far" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--hs-far1)' }} /><stop offset="1" style={{ stopColor: 'var(--hs-far2)' }} /></linearGradient>
          <linearGradient id="hs-mid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--hs-mid1)' }} /><stop offset="1" style={{ stopColor: 'var(--hs-mid2)' }} /></linearGradient>
          <linearGradient id="hs-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style={{ stopColor: 'var(--hs-sea1)' }} /><stop offset="1" style={{ stopColor: 'var(--hs-sea2)' }} /></linearGradient>
        </defs>
        <path fill="url(#hs-far)" d="M0 150 C40 140 60 120 100 118 C140 116 150 132 190 128 C240 122 250 80 300 76 C350 72 360 124 410 122 C460 120 480 92 530 90 C575 88 590 118 630 116 C670 114 680 86 720 84 C770 82 780 126 830 124 C880 122 880 80 930 78 C985 76 990 122 1040 120 C1090 118 1100 96 1140 94 C1185 92 1190 130 1240 128 C1290 126 1290 88 1340 86 C1390 84 1400 118 1440 120 V220 H0 Z" />
        <path fill="url(#hs-mid)" d="M0 176 C110 150 210 158 320 142 C430 126 520 168 640 156 C760 144 850 122 980 146 C1100 168 1210 138 1320 150 C1380 156 1420 162 1440 160 V220 H0 Z" />
        <path fill="url(#hs-sea)" d="M0 188 C240 178 480 194 720 186 C960 178 1200 192 1440 184 V220 H0 Z" />
        <path fill="var(--bg)" d="M0 204 C240 196 480 212 720 203 C960 194 1200 210 1440 200 V220 H0 Z" />
      </svg>
    </>
  );
}

/* ---------- header buttons ---------- */
export function BackLink({ to = '/', label = 'All trips' }: { to?: string; label?: string }) {
  return <Link className="hn-btn" to={to}>‹ {label}</Link>;
}

export async function signInWithToast(): Promise<void> {
  try { await cloud.signIn(); } catch (err) { toast((err as Error).message, 'bad'); }
}

/** Account (with your photo) when signed in, else a Sign in button. */
export function AccountChip() {
  // shownUser: while Firebase starts, last visit's account (so the button doesn't flip from
  // "Sign in" to "Account" a moment after the page opens).
  const { shownUser: user } = useAppData();
  if (user) {
    return (
      <Link className="hn-btn" to="/account" title={user.email}>
        {user.photo ? <img className="avatar-img" src={user.photo} alt="" referrerPolicy="no-referrer" /> : '👤'} Account
      </Link>
    );
  }
  return cloud.available() ? <button className="hn-btn" type="button" onClick={signInWithToast}>Sign in</button> : null;
}
