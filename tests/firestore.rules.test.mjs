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
    // Its own project, so running these never wipes the app's own emulator data (demo-trips).
    projectId: 'demo-rules-test',
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

/* ---------- roles: view-only members ---------- */
const makeViewer = () => updateDoc(trip(OWNER), { memberEmails: [OWNER.email, FRIEND.email], viewerEmails: [FRIEND.email], ...stamp(OWNER) });

test('the owner can make a member view-only and back', async () => {
  await addFriend();
  await assertSucceeds(updateDoc(trip(OWNER), { viewerEmails: [FRIEND.email], ...stamp(OWNER) }));
  await assertSucceeds(updateDoc(trip(OWNER), { viewerEmails: [], ...stamp(OWNER) }));
});
test('a view-only member can read but not edit the plan', async () => {
  await makeViewer();
  await assertSucceeds(getDoc(trip(FRIEND)));
  await assertFails(updateDoc(trip(FRIEND), { title: 'changed', ...stamp(FRIEND) }));
});
test('a view-only member cannot make themselves an editor', async () => {
  await makeViewer();
  await assertFails(updateDoc(trip(FRIEND), { viewerEmails: [], ...stamp(FRIEND) }));
});
test('editors cannot change roles or link settings', async () => {
  await updateDoc(trip(OWNER), { memberEmails: [OWNER.email, FRIEND.email, STRANGER.email], viewerEmails: [STRANGER.email], ...stamp(OWNER) });
  await assertFails(updateDoc(trip(FRIEND), { viewerEmails: [], ...stamp(FRIEND) }));
  await assertFails(updateDoc(trip(FRIEND), { linkRole: 'view', ...stamp(FRIEND) }));
});
test('only members can be view-only, and never the owner', async () => {
  await addFriend();
  await assertFails(updateDoc(trip(OWNER), { viewerEmails: [STRANGER.email], ...stamp(OWNER) }));
  await assertFails(updateDoc(trip(OWNER), { viewerEmails: [OWNER.email], ...stamp(OWNER) }));
  await assertFails(updateDoc(trip(OWNER), { linkRole: 'admin', ...stamp(OWNER) }));
});
test('a view-only member can still tick stops, use the checklist and log expenses', async () => {
  await makeViewer();
  await assertSucceeds(tick(FRIEND));
  await assertSucceeds(setDoc(doc(db(FRIEND), 'trips', 't1', 'checklist', 'v1'), { text: 'Hat', list: 'packing', done: false, doneBy: '', createdBy: FRIEND.email, createdAt: serverTimestamp(), ...stamp(FRIEND) }));
  await assertSucceeds(setDoc(doc(db(FRIEND), 'trips', 't1', 'expenses', 'v1'), {
    title: 'Snacks', amount: 200, currency: 'INR', paidBy: FRIEND.email, split: [OWNER.email, FRIEND.email], date: '2026-10-17', kind: 'expense',
    createdBy: FRIEND.email, createdAt: serverTimestamp(), ...stamp(FRIEND),
  }));
});
test('a view-only member cannot change the cover', async () => {
  await makeViewer();
  await assertFails(setDoc(doc(db(FRIEND), 'trips', 't1', 'media', 'cover'), { data: 'data:image/jpeg;base64,AAAA', ...stamp(FRIEND) }));
  await assertSucceeds(setDoc(doc(db(OWNER), 'trips', 't1', 'media', 'cover'), { data: 'data:image/jpeg;base64,AAAA', ...stamp(OWNER) }));
  await assertFails(deleteDoc(doc(db(FRIEND), 'trips', 't1', 'media', 'cover')));
});
test('a view-only member can leave, and leaves the viewer list too', async () => {
  await makeViewer();
  await assertFails(updateDoc(trip(FRIEND), { memberEmails: arrayRemove(FRIEND.email), ...stamp(FRIEND) })); // still listed as viewer
  await assertSucceeds(updateDoc(trip(FRIEND), { memberEmails: arrayRemove(FRIEND.email), viewerEmails: arrayRemove(FRIEND.email), ...stamp(FRIEND) }));
  await assertFails(getDoc(trip(FRIEND)));
});
test('strangers cannot touch a trip by pretending to leave it', async () => {
  await assertFails(updateDoc(trip(STRANGER), { ...stamp(STRANGER) }));
});
test('link joiners become view-only when the owner chose that', async () => {
  await updateDoc(trip(OWNER), { linkJoin: true, linkRole: 'view', ...stamp(OWNER) });
  await assertFails(join(STRANGER)); // must add themselves to the viewers as well
  await assertSucceeds(updateDoc(trip(STRANGER), { memberEmails: arrayUnion(STRANGER.email), viewerEmails: arrayUnion(STRANGER.email), ...stamp(STRANGER) }));
  await assertFails(updateDoc(trip(STRANGER), { title: 'mine', ...stamp(STRANGER) }));
});
test('link joiners cannot pick view-only access the owner did not choose', async () => {
  await updateDoc(trip(OWNER), { linkJoin: true, ...stamp(OWNER) });
  await assertFails(updateDoc(trip(STRANGER), { memberEmails: arrayUnion(STRANGER.email), viewerEmails: arrayUnion(STRANGER.email), ...stamp(STRANGER) }));
  await assertSucceeds(join(STRANGER));
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

/* ---------- shared checklist ---------- */
const item = (u, id = 'i1') => doc(db(u), 'trips', 't1', 'checklist', id);
const newItem = (u, extra = {}) => ({ text: 'Sunscreen', list: 'packing', done: false, doneBy: '', createdBy: u.email, createdAt: serverTimestamp(), ...stamp(u), ...extra });

test('members can add, tick and remove checklist items', async () => {
  await addFriend();
  await assertSucceeds(setDoc(item(FRIEND), newItem(FRIEND)));
  await assertSucceeds(getDoc(item(OWNER)));
  await assertSucceeds(updateDoc(item(OWNER), { done: true, doneBy: OWNER.email, ...stamp(OWNER) }));
  await assertSucceeds(deleteDoc(item(OWNER)));
});
test('strangers cannot see or change the checklist', async () => {
  await setDoc(item(OWNER), newItem(OWNER));
  await assertFails(getDoc(item(STRANGER)));
  await assertFails(setDoc(item(STRANGER, 'i2'), newItem(STRANGER)));
  await assertFails(updateDoc(item(STRANGER), { done: true, ...stamp(STRANGER) }));
});
test('checklist items are validated and keep their author', async () => {
  await addFriend();
  await assertFails(setDoc(item(OWNER), newItem(OWNER, { list: 'shopping' })));
  await assertFails(setDoc(item(OWNER), newItem(OWNER, { text: '' })));
  await assertFails(setDoc(item(OWNER), newItem(OWNER, { createdBy: FRIEND.email })));
  await setDoc(item(OWNER), newItem(OWNER));
  await assertFails(updateDoc(item(FRIEND), { createdBy: FRIEND.email, ...stamp(FRIEND) }));
});

/* ---------- shared expenses ---------- */
const exp = (u, id = 'e1') => doc(db(u), 'trips', 't1', 'expenses', id);
const newExp = (u, extra = {}) => ({
  title: 'Dinner', amount: 1200, currency: 'INR', paidBy: u.email, split: [OWNER.email, FRIEND.email], date: '2026-10-17', kind: 'expense',
  createdBy: u.email, createdAt: serverTimestamp(), ...stamp(u), ...extra,
});

test('members can log, edit and delete expenses', async () => {
  await addFriend();
  await assertSucceeds(setDoc(exp(FRIEND), newExp(FRIEND)));
  await assertSucceeds(getDoc(exp(OWNER)));
  await assertSucceeds(updateDoc(exp(OWNER), { amount: 1500, ...stamp(OWNER) }));
  await assertSucceeds(setDoc(exp(OWNER, 'e2'), newExp(OWNER, { title: 'Paid back', kind: 'settlement', paidBy: OWNER.email, split: [FRIEND.email] })));
  await assertSucceeds(deleteDoc(exp(OWNER)));
});
test('strangers cannot see or log expenses', async () => {
  await addFriend();
  await setDoc(exp(OWNER), newExp(OWNER));
  await assertFails(getDoc(exp(STRANGER)));
  await assertFails(setDoc(exp(STRANGER, 'e2'), newExp(STRANGER, { paidBy: OWNER.email })));
});
test('payer and split must be trip members, and amounts must be sensible', async () => {
  await addFriend();
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { paidBy: STRANGER.email })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { split: [OWNER.email, STRANGER.email] })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { split: [] })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { amount: 0 })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { amount: '100' })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { currency: 'rupees' })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { kind: 'gift' })));
  await assertFails(setDoc(exp(OWNER), newExp(OWNER, { junk: 1 })));
});

