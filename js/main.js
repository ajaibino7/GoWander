// App shell: hash router, sign-in, trip list, members, account, and importing shared trips.
import { esc, fmtRange, toast, ask, toastLink, makeClock, deviceTz, THEMES, addDays } from './util.js';
import * as store from './store.js';
import * as cloud from './cloud.js';
import { mountTrip, unmountTrip, setDone, sim } from './live.js';
import { mountEditor } from './editor.js';

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
function setHero({ eyebrow = 'GoWander', title = 'Trips', sub = '', desc = '', nav = '' }) {
  $('hero-eyebrow').textContent = eyebrow;
  $('hero-title').innerHTML = fancyTitle(title);
  $('hero-sub').textContent = sub;
  $('hero-desc').textContent = desc;
  $('hero-desc').hidden = !desc;
  $('hero-nav').innerHTML = nav;
  document.title = title === 'Trips' ? 'GoWander' : `${title} · GoWander`;
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
function card(trip, i, { badges = '', actions = '' } = {}) {
  const st = tripStatus(trip);
  const stops = trip.days.reduce((n, d) => n + d.stops.length, 0);
  const first = trip.days[0]?.date, last = trip.days[trip.days.length - 1]?.date;
  return `
    <article class="trip-card theme-${THEMES[i % THEMES.length]}">
      <a class="tc-main" href="#/trip/${enc(trip.id)}">
        <div class="tc-top"><span class="chip ${st.key}">${esc(st.label)}</span></div>
        <h3>${esc(trip.title)}</h3>
        <div class="tc-meta">${esc(fmtRange(first, last))} · ${trip.days.length} day${trip.days.length === 1 ? '' : 's'} · ${stops} stop${stops === 1 ? '' : 's'}</div>
        ${trip.subtitle ? `<div class="tc-sub">${esc(trip.subtitle)}</div>` : ''}
      </a>
      <div class="tc-foot"><span class="badges">${badges}</span><span class="tc-actions">${actions}</span></div>
    </article>`;
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
  setHero({
    title: 'Trips',
    sub: user ? `Signed in as ${user.email}` : 'Plan trips together and follow them live',
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
    showView('home');
    return;
  }

  const rows = myTrips.map((e) => ({ ...e, st: tripStatus(e.trip) })).sort(byStatus);
  $('view-home').innerHTML = `
    <div class="home-actions">
      <a class="btn" href="#/edit/new">+ New trip</a>
      <button class="btn ghost" type="button" data-a="import">Import file</button>
    </div>
    <h2 class="list-h">Your trips</h2>
    <div class="trip-list">
      ${rows.map(({ trip, meta }, i) => {
        const owner = meta.ownerUid === user.uid;
        const n = meta.memberEmails.length;
        return card(trip, i, {
          badges: `${owner ? '<span class="badge pub">Owner</span>' : `<span class="badge local" title="${esc(meta.ownerEmail)}">Shared by ${esc(meta.ownerEmail.split('@')[0])}</span>`}
            ${n > 1 ? `<span class="badge local">👥 ${n}</span>` : ''}
            ${meta.pending ? '<span class="badge dirty">Syncing…</span>' : ''}`,
          actions: `<a class="mini" href="#/edit/${enc(trip.id)}">Edit</a><a class="mini" href="#/members/${enc(trip.id)}">Members</a>`,
        });
      }).join('') || `
        <div class="empty">
          <div class="empty-t">No trips yet</div>
          <p>Create one, copy the sample, or import a trips file. Trips others share with you appear here too.</p>
        </div>`}
    </div>
    ${samplesSection(sampleCards)}
    <input type="file" id="import-file" accept=".json,application/json" hidden>`;
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
  setHero({ eyebrow: opts.sample ? 'Sample trip' : 'GoWander · live', title: trip.title, desc: trip.subtitle, nav: tripNav(trip, opts) });
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
  });
  $('site-foot').textContent = 'Place search by OpenStreetMap Nominatim.';
  showView('edit');
  editor = mountEditor($('view-edit'), trip, {
    isNew,
    canDelete: owner,
    onSave: async (draft) => {
      if (isNew) {
        const newId = await cloud.createTrip(user, draft);
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
  keep(await cloud.watchTrip(id, (entry) => {
    if (!entry) { toast('This trip was deleted, or you were removed from it.', 'bad'); location.replace('#/'); return; }
    renderMembers(entry);
  }, (err) => { if (err === 'denied') showDenied(id); else toast(err, 'bad'); }));
}

function renderMembers({ trip, meta }) {
  const owner = meta.ownerUid === user.uid;
  const invite = `${location.origin}${location.pathname}#/trip/${enc(trip.id)}`;
  setHero({ eyebrow: 'Trip members', title: trip.title, sub: `${meta.memberEmails.length} member${meta.memberEmails.length === 1 ? '' : 's'}`, nav: backLink(`#/trip/${enc(trip.id)}`, 'Back to trip') });
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
    <p class="fine app-version">GoWander version ${esc(APP_VERSION)}</p>
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
