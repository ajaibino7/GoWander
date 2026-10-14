// Google sign-in and trip storage in Firestore. Access rules live in firestore.rules —
// the server enforces them, this file just calls the API.
import { firebaseConfig } from './firebase-config.js';
import { normalizeTrip } from './store.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

// Local development against the Firebase emulators: add ?emulator on localhost.
const useEmulator = new URLSearchParams(location.search).has('emulator') && ['localhost', '127.0.0.1'].includes(location.hostname);
export const available = () => useEmulator || !!(firebaseConfig.apiKey && firebaseConfig.projectId);
export const emulatorMode = useEmulator;

let fbP = null;
function init() {
  fbP ??= (async () => {
    const [appM, A, F] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const cfg = useEmulator ? { apiKey: 'demo-key', authDomain: 'demo-trips.firebaseapp.com', projectId: 'demo-trips', appId: 'demo' } : firebaseConfig;
    const app = appM.initializeApp(cfg);
    const auth = A.getAuth(app);
    let db;
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
const toUser = (u) => (u ? { uid: u.uid, email: (u.email || '').toLowerCase(), name: u.displayName || u.email, photo: u.photoURL || '' } : null);

// Calls cb(user|null) now and whenever sign-in changes.
export async function onUserChange(cb) {
  if (!available()) { cb(null); return; }
  try {
    const { auth, A } = await init();
    A.onAuthStateChanged(auth, (u) => cb(toUser(u)));
  } catch (e) {
    console.error('Firebase failed to load', e);
    cb(null);
  }
}

export async function signIn() {
  const { auth, A } = await init();
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await A.signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      throw new Error(e.code === 'auth/unauthorized-domain'
        ? 'This site isn\'t allowed to sign in yet. Add it under Firebase → Authentication → Settings → Authorized domains.'
        : `Sign-in failed (${e.code || e.message}).`);
    }
  }
}

// Signing out also wipes the offline copy, so the next person on this device can't read it.
export async function signOutUser() {
  const { auth, A, db, F } = await init();
  await A.signOut(auth);
  try { await F.terminate(db); await F.clearIndexedDbPersistence(db); } catch { /* best effort */ }
}

/* ============================================================
   Trips
   ============================================================ */
function fromDoc(snap) {
  const d = snap.data();
  if (!d) return null;
  let trip;
  try { trip = normalizeTrip({ ...d, id: snap.id, updatedAt: d.updatedAt?.toDate?.().toISOString() }); } catch { return null; }
  trip.id = snap.id;
  return {
    trip,
    meta: {
      ownerUid: d.ownerUid,
      ownerEmail: d.ownerEmail,
      memberEmails: Array.isArray(d.memberEmails) ? d.memberEmails : [],
      linkJoin: d.linkJoin === true,
      viewerEmails: Array.isArray(d.viewerEmails) ? d.viewerEmails : [], // view-only members
      linkRole: d.linkRole === 'view' ? 'view' : 'edit', // what people joining by link become
      updatedAtMs: d.updatedAt?.toMillis?.() ?? 0, // 0 while our own write is still pending
      updatedBy: d.updatedBy || '',
      pending: snap.metadata.hasPendingWrites,
    },
  };
}

const friendly = (e) => {
  if (e?.code === 'permission-denied') return 'You don\'t have permission to do that on this trip.';
  if (e?.code === 'unavailable') return 'You\'re offline — this will sync when you\'re back online.';
  return e?.message || 'Something went wrong.';
};

// Firestore only resolves writes once the server confirms them. Wait briefly so errors
// (e.g. permission denied) surface, but don't block when offline — the write is queued.
async function commit(promise) {
  let settled = false;
  const p = promise.then(() => { settled = true; }, (e) => { settled = true; throw e; });
  await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
  if (!settled) p.catch(() => {});
  else await p.catch((e) => { throw new Error(friendly(e)); });
}

const planFields = (trip) => {
  const t = normalizeTrip(trip);
  return { title: t.title, subtitle: t.subtitle, timezone: t.timezone, days: t.days };
};

export async function watchMyTrips(user, cb, onError) {
  const { db, F } = await init();
  const q = F.query(F.collection(db, 'trips'), F.where('memberEmails', 'array-contains', user.email));
  return F.onSnapshot(q, { includeMetadataChanges: true },
    (snap) => cb(snap.docs.map(fromDoc).filter(Boolean), { fromCache: snap.metadata.fromCache }),
    (e) => onError?.(friendly(e)));
}

export async function watchTrip(id, cb, onError) {
  const { db, F } = await init();
  return F.onSnapshot(F.doc(db, 'trips', id), { includeMetadataChanges: true },
    (snap) => {
      if (!snap.exists()) { cb(null); return; }
      const entry = fromDoc(snap);
      // A trip that exists but can't be parsed is an error, not a deletion.
      if (entry) cb(entry); else onError?.('This trip has data the app can\'t read.');
    },
    (e) => onError?.(e.code === 'permission-denied' ? 'denied' : friendly(e)));
}

export async function createTrip(user, trip) {
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
  constructor(by) { super('conflict'); this.by = by; }
}

// Saves the plan. If someone else saved since you opened the editor (baseMs), throws
// ConflictError unless force is set. Offline, the save is queued instead.
export async function updateTrip(user, id, trip, baseMs, { force = false } = {}) {
  const { db, F } = await init();
  const ref = F.doc(db, 'trips', id);
  const data = { ...planFields(trip), updatedAt: F.serverTimestamp(), updatedBy: user.email };
  if (!force && baseMs && navigator.onLine) {
    try {
      await Promise.race([
        F.runTransaction(db, async (tx) => {
          const cur = await tx.get(ref);
          if (!cur.exists()) throw Object.assign(new Error('This trip has been deleted.'), { code: 'gone' });
          const ms = cur.data().updatedAt?.toMillis?.() ?? 0;
          if (ms !== baseMs) throw new ConflictError(cur.data().updatedBy);
          tx.update(ref, data);
        }),
        new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), 8000)),
      ]);
      return;
    } catch (e) {
      if (e instanceof ConflictError) throw e;
      if (e.code === 'gone') throw e;
      if (e.code === 'permission-denied') throw new Error(friendly(e));
      // Network trouble: fall through and queue a normal write.
    }
  }
  await commit(F.updateDoc(ref, data));
}

