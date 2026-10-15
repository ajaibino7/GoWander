// Google sign-in and trip storage in Firestore. Access rules live in firestore.rules —
// the server enforces them, this file just calls the API. The Firebase SDK is loaded on first
// use (a separate download), so the first screen appears without waiting for it.
import type { Auth, User as FbUser } from 'firebase/auth';
import type { DocumentData, DocumentSnapshot, Firestore, Timestamp, Unsubscribe } from 'firebase/firestore';
import { firebaseConfig } from './firebase-config';
import { normalizeTrip } from './store';
import type {
  Budget, ChecklistItem, ChecklistList, DraftTrip, Expense, ExpenseCategory, ExpenseInput, Idea, JournalEntry, MemberLocation,
  Place, Poll, PollOption, Profile, Reminder, Review, Role, Trip, TripEntry, User,
} from './types';

// Local development against the Firebase emulators: add ?emulator on localhost.
const useEmulator = new URLSearchParams(location.search).has('emulator') && ['localhost', '127.0.0.1'].includes(location.hostname);
// Development: Firebase can only be set up once per page, so editing this file reloads the page
// instead of swapping the module in place.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
export const available = (): boolean => useEmulator || !!(firebaseConfig.apiKey && firebaseConfig.projectId);
export const emulatorMode = useEmulator;

type AuthMod = typeof import('firebase/auth');
type FsMod = typeof import('firebase/firestore');
interface Fb { auth: Auth; db: Firestore; A: AuthMod; F: FsMod }

let fbP: Promise<Fb> | null = null;
function init(): Promise<Fb> {
  fbP ??= (async () => {
    const [appM, A, F] = await Promise.all([import('firebase/app'), import('firebase/auth'), import('firebase/firestore')]);
    const cfg = useEmulator ? { apiKey: 'demo-key', authDomain: 'demo-trips.firebaseapp.com', projectId: 'demo-trips', appId: 'demo' } : firebaseConfig;
    const app = appM.initializeApp(cfg);
    const auth = A.getAuth(app);
    let db: Firestore;
    try {
      // Keeps an offline copy so trips open (and edits queue) without signal.
      db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
    } catch {
      db = F.getFirestore(app);
    }
    if (useEmulator) {
      A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      F.connectFirestoreEmulator(db, '127.0.0.1', 8081);
    }
    return { auth, db, A, F };
  })();
  return fbP;
}

/* ============================================================
   Auth
   ============================================================ */
const toUser = (u: FbUser | null): User | null =>
  (u ? { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.displayName || u.email || '', photo: u.photoURL || '' } : null);

// Calls cb(user|null) now and whenever sign-in changes.
export async function onUserChange(cb: (u: User | null) => void): Promise<Unsubscribe | void> {
  if (!available()) { cb(null); return; }
  try {
    const { auth, A } = await init();
    return A.onAuthStateChanged(auth, (u) => cb(toUser(u)));
  } catch (e) {
    console.error('Firebase failed to load', e);
    cb(null);
  }
}

const codeOf = (e: unknown): string => (e as { code?: string } | null)?.code || '';
const messageOf = (e: unknown): string => (e as { message?: string } | null)?.message || '';

export async function signIn(): Promise<void> {
  const { auth, A } = await init();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    const code = codeOf(e);
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await A.signInWithRedirect(auth, provider);
    } else if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
      throw new Error(code === 'auth/unauthorized-domain'
        ? 'This site isn\'t allowed to sign in yet. Add it under Firebase → Authentication → Settings → Authorized domains.'
        : `Sign-in failed (${code || messageOf(e)}).`);
    }
  }
}

// Signing out also wipes the offline copy, so the next person on this device can't read it.
export async function signOutUser(): Promise<void> {
  const { auth, A, db, F } = await init();
  await A.signOut(auth);
  try { await F.terminate(db); await F.clearIndexedDbPersistence(db); } catch { /* best effort */ }
}

/* ============================================================
   Trips
   ============================================================ */
