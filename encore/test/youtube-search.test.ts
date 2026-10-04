// The YouTube search service (supabase/functions/youtube-search), run in Node
// against an in-memory store and a fake YouTube.

import { describe, expect, it } from 'vitest';
import {
  FRESH_MS,
  handleCheck,
  handleReport,
  handleSearch,
  MAX_AGE_MS,
  pacificDay,
  searchText,
  handleCatalogTick,
  errorText,
  type CatalogConfig,
  type CatalogState,
  type Deps,
  type ReportKind,
  type StagedVideo,
  type Store,
  type VideoResult,
} from '../supabase/functions/youtube-search/core.ts';

const INSTALL = 'abcdefghijklmnopqrstuv';

function memoryStore() {
  const cache = new Map<string, { results: VideoResult[]; fetchedAt: number }>();
  const usage = new Map<string, number>();
  /** video|kind|reporter -> network */
  const reports = new Map<string, string>();
  const catalog = new Map<string, VideoResult & { at: number }>();
  const staging = new Map<string, StagedVideo & { fetched: boolean }>();
  const job: { state: CatalogState; token: string; config: CatalogConfig } = {
    state: { phase: 'idle' },
    token: 'job-token-123',
    config: { channels: ['@SingKingKaraoke', '@karafun'], keep: 3, unitsPerDay: 2000 },
  };
  const store: Store = {
    async catalogSearch(query, limit) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      return [...catalog.values()]
        .filter((v) => words.every((w) => `${v.title} ${v.channel}`.toLowerCase().includes(w)))
        .slice(0, limit)
        .map(({ at: _at, ...v }) => v);
    },
    async catalogAge() {
      return catalog.size ? Date.now() - Math.min(...[...catalog.values()].map((v) => v.at)) : null;
    },
    async jobGet() {
      return structuredClone(job);
    },
    async jobSave(state) {
      job.state = structuredClone(state);
    },
    async stagingAdd(ids) {
      for (const id of ids) if (!staging.has(id)) staging.set(id, { videoId: id, embeddable: false, fetched: false });
    },
    async stagingPending(limit) {
      return [...staging.values()].filter((v) => !v.fetched).slice(0, limit).map((v) => v.videoId);
    },
    async stagingSet(rows) {
      for (const r of rows) staging.set(r.videoId, { ...r, fetched: true });
    },
    async stagingCommit(keep) {
      const kept = [...staging.values()]
        .filter((v) => v.fetched && v.embeddable && v.title)
        .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
        .slice(0, keep);
      if (!kept.length) return 0;
      catalog.clear();
      for (const v of kept) catalog.set(v.videoId, { videoId: v.videoId, title: v.title!, channel: v.channel!, thumbnail: v.thumbnail, durationSec: v.durationSec, at: Date.now() });
      staging.clear();
      return kept.length;
    },
    async blocked(ids, t) {
      const out: Record<string, ReportKind> = {};
      for (const id of ids)
        for (const kind of ['not_karaoke', 'refused'] as const) {
          const networks = new Set([...reports].filter(([k]) => k.startsWith(`${id}|${kind}|`)).map(([, n]) => n));
          if (networks.size >= (kind === 'refused' ? t.refused : t.notKaraoke)) out[id] = kind;
        }
      return out;
    },
    async report(videoId, kind, reporter, network) {
      reports.set(`${videoId}|${kind}|${reporter}`, network);
    },
    async clearRefused(videoId) {
      for (const k of [...reports.keys()]) if (k.startsWith(`${videoId}|refused|`)) reports.delete(k);
    },
    async getCache(key) {
      return cache.get(key) ?? null;
    },
    async putCache(key, results, fetchedAt) {
      cache.set(key, { results, fetchedAt });
    },
    async take(buckets, day) {
      const full = buckets.find((b) => (usage.get(`${day}/${b.name}`) ?? 0) >= b.limit);
      if (full) return full.name;
      for (const b of buckets) usage.set(`${day}/${b.name}`, (usage.get(`${day}/${b.name}`) ?? 0) + 1);
      return null;
    },
    async prune() {},
  };
  return { store, cache, usage, reports, catalog, staging, job };
}

