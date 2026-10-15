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
  /** Tickets and bookings for this stop, kept with the plan so they work offline. */
  booking?: Booking;
}

/** Ticket or booking details on a stop. Every field is optional. */
export interface Booking {
  /** Booking reference / confirmation number. */
  ref?: string;
  /** Indian Railways PNR (10 digits): gets a "Check status" link. */
  pnr?: string;
  phone?: string;
  /** Ticket, e-ticket or booking page. */
  link?: string;
  note?: string;
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
export type ExpenseCategory = 'food' | 'travel' | 'stay' | 'tickets' | 'shopping' | 'other';
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
  category?: ExpenseCategory;
  /** Split by amount instead of equally: member → their part (adds up to `amount`). */
  shares?: Record<string, number>;
  /** A photo of the bill is stored (photos/bill-<id>). */
  hasBill?: boolean;
}
export interface Expense extends ExpenseInput {
  id: string;
  createdBy: string;
  createdMs: number;
}

/* ---------- planning together ---------- */
/** A place someone would like to visit, not in the plan yet. */
export interface Idea {
  id: string;
  title: string;
  note: string;
  place: Place | null;
  link: string;
  createdBy: string;
  createdMs: number;
  /** Members who'd like to go. */
  likes: string[];
}

export interface PollOption { id: string; text: string; place: Place | null }
export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  /** Member email → the option id they picked. */
  votes: Record<string, string>;
  /** The day it's about (YYYY-MM-DD), or ''. */
  dayDate: string;
  closed: boolean;
  createdBy: string;
  createdMs: number;
}

/** Trip budget, per person, in one currency. */
export interface Budget { perPerson: number; currency: string }

/** A member's details for the group: their nickname (shown instead of their email) and UPI ID. */
export interface Profile { email: string; upi: string; nickname: string }

/** Where a member is right now, if they chose to share it. */
export interface MemberLocation {
  email: string;
  lat: number;
  lng: number;
  accuracy: number;
  atMs: number;
  /** Sharing stops after this (ms). */
  untilMs: number;
}

/* ---------- memories ---------- */
export interface JournalEntry {
  id: string;
  dayDate: string;
  /** The stop it's about, or ''. */
  stopId: string;
  text: string;
  /** A photo is stored (photos/j-<id>). */
  hasPhoto: boolean;
  createdBy: string;
  createdMs: number;
}

/** One member's 👍 / 👎 on a stop, with an optional note. */
export interface Review {
  stopId: string;
  email: string;
  vote: 1 | -1;
  note: string;
}
