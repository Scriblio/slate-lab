// YouTube lookups.
//
// Search goes through Encore's own server (a Supabase Edge Function that
// holds Scriblio's one YouTube API key). YouTube's developer policies allow
// exactly one API project per app and forbid sharing its key, so KJs never
// need a key of their own. A YOUTUBE_API_KEY environment variable still
// makes this copy search YouTube directly, which is handy for development.
//
// Titles are shown exactly as YouTube returns them: the policies forbid
// modifying search results. Pasted links need no key at all (oEmbed).

import type { SearchResult, Song } from '../shared/types.ts';
import { decodeEntities, parseIsoDuration } from '../shared/text.ts';

const CACHE_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 500;

export interface YouTubeProxy {
  /** e.g. https://<project>.supabase.co/functions/v1/youtube-search */
  url: string;
  /** The project's publishable key. */
  key: string;
  /** Identifies this installation for fair per-KJ limits. */
  installId: string;
}

/** What the search proxy (and the direct path) return for each video. */
export interface VideoResult {
  videoId: string;
  title: string;
  channel: string;
  thumbnail?: string;
  durationSec?: number;
}

export class YouTube {
  private cache = new Map<string, { at: number; results: SearchResult[] }>();

  constructor(
    private apiKey: string | undefined,
    private fetchImpl: typeof fetch = fetch,
    private proxy?: YouTubeProxy,
  ) {}

  get canSearch(): boolean {
    return Boolean(this.apiKey || this.proxy);
  }

  /** 'own-key' (development), 'built-in' (through Encore's server) or 'off'. */
  get mode(): 'own-key' | 'built-in' | 'off' {
    return this.apiKey ? 'own-key' : this.proxy ? 'built-in' : 'off';
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.canSearch) throw new Error('YouTube search isn’t available in this copy of Encore. Paste a YouTube link instead.');
    const q = query.trim().slice(0, 100);
    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

    const videos = this.apiKey ? await searchDirect(this.fetchImpl, this.apiKey, q) : await this.searchViaProxy(q);
    const results = videos.map(toResult);
    this.cache.set(key, { at: Date.now(), results });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return results;
  }

  private async searchViaProxy(q: string): Promise<VideoResult[]> {
    const { url, key, installId } = this.proxy!;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, installId }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new Error('Couldn’t reach YouTube search. Is this laptop online? You can still paste a YouTube link.');
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; results?: VideoResult[]; error?: string } | null;
    if (!res.ok || !body?.ok) throw new Error(body?.error ?? `YouTube search failed (${res.status}). You can still paste a YouTube link.`);
    return (body.results ?? []).filter((v) => typeof v?.videoId === 'string' && /^[\w-]{11}$/.test(v.videoId));
  }

  /** Title and thumbnail for a pasted link, via oEmbed (no API key needed). */
  async lookup(videoId: string): Promise<SearchResult> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const fallback: SearchResult = toResult({ videoId, title: 'YouTube video', channel: '' });
    try {
      const res = await this.fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (res.status === 401 || res.status === 403) throw new Error('That video does not allow embedding, so it can’t play here.');
      if (res.status === 404 || res.status === 400) throw new Error('That YouTube video could not be found.');
      if (!res.ok) return fallback;
      const body = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      return toResult({
        videoId,
        title: decodeEntities(body.title ?? '') || 'YouTube video',
        channel: decodeEntities(body.author_name ?? ''),
        thumbnail: body.thumbnail_url,
      });
    } catch (err) {
      if (err instanceof Error && /embedding|could not be found/.test(err.message)) throw err;
      return fallback;
    }
  }
}

function toResult(v: VideoResult): SearchResult {
  const song: Song = {
    title: v.title,
    artist: '',
    source: { kind: 'youtube', videoId: v.videoId },
    durationSec: v.durationSec,
    thumbnail: v.thumbnail ?? `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
  };
  return { song, detail: v.channel };
}

/** Development path: call the YouTube Data API directly with a local key. */
async function searchDirect(fetchImpl: typeof fetch, apiKey: string, q: string): Promise<VideoResult[]> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoEmbeddable: 'true',
    maxResults: '15',
    q: /karaoke/i.test(q) ? q : `${q} karaoke`,
    key: apiKey,
  });
  const res = await fetchImpl(`https://www.googleapis.com/youtube/v3/search?${params}`);
  if (!res.ok) throw new Error(await apiError(res));
  const body = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url: string }> } }[];
  };
  const items = (body.items ?? []).filter((i) => i.id?.videoId);
  const durations = new Map<string, number>();
  try {
    const p = new URLSearchParams({ part: 'contentDetails', id: items.map((i) => i.id!.videoId!).join(','), key: apiKey });
    const r = await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${p}`);
    if (r.ok) {
      const b = (await r.json()) as { items?: { id: string; contentDetails?: { duration?: string } }[] };
      for (const v of b.items ?? []) {
        const d = parseIsoDuration(v.contentDetails?.duration ?? '');
        if (d) durations.set(v.id, d);
      }
    }
  } catch {
    // Durations only improve wait estimates.
  }
  return items.map((i) => ({
    videoId: i.id!.videoId!,
    title: decodeEntities(i.snippet?.title ?? ''),
    channel: decodeEntities(i.snippet?.channelTitle ?? ''),
    thumbnail: i.snippet?.thumbnails?.medium?.url ?? i.snippet?.thumbnails?.default?.url,
    durationSec: durations.get(i.id!.videoId!),
  }));
}

async function apiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = body.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') return 'YouTube search quota is used up for today. Paste a YouTube link instead.';
    if (reason === 'keyInvalid' || res.status === 400) return 'The YouTube API key was rejected.';
    return body.error?.message ?? `YouTube search failed (${res.status})`;
  } catch {
    return `YouTube search failed (${res.status})`;
  }
}
