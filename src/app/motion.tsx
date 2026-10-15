// Screen transitions: moving deeper slides the new screen in from the right, going back from the
// left (styles in app.css → Motion). Lists rise in once per visit to a screen.
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { prefersReducedMotion } from '../lib/util';

// How deep each screen sits.
const DEPTH: Record<string, number> = { home: 0, account: 1, import: 1, trip: 1, edit: 2, members: 2, checklist: 2, expenses: 2 };
export const screenOf = (pathname: string): string => pathname.split('/')[1] || 'home';

export interface NavMotion {
  /** Changes with every screen change. */
  visit: number;
  /** null on the very first screen (already painted by index.html, so it doesn't slide). */
  dir: 'forward' | 'back' | null;
}

const Ctx = createContext<NavMotion>({ visit: 0, dir: null });
export const useNavMotion = (): NavMotion => useContext(Ctx);

export function NavMotionProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const screen = screenOf(pathname);
  const state = useRef<{ screen: string | null; motion: NavMotion }>({ screen: null, motion: { visit: 0, dir: null } });
  if (state.current.screen !== screen) {
    const prev = state.current.screen;
    state.current = {
      screen,
      motion: {
        visit: state.current.motion.visit + 1,
        dir: prev === null ? null : (DEPTH[screen] ?? 1) < (DEPTH[prev] ?? 1) ? 'back' : 'forward',
      },
    };
  }
  return <Ctx.Provider value={state.current.motion}>{children}</Ctx.Provider>;
}

/**
 * The class that plays the screen's entrance, decided once when the screen mounts and kept until
 * the slide has finished — so data arriving mid-slide (a redraw) can't cut the animation short.
 */
export function useEnterClass(): string {
  const { dir } = useNavMotion();
  const [cls, setCls] = useState(() => (dir && !prefersReducedMotion() ? `enter-${dir}` : ''));
  useEffect(() => {
    if (!cls) return undefined;
    const t = setTimeout(() => setCls(''), 700);
    return () => clearTimeout(t);
  }, [cls]);
  return cls;
}

/**
 * Lets a list's items rise in one after another — once per visit, when the real content first
 * appears. Uses the Web Animations API on the items present then, so later redraws never replay it.
 * Pass `ready` false while data is still loading.
 */
export function useReveal(ref: React.RefObject<HTMLElement>, selector: string, ready = true): void {
  const { visit } = useNavMotion();
  const done = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!ready || done.current === visit || prefersReducedMotion() || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(selector)];
    if (!items.length) return; // nothing loaded yet: wait for the real content
    done.current = visit;
    items.slice(0, 12).forEach((el, i) => el.animate(
      [{ opacity: 0, transform: 'translate3d(0, 16px, 0) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: 560, delay: 60 + i * 45, easing: 'cubic-bezier(.32, .72, 0, 1)', fill: 'backwards' },
    ));
  });
}

/**
 * For live lists (checklist, expenses): which items arrived after the list first appeared, so
 * just those can slide in. The first batch is left to useReveal.
 */
export function useNewItems(ids: string[] | null): (id: string) => boolean {
  const known = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  if (ids) {
    if (!known.current) known.current = new Set(ids);
    else for (const id of ids) if (!known.current.has(id)) { known.current.add(id); fresh.current.add(id); }
  }
  return (id) => fresh.current.has(id);
}

/**
 * Removing an item from a list: it slides away first, then `remove` runs. Returns the ids on
 * their way out (give them the 'leaving' class) and the function that starts it.
 */
export function useLeaving(): [Set<string>, (id: string, remove: () => Promise<unknown>) => Promise<void>] {
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set());
  const start = async (id: string, remove: () => Promise<unknown>) => {
    setLeaving((s) => new Set(s).add(id));
    await new Promise((r) => setTimeout(r, prefersReducedMotion() ? 0 : 220));
    try { await remove(); } finally {
      // Gone from the list now (or it failed and stays): either way it's no longer leaving.
      setLeaving((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };
  return [leaving, start];
}
