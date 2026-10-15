// Actions used from several screens: copying the sample, importing files, sharing links, signing out.
import * as cloud from '../lib/cloud';
import * as store from '../lib/store';
import { clearBoot } from './bootCache';
import { ask, toast, toastLink } from '../lib/toast';
import type { Trip, User } from '../lib/types';

/** Copies a (sample) trip into the signed-in person's trips. Resolves with the new trip id. */
export async function copyTrip(user: User, trip: Trip): Promise<string | null> {
  try {
    const id = await cloud.createTrip(user, trip);
    toast('Copied to your trips — now you can edit it', 'ok');
    return id;
  } catch (err) { toast((err as Error).message, 'bad'); return null; }
}

/** Imports every trip in a trips.json file. Resolves true when something was imported. */
export async function importFile(user: User, file: File): Promise<boolean> {
  try {
    const trips = await store.readTripsFile(file);
    for (const t of trips) await cloud.createTrip(user, t);
    toast(`Imported ${trips.length} trip${trips.length === 1 ? '' : 's'}`, 'ok');
    return true;
  } catch (err) {
    toast((err as Error).message || 'Couldn\'t read that file.', 'bad');
    return false;
  }
}

/** The phone's share sheet when there is one, else copy to the clipboard, else show the link. */
export async function shareOrCopy(url: string, text: string, copiedMsg: string): Promise<void> {
  if (navigator.share) {
    try { await navigator.share({ text, url }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast(copiedMsg, 'ok'); } catch { toastLink('Copy this link:', url); }
}

/** A link that carries the whole trip; whoever opens it gets their own copy (no access granted). */
export async function shareCopy(trip: Trip): Promise<void> {
  const url = await store.shareUrl(trip);
  await shareOrCopy(url, `Trip plan: ${trip.title}`, 'Copy link copied — whoever opens it gets their own copy');
}

export async function signOutAndReload(): Promise<void> {
  if (!(await ask('Sign out of GoWander?', { detail: 'Your trips stay safe in your account. The offline copy on this device is removed.', ok: 'Sign out' }))) return;
  await cloud.signOutUser();
  clearBoot();
  location.replace(`${location.pathname}${location.search}#/`);
  location.reload();
}

export async function switchAccount(): Promise<void> {
  await cloud.signOutUser();
  clearBoot();
  location.reload();
}
