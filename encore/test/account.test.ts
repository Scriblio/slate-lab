// The KJ's sign-in on the laptop (src/server/account.ts), against a fake Supabase Auth.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Account, OfflineError } from '../src/server/account.ts';
import { fakeSupabase, SUPABASE_KEY, SUPABASE_URL, type FakeSupabase } from './fakesupabase.ts';
import { DAY, makeKeys } from './licensekit.ts';
import { memoryWorld } from './licenseworld.ts';

let dir: string;
let fake: FakeSupabase;
let clock: { t: number };
let account: Account;
const now = () => clock.t;
const make = () => new Account({ dataDir: dir, url: SUPABASE_URL, key: SUPABASE_KEY, fetchImpl: fake.fetch, now });
const saved = async () => JSON.parse(await readFile(join(dir, 'account.json'), 'utf8')) as { email: string; accessToken: string; refreshToken: string };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'encore-account-'));
  clock = { t: Date.now() };
  const keys = await makeKeys();
  fake = fakeSupabase({ world: memoryWorld({ now }), signing: keys.signing, now });
  account = make();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function signIn(email = 'kj@example.com') {
  await account.sendCode(email);
  return account.verify(email, fake.codeFor(email));
}

describe('asking for a code', () => {
  it('emails one, to the address as the KJ typed it, tidied', async () => {
    await account.sendCode('  KJ@Example.com ');
    expect(fake.to('/auth/v1/otp')).toHaveLength(1);
    expect(fake.to('/auth/v1/otp')[0]!.body).toEqual({ email: 'kj@example.com', create_user: true });
    expect(fake.codeFor('kj@example.com')).toMatch(/^\d{6}$/);
  });

  it('does not bother the server about an address that is not one', async () => {
    for (const bad of ['', 'nobody', 'a@b', '@example.com', 'two words@example.com', `${'x'.repeat(250)}@example.com`]) {
      await expect(account.sendCode(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'bad-email', message: expect.stringMatching(/email address/) });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('says so, in plain words, when too many emails were asked for', async () => {
    fake.emailLimited = true;
    await expect(account.sendCode('kj@example.com')).rejects.toMatchObject({ code: 'rate-limit', message: 'Too many sign-in emails just now. Wait a minute, then try again.' });
  });

  it('says so when the laptop is offline', async () => {
    fake.online = false;
    await expect(account.sendCode('kj@example.com')).rejects.toBeInstanceOf(OfflineError);
    await expect(account.sendCode('kj@example.com')).rejects.toThrow(/Is this laptop online/);
  });
});

describe('signing in with the code', () => {
  it('trades the code for a session and keeps it in the data folder', async () => {
    const session = await signIn('kj@example.com');
    expect(session.email).toBe('kj@example.com');
    expect(account.signedIn).toBe(true);
    expect(account.email).toBe('kj@example.com');
    expect(account.userId).toBe(session.userId);
    expect(await saved()).toMatchObject({ email: 'kj@example.com', accessToken: session.accessToken, refreshToken: session.refreshToken });
    if (process.platform !== 'win32') expect((await stat(join(dir, 'account.json'))).mode & 0o077).toBe(0);
    expect(fake.to('/auth/v1/verify')[0]!.body).toMatchObject({ email: 'kj@example.com', type: 'email' });
  });

  it('takes the code however it was copied: spaces, a dash, a line break', async () => {
    await account.sendCode('kj@example.com');
    const code = fake.codeFor('kj@example.com');
    await account.verify('KJ@example.com ', ` ${code.slice(0, 3)}-${code.slice(3)}\n`);
    expect(account.signedIn).toBe(true);
  });

  it('refuses a wrong code kindly, and a code that is plainly too short without asking the server', async () => {
    await account.sendCode('kj@example.com');
    await expect(account.verify('kj@example.com', '000000')).rejects.toMatchObject({ code: 'bad-code', message: expect.stringMatching(/didn’t work.*Send a new code/) });
    const asked = fake.to('/auth/v1/verify').length;
    await expect(account.verify('kj@example.com', '12')).rejects.toMatchObject({ code: 'bad-code' });
    expect(fake.to('/auth/v1/verify')).toHaveLength(asked);
    expect(account.signedIn).toBe(false);
  });

  it('uses a code once', async () => {
    await account.sendCode('kj@example.com');
    const code = fake.codeFor('kj@example.com');
    await account.verify('kj@example.com', code);
    await expect(make().verify('kj@example.com', code)).rejects.toMatchObject({ code: 'bad-code' });
  });

  it('is remembered by the next start', async () => {
    const session = await signIn();
    const next = make();
    expect(next.signedIn).toBe(false);
    await next.load();
    expect(next.signedIn).toBe(true);
    expect(next.email).toBe('kj@example.com');
    expect(await next.accessToken()).toBe(session.accessToken);
  });

  it('is not remembered from a damaged file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'account.json'), '{"email": "a@b.co"');
    await account.load();
    expect(account.signedIn).toBe(false);
    await writeFile(join(dir, 'account.json'), JSON.stringify({ email: 'a@b.co', accessToken: 5 }));
    await account.load();
    expect(account.signedIn).toBe(false);
  });
});

describe('keeping the session going', () => {
  it('uses the same token while it is fresh', async () => {
    const s = await signIn();
    expect(await account.accessToken()).toBe(s.accessToken);
    expect(await account.accessToken()).toBe(s.accessToken);
    expect(fake.to('/auth/v1/token')).toHaveLength(0);
  });

  it('gets a new one just before the old one runs out, and keeps the new refresh token', async () => {
    const s = await signIn();
    clock.t += 3600_000 - 30_000; // 30 seconds left: inside the minute's margin
    const fresh = await account.accessToken();
    expect(fresh).not.toBe(s.accessToken);
    expect(fake.to('/auth/v1/token')).toHaveLength(1);
    expect((await saved()).refreshToken).not.toBe(s.refreshToken);
    expect((await saved()).accessToken).toBe(fresh);
    // And that new refresh token works in its turn, a long while later.
    clock.t += 5 * DAY;
    expect(await account.accessToken()).not.toBe(fresh);
  });

  it('refreshes once however many ask at once, since a refresh token only works once', async () => {
    await signIn();
    clock.t += 2 * 3600_000;
    const tokens = await Promise.all([account.accessToken(), account.accessToken(), account.accessToken(), account.renew().then((s) => s?.accessToken)]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.to('/auth/v1/token')).toHaveLength(1);
  });

  it('stays signed in when the refresh cannot get through, and says why', async () => {
    await signIn();
    clock.t += 2 * 3600_000;
    fake.online = false;
    await expect(account.accessToken()).rejects.toBeInstanceOf(OfflineError);
    expect(account.signedIn).toBe(true);
    expect(await saved()).toMatchObject({ email: 'kj@example.com' });
    fake.online = true;
    expect(await account.accessToken()).toBeTruthy();
  });

  it('is signed out for good when the server says the session is over, and the file goes', async () => {
    await signIn();
    fake.endSessions();
    clock.t += 2 * 3600_000;
    expect(await account.accessToken()).toBeNull();
    expect(account.signedIn).toBe(false);
    await expect(stat(join(dir, 'account.json'))).rejects.toThrow();
  });

  it('is not signed out by a server hiccup that is not about the session', async () => {
    await signIn();
    clock.t += 2 * 3600_000;
    const real = fake.fetch;
    const broken = new Account({
      dataDir: dir,
      url: SUPABASE_URL,
      key: SUPABASE_KEY,
      now,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => (String(input).includes('/token') ? Response.json({ msg: 'boom' }, { status: 502 }) : real(input, init))) as typeof fetch,
    });
    await broken.load();
    await expect(broken.accessToken()).rejects.toBeInstanceOf(OfflineError);
    expect(broken.signedIn).toBe(true);
  });

  it('has nothing to give when nobody is signed in', async () => {
    expect(await account.accessToken()).toBeNull();
    expect(account.signedIn).toBe(false);
  });
});

describe('signing out', () => {
  it('forgets the session, and tells the server', async () => {
    await signIn();
    await account.signOut();
    expect(account.signedIn).toBe(false);
    await expect(stat(join(dir, 'account.json'))).rejects.toThrow();
    expect(fake.to('/auth/v1/logout')).toHaveLength(1);
    expect(fake.to('/auth/v1/logout')[0]!.bearer).toBeTruthy();
    expect(await account.accessToken()).toBeNull();
  });

  it('works with no internet', async () => {
    await signIn();
    fake.online = false;
    await account.signOut();
    expect(account.signedIn).toBe(false);
    await expect(stat(join(dir, 'account.json'))).rejects.toThrow();
  });
});