const ts = (v: unknown): Timestamp | undefined => (v && typeof (v as Timestamp).toMillis === 'function' ? (v as Timestamp) : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function fromDoc(snap: DocumentSnapshot<DocumentData>): TripEntry | null {
  const d = snap.data();
  if (!d) return null;
  let trip: Trip;
  try { trip = normalizeTrip({ ...d, id: snap.id, updatedAt: ts(d.updatedAt)?.toDate().toISOString() }); } catch { return null; }
  trip.id = snap.id;
  return {
    trip,
    meta: {
      ownerUid: String(d.ownerUid || ''),
      ownerEmail: String(d.ownerEmail || ''),
      memberEmails: strList(d.memberEmails),
      linkJoin: d.linkJoin === true,
      viewerEmails: strList(d.viewerEmails), // view-only members
      linkRole: d.linkRole === 'view' ? 'view' : 'edit', // what people joining by link become
      updatedAtMs: ts(d.updatedAt)?.toMillis() ?? 0, // 0 while our own write is still pending
      updatedBy: String(d.updatedBy || ''),
      pending: snap.metadata.hasPendingWrites,
    },
  };
}

const friendly = (e: unknown): string => {
  const code = codeOf(e);
  if (code === 'permission-denied') return 'You don\'t have permission to do that on this trip.';
  if (code === 'unavailable') return 'You\'re offline — this will sync when you\'re back online.';
  return messageOf(e) || 'Something went wrong.';
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Firestore only resolves writes once the server confirms them. Wait briefly so errors
// (e.g. permission denied) surface, but don't block when offline — the write is queued.
async function commit(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const p = promise.then(() => { settled = true; }, (e) => { settled = true; throw e; });
  try {
    await Promise.race([p, sleep(5000)]);
  } catch (e) {
    throw new Error(friendly(e));
  }
  if (!settled) p.catch(() => {});
}

const planFields = (trip: Trip | DraftTrip) => {
  const t = normalizeTrip(trip);
  return { title: t.title, subtitle: t.subtitle, timezone: t.timezone, days: t.days };
};

export async function watchMyTrips(
  user: User, cb: (list: TripEntry[], info: { fromCache: boolean }) => void, onError?: (msg: string) => void,
): Promise<Unsubscribe> {
  const { db, F } = await init();
  const q = F.query(F.collection(db, 'trips'), F.where('memberEmails', 'array-contains', user.email));
  return F.onSnapshot(q, { includeMetadataChanges: true },
    (snap) => cb(snap.docs.map(fromDoc).filter((x): x is TripEntry => !!x), { fromCache: snap.metadata.fromCache }),
    (e) => onError?.(friendly(e)));
}

/** onError receives 'denied' when you're not a member (the join screen), else a message. */
export async function watchTrip(id: string, cb: (entry: TripEntry | null) => void, onError?: (msg: string) => void): Promise<Unsubscribe> {
  const { db, F } = await init();
  return F.onSnapshot(F.doc(db, 'trips', id), { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) { cb(null); return; }
      const entry = fromDoc(snap);
      // A trip that exists but can't be parsed is an error, not a deletion.
      if (entry) cb(entry); else onError?.('This trip has data the app can\'t read.');
    },
    (e) => onError?.(codeOf(e) === 'permission-denied' ? 'denied' : friendly(e)));
}

export async function createTrip(user: User, trip: Trip | DraftTrip): Promise<string> {
  const { db, F } = await init();
  const ref = F.doc(F.collection(db, 'trips'));
  await commit(F.setDoc(ref, {
    ...planFields(trip),
    ownerUid: user.uid,
    ownerEmail: user.email,
    memberEmails: [user.email],
    createdAt: F.serverTimestamp(),
    updatedAt: F.serverTimestamp(),
    updatedBy: user.email,
  }));
  return ref.id;
}

export class ConflictError extends Error {
  constructor(public by: string) { super('conflict'); }
}

// Saves the plan. If someone else saved since you opened the editor (baseMs), throws
// ConflictError unless force is set. Offline, the save is queued instead.
export async function updateTrip(user: User, id: string, trip: DraftTrip, baseMs: number, { force = false } = {}): Promise<void> {
  const { db, F } = await init();
  const ref = F.doc(db, 'trips', id);
  const data = { ...planFields(trip), updatedAt: F.serverTimestamp(), updatedBy: user.email };
  if (!force && baseMs && navigator.onLine) {
    try {
      await Promise.race([
        F.runTransaction(db, async (tx) => {
          const cur = await tx.get(ref);
          if (!cur.exists()) throw Object.assign(new Error('This trip has been deleted.'), { code: 'gone' });
          const ms = ts(cur.data().updatedAt)?.toMillis() ?? 0;
          if (ms !== baseMs) throw new ConflictError(String(cur.data().updatedBy || ''));
          tx.update(ref, data);
        }),
        sleep(8000).then(() => { throw Object.assign(new Error('timeout'), { code: 'timeout' }); }),
      ]);
      return;
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      if (codeOf(e) === 'gone') throw e;
      if (codeOf(e) === 'permission-denied') throw new Error(friendly(e));
      // Network trouble: fall through and queue a normal write.
    }
  }
  await commit(F.updateDoc(ref, data));
}

// Owner only. viewers = the view-only members (kept to people still in the trip).
export async function setMembers(user: User, id: string, emails: string[], viewers: string[] = []): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), {
    memberEmails: emails, viewerEmails: viewers.filter((v) => emails.includes(v)), updatedAt: F.serverTimestamp(), updatedBy: user.email,
  }));
}

