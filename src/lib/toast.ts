// Toaster — notifications and questions, instead of browser pop-ups. It lives outside the React
// tree (a fixed stack at the bottom of the page), so any code can call toast() or ask().

export type ToastKind = 'ok' | 'bad' | 'warn' | 'info';

const ICONS: Record<ToastKind | 'ask', string> = { ok: '✓', bad: '!', warn: '!', info: 'i', ask: '?' };
const MAX_TOASTS = 4;
let toaster: HTMLDivElement | null = null;
let pendingAsk: ((answer: boolean) => void) | null = null;

function toasterEl(): HTMLDivElement {
  if (!toaster) {
    toaster = document.createElement('div');
    toaster.className = 'toaster';
    toaster.setAttribute('aria-live', 'polite');
    document.body.appendChild(toaster);
  }
  return toaster;
}

function makeToast(kind: ToastKind | 'ask', { role = 'status', closable = true } = {}): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', role);
  el.innerHTML = `<span class="t-icon" aria-hidden="true">${ICONS[kind] || ICONS.info}</span><div class="t-body"></div>${closable ? '<button type="button" class="t-x" aria-label="Dismiss">✕</button>' : ''}`;
  const box = toasterEl();
  box.appendChild(el);
  // Keep the stack short: drop the oldest plain notifications first.
  const plain = [...box.querySelectorAll<HTMLElement>('.toast:not(.ask):not(.out)')];
  while (box.querySelectorAll('.toast:not(.out)').length > MAX_TOASTS && plain.length) dismiss(plain.shift());
  requestAnimationFrame(() => el.classList.add('in'));
  return el;
}

function dismiss(el: HTMLElement | undefined): void {
  if (!el || el.classList.contains('out')) return;
  el.classList.remove('in');
  el.classList.add('out');
  setTimeout(() => el.remove(), 220);
}

export interface ToastOptions {
  /** ms before it hides (0 = stays until dismissed). */
  duration?: number;
  /** Adds a button, e.g. "Reload". */
  action?: { label: string; onClick: () => void };
}

/** Shows a notification. Returns a function that dismisses it. */
export function toast(msg: string, kind: ToastKind = 'info', { duration, action }: ToastOptions = {}): () => void {
  const el = makeToast(kind, { role: kind === 'bad' ? 'alert' : 'status' });
  const body = el.querySelector('.t-body') as HTMLElement;
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
  (el.querySelector('.t-x') as HTMLButtonElement).onclick = () => dismiss(el);
  const ms = duration ?? (kind === 'bad' ? 6000 : action ? 8000 : 3500);
  let timer: ReturnType<typeof setTimeout> | null = ms ? setTimeout(() => dismiss(el), ms) : null;
  // Don't vanish while someone is reading or reaching for it.
  el.addEventListener('pointerenter', () => { if (timer) clearTimeout(timer); });
  el.addEventListener('pointerleave', () => { if (ms) timer = setTimeout(() => dismiss(el), 2000); });
  return () => dismiss(el);
}

export interface AskOptions { ok?: string; cancel?: string; danger?: boolean; detail?: string }

/**
 * Asks a question in a toast. Resolves true for the confirm button, false for cancel,
 * Escape, ✕, or when another question replaces it.
 *   await ask('Remove this stop?', { ok: 'Remove', danger: true })
 */
export function ask(message: string, { ok = 'OK', cancel = 'Cancel', danger = false, detail = '' }: AskOptions = {}): Promise<boolean> {
  pendingAsk?.(false);
  return new Promise((resolve) => {
    const el = makeToast('ask', { role: 'alertdialog' });
    el.classList.add('ask');
    if (danger) el.classList.add('danger');
    el.setAttribute('aria-label', message);
    const body = el.querySelector('.t-body') as HTMLElement;
    body.innerHTML = `
      <span class="t-msg"></span>
      ${detail ? '<span class="t-detail"></span>' : ''}
      <span class="t-actions">
        <button type="button" class="t-btn" data-r="0"></button>
        <button type="button" class="t-btn ${danger ? 'danger' : 'primary'}" data-r="1"></button>
      </span>`;
    (body.querySelector('.t-msg') as HTMLElement).textContent = message;
    if (detail) (body.querySelector('.t-detail') as HTMLElement).textContent = detail;
    (body.querySelector('[data-r="0"]') as HTMLElement).textContent = cancel;
    const okBtn = body.querySelector('[data-r="1"]') as HTMLButtonElement;
    okBtn.textContent = ok;

    const finish = (answer: boolean) => {
      if (pendingAsk !== finish) return;
      pendingAsk = null;
      document.removeEventListener('keydown', onKey, true);
      dismiss(el);
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    pendingAsk = finish;
    document.addEventListener('keydown', onKey, true);
    (el.querySelector('.t-x') as HTMLButtonElement).onclick = () => finish(false);
    body.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-r]');
      if (b) finish(b.dataset.r === '1');
    };
    setTimeout(() => okBtn.focus(), 50);
  });
}

/** Shows a link the user can copy by hand (fallback when the clipboard isn't available). */
export function toastLink(label: string, url: string): void {
  const el = makeToast('info');
  const body = el.querySelector('.t-body') as HTMLElement;
  body.innerHTML = '<span class="t-msg"></span><input class="t-input" readonly>';
  (body.querySelector('.t-msg') as HTMLElement).textContent = label;
  const input = body.querySelector('.t-input') as HTMLInputElement;
  input.value = url;
  input.onfocus = () => input.select();
  (el.querySelector('.t-x') as HTMLButtonElement).onclick = () => dismiss(el);
  setTimeout(() => input.focus(), 50);
}
