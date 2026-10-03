// YouTube lookups. Searching needs a YouTube Data API v3 key (each search
// costs 100 of the default 10,000 daily quota units, so results are cached).
// Without a key, singers and the KJ can still paste a link: oEmbed gives us
// the title with no key at all.

import type { SearchResult, Song } from '../shared/types.ts';
import { decodeEntities, parseIsoDuration, parseYouTubeTitle } from '../shared/text.ts';

const CACHE_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 500;

export class YouTube {
  private cache = new Map<string, { at: number; results: SearchResult[] }>();

  constructor(
    private apiKey: string | undefined,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get canSearch(): boolean {
    return Boolean(this.apiKey);
  }

  setApiKey(key: string | undefined): void {
    this.apiKey = key || undefined;
    this.cache.clear();
  }

  async search(query: string): Promise<SearchResult[]> {
    if (!this.apiKey) throw new Error('YouTube search needs an API key (Settings → YouTube).');
    const q = query.trim().slice(0, 120);
    const key = q.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;

    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '15',
      q: /karaoke/i.test(q) ? q : `${q} karaoke`,
      key: this.apiKey,
    });
    const res = await this.fetchImpl(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!res.ok) throw new Error(await apiError(res));
    const body = (await res.json()) as {
      items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url: string }> } }[];
    };
    const items = (body.items ?? []).filter((i) => i.id?.videoId);
    const durations = await this.durations(items.map((i) => i.id!.videoId!));
    const results = items.map<SearchResult>((i) => {
      const videoId = i.id!.videoId!;
      const channel = decodeEntities(i.snippet?.channelTitle ?? '');
      const { artist, title } = parseYouTubeTitle(i.snippet?.title ?? '', channel);
      return {
        song: {
          title: title || decodeEntities(i.snippet?.title ?? videoId),
          artist,
          source: { kind: 'youtube', videoId },
          durationSec: durations.get(videoId),
          thumbnail: i.snippet?.thumbnails?.medium?.url ?? i.snippet?.thumbnails?.default?.url,
        },
        detail: channel,
      };
    });
    this.cache.set(key, { at: Date.now(), results });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return results;
  }

  /** One extra unit of quota buys durations for the whole page of results. */
  private async durations(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length || !this.apiKey) return out;
    try {
      const params = new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key: this.apiKey });
      const res = await this.fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${params}`);
      if (!res.ok) return out;
      const body = (await res.json()) as { items?: { id: string; contentDetails?: { duration?: string } }[] };
      for (const v of body.items ?? []) {
        const d = parseIsoDuration(v.contentDetails?.duration ?? '');
        if (d) out.set(v.id, d);
      }
    } catch {
      // Durations only improve wait estimates; never fail a search over them.
    }
    return out;
  }

  /** Title and thumbnail for a pasted link, via oEmbed (no API key needed). */
  async lookup(videoId: string): Promise<Song> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const fallback: Song = {
      title: 'YouTube video',
      artist: '',
      source: { kind: 'youtube', videoId },
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
    try {
      const res = await this.fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
      if (res.status === 401 || res.status === 403) throw new Error('That video does not allow embedding, so it can’t play here.');
      if (res.status === 404 || res.status === 400) throw new Error('That YouTube video could not be found.');
      if (!res.ok) return fallback;
      const body = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
      const { artist, title } = parseYouTubeTitle(body.title ?? '', body.author_name ?? '');
      return { ...fallback, title: title || body.title || fallback.title, artist, thumbnail: body.thumbnail_url ?? fallback.thumbnail };
    } catch (err) {
      if (err instanceof Error && /embedding|could not be found/.test(err.message)) throw err;
      return fallback;
    }
  }
}

async function apiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    const reason = body.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') return 'YouTube search quota is used up for today. Paste a YouTube link instead.';
    if (reason === 'keyInvalid' || res.status === 400) return 'The YouTube API key was rejected. Check it in Settings.';
    return body.error?.message ?? `YouTube search failed (${res.status})`;
  } catch {
    return `YouTube search failed (${res.status})`;
  }
}
