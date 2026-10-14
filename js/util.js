// Shared helpers: escaping, geo maths, durations, and timezone-aware trip clocks.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DEFAULT_TZ = 'Asia/Kolkata';
export const THEMES = ['navy', 'green', 'coral', 'gold'];
export const THEME_COLORS = { navy: '#1f4e79', green: '#2f7a59', coral: '#c4553b', gold: '#b8801c' };
export const KIND_LABELS = { stop: 'Sightseeing', meal: 'Food', travel: 'Travel', stay: 'Stay / rest' };
export const TAG_LABELS = { must: 'Must see', key: 'Main attraction', optional: 'Optional', closing: 'Before closing', deadline: 'Be on time' };
export const NOTE_LABELS = { star: 'Highlight', tip: 'Tip', warn: 'Warning' };

/* ---------- geo ---------- */
export function distM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

// Rough travel-time estimate from straight-line distance. Deliberately pessimistic for city traffic.
export function estimateTravel(m) {
  const road = m * 1.35;
  if (road < 1500) return { ms: (road / 4500) * 3600000, mode: 'walk' };
  const kmh = road > 30000 ? 45 : 18;
  return { ms: (road / 1000 / kmh) * 3600000 + 5 * 60000, mode: 'drive' };
}
export const directionsUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
export const isHere = (pos, place) => !!pos && distM(pos, place) <= place.radius + Math.min(pos.accuracy || 0, 150);

