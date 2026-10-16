// Two stand-ins for the license database, so the service's rules are tested
// against both: a quick in-memory one, and the real SQL functions running in
// PGlite. They have to agree, which is the point of running every scenario twice.

import { randomUUID } from 'node:crypto';
import { hashCode, normalizeCode } from '../supabase/functions/encore-license/codes.ts';
import type { Grant, LicenseRow, RedeemResult, Snapshot, Store, TrialResult } from '../supabase/functions/encore-license/core.ts';
import { toSnapshot, type RawSnapshot } from '../supabase/functions/encore-license/store.ts';
import { DAY } from './licensekit.ts';
import { openLicenseDb } from './licensedb.ts';

export interface Kj {
  userId: string;
  email: string;
}

export interface World {
  name: string;
  store: Store;
  /** A KJ with an account. */
  kj(email: string): Promise<Kj>;
  /** Make an unlock code the way the owner does. */
  makeCode(note: string, grants?: Grant, maxUses?: number, expiresInDays?: number | null): Promise<string>;
  revoke(codeOrNote: string): Promise<void>;
  /** Make a code run out, as if its date had passed. */
  expireCode(note: string): Promise<void>;
  setOwner(email: string): Promise<void>;
  /** Move the end of someone's trial. */
  endTrialAt(userId: string, ms: number): Promise<void>;
  /** What a purchase would set (the payment step isn't built; this is how a test stands in for it). */
  purchase(userId: string, fields: { appForever?: boolean; cloudUntil?: number | null; cloudForever?: boolean }): Promise<void>;
  /** Has this laptop's one trial been used? */
  trialsOn(installId: string): Promise<number>;
  close(): Promise<void>;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// --- in memory ------------------------------------------------------------------------

interface CodeRow {
  id: string;
  note: string;
  grants: Grant;
  maxUses: number;
  uses: number;
  revoked: boolean;
  expiresAt: number | null;
}

export function memoryWorld(opts: { now?: () => number } = {}): World {
  const now = opts.now ?? Date.now;
  const users = new Map<string, string>();
  const licenses = new Map<string, LicenseRow>();
  const codes = new Map<string, CodeRow>();
  const redemptions: { codeId: string; userId: string; at: number }[] = [];
  const trials = new Map<string, string | null>();
  const attempts = new Map<string, number>();
  const row = (userId: string): LicenseRow => {
    let r = licenses.get(userId);
    if (!r) licenses.set(userId, (r = { appForever: false, cloudUntil: null, cloudForever: false, trialEndsAt: null, owner: false }));
    return r;
  };

  const store: Store = {
    async snapshot(userId, installId): Promise<Snapshot> {
      const grants = redemptions
        .filter((r) => r.userId === userId)
        .flatMap((r) => {
          const c = [...codes.values()].find((x) => x.id === r.codeId)!;
          return c.revoked ? [] : [{ grants: c.grants, redeemedAt: r.at }];
        });
      return { license: licenses.get(userId) ? { ...licenses.get(userId)! } : null, grants, installHadTrial: trials.has(installId) };
    },
    async startTrial(userId, installId, days): Promise<TrialResult> {
      const lic = row(userId);
      if (lic.owner || lic.appForever) return 'owned';
      if (lic.trialEndsAt !== null) return 'account';
      if (trials.has(installId)) return 'install';
      trials.set(installId, userId);
      lic.trialEndsAt = now() + days * DAY;
      return 'started';
    },
    async redeem(codeHash, userId): Promise<RedeemResult> {
      const c = codes.get(codeHash);
      if (!c) return 'not-found';
      if (c.revoked) return 'revoked';
      if (c.expiresAt !== null && c.expiresAt <= now()) return 'expired';
      if (redemptions.some((r) => r.codeId === c.id && r.userId === userId)) return 'already';
      if (c.uses >= c.maxUses) return 'used-up';
      redemptions.push({ codeId: c.id, userId, at: now() });
      c.uses++;
      return 'ok';
    },
    async take(buckets, window) {
      const key = (b: string) => `${window}/${b}`;
      const full = buckets.find((b) => (attempts.get(key(b.name)) ?? 0) >= b.limit);
      if (full) return full.name;
      for (const b of buckets) attempts.set(key(b.name), (attempts.get(key(b.name)) ?? 0) + 1);
      return null;
    },
    async prune() {},
  };

  return {
    name: 'the in-memory store',
    store,
    async kj(email) {
      const userId = randomUUID();
      users.set(email.toLowerCase(), userId);
      return { userId, email };
    },
    async makeCode(note, grants = 'forever', maxUses = 1, expiresInDays = null) {
      const body = Array.from({ length: 12 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join('');
      const code = normalizeCode(body)!;
      codes.set(await hashCode(code), { id: randomUUID(), note, grants, maxUses, uses: 0, revoked: false, expiresAt: expiresInDays === null ? null : now() + expiresInDays * DAY });
      return code;
    },
    async revoke(codeOrNote) {
      const hash = normalizeCode(codeOrNote) ? await hashCode(normalizeCode(codeOrNote)!) : undefined;
      const hit = [...codes.entries()].filter(([h, c]) => !c.revoked && (h === hash || c.note.trim().toLowerCase() === codeOrNote.trim().toLowerCase()));
      if (!hit.length) throw new Error('No unlock code that is still on matches');
      for (const [, c] of hit) c.revoked = true;
    },
    async expireCode(note) {
      for (const c of codes.values()) if (c.note === note) c.expiresAt = now() - 60_000;
    },
    async setOwner(email) {
      const id = users.get(email.toLowerCase());
      if (!id) throw new Error('Nobody has signed in to Encore with that email');
      row(id).owner = true;
    },
    async endTrialAt(userId, ms) {
      row(userId).trialEndsAt = ms;
    },
    async purchase(userId, f) {
      Object.assign(row(userId), { appForever: f.appForever ?? false, cloudUntil: f.cloudUntil ?? null, cloudForever: f.cloudForever ?? false });
    },
    async trialsOn(installId) {
      return trials.has(installId) ? 1 : 0;
    },
    async close() {},
  };
}

// --- the real SQL ---------------------------------------------------------------------------

export async function sqlWorld(): Promise<World> {
  const t = await openLicenseDb();
  const store: Store = {
    async snapshot(userId, installId) {
      return toSnapshot(await t.value<RawSnapshot>('select license_snapshot($1, $2)', [userId, installId]));
    },
    startTrial: (userId, installId, days) => t.value<TrialResult>('select license_start_trial($1, $2, $3)', [userId, installId, days]),
    redeem: (codeHash, userId, installId) => t.value<RedeemResult>('select license_redeem_code($1, $2, $3)', [codeHash, userId, installId]),
    async take(buckets, window) {
      return (await t.value<string | null>('select license_take($1, $2, $3)', [buckets.map((b) => b.name), buckets.map((b) => b.limit), window])) ?? null;
    },
    async prune() {
      await t.value('select license_prune()');
    },
  };
  return {
    name: 'the real SQL functions',
    store,
    async kj(email) {
      return { userId: await t.addUser(email), email };
    },
    makeCode: (note, grants = 'forever', maxUses = 1, expiresInDays = null) => t.value<string>('select make_unlock_code($1, $2, $3, $4)', [note, grants, maxUses, expiresInDays]),
    async revoke(codeOrNote) {
      await t.value('select revoke_unlock_code($1)', [codeOrNote]);
    },
    async expireCode(note) {
      await t.db.query("update unlock_codes set expires_at = now() - interval '1 minute' where note = $1", [note]);
    },
    async setOwner(email) {
      await t.value('select set_owner($1)', [email]);
    },
    async endTrialAt(userId, ms) {
      await t.db.query('update licenses set trial_ends_at = to_timestamp($2::double precision / 1000) where user_id = $1', [userId, ms]);
    },
    async purchase(userId, f) {
      await t.db.query(
        `insert into licenses (user_id, app_forever, cloud_until, cloud_forever, source) values ($1, $2, case when $3::double precision is null then null else to_timestamp($3::double precision / 1000) end, $4, 'stripe')
         on conflict (user_id) do update set app_forever = excluded.app_forever, cloud_until = excluded.cloud_until, cloud_forever = excluded.cloud_forever`,
        [userId, f.appForever ?? false, f.cloudUntil ?? null, f.cloudForever ?? false],
      );
    },
    async trialsOn(installId) {
      return t.value<number>('select count(*)::int from trials where install_id = $1', [installId]);
    },
    close: () => t.db.close(),
  };
}
