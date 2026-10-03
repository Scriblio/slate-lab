// YouTube search for every copy of Encore, through Scriblio's one YouTube API
// key. YouTube's developer policies allow one API project per app and forbid
// handing its key out, so KJs never need a key of their own: their laptops
// ask this function instead.
//
// What keeps the shared daily quota (10,000 units, about 99 searches) going:
//   - a shared cache: results stay fresh for 7 days, and up to 30 days old
//     (the policies' storage limit) they are a fallback when the quota is out;
//   - daily caps on uncached searches: overall, per installation and per
//     network address (stored only as a hash that changes every day).
//
// Titles are passed through exactly as YouTube returns them; the policies
// forbid modifying search results.
//
// Plain TypeScript with no Deno or npm imports, so the tests run it in Node.

export interface VideoResult {
  videoId: string;
  title: string;
  channel: string;
  thumbnail?: string;
  durationSec?: number;
}

export interface CacheRow {
  results: VideoResult[];
  fetchedAt: number;
}

export interface Store {
  getCache(key: string): Promise<CacheRow | null>;
  putCache(key: string, results: VideoResult[], fetchedAt: number): Promise<void>;
  /** Count one search against every bucket if all are under their limit; returns the first full bucket, or null. */
  take(buckets: { name: string; limit: number }[], day: string): Promise<string | null>;
  /** Forget results older than 30 days and old usage counters. */
  prune(): Promise<void>;
}

export interface Limits {
  global: number;
  perInstall: number;
  perIp: number;
}

export interface Deps {
  store: Store;
  fetch: typeof fetch;
  /** Unset until the YOUTUBE_API_KEY secret is added. */
  apiKey?: string;
  limits: Limits;
  now?: () => number;
  random?: () => number;
}

export interface Reply {
  status: number;
  body: { ok: true; results: VideoResult[]; cached?: 'fresh' | 'stale' } | { ok: false; error: string; code: string };
}

const DAY = 24 * 60 * 60 * 1000;
export const FRESH_MS = 7 * DAY;
export const MAX_AGE_MS = 30 * DAY;

export const DEFAULT_LIMITS: Limits = { global: 90, perInstall: 60, perIp: 90 };

const LINK_HINT = 'You can still paste a YouTube link.';

export async function handleSearch(input: unknown, ip: string, deps: Deps): Promise<Reply> {
  const now = (deps.now ?? Date.now)();
  const body = (input ?? {}) as { q?: unknown; installId?: unknown };
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  const installId = typeof body.installId === 'string' ? body.installId : '';
  if (!q || q.length > 100) return fail(400, 'bad-request', 'Search for a song or artist (up to 100 characters).');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(installId)) return fail(400, 'bad-request', 'Update Encore to search YouTube.');

  const search = searchText(q);
  const key = search.toLowerCase();
  if ((deps.random ?? Math.random)() < 0.02) await deps.store.prune().catch(() => {});

  const cached = await deps.store.getCache(key).catch(() => null);
  const age = cached ? now - cached.fetchedAt : Infinity;
  if (cached && age < FRESH_MS) return ok(cached.results, 'fresh');
  const fallback = cached && age < MAX_AGE_MS ? cached.results : null;

  if (!deps.apiKey) return fallback ? ok(fallback, 'stale') : fail(503, 'not-configured', `YouTube search isn’t switched on yet. ${LINK_HINT}`);

  const day = pacificDay(now);
  const full = await deps.store.take(
    [
      { name: 'global', limit: deps.limits.global },
      { name: `install:${installId}`, limit: deps.limits.perInstall },
      { name: `ip:${await hash(`${ip}|${day}`)}`, limit: deps.limits.perIp },
    ],
    day,
  );
  if (full) {
    if (fallback) return ok(fallback, 'stale');
    return full === 'global'
      ? fail(429, 'limit', `YouTube search is very busy today. ${LINK_HINT}`)
      : fail(429, 'limit', `This laptop has used today’s YouTube searches. They reset at midnight Pacific time. ${LINK_HINT}`);
  }

  let results: VideoResult[];
  try {
    results = await searchYouTube(deps.fetch, deps.apiKey, search);
  } catch (err) {
    console.error('YouTube search failed:', err instanceof Error ? err.message : err);
    if (fallback) return ok(fallback, 'stale');
    const quota = err instanceof YouTubeError && err.reason === 'quota';
    return fail(503, quota ? 'limit' : 'upstream', quota ? `YouTube search is very busy today. ${LINK_HINT}` : `YouTube search isn’t answering right now. ${LINK_HINT}`);
  }
  await deps.store.putCache(key, results, now).catch(() => {});
  return ok(results);
}

/** What actually gets searched: the query, nudged toward karaoke versions. */
export function searchText(q: string): string {
  const t = q.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /karaoke/i.test(t) ? t : `${t} karaoke`;
}

/** YouTube's quota resets at midnight Pacific time, so the counters do too. */
export function pacificDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

async function hash(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

class YouTubeError extends Error {
  constructor(
    message: string,
    readonly reason: 'quota' | 'key' | 'other',
  ) {
    super(message);
  }
}

async function searchYouTube(fetchImpl: typeof fetch, apiKey: string, q: string): Promise<VideoResult[]> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    maxResults: '15',
    q,
    key: apiKey,
  });
  const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw await youtubeError(res);
  const body = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string }> } }[];
  };
  const items = (body.items ?? []).filter((i) => typeof i.id?.videoId === 'string' && /^[\w-]{11}$/.test(i.id.videoId));
  const durations = new Map<string, number>();
  if (items.length) {
    try {
      const p = new URLSearchParams({ part: 'contentDetails', id: items.map((i) => i.id!.videoId!).join(','), key: apiKey });
      const r = await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${p}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const b = (await r.json()) as { items?: { id: string; contentDetails?: { duration?: string } }[] };
        for (const v of b.items ?? []) {
          const d = isoSeconds(v.contentDetails?.duration ?? '');
          if (d) durations.set(v.id, d);
        }
      }
    } catch {
      // Durations only sharpen wait estimates.
    }
  }
  return items.map((i) => ({
    videoId: i.id!.videoId!,
    title: decodeEntities(i.snippet?.title ?? ''),
    channel: decodeEntities(i.snippet?.channelTitle ?? ''),
    thumbnail: i.snippet?.thumbnails?.medium?.url ?? i.snippet?.thumbnails?.default?.url,
    durationSec: durations.get(i.id!.videoId!),
  }));
}

async function youtubeError(res: Response): Promise<YouTubeError> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? '';
  const kind = /quota|rateLimit/i.test(reason) ? 'quota' : /key/i.test(reason) || res.status === 400 ? 'key' : 'other';
  return new YouTubeError(body?.error?.message ?? `YouTube answered ${res.status}`, kind);
}

function isoSeconds(iso: string): number | undefined {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return undefined;
  const [, d = '0', h = '0', min = '0', s = '0'] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s) || undefined;
}

/** The API HTML-escapes titles; undo that so they read exactly as on YouTube. */
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function ok(results: VideoResult[], cached?: 'fresh' | 'stale'): Reply {
  return { status: 200, body: cached ? { ok: true, results, cached } : { ok: true, results } };
}

function fail(status: number, code: string, error: string): Reply {
  return { status, body: { ok: false, code, error } };
}
