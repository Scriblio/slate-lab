// The licensing migration's functions and permissions, against a real Postgres.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCode, normalizeCode } from '../supabase/functions/encore-license/codes.ts';
import { openLicenseDb, type TestDb } from './licensedb.ts';

let t: TestDb;
beforeAll(async () => {
  t = await openLicenseDb();
}, 60_000);
afterAll(async () => {
  await t.db.close();
});

const INSTALL = 'abcdefghijklmnopqrstuv';
const FORMAT = /^ENC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const make = (note: string, grants = 'forever', maxUses = 1, days: number | null = null) =>
  t.value<string>('select make_unlock_code($1, $2, $3, $4)', [note, grants, maxUses, days]);
const redeem = async (code: string, user: string, install = INSTALL) => t.value<string>('select license_redeem_code($1, $2, $3)', [await hashCode(normalizeCode(code)!), user, install]);

describe('making unlock codes', () => {
  it('shows a code like ENC-7K4Q-M2XP-9R8T and keeps only its hash', async () => {
    const code = await make('for Dave');
    expect(code).toMatch(FORMAT);
    const [row] = await t.rows<{ code_hash: string; note: string; grants: string; max_uses: number; uses: number; revoked: boolean; expires_at: string | null }>(
      'select * from unlock_codes where note = $1',
      ['for Dave'],
    );
    expect(row).toMatchObject({ note: 'for Dave', grants: 'forever', max_uses: 1, uses: 0, revoked: false, expires_at: null });
    // The hash is the one the service looks up, and nothing readable is kept.
    expect(row!.code_hash).toBe(await hashCode(code));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code.slice(4, 8));
  });

  it('uses 60 random bits: two hundred codes are all different and only use the safe alphabet', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) codes.add(await make(`bulk ${i}`));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(FORMAT);
    // Every one of the 32 symbols turns up across that many characters.
    const seen = new Set([...codes].join('').replace(/ENC|-/g, ''));
    expect(seen.size).toBeGreaterThan(28);
  });

  it('can grant just the app, or a year of Cloud, to several KJs, for a limited time', async () => {
    await make('band', 'app', 3);
    await make('prize', 'cloud_year', 1, 30);
    const rows = await t.rows<{ note: string; grants: string; max_uses: number; days: number | null }>(
      "select note, grants, max_uses, round(extract(epoch from (expires_at - now())) / 86400)::int as days from unlock_codes where note in ('band', 'prize') order by note",
    );
    expect(rows).toEqual([
      { note: 'band', grants: 'app', max_uses: 3, days: null },
      { note: 'prize', grants: 'cloud_year', max_uses: 1, days: 30 },
    ]);
  });

  it('refuses a grant it does not know and a code with no uses', async () => {
    await expect(make('x', 'everything')).rejects.toThrow(/grants must be/);
    await expect(make('x', 'forever', 0)).rejects.toThrow(/max_uses/);
  });

  it('reads codes the way the app does', async () => {
    const typed = ['ENC-7K4Q-M2XP-9R8T', 'enc 7k4q m2xp 9r8t', '7K4QM2XP9R8T', 'ENC-0O0O-1I1L-ABCD', 'ENC-ENC1-ABCD-EFGH', 'ENC1-ABCD-EFGH', 'ENC-7K4Q-M2XP-9R8U', 'ENC-7K4Q', '', ' ', 'hello world 12'];
    for (const input of typed) {
      expect(await t.value('select normalize_unlock_code($1)', [input]), JSON.stringify(input)).toBe(normalizeCode(input));
    }
    expect(await t.value('select normalize_unlock_code(null)')).toBeNull();
  });
});

describe('turning codes off', () => {
  it('works by code, however it is typed, and says how many it turned off', async () => {
    const code = await make('rev by code');
    expect(await t.value('select revoke_unlock_code($1)', [code.toLowerCase().replace(/-/g, ' ')])).toBe(1);
    expect(await t.value("select revoked from unlock_codes where note = 'rev by code'")).toBe(true);
  });

  it('works by note, for every code with that note, ignoring case and spaces', async () => {
    await make('Dave');
    await make('dave');
    await make('Davina');
    expect(await t.value("select revoke_unlock_code('  DAVE ')")).toBe(2);
    expect(await t.rows<{ note: string; revoked: boolean }>("select note, revoked from unlock_codes where lower(note) like 'dav%' order by note")).toEqual([
      { note: 'Dave', revoked: true },
      { note: 'Davina', revoked: false },
      { note: 'dave', revoked: true },
    ]);
  });

  it('finds a note that happens to look like a code', async () => {
    await make('FORDAVESMITH');
    expect(await t.value("select revoke_unlock_code('FORDAVESMITH')")).toBe(1);
  });

  it('complains instead of quietly doing nothing', async () => {
    await expect(t.value("select revoke_unlock_code('nobody at all')")).rejects.toThrow(/No unlock code that is still on matches/);
    await make('once');
    await t.value("select revoke_unlock_code('once')");
    await expect(t.value("select revoke_unlock_code('once')")).rejects.toThrow(/may already be turned off/);
  });
});

