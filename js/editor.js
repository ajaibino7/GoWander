// Trip editor: trip details, days, stops (with locations), notes, and fixed departures.
import { esc, KIND_LABELS, TAG_LABELS, NOTE_LABELS, toMin, fromMin, addDays, weekdayOf, makeClock, DEFAULT_TZ } from './util.js';
import { openPlacePicker } from './placepicker.js';

const TIMEZONES = (() => {
  try { return Intl.supportedValuesOf('timeZone'); } catch {
    return ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
  }
})();

const blankStop = (start = '09:00') => ({ start, end: fromMin(toMin(start) + 60), kind: 'stop', title: '', note: '', place: null });

function getPath(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

/**
 * opts: { isNew, canDelete, onSave(trip) → false if cancelled, onCancel(), onDelete(), onDuplicate(trip) }
 */
export function mountEditor(el, trip, opts) {
  const draft = structuredClone(trip);
  for (const d of draft.days) { d.stops ??= []; d.notes ??= []; }
  let errors = [];
  let errorStops = new Set();
  let changed = false;

  const tzToday = () => makeClock(draft.timezone || DEFAULT_TZ).dateKey(new Date());

  function stopHtml(s, i, j) {
    const p = `days.${i}.stops.${j}`;
    const bad = errorStops.has(`${i}.${j}`);
    return `
      <div class="ed-stop${bad ? ' err' : ''}" id="stop-${i}-${j}">
        <div class="ed-row">
          <input type="time" class="t" data-f="${p}.start" value="${esc(s.start)}" aria-label="Start time" required>
          <span class="dash">–</span>
          <input type="time" class="t" data-f="${p}.end" value="${esc(s.end)}" aria-label="End time" required>
          <select data-f="${p}.kind" aria-label="Type">${Object.entries(KIND_LABELS).map(([k, v]) => `<option value="${k}"${s.kind === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
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
        <div class="ed-stops">${d.stops.map((s, j) => stopHtml(s, i, j)).join('') || '<div class="muted small">No stops yet.</div>'}</div>
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
        ${errors.length ? `<div class="ed-errors" id="ed-errors" role="alert"><strong>Fix these before saving:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
        <section class="ed-card">
          <label class="fld"><span>Trip name</span><input data-f="title" value="${esc(draft.title)}" maxlength="120" placeholder="e.g. Goa long weekend" required></label>
          <label class="fld"><span>Short description</span><input data-f="subtitle" value="${esc(draft.subtitle || '')}" maxlength="300" placeholder="Optional one-liner shown on the trip card"></label>
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
  el.oninput = (e) => {
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
      if ((await opts.onSave(draft)) === false) changed = true; // cancelled (e.g. after a conflict)
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
        if (draft.days[i].stops.length && !confirm(`Remove Day ${i + 1} and its ${draft.days[i].stops.length} stop(s)?`)) return;
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
        if (changed && !confirm('Discard your unsaved changes?')) return;
        changed = false;
        opts.onCancel();
        return;
      case 'delete':
        if (!confirm(`Delete “${draft.title || 'this trip'}” for everyone? Members lose access too. This can't be undone.`)) return;
        changed = false;
        opts.onDelete();
        return;
      case 'duplicate':
        opts.onDuplicate(structuredClone(draft));
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
  return { isDirty: () => changed, dispose: () => { window.onbeforeunload = null; } };
}