// Owner only: 'view' makes a member view-only, 'edit' lets them change the plan.
export async function setRole(user: User, id: string, email: string, role: Role): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), {
    viewerEmails: role === 'view' ? F.arrayUnion(email) : F.arrayRemove(email), updatedAt: F.serverTimestamp(), updatedBy: user.email,
  }));
}

// Owner only: what people who join with the link become.
export async function setLinkRole(user: User, id: string, role: Role): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), { linkRole: role, updatedAt: F.serverTimestamp(), updatedBy: user.email }));
}

// Owner only: lets anyone who has the trip's link add themselves as a member.
export async function setLinkJoin(user: User, id: string, on: boolean): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), { linkJoin: on, updatedAt: F.serverTimestamp(), updatedBy: user.email }));
}

// Adds you to a trip you opened by link. The rules only allow it while the owner has link joining on.
export async function joinTrip(user: User, id: string): Promise<void> {
  if (!navigator.onLine) throw new Error('You\'re offline. Connect to the internet to join this trip.');
  const { db, F } = await init();
  const ref = F.doc(db, 'trips', id);
  const stamp = { updatedAt: F.serverTimestamp(), updatedBy: user.email };
  try {
    // Someone outside the trip can't read whether link joiners can edit or only view, so try
    // joining as an editor first; if the owner chose view-only, join as a viewer instead.
    try {
      await F.updateDoc(ref, { memberEmails: F.arrayUnion(user.email), ...stamp });
    } catch (e) {
      if (codeOf(e) !== 'permission-denied') throw e;
      await F.updateDoc(ref, { memberEmails: F.arrayUnion(user.email), viewerEmails: F.arrayUnion(user.email), ...stamp });
    }
  } catch (e) {
    if (codeOf(e) === 'permission-denied') throw new Error('This trip isn\'t open to join by link, or it\'s full. Ask the owner to turn on “Anyone with the link can join”.');
    if (codeOf(e) === 'not-found') throw new Error('This trip no longer exists.');
    throw new Error(friendly(e));
  }
}

export async function leaveTrip(user: User, id: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), {
    memberEmails: F.arrayRemove(user.email), viewerEmails: F.arrayRemove(user.email), updatedAt: F.serverTimestamp(), updatedBy: user.email,
  }));
}

export async function deleteTrip(id: string): Promise<void> {
  const { db, F } = await init();
  try { await commit(F.deleteDoc(F.doc(db, 'trips', id, 'state', 'progress'))); } catch { /* no progress yet */ }
  try { await commit(F.deleteDoc(F.doc(db, 'trips', id, 'media', 'cover'))); } catch { /* no cover */ }
  // Firestore keeps a deleted document's subcollections, so clear the shared lists first.
  for (const sub of ['checklist', 'expenses', 'photos', 'ideas', 'polls', 'settings', 'profiles', 'locations', 'journal', 'reviews']) {
    try {
      const snap = await F.getDocs(F.collection(db, 'trips', id, sub));
      await Promise.all(snap.docs.map((d) => commit(F.deleteDoc(d.ref))));
    } catch { /* nothing there */ }
  }
  await commit(F.deleteDoc(F.doc(db, 'trips', id)));
}

/* ============================================================
   Cover photo — an optional image data URL in trips/{id}/media/cover, kept out of the trip
   document so the plan stays small and lists don't download photos.
   ============================================================ */