describe('marking the owner', () => {
  it('needs the account to exist, then makes it the owner, whatever the capitals', async () => {
    await expect(t.value("select set_owner('nobody@example.com')")).rejects.toThrow(/Nobody has signed in/);
    const id = await t.addUser('boss@example.com');
    expect(await t.value("select set_owner('  Boss@Example.com ')")).toMatch(/is now the owner/);
    expect(await t.rows('select owner, source from licenses where user_id = $1', [id])).toEqual([{ owner: true, source: 'owner' }]);
  });

  it('can be undone', async () => {
    const id = await t.addUser('temp-boss@example.com');
    await t.value("select set_owner('temp-boss@example.com')");
    expect(await t.value("select set_owner('temp-boss@example.com', false)")).toMatch(/no longer the owner/);
    expect(await t.value('select owner from licenses where user_id = $1', [id])).toBe(false);
  });
});

describe('free trials', () => {
  const start = (user: string, install = INSTALL, days = 14) => t.value<string>('select license_start_trial($1, $2, $3)', [user, install, days]);

  it('start once, for fourteen days', async () => {
    const user = await t.addUser('first@example.com');
    expect(await start(user, 'install-for-first-1')).toBe('started');
    const [lic] = await t.rows<{ days: number; source: string }>('select round(extract(epoch from (trial_ends_at - now())) / 86400)::int as days, source from licenses where user_id = $1', [user]);
    expect(lic).toEqual({ days: 14, source: 'trial' });
    expect(await t.value('select count(*)::int from trials where install_id = $1', ['install-for-first-1'])).toBe(1);
  });

  it('are once per account: asking again changes nothing, even from another laptop', async () => {
    const user = await t.addUser('second@example.com');
    expect(await start(user, 'install-second-a')).toBe('started');
    const before = await t.value('select trial_ends_at from licenses where user_id = $1', [user]);
    expect(await start(user, 'install-second-a')).toBe('account');
    expect(await start(user, 'install-second-b')).toBe('account');
    expect(await t.value('select trial_ends_at from licenses where user_id = $1', [user])).toEqual(before);
    expect(await t.value("select count(*)::int from trials where install_id = 'install-second-b'")).toBe(0);
  });

  it('are once per laptop: a new email on the same laptop gets no new trial', async () => {
    const a = await t.addUser('third-a@example.com');
    const b = await t.addUser('third-b@example.com');
    expect(await start(a, 'shared-laptop-123456')).toBe('started');
    expect(await start(b, 'shared-laptop-123456')).toBe('install');
    expect(await t.value('select trial_ends_at from licenses where user_id = $1', [b])).toBeNull();
  });

  it('are not needed by the owner or by someone who already has the app', async () => {
    const owner = await t.addUser('owner-trial@example.com');
    await t.value("select set_owner('owner-trial@example.com')");
    expect(await start(owner, 'owner-laptop-123456')).toBe('owned');
    const buyer = await t.addUser('buyer@example.com');
    await t.db.query('insert into licenses (user_id, app_forever, source) values ($1, true, $2)', [buyer, 'stripe']);
    expect(await start(buyer, 'buyer-laptop-123456')).toBe('owned');
    expect(await t.value("select count(*)::int from trials where install_id in ('owner-laptop-123456', 'buyer-laptop-123456')")).toBe(0);
  });

  it('remember a laptop had one even after the account is deleted', async () => {
    const gone = await t.addUser('gone@example.com');
    await start(gone, 'gone-laptop-1234567');
    await t.db.query('delete from auth.users where id = $1', [gone]);
    expect(await t.value("select user_id from trials where install_id = 'gone-laptop-1234567'")).toBeNull();
    expect(await t.value("select count(*)::int from licenses where user_id = $1", [gone])).toBe(0);
    const again = await t.addUser('gone-again@example.com');
    expect(await start(again, 'gone-laptop-1234567')).toBe('install');
  });
});

