// What a pass means: the six states, what each allows, and how the plan reads in words.

import { describe, expect, it } from 'vitest';
import { accessOf, cloudActive, daysLeft, formatDay, MONTHS_TO_BREAK_EVEN, offersOf, planSentence, PRICES, RENEW_WITHIN_DAYS, renewalFrom, stateOf, type LicenseView } from '../src/shared/license.ts';
import { DAY, passPayload } from './licensekit.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const pass = (over: Parameters<typeof passPayload>[0] = {}, now = NOW) => passPayload(over, now);
const view = (over: Partial<LicenseView>): LicenseView => ({ state: 'signed-out', app: false, cloud: false, showOpen: true, ...over });
/** The plan in words, with dates written in UTC so the tests read the same on any computer. */
const say = (over: Partial<LicenseView>) => planSentence(view(over), 'UTC');

describe('the six states', () => {
  it.each([
    ['signed-out', null, { shows: false, cloud: false }],
    ['owner', pass({ owner: true, app: true, cloudUntil: 'forever' }), { shows: true, cloud: true }],
    ['licensed', pass({ app: true, cloudUntil: 'forever' }), { shows: true, cloud: true }],
    ['licensed', pass({ app: true, cloudUntil: iso(NOW + 30 * DAY) }), { shows: true, cloud: true }],
    ['licensed', pass({ app: true, cloudUntil: iso(NOW - DAY) }), { shows: true, cloud: false }],
    ['licensed', pass({ app: true, cloudUntil: null }), { shows: true, cloud: false }],
    ['trial', pass({ trialUntil: iso(NOW + 9 * DAY) }), { shows: true, cloud: true }],
    ['ended', pass({ trialUntil: iso(NOW - DAY) }), { shows: false, cloud: false }],
    ['ended', pass({ trialUntil: null }), { shows: false, cloud: false }],
  ] as const)('is %s for %j: %j', (state, p, access) => {
    expect(stateOf(p, NOW)).toBe(state);
    expect(accessOf(p, NOW)).toEqual(access);
  });

  it('puts the owner ahead of everything, and a purchase ahead of a trial', () => {
    expect(stateOf(pass({ owner: true, app: true, trialUntil: iso(NOW + DAY) }), NOW)).toBe('owner');
    expect(stateOf(pass({ app: true, trialUntil: iso(NOW + DAY) }), NOW)).toBe('licensed');
  });

  it('has the trial end exactly at its date', () => {
    const p = pass({ trialUntil: iso(NOW + 5 * DAY) }, NOW - 5 * DAY); // issued 5 days ago: the pass has 9 days left, the trial 5
    expect(stateOf(p, NOW + 5 * DAY - 1)).toBe('trial');
    expect(stateOf(p, NOW + 5 * DAY)).toBe('ended');
  });

  it('has a pass go stale at its expiry, whoever it is for: the laptop must check in before it trusts it', () => {
    for (const p of [pass({ owner: true, app: true, cloudUntil: 'forever' }), pass({ app: true }), pass({ trialUntil: iso(NOW + 30 * DAY) })]) {
      expect(stateOf(p, p.exp * 1000 - 1)).not.toBe('offline-expired');
      expect(stateOf(p, p.exp * 1000)).toBe('offline-expired');
      expect(accessOf(p, p.exp * 1000)).toEqual({ shows: false, cloud: false });
    }
  });

  it('keeps the ownerâ€™s pass to two weeks too, by the passâ€™s own dates', () => {
    const p = pass({ owner: true, app: true, cloudUntil: 'forever' });
    expect(p.exp - p.iat).toBe(14 * 24 * 60 * 60);
  });

  it('counts Cloud until its date, to the millisecond', () => {
    expect(cloudActive(iso(NOW + 1), NOW)).toBe(true);
    expect(cloudActive(iso(NOW), NOW)).toBe(false);
    expect(cloudActive('forever', NOW * 100)).toBe(true);
    expect(cloudActive(null, NOW)).toBe(false);
  });
});

describe('days left', () => {
  it('rounds up, so the last day reads "1 day left" and never "0"', () => {
    expect(daysLeft(NOW + 14 * DAY, NOW)).toBe(14);
    expect(daysLeft(NOW + 13 * DAY + 1, NOW)).toBe(14);
    expect(daysLeft(NOW + 1, NOW)).toBe(1);
    expect(daysLeft(NOW, NOW)).toBe(0);
    expect(daysLeft(NOW - 5 * DAY, NOW)).toBe(0);
  });
});

