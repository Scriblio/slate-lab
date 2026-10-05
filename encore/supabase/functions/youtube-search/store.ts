// The search cache, usage counters, shared video reports and the karaoke
// catalog, in this
// project's Postgres through its REST API. Uses a secret key, so it runs only
// inside the function.

import type { CacheRow, CatalogState, ReportKind, Store, VideoResult } from './core.ts';

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
    async catalogSearch(query, limit) {
      const res = await call('/rpc/yt_catalog_search', { method: 'POST', body: JSON.stringify({ p_query: query, p_limit: limit }) });
      const rows = (await res.json()) as { video_id: string; title: string; channel: string; thumbnail: string | null; duration_sec: number | null }[];
      return rows.map((r) => ({ videoId: r.video_id, title: r.title, channel: r.channel, thumbnail: r.thumbnail ?? undefined, durationSec: r.duration_sec ?? undefined }));
    },
    async catalogAge() {
      const res = await call('/rpc/yt_catalog_age', { method: 'POST', body: '{}' });
      const seconds = (await res.json()) as number | null;
      return seconds === null ? null : seconds * 1000;
    },
    async jobGet() {
      const res = await call('/yt_catalog_job?id=eq.1&select=state,token,channels,keep,units_per_day');
      const [row] = (await res.json()) as { state: CatalogState; token: string; channels: string[]; keep: number; units_per_day: number }[];
      if (!row) throw new Error('catalog job row missing');
      return { state: row.state, token: row.token, config: { channels: row.channels, keep: row.keep, unitsPerDay: row.units_per_day } };
    },
    async jobSave(state) {
      await call('/yt_catalog_job?id=eq.1', {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ state, updated_at: new Date().toISOString() }),
      });
    },
    async stagingAdd(ids) {
      await call('/yt_catalog_staging?on_conflict=video_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(ids.map((video_id) => ({ video_id }))),
      });
    },
    async stagingPending(limit) {
      const res = await call(`/yt_catalog_staging?fetched=eq.false&select=video_id&limit=${limit}`);
      return ((await res.json()) as { video_id: string }[]).map((r) => r.video_id);
    },
    async stagingSet(rows) {
      await call('/yt_catalog_staging?on_conflict=video_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(
          rows.map((r) => ({
            video_id: r.videoId,
            title: r.title ?? null,
            channel: r.channel ?? null,
            thumbnail: r.thumbnail ?? null,
            duration_sec: r.durationSec ?? null,
            views: r.views ?? null,
            embeddable: r.embeddable,
            fetched: true,
          })),
        ),
      });
    },
    async stagingCommit(keep) {
      const res = await call('/rpc/yt_catalog_commit', { method: 'POST', body: JSON.stringify({ p_keep: keep }) });
      return (await res.json()) as number;
    },
  };
}