// cb(dataUrl | null) now and whenever a member changes it.
export async function watchCover(id: string, cb: (url: string | null) => void): Promise<Unsubscribe> {
  const { db, F } = await init();
  return F.onSnapshot(F.doc(db, 'trips', id, 'media', 'cover'),
    (snap) => { const v = snap.data()?.data; cb(typeof v === 'string' ? v : null); },
    () => cb(null));
}

// null removes it, so the trip goes back to the default artwork.
export async function setCover(user: User, id: string, dataUrl: string | null): Promise<void> {
  const { db, F } = await init();
  const ref = F.doc(db, 'trips', id, 'media', 'cover');
  await commit(dataUrl
    ? F.setDoc(ref, { data: dataUrl, updatedBy: user.email, updatedAt: F.serverTimestamp() })
    : F.deleteDoc(ref));
}

/* ============================================================
   Shared checklist (packing + to-dos) and expenses — one document per item, so members can
   add and tick things at the same time without overwriting each other. Both work offline:
   writes queue and sync when the signal comes back.
   ============================================================ */
const toMs = (v: unknown): number => ts(v)?.toMillis() ?? Date.now(); // pending own writes have no server time yet

function toChecklistItem(id: string, d: DocumentData): ChecklistItem {
  return {
    id,
    text: String(d.text || ''),
    list: d.list === 'todo' ? 'todo' : 'packing',
    done: d.done === true,
    doneBy: String(d.doneBy || ''),
    createdBy: String(d.createdBy || ''),
    createdMs: toMs(d.createdAt),
  };
}
function toExpense(id: string, d: DocumentData): Expense {
  return {
    id,
    title: String(d.title || ''),
    amount: Number(d.amount) || 0,
    currency: String(d.currency || 'INR'),
    paidBy: String(d.paidBy || ''),
    split: strList(d.split),
    date: String(d.date || ''),
    kind: d.kind === 'settlement' ? 'settlement' : 'expense',
    category: CATEGORIES.includes(d.category) ? d.category : undefined,
    shares: sharesOf(d.shares),
    hasBill: d.hasBill === true,
    createdBy: String(d.createdBy || ''),
    createdMs: toMs(d.createdAt),
  };
}
const CATEGORIES: ExpenseCategory[] = ['food', 'travel', 'stay', 'tickets', 'shopping', 'other'];
function sharesOf(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number' && n >= 0) out[k] = n;
  return Object.keys(out).length ? out : undefined;
}

export function watchChecklist(id: string, cb: (items: ChecklistItem[]) => void, onError?: (msg: string) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'checklist', (docs) => cb(docs.map(([k, d]) => toChecklistItem(k, d))), onError);
}
export function watchExpenses(id: string, cb: (items: Expense[]) => void, onError?: (msg: string) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'expenses', (docs) => cb(docs.map(([k, d]) => toExpense(k, d))), onError);
}
async function watchCollection(
  id: string, sub: string, cb: (docs: [string, DocumentData][]) => void, onError?: (msg: string) => void,
): Promise<Unsubscribe> {
  const { db, F } = await init();
  return F.onSnapshot(F.collection(db, 'trips', id, sub),
    (snap) => cb(snap.docs.map((d) => [d.id, d.data()])),
    (e) => onError?.(friendly(e)));
}

// One-off read of the checklist (e.g. for the calendar export). Falls back to the offline copy
// when there's no signal, and gives up after a few seconds rather than hang.
export async function getChecklist(id: string): Promise<ChecklistItem[]> {
  const { db, F } = await init();
  const read = F.getDocs(F.collection(db, 'trips', id, 'checklist')).then((snap) => snap.docs.map((d) => toChecklistItem(d.id, d.data())));
  return Promise.race([read, sleep(5000).then((): never => { throw new Error('timeout'); })]);
}

export async function addChecklistItem(user: User, id: string, list: ChecklistList, text: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.addDoc(F.collection(db, 'trips', id, 'checklist'), {
    text, list, done: false, doneBy: '',
    createdBy: user.email, createdAt: F.serverTimestamp(), updatedBy: user.email, updatedAt: F.serverTimestamp(),
  }));
}

