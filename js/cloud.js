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
    (snap) => cb(snap.exists() ? fromDoc(snap) : null),
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

export async function setMembers(user, id, emails) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), { memberEmails: emails, updatedAt: F.serverTimestamp(), updatedBy: user.email }));
}

export async function leaveTrip(user, id) {
  const { db, F } = await init();
  await commit(F.updateDoc(F.doc(db, 'trips', id), { memberEmails: F.arrayRemove(user.email), updatedAt: F.serverTimestamp(), updatedBy: user.email }));
}

export async function deleteTrip(id) {
  const { db, F } = await init();
  await commit(F.deleteDoc(F.doc(db, 'trips', id)));
}
