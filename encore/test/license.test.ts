// The laptop's license (src/server/license.ts): the pass it keeps, checks and renews.
// Runs against a fake Supabase that plays Auth and runs the real license service logic.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Account } from '../src/server/account.ts';
import { License } from '../src/server/license.ts';
import { planSentence } from '../src/shared/license.ts';
import { fakeSupabase, LICENSE_URL, SUPABASE_KEY, SUPABASE_URL, type FakeSupabase } from './fakesupabase.ts';
import { DAY, makeKeys } from './licensekit.ts';
import { memoryWorld, type World } from './licenseworld.ts';

const INSTALL = 'abcdefghijklmnopqrstuv';
let dir: string;
let clock: { t: number };
let world: World;
let keys: Awaited<ReturnType<typeof makeKeys>>;
let fake: FakeSupabase;
const now = () => clock.t;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'encore-license-'));
  clock = { t: Date.UTC(2026, 10, 5, 12, 0, 0) };
  world = memoryWorld({ now });
  keys = await makeKeys();
  fake = fakeSupabase({ world, signing: keys.signing, now });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A laptop: its license and account over one data folder. Call open() to read what was saved, as a start does. */
async function laptop(over: { installId?: string; publicKeys?: { kid: string; key: string }[]; serverClock?: () => number; dataDir?: string } = {}) {
  const dataDir = over.dataDir ?? dir;
  const account = new Account({ dataDir, url: SUPABASE_URL, key: SUPABASE_KEY, fetchImpl: fake.fetch, now });
  let changes = 0;
  const license = new License({
    dataDir,
    installId: over.installId ?? INSTALL,
    account,
    functionUrl: LICENSE_URL,
    key: SUPABASE_KEY,
    publicKeys: over.publicKeys ?? [{ kid: keys.kid, key: keys.publicKey }],
    fetchImpl: fake.fetch,
    now,
    onChange: () => void changes++,
  });
  await license.load();
  return {
    license,
    account,
    changes: () => changes,
    async signIn(email = 'kj@example.com') {
      await license.sendCode(email);
      await license.signIn(email, fake.codeFor(email));
    },
  };
}

const sentence = (l: License) => planSentence({ ...l.view(), showOpen: true });
const asked = () => fake.to('/functions/v1/encore-license').map((c) => c.body?.action);

describe('with nobody signed in', () => {
  it('is signed out, allows nothing, and goes nowhere on its own', async () => {
    const l = await laptop();
    expect(l.license.state()).toBe('signed-out');
    expect(l.license.access()).toEqual({ shows: false, cloud: false });
    expect(l.license.view()).toEqual({ state: 'signed-out', app: false, cloud: false });
    l.license.start();
    await l.license.refresh();
    l.license.stop();
    expect(fake.calls).toHaveLength(0);
  });

  it('can ask for a sign-in code without being signed in', async () => {
    const l = await laptop();
    await l.license.sendCode('kj@example.com');
    expect(fake.to('/auth/v1/otp')).toHaveLength(1);
  });

  it('cannot start a trial or use a code, and says to sign in first', async () => {
    const l = await laptop();
    await expect(l.license.redeem('ENC-0000-0000-0000')).rejects.toMatchObject({ code: 'signed-out', message: 'Sign in to Encore first.' });
    await expect(l.license.startTrial()).rejects.toMatchObject({ code: 'signed-out' });
  });
});