describe('what the console offers to buy', () => {
  const offers = (over: Partial<LicenseView>) => offersOf(view({ email: 'kj@example.com', payments: true, ...over }), NOW);
  const none = { app: false, monthly: false, cloud: false, manage: false };

  it('offers nothing until the service says buying is switched on, or before anyone is signed in', () => {
    for (const state of ['trial', 'ended', 'licensed', 'owner', 'signed-out', 'offline-expired'] as const) {
      expect(offersOf(view({ state, email: 'kj@example.com' }), NOW), `${state}, payments off`).toEqual(none);
      expect(offersOf(view({ state, payments: true }), NOW), `${state}, no email`).toEqual(none);
      expect(offersOf(view({ state, monthly: true, email: 'kj@example.com' }), NOW), `${state}, monthly without payments`).toEqual(none);
    }
  });

  it('offers Encore to someone on the trial or whose trial is over, and nothing else', () => {
    expect(offers({ state: 'trial', trialDaysLeft: 9 })).toEqual({ app: true, monthly: false, cloud: false, manage: false });
    expect(offers({ state: 'ended', trialEndsAt: iso(NOW - DAY) })).toEqual({ app: true, monthly: false, cloud: false, manage: false });
  });

  it('offers Encore Monthly beside it, once the service says that can be subscribed to', () => {
    expect(offers({ state: 'trial', trialDaysLeft: 9, monthly: true })).toEqual({ app: true, monthly: true, cloud: false, manage: false });
    expect(offers({ state: 'ended', trialEndsAt: iso(NOW - DAY), monthly: true, billing: true })).toEqual({ app: true, monthly: true, cloud: false, manage: true });
  });

  it('offers a subscriber Encore outright, which ends their subscription, but never Cloud, which they have', () => {
    const subscribed = { state: 'licensed', source: 'subscription', cloud: true, cloudUntil: iso(NOW + 10 * DAY), appUntil: iso(NOW + 7 * DAY), monthly: true } as const;
    expect(offers(subscribed)).toEqual({ app: true, monthly: false, cloud: false, manage: false });
    expect(offers({ ...subscribed, billing: true })).toEqual({ app: true, monthly: false, cloud: false, manage: true });
    // Even when their Cloud (which ends with the subscription) is about to run out.
    expect(offers({ ...subscribed, cloudUntil: iso(NOW + DAY) }).cloud).toBe(false);
  });

  it('offers nothing to the owner, whatever else is true', () => {
    expect(offers({ state: 'owner', cloud: true, cloudUntil: 'forever' })).toEqual(none);
    expect(offers({ state: 'owner', billing: true })).toEqual(none);
  });

  it('offers nothing while the license can’t be checked', () => {
    expect(offers({ state: 'offline-expired' })).toEqual(none);
    expect(offers({ state: 'signed-out' })).toEqual(none);
  });

  it('offers Cloud, never Encore again, to someone who has it: when Cloud is gone, never was, or is nearly over', () => {
    expect(offers({ state: 'licensed', source: 'purchase', cloud: false })).toEqual({ app: false, monthly: false, cloud: true, manage: false });
    expect(offers({ state: 'licensed', source: 'code', cloud: false, cloudUntil: iso(NOW - 40 * DAY) })).toEqual({ app: false, monthly: false, cloud: true, manage: false });
    expect(offers({ state: 'licensed', source: 'purchase', cloud: true, cloudUntil: iso(NOW + (RENEW_WITHIN_DAYS - 1) * DAY) })).toEqual({ app: false, monthly: false, cloud: true, manage: false });
  });

  it('leaves Cloud alone while it has a long way to run, or never ends', () => {
    expect(offers({ state: 'licensed', source: 'purchase', cloud: true, cloudUntil: iso(NOW + (RENEW_WITHIN_DAYS + 1) * DAY) })).toEqual(none);
    expect(offers({ state: 'licensed', source: 'code', cloud: true, cloudUntil: 'forever' })).toEqual(none);
  });

  describe('telling the KJ when Cloud can be renewed', () => {
    const bought = (over: Partial<LicenseView> = {}) => view({ state: 'licensed', source: 'purchase', email: 'kj@example.com', payments: true, cloud: true, cloudUntil: iso(NOW + 300 * DAY), ...over });

    it('names the day the offer will appear, which is when Cloud has the renewal window left', () => {
      const ends = NOW + 300 * DAY;
      const from = renewalFrom(bought(), NOW)!;
      expect(Date.parse(from)).toBe(ends - RENEW_WITHIN_DAYS * DAY);
      // On that very day the offer is showing, and the note has done its job.
      expect(offersOf(bought(), Date.parse(from) + 1000).cloud).toBe(true);
      expect(renewalFrom(bought(), Date.parse(from) + 1000)).toBeUndefined();
      // The day before, it isn't, and the note is still there.
      expect(offersOf(bought(), Date.parse(from) - DAY).cloud).toBe(false);
      expect(renewalFrom(bought(), Date.parse(from) - DAY)).toBe(from);
    });

    it('says it in plain dates', () => {
      // 300 days after 5 November 2026 is 1 September 2027; the offer appears 60 days earlier.
      expect(formatDay(renewalFrom(bought(), NOW)!, 'UTC')).toBe('3 July 2027');
    });

    it('says nothing when there is nothing to renew, or nothing to buy', () => {
      expect(renewalFrom(bought({ cloudUntil: iso(NOW + 10 * DAY) }), NOW)).toBeUndefined(); // the offer is showing already
      expect(renewalFrom(bought({ cloudUntil: iso(NOW - DAY), cloud: false }), NOW)).toBeUndefined(); // Cloud has ended: "Add Cloud" is showing
      expect(renewalFrom(bought({ cloudUntil: 'forever' }), NOW)).toBeUndefined();
      expect(renewalFrom(bought({ cloud: false, cloudUntil: undefined }), NOW)).toBeUndefined();
      expect(renewalFrom(bought({ source: 'subscription' }), NOW)).toBeUndefined(); // Cloud comes with Encore Monthly
      expect(renewalFrom(bought({ payments: undefined }), NOW)).toBeUndefined(); // buying isn't switched on
      expect(renewalFrom(bought({ email: undefined }), NOW)).toBeUndefined();
      expect(renewalFrom(bought({ state: 'owner' }), NOW)).toBeUndefined();
      expect(renewalFrom(bought({ state: 'trial' }), NOW)).toBeUndefined();
    });
  });

  it('offers the billing page to anyone who has paid by card, and not otherwise', () => {
    expect(offers({ state: 'licensed', source: 'purchase', cloud: true, cloudUntil: iso(NOW + 300 * DAY), billing: true })).toEqual({ app: false, monthly: false, cloud: false, manage: true });
    expect(offers({ state: 'ended', billing: true })).toEqual({ app: true, monthly: false, cloud: false, manage: true });
    expect(offers({ state: 'licensed', source: 'code', cloud: true, cloudUntil: 'forever', billing: true }).manage).toBe(true);
  });

  it('names the prices in one place, as dollars', () => {
    expect(PRICES).toEqual({ app: '$149', cloud: '$49', monthly: '$29' });
  });

  it('says how long Encore Monthly takes to cost more than Encore, so the console can be straight about it', () => {
    // $29 a month: five payments are $145, still under $149; the sixth makes buying once the cheaper way.
    expect(MONTHS_TO_BREAK_EVEN).toBe(5);
    expect(MONTHS_TO_BREAK_EVEN * 29).toBeLessThan(149);
    expect((MONTHS_TO_BREAK_EVEN + 1) * 29).toBeGreaterThan(149);
  });
});

