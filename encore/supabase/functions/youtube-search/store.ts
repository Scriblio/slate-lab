// The search cache and usage counters, in this project's Postgres through
// its REST API. Uses a secret key, so it runs only inside the function.

import type { CacheRow, Store, VideoResult } from './core.ts';

export function restStore(supabaseUrl: string, secretKey: string, fetchImpl: typeof fetch = fetch): Store {
  const base = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`;
  // New secret keys go in the apikey header only (they aren't JWTs).
  const headers = { apikey: secretKey, 'Content-Type': 'application/json' };

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`database ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  return {
    async getCache(key) {
      const res = await call(`/yt_search_cache?select=results,fetched_at&query_key=eq.${encodeURIComponent(key)}`);
      const [row] = (await res.json()) as { results: VideoResult[]; fetched_at: string }[];
      return row ? ({ results: row.results, fetchedAt: Date.parse(row.fetched_at) } satisfies CacheRow) : null;
    },
    async putCache(key, results, fetchedAt) {
      await call('/yt_search_cache?on_conflict=query_key', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ query_key: key, results, fetched_at: new Date(fetchedAt).toISOString() }),
      });
    },
    async take(buckets, day) {
      const res = await call('/rpc/yt_take', {
        method: 'POST',
        body: JSON.stringify({ p_buckets: buckets.map((b) => b.name), p_limits: buckets.map((b) => b.limit), p_day: day }),
      });
      return ((await res.json()) as string | null) ?? null;
    },
    async prune() {
      await call('/rpc/yt_prune', { method: 'POST', body: '{}' });
    },
  };
}