describe('signing in', () => {
  it('starts the free trial by itself: a fortnight of everything', async () => {
    const l = await laptop();
    await l.signIn();
    expect(l.license.state()).toBe('trial');
    expect(l.license.access()).toEqual({ shows: true, cloud: true });
    expect(l.license.view()).toMatchObject({ state: 'trial', email: 'kj@example.com', trialDaysLeft: 14, app: false, cloud: true, source: 'trial' });
    expect(sentence(l.license)).toBe('Free trial: 14 days left.');
    expect(asked()).toEqual(['status', 'startTrial']);
    expect(l.changes()).toBeGreaterThan(0);
    // Every question is for this laptop, with the session's token.
    for (const call of fake.to('/functions/v1/encore-license')) {
      expect(call.body?.installId).toBe(INSTALL);
      expect(call.bearer).toBeTruthy();
    }
  });

  it('counts the days down as they pass', async () => {
    const l = await laptop();
    await l.signIn();
    clock.t += 5 * DAY + 3_600_000;
    expect(l.license.view().trialDaysLeft).toBe(9);
    clock.t += 8 * DAY;
    expect(l.license.view().trialDaysLeft).toBe(1);
    expect(sentence(l.license)).toBe('Free trial: 1 day left.');
  });

  it('keeps what it learned, so a restart with no internet still runs a show', async () => {
    const first = await laptop();
    await first.signIn();
    const calls = fake.calls.length;
    fake.online = false;
    const restarted = await laptop();
    expect(restarted.license.state()).toBe('trial');
    expect(restarted.license.access().shows).toBe(true);
    expect(restarted.license.view().email).toBe('kj@example.com');
    expect(fake.calls).toHaveLength(calls);
  });

  it('keeps the pass out of reach of anyone who can write to the folder but not sign: a changed pass is ignored', async () => {
    const first = await laptop();
    await first.signIn();
    const file = join(dir, 'license.json');
    const saved = JSON.parse(await readFile(file, 'utf8')) as { pass: string };
    const [head, body, sig] = saved.pass.split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...payload, owner: true, app: true, cloudUntil: 'forever' })).toString('base64url');
    await writeFile(file, JSON.stringify({ ...saved, pass: `${head}.${forged}.${sig}` }));
    const restarted = await laptop();
    expect(restarted.license.state()).toBe('signed-out');
    expect(restarted.license.access().shows).toBe(false);
  });

  it('ignores a pass made out to another installation, or signed by a key it does not trust', async () => {
    await (await laptop()).signIn();
    expect((await laptop({ installId: 'a-completely-different-one' })).license.state()).toBe('signed-out');
    const other = await makeKeys();
    expect((await laptop({ publicKeys: [{ kid: other.kid, key: other.publicKey }] })).license.state()).toBe('signed-out');
    expect((await laptop()).license.state()).toBe('trial');
  });

  it('ignores a pass file that is not valid', async () => {
    await writeFile(join(dir, 'license.json'), 'not json at all');
    expect((await laptop()).license.state()).toBe('signed-out');
    await writeFile(join(dir, 'license.json'), JSON.stringify({ pass: 12 }));
    expect((await laptop()).license.state()).toBe('signed-out');
  });

  it('forgets a different KJ’s pass when someone else signs in on this laptop', async () => {
    const a = await laptop();
    await a.signIn('first@example.com');
    await a.license.signOut();
    // Same folder, the saved pass was removed with the sign-out; sign in as someone else.
    const b = await laptop();
    await b.signIn('second@example.com');
    // The laptop already had its trial, under the first email, so the second gets none.
    expect(b.license.state()).toBe('ended');
    expect(b.license.view()).toMatchObject({ email: 'second@example.com' });
    expect(b.license.view().trialAvailable).toBeUndefined();
    expect(sentence(b.license)).toBe('This computer has already had its free trial.');
  });

  it('does not let a wrong code through', async () => {
    const l = await laptop();
    await l.license.sendCode('kj@example.com');
    await expect(l.license.signIn('kj@example.com', '000000')).rejects.toMatchObject({ code: 'bad-code' });
    expect(l.license.state()).toBe('signed-out');
    expect(asked()).toEqual([]);
  });

  it('offers the trial again, in the console, if it could not be started at once', async () => {
    const l = await laptop();
    await l.license.sendCode('kj@example.com');
    const code = fake.codeFor('kj@example.com');
    // Sign in works, then the internet goes before the license service is asked.
    const real = fake.fetch;
    let cut = false;
    const flaky = new Account({ dataDir: dir, url: SUPABASE_URL, key: SUPABASE_KEY, now, fetchImpl: (async (i: string | URL | Request, n?: RequestInit) => (cut && String(i).includes('/functions/') ? Promise.reject(new TypeError('x')) : real(i, n))) as typeof fetch });
    const license = new License({ dataDir: dir, installId: INSTALL, account: flaky, functionUrl: LICENSE_URL, key: SUPABASE_KEY, publicKeys: [{ kid: keys.kid, key: keys.publicKey }], fetchImpl: ((i: string | URL | Request, n?: RequestInit) => (cut ? Promise.reject(new TypeError('x')) : real(i, n))) as typeof fetch, now });
    await license.load();
    cut = false;
    await flaky.verify('kj@example.com', code);
    cut = true;
    await license.refresh();
    expect(license.view()).toMatchObject({ state: 'signed-out', email: 'kj@example.com' });
    expect(license.view().problem).toMatch(/Couldn’t reach Encore/);
    cut = false;
    // Back online, the trial starts from the console's own button.
    await license.refresh();
    expect(license.view().trialAvailable).toBe(true);
    expect(sentence(license)).toBe('Your free trial hasn’t started yet.');
    await license.startTrial();
    expect(license.state()).toBe('trial');
  });
});

