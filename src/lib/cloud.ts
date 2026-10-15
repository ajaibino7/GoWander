// Google sign-in and trip storage in Firestore. Access rules live in firestore.rules —
// the server enforces them, this file just calls the API. The Firebase SDK is loaded on first
// use (a separate download), so the first screen appears without waiting for it.
import type { Auth, User as FbUser } from 'firebase/auth';
import type { DocumentData, DocumentSnapshot, Firestore, Timestamp, Unsubscribe } from 'firebase/firestore';
import { firebaseConfig } from './firebase-config';
import { normalizeTrip } from './store';
import type {
  ChecklistItem, ChecklistList, DraftTrip, Expense, ExpenseInput, Role, Trip, TripEntry, User,
} from './types';

// Local development against the Firebase emulators: add ?emulator on localhost.
const useEmulator = new URLSearchParams(location.search).has('emulator') && ['localhost', '127.0.0.1'].includes(location.hostname);
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
  for (const sub of ['checklist', 'expenses']) {
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
    createdBy: String(d.createdBy || ''),
    createdMs: toMs(d.createdAt),
  };
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

// Pass expenseId to edit an existing expense.
export async function saveExpense(user: User, id: string, expense: ExpenseInput, expenseId: string | null = null): Promise<void> {
  const { db, F } = await init();
  const stamp = { updatedBy: user.email, updatedAt: F.serverTimestamp() };
  await commit(expenseId
    ? F.updateDoc(F.doc(db, 'trips', id, 'expenses', expenseId), { ...expense, ...stamp })
    : F.addDoc(F.collection(db, 'trips', id, 'expenses'), { ...expense, createdBy: user.email, createdAt: F.serverTimestamp(), ...stamp }));
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