export async function updateChecklistItem(user: User, id: string, itemId: string, fields: { done: boolean; doneBy: string }): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id, 'checklist', itemId), { ...fields, updatedBy: user.email, updatedAt: F.serverTimestamp() }));
}

// Pass expenseId to edit an existing expense. Resolves with the expense's id. Optional fields
// that are unset are removed (an expense switched back to an equal split loses its shares).
export async function saveExpense(user: User, id: string, expense: ExpenseInput, expenseId: string | null = null): Promise<string> {
  const { db, F } = await init();
  const stamp = { updatedBy: user.email, updatedAt: F.serverTimestamp() };
  const data: Record<string, any> = { ...expense, ...stamp }; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const k of ['category', 'shares', 'hasBill'] as const) if (expense[k] === undefined) data[k] = expenseId ? F.deleteField() : undefined;
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  if (expenseId) {
    await commit(F.updateDoc(F.doc(db, 'trips', id, 'expenses', expenseId), data));
    return expenseId;
  }
  const ref = F.doc(F.collection(db, 'trips', id, 'expenses'));
  await commit(F.setDoc(ref, { ...data, createdBy: user.email, createdAt: F.serverTimestamp() }));
  return ref.id;
}

export async function deleteListItem(id: string, sub: 'checklist' | 'expenses', itemId: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id, sub, itemId)));
}

/* ============================================================
   Shared progress — which stops members have marked done / skipped.
   Kept in trips/{id}/state/progress so ticking a stop never collides with plan edits.
   ============================================================ */
// cb(Map<stopId, email>) now and on every change by any member.
export async function watchProgress(id: string, cb: (doneBy: Map<string, string>) => void): Promise<Unsubscribe> {
  const { db, F } = await init();
  return F.onSnapshot(F.doc(db, 'trips', id, 'state', 'progress'),
    (snap) => {
      const done = snap.data()?.done;
      cb(new Map(Object.entries(done && typeof done === 'object' ? done as Record<string, string> : {})));
    },
    () => cb(new Map()));
}

export async function setStopDone(user: User, id: string, stopId: string, on: boolean): Promise<void> {
  const { db, F } = await init();
  await commit(F.setDoc(F.doc(db, 'trips', id, 'state', 'progress'), {
    done: { [stopId]: on ? user.email : F.deleteField() },
    updatedBy: user.email,
    updatedAt: F.serverTimestamp(),
  }, { merge: true }));
}

/* ============================================================
   Planning together, on the go, and memories — one small document per idea, poll, journal
   entry, review or location, so members never overwrite each other. All work offline.
   ============================================================ */
const placeOf = (v: unknown): Place | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { name: String(p.name || 'Pinned place').slice(0, 160), lat, lng, radius: Number(p.radius) || 300 };
};
const plainPlace = (p: Place | null) => (p ? { name: p.name, lat: p.lat, lng: p.lng, radius: p.radius } : null);

/* ---------- photos (bills, journal) ---------- */
export async function setPhoto(user: User, id: string, photoId: string, dataUrl: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.setDoc(F.doc(db, 'trips', id, 'photos', photoId), { data: dataUrl, createdBy: user.email, createdAt: F.serverTimestamp() }));
}
// One-off read (from the offline copy when there's no signal). null when there's none.
export async function getPhoto(id: string, photoId: string): Promise<string | null> {
  const { db, F } = await init();
  try {
    const snap = await F.getDoc(F.doc(db, 'trips', id, 'photos', photoId));
    const v = snap.data()?.data;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}
export async function deletePhoto(id: string, photoId: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id, 'photos', photoId)));
}

/* ---------- ideas board ---------- */
export function watchIdeas(id: string, cb: (items: Idea[]) => void, onError?: (msg: string) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'ideas', (docs) => cb(docs.map(([k, d]): Idea => ({
    id: k, title: String(d.title || ''), note: String(d.note || ''), place: placeOf(d.place), link: String(d.link || ''),
    likes: strList(d.likes), createdBy: String(d.createdBy || ''), createdMs: toMs(d.createdAt),
  }))), onError);
}
export async function saveIdea(user: User, id: string, idea: Pick<Idea, 'title' | 'note' | 'place' | 'link'>, ideaId: string | null = null): Promise<void> {
  const { db, F } = await init();
  const data = { title: idea.title, note: idea.note, place: plainPlace(idea.place), link: idea.link, updatedBy: user.email, updatedAt: F.serverTimestamp() };
  await commit(ideaId
    ? F.updateDoc(F.doc(db, 'trips', id, 'ideas', ideaId), data)
    : F.addDoc(F.collection(db, 'trips', id, 'ideas'), { ...data, likes: [], createdBy: user.email, createdAt: F.serverTimestamp() }));
}
export async function likeIdea(user: User, id: string, ideaId: string, on: boolean): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id, 'ideas', ideaId), {
    likes: on ? F.arrayUnion(user.email) : F.arrayRemove(user.email), updatedBy: user.email, updatedAt: F.serverTimestamp(),
  }));
}

