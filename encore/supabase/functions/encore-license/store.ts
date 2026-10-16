// The license tables, in this project's Postgres through its REST API. Each store
// method is one database function (migrations/..._licensing.sql), so what has to
// happen together (a code's last use, a laptop's one trial) is decided inside the
// database, not by two trips from here. Uses a secret key, so it runs only inside
// the function.

import type { Grant, RedeemResult, Snapshot, Store, TrialResult } from './core.ts';

/** license_snapshot's answer as the database sends it: column names, ISO dates. */
export interface RawSnapshot {
  license: {
    app_forever: boolean;
    cloud_until: string | null;
    cloud_forever: boolean;
    trial_ends_at: string | null;
    owner: boolean;
  } | null;
  grants: { grants: Grant; redeemedAt: string }[] | null;
  installHadTrial: boolean;
}

export function toSnapshot(raw: RawSnapshot): Snapshot {
  const ms = (iso: string | null) => (iso === null ? null : Date.parse(iso));
  return {
    license: raw.license && {
      appForever: raw.license.app_forever,
      cloudUntil: ms(raw.license.cloud_until),
      cloudForever: raw.license.cloud_forever,
      trialEndsAt: ms(raw.license.trial_ends_at),
      owner: raw.license.owner,
    },
    grants: (raw.grants ?? []).map((g) => ({ grants: g.grants, redeemedAt: Date.parse(g.redeemedAt) })),
    installHadTrial: Boolean(raw.installHadTrial),
  };
}

export function restStore(supabaseUrl: string, secretKey: string, fetchImpl: typeof fetch = fetch): Store {
  const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/rpc`;
  // New secret keys go in the apikey header only (they aren't JWTs).
  const headers = { apikey: secretKey, 'Content-Type': 'application/json' };

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${base}/${name}`, { method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`database ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  return {
    async snapshot(userId, installId) {
      return toSnapshot(await rpc<RawSnapshot>('license_snapshot', { p_user: userId, p_install: installId }));
    },
    startTrial(userId, installId, days) {
      return rpc<TrialResult>('license_start_trial', { p_user: userId, p_install: installId, p_days: days });
    },
    redeem(codeHash, userId, installId) {
      return rpc<RedeemResult>('license_redeem_code', { p_code_hash: codeHash, p_user: userId, p_install: installId });
    },
    async take(buckets, window) {
      return (await rpc<string | null>('license_take', { p_buckets: buckets.map((b) => b.name), p_limits: buckets.map((b) => b.limit), p_window: window })) ?? null;
    },
    async prune() {
      await rpc('license_prune', {});
    },
  };
}