describe('Encore Monthly', () => {
  const paidTo = NOW + 12 * DAY;
  const subscription = (over: Parameters<typeof passPayload>[0] = {}) => pass({ app: true, source: 'subscription', appUntil: iso(paidTo), cloudUntil: iso(paidTo + 3 * DAY), exp: Math.floor((paidTo + 3 * DAY) / 1000), ...over });

  it('is a licensed plan, with Cloud while it lasts, and the pass goes stale when its grace is over', () => {
    const p = subscription();
    expect(stateOf(p, NOW)).toBe('licensed');
    expect(accessOf(p, NOW)).toEqual({ shows: true, cloud: true });
    // Past the paid month, inside the grace: still working.
    expect(stateOf(p, paidTo + DAY)).toBe('licensed');
    // Past the grace, the pass has run out, and nothing is allowed until it is checked.
    expect(stateOf(p, paidTo + 3 * DAY)).toBe('offline-expired');
    expect(accessOf(p, paidTo + 3 * DAY)).toEqual({ shows: false, cloud: false });
  });

  it('has the owner and a purchase ahead of it, as they are for the pass itself', () => {
    expect(stateOf(subscription({ owner: true, source: 'owner' }), NOW)).toBe('owner');
  });

  it('says in plain words what has been paid for, and what to do when it has not come through', () => {
    const v = (appUntil: string) => view({ state: 'licensed', source: 'subscription', cloud: true, cloudUntil: iso(paidTo + 3 * DAY), appUntil });
    expect(planSentence(v(iso(paidTo)), 'UTC', NOW)).toBe('Encore Monthly: paid until 17 November 2026. Cloud is included.');
    // The paid month is over but the pass still works (the grace): say so, and where to put it right.
    expect(planSentence(v(iso(paidTo)), 'UTC', paidTo + DAY)).toBe('Encore Monthly: the month paid for ended on 17 November 2026. Update your card in Manage billing to keep going.');
    expect(planSentence(view({ state: 'licensed', source: 'subscription' }), 'UTC', NOW)).toBe('Encore Monthly. Cloud is included.');
  });

  it('says that it ended, not that a free trial did, once the grace is over', () => {
    const ended = (over: Partial<LicenseView> = {}) => view({ state: 'ended', appUntil: iso(paidTo), ...over });
    expect(planSentence(ended(), 'UTC', paidTo + 5 * DAY)).toBe('Encore Monthly ended on 17 November 2026.');
    // Whatever else is known about a trial, the subscription is what ended.
    expect(planSentence(ended({ trialEndsAt: iso(NOW - 20 * DAY) }), 'UTC', paidTo + 5 * DAY)).toBe('Encore Monthly ended on 17 November 2026.');
    expect(planSentence(ended({ appUntil: undefined, trialEndsAt: iso(NOW - 20 * DAY) }), 'UTC', paidTo + 5 * DAY)).toBe('Your free trial ended on 16 October 2026.');
  });

  it('offers what it offers after any ended plan: buying or subscribing again, and Manage billing', () => {
    const ended = view({ state: 'ended', email: 'kj@example.com', appUntil: iso(paidTo), payments: true, monthly: true, billing: true });
    expect(offersOf(ended, paidTo + 5 * DAY)).toEqual({ app: true, monthly: true, cloud: false, manage: true });
  });
});