// Owner only. viewers = the view-only members (kept to people still in the trip).
export async function setMembers(user, id, emails, viewers = []) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), {
    memberEmails: emails, viewerEmails: viewers.filter((v) => emails.includes(v)), updatedAt: F.serverTimestamp(), updatedBy: user.email,
  }));
}

// Owner only: 'view' makes a member view-only, 'edit' lets them change the plan.
export async function setRole(user, id, email, role) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), {
    viewerEmails: role === 'view' ? F.arrayUnion(email) : F.arrayRemove(email), updatedAt: F.serverTimestamp(), updatedBy: user.email,
  }));
}

// Owner only: what people who join with the link become.
export async function setLinkRole(user, id, role) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), { linkRole: role, updatedAt: F.serverTimestamp(), updatedBy: user.email }));
}

// Owner only: lets anyone who has the trip's link add themselves as a member.
export async function setLinkJoin(user, id, on) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), { linkJoin: on, updatedAt: F.serverTimestamp(), updatedBy: user.email }));
}

// Adds you to a trip you opened by link. The rules only allow it while the owner has link joining on.
export async function joinTrip(user, id) {
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
      if (e?.code !== 'permission-denied') throw e;
      await F.updateDoc(ref, { memberEmails: F.arrayUnion(user.email), viewerEmails: F.arrayUnion(user.email), ...stamp });
    }
  } catch (e) {
    if (e?.code === 'permission-denied') throw new Error('This trip isn\'t open to join by link, or it\'s full. Ask the owner to turn on “Anyone with the link can join”.');
    if (e?.code === 'not-found') throw new Error('This trip no longer exists.');
    throw new Error(friendly(e));
  }
}

export async function leaveTrip(user, id) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), {
    memberEmails: F.arrayRemove(user.email), viewerEmails: F.arrayRemove(user.email), updatedAt: F.serverTimestamp(), updatedBy: user.email,
  }));
}

