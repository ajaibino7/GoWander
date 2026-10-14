// Security rules tests. Run with:  npm run test:rules   (needs Java for the Firestore emulator)
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp, arrayRemove, arrayUnion,
} from 'firebase/firestore';

const OWNER = { uid: 'owner-uid', email: 'owner@gmail.com' };
const FRIEND = { uid: 'friend-uid', email: 'friend@gmail.com' };
const STRANGER = { uid: 'stranger-uid', email: 'stranger@gmail.com' };

let env;
const db = (u, provider = 'google.com') =>
  env.authenticatedContext(u.uid, { email: u.email, firebase: { sign_in_provider: provider } }).firestore();
const plan = { title: 'Goa', subtitle: '', timezone: 'Asia/Kolkata', days: [] };
const newTrip = (u, extra = {}) => ({
  ...plan, ownerUid: u.uid, ownerEmail: u.email, memberEmails: [u.email],
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: u.email, ...extra,
});
const stamp = (u) => ({ updatedAt: serverTimestamp(), updatedBy: u.email });
const trip = (u) => doc(db(u), 'trips', 't1');

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-trips',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8081 },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await setDoc(trip(OWNER), newTrip(OWNER));
});
const addFriend = () => updateDoc(trip(OWNER), { memberEmails: [OWNER.email, FRIEND.email], ...stamp(OWNER) });

/* ---------- creating ---------- */
test('owner can create a trip with only themselves as member', async () => {
  await assertSucceeds(setDoc(doc(db(OWNER), 'trips', 't2'), newTrip(OWNER)));
});
test('cannot create a trip owned by someone else', async () => {
  await assertFails(setDoc(doc(db(STRANGER), 'trips', 't2'), newTrip(OWNER)));
});
test('cannot create a trip that already includes other members', async () => {
  await assertFails(setDoc(doc(db(OWNER), 'trips', 't2'), newTrip(OWNER, { memberEmails: [OWNER.email, FRIEND.email] })));
});
test('non-Google sign-in cannot create trips', async () => {
  await assertFails(setDoc(doc(db(OWNER, 'password'), 'trips', 't2'), newTrip(OWNER)));
});
test('signed-out users cannot create trips', async () => {
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'trips', 't2'), newTrip(OWNER)));
});
test('unknown fields are rejected', async () => {
  await assertFails(setDoc(doc(db(OWNER), 'trips', 't2'), newTrip(OWNER, { isAdmin: true })));
});

/* ---------- reading ---------- */
test('strangers cannot read a trip', async () => {
  await assertFails(getDoc(trip(STRANGER)));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'trips', 't1')));
});
test('a collaborator can read once added', async () => {
  await assertFails(getDoc(trip(FRIEND)));
  await assertSucceeds(addFriend());
  await assertSucceeds(getDoc(trip(FRIEND)));
});
test('listing only works for trips you are a member of', async () => {
  await assertSucceeds(getDocs(query(collection(db(OWNER), 'trips'), where('memberEmails', 'array-contains', OWNER.email))));
  await assertFails(getDocs(collection(db(STRANGER), 'trips')));
  await assertFails(getDocs(query(collection(db(STRANGER), 'trips'), where('memberEmails', 'array-contains', OWNER.email))));
});

/* ---------- editing ---------- */
test('a collaborator can edit the plan', async () => {
  await addFriend();
  await assertSucceeds(updateDoc(trip(FRIEND), { title: 'Goa (updated)', ...stamp(FRIEND) }));
});
test('strangers cannot edit', async () => {
  await assertFails(updateDoc(trip(STRANGER), { title: 'hacked', ...stamp(STRANGER) }));
});
test('edits must be stamped with your own email', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(FRIEND), { title: 'x', updatedAt: serverTimestamp(), updatedBy: OWNER.email }));
});
test('a collaborator cannot add other people', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(FRIEND), { memberEmails: [OWNER.email, FRIEND.email, STRANGER.email], ...stamp(FRIEND) }));
});
test('a collaborator cannot take ownership', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(FRIEND), { ownerUid: FRIEND.uid, ownerEmail: FRIEND.email, ...stamp(FRIEND) }));
});
test('a collaborator cannot remove the owner', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(FRIEND), { memberEmails: [FRIEND.email], ...stamp(FRIEND) }));
});

/* ---------- membership ---------- */
test('a collaborator can leave, and then loses access', async () => {
  await addFriend();
  await assertSucceeds(updateDoc(trip(FRIEND), { memberEmails: arrayRemove(FRIEND.email), ...stamp(FRIEND) }));
  await assertFails(getDoc(trip(FRIEND)));
});
test('the owner can remove a collaborator', async () => {
  await addFriend();
  await assertSucceeds(updateDoc(trip(OWNER), { memberEmails: [OWNER.email], ...stamp(OWNER) }));
  await assertFails(getDoc(trip(FRIEND)));
});
test('the owner cannot remove themselves', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(OWNER), { memberEmails: [FRIEND.email], ...stamp(OWNER) }));
});

/* ---------- joining by link ---------- */
const linkOn = () => updateDoc(trip(OWNER), { linkJoin: true, ...stamp(OWNER) });
const join = (u) => updateDoc(trip(u), { memberEmails: arrayUnion(u.email), ...stamp(u) });

