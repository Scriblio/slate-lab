// The YouTube search service (supabase/functions/youtube-search), run in Node
// against an in-memory store and a fake YouTube.

import { describe, expect, it } from 'vitest';
import { FRESH_MS, handleSearch, MAX_AGE_MS, pacificDay, searchText, type Deps, type Store, type VideoResult } from '../supabase/functions/youtube-search/core.ts';

const INSTALL = 'abcdefghijklmnopqrstuv';

function memoryStore() {
  const cache = new Map<string, { results: VideoResult[]; fetchedAt: number }>();
  const usage = new Map<string, number>();
  const store: Store = {
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
  return { store, cache, usage };
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
