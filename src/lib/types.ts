// The shapes of GoWander's data. Trips are stored in Firestore (see cloud.ts) and validated by
// normalizeTrip (store.ts) whenever they come from a file, a link or the network.

export type StopKind = 'stop' | 'meal' | 'travel' | 'stay';
export type StopTag = 'must' | 'key' | 'optional' | 'closing' | 'deadline';
export type NoteType = 'star' | 'tip' | 'warn';
export type Role = 'edit' | 'view';

export interface LatLng { lat: number; lng: number }

export interface Place extends LatLng {
  name: string;
  /** Metres: inside this circle counts as "arrived". */
  radius: number;
  /** The pin is roughly placed (e.g. a whole neighbourhood). */
  approx?: boolean;
}

export interface Stop {
  /** Stable id, so shared done/skip marks survive edits and reordering. */
  id: string;
  /** Local wall-clock times at the destination, "HH:MM". */
  start: string;
  end: string;
  kind: StopKind;
  title: string;
  place: Place;
  note?: string;
  tag?: StopTag;
  /** A fixed departure (train, flight, bus): be there `buffer` minutes early. */
  departure?: { buffer: number };
}

export interface DayNote { type: NoteType; title: string; text: string }

export interface Day {
  /** "YYYY-MM-DD" in the trip's timezone. */
  date: string;
  title: string;
  stops: Stop[];
  notes: DayNote[];
}

export interface Trip {
  id: string;
  title: string;
  subtitle: string;
  timezone: string;
  updatedAt?: string;
  days: Day[];
}

/** Sharing and sync details that come with a stored trip. */
export interface TripMeta {
  ownerUid: string;
  ownerEmail: string;
  memberEmails: string[];
  /** View-only members (everyone else can edit the plan). */
  viewerEmails: string[];
  /** Anyone with the link can join. */
  linkJoin: boolean;
  /** What people joining by link become. */
  linkRole: Role;
  /** 0 while our own write is still pending. */
  updatedAtMs: number;
  updatedBy: string;
  pending: boolean;
}

export interface TripEntry { trip: Trip; meta: TripMeta }

export interface User {
  uid: string;
  email: string;
  name: string;
  photo: string;
}

/* ---------- editor drafts: stops may not have a place yet ---------- */
export type DraftStop = Omit<Stop, 'place'> & { place: Place | null };
export type DraftDay = Omit<Day, 'stops'> & { stops: DraftStop[] };
export type DraftTrip = Omit<Trip, 'days'> & { days: DraftDay[] };

/* ---------- shared lists ---------- */
export type ChecklistList = 'packing' | 'todo';
export interface ChecklistItem {
  id: string;
  text: string;
  list: ChecklistList;
  done: boolean;
  doneBy: string;
  createdBy: string;
  createdMs: number;
}

export type ExpenseKind = 'expense' | 'settlement';
export interface ExpenseInput {
  title: string;
  amount: number;
  /** ISO 4217, e.g. "INR". */
  currency: string;
  paidBy: string;
  /** Shared equally between these members. A settlement has one: who was paid back. */
  split: string[];
  date: string;
  kind: ExpenseKind;
}
export interface Expense extends ExpenseInput {
  id: string;
  createdBy: string;
  createdMs: number;
}