/* ---------- polls ---------- */
export function watchPolls(id: string, cb: (items: Poll[]) => void, onError?: (msg: string) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'polls', (docs) => cb(docs.map(([k, d]): Poll => ({
    id: k,
    question: String(d.question || ''),
    options: (Array.isArray(d.options) ? d.options as Record<string, unknown>[] : [])
      .map((o): PollOption => ({ id: String(o.id || ''), text: String(o.text || ''), place: placeOf(o.place) })),
    votes: Object.fromEntries(Object.entries(d.votes && typeof d.votes === 'object' ? d.votes as Record<string, unknown> : {})
      .filter((e): e is [string, string] => typeof e[1] === 'string')),
    dayDate: String(d.dayDate || ''),
    closed: d.closed === true,
    createdBy: String(d.createdBy || ''),
    createdMs: toMs(d.createdAt),
  }))), onError);
}
export async function createPoll(user: User, id: string, poll: Pick<Poll, 'question' | 'options' | 'dayDate'>): Promise<void> {
  const { db, F } = await init();
  await commit(F.addDoc(F.collection(db, 'trips', id, 'polls'), {
    question: poll.question, options: poll.options.map((o) => ({ id: o.id, text: o.text, place: plainPlace(o.place) })), votes: {},
    dayDate: poll.dayDate, closed: false, createdBy: user.email, createdAt: F.serverTimestamp(), updatedBy: user.email, updatedAt: F.serverTimestamp(),
  }));
}
// optionId null takes your vote back. (A FieldPath, because emails contain dots.)
export async function votePoll(user: User, id: string, pollId: string, optionId: string | null): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id, 'polls', pollId),
    new F.FieldPath('votes', user.email), optionId ?? F.deleteField(),
    'updatedBy', user.email, 'updatedAt', F.serverTimestamp()));
}
export async function closePoll(user: User, id: string, pollId: string, closed: boolean): Promise<void> {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id, 'polls', pollId), { closed, updatedBy: user.email, updatedAt: F.serverTimestamp() }));
}

/* ---------- budget and UPI IDs ---------- */
export async function watchBudget(id: string, cb: (b: Budget | null) => void): Promise<Unsubscribe> {
  const { db, F } = await init();
  return F.onSnapshot(F.doc(db, 'trips', id, 'settings', 'budget'),
    (snap) => { const d = snap.data(); cb(d && typeof d.perPerson === 'number' ? { perPerson: d.perPerson, currency: String(d.currency || 'INR') } : null); },
    () => cb(null));
}
export async function setBudget(user: User, id: string, b: Budget | null): Promise<void> {
  const { db, F } = await init();
  const ref = F.doc(db, 'trips', id, 'settings', 'budget');
  await commit(b ? F.setDoc(ref, { ...b, updatedBy: user.email, updatedAt: F.serverTimestamp() }) : F.deleteDoc(ref));
}
export function watchProfiles(id: string, cb: (p: Map<string, Profile>) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'profiles', (docs) => cb(new Map(docs.map(([email, d]) => [email, { email, upi: String(d.upi || ''), nickname: String(d.nickname || '') }]))));
}
// Merged, so saving your nickname keeps your UPI ID and the other way round.
export async function setMyProfile(user: User, id: string, fields: { upi?: string; nickname?: string }): Promise<void> {
  const { db, F } = await init();
  await commit(F.setDoc(F.doc(db, 'trips', id, 'profiles', user.email), { ...fields, updatedAt: F.serverTimestamp() }, { merge: true }));
}

