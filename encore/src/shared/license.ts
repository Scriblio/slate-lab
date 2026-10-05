// What Encore knows about the KJ's plan, and what it means. The server works it out
// from the signed pass (src/server/license.ts); the console shows it. Pure functions,
// so the same rules are tested without a screen or a network.
//
// The states, in plain words:
//   owner            the owner's own account: everything
//   licensed         Encore is theirs (an unlock code or a purchase); Cloud while it lasts
//   trial            inside the free 14 days: everything
//   ended            the trial is over and nothing was bought
//   signed-out       no account yet
//   offline-expired  the pass is too old to trust, and this laptop hasn't been online to renew it
//
// No YouTube feature depends on any of this: search, pasted links, previews and the
// Not karaoke button work in every state (YouTube's policies forbid charging for them).

import type { PassPayload, PassSource } from '../../supabase/functions/encore-license/pass.ts';

export type { PassPayload, PassSource };

export type LicenseState = 'owner' | 'licensed' | 'trial' | 'ended' | 'signed-out' | 'offline-expired';

/** What a plan allows right now. */
export interface Access {
  /** Singers can join and the KJ can call them up. */
  shows: boolean;
  /** Encore Cloud: the online join link and lock-screen alerts. */
  cloud: boolean;
}

/** What the console is told about the plan. */
export interface LicenseView {
  /** 'off': licensing isn't enforced in this copy (a development build). */
  state: LicenseState | 'off';
  email?: string;
  /** Encore itself is theirs. */
  app: boolean;
  /** Encore Cloud is part of the plan right now. */
  cloud: boolean;
  /** When Cloud ends: an ISO date, or "forever". Absent when there's none. */
  cloudUntil?: string;
  /** The free trial's end, and the whole days left (rounded up) while it's running. */
  trialEndsAt?: string;
  trialDaysLeft?: number;
  /** How Encore became theirs. */
  source?: PassSource;
  /** A free trial can still be started on this account. */
  trialAvailable?: boolean;
  /** The last time the license was checked online (ISO), and when the saved answer stops being good without a check. */
  checkedAt?: string;
  validUntil?: string;
  /** Something that went wrong, in plain words (no internet, a code that didn't work). */
  problem?: string;
  /** A show can run right now: the plan allows it, or this is the show that was running when it ran out. */
  showOpen: boolean;
}

/** A development copy with licensing switched off. */
export const LICENSE_OFF: LicenseView = { state: 'off', app: true, cloud: true, showOpen: true };

const DAY = 24 * 60 * 60 * 1000;

/** The state a pass puts the laptop in at this time. Without a pass, signed out. */
export function stateOf(pass: PassPayload | null, now: number): LicenseState {
  if (!pass) return 'signed-out';
  // The pass is only good until it expires; after that the laptop has to check in before it trusts it.
  if (now >= pass.exp * 1000) return 'offline-expired';
  if (pass.owner) return 'owner';
  if (pass.app) return 'licensed';
  if (pass.trialUntil && now < Date.parse(pass.trialUntil)) return 'trial';
  return 'ended';
}

export function accessOf(pass: PassPayload | null, now: number): Access {
  const state = stateOf(pass, now);
  if (state === 'owner' || state === 'trial') return { shows: true, cloud: true };
  if (state === 'licensed') return { shows: true, cloud: cloudActive(pass!.cloudUntil, now) };
  return { shows: false, cloud: false };
}

export function cloudActive(cloudUntil: string | null, now: number): boolean {
  return cloudUntil === 'forever' || (cloudUntil !== null && now < Date.parse(cloudUntil));
}

/** Whole days left, rounded up, so the last day reads "1 day left" rather than "0". */
export function daysLeft(untilMs: number, now: number): number {
  return Math.max(0, Math.ceil((untilMs - now) / DAY));
}

/** "3 May 2027", in the computer's own time zone (or the one given: the tests pin UTC). */
export function formatDay(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(new Date(iso));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The plan in one plain sentence, for Settings. */
export function planSentence(v: LicenseView, timeZone?: string): string {
  const day = (iso: string) => formatDay(iso, timeZone);
  switch (v.state) {
    case 'off':
      return 'Licensing is switched off in this copy of Encore.';
    case 'owner':
      return 'Owner. Everything, forever.';
    case 'trial':
      return `Free trial: ${plural(v.trialDaysLeft ?? 0, 'day')} left.`;
    case 'licensed': {
      const how = v.source === 'code' ? ' (unlock code)' : '';
      if (v.cloudUntil === 'forever') return `Encore is yours forever${how}.`;
      if (v.cloud && v.cloudUntil) return `Encore is yours${how}. Cloud until ${day(v.cloudUntil)}.`;
      if (v.cloudUntil) return `Encore is yours${how}. Cloud ended on ${day(v.cloudUntil)}.`;
      return `Encore is yours${how}. Cloud isn’t included.`;
    }
    case 'ended':
      // No trial date means this account never had one: either it hasn't started, or this laptop already used its one.
      return v.trialEndsAt ? `Your free trial ended on ${day(v.trialEndsAt)}.` : v.trialAvailable ? 'Your free trial hasn’t started yet.' : 'This computer has already had its free trial.';
    case 'offline-expired':
      return 'Encore needs to check your license. Connect this laptop to the internet.';
    case 'signed-out':
      // Signed in, but no answer from the license service yet (no internet, say).
      return v.email ? 'Signed in, but Encore hasn’t checked your license yet.' : 'Not signed in.';
  }
}