describe('redeeming unlock codes', () => {
  it('uses up a single-use code, and says so to the next KJ', async () => {
    const [a, b] = [await t.addUser('r1a@example.com'), await t.addUser('r1b@example.com')];
    const code = await make('single');
    expect(await redeem(code, a)).toBe('ok');
    expect(await redeem(code, b)).toBe('used-up');
    expect(await t.rows('select uses, max_uses from unlock_codes where note = $1', ['single'])).toEqual([{ uses: 1, max_uses: 1 }]);
    expect(await t.value('select count(*)::int from code_redemptions where user_id = $1', [b])).toBe(0);
  });

  it('lets a multi-use code go to as many KJs as it allows', async () => {
    const users = await Promise.all([1, 2, 3].map((n) => t.addUser(`multi${n}@example.com`)));
    const code = await make('multi', 'app', 2);
    expect(await redeem(code, users[0]!)).toBe('ok');
    expect(await redeem(code, users[1]!)).toBe('ok');
    expect(await redeem(code, users[2]!)).toBe('used-up');
    expect(await t.value("select uses from unlock_codes where note = 'multi'")).toBe(2);
  });

  it('does not let one account use a code twice, and says that rather than "used up"', async () => {
    const user = await t.addUser('twice@example.com');
    const code = await make('twice');
    expect(await redeem(code, user)).toBe('ok');
    expect(await redeem(code, user)).toBe('already');
    expect(await t.value("select uses from unlock_codes where note = 'twice'")).toBe(1);
  });

  it('refuses codes that were turned off, have expired, or never existed', async () => {
    const user = await t.addUser('refused@example.com');
    const off = await make('turned off');
    await t.value("select revoke_unlock_code('turned off')");
    expect(await redeem(off, user)).toBe('revoked');
    const old = await make('old');
    await t.db.query("update unlock_codes set expires_at = now() - interval '1 minute' where note = 'old'");
    expect(await redeem(old, user)).toBe('expired');
    expect(await redeem('ENC-0000-0000-0000', user)).toBe('not-found');
    expect(await t.value('select count(*)::int from code_redemptions where user_id = $1', [user])).toBe(0);
  });

  it('records which laptop used it', async () => {
    const user = await t.addUser('where@example.com');
    await redeem(await make('where'), user, 'the-redeeming-laptop-1');
    expect(await t.value('select install_id from code_redemptions where user_id = $1', [user])).toBe('the-redeeming-laptop-1');
  });
});