/* ---------- settle-up reminders ---------- */
const reminderId = (from: string, to: string) => `${from}__${to}`;
export function watchReminders(id: string, cb: (r: Reminder[]) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'reminders', (docs) => cb(docs.map(([, d]): Reminder => ({
    from: String(d.from || ''), to: String(d.to || ''), amount: Number(d.amount) || 0, currency: String(d.currency || 'INR'), atMs: toMs(d.createdAt),
  })).filter((r) => r.from && r.to && r.amount > 0)));
}
// Reminding the same person again replaces the last reminder (one per pair).
export async function sendReminder(user: User, id: string, to: string, amount: number, currency: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.setDoc(F.doc(db, 'trips', id, 'reminders', reminderId(user.email, to)), { from: user.email, to, amount, currency, createdAt: F.serverTimestamp() }));
}
export async function clearReminder(id: string, from: string, to: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id, 'reminders', reminderId(from, to))));
}

/* ---------- where's everyone ---------- */
export function watchLocations(id: string, cb: (l: MemberLocation[]) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'locations', (docs) => cb(docs.map(([email, d]): MemberLocation => ({
    email, lat: Number(d.lat), lng: Number(d.lng), accuracy: Number(d.accuracy) || 0, atMs: toMs(d.updatedAt), untilMs: Number(d.untilMs) || 0,
  })).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng))));
}
export async function shareLocation(user: User, id: string, pos: { lat: number; lng: number; accuracy?: number }, untilMs: number): Promise<void> {
  const { db, F } = await init();
  await commit(F.setDoc(F.doc(db, 'trips', id, 'locations', user.email), {
    lat: Number(pos.lat.toFixed(5)), lng: Number(pos.lng.toFixed(5)), accuracy: Math.round(pos.accuracy || 0), untilMs, updatedAt: F.serverTimestamp(),
  }));
}
export async function stopSharingLocation(user: User, id: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id, 'locations', user.email)));
}

/* ---------- journal ---------- */
export function watchJournal(id: string, cb: (items: JournalEntry[]) => void, onError?: (msg: string) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'journal', (docs) => cb(docs.map(([k, d]): JournalEntry => ({
    id: k, dayDate: String(d.dayDate || ''), stopId: String(d.stopId || ''), text: String(d.text || ''), hasPhoto: d.hasPhoto === true,
    createdBy: String(d.createdBy || ''), createdMs: toMs(d.createdAt),
  }))), onError);
}
// Resolves with the entry's id (new entries get one before saving, so a photo can go with it).
export async function saveJournal(user: User, id: string, e: Pick<JournalEntry, 'dayDate' | 'stopId' | 'text' | 'hasPhoto'>, entryId: string | null = null): Promise<string> {
  const { db, F } = await init();
  const data = { dayDate: e.dayDate, stopId: e.stopId, text: e.text, hasPhoto: e.hasPhoto, updatedAt: F.serverTimestamp() };
  if (entryId) {
    await commit(F.updateDoc(F.doc(db, 'trips', id, 'journal', entryId), data));
    return entryId;
  }
  const ref = F.doc(F.collection(db, 'trips', id, 'journal'));
  await commit(F.setDoc(ref, { ...data, createdBy: user.email, createdAt: F.serverTimestamp() }));
  return ref.id;
}

/* ---------- reviews ---------- */
export function watchReviews(id: string, cb: (items: Review[]) => void): Promise<Unsubscribe> {
  return watchCollection(id, 'reviews', (docs) => cb(docs.map(([, d]): Review => ({
    stopId: String(d.stopId || ''), email: String(d.email || ''), vote: d.vote === -1 ? -1 : 1, note: String(d.note || ''),
  }))));
}
// vote null removes your review.
export async function setReview(user: User, id: string, stopId: string, vote: 1 | -1 | null, note = ''): Promise<void> {
  const { db, F } = await init();
  const ref = F.doc(db, 'trips', id, 'reviews', `${stopId}__${user.email}`);
  await commit(vote ? F.setDoc(ref, { stopId, email: user.email, vote, note, updatedAt: F.serverTimestamp() }) : F.deleteDoc(ref));
}

/** Removes an idea, poll or journal entry. */
export async function deleteSubDoc(id: string, sub: 'ideas' | 'polls' | 'journal', docId: string): Promise<void> {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id, sub, docId)));
}
