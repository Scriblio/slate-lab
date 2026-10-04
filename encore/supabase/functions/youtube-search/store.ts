// The search cache, usage counters and shared video reports, in this
// project's Postgres through its REST API. Uses a secret key, so it runs only
// inside the function.

import type { CacheRow, ReportKind, Store, VideoResult } from './core.ts';

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
    async blocked(ids, thresholds) {
      const res = await call('/rpc/yt_blocked', {
        method: 'POST',
        body: JSON.stringify({ p_ids: ids, p_refused: thresholds.refused, p_not_karaoke: thresholds.notKaraoke }),
      });
      const rows = (await res.json()) as { video_id: string; kind: ReportKind }[];
      const out: Record<string, ReportKind> = {};
      // "Won't play here" wins over "not karaoke" when both apply.
      for (const r of rows) if (r.kind === 'refused' || !out[r.video_id]) out[r.video_id] = r.kind;
      return out;
    },
    async report(videoId, kind, reporter, network) {
      await call('/yt_reports?on_conflict=video_id,kind,reporter', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ video_id: videoId, kind, reporter, network, reported_at: new Date().toISOString() }),
      });
    },
    async clearRefused(videoId) {
      await call(`/yt_reports?video_id=eq.${encodeURIComponent(videoId)}&kind=eq.refused`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    },
  };
}