/* ---------- durations & plain times ---------- */
export function fmtDur(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}
export function fmtHHMM(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}
export const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export function fromMin(m) {
  m = Math.max(0, Math.min(23 * 60 + 59, Math.round(m)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* ---------- plain calendar dates (YYYY-MM-DD, no timezone) ---------- */
const noonUTC = (date) => new Date(`${date}T12:00:00Z`);
const fmtUTC = (date, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(noonUTC(date));
export const weekdayOf = (date) => fmtUTC(date, { weekday: 'long' });
export const shortDate = (date) => fmtUTC(date, { weekday: 'short', day: 'numeric', month: 'short' }); // "Sat 17 Oct"
export const dayMonth = (date) => fmtUTC(date, { day: 'numeric', month: 'short' }); // "17 Oct"
export function addDays(date, n) {
  const d = noonUTC(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function fmtRange(first, last) {
  if (!first) return 'No dates yet';
  const y = (d) => d.slice(0, 4);
  if (first === last) return `${fmtUTC(first, { day: 'numeric', month: 'short' })} ${y(first)}`;
  if (first.slice(0, 7) === last.slice(0, 7)) return `${Number(first.slice(8))}–${fmtUTC(last, { day: 'numeric', month: 'short' })} ${y(last)}`;
  if (y(first) === y(last)) return `${dayMonth(first)} – ${dayMonth(last)} ${y(last)}`;
  return `${dayMonth(first)} ${y(first)} – ${dayMonth(last)} ${y(last)}`;
}

/* ---------- timezone-aware clock for a trip ---------- */
export function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}
export const deviceTz = () => validTz(Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ);

function partsIn(tz, d) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) p[x.type] = x.value;
  p.hour = String(Number(p.hour) % 24).padStart(2, '0');
  return p;
}
function tzOffsetMs(tz, d) {
  const p = partsIn(tz, d);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - (d.getTime() - d.getMilliseconds());
}
export function tzLabel(tz) {
  if (tz === 'Asia/Kolkata') return 'IST';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value || tz;
  } catch { return tz; }
}

// All trip times are wall-clock times in the trip's timezone, whatever the phone is set to.
export function makeClock(tz = DEFAULT_TZ) {
  tz = validTz(tz);
  const at = (date, hhmm) => {
    const [y, mo, da] = date.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, da, h, mi);
    let t = guess - tzOffsetMs(tz, new Date(guess));
    t = guess - tzOffsetMs(tz, new Date(t)); // second pass settles DST edges
    return new Date(t);
  };
  return {
    tz,
    label: tzLabel(tz),
    at,
    dateKey: (d) => { const p = partsIn(tz, d); return `${p.year}-${p.month}-${p.day}`; },
    inputValue: (d) => { const p = partsIn(tz, d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; },
    parseInput: (s) => at(s.slice(0, 10), s.slice(11, 16)),
    fmtClock: (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d),
    fmtDay: (d) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d),
  };
}

/* ---------- misc ---------- */
export function newId(title = 'trip') {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'trip';
  return `${slug}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ============================================================
   Toaster — notifications and questions, instead of browser pop-ups
   ============================================================ */
const ICONS = { ok: '✓', bad: '!', warn: '!', info: 'i', ask: '?' };
const MAX_TOASTS = 4;
let toaster = null;
let pendingAsk = null;

function toasterEl() {
  if (!toaster) {
    toaster = document.createElement('div');
    toaster.className = 'toaster';
    toaster.setAttribute('aria-live', 'polite');
    document.body.appendChild(toaster);
  }
  return toaster;
}

function makeToast(kind, { role = 'status', closable = true } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', role);
  el.innerHTML = `<span class="t-icon" aria-hidden="true">${ICONS[kind] || ICONS.info}</span><div class="t-body"></div>${closable ? '<button type="button" class="t-x" aria-label="Dismiss">✕</button>' : ''}`;
  const box = toasterEl();
  box.appendChild(el);
  // Keep the stack short: drop the oldest plain notifications first.
  const plain = [...box.querySelectorAll('.toast:not(.ask):not(.out)')];
  while (box.querySelectorAll('.toast:not(.out)').length > MAX_TOASTS && plain.length) dismiss(plain.shift());
  requestAnimationFrame(() => el.classList.add('in'));
  return el;
}

function dismiss(el) {
  if (!el || el.classList.contains('out')) return;
  el.classList.remove('in');
  el.classList.add('out');
  setTimeout(() => el.remove(), 220);
}

/**
 * Shows a notification. kind: 'ok' | 'bad' | 'warn' | 'info'.
 * options.duration: ms before it hides (0 = stays until dismissed).
 * options.action: { label, onClick } adds a button, e.g. "Reload".
 * Returns a function that dismisses it.
 */
export function toast(msg, kind = 'info', { duration, action } = {}) {
  const el = makeToast(kind, { role: kind === 'bad' ? 'alert' : 'status' });
  const body = el.querySelector('.t-body');
  const text = document.createElement('span');
  text.className = 't-msg';
  text.textContent = msg;
  body.appendChild(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 't-btn primary';
    b.textContent = action.label;
    b.onclick = () => { dismiss(el); action.onClick(); };
    body.appendChild(b);
  }
  el.querySelector('.t-x').onclick = () => dismiss(el);
  const ms = duration ?? (kind === 'bad' ? 6000 : action ? 8000 : 3500);
  let timer = ms ? setTimeout(() => dismiss(el), ms) : null;
  // Don't vanish while someone is reading or reaching for it.
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { if (ms) timer = setTimeout(() => dismiss(el), 2000); });
  return () => dismiss(el);
}

/**
 * Asks a question in a toast. Resolves true for the confirm button, false for cancel,
 * Escape, ✕, or when another question replaces it.
 *   await ask('Remove this stop?', { ok: 'Remove', danger: true })
 */
export function ask(message, { ok = 'OK', cancel = 'Cancel', danger = false, detail = '' } = {}) {
  pendingAsk?.(false);
  return new Promise((resolve) => {
    const el = makeToast('ask', { role: 'alertdialog' });
    el.classList.add('ask');
    if (danger) el.classList.add('danger');
    el.setAttribute('aria-label', message);
    const body = el.querySelector('.t-body');
    body.innerHTML = `
      <span class="t-msg"></span>
      ${detail ? '<span class="t-detail"></span>' : ''}
      <span class="t-actions">
        <button type="button" class="t-btn" data-r="0"></button>
        <button type="button" class="t-btn ${danger ? 'danger' : 'primary'}" data-r="1"></button>
      </span>`;
    body.querySelector('.t-msg').textContent = message;
    if (detail) body.querySelector('.t-detail').textContent = detail;
    body.querySelector('[data-r="0"]').textContent = cancel;
    body.querySelector('[data-r="1"]').textContent = ok;

    const finish = (answer) => {
      if (pendingAsk !== finish) return;
      pendingAsk = null;
      document.removeEventListener('keydown', onKey, true);
      dismiss(el);
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    pendingAsk = finish;
    document.addEventListener('keydown', onKey, true);
    el.querySelector('.t-x').onclick = () => finish(false);
    body.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) finish(b.dataset.r === '1'); };
    setTimeout(() => body.querySelector('[data-r="1"]').focus(), 50);
  });
}

// Shows a link the user can copy by hand (fallback when the clipboard isn't available).
export function toastLink(label, url) {
  const el = makeToast('info');
  const body = el.querySelector('.t-body');
  body.innerHTML = '<span class="t-msg"></span><input class="t-input" readonly>';
  body.querySelector('.t-msg').textContent = label;
  const input = body.querySelector('.t-input');
  input.value = url;
  input.onfocus = () => input.select();
  el.querySelector('.t-x').onclick = () => dismiss(el);
  setTimeout(() => input.focus(), 50);
}
