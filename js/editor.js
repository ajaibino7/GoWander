// Trip editor: trip details, days, stops (with locations), notes, and fixed departures.
import { esc, ask, toast, KIND_LABELS, TAG_LABELS, NOTE_LABELS, toMin, fromMin, addDays, weekdayOf, makeClock, DEFAULT_TZ } from './util.js';
import { openPlacePicker } from './placepicker.js';
import { newStopId } from './store.js';

const TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch {
    return ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
  }
})();

/* ---------- cover image ---------- */
const COVER_MAX = 500 * 1024;
const COVER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const isCoverUrl = (u) => typeof u === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(u);

const readDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Images up to 500 KB are used as they are. Bigger ones (e.g. phone photos) are resized and
// re-compressed as JPEG until they fit, so nobody has to shrink them by hand.
async function prepareCover(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WebP).');
  if (COVER_TYPES.includes(file.type) && file.size <= COVER_MAX) return readDataUrl(file);
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image couldn\'t be opened. Try a JPG or PNG.'); }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  for (const width of [1920, 1600, 1280, 1024, 800]) {
    const scale = Math.min(1, width / bmp.width);
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    ctx.fillStyle = '#fff'; // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.75, 0.65]) {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= COVER_MAX) return readDataUrl(blob);
    }
  }
  throw new Error('That image is too detailed to fit in 500 KB. Try a smaller one.');
}

// Swaps stops k and k+1. Stops are kept in time order, so the one moving up takes the earlier
// slot: each keeps its duration and the gap between them, and the pair ends when it did before.
function swapStops(stops, k) {
  const a = stops[k], b = stops[k + 1];
  const ok = (s) => /^\d\d:\d\d$/.test(s.start || '') && /^\d\d:\d\d$/.test(s.end || '');
  if (ok(a) && ok(b)) {
    const dur = (s) => Math.max(0, toMin(s.end) - toMin(s.start));
    const start = toMin(a.start);
    const gap = Math.max(0, toMin(b.start) - toMin(a.end));
    const da = dur(a), db = dur(b);
    b.start = fromMin(start);
    b.end = fromMin(start + db);
    a.start = fromMin(start + db + gap);
    a.end = fromMin(start + db + gap + da);
  }
  stops[k] = b;
  stops[k + 1] = a;
}

const blankStop = (start = '09:00') => ({ id: newStopId(), start, end: fromMin(toMin(start) + 60), kind: 'stop', title: '', note: '', place: null });

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

/**
 * opts: { isNew, canDelete, coverP (Promise of the current cover data URL or null),
 *         onSave(trip, cover) → false if cancelled — cover is undefined (unchanged), a data URL, or null (removed),
 *         onCancel(), onReload(), onDelete(), onDuplicate(trip) }
 */