function fakeYouTube(opts: { quota?: boolean } = {}) {
  const calls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    if (opts.quota) return Response.json({ error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
    if (url.pathname.endsWith('/search'))
      return Response.json({
        items: [
          { id: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'Simon &amp; Garfunkel - The Boxer (Karaoke)', channelTitle: 'Sing King' } },
          { id: { videoId: 'not-an-id' }, snippet: { title: 'junk' } },
        ],
      });
    return Response.json({ items: [{ id: 'aaaaaaaaaaa', contentDetails: { duration: 'PT5M8S' } }] });
  }) as typeof fetch;
  return { impl, calls };
}

function deps(over: Partial<Deps> = {}): Deps & { mem: ReturnType<typeof memoryStore>; yt: ReturnType<typeof fakeYouTube> } {
  const mem = memoryStore();
  const yt = fakeYouTube();
  return { store: mem.store, fetch: yt.impl, apiKey: 'AIzaTest', limits: { global: 90, perInstall: 60, perIp: 90 }, random: () => 1, mem, yt, ...over };
}

describe('YouTube search service', () => {
  it('searches YouTube for karaoke versions and returns titles exactly as YouTube has them', async () => {
    const d = deps();
    const r = await handleSearch({ q: '  the boxer ', installId: INSTALL }, '203.0.113.5', d);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      results: [{ videoId: 'aaaaaaaaaaa', title: 'Simon & Garfunkel - The Boxer (Karaoke)', channel: 'Sing King', thumbnail: undefined, durationSec: 308 }],
    });
    const search = d.yt.calls[0]!;
    expect(search.searchParams.get('q')).toBe('the boxer karaoke');
    expect(search.searchParams.get('videoEmbeddable')).toBe('true');
    expect(search.searchParams.get('key')).toBe('AIzaTest');
  });

  it('answers repeats from the shared cache, whoever asks', async () => {
    const d = deps();
    await handleSearch({ q: 'The Boxer', installId: INSTALL }, '1.1.1.1', d);
    const r = await handleSearch({ q: 'the  boxer', installId: 'zzzzzzzzzzzzzzzzzzzz' }, '2.2.2.2', d);
    expect(r.body).toMatchObject({ ok: true, cached: 'fresh' });
    expect(d.yt.calls.filter((u) => u.pathname.endsWith('/search'))).toHaveLength(1);
    expect(searchText('Karaoke Hello')).toBe('Karaoke Hello');
  });

  it('refreshes week-old results and never serves anything older than 30 days', async () => {
    const d = deps();
    const old = [{ videoId: 'bbbbbbbbbbb', title: 'Old', channel: 'c' }];
    d.mem.cache.set('hello karaoke', { results: old, fetchedAt: Date.now() - FRESH_MS - 1000 });
    expect((await handleSearch({ q: 'hello', installId: INSTALL }, 'ip', d)).body).toMatchObject({ results: [{ videoId: 'aaaaaaaaaaa' }] });

    // When YouTube's quota is gone, recent-enough results stand in...
    const q = deps({ fetch: fakeYouTube({ quota: true }).impl });
    q.mem.cache.set('hello karaoke', { results: old, fetchedAt: Date.now() - FRESH_MS - 1000 });
    expect((await handleSearch({ q: 'hello', installId: INSTALL }, 'ip', q)).body).toEqual({ ok: true, results: old, cached: 'stale' });
    // ...but not once they pass the 30-day limit.
    q.mem.cache.set('hello karaoke', { results: old, fetchedAt: Date.now() - MAX_AGE_MS - 1000 });
    expect((await handleSearch({ q: 'hello', installId: INSTALL }, 'ip', q)).body).toMatchObject({ ok: false, code: 'limit' });
  });

  it('caps each laptop’s uncached searches per day', async () => {
    const d = deps({ limits: { global: 90, perInstall: 2, perIp: 90 } });
    for (const q of ['a', 'b']) expect((await handleSearch({ q, installId: INSTALL }, 'ip', d)).status).toBe(200);
    const r = await handleSearch({ q: 'c', installId: INSTALL }, 'ip', d);
    expect(r).toMatchObject({ status: 429, body: { code: 'limit', error: expect.stringMatching(/This laptop/) } });
    // Cached answers don't count, and other laptops still get through.
    expect((await handleSearch({ q: 'a', installId: INSTALL }, 'ip', d)).status).toBe(200);
    expect((await handleSearch({ q: 'c', installId: 'yyyyyyyyyyyyyyyyyyyy' }, 'ip', d)).status).toBe(200);
  });

  it('keeps network addresses only as a daily hash', async () => {
    const d = deps();
    await handleSearch({ q: 'x', installId: INSTALL }, '198.51.100.7', d);
    const keys = [...d.mem.usage.keys()].join(' ');
    expect(keys).not.toContain('198.51.100.7');
    expect(keys).toMatch(/ip:[0-9a-f]{24}/);
    expect(keys).toContain(pacificDay(Date.now()));
  });

  it('explains itself before the YouTube key is added, and rejects bad input', async () => {
    expect((await handleSearch({ q: 'x', installId: INSTALL }, 'ip', deps({ apiKey: undefined }))).body).toMatchObject({ code: 'not-configured' });
    expect((await handleSearch({ q: '', installId: INSTALL }, 'ip', deps())).status).toBe(400);
    expect((await handleSearch({ q: 'x'.repeat(101), installId: INSTALL }, 'ip', deps())).status).toBe(400);
    expect((await handleSearch({ q: 'x', installId: 'short' }, 'ip', deps())).status).toBe(400);
    expect((await handleSearch(null, 'ip', deps())).status).toBe(400);
  });

  it('counts days in Pacific time, when YouTube resets its quota', () => {
    expect(pacificDay(Date.UTC(2026, 9, 4, 6, 59))).toBe('2026-10-03');
    expect(pacificDay(Date.UTC(2026, 9, 4, 7, 1))).toBe('2026-10-04');
  });
});