test('nobody can join by link until the owner turns it on', async () => {
  await assertFails(join(STRANGER));
  await assertSucceeds(linkOn());
  await assertSucceeds(join(STRANGER));
  await assertSucceeds(getDoc(trip(STRANGER)));
});
test('joining by link adds only yourself and changes nothing else', async () => {
  await addFriend();
  await linkOn();
  await assertFails(updateDoc(trip(STRANGER), { memberEmails: arrayUnion(STRANGER.email, 'other@gmail.com'), ...stamp(STRANGER) }));
  await assertFails(updateDoc(trip(STRANGER), { memberEmails: arrayUnion(STRANGER.email), title: 'mine now', ...stamp(STRANGER) }));
  await assertFails(updateDoc(trip(STRANGER), { memberEmails: [OWNER.email, STRANGER.email], ...stamp(STRANGER) })); // drops FRIEND
  await assertFails(updateDoc(trip(STRANGER), { memberEmails: arrayUnion(STRANGER.email), updatedAt: serverTimestamp(), updatedBy: OWNER.email }));
});
test('signed-out or non-Google users cannot join by link', async () => {
  await linkOn();
  await assertFails(updateDoc(doc(db(STRANGER, 'password'), 'trips', 't1'), { memberEmails: arrayUnion(STRANGER.email), ...stamp(STRANGER) }));
  await assertFails(updateDoc(doc(env.unauthenticatedContext().firestore(), 'trips', 't1'), { memberEmails: arrayUnion(STRANGER.email) }));
});
test('only the owner can turn link joining on or off', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(FRIEND), { linkJoin: true, ...stamp(FRIEND) }));
  await assertSucceeds(linkOn());
  await assertFails(updateDoc(trip(FRIEND), { linkJoin: false, ...stamp(FRIEND) }));
  await assertSucceeds(updateDoc(trip(OWNER), { linkJoin: false, ...stamp(OWNER) }));
  await assertFails(join(STRANGER));
});
test('link joining must be true or false', async () => {
  await assertFails(updateDoc(trip(OWNER), { linkJoin: 'yes', ...stamp(OWNER) }));
});
test('members can still edit the plan while link joining is on', async () => {
  await addFriend();
  await linkOn();
  await assertSucceeds(updateDoc(trip(FRIEND), { title: 'Goa 2', ...stamp(FRIEND) }));
});

/* ---------- shared progress (done / skipped stops) ---------- */
const progress = (u) => doc(db(u), 'trips', 't1', 'state', 'progress');
const tick = (u, done = { s1: u.email }) => setDoc(progress(u), { done, ...stamp(u) }, { merge: true });

test('members can tick stops and everyone in the trip sees it', async () => {
  await addFriend();
  await assertSucceeds(tick(FRIEND));
  await assertSucceeds(getDoc(progress(OWNER)));
  await assertSucceeds(tick(OWNER, { s2: OWNER.email }));
});
test('strangers cannot read or change progress', async () => {
  await tick(OWNER);
  await assertFails(getDoc(progress(STRANGER)));
  await assertFails(tick(STRANGER));
});
test('progress must be stamped with your own email and has no extra fields', async () => {
  await addFriend();
  await assertFails(setDoc(progress(FRIEND), { done: {}, updatedAt: serverTimestamp(), updatedBy: OWNER.email }));
  await assertFails(setDoc(progress(FRIEND), { done: {}, junk: 1, ...stamp(FRIEND) }));
});
test('only the progress document is writable', async () => {
  await assertFails(setDoc(doc(db(OWNER), 'trips', 't1', 'state', 'other'), { done: {}, ...stamp(OWNER) }));
});
test('a removed member loses access to progress', async () => {
  await addFriend();
  await tick(FRIEND);
  await updateDoc(trip(OWNER), { memberEmails: [OWNER.email], ...stamp(OWNER) });
  await assertFails(getDoc(progress(FRIEND)));
  await assertFails(tick(FRIEND));
});

/* ---------- cover image ---------- */
const cover = (u) => doc(db(u), 'trips', 't1', 'media', 'cover');
const img = (n = 1000) => `data:image/jpeg;base64,${'A'.repeat(n)}`;
const setCover = (u, data = img()) => setDoc(cover(u), { data, ...stamp(u) });

test('members can set, read and remove the cover', async () => {
  await addFriend();
  await assertSucceeds(setCover(FRIEND));
  await assertSucceeds(getDoc(cover(OWNER)));
  await assertSucceeds(setCover(OWNER, img(2000)));
  await assertSucceeds(deleteDoc(cover(FRIEND)));
});
test('strangers cannot see or change the cover', async () => {
  await setCover(OWNER);
  await assertFails(getDoc(cover(STRANGER)));
  await assertFails(setCover(STRANGER));
  await assertFails(deleteDoc(cover(STRANGER)));
});
test('a near-500 KB cover is allowed, anything bigger is not', async () => {
  await assertSucceeds(setCover(OWNER, img(683000)));
  await assertFails(setCover(OWNER, img(700001)));
});
test('the cover must be an image data URL with nothing extra', async () => {
  await assertFails(setCover(OWNER, 'https://example.com/x.jpg'));
  await assertFails(setCover(OWNER, 'data:text/html;base64,PHNjcmlwdD4='));
  await assertFails(setDoc(cover(OWNER), { data: img(), junk: 1, ...stamp(OWNER) }));
  await assertFails(setDoc(doc(db(OWNER), 'trips', 't1', 'media', 'other'), { data: img(), ...stamp(OWNER) }));
});

/* ---------- deleting ---------- */
test('only the owner can delete a trip', async () => {
  await addFriend();
  await assertFails(deleteDoc(trip(FRIEND)));
  await assertFails(deleteDoc(trip(STRANGER)));
  await assertSucceeds(deleteDoc(trip(OWNER)));
});