test('expenses can have a category, a split by amount and a bill photo flag', async () => {
  await addFriend();
  await assertSucceeds(setDoc(exp(OWNER), newExp(OWNER, { category: 'food', shares: { [OWNER.email]: 800, [FRIEND.email]: 400 }, hasBill: true })));
  await assertFails(setDoc(exp(OWNER, 'e2'), newExp(OWNER, { category: 'gifts' })));
  await assertFails(setDoc(exp(OWNER, 'e3'), newExp(OWNER, { shares: { [STRANGER.email]: 1200 } })));
  await assertFails(setDoc(exp(OWNER, 'e4'), newExp(OWNER, { hasBill: 'yes' })));
});

/* ---------- photos (bills, journal) ---------- */
const photo = (u, id = 'bill-e1') => doc(db(u), 'trips', 't1', 'photos', id);
const newPhoto = (u, data = img()) => ({ data, createdBy: u.email, createdAt: serverTimestamp() });

test('members store, read and remove photos; strangers cannot', async () => {
  await addFriend();
  await assertSucceeds(setDoc(photo(FRIEND), newPhoto(FRIEND)));
  await assertSucceeds(getDoc(photo(OWNER)));
  await assertFails(getDoc(photo(STRANGER)));
  await assertFails(setDoc(photo(STRANGER, 'j-x'), newPhoto(STRANGER)));
  await assertSucceeds(deleteDoc(photo(OWNER)));
});
test('photos must be small images with a known id', async () => {
  await assertFails(setDoc(photo(OWNER), newPhoto(OWNER, img(420001))));
  await assertFails(setDoc(photo(OWNER), newPhoto(OWNER, 'data:text/html;base64,PHNjcmlwdD4=')));
  await assertFails(setDoc(photo(OWNER, 'avatar'), newPhoto(OWNER)));
  await assertFails(setDoc(photo(OWNER), { ...newPhoto(OWNER), createdBy: FRIEND.email }));
});