export function mountEditor(el, trip, opts) {
  const draft = structuredClone(trip);
  for (const d of draft.days) { d.stops ??= []; d.notes ??= []; }
  let errors = [];
  let errorStops = new Set();
  let changed = false;
  let noticeHtml = ''; // e.g. "Priya just saved changes" while you're editing
  let coverSaved = null; // what the trip has now
  let coverEdit; // undefined = unchanged, data URL = new image, null = back to the default
  let coverBusy = false;
  let auto = null; // the destination photo used when nothing is uploaded
  const coverNow = () => (coverEdit === undefined ? coverSaved : coverEdit);
  const autoUrl = () => (/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(auto?.hero || '') ? auto.hero.replace(/\/(\d+)px-([^/]+)$/, '/500px-$2') : '');

  function coverHtml() {
    const has = !!coverNow();
    const label = auto ? `Photo of ${esc(auto.place)} · ${esc(auto.source)}` : 'Default cover';
    return `
      <div class="fld cover-fld">
        <span>Cover image (optional)</span>
        <div class="cover-pick">
          <div class="cover-prev${has || auto ? ' has' : ''}" role="img" aria-label="${has ? 'Cover image preview' : label}">${has ? '' : `<span>${label}</span>`}</div>
          <div class="cover-actions">
            <button type="button" class="btn ghost small" data-a="cover-pick"${coverBusy ? ' disabled' : ''}>${coverBusy ? 'Preparing…' : has ? 'Change image' : 'Upload image'}</button>
            ${has ? `<button type="button" class="btn ghost small" data-a="cover-remove">${auto ? 'Use destination photo' : 'Use default'}</button>` : ''}
          </div>
        </div>
        <small>JPG, PNG or WebP, up to 500 KB. Bigger photos are shrunk to fit automatically. Without an upload, the trip shows a photo of its main destination.</small>
        <input type="file" accept="image/jpeg,image/png,image/webp,image/*" hidden data-cover-file>
      </div>`;
  }
  // The image is set as a style after rendering, so the big data URL isn't re-parsed as HTML on every edit.
  function paintCover() {
    const prev = el.querySelector('.cover-prev');
    const url = coverNow();
    if (prev) prev.style.backgroundImage = isCoverUrl(url) ? `url("${url}")` : autoUrl() ? `url("${autoUrl()}")` : '';
  }
  function renderCover() {
    const box = el.querySelector('.cover-fld');
    if (!box) return;
    box.outerHTML = coverHtml();
    paintCover();
  }
  opts.coverP?.then((url) => { coverSaved = isCoverUrl(url) ? url : null; renderCover(); });
  opts.autoP?.then((info) => { auto = info || null; renderCover(); });

  const tzToday = () => makeClock(draft.timezone || DEFAULT_TZ).dateKey(new Date());

  function stopHtml(s, i, j, stopsLen) {
    const p = `days.${i}.stops.${j}`;
    const bad = errorStops.has(`${i}.${j}`);
    return `
      <div class="ed-stop${bad ? ' err' : ''}" id="stop-${i}-${j}">
        <div class="ed-row">
          <input type="time" class="t" data-f="${p}.start" value="${esc(s.start)}" aria-label="Start time" required>
          <span class="dash">–</span>
          <input type="time" class="t" data-f="${p}.end" value="${esc(s.end)}" aria-label="End time" required>
          <select data-f="${p}.kind" aria-label="Type">${Object.entries(KIND_LABELS).map(([k, v]) => `<option value="${k}"${s.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <span class="ed-move">
            <button type="button" class="icon-btn" data-a="move-stop" data-dir="-1" data-d="${i}" data-s="${j}" title="Move earlier" aria-label="Move stop ${j + 1} earlier"${j === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-a="move-stop" data-dir="1" data-d="${i}" data-s="${j}" title="Move later" aria-label="Move stop ${j + 1} later"${j === stopsLen - 1 ? ' disabled' : ''}>↓</button>
          </span>
          <button type="button" class="icon-btn" data-a="del-stop" data-d="${i}" data-s="${j}" title="Remove stop" aria-label="Remove stop">✕</button>
        </div>
        <input class="title-in" data-f="${p}.title" value="${esc(s.title)}" maxlength="160" placeholder="What's the plan? e.g. Sunset at Chapora Fort" aria-label="Stop title">
        <input data-f="${p}.note" value="${esc(s.note || '')}" maxlength="300" placeholder="Note (optional)" aria-label="Note">
        <div class="ed-row">
          <button type="button" class="place-btn${s.place ? '' : ' missing'}" data-a="pick-place" data-d="${i}" data-s="${j}">
            📍 ${s.place ? `${esc(s.place.name)} <small>· ${s.place.radius < 1000 ? `${s.place.radius} m` : `${s.place.radius / 1000} km`}</small>` : 'Set location'}
          </button>
          <select data-f="${p}.tag" aria-label="Label"><option value="">No label</option>${Object.entries(TAG_LABELS).map(([k, v]) => `<option value="${k}"${s.tag === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
        </div>
        <label class="chk"><input type="checkbox" data-a="toggle-dep" data-d="${i}" data-s="${j}"${s.departure ? ' checked' : ''}> Fixed departure (train, flight, bus) — show a “leave by” countdown</label>
        ${s.departure ? `<label class="chk sub">Be there <input type="number" class="num" min="0" max="360" step="5" data-f="${p}.departure.buffer" data-type="number" value="${s.departure.buffer}"> minutes early</label>` : ''}
      </div>`;
  }

  function noteHtml(n, i, k) {
    const p = `days.${i}.notes.${k}`;
    return `
      <div class="ed-note">
        <div class="ed-row">
          <select data-f="${p}.type" aria-label="Note type">${Object.entries(NOTE_LABELS).map(([t, v]) => `<option value="${t}"${n.type === t ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <input data-f="${p}.title" value="${esc(n.title)}" maxlength="60" placeholder="Heading, e.g. Don't miss" aria-label="Note heading">
          <button type="button" class="icon-btn" data-a="del-note" data-d="${i}" data-k="${k}" title="Remove note" aria-label="Remove note">✕</button>
        </div>
        <textarea data-f="${p}.text" rows="2" maxlength="600" placeholder="Tip or reminder for this day" aria-label="Note text">${esc(n.text)}</textarea>
      </div>`;
  }

  function dayHtml(d, i) {
    return `
      <section class="ed-day">
        <div class="ed-day-h">
          <strong>Day ${i + 1}</strong>
          <span class="muted">${d.date ? esc(weekdayOf(d.date)) : ''}</span>
          <button type="button" class="icon-btn" data-a="del-day" data-d="${i}" title="Remove day" aria-label="Remove day ${i + 1}">✕</button>
        </div>
        <div class="grid2">
          <label class="fld"><span>Date</span><input type="date" data-f="days.${i}.date" value="${esc(d.date)}" required></label>
          <label class="fld"><span>Day title</span><input data-f="days.${i}.title" value="${esc(d.title)}" maxlength="160" placeholder="e.g. North Goa beaches"></label>
        </div>
        <div class="ed-stops">${d.stops.map((s, j) => stopHtml(s, i, j, d.stops.length)).join('') || '<div class="muted small">No stops yet.</div>'}</div>
        <button type="button" class="btn ghost small" data-a="add-stop" data-d="${i}">+ Add stop</button>
        <details class="ed-notes"${d.notes.length ? ' open' : ''}>
          <summary>Notes &amp; tips (${d.notes.length})</summary>
          ${d.notes.map((n, k) => noteHtml(n, i, k)).join('')}
          <button type="button" class="btn ghost small" data-a="add-note" data-d="${i}">+ Add note</button>
        </details>
      </section>`;
  }

  function render() {
    const y = window.scrollY;
    const tzs = TIMEZONES.includes(draft.timezone) ? TIMEZONES : [draft.timezone, ...TIMEZONES];
    el.innerHTML = `
      <form class="editor" novalidate>
        ${noticeHtml ? `<div class="ed-notice" role="status">${noticeHtml}</div>` : ''}
        ${errors.length ? `<div class="ed-errors" id="ed-errors" role="alert"><strong>Fix these before saving:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
        <section class="ed-card">
          <label class="fld"><span>Trip name</span><input data-f="title" value="${esc(draft.title)}" maxlength="120" placeholder="e.g. Goa long weekend" required></label>
          <label class="fld"><span>Short description</span><input data-f="subtitle" value="${esc(draft.subtitle || '')}" maxlength="300" placeholder="Optional one-liner shown on the trip card"></label>
          ${coverHtml()}
          <label class="fld"><span>Destination timezone</span>
            <select data-f="timezone">${tzs.map((z) => `<option${z === draft.timezone ? ' selected' : ''}>${esc(z)}</option>`).join('')}</select>
            <small>All times you enter are local times at the destination.</small>
          </label>
        </section>
        ${draft.days.map(dayHtml).join('')}
        <button type="button" class="btn ghost wide" data-a="add-day">+ Add day</button>

        ${opts.isNew ? '' : `
        <section class="ed-card ed-more">
          <button type="button" class="btn ghost small" data-a="duplicate">Duplicate trip</button>
          ${opts.canDelete ? '<button type="button" class="btn ghost small danger" data-a="delete">Delete trip</button>' : ''}
        </section>`}

        <div class="ed-bar">
          <button type="button" class="btn ghost" data-a="cancel">Cancel</button>
          <button type="submit" class="btn">Save trip</button>
        </div>
      </form>`;
    paintCover();
    window.scrollTo(0, y);
  }

  function validate() {
    errors = [];
    errorStops = new Set();
    if (!draft.title.trim()) errors.push('Give the trip a name.');
    if (!draft.days.length) errors.push('Add at least one day.');
    const seen = new Set();
    draft.days.forEach((d, i) => {
      if (!d.date) errors.push(`Day ${i + 1}: choose a date.`);
      else if (seen.has(d.date)) errors.push(`Day ${i + 1}: ${d.date} is used by another day.`);
      seen.add(d.date);
      d.stops.forEach((s, j) => {
        const where = `Day ${i + 1}, stop ${j + 1}`;
        const bad = (msg) => { errors.push(`${where}: ${msg}`); errorStops.add(`${i}.${j}`); };
        if (!s.title.trim()) bad('add a title.');
        if (!s.start || !s.end) bad('set start and end times.');
        else if (s.end < s.start) bad('ends before it starts (stops can\'t run past midnight — split it across two days).');
        if (!s.place) bad('set a location.');
      });
      d.notes.forEach((n, k) => { if (!n.text.trim()) errors.push(`Day ${i + 1}, note ${k + 1}: write something or remove it.`); });
    });
    return !errors.length;
  }

  // Distinct places already used in this trip, most recent last — quick picks in the place picker.
  function recentPlaces() {
    const seen = new Map();
    for (const d of draft.days) for (const s of d.stops) if (s.place) seen.set(`${s.place.lat},${s.place.lng}`, s.place);
    return [...seen.values()].slice(-8);
  }

  /* ---------- events ---------- */
  el.oninput = async (e) => {
    if (e.type === 'change' && e.target.matches('[data-cover-file]')) {
      const file = e.target.files?.[0];
      if (!file) return;
      coverBusy = true;
      renderCover();
      try {
        coverEdit = await prepareCover(file);
        changed = true;
      } catch (err) {
        toast(err.message, 'bad');
      }
      coverBusy = false;
      renderCover();
      return;
    }
    const f = e.target.dataset.f;
    if (!f) return;
    let v = e.target.value;
    if (e.target.dataset.type === 'number') v = Number(v);
    if (f.endsWith('.tag') && !v) {
      delete getPath(draft, f.slice(0, -4)).tag;
    } else setPath(draft, f, v);
    changed = true;
    // Live-update the weekday next to a changed date.
    if (/^days\.\d+\.date$/.test(f)) {
      const label = e.target.closest('.ed-day')?.querySelector('.ed-day-h .muted');
      if (label) label.textContent = v ? weekdayOf(v) : '';
    }
  };
  el.onchange = el.oninput;

  el.onsubmit = async (e) => {
    e.preventDefault();
    if (!validate()) {
      render();
      document.getElementById('ed-errors')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    for (const d of draft.days) d.stops.sort((a, b) => a.start.localeCompare(b.start));
    draft.days.sort((a, b) => a.date.localeCompare(b.date));
    const btn = el.querySelector('button[type="submit"]');
    btn.disabled = true;
    changed = false;
    try {
      if ((await opts.onSave(draft, coverEdit)) === false) changed = true; // cancelled (e.g. after a conflict)
    } catch (err) {
      changed = true;
      errors = [err.message || 'Couldn\'t save.'];
      render();
      document.getElementById('ed-errors')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      btn.disabled = false;
    }
  };

  el.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || b.tagName === 'FORM') return;
    const i = Number(b.dataset.d), j = Number(b.dataset.s);
    switch (b.dataset.a) {
      case 'add-day': {
        const last = draft.days[draft.days.length - 1];
        draft.days.push({ date: last?.date ? addDays(last.date, 1) : tzToday(), title: '', stops: [], notes: [] });
        break;
      }
      case 'del-day':
        if (draft.days[i].stops.length && !(await ask(`Remove Day ${i + 1}?`, { detail: `Its ${draft.days[i].stops.length} stop(s) will be removed too.`, ok: 'Remove day', danger: true }))) return;
        draft.days.splice(i, 1);
        break;
      case 'add-stop': {
        const stops = draft.days[i].stops;
        stops.push(blankStop(stops.length ? stops[stops.length - 1].end : '09:00'));
        break;
      }
      case 'del-stop':
        draft.days[i].stops.splice(j, 1);
        break;
      case 'move-stop': {
        const stops = draft.days[i].stops;
        const to = j + Number(b.dataset.dir);
        if (to < 0 || to >= stops.length) return;
        swapStops(stops, Math.min(j, to));
        errorStops = new Set(); // indexes changed; validation runs again on save
        changed = true;
        render();
        // Keep the moved stop in view and flash it so it's easy to follow.
        const moved = document.getElementById(`stop-${i}-${to}`);
        moved?.classList.add('moved');
        moved?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        moved?.querySelector(`[data-a="move-stop"][data-dir="${b.dataset.dir}"]:not(:disabled)`)?.focus({ preventScroll: true });
        return;
      }
      case 'add-note':
        draft.days[i].notes.push({ type: 'tip', title: '', text: '' });
        break;
      case 'del-note':
        draft.days[i].notes.splice(Number(b.dataset.k), 1);
        break;
      case 'toggle-dep': {
        const s = draft.days[i].stops[j];
        if (b.checked) s.departure = { buffer: 60 }; else delete s.departure;
        break;
      }
      case 'pick-place': {
        const s = draft.days[i].stops[j];
        const place = await openPlacePicker({ place: s.place, recent: recentPlaces().filter((p) => p !== s.place) });
        if (!place) return;
        s.place = place;
        errorStops.delete(`${i}.${j}`);
        break;
      }
      case 'cancel':
        if (changed && !(await ask('Discard your unsaved changes?', { ok: 'Discard', cancel: 'Keep editing', danger: true }))) return;
        changed = false;
        opts.onCancel();
        return;
      case 'delete':
        if (!(await ask(`Delete “${draft.title || 'this trip'}”?`, { detail: `It's deleted for everyone and members lose access. This can't be undone.`, ok: 'Delete trip', danger: true }))) return;
        changed = false;
        opts.onDelete();
        return;
      case 'reload-editor':
        if (changed && !(await ask('Load the latest version?', { detail: 'Your unsaved edits will be lost.', ok: 'Load latest', danger: true }))) return;
        changed = false;
        opts.onReload();
        return;
      case 'duplicate':
        opts.onDuplicate(structuredClone(draft));
        return;
      case 'cover-pick':
        el.querySelector('[data-cover-file]').click();
        return;
      case 'cover-remove':
        coverEdit = null;
        changed = true;
        renderCover();
        return;
      default:
        return;
    }
    changed = true;
    render();
  };

  // Warn before closing the tab with unsaved edits.
  window.onbeforeunload = () => (changed ? true : undefined);

  render();
  return {
    isDirty: () => changed,
    markClean: () => { changed = false; },
    dispose: () => { window.onbeforeunload = null; },
    // Shows a banner above the form without touching the user's unsaved edits.
    notice(html, offerReload = false) {
      noticeHtml = `${html} ${offerReload ? 'Saving now will warn before overwriting. <button type="button" class="mini" data-a="reload-editor">Load their version</button>' : ''}`;
      render();
    },
  };
}