describe('the plan in words', () => {
  it('says what the owner, a trial and a purchase get, plainly', () => {
    expect(say({ state: 'owner' })).toBe('Owner. Everything, forever.');
    expect(say({ state: 'trial', trialDaysLeft: 9 })).toBe('Free trial: 9 days left.');
    expect(say({ state: 'trial', trialDaysLeft: 1 })).toBe('Free trial: 1 day left.');
    expect(say({ state: 'licensed', cloud: true, cloudUntil: '2027-05-03T12:00:00.000Z' })).toBe('Encore is yours. Cloud until 3 May 2027.');
  });

  it('says where an unlock code left someone', () => {
    expect(say({ state: 'licensed', source: 'code', cloud: true, cloudUntil: 'forever' })).toBe('Encore is yours forever (unlock code).');
    expect(say({ state: 'licensed', source: 'code' })).toBe('Encore is yours (unlock code). Cloud isn’t included.');
  });

  it('says when Cloud has run out, and when it was never part of the plan', () => {
    expect(say({ state: 'licensed', cloudUntil: '2026-05-03T00:00:00.000Z' })).toBe('Encore is yours. Cloud ended on 3 May 2026.');
    expect(say({ state: 'licensed' })).toBe('Encore is yours. Cloud isn’t included.');
  });

  it('says what is wrong, without a sales pitch', () => {
    expect(say({ state: 'ended', trialEndsAt: '2026-10-01T09:00:00.000Z' })).toBe('Your free trial ended on 1 October 2026.');
    expect(say({ state: 'ended', trialAvailable: true })).toBe('Your free trial hasn’t started yet.');
    expect(say({ state: 'ended' })).toBe('This computer has already had its free trial.');
    expect(say({ state: 'offline-expired' })).toMatch(/connect this laptop to the internet/i);
    expect(say({ state: 'signed-out' })).toBe('Not signed in.');
    expect(say({ state: 'signed-out', email: 'kj@example.com' })).toBe('Signed in, but Encore hasn’t checked your license yet.');
    expect(say({ state: 'off' })).toMatch(/switched off/);
  });

  it('writes a date in the KJ’s own time zone, so a trial that ends late in the evening ends that day for them', () => {
    // 03:44 UTC on the 19th is still the evening of the 18th in Chicago, and already the 19th in Auckland.
    const ends = '2026-10-19T03:44:00.000Z';
    expect(formatDay(ends, 'UTC')).toBe('19 October 2026');
    expect(formatDay(ends, 'America/Chicago')).toBe('18 October 2026');
    expect(formatDay(ends, 'Pacific/Auckland')).toBe('19 October 2026');
    expect(planSentence(view({ state: 'ended', trialEndsAt: ends }), 'America/Chicago')).toBe('Your free trial ended on 18 October 2026.');
  });

  it('never uses the jargon the plan avoids', () => {
    const everything = [
      view({ state: 'owner' }),
      view({ state: 'trial', trialDaysLeft: 3 }),
      view({ state: 'licensed', source: 'code', cloudUntil: 'forever', cloud: true }),
      view({ state: 'licensed', source: 'purchase', cloudUntil: '2027-01-01T00:00:00.000Z' }),
      view({ state: 'ended' }),
      view({ state: 'offline-expired' }),
      view({ state: 'signed-out' }),
    ].map((v) => planSentence(v));
    for (const s of everything) expect(s).not.toMatch(/entitlement|sku|subscription tier/i);
  });
});