/* ---------- ideas board ---------- */
const idea = (u, id = 'd1') => doc(db(u), 'trips', 't1', 'ideas', id);
const newIdea = (u, extra = {}) => ({ title: 'Chapora Fort', note: '', place: null, link: '', likes: [], createdBy: u.email, createdAt: serverTimestamp(), ...stamp(u), ...extra });

test('members add ideas and like them, changing only their own like', async () => {
  await makeViewer(); // a view-only member still shares ideas
  await assertSucceeds(setDoc(idea(FRIEND, 'd2'), newIdea(FRIEND)));
  await setDoc(idea(OWNER), newIdea(OWNER, { likes: [] }));
  await assertSucceeds(updateDoc(idea(OWNER), { likes: [OWNER.email], ...stamp(OWNER) }));
  await assertSucceeds(updateDoc(idea(FRIEND), { likes: [OWNER.email, FRIEND.email], ...stamp(FRIEND) }));
  await assertFails(updateDoc(idea(FRIEND), { likes: [FRIEND.email], ...stamp(FRIEND) })); // removing someone else's like
  await assertFails(updateDoc(idea(FRIEND), { title: 'Renamed', ...stamp(FRIEND) })); // not theirs to edit
  await assertFails(getDoc(idea(STRANGER)));
});
test('only the author or an editor changes or removes an idea', async () => {
  await makeViewer();
  await setDoc(idea(OWNER), newIdea(OWNER));
  await assertFails(updateDoc(idea(FRIEND), { title: 'Mine now', ...stamp(FRIEND) }));
  await assertFails(deleteDoc(idea(FRIEND)));
  await assertSucceeds(deleteDoc(idea(OWNER)));
});

