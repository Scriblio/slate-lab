// The license service's REST store (supabase/functions/encore-license/store.ts):
// that it asks the database for the functions the migration really defines, by the
// parameter names it really has. The other tests cover what the functions do;
// this one catches a typo between the two.

import { describe, expect, it } from 'vitest';
import { restStore } from '../supabase/functions/encore-license/store.ts';
import { licensingMigration } from './licensedb.ts';

/** Every function the migration creates, with its parameter names. */
function definedFunctions(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of sql.matchAll(/create function public\.(\w+)\(([^)]*)\)/g)) {
    const params = m[2]!
      .split(',')
      .map((p) => p.trim().split(/\s+/)[0]!)
      .filter(Boolean);
    out.set(m[1]!, params);
  }
  return out;
}

describe('the license REST store', () => {
  it('only calls database functions that exist, with parameters they have', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const name = String(url).split('/').pop();
      return Response.json(name === 'license_snapshot' ? { license: null, grants: [], installHadTrial: false } : name === 'license_prune' ? null : name === 'license_take' ? null : 'ok');
    }) as typeof fetch;
    const store = restStore('https://project.supabase.co/', 'sb_secret_test', fetchImpl);
    await store.snapshot('user', 'install');
    await store.startTrial('user', 'install', 14);
    await store.redeem('hash', 'user', 'install');
    await store.take([{ name: 'a', limit: 1 }], '2026-10-05T10:00:00.000Z');
    await store.prune();

    const defined = definedFunctions(licensingMigration());
    expect(calls).toHaveLength(5);
    for (const { url, init } of calls) {
      const name = url.replace('https://project.supabase.co/rest/v1/rpc/', '');
      expect(defined.has(name), `${name} is in the migration`).toBe(true);
      const sent = Object.keys(JSON.parse(String(init.body)));
      expect([...sent].sort(), name).toEqual([...defined.get(name)!].sort());
      expect(init.method).toBe('POST');
    }
  });

  it('sends the secret key as the apikey only, since new secret keys are not JWTs', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return Response.json(null);
    }) as typeof fetch;
    await restStore('https://project.supabase.co', 'sb_secret_test', fetchImpl).prune();
    expect(headers.apikey).toBe('sb_secret_test');
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('turns a database error into an error that does not repeat what was sent', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(restStore('https://project.supabase.co', 'k', fetchImpl).redeem('secret-hash', 'user', 'install')).rejects.toThrow(/database 500: boom/);
  });

  it('maps the take and redeem answers', async () => {
    const answers: unknown[] = ['acct:a', null, 'used-up'];
    const fetchImpl = (async () => Response.json(answers.shift())) as typeof fetch;
    const store = restStore('https://project.supabase.co', 'k', fetchImpl);
    expect(await store.take([{ name: 'acct:a', limit: 1 }], 'w')).toBe('acct:a');
    expect(await store.take([{ name: 'acct:a', limit: 1 }], 'w')).toBeNull();
    expect(await store.redeem('h', 'u', 'i')).toBe('used-up');
  });
});