describe('shared reports: "won’t play here" and "not karaoke"', () => {
  const VIDEO = 'aaaaaaaaaaa';
  const report = (d: Deps, kind: string, ip: string, install = `${ip.replace(/\D/g, '')}installinstall`.padEnd(16, 'x')) =>
    handleReport({ action: 'report', installId: install, videoId: VIDEO, kind }, ip, d);
  const search = async (d: Deps) => {
    const r = await handleSearch({ q: 'the boxer', installId: INSTALL }, '203.0.113.5', d);
    return r.body.ok ? r.body.results.map((v) => v.videoId) : r.body;
  };

  it('hides a video for everyone once two different networks find it won’t play', async () => {
    const d = deps();
    expect(await search(d)).toEqual([VIDEO]);
    expect((await report(d, 'refused', '198.51.100.1')).status).toBe(200);
    expect(await search(d)).toEqual([VIDEO]); // one report isn't enough
    await report(d, 'refused', '198.51.100.1', 'another-install-same-bar'); // same network again
    expect(await search(d)).toEqual([VIDEO]);
    await report(d, 'refused', '192.0.2.77');
    expect(await search(d)).toEqual([]); // cached results are filtered too
    expect(d.yt.calls.filter((u) => u.pathname.endsWith('/search'))).toHaveLength(1);
    expect((await handleCheck({ action: 'check', ids: [VIDEO, 'bbbbbbbbbbb'] }, d)).body).toEqual({ ok: true, hidden: { [VIDEO]: 'refused' } });
  });

  it('needs three networks for "not karaoke", a judgement call', async () => {
    const d = deps();
    await report(d, 'not_karaoke', '198.51.100.1');
    await report(d, 'not_karaoke', '192.0.2.77');
    expect(await search(d)).toEqual([VIDEO]);
    await report(d, 'not_karaoke', '203.0.113.200');
    expect(await search(d)).toEqual([]);
  });

  it('brings a video back when it plays after all', async () => {
    const d = deps();
    await report(d, 'refused', '198.51.100.1');
    await report(d, 'refused', '192.0.2.77');
    expect(await search(d)).toEqual([]);
    await report(d, 'plays', '203.0.113.9');
    expect(await search(d)).toEqual([VIDEO]);
  });

  it('keeps only hashes of who reported, and turns away nonsense and floods', async () => {
    const d = deps({ salt: 'pepper' });
    await report(d, 'refused', '198.51.100.1');
    const [key, network] = [...d.mem.reports][0]!;
    expect(key).not.toContain('198.51.100.1');
    expect(key).not.toContain('installinstall');
    expect(network).not.toContain('198.51');
    expect((await handleReport({ installId: INSTALL, videoId: 'nope', kind: 'refused' }, '1.2.3.4', d)).status).toBe(400);
    expect((await handleReport({ installId: INSTALL, videoId: VIDEO, kind: 'boring' }, '1.2.3.4', d)).status).toBe(400);
    expect((await handleCheck({ ids: 'x' }, d)).status).toBe(400);
    let last = 200;
    for (let i = 0; i < 201; i++) last = (await handleReport({ installId: INSTALL, videoId: VIDEO, kind: 'refused' }, '1.2.3.4', d)).status;
    expect(last).toBe(429);
  });
});

