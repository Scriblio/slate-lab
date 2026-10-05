// The license service (supabase/functions/encore-license): the trial, unlock codes,
// the owner, and the pass it signs. Every scenario runs twice, against an in-memory
// store and against the real SQL functions, which have to agree.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRedeem, handleStartTrial, handleStatus, type Caller, type Deps, type Reply } from '../supabase/functions/encore-license/core.ts';
import { readPass, type PassPayload } from '../supabase/functions/encore-license/pass.ts';
import { toSnapshot } from '../supabase/functions/encore-license/store.ts';
import { DAY, makeKeys } from './licensekit.ts';
import { memoryWorld, sqlWorld, type World } from './licenseworld.ts';

let counter = 0;
/** A laptop's installation id, and a network address, that nothing else in the file uses. */
const laptop = () => `laptop-${String(++counter).padStart(8, '0')}-abcdef`;
const address = () => `198.51.100.${++counter}`;
const yearsFrom = (ms: number, n: number) => {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.getTime();
};
const near = (iso: string | null, ms: number, slackMs = 120_000) => iso !== null && Math.abs(Date.parse(iso) - ms) < slackMs;

describe.each([
  { name: 'the in-memory store', open: async () => memoryWorld() },
  { name: 'the real SQL functions', open: sqlWorld },
])('the license service, on $name', ({ open }) => {
  let w: World;
  let keys: Awaited<ReturnType<typeof makeKeys>>;
  beforeAll(async () => {
    w = await open();
    keys = await makeKeys();
  }, 60_000);
  afterAll(() => w.close());

  const deps = (over: Partial<Deps> = {}): Deps => ({ store: w.store, signing: { key: keys.signing, kid: keys.kid }, ...over });
  const status = (kj: Caller, installId: string, d = deps()) => handleStatus({ installId }, kj, d);
  const startTrial = (kj: Caller, installId: string, d = deps()) => handleStartTrial({ installId }, kj, d);
  const redeem = (kj: Caller, installId: string, code: string, ip = address(), d = deps()) => handleRedeem({ installId, code }, kj, ip, d);
  /** The pass a successful reply carries, read with the public key like a laptop does. */
  async function passOf(reply: Reply): Promise<PassPayload> {
    expect(reply.body.ok, JSON.stringify(reply.body)).toBe(true);
    if (!reply.body.ok) throw new Error('not ok');
    const pass = await readPass(reply.body.pass, keys.keys);
    expect(pass).not.toBeNull();
    return pass!;
  }
  const refusal = (reply: Reply) => (reply.body.ok ? undefined : { status: reply.status, code: reply.body.code });

  describe('the pass', () => {
    it('is for one account on one laptop, and good for two weeks without a check-in', async () => {
      const kj = await w.kj('pass@example.com');
      const install = laptop();
      const reply = await status(kj, install);
      expect(await passOf(reply)).toMatchObject({ v: 1, sub: kj.userId, email: kj.email, installId: install, app: false, cloudUntil: null, trialUntil: null, owner: false, source: null });
      const pass = await passOf(reply);
      expect(pass.exp - pass.iat).toBe(14 * 24 * 60 * 60);
      expect(Math.abs(pass.iat - Date.now() / 1000)).toBeLessThan(10);
    });

    it('can be made to last a different time', async () => {
      const pass = await passOf(await status(await w.kj('short@example.com'), laptop(), deps({ passDays: 3 })));
      expect(pass.exp - pass.iat).toBe(3 * 24 * 60 * 60);
    });

    it('says nothing about YouTube, so no plan can switch a YouTube feature on or off', async () => {
      const kj = await w.kj('plain-owner@example.com');
      await w.setOwner(kj.email);
      const pass = await passOf(await status(kj, laptop()));
      // Only these fields exist, and none of them is a feature.
      expect(Object.keys(pass).sort()).toEqual(['app', 'cloudUntil', 'email', 'exp', 'iat', 'installId', 'owner', 'source', 'sub', 'trialUntil', 'v']);
      expect(JSON.stringify(pass)).not.toMatch(/youtube/i);
    });

    it('is never made without the signing key, and then changes nothing', async () => {
      const kj = await w.kj('nokey@example.com');
      const install = laptop();
      const code = await w.makeCode('nokey');
      const off = deps({ signing: undefined });
      for (const reply of [await status(kj, install, off), await startTrial(kj, install, off), await redeem(kj, install, code, address(), off)]) {
        expect(refusal(reply)).toEqual({ status: 503, code: 'not-configured' });
      }
      expect(await w.trialsOn(install)).toBe(0);
      expect(await w.store.snapshot(kj.userId, install)).toMatchObject({ license: null, grants: [] });
      // Once the key is there, the same code still works.
      expect((await redeem(kj, install, code)).status).toBe(200);
    });

    it('is not made for a laptop id that is missing or malformed', async () => {
      const kj = await w.kj('badid@example.com');
      for (const installId of [undefined, '', 'short', 'has spaces in it abc', 12345678901234567890, 'x'.repeat(65)]) {
        expect(refusal(await handleStatus({ installId }, kj, deps())), String(installId)).toEqual({ status: 400, code: 'bad-request' });
      }
      expect(refusal(await handleStatus(null, kj, deps()))?.status).toBe(400);
    });
  });

  describe('the free trial', () => {
    it('starts for fourteen days', async () => {
      const kj = await w.kj('trial@example.com');
      const install = laptop();
      expect((await status(kj, install)).body).toMatchObject({ ok: true, trialAvailable: true });
      const reply = await startTrial(kj, install);
      const pass = await passOf(reply);
      expect(reply.body).toMatchObject({ trial: 'started', trialAvailable: false });
      expect(near(pass.trialUntil, Date.now() + 14 * DAY)).toBe(true);
      expect(pass).toMatchObject({ app: false, owner: false, cloudUntil: null, source: 'trial' });
      expect(await w.trialsOn(install)).toBe(1);
    });

    it('can be made a different length', async () => {
      const pass = await passOf(await startTrial(await w.kj('trial7@example.com'), laptop(), deps({ trialDays: 7 })));
      expect(near(pass.trialUntil, Date.now() + 7 * DAY)).toBe(true);
    });

    it('is once per account: asking again, even from another laptop, changes nothing', async () => {
      const kj = await w.kj('trial-once@example.com');
      const [a, b] = [laptop(), laptop()];
      const first = await passOf(await startTrial(kj, a));
      const again = await startTrial(kj, a);
      const other = await startTrial(kj, b);
      expect(again.body).toMatchObject({ trial: 'account', trialAvailable: false });
      expect(other.body).toMatchObject({ trial: 'account', trialAvailable: false });
      expect((await passOf(again)).trialUntil).toBe(first.trialUntil);
      expect((await passOf(other)).trialUntil).toBe(first.trialUntil);
      expect(await w.trialsOn(b)).toBe(0);
    });

    it('is once per laptop: a new email on the same laptop gets no trial, and is told so', async () => {
      const install = laptop();
      const [a, b] = [await w.kj('shared-a@example.com'), await w.kj('shared-b@example.com')];
      await startTrial(a, install);
      expect((await status(b, install)).body).toMatchObject({ trialAvailable: false });
      const reply = await startTrial(b, install);
      expect(reply.body).toMatchObject({ trial: 'install', trialAvailable: false });
      expect(await passOf(reply)).toMatchObject({ trialUntil: null, app: false });
      // Another laptop for the same new account is fine.
      expect((await startTrial(b, laptop())).body).toMatchObject({ trial: 'started' });
    });

    it('has ended once its date has passed, and cannot be started again', async () => {
      const kj = await w.kj('trial-over@example.com');
      const install = laptop();
      await startTrial(kj, install);
      await w.endTrialAt(kj.userId, Date.now() - DAY);
      const reply = await status(kj, install);
      const pass = await passOf(reply);
      expect(Date.parse(pass.trialUntil!)).toBeLessThan(Date.now());
      expect(pass).toMatchObject({ app: false });
      expect(reply.body).toMatchObject({ trialAvailable: false });
      expect((await startTrial(kj, install)).body).toMatchObject({ trial: 'account' });
    });
  });

  describe('the owner', () => {
    it('has everything forever, and needs no trial', async () => {
      const kj = await w.kj('owner@example.com');
      const install = laptop();
      await w.setOwner(kj.email);
      const pass = await passOf(await status(kj, install));
      expect(pass).toMatchObject({ owner: true, app: true, cloudUntil: 'forever', source: 'owner' });
      const reply = await startTrial(kj, install);
      expect(reply.body).toMatchObject({ trial: 'owned', trialAvailable: false });
      expect(await w.trialsOn(install)).toBe(0);
    });

    it('is the owner on every laptop and keeps a trial that was already running', async () => {
      const kj = await w.kj('owner-later@example.com');
      await startTrial(kj, laptop());
      await w.setOwner(kj.email);
      expect(await passOf(await status(kj, laptop()))).toMatchObject({ owner: true, app: true, cloudUntil: 'forever' });
    });
  });

  describe('unlock codes', () => {
    it('with "forever" give the app and Cloud for good', async () => {
      const kj = await w.kj('forever@example.com');
      const install = laptop();
      const reply = await redeem(kj, install, await w.makeCode('forever'));
      expect(await passOf(reply)).toMatchObject({ app: true, cloudUntil: 'forever', owner: false, source: 'code' });
      expect(reply.body).toMatchObject({ trialAvailable: false });
    });

    it('with "app" give the app but not Cloud', async () => {
      const kj = await w.kj('apponly@example.com');
      expect(await passOf(await redeem(kj, laptop(), await w.makeCode('apponly', 'app')))).toMatchObject({ app: true, cloudUntil: null, source: 'code' });
    });

    it('with "cloud_year" give a year of Cloud, but not the app', async () => {
      const kj = await w.kj('cloudyear@example.com');
      const pass = await passOf(await redeem(kj, laptop(), await w.makeCode('cloudyear', 'cloud_year')));
      expect(pass).toMatchObject({ app: false, source: null });
      expect(near(pass.cloudUntil, yearsFrom(Date.now(), 1))).toBe(true);
    });

    it('with a year of Cloud stack: a second code adds a second year', async () => {
      const kj = await w.kj('twoyears@example.com');
      const install = laptop();
      await redeem(kj, install, await w.makeCode('year-a', 'cloud_year'));
      const pass = await passOf(await redeem(kj, install, await w.makeCode('year-b', 'cloud_year')));
      expect(near(pass.cloudUntil, yearsFrom(Date.now(), 2))).toBe(true);
    });

    it('with a year of Cloud add to what was paid for, from where it ends', async () => {
      const kj = await w.kj('paid-then-code@example.com');
      const paidUntil = Date.now() + 100 * DAY;
      await w.purchase(kj.userId, { appForever: true, cloudUntil: paidUntil });
      const before = await passOf(await status(kj, laptop()));
      expect(before).toMatchObject({ app: true, source: 'purchase' });
      expect(near(before.cloudUntil, paidUntil)).toBe(true);
      const after = await passOf(await redeem(kj, laptop(), await w.makeCode('paid-year', 'cloud_year')));
      expect(near(after.cloudUntil, yearsFrom(paidUntil, 1))).toBe(true);
    });

    it('with "forever" win over a Cloud year that was paid for', async () => {
      const kj = await w.kj('forever-over-year@example.com');
      await w.purchase(kj.userId, { appForever: true, cloudUntil: Date.now() + 30 * DAY });
      expect(await passOf(await redeem(kj, laptop(), await w.makeCode('fy')))).toMatchObject({ app: true, cloudUntil: 'forever', source: 'code' });
    });

    it('work for one KJ unless made for more', async () => {
      const [a, b] = [await w.kj('one-a@example.com'), await w.kj('one-b@example.com')];
      const code = await w.makeCode('one');
      expect((await redeem(a, laptop(), code)).status).toBe(200);
      expect(refusal(await redeem(b, laptop(), code))).toEqual({ status: 400, code: 'code-used' });
      expect(await passOf(await status(b, laptop()))).toMatchObject({ app: false });
    });

    it('can be made for several KJs, and stop at that number', async () => {
      const kjs = await Promise.all([1, 2, 3].map((n) => w.kj(`band${n}@example.com`)));
      const code = await w.makeCode('band', 'app', 2);
      expect((await redeem(kjs[0]!, laptop(), code)).status).toBe(200);
      expect((await redeem(kjs[1]!, laptop(), code)).status).toBe(200);
      expect(refusal(await redeem(kjs[2]!, laptop(), code))).toEqual({ status: 400, code: 'code-used' });
    });

    it('cannot be used twice by one account', async () => {
      const kj = await w.kj('twice@example.com');
      const code = await w.makeCode('twice', 'forever', 5);
      expect((await redeem(kj, laptop(), code)).status).toBe(200);
      expect(refusal(await redeem(kj, laptop(), code))).toEqual({ status: 400, code: 'code-already' });
      // It didn't use up a second place.
      const other = await w.kj('twice-other@example.com');
      expect((await redeem(other, laptop(), code)).status).toBe(200);
    });

    it('can be typed any way: lowercase, spaces, no dashes, no prefix', async () => {
      const kj = await w.kj('typed@example.com');
      const code = await w.makeCode('typed');
      const sloppy = code.toLowerCase().replace(/-/g, ' ').replace('enc ', '');
      expect((await redeem(kj, laptop(), `  ${sloppy} `)).status).toBe(200);
    });

    it('are refused when turned off or run out, and say which', async () => {
      const kj = await w.kj('refused@example.com');
      const off = await w.makeCode('turned-off');
      await w.revoke('turned-off');
      expect(refusal(await redeem(kj, laptop(), off))).toEqual({ status: 400, code: 'code-off' });
      const old = await w.makeCode('lapsed', 'forever', 1, 30);
      await w.expireCode('lapsed');
      expect(refusal(await redeem(kj, laptop(), old))).toEqual({ status: 400, code: 'code-expired' });
      expect(refusal(await redeem(kj, laptop(), 'ENC-0000-0000-0000'))).toEqual({ status: 400, code: 'bad-code' });
      expect(await passOf(await status(kj, laptop()))).toMatchObject({ app: false });
    });

    it('are refused, without being counted as a try, when they are not even shaped like a code', async () => {
      const kj = await w.kj('shapes@example.com');
      const d = deps({ limits: { redeemPerAccount: 1, redeemPerIp: 1000 } });
      const ip = address();
      for (const junk of ['', 'hello', 'ENC-1234', 12345, null, { code: 1 }, 'ENC-7K4Q-M2XP-9R8U']) {
        expect(refusal(await handleRedeem({ installId: laptop(), code: junk }, kj, ip, d)), JSON.stringify(junk)).toEqual({ status: 400, code: 'bad-code' });
      }
      // The one try this account is allowed is still there.
      expect(refusal(await handleRedeem({ installId: laptop(), code: 'ENC-0000-0000-0000' }, kj, ip, d))).toEqual({ status: 400, code: 'bad-code' });
      expect(refusal(await handleRedeem({ installId: laptop(), code: 'ENC-0000-0000-0000' }, kj, ip, d))).toEqual({ status: 429, code: 'limit' });
    });

    it('stop counting the moment they are turned off, at that KJ’s next check-in', async () => {
      const kj = await w.kj('revoked-later@example.com');
      const install = laptop();
      await redeem(kj, install, await w.makeCode('lent', 'forever'));
      expect(await passOf(await status(kj, install))).toMatchObject({ app: true, cloudUntil: 'forever' });
      await w.revoke('lent');
      const pass = await passOf(await status(kj, install));
      expect(pass).toMatchObject({ app: false, cloudUntil: null, owner: false, source: null });
    });

    it('turned off one at a time leave the others alone', async () => {
      const kj = await w.kj('two-codes@example.com');
      const install = laptop();
      await redeem(kj, install, await w.makeCode('keep-me', 'app'));
      await redeem(kj, install, await w.makeCode('lose-me', 'cloud_year'));
      await w.revoke('lose-me');
      expect(await passOf(await status(kj, install))).toMatchObject({ app: true, cloudUntil: null, source: 'code' });
    });

    it('make a free trial pointless: it is not started, and the laptop’s trial is left for someone else', async () => {
      const kj = await w.kj('code-no-trial@example.com');
      const install = laptop();
      await redeem(kj, install, await w.makeCode('no-trial'));
      expect((await startTrial(kj, install)).body).toMatchObject({ trial: 'owned', trialAvailable: false });
      expect(await w.trialsOn(install)).toBe(0);
      expect((await startTrial(await w.kj('code-no-trial-2@example.com'), install)).body).toMatchObject({ trial: 'started' });
    });

    it('keep a trial that was already going', async () => {
      const kj = await w.kj('trial-then-code@example.com');
      const install = laptop();
      await startTrial(kj, install);
      const pass = await passOf(await redeem(kj, install, await w.makeCode('after-trial', 'app')));
      expect(pass).toMatchObject({ app: true, source: 'code' });
      expect(pass.trialUntil).not.toBeNull();
    });
  });

  describe('guessing codes', () => {
    it('is stopped after a few tries an hour for one account, even with a good code', async () => {
      const kj = await w.kj('guesser@example.com');
      const d = deps({ limits: { redeemPerAccount: 3, redeemPerIp: 1000 } });
      const ip = address();
      for (let i = 0; i < 3; i++) expect((await handleRedeem({ installId: laptop(), code: 'ENC-0000-0000-0000' }, kj, ip, d)).status).toBe(400);
      const good = await w.makeCode('guarded');
      expect(refusal(await handleRedeem({ installId: laptop(), code: good }, kj, ip, d))).toEqual({ status: 429, code: 'limit' });
      // The code wasn't used up by that refused try, and another account is not held back.
      expect((await handleRedeem({ installId: laptop(), code: good }, await w.kj('innocent@example.com'), address(), d)).status).toBe(200);
    });

    it('is stopped for one network however many accounts it uses, but not for other networks', async () => {
      const d = deps({ limits: { redeemPerAccount: 100, redeemPerIp: 2 } });
      const ip = address();
      for (const n of [1, 2]) expect((await handleRedeem({ installId: laptop(), code: 'ENC-0000-0000-0000' }, await w.kj(`net${n}@example.com`), ip, d)).status).toBe(400);
      expect(refusal(await handleRedeem({ installId: laptop(), code: 'ENC-0000-0000-0000' }, await w.kj('net3@example.com'), ip, d))).toEqual({ status: 429, code: 'limit' });
      expect((await handleRedeem({ installId: laptop(), code: 'ENC-0000-0000-0000' }, await w.kj('net4@example.com'), address(), d)).status).toBe(400);
    });

    it('is counted by the hour, in the hour it happened', async () => {
      const kj = await w.kj('hourly@example.com');
      const ip = address();
      const at = (ms: number) => deps({ limits: { redeemPerAccount: 1, redeemPerIp: 1000 }, now: () => ms });
      const nine = Date.UTC(2031, 5, 1, 9, 10);
      const code = 'ENC-0000-0000-0000';
      expect((await handleRedeem({ installId: laptop(), code }, kj, ip, at(nine))).status).toBe(400);
      expect((await handleRedeem({ installId: laptop(), code }, kj, ip, at(nine + 40 * 60_000))).status).toBe(429);
      expect((await handleRedeem({ installId: laptop(), code }, kj, ip, at(nine + 60 * 60_000))).status).toBe(400);
    });
  });
});

describe('reading the database’s answer', () => {
  it('turns column names and ISO dates into what the service uses', () => {
    expect(
      toSnapshot({
        license: { app_forever: true, cloud_until: '2027-05-03T12:00:00.250000+00:00', cloud_forever: false, trial_ends_at: null, owner: false },
        grants: [{ grants: 'cloud_year', redeemedAt: '2026-10-05T09:30:00+00:00' }],
        installHadTrial: true,
      }),
    ).toEqual({
      license: { appForever: true, cloudUntil: Date.UTC(2027, 4, 3, 12, 0, 0, 250), cloudForever: false, trialEndsAt: null, owner: false },
      grants: [{ grants: 'cloud_year', redeemedAt: Date.UTC(2026, 9, 5, 9, 30) }],
      installHadTrial: true,
    });
    expect(toSnapshot({ license: null, grants: null, installHadTrial: false })).toEqual({ license: null, grants: [], installHadTrial: false });
  });
});
