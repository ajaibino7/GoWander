// App shell: hash router, sign-in, trip list, members, account, and importing shared trips.
import { esc, fmtRange, toast, ask, toastLink, makeClock, deviceTz, THEMES, addDays } from './util.js';
import * as store from './store.js';
import * as cloud from './cloud.js';
import { mountTrip, unmountTrip, setDone, sim } from './live.js';
import { mountEditor } from './editor.js';
import { autoCover, smallUrl, creditUrl } from './autocover.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['home', 'trip', 'edit', 'members', 'settings', 'import'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 20;

let current = null;
let editor = null;
let user = null;
let samples = [];
let myTrips = [];
let myTripsReady = null, resolveMyTrips = () => {};
let unsubMine = null;
let cleanups = []; // live listeners for the current screen, closed on navigation
const keep = (unsub) => { if (unsub) cleanups.push(unsub); };

function showView(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  current = name;
}

const fancyTitle = (t) => esc(t).replace(/ (\+|&amp;) /g, ' <em>$1</em> ');
// trip: the trip this page is about, so its cover photo (if any) fills the header.
// logo: the home page header — the GoWander logo centred in the sky as the page title.
function setHero({ eyebrow = 'GoWander', title = 'Trips', sub = '', subHtml = '', desc = '', nav = '', trip = null, logo = false }) {
  document.querySelector('.hero').classList.toggle('home', logo);
  $('hero-eyebrow').textContent = logo ? '' : eyebrow;
  heroTrip = trip;
  applyCover();
  $('hero-title').innerHTML = logo
    ? '<img class="brand-logo" src="icons/logo.webp" alt="GoWander trip planner" width="900" height="624">'
    : fancyTitle(title);
  if (subHtml) $('hero-sub').innerHTML = subHtml; else $('hero-sub').textContent = sub;
  $('hero-desc').textContent = desc;
  $('hero-desc').hidden = !desc;
  $('hero-nav').innerHTML = nav;
  document.title = title === 'Trips' ? 'GoWander' : `${title} · GoWander`;
}
/* ---------- trip cover photos in the header ----------
   An uploaded cover wins; otherwise a photo of the trip's main destination; otherwise the sunset. */
const covers = new Map(); // trip id → uploaded image data URL
const autoCovers = new Map(); // trip id → { hero, file, place, source } from autocover.js
const isAutoUrl = (u) => /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(u || '');
let heroTrip = null;
let shownCover = null;
function applyCover() {
  const auto = heroTrip && !covers.has(heroTrip) ? autoCovers.get(heroTrip) : null;
  const url = (heroTrip && covers.get(heroTrip)) || (isAutoUrl(auto?.hero) ? auto.hero : null);
  const credit = $('hero-credit');
  credit.hidden = !auto || !url;
  if (auto && url) {
    credit.textContent = `Photo: ${auto.place} · ${auto.source}`;
    credit.href = creditUrl(auto);
  }
  if (url === shownCover) return;
  shownCover = url;
  const hero = document.querySelector('.hero');
  hero.classList.toggle('has-cover', !!url);
  hero.style.setProperty('--cover', url ? `url("${url}")` : 'none');
}
// Looks up (or recalls) the destination photo for a trip, then refreshes the header and cards.
function ensureAutoCover(trip) {
  if (!trip?.id) return Promise.resolve(null);
  return autoCover(trip).then((info) => {
    if (info) autoCovers.set(trip.id, info); else autoCovers.delete(trip.id);
    applyCover();
    paintCardCovers();
    return info;
  }, () => null);
}
// Keeps the header in step with the trip's cover while the page is open. Resolves with the first value.
function watchCoverFor(id) {
  return new Promise((resolve) => {
    cloud.watchCover(id, (url) => {
      if (url && /^data:image\/(jpeg|png|webp);base64,/.test(url)) covers.set(id, url); else covers.delete(id);
      applyCover();
      resolve(covers.get(id) || null);
    }).then(keep, () => resolve(null));
  });
}

const backLink = (href = '#/', label = 'All trips') => `<a class="hn-btn" href="${href}">‹ ${label}</a>`;
const accountChip = () => (user
  ? `<a class="hn-btn" href="#/account" title="${esc(user.email)}">${user.photo ? `<img class="avatar-img" src="${esc(user.photo)}" alt="" referrerpolicy="no-referrer">` : '👤'} Account</a>`
  : (cloud.available() ? '<button class="hn-btn" type="button" data-a="signin">Sign in</button>' : ''));
const enc = encodeURIComponent;

/* ---------- lookups ---------- */
const isSample = (id) => samples.some((t) => t.id === id);
async function findMine(id) {
  if (!user) return null;
  await Promise.race([myTripsReady, new Promise((r) => setTimeout(r, 4000))]);
  return myTrips.find((e) => e.trip.id === id) || null;
}