/* ---------- polls ---------- */
const poll = (u, id = 'p1') => doc(db(u), 'trips', 't1', 'polls', id);
const opts = [{ id: 'a', text: 'Thalassa', place: null }, { id: 'b', text: "Fisherman's Wharf", place: null }];
const newPoll = (u, extra = {}) => ({ question: 'Dinner?', options: opts, votes: {}, dayDate: '', closed: false, createdBy: u.email, createdAt: serverTimestamp(), ...stamp(u), ...extra });

test('members vote, changing only their own vote', async () => {
  await makeViewer();
  await setDoc(poll(OWNER), newPoll(OWNER));
  await assertSucceeds(updateDoc(poll(FRIEND), { votes: { [FRIEND.email]: 'a' }, ...stamp(FRIEND) }));
  await assertFails(updateDoc(poll(FRIEND), { votes: { [FRIEND.email]: 'a', [OWNER.email]: 'b' }, ...stamp(FRIEND) }));
  await assertFails(updateDoc(poll(FRIEND), { closed: true, ...stamp(FRIEND) })); // only the starter or an editor closes it
  await assertSucceeds(updateDoc(poll(OWNER), { closed: true, ...stamp(OWNER) }));
  await assertFails(updateDoc(poll(FRIEND), { votes: { [FRIEND.email]: 'b' }, ...stamp(FRIEND) })); // closed
});
test('polls need a question and 2–8 options, and strangers stay out', async () => {
  await assertFails(setDoc(poll(OWNER), newPoll(OWNER, { options: [opts[0]] })));
  await assertFails(setDoc(poll(OWNER), newPoll(OWNER, { question: '' })));
  await assertFails(setDoc(poll(OWNER), newPoll(OWNER, { votes: { [OWNER.email]: 'a' } })));
  await setDoc(poll(OWNER), newPoll(OWNER));
  await assertFails(getDoc(poll(STRANGER)));
});