describe('when the trial is over', () => {
  it('has the pass go stale at two weeks with no check-in, and says to go online', async () => {
    const l = await laptop();
    await l.signIn();
    fake.online = false;
    clock.t += 14 * DAY;
    expect(l.license.state()).toBe('offline-expired');
    expect(l.license.access()).toEqual({ shows: false, cloud: false });
    expect(sentence(l.license)).toMatch(/connect this laptop to the internet/i);
    await l.license.refresh();
    expect(l.license.state()).toBe('offline-expired');
    expect(l.license.view().problem).toMatch(/Couldn’t reach Encore/);
  });

  it('is renewed by a check-in, which finds the trial over and nothing bought', async () => {
    const l = await laptop();
    await l.signIn();
    clock.t += 15 * DAY;
    expect(l.license.state()).toBe('offline-expired');
    await l.license.refresh();
    expect(l.license.state()).toBe('ended');
    expect(l.license.access()).toEqual({ shows: false, cloud: false });
    expect(sentence(l.license)).toBe('Your free trial ended on 19 November 2026.');
    expect(l.license.view().trialAvailable).toBeUndefined();
  });

  it('checks in by itself every twelve hours while it runs', async () => {
    const l = await laptop();
    await l.signIn();
    const before = fake.to('/functions/v1/encore-license').length;
    l.license.start();
    await new Promise((r) => setTimeout(r, 20));
    l.license.stop();
    expect(fake.to('/functions/v1/encore-license').length).toBe(before + 1); // the check on start
  });
});

describe('unlock codes', () => {
  it('make Encore theirs forever, with Cloud', async () => {
    const l = await laptop();
    await l.signIn();
    await l.license.redeem(await world.makeCode('for Dave'));
    expect(l.license.state()).toBe('licensed');
    expect(l.license.access()).toEqual({ shows: true, cloud: true });
    expect(l.license.view()).toMatchObject({ state: 'licensed', app: true, cloud: true, cloudUntil: 'forever', source: 'code' });
    expect(sentence(l.license)).toBe('Encore is yours forever (unlock code).');
  });

  it('can be typed any which way', async () => {
    const l = await laptop();
    await l.signIn();
    const code = await world.makeCode('typed');
    await l.license.redeem(`  ${code.toLowerCase().replace(/-/g, ' ')}\n`);
    expect(l.license.state()).toBe('licensed');
  });

  it('only for the app leave Cloud out, and the plan says so', async () => {
    const l = await laptop();
    await l.signIn();
    await l.license.redeem(await world.makeCode('app only', 'app'));
    expect(l.license.access()).toEqual({ shows: true, cloud: false });
    expect(sentence(l.license)).toBe('Encore is yours (unlock code). Cloud isn’t included.');
  });

  it('that do not work say why, in the service’s own plain words, and change nothing', async () => {
    const l = await laptop();
    await l.signIn();
    const used = await world.makeCode('used');
    await expect(l.license.redeem('ENC-0000-0000-0000')).rejects.toMatchObject({ code: 'bad-code', message: 'That unlock code isn’t right. Check it and try again.' });
    await expect(l.license.redeem('nonsense')).rejects.toMatchObject({ code: 'bad-code', message: expect.stringMatching(/doesn’t look like an unlock code/) });
    await world.revoke('used');
    await expect(l.license.redeem(used)).rejects.toMatchObject({ code: 'code-off' });
    expect(l.license.state()).toBe('trial');
  });

  it('stop working at the next check-in once the owner turns them off', async () => {
    const l = await laptop();
    await l.signIn();
    await l.license.redeem(await world.makeCode('lent'));
    expect(l.license.state()).toBe('licensed');
    await world.revoke('lent');
    // Nothing changes until the laptop checks in.
    expect(l.license.state()).toBe('licensed');
    await l.license.refresh();
    expect(l.license.state()).toBe('trial');
    clock.t += 14 * DAY + 1;
    await l.license.refresh();
    expect(l.license.state()).toBe('ended');
  });
});

describe('the owner', () => {
  it('has everything once the account is marked, at the next check', async () => {
    const l = await laptop();
    await l.signIn('owner@example.com');
    await world.setOwner('owner@example.com');
    await l.license.refresh();
    expect(l.license.state()).toBe('owner');
    expect(l.license.access()).toEqual({ shows: true, cloud: true });
    expect(sentence(l.license)).toBe('Owner. Everything, forever.');
  });
});