/* ---------- trip timing for cards ---------- */
function tripWindow(trip) {
  const days = trip.days.filter((d) => d.stops.length);
  if (!days.length) return null;
  const c = makeClock(trip.timezone);
  const first = days[0], last = days[days.length - 1];
  return { start: c.at(first.date, first.stops[0].start), end: c.at(last.date, last.stops[last.stops.length - 1].end) };
}
function tripStatus(trip, t = new Date()) {
  const w = tripWindow(trip);
  if (!w) return { key: 'empty', label: 'No stops yet', order: 3 };
  if (t >= w.start && t < w.end) return { key: 'live', label: 'Live now', order: 0 };
  if (t < w.start) {
    const days = Math.ceil((w.start - t) / 86400000);
    return { key: 'soon', label: days <= 1 ? 'Starts tomorrow' : `In ${days} days`, order: 1, at: w.start };
  }
  return { key: 'past', label: 'Completed', order: 2, at: w.end };
}
const byStatus = (a, b) => a.st.order - b.st.order || (a.st.key === 'past' ? b.st.at - a.st.at : (a.st.at || 0) - (b.st.at || 0));

/* ============================================================
   Sharing a copy (link carries the whole trip; no access granted)
   ============================================================ */
async function shareCopy(trip) {
  const url = await store.shareUrl(trip);
  await shareOrCopy(url, `Trip plan: ${trip.title}`, 'Copy link copied — whoever opens it gets their own copy');
}
async function shareOrCopy(url, text, copiedMsg) {
  if (navigator.share) {
    try { await navigator.share({ text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast(copiedMsg, 'ok'); } catch { toastLink('Copy this link:', url); }
}

/* ============================================================
   Home
   ============================================================ */
// Small line icons (inherit the text colour).
const svg = (d) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  cal: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  pin: svg('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>'),
};

// Members as overlapping initials, coloured per person.
const AVATAR_COLORS = ['#1f6f8b', '#e8704f', '#3c8d6b', '#b8801c', '#6a4fb3', '#c4553b'];
function avatars(emails = []) {
  if (!emails.length) return '';
  const hue = (e) => AVATAR_COLORS[[...e].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const shown = emails.slice(0, 4);
  return `<span class="avatars">${shown.map((e) => `<span class="av" style="background:${hue(e)}" title="${esc(e)}">${esc(e[0].toUpperCase())}</span>`).join('')}${emails.length > 4 ? `<span class="av more">+${emails.length - 4}</span>` : ''}</span>`;
}

function card(trip, i, { badges = '', actions = '', members = [] } = {}) {
  const st = tripStatus(trip);
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  const first = trip.days[0]?.date, last = trip.days[trip.days.length - 1]?.date;
  const [, , day] = (first || '').split('-');
  const mon = first ? new Date(`${first}T12:00:00`).toLocaleString('en', { month: 'short' }) : '';
  return `
    <article class="trip-card theme-${THEMES[i % THEMES.length]}">
      <a class="tc-main" href="#/trip/${enc(trip.id)}">
        <div class="tc-banner" data-cover-of="${esc(trip.id)}">
          <svg class="tc-route" viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true">
            <path d="M18 92 C 80 92, 90 40, 150 50 S 230 18, 282 20" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-dasharray="5 6"/>
            <circle cx="18" cy="92" r="4" fill="rgba(255,255,255,.8)"/><circle cx="150" cy="50" r="3" fill="rgba(255,255,255,.7)"/>
          </svg>
          ${first ? `<div class="tc-date"><b>${Number(day)}</b><span>${esc(mon)}</span></div>` : ''}
          <span class="chip st-${st.key}">${st.key === 'live' ? '<span class="live-dot"></span>' : ''}${esc(st.label)}</span>
        </div>
        <div class="tc-body">
          <h3>${esc(trip.title)}</h3>
          <div class="tc-meta">
            <span>${ICON.cal}${esc(fmtRange(first, last))}</span>
            <span>${ICON.sun}${trip.days.length} day${trip.days.length === 1 ? '' : 's'}</span>
            <span>${ICON.pin}${stops} stop${stops === 1 ? '' : 's'}</span>
          </div>
          ${trip.subtitle ? `<div class="tc-sub">${esc(trip.subtitle)}</div>` : ''}
        </div>
      </a>
      <div class="tc-foot"><span class="badges">${avatars(members)}${badges}</span><span class="tc-actions">${actions}</span></div>
    </article>`;
}

// Card banners: an uploaded cover already loaded this session (the list doesn't download every
// trip's photo), else a small copy of the destination photo, else the coloured banner.
function paintCardCovers() {
  for (const b of document.querySelectorAll('[data-cover-of]')) {
    const id = b.dataset.coverOf;
    const auto = covers.has(id) ? null : autoCovers.get(id);
    const url = covers.get(id) || (isAutoUrl(auto?.hero) ? smallUrl(auto.hero) : null);
    if (!url || b.dataset.painted === String(url.length) + url.slice(-60)) continue;
    b.dataset.painted = String(url.length) + url.slice(-60);
    b.classList.add('has-cover');
    b.style.backgroundImage = `url("${url}")`;
    if (auto) b.title = `Photo: ${auto.place} · ${auto.source}`;
  }
}

function signInCard(message = '') {
  if (!cloud.available()) {
    return `
      <section class="ed-card">
        <h2 class="sec-h">Sign-in isn't set up yet</h2>
        <p class="fine">The site owner needs to connect Firebase (see the README → “Set up Firebase”). Until then you can browse the sample trip.</p>
      </section>`;
  }
  return `
    <section class="ed-card signin-card">
      ${message ? `<div class="status-msg info">${esc(message)}</div>` : ''}
      <h2 class="sec-h">Plan together, follow live</h2>
      <p class="fine">Sign in with Google to create trips, keep them in sync across your devices, and invite friends to plan with you. Only the people you add can see or change a trip.</p>
      <div><button class="btn google" type="button" data-a="signin"><span class="g">G</span> Sign in with Google</button></div>
    </section>`;
}

// The sample trip sits behind a label until clicked. The open/closed state survives the list
// re-rendering when trips change.
let samplesOpen = false;
function samplesSection(cards) {
  if (!samples.length) return '';
  return `
    <details class="samples"${samplesOpen ? ' open' : ''}>
      <summary><span class="list-h">Sample trip</span><span class="muted small">${samplesOpen ? 'Hide' : 'Show'}</span></summary>
      <div class="trip-list">${cards}</div>
    </details>`;
}
document.addEventListener('toggle', (e) => {
  if (!e.target.matches?.('details.samples')) return;
  samplesOpen = e.target.open;
  e.target.querySelector('summary .muted').textContent = samplesOpen ? 'Hide' : 'Show';
}, true);

function showHome({ message = '' } = {}) {
  const rows = user ? myTrips.map((e) => ({ ...e, st: tripStatus(e.trip) })).sort(byStatus) : [];
  // The header points at what matters now: a trip in progress, else the next one.
  const focus = rows.find((r) => r.st.key === 'live') || rows.find((r) => r.st.key === 'soon');
  const pill = focus
    ? `<a class="hero-pill${focus.st.key === 'live' ? ' live' : ''}" href="#/trip/${enc(focus.trip.id)}">
        <span class="hp-dot"></span><span class="hp-k">${focus.st.key === 'live' ? 'Live now' : 'Up next'}</span>
        <span class="hp-v">${esc(focus.trip.title)}${focus.st.key === 'soon' ? ` · ${esc(focus.st.label.toLowerCase())}` : ''}</span><span aria-hidden="true">→</span>
      </a>`
    : '';
  setHero({
    logo: true,
    title: 'Trips',
    desc: 'Plan together · Travel smarter · Follow it live',
    subHtml: `${pill}${user ? `<div class="hero-who">Signed in as ${esc(user.email)}</div>` : ''}`,
    nav: `<span></span>${accountChip()}`,
  });
  $('site-foot').textContent = cloud.emulatorMode ? 'Using local Firebase emulators.' : 'Trips are private to their members. Your location never leaves your device.';

  const sampleCards = samples.map((t, i) => card(t, i + 1, {
    badges: '<span class="badge local">Sample · read-only</span>',
    actions: user ? `<button class="mini" type="button" data-copy-sample="${esc(t.id)}">Copy to my trips</button>` : '',
  })).join('');

  if (!user) {
    $('view-home').innerHTML = `${signInCard(message)}
      ${samplesSection(sampleCards)}`;
    samples.forEach(ensureAutoCover);
    showView('home');
    return;
  }

  const live = rows.filter((r) => r.st.key === 'live').length;
  const soon = rows.filter((r) => r.st.key === 'soon').length;
  const summary = [`${rows.length} trip${rows.length === 1 ? '' : 's'}`, live && `${live} live now`, soon && `${soon} coming up`].filter(Boolean).join(' · ');
  $('view-home').innerHTML = `
    <div class="home-head">
      <div>
        <h2 class="list-h">Your trips</h2>
        <div class="home-sum">${esc(summary)}</div>
      </div>
      <div class="home-actions">
        <button class="btn ghost" type="button" data-a="import">${ICON.upload} Import</button>
        <a class="btn" href="#/edit/new">${ICON.plus} New trip</a>
      </div>
    </div>
    <div class="trip-list">
      ${rows.map(({ trip, meta }, i) => {
        const owner = meta.ownerUid === user.uid;
        return card(trip, i, {
          members: meta.memberEmails,
          badges: `${owner ? '<span class="badge pub">Owner</span>' : `<span class="badge local" title="${esc(meta.ownerEmail)}">Shared by ${esc(meta.ownerEmail.split('@')[0])}</span>`}
            ${meta.pending ? '<span class="badge dirty">Syncing…</span>' : ''}`,
          actions: `<a class="icon-link" href="#/edit/${enc(trip.id)}" title="Edit trip" aria-label="Edit ${esc(trip.title)}">${ICON.edit}</a><a class="icon-link" href="#/members/${enc(trip.id)}" title="Members" aria-label="Members of ${esc(trip.title)}">${ICON.users}</a>`,
        });
      }).join('') || `
        <div class="empty">
          <div class="empty-art" aria-hidden="true">🧭</div>
          <div class="empty-t">Your next adventure starts here</div>
          <p>Create a trip, copy the sample, or import a trips file. Trips friends share with you appear here too.</p>
          <div class="home-actions center"><a class="btn" href="#/edit/new">${ICON.plus} Plan a trip</a></div>
        </div>`}
    </div>
    ${samplesSection(sampleCards)}
    <input type="file" id="import-file" accept=".json,application/json" hidden>`;
  paintCardCovers();
  // Destination photos for the cards; looked up once per place, then remembered.
  [...rows.map((r) => r.trip), ...samples].forEach(ensureAutoCover);
  showView('home');
}

/* ============================================================
   Trip (live view)
   ============================================================ */
function tripNav(trip, { sample = false, preview = false, meta = null } = {}) {
  if (preview) return `${backLink()}`;
  if (sample) {
    return `${backLink()}<span class="hn-right">${user ? `<button class="hn-btn" type="button" data-copy-sample="${esc(trip.id)}">Copy to my trips</button>` : ''}</span>`;
  }
  const n = meta?.memberEmails.length || 1;
  return `${backLink()}<span class="hn-right"><a class="hn-btn" href="#/members/${enc(trip.id)}">👥 ${n}</a><a class="hn-btn" href="#/edit/${enc(trip.id)}">Edit</a></span>`;
}

function showTripObject(trip, opts) {
  setHero({ eyebrow: opts.sample ? 'Sample trip' : 'GoWander · live', title: trip.title, desc: trip.subtitle, nav: tripNav(trip, opts), trip: opts.preview ? null : trip.id });
  if (!opts.preview) ensureAutoCover(trip);
  showView('trip');
  mountTrip(trip, { onDone: opts.onDone });
}

// Opening a trip you're not in: offer to join. Firebase only lets it through if the owner
// has turned on "Anyone with the link can join".
function showDenied(id) {
  setHero({ eyebrow: 'Trip invite', title: 'Join this trip', nav: backLink() });
  $('view-import').innerHTML = `
    <section class="ed-card">
      <h2 class="sec-h">You've been invited to a trip</h2>
      <p class="fine">Join as <strong>${esc(user.email)}</strong> to see the plan, follow it live and edit it with everyone else.</p>
      <div class="home-actions">
        <button class="btn" type="button" data-join>Join trip</button>
        <button class="btn ghost" type="button" data-a="switch-account">Use a different Google account</button>
      </div>
      <p class="fine" id="join-help" hidden></p>
    </section>`;
  showView('import');
  $('view-import').onclick = async (e) => {
    const b = e.target.closest('[data-join]');
    if (!b) return;
    b.disabled = true;
    try {
      await cloud.joinTrip(user, id);
      toast('You joined the trip', 'ok');
      route();
    } catch (err) {
      b.disabled = false;
      $('join-help').hidden = false;
      $('join-help').textContent = `${err.message} They can also add ${user.email} under Members.`;
    }
  };
}

async function showTrip(id) {
  const sample = samples.find((t) => t.id === id);
  if (sample) { showTripObject(sample, { sample: true }); return; }
  if (!user) { showHome({ message: 'Sign in with Google to open or join this trip.' }); return; }

  // Done/skip marks are shared: ticking a stop shows up for every member.
  const onDone = (stopId, on) => cloud.setStopDone(user, id, stopId, on).catch((e) => toast(e.message, 'bad'));
  watchCoverFor(id);
  let progressStarted = false;
  keep(await cloud.watchTrip(id, (entry) => {
    if (!entry) {
      toast('This trip was deleted, or you were removed from it.', 'bad');
      location.replace('#/');
      return;
    }
    showTripObject(entry.trip, { meta: entry.meta, onDone });
    if (!progressStarted) {
      progressStarted = true;
      cloud.watchProgress(id, setDone).then(keep);
    }
  }, (err) => {
    if (err === 'denied') showDenied(id);
    else toast(err, 'bad');
  }));
}

/* ============================================================
   Editor
   ============================================================ */
function blankTrip() {
  const tz = deviceTz();
  const today = makeClock(tz).dateKey(new Date());
  return { id: 'new', title: '', subtitle: '', timezone: tz, days: [{ date: addDays(today, 7), title: '', stops: [], notes: [] }] };
}

async function showEdit(id) {
  if (!user) { showHome({ message: 'Sign in to create and edit trips.' }); return; }
  if (isSample(id)) { location.replace(`#/trip/${enc(id)}`); return; }
  const isNew = id === 'new';
  const entry = isNew ? null : await findMine(id);
  if (!isNew && !entry) { toast('Trip not found, or you\'re not a member.', 'bad'); location.replace('#/'); return; }
  const trip = isNew ? blankTrip() : entry.trip;
  const baseMs = entry?.meta.updatedAtMs || 0;
  const owner = entry?.meta.ownerUid === user.uid;
  setHero({
    eyebrow: isNew ? 'New trip' : 'Edit trip',
    title: isNew ? 'New trip' : trip.title,
    sub: isNew ? 'Add days, then stops with times and places.' : (entry.meta.memberEmails.length > 1 ? 'Members see your changes as soon as you save.' : 'Changes sync to all your devices.'),
    nav: backLink(isNew ? '#/' : `#/trip/${enc(id)}`, isNew ? 'All trips' : 'Back to trip'),
    trip: isNew ? null : id,
  });
  $('site-foot').textContent = 'Place search by OpenStreetMap Nominatim.';
  showView('edit');
  // The plan is already saved when the cover goes up, so a failed cover is reported, not thrown:
  // throwing would let "Save" run again and, for a new trip, create it twice.
  const saveCover = async (tripId, cover) => {
    if (cover === undefined) return;
    try { await cloud.setCover(user, tripId, cover); } catch (e) { toast(`Trip saved, but the cover image wasn't: ${e.message}`, 'bad'); }
  };
  editor = mountEditor($('view-edit'), trip, {
    isNew,
    canDelete: owner,
    coverP: isNew ? Promise.resolve(null) : watchCoverFor(id),
    autoP: isNew ? Promise.resolve(null) : ensureAutoCover(trip),
    onSave: async (draft, cover) => {
      if (isNew) {
        const newId = await cloud.createTrip(user, draft);
        await saveCover(newId, cover);
        toast('Trip created', 'ok');
        location.hash = `#/trip/${enc(newId)}`;
        return;
      }
      try {
        await cloud.updateTrip(user, id, draft, baseMs);
      } catch (e) {
        if (!(e instanceof cloud.ConflictError)) throw e;
        if (!(await ask(`${e.by || 'Another member'} changed this trip while you were editing.`, {
          detail: 'Overwrite their changes with yours, or keep editing and load their version first.',
          ok: 'Overwrite',
          cancel: 'Keep editing',
          danger: true,
        }))) return false;
        await cloud.updateTrip(user, id, draft, baseMs, { force: true });
      }
      await saveCover(id, cover);
      toast('Saved', 'ok');
      location.hash = `#/trip/${enc(id)}`;
    },
    onCancel: () => { location.hash = isNew ? '#/' : `#/trip/${enc(id)}`; },
    onReload: () => route(),
    onDelete: async () => { await cloud.deleteTrip(id); toast('Trip deleted', 'ok'); location.hash = '#/'; },
    onDuplicate: async (copy) => {
      copy.title = `${copy.title} (copy)`;
      const newId = await cloud.createTrip(user, copy);
      toast('Copy created — only you are a member', 'ok');
      location.hash = `#/edit/${enc(newId)}`;
    },
  });

  // Tell the editor when another member saves this trip, so nobody edits a stale copy unknowingly.
  if (!isNew) {
    keep(await cloud.watchTrip(id, (e) => {
      if (!e) { editor?.notice('This trip was just deleted by its owner.'); return; }
      if (e.meta.updatedAtMs && e.meta.updatedAtMs !== baseMs && !e.meta.pending) {
        const who = e.meta.updatedBy === user.email ? 'You (on another device)' : esc(e.meta.updatedBy);
        editor?.notice(`<strong>${who}</strong> just saved changes to this trip.`, true);
      }
    }));
  }
}

/* ============================================================
   Members
   ============================================================ */
async function showMembers(id) {
  if (!user) { showHome({ message: 'Sign in to manage trip members.' }); return; }
  // Re-renders live as members are added or removed (the watcher is closed on navigation).
  watchCoverFor(id);
  keep(await cloud.watchTrip(id, (entry) => {
    if (!entry) { toast('This trip was deleted, or you were removed from it.', 'bad'); location.replace('#/'); return; }
    renderMembers(entry);
  }, (err) => { if (err === 'denied') showDenied(id); else toast(err, 'bad'); }));
}

function renderMembers({ trip, meta }) {
  const owner = meta.ownerUid === user.uid;
  const invite = `${location.origin}${location.pathname}#/trip/${enc(trip.id)}`;
  setHero({ eyebrow: 'Trip members', title: trip.title, sub: `${meta.memberEmails.length} member${meta.memberEmails.length === 1 ? '' : 's'}`, nav: backLink(`#/trip/${enc(trip.id)}`, 'Back to trip'), trip: trip.id });
  ensureAutoCover(trip);
  $('site-foot').textContent = 'Only members can open this trip. Access is enforced by Firebase security rules.';
  const members = [meta.ownerEmail, ...meta.memberEmails.filter((m) => m !== meta.ownerEmail)];
  const full = meta.memberEmails.length >= MAX_MEMBERS;
  $('view-members').innerHTML = `
    <section class="ed-card">
      <h2 class="sec-h">Invite people</h2>
      ${owner
        ? `<label class="chk big"><input type="checkbox" data-link-join${meta.linkJoin ? ' checked' : ''}> Anyone with the link can join</label>`
        : `<p class="fine"><strong>${meta.linkJoin ? 'Anyone with the link can join.' : 'Only people the owner adds by email can join.'}</strong></p>`}
      <p class="fine">${meta.linkJoin
        ? `Send this link to friends. They open it, sign in with Google and tap <em>Join trip</em>. No need to type their email.${full ? ` <strong>This trip is full (${MAX_MEMBERS} members).</strong>` : ''}`
        : (owner ? 'Turn this on to let people join with just the link. Otherwise, add their Google email below first, then send them the link.' : 'Send this link to people the owner has added by email.')}</p>
      <div class="invite-row">
        <input class="invite-url" readonly value="${esc(invite)}" aria-label="Invite link">
        <button class="btn" type="button" data-invite="${esc(invite)}">${navigator.share ? 'Share' : 'Copy'}</button>
      </div>
    </section>

    <section class="ed-card">
      <h2 class="sec-h">Who can see and edit this trip</h2>
      <ul class="members">
        ${members.map((m) => `
          <li>
            <span class="avatar">${esc(m[0].toUpperCase())}</span>
            <span class="m-email">${esc(m)}${m === user.email ? ' <span class="muted">(you)</span>' : ''}</span>
            ${m === meta.ownerEmail ? '<span class="badge pub">Owner</span>' : '<span class="badge local">Can edit</span>'}
            ${owner && m !== meta.ownerEmail ? `<button class="icon-btn" type="button" data-remove="${esc(m)}" title="Remove ${esc(m)}" aria-label="Remove ${esc(m)}">✕</button>` : ''}
          </li>`).join('')}
      </ul>
      ${owner ? `
        <form id="add-member" class="add-member" novalidate>
          <input type="email" name="email" placeholder="Or add by email: friend@gmail.com" autocomplete="off" aria-label="Collaborator's Google email" ${full ? 'disabled' : ''}>
          <button class="btn ghost" type="submit" ${full ? 'disabled' : ''}>Add</button>
        </form>
        <p class="fine">Use the email of their <strong>Google account</strong>. Members can view and edit the plan. Only you can add or remove people or delete the trip.</p>`
        : `<p class="fine">${esc(meta.ownerEmail)} owns this trip and manages who's in it.</p>`}
    </section>

    <section class="ed-card">
      <h2 class="sec-h">Send a copy instead</h2>
      <p class="fine">Gives someone their own separate copy of the plan. They can't see your future changes, and you can't see theirs.</p>
      <div><button class="btn ghost" type="button" data-send-copy>Send a copy</button></div>
    </section>

    ${owner ? '' : `
    <section class="ed-card">
      <h2 class="sec-h">Leave this trip</h2>
      <p class="fine">It disappears from your list. The owner can add you back later.</p>
      <div><button class="btn ghost danger" type="button" data-leave>Leave trip</button></div>
    </section>`}`;
  showView('members');

  const view = $('view-members');
  view.querySelector('[data-link-join]')?.addEventListener('change', async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    try {
      await cloud.setLinkJoin(user, trip.id, on);
      toast(on ? 'Anyone with the link can now join' : 'Link joining turned off. Only people you add by email can join.', 'ok');
    } catch (err) { e.target.checked = !on; toast(err.message, 'bad'); }
    e.target.disabled = false;
  });
  view.querySelector('#add-member')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = String(new FormData(e.target).get('email') || '').trim().toLowerCase();
    if (!EMAIL.test(email)) { toast('Enter a valid email address.', 'bad'); return; }
    if (meta.memberEmails.includes(email)) { toast('They\'re already a member.', 'bad'); return; }
    try {
      await cloud.setMembers(user, trip.id, [...meta.memberEmails, email]);
      toast(`Added ${email}. Now send them the invite link.`, 'ok');
    } catch (err) { toast(err.message, 'bad'); }
  });
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove) {
      if (!(await ask(`Remove ${b.dataset.remove} from this trip?`, { detail: 'They lose access straight away.', ok: 'Remove', danger: true }))) return;
      try { await cloud.setMembers(user, trip.id, meta.memberEmails.filter((m) => m !== b.dataset.remove)); toast('Removed', 'ok'); } catch (err) { toast(err.message, 'bad'); }
    } else if (b.dataset.invite) {
      shareOrCopy(b.dataset.invite, `Join my trip “${trip.title}”`, 'Invite link copied');
    } else if ('sendCopy' in b.dataset) {
      shareCopy(trip);
    } else if ('leave' in b.dataset) {
      if (!(await ask('Leave this trip?', { detail: 'You\'ll lose access until the owner adds you again.', ok: 'Leave trip', danger: true }))) return;
      try { await cloud.leaveTrip(user, trip.id); toast('You left the trip', 'ok'); location.replace('#/'); } catch (err) { toast(err.message, 'bad'); }
    }
  };
}

/* ============================================================
   Account
   ============================================================ */
function showAccount() {
  setHero({ title: 'Account', sub: user ? user.email : 'Not signed in', nav: backLink() });
  $('site-foot').textContent = cloud.emulatorMode ? 'Using local Firebase emulators.' : 'Signed in with Google via Firebase Authentication.';
  if (!user) { $('view-settings').innerHTML = signInCard(); showView('settings'); return; }
  $('view-settings').innerHTML = `
    <section class="ed-card">
      <div class="who">
        ${user.photo ? `<img class="avatar-lg" src="${esc(user.photo)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar avatar-lg">${esc(user.email[0].toUpperCase())}</span>`}
        <div><strong>${esc(user.name)}</strong><div class="fine">${esc(user.email)}</div></div>
      </div>
      <p class="fine">Collaborators add you by this email address.</p>
      <div><button class="btn ghost" type="button" data-a="signout">Sign out</button></div>
    </section>
    <section class="ed-card">
      <h2 class="sec-h">Backup</h2>
      <p class="fine">Download every trip you're a member of as a <code>trips.json</code> file, or import one. Imported trips are added to your account with only you as a member.</p>
      <div class="home-actions">
        <button class="btn ghost" type="button" data-a="export">Download my trips</button>
        <button class="btn ghost" type="button" data-a="import">Import file</button>
      </div>
    </section>
    <p class="fine app-version" title="Build ${esc(APP_VERSION)}">GoWander V${esc(RELEASE)}</p>
    <input type="file" id="import-file-s" accept=".json,application/json" hidden>`;
  showView('settings');
}

/* ============================================================
   Import from a share link
   ============================================================ */
async function showImport(payload) {
  let trip;
  try { trip = await store.decodeShare(payload || ''); } catch {
    toast('That link is broken or incomplete.', 'bad');
    location.replace('#/');
    return;
  }
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  setHero({ eyebrow: 'Shared trip', title: trip.title, desc: trip.subtitle, sub: `${fmtRange(trip.days[0]?.date, trip.days[trip.days.length - 1]?.date)} · ${trip.days.length} days · ${stops} stops`, nav: backLink() });
  $('view-import').innerHTML = `
    <section class="ed-card">
      <h2 class="sec-h">Someone sent you a copy of a trip</h2>
      <ul class="import-days">
        ${trip.days.map((d, i) => `<li><strong>Day ${i + 1}</strong> · ${esc(fmtRange(d.date, d.date))}${d.title ? ` — ${esc(d.title)}` : ''} <span class="muted">(${d.stops.length} stops)</span></li>`).join('')}
      </ul>
      <div class="home-actions">
        ${user ? '<button class="btn" type="button" data-imp="save">Save to my trips</button>' : (cloud.available() ? '<button class="btn" type="button" data-a="signin">Sign in to save it</button>' : '')}
        <button class="btn ghost" type="button" data-imp="preview">Just view it</button>
      </div>
      <p class="fine">${user ? 'It becomes your own trip — only you are a member until you add others.' : 'You can view it without signing in. Saving needs a Google sign-in.'}</p>
    </section>`;
  showView('import');
  $('view-import').onclick = async (e) => {
    const b = e.target.closest('[data-imp]');
    if (!b) return;
    if (b.dataset.imp === 'preview') { showTripObject(trip, { preview: true }); return; }
    b.disabled = true;
    try {
      const id = await cloud.createTrip(user, trip);
      toast('Trip saved to your account', 'ok');
      location.replace(`#/trip/${enc(id)}`);
    } catch (err) { b.disabled = false; toast(err.message, 'bad'); }
  };
}

/* ============================================================
   Shared event handlers
   ============================================================ */
async function importFiles(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file || !user) return;
  try {
    const trips = await store.readTripsFile(file);
    for (const t of trips) await cloud.createTrip(user, t);
    toast(`Imported ${trips.length} trip${trips.length === 1 ? '' : 's'}`, 'ok');
    location.hash = '#/';
  } catch (err) {
    toast(err.message || 'Couldn\'t read that file.', 'bad');
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-a], [data-copy-sample]');
  if (!b || !b.closest('#view-home, #view-settings, #view-import, #hero-nav')) return;
  if (b.dataset.copySample) {
    e.preventDefault();
    const t = samples.find((x) => x.id === b.dataset.copySample);
    if (!t || !user) return;
    b.disabled = true;
    try {
      const id = await cloud.createTrip(user, t);
      toast('Copied to your trips — now you can edit it', 'ok');
      location.hash = `#/trip/${enc(id)}`;
    } catch (err) { b.disabled = false; toast(err.message, 'bad'); }
    return;
  }
  switch (b.dataset.a) {
    case 'signin':
    case 'switch-account':
      try {
        if (b.dataset.a === 'switch-account') { await cloud.signOutUser(); location.reload(); return; }
        await cloud.signIn();
      } catch (err) { toast(err.message, 'bad'); }
      break;
    case 'signout':
      if (!(await ask('Sign out of GoWander?', { detail: 'Your trips stay safe in your account. The offline copy on this device is removed.', ok: 'Sign out' }))) return;
      await cloud.signOutUser();
      location.replace(`${location.pathname}${location.search}#/`);
      location.reload();
      break;
    case 'import':
      (current === 'settings' ? $('import-file-s') : $('import-file')).click();
      break;
    case 'export':
      store.downloadJson('trips.json', { version: 1, trips: myTrips.map((x) => x.trip) });
      break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'import-file' || e.target.id === 'import-file-s') importFiles(e.target);
});