/* ---------- budget, profiles (UPI), live locations ---------- */
test('editors set the budget; view-only members only read it', async () => {
  await makeViewer();
  const budget = (u) => doc(db(u), 'trips', 't1', 'settings', 'budget');
  await assertSucceeds(setDoc(budget(OWNER), { perPerson: 15000, currency: 'INR', ...stamp(OWNER) }));
  await assertSucceeds(getDoc(budget(FRIEND)));
  await assertFails(setDoc(budget(FRIEND), { perPerson: 1, currency: 'INR', ...stamp(FRIEND) }));
  await assertFails(setDoc(budget(OWNER), { perPerson: -5, currency: 'INR', ...stamp(OWNER) }));
});
test('members set only their own UPI ID, and it must look like one', async () => {
  await addFriend();
  const prof = (u, email) => doc(db(u), 'trips', 't1', 'profiles', email);
  await assertSucceeds(setDoc(prof(FRIEND, FRIEND.email), { upi: 'friend@okicici', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(prof(OWNER, FRIEND.email)));
  await assertFails(setDoc(prof(FRIEND, OWNER.email), { upi: 'thief@okicici', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(prof(FRIEND, FRIEND.email), { upi: 'not a upi id', updatedAt: serverTimestamp() }));
  await assertFails(getDoc(prof(STRANGER, FRIEND.email)));
});
test('members set only their own nickname, and keep it short', async () => {
  await addFriend();
  const prof = (u, email) => doc(db(u), 'trips', 't1', 'profiles', email);
  await assertSucceeds(setDoc(prof(FRIEND, FRIEND.email), { nickname: 'Fizz', updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(prof(FRIEND, FRIEND.email), { nickname: 'Fizz', upi: 'friend@okicici', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(prof(OWNER, FRIEND.email)));
  await assertFails(setDoc(prof(OWNER, FRIEND.email), { nickname: 'Not you', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(prof(FRIEND, FRIEND.email), { nickname: 'x'.repeat(31), updatedAt: serverTimestamp() }));
  await assertFails(setDoc(prof(FRIEND, FRIEND.email), { nickname: 7, updatedAt: serverTimestamp() }));
});
test('members share only their own location, and can stop', async () => {
  await addFriend();
  const loc = (u, email) => doc(db(u), 'trips', 't1', 'locations', email);
  const here = { lat: 15.5, lng: 73.8, accuracy: 20, untilMs: Date.now() + 3600000, updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(loc(FRIEND, FRIEND.email), here));
  await assertSucceeds(getDoc(loc(OWNER, FRIEND.email)));
  await assertFails(setDoc(loc(FRIEND, OWNER.email), here));
  await assertFails(setDoc(loc(FRIEND, FRIEND.email), { ...here, lat: 123 }));
  await assertFails(getDoc(loc(STRANGER, FRIEND.email)));
  await assertSucceeds(deleteDoc(loc(FRIEND, FRIEND.email)));
});

/* ---------- journal and reviews ---------- */
test('members write their own journal entries; only the author edits them', async () => {
  await addFriend();
  const entry = (u) => doc(db(u), 'trips', 't1', 'journal', 'j1');
  const e = { dayDate: '2026-10-17', stopId: 's1', text: 'Best sunset ever', hasPhoto: false, createdBy: FRIEND.email, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(entry(FRIEND), e));
  await assertFails(updateDoc(entry(OWNER), { text: 'Edited by someone else', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(entry(FRIEND), { text: 'Best sunset of the trip', updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db(OWNER), 'trips', 't1', 'journal', 'j2'), { ...e, createdBy: OWNER.email, text: '' }));
  await assertSucceeds(deleteDoc(entry(OWNER))); // the owner can tidy up
});
test('one review per member per stop, written only by them', async () => {
  await addFriend();
  const review = (u, id) => doc(db(u), 'trips', 't1', 'reviews', id);
  const r = (email, extra = {}) => ({ stopId: 's1', email, vote: 1, note: '', updatedAt: serverTimestamp(), ...extra });
  await assertSucceeds(setDoc(review(FRIEND, `s1__${FRIEND.email}`), r(FRIEND.email)));
  await assertSucceeds(setDoc(review(FRIEND, `s1__${FRIEND.email}`), r(FRIEND.email, { vote: -1, note: 'Too crowded' })));
  await assertFails(setDoc(review(FRIEND, `s1__${OWNER.email}`), r(OWNER.email)));
  await assertFails(setDoc(review(FRIEND, `s2__${FRIEND.email}`), r(FRIEND.email)));
  await assertFails(setDoc(review(FRIEND, `s1__${FRIEND.email}`), r(FRIEND.email, { vote: 5 })));
  await assertFails(getDoc(review(STRANGER, `s1__${FRIEND.email}`)));
});

/* ---------- deleting ---------- */
test('only the owner can delete a trip', async () => {
  await addFriend();
  await assertFails(deleteDoc(trip(FRIEND)));
  await assertFails(deleteDoc(trip(STRANGER)));
  await assertSucceeds(deleteDoc(trip(OWNER)));
});