export async function deleteTrip(id) {
  const { db, F } = await init();
  try { await commit(F.deleteDoc(progressRef(F, db, id))); } catch { /* no progress yet */ }
  try { await commit(F.deleteDoc(coverRef(F, db, id))); } catch { /* no cover */ }
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
const coverRef = (F, db, id) => F.doc(db, 'trips', id, 'media', 'cover');

// cb(dataUrl | null) now and whenever a member changes it.
export async function watchCover(id, cb) {
  const { db, F } = await init();
  return F.onSnapshot(coverRef(F, db, id), (snap) => cb(snap.data()?.data || null), () => cb(null));
}

// null removes it, so the trip goes back to the default artwork.
export async function setCover(user, id, dataUrl) {
  const { db, F } = await init();
  const ref = coverRef(F, db, id);
  await commit(dataUrl
    ? F.setDoc(ref, { data: dataUrl, updatedBy: user.email, updatedAt: F.serverTimestamp() })
    : F.deleteDoc(ref));
}

/* ============================================================
   Shared checklist (packing + to-dos) and expenses — one document per item, so members can
   add and tick things at the same time without overwriting each other. Both work offline:
   writes queue and sync when the signal comes back.
   ============================================================ */
const toMs = (ts) => ts?.toMillis?.() ?? Date.now(); // pending own writes have no server time yet

// cb([{ id, ...data, createdMs }]) now and on every change by any member.
export async function watchList(id, sub, cb, onError) {
  const { db, F } = await init();
  return F.onSnapshot(F.collection(db, 'trips', id, sub),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data(), createdMs: toMs(d.data().createdAt) }))),
    (e) => onError?.(friendly(e)));
}

// One-off read of a shared list (e.g. the checklist for the calendar export). Falls back to the
// offline copy when there's no signal, and gives up after a few seconds rather than hang.
export async function getList(id, sub) {
  const { db, F } = await init();
  const read = F.getDocs(F.collection(db, 'trips', id, sub)).then((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  return Promise.race([read, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
}

export async function addChecklistItem(user, id, list, text) {
  const { db, F } = await init();
  await commit(F.addDoc(F.collection(db, 'trips', id, 'checklist'), {
    text, list, done: false, doneBy: '',
    createdBy: user.email, createdAt: F.serverTimestamp(), updatedBy: user.email, updatedAt: F.serverTimestamp(),
  }));
}

export async function updateChecklistItem(user, id, itemId, fields) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id, 'checklist', itemId), { ...fields, updatedBy: user.email, updatedAt: F.serverTimestamp() }));
}

// expense: { title, amount, currency, paidBy, split, date, kind }. Pass expenseId to edit one.
export async function saveExpense(user, id, expense, expenseId = null) {
  const { db, F } = await init();
  const stamp = { updatedBy: user.email, updatedAt: F.serverTimestamp() };
  await commit(expenseId
    ? F.updateDoc(F.doc(db, 'trips', id, 'expenses', expenseId), { ...expense, ...stamp })
    : F.addDoc(F.collection(db, 'trips', id, 'expenses'), { ...expense, createdBy: user.email, createdAt: F.serverTimestamp(), ...stamp }));
}

export async function deleteListItem(id, sub, itemId) {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id, sub, itemId)));
}

/* ============================================================
   Shared progress — which stops members have marked done / skipped.
   Kept in trips/{id}/state/progress so ticking a stop never collides with plan edits.
   ============================================================ */
const progressRef = (F, db, id) => F.doc(db, 'trips', id, 'state', 'progress');

// cb(Map<stopId, email>) now and on every change by any member.
export async function watchProgress(id, cb) {
  const { db, F } = await init();
  return F.onSnapshot(progressRef(F, db, id),
    (snap) => cb(new Map(Object.entries(snap.data()?.done || {}))),
    () => cb(new Map()));
}

export async function setStopDone(user, id, stopId, on) {
  const { db, F } = await init();
  await commit(F.setDoc(progressRef(F, db, id), {
    done: { [stopId]: on ? user.email : F.deleteField() },
    updatedBy: user.email,
    updatedAt: F.serverTimestamp(),
  }, { merge: true }));
}
