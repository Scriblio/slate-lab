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
// forbid modifying search results. Videos that enough KJs reported as not
// playing inside Encore, or as not karaoke, are left out for everyone (see
// handleReport below).
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
  /** Which of these videos enough different networks reported in the last 30 days. */
  blocked(ids: string[], thresholds: ReportThresholds): Promise<Record<string, ReportKind>>;
  /** Record (or refresh) one installation's report about a video. */
  report(videoId: string, kind: ReportKind, reporter: string, network: string): Promise<void>;
  /** The video played after all: forget the "won't play here" reports. */
  clearRefused(videoId: string): Promise<void>;
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
  /** How many different networks must agree to hide a video for everyone. */
  thresholds?: ReportThresholds;
  /** Secret salt for hashing network addresses in reports (kept 30 days, so a daily hash won't do). */
  salt?: string;
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
  const reply = await findResults(input, ip, deps);
  if (!reply.body.ok) return reply;
  // Videos enough KJs found broken or not karaoke are skipped for everyone,
  // as they are found: cached results are filtered on the way out.
  const hidden = await reportedVideos(reply.body.results.map((r) => r.videoId), deps);
  return hidden.size ? { ...reply, body: { ...reply.body, results: reply.body.results.filter((r) => !hidden.has(r.videoId)) } } : reply;
}

async function findResults(input: unknown, ip: string, deps: Deps): Promise<Reply> {
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

// --- shared reports: "won't play here" and "not karaoke" ------------------------------

export type ReportKind = 'refused' | 'not_karaoke';

/** How many different networks must agree before a video is hidden for everyone. */
export interface ReportThresholds {
  refused: number;
  notKaraoke: number;
}

// Two for "won't play here": Encore detects refusals itself, from YouTube's
// player, so they're facts, but the function is public and one forged report
// shouldn't hide a video. Three for "not karaoke", which is a judgement call.
export const DEFAULT_THRESHOLDS: ReportThresholds = { refused: 2, notKaraoke: 3 };

const ID = /^[\w-]{11}$/;
const REPORTS_PER_DAY = { install: 200, ip: 300 };

async function reportedVideos(ids: string[], deps: Deps): Promise<Map<string, ReportKind>> {
  const valid = [...new Set(ids.filter((id) => ID.test(id)))].slice(0, 100);
  if (!valid.length) return new Map();
  const rows = await deps.store.blocked(valid, deps.thresholds ?? DEFAULT_THRESHOLDS).catch(() => ({}) as Record<string, ReportKind>);
  return new Map(Object.entries(rows));
}

export interface ReportReply {
  status: number;
  body: { ok: true } | { ok: false; error: string; code: string };
}

/**
 * POST { action: 'report', installId, videoId, kind }. kind 'plays' means
 * the video played after all, which clears the "won't play here" reports.
 */
export async function handleReport(input: unknown, ip: string, deps: Deps): Promise<ReportReply> {
  const body = (input ?? {}) as { installId?: unknown; videoId?: unknown; kind?: unknown };
  const installId = typeof body.installId === 'string' ? body.installId : '';
  const videoId = typeof body.videoId === 'string' ? body.videoId : '';
  const kind = body.kind;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(installId) || !ID.test(videoId) || (kind !== 'refused' && kind !== 'not_karaoke' && kind !== 'plays')) {
    return { status: 400, body: { ok: false, code: 'bad-request', error: 'Not a report Encore understands.' } };
  }
  const day = pacificDay((deps.now ?? Date.now)());
  const network = await hash(`${ip}|${deps.salt ?? ''}`);
  const full = await deps.store.take(
    [
      { name: `report:install:${installId}`, limit: REPORTS_PER_DAY.install },
      { name: `report:ip:${await hash(`${ip}|${day}`)}`, limit: REPORTS_PER_DAY.ip },
    ],
    day,
  );
  if (full) return { status: 429, body: { ok: false, code: 'limit', error: 'Too many reports today.' } };
  if (kind === 'plays') await deps.store.clearRefused(videoId);
  else await deps.store.report(videoId, kind, await hash(`install|${installId}`), network);
  return { status: 200, body: { ok: true } };
}

export interface CheckReply {
  status: number;
  body: { ok: true; hidden: Record<string, ReportKind> } | { ok: false; error: string; code: string };
}

/** POST { action: 'check', ids }: which of these videos are hidden for everyone, and why. */
export async function handleCheck(input: unknown, deps: Deps): Promise<CheckReply> {
  const ids = (input as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length > 100) return { status: 400, body: { ok: false, code: 'bad-request', error: 'Send up to 100 video ids.' } };
  const hidden = await reportedVideos(ids.filter((x): x is string => typeof x === 'string'), deps);
  return { status: 200, body: { ok: true, hidden: Object.fromEntries(hidden) } };
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