describe('the snapshot the service reads', () => {
  const snapshot = (user: string, install = INSTALL) => t.value<{ license: Record<string, unknown> | null; grants: { grants: string; redeemedAt: string }[]; installHadTrial: boolean }>('select license_snapshot($1, $2)', [user, install]);

  it('is empty for an account with nothing', async () => {
    const user = await t.addUser('empty@example.com');
    expect(await snapshot(user, 'nothing-here-1234567')).toEqual({ license: null, grants: [], installHadTrial: false });
  });

  it('has the license row, the codes that count, and whether the laptop had a trial', async () => {
    const user = await t.addUser('snap@example.com');
    await t.value('select license_start_trial($1, $2, 14)', [user, 'snap-laptop-1234567']);
    await redeem(await make('snap forever'), user);
    const off = await make('snap off', 'cloud_year');
    await redeem(off, user);
    await t.value("select revoke_unlock_code('snap off')");
    const snap = await snapshot(user, 'snap-laptop-1234567');
    expect(snap.license).toMatchObject({ user_id: user, owner: false, app_forever: false, cloud_forever: false, source: 'trial' });
    // A turned-off code no longer counts.
    expect(snap.grants.map((g) => g.grants)).toEqual(['forever']);
    expect(Date.parse(snap.grants[0]!.redeemedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(snap.installHadTrial).toBe(true);
  });
});

describe('counting tries', () => {
  const take = (buckets: string[], limits: number[], window = '2026-10-05T10:00:00Z') => t.value<string | null>('select license_take($1, $2, $3)', [buckets, limits, window]);

  it('lets each bucket have its limit, then names the one that is full', async () => {
    for (let i = 0; i < 3; i++) expect(await take(['acct:a'], [3])).toBeNull();
    expect(await take(['acct:a'], [3])).toBe('acct:a');
    expect(await t.value("select attempts from license_attempts where bucket = 'acct:a'")).toBe(3);
  });

  it('counts a try against every bucket or none, so a full network does not use up an account', async () => {
    for (let i = 0; i < 2; i++) expect(await take(['acct:b', 'ip:b'], [10, 2])).toBeNull();
    expect(await take(['acct:b', 'ip:b'], [10, 2])).toBe('ip:b');
    expect(await t.value("select attempts from license_attempts where bucket = 'acct:b'")).toBe(2);
  });

  it('starts again each hour', async () => {
    expect(await take(['acct:c'], [1], '2026-10-05T10:00:00Z')).toBeNull();
    expect(await take(['acct:c'], [1], '2026-10-05T10:00:00Z')).toBe('acct:c');
    expect(await take(['acct:c'], [1], '2026-10-05T11:00:00Z')).toBeNull();
  });

  it('refuses mismatched lists', async () => {
    await expect(take(['a', 'b'], [1])).rejects.toThrow(/must match/);
    await expect(take([], [])).rejects.toThrow(/must match/);
  });

  it('forgets old counters', async () => {
    await take(['acct:old'], [5], '2020-01-01T00:00:00Z');
    await t.value('select license_prune()');
    expect(await t.value("select count(*)::int from license_attempts where bucket = 'acct:old'")).toBe(0);
    expect(await t.value("select count(*)::int from license_attempts where bucket = 'acct:a'")).toBe(1);
  });
});

describe('who can touch what', () => {
  const FUNCTIONS = [
    "select license_snapshot('00000000-0000-0000-0000-000000000000', 'x')",
    "select license_start_trial('00000000-0000-0000-0000-000000000000', 'x', 14)",
    "select license_redeem_code('x', '00000000-0000-0000-0000-000000000000', 'x')",
    "select license_take(array['x'], array[1], now())",
    'select license_prune()',
    "select normalize_unlock_code('x')",
    "select hash_unlock_code('x')",
    "select make_unlock_code('sneaky')",
    "select revoke_unlock_code('sneaky')",
    "select set_owner('boss@example.com')",
  ];
  const TABLES = ['unlock_codes', 'code_redemptions', 'trials', 'license_attempts'];

  it.each(['anon', 'authenticated'] as const)('keeps every function away from the %s key', async (role) => {
    for (const sql of FUNCTIONS) {
      await expect(
        t.as(role, () => t.rows(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('keeps every table but the KJ’s own license row away from the public keys', async () => {
    const user = await t.addUser('reader@example.com');
    for (const role of ['anon', 'authenticated'] as const) {
      for (const table of TABLES) await expect(t.as(role, () => t.rows(`select * from ${table}`), user), `${role} ${table}`).rejects.toThrow(/permission denied/);
      await expect(t.as(role, () => t.rows("insert into licenses (user_id, owner) values ('00000000-0000-0000-0000-000000000000', true)"), user)).rejects.toThrow(/permission denied/);
    }
    await expect(t.as('anon', () => t.rows('select * from licenses'))).rejects.toThrow(/permission denied/);
  });

  it('lets a signed-in KJ read their own license row and nobody else’s, and never change it', async () => {
    const [me, other] = [await t.addUser('me@example.com'), await t.addUser('other@example.com')];
    await t.value('select license_start_trial($1, $2, 14)', [me, 'me-laptop-123456789']);
    await t.value('select license_start_trial($1, $2, 14)', [other, 'other-laptop-1234567']);
    const seen = await t.as('authenticated', () => t.rows<{ user_id: string }>('select user_id from licenses'), me);
    expect(seen).toEqual([{ user_id: me }]);
    await expect(t.as('authenticated', () => t.rows('update licenses set owner = true'), me)).rejects.toThrow(/permission denied/);
    await expect(t.as('authenticated', () => t.rows('delete from licenses'), me)).rejects.toThrow(/permission denied/);
    expect(await t.value('select count(*)::int from licenses where owner')).not.toBe(0); // the owner rows from earlier tests are untouched
  });

  it('lets the service run them all', async () => {
    const user = await t.addUser('service@example.com');
    const code = await t.as('service_role', () => t.value<string>("select make_unlock_code('service made')"));
    expect(code).toMatch(FORMAT);
    const hash = await hashCode(code);
    expect(await t.as('service_role', () => t.value('select license_redeem_code($1, $2, $3)', [hash, user, 'x']))).toBe('ok');
    expect(await t.as('service_role', () => t.value('select license_start_trial($1, $2, 14)', [user, 'service-laptop-12345']))).toBe('started');
    expect(await t.as('service_role', () => t.value('select license_snapshot($1, $2)', [user, 'service-laptop-12345']))).toMatchObject({ installHadTrial: true });
  });
});