/* ============================================================
   Router
   ============================================================ */
async function route() {
  const [, view, arg = ''] = (location.hash.replace(/^#/, '') || '/').split('/');
  if (current === 'trip' && view !== 'trip') unmountTrip();
  if (current === 'edit') { editor?.dispose(); editor = null; }
  for (const off of cleanups.splice(0)) off();
  window.scrollTo(0, 0);
  try {
    switch (view) {
      case 'trip': return await showTrip(decodeURIComponent(arg));
      case 'edit': return await showEdit(decodeURIComponent(arg || 'new'));
      case 'members': return await showMembers(decodeURIComponent(arg));
      case 'account': return showAccount();
      case 'import': return await showImport(arg);
      default: return showHome();
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong.', 'bad');
  }
}

// Leaving the editor with unsaved changes asks first.
// A hash change can't be paused, so step back, ask, and continue only if confirmed.
window.addEventListener('hashchange', async (e) => {
  if (current === 'edit' && editor?.isDirty()) {
    const target = location.hash;
    history.replaceState(null, '', new URL(e.oldURL).hash);
    if (await ask('Leave without saving your changes?', { ok: 'Leave', cancel: 'Keep editing', danger: true })) {
      editor.markClean();
      location.hash = target;
    }
    return;
  }
  route();
});

function subscribeMine() {
  unsubMine?.();
  unsubMine = null;
  myTrips = [];
  myTripsReady = new Promise((r) => { resolveMyTrips = r; });
  if (!user) { resolveMyTrips(); return; }
  cloud.watchMyTrips(user, (list) => {
    myTrips = list;
    resolveMyTrips();
    if (current === 'home') showHome();
  }, (err) => { resolveMyTrips(); toast(err, 'bad'); }).then((u) => { unsubMine = u; });
}

async function boot() {
  samples = await store.loadSamples();
  let booted = false;
  cloud.onUserChange(async (u) => {
    const changed = u?.uid !== user?.uid;
    user = u;
    if (changed || !booted) subscribeMine();
    if (!booted) {
      booted = true;
      if (!location.hash || location.hash === '#' || location.hash === '#/') {
        // Test mode opens the sample trip; otherwise jump into a trip that's happening right now.
        let target = sim.enabled ? samples[0]?.id : null;
        if (!target && user) {
          await Promise.race([myTripsReady, new Promise((r) => setTimeout(r, 3000))]);
          target = myTrips.find((e) => tripStatus(e.trip).key === 'live')?.trip.id;
        }
        if (target) history.replaceState(null, '', `${location.search}#/trip/${enc(target)}`);
      }
      route();
    } else if (changed) {
      route();
    }
  });
}
boot();

/* ============================================================
   No page zoom. The viewport meta covers Android; iOS Safari ignores it, so block its pinch
   gestures too, and Ctrl + wheel / Ctrl +/-/0 on desktop. The map handles its own zoom first,
   so it still zooms.
   ============================================================ */
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 && !e.target.closest?.('#map')) e.preventDefault(); }, { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
});

/* ============================================================
   Versioning: tell people when a newer GoWander has been deployed
   ============================================================ */
// RELEASE is the version people see; bump it by hand when shipping. APP_VERSION is the build
// hash written by the stamp script and is what the update check compares.
const RELEASE = '1.0.1';
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || 'dev';

let updateShown = false;
async function checkForUpdate() {
  if (APP_VERSION === 'dev' || updateShown) return;
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = await res.json();
    if (version && version !== APP_VERSION) {
      updateShown = true;
      toast('A new version of GoWander is available.', 'info', { duration: 0, action: { label: 'Reload', onClick: () => location.reload() } });
    }
  } catch { /* offline — try again later */ }
}

setTimeout(checkForUpdate, 5000);
setInterval(checkForUpdate, 30 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // updateViaCache: 'none' makes the browser always re-check sw.js itself, ignoring HTTP caching.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }))
    .catch(() => {});
}