describe('when the license service cannot be reached or does not make sense', () => {
  it('keeps what it has, notes the trouble, and clears it when the next check works', async () => {
    const l = await laptop();
    await l.signIn();
    fake.online = false;
    await l.license.refresh();
    expect(l.license.state()).toBe('trial');
    expect(l.license.view().problem).toMatch(/good until 19 November/);
    await expect(l.license.refresh({ report: true })).rejects.toThrow(/Is this laptop online/);
    fake.online = true;
    await l.license.refresh();
    expect(l.license.view().problem).toBeUndefined();
  });

  it('shrugs off a license service that is down', async () => {
    const l = await laptop();
    await l.signIn();
    fake.overrideLicense(() => Response.json({ ok: false, code: 'server', error: 'boom' }, { status: 500 }));
    await l.license.refresh();
    expect(l.license.state()).toBe('trial');
    expect(l.license.view().problem).toMatch(/had a problem/);
    fake.overrideLicense(() => Response.json({ ok: false, code: 'not-configured', error: 'Licensing isn’t switched on yet.' }, { status: 503 }));
    await l.license.refresh();
    expect(l.license.view().problem).toMatch(/isn’t switched on yet/);
    fake.overrideLicense(() => new Response('<html>bad gateway</html>', { status: 502 }));
    await l.license.refresh();
    expect(l.license.state()).toBe('trial');
  });

  it('does not take a pass made out to another laptop or another KJ', async () => {
    const l = await laptop();
    await l.signIn();
    const before = await readFile(join(dir, 'license.json'), 'utf8');
    for (const wrong of [{ installId: 'another-laptop-entirely-1' }, { sub: '99999999-9999-4999-8999-999999999999' }]) {
      const { signPass } = await import('../supabase/functions/encore-license/pass.ts');
      const { passPayload } = await import('./licensekit.ts');
      const forged = await signPass(passPayload({ installId: INSTALL, sub: l.account.userId!, owner: true, app: true, cloudUntil: 'forever', ...wrong }, clock.t), keys.signing, keys.kid);
      fake.overrideLicense(() => Response.json({ ok: true, pass: forged, trialAvailable: false }));
      await l.license.refresh();
      expect(l.license.state()).toBe('trial');
      expect(l.license.view().problem).toMatch(/couldn’t check/);
    }
    expect(await readFile(join(dir, 'license.json'), 'utf8')).toBe(before);
  });

  it('does not take a pass signed by a key it does not trust', async () => {
    const l = await laptop();
    await l.signIn();
    const stranger = await makeKeys();
    const { signPass } = await import('../supabase/functions/encore-license/pass.ts');
    const { passPayload } = await import('./licensekit.ts');
    const forged = await signPass(passPayload({ installId: INSTALL, sub: l.account.userId!, owner: true, app: true, cloudUntil: 'forever' }, clock.t), stranger.signing, 'k1');
    fake.overrideLicense(() => Response.json({ ok: true, pass: forged, trialAvailable: false }));
    await l.license.refresh();
    expect(l.license.state()).toBe('trial');
  });

  it('gets a fresh token and tries again when the service turns the old one down', async () => {
    const l = await laptop();
    await l.signIn();
    const before = fake.to('/auth/v1/token').length;
    fake.revokeAccessTokens();
    await l.license.refresh({ report: true });
    expect(fake.to('/auth/v1/token')).toHaveLength(before + 1);
    expect(l.license.state()).toBe('trial');
    expect(l.license.view().problem).toBeUndefined();
  });

  it('signs out, and forgets the pass, when the session has ended for good', async () => {
    const l = await laptop();
    await l.signIn();
    fake.revokeAccessTokens();
    fake.endSessions();
    await expect(l.license.refresh({ report: true })).rejects.toMatchObject({ code: 'signed-out' });
    expect(l.license.state()).toBe('signed-out');
    expect(l.account.signedIn).toBe(false);
    await expect(stat(join(dir, 'license.json'))).rejects.toThrow();
  });
});

describe('the computer’s clock', () => {
  it('cannot be turned back to make a pass last longer than it was made for', async () => {
    const l = await laptop();
    await l.signIn();
    clock.t -= 6 * DAY;
    expect(l.license.view().trialDaysLeft).toBe(14);
    expect(l.license.now()).toBeGreaterThanOrEqual(clock.t + 6 * DAY);
  });

  it('being far ahead is called out, rather than leaving every fresh pass looking too old', async () => {
    // The service says it is 20 days earlier than this laptop thinks it is.
    const early = () => clock.t - 20 * DAY;
    fake = fakeSupabase({ world: memoryWorld({ now: early }), signing: keys.signing, now: early });
    const l = await laptop();
    await l.license.sendCode('kj@example.com');
    await l.license.signIn('kj@example.com', fake.codeFor('kj@example.com'));
    expect(l.license.view().problem).toMatch(/date and time look wrong/);
    expect(l.license.state()).toBe('offline-expired');
  });
});

describe('signing out', () => {
  it('forgets the pass and the session, on this laptop and with the server', async () => {
    const l = await laptop();
    await l.signIn();
    await l.license.signOut();
    expect(l.license.state()).toBe('signed-out');
    expect(l.license.view()).toEqual({ state: 'signed-out', app: false, cloud: false });
    await expect(stat(join(dir, 'license.json'))).rejects.toThrow();
    await expect(stat(join(dir, 'account.json'))).rejects.toThrow();
    expect(fake.to('/auth/v1/logout')).toHaveLength(1);
    expect((await laptop()).license.state()).toBe('signed-out');
  });
});
