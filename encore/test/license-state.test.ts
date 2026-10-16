// What a pass means: the six states, what each allows, and how the plan reads in words.

import { describe, expect, it } from 'vitest';
import { accessOf, cloudActive, daysLeft, formatDay, planSentence, stateOf, type LicenseView } from '../src/shared/license.ts';
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