describe('the karaoke catalog', () => {
  /** A fake YouTube with two channels: Sing King (3 videos over 2 pages) and KaraFun (2 videos). */
  function catalogYouTube(opts: { quotaAfter?: number } = {}) {
    const calls: URL[] = [];
    const videos: Record<string, { title: string; channel: string; views: number; embeddable?: boolean }> = {
      sk000000001: { title: 'Toto - Africa (Karaoke Version)', channel: 'Sing King', views: 900 },
      sk000000002: { title: 'Adele - Hello (Karaoke Version)', channel: 'Sing King', views: 500 },
      sk000000003: { title: 'Queen - Bohemian Rhapsody (Karaoke Version)', channel: 'Sing King', views: 50, embeddable: false },
      kf000000001: { title: 'Toto - Africa | Karaoke Version | KaraFun', channel: 'KaraFun Karaoke', views: 700 },
      kf000000002: { title: 'ABBA - Dancing Queen | Karaoke Version | KaraFun', channel: 'KaraFun Karaoke', views: 100 },
    };
    const impl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url);
      if (opts.quotaAfter !== undefined && calls.length > opts.quotaAfter) {
        return Response.json({ error: { message: 'You have exceeded your quota.', errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
      }
      const p = url.searchParams;
      if (url.pathname.endsWith('/channels')) {
        const handle = p.get('forHandle');
        if (handle === '@NoSuchChannel') return Response.json({ items: [] });
        const sk = handle === '@SingKingKaraoke';
        return Response.json({
          items: [
            {
              snippet: { title: sk ? 'Sing King' : 'KaraFun Karaoke' },
              contentDetails: { relatedPlaylists: { uploads: sk ? 'UUsk' : 'UUkf' } },
              statistics: { videoCount: sk ? '3' : '2' },
            },
          ],
        });
      }
      if (url.pathname.endsWith('/playlistItems')) {
        const pages: Record<string, string[][]> = { UUsk: [['sk000000001', 'sk000000002'], ['sk000000003']], UUkf: [['kf000000001', 'kf000000002']] };
        const list = pages[p.get('playlistId')!]!;
        const page = Number(p.get('pageToken') ?? 0);
        return Response.json({
          items: list[page]!.map((videoId) => ({ contentDetails: { videoId } })),
          ...(page + 1 < list.length ? { nextPageToken: String(page + 1) } : {}),
        });
      }
      if (url.pathname.endsWith('/videos')) {
        return Response.json({
          items: p
            .get('id')!
            .split(',')
            .filter((id) => videos[id])
            .map((id) => {
              const v = videos[id]!;
              return {
                id,
                snippet: { title: v.title, channelTitle: v.channel, liveBroadcastContent: 'none', thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } } },
                contentDetails: { duration: 'PT4M1S' },
                statistics: { viewCount: String(v.views) },
                status: { embeddable: v.embeddable ?? true, privacyStatus: 'public' },
              };
            }),
        });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    return { impl, calls };
  }

  const tick = (d: Deps, token: unknown = 'job-token-123') => handleCatalogTick({ action: 'catalog', token }, d);

  async function runImport(d: Deps, max = 10) {
    let r = await tick(d);
    for (let i = 0; i < max && r.body.ok && r.body.phase !== 'idle'; i++) r = await tick(d);
    return r;
  }

  it('imports the most-viewed playable videos from the channels, cheaply', async () => {
    const yt = catalogYouTube();
    const d = deps({ fetch: yt.impl });
    const r = await runImport(d);
    expect(r.body).toMatchObject({ ok: true, phase: 'idle', kept: 3 });
    // The top 3 by views, leaving out the one that won't embed.
    expect([...d.mem.catalog.keys()].sort()).toEqual(['kf000000001', 'sk000000001', 'sk000000002']);
    expect(d.mem.catalog.get('sk000000001')).toMatchObject({ title: 'Toto - Africa (Karaoke Version)', channel: 'Sing King', durationSec: 241 });
    // 2 channel lookups + 3 list pages + 1 details call: 6 units, versus 100 for one search.
    expect(yt.calls).toHaveLength(6);
    expect(yt.calls.some((u) => u.pathname.endsWith('/search'))).toBe(false);
    // View counts are only used to choose; the catalog doesn't keep them.
    expect(JSON.stringify([...d.mem.catalog.values()])).not.toContain('900');
  });

  it('answers searches from the catalog without using the quota', async () => {
    const yt = catalogYouTube();
    const d = deps({ fetch: yt.impl });
    await runImport(d);
    const before = yt.calls.length;
    const r = await handleSearch({ q: 'toto africa', installId: INSTALL }, '203.0.113.5', d);
    expect(r.body).toMatchObject({ ok: true, cached: 'catalog' });
    expect(r.body.ok && r.body.results.map((v) => v.videoId).sort()).toEqual(['kf000000001', 'sk000000001']);
    expect(yt.calls.length).toBe(before);
    expect(d.mem.usage.size).toBe(0); // nothing counted against anyone's daily cap
    // One match isn't enough choice: YouTube is searched as before.
    const one = await handleSearch({ q: 'adele hello', installId: INSTALL }, '203.0.113.5', d);
    expect(one.body).not.toMatchObject({ cached: 'catalog' });
  });

  it('does nothing while the catalog is fresh, and rebuilds it before 30 days', async () => {
    const yt = catalogYouTube();
    const d = deps({ fetch: yt.impl });
    await runImport(d);
    const calls = yt.calls.length;
    expect((await tick(d)).body).toMatchObject({ ok: true, phase: 'idle' });
    expect(yt.calls.length).toBe(calls);
    for (const v of d.mem.catalog.values()) v.at -= 26 * 24 * 60 * 60 * 1000;
    await tick(d);
    expect(yt.calls.length).toBeGreaterThan(calls);
  });

  it('stays inside its daily budget, and carries on after running out of quota', async () => {
    const d = deps({ fetch: catalogYouTube({ quotaAfter: 3 }).impl });
    const r = await tick(d);
    expect(r.body).toMatchObject({ ok: true, lastError: expect.stringMatching(/quota/) });
    expect(d.mem.catalog.size).toBe(0); // a half-done import never replaces the catalog

    const tight = deps({ fetch: catalogYouTube().impl });
    tight.mem.job.config.unitsPerDay = 2;
    expect((await runImport(tight, 5)).body).toMatchObject({ ok: true, units: 2 });
    expect(tight.mem.job.state.phase).not.toBe('idle');
  });

  it('reports a channel it can’t find, and only answers to its own token', async () => {
    const d = deps({ fetch: catalogYouTube().impl });
    d.mem.job.config.channels = ['@SingKingKaraoke', '@NoSuchChannel'];
    const r = await runImport(d);
    expect(r.body.ok && r.body.channels?.find((c) => c.channel === '@NoSuchChannel')).toMatchObject({ error: 'channel not found' });
    expect(d.mem.catalog.size).toBe(2);
    expect((await tick(d, 'guess')).status).toBe(403);
    expect((await handleCatalogTick({ action: 'catalog' }, d)).status).toBe(403);
  });

  it('never stores the API key in an error, even when a failed fetch names its URL', async () => {
    const leaky = (async (input: string | URL | Request) => {
      throw new TypeError(`error sending request for url (${String(input)})`);
    }) as typeof fetch;
    const d = deps({ fetch: leaky });
    const r = await tick(d);
    expect(r.body).toMatchObject({ ok: true, lastError: expect.stringContaining('key=[key]') });
    expect(JSON.stringify(r.body)).not.toContain('AIzaTest');
    expect(JSON.stringify(d.mem.job.state)).not.toContain('AIzaTest');
    expect(errorText(new Error('https://x/y?part=a&key=AIzaOther&q=b'))).toBe('https://x/y?part=a&key=[key]&q=b');
  });
});
