// Keeps YouTube songs that won't play here from reaching the stage.
//
// Some videos that YouTube lists as embeddable still refuse to play inside
// Encore (uploader or label restrictions). The console checks queued videos
// ahead of time in a visible preview player, and the venue screen reports
// refusals it hits at showtime. Either way, Encore remembers the video for
// 30 days (hiding it from searches on this laptop) and swaps the request for
// another version of the same song that does play, telling the singer.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { YOUTUBE_REFUSALS } from '../shared/protocol.ts';
import { normalize } from '../shared/text.ts';
import type { Entry, SearchResult, Song, YouTubeEmbed, YouTubeMode } from '../shared/types.ts';
import type { Show } from './show.ts';

export const REFUSAL_CODES = new Set(YOUTUBE_REFUSALS);

const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const OK_FOR_MS = 12 * 60 * 60 * 1000;
const MAX_REMEMBERED = 2000;
const MAX_SWAPS = 3;

export interface YouTubeGuardDeps {
  dataDir?: string;
  show: Show;
  /** YouTube search (cached), used to find other versions. */
  search: (query: string) => Promise<SearchResult[]>;
  frameUrl?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Why a video is kept off the list: YouTube won't play it here, or the KJ says it isn't karaoke. */
export type BlockReason = 'refused' | 'not-karaoke';

export class YouTubeGuard {
  /** videoId -> when and why it was blocked. Only ids, times and reasons are kept. */
  private refused = new Map<string, { at: number; reason: BlockReason }>();
  private checks = new Map<string, { ok: boolean; mode?: YouTubeMode; at: number }>();
  private swapping = new Set<string>();
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private deps: YouTubeGuardDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get file(): string | undefined {
    return this.deps.dataDir ? join(this.deps.dataDir, 'youtube-refused.json') : undefined;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, number | { at: number; reason: BlockReason }>;
      for (const [id, v] of Object.entries(saved)) {
        // Older files kept only the time of a refusal.
        const entry = typeof v === 'number' ? { at: v, reason: 'refused' as const } : v;
        const reason = entry?.reason === 'not-karaoke' ? 'not-karaoke' : 'refused';
        if (/^[\w-]{11}$/.test(id) && Number.isFinite(entry?.at)) this.refused.set(id, { at: entry.at, reason });
      }
      this.expire();
    } catch {
      // nothing remembered yet
    }
  }

  private save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const data = JSON.stringify(Object.fromEntries(this.refused));
    this.saving = this.saving.then(async () => {
      await mkdir(this.deps.dataDir!, { recursive: true });
      await writeFile(`${file}.tmp`, data);
      await rename(`${file}.tmp`, file);
    });
    return this.saving.catch(() => {});
  }

  private expire(): void {
    const cutoff = this.now() - REMEMBER_MS;
    for (const [id, { at }] of this.refused) if (at < cutoff) this.refused.delete(id);
    while (this.refused.size > MAX_REMEMBERED) this.refused.delete(this.refused.keys().next().value!);
  }

  /** Why a video is kept off the list on this laptop, if it is. */
  blockReason(videoId: string): BlockReason | undefined {
    const b = this.refused.get(videoId);
    return b && this.now() - b.at < REMEMBER_MS ? b.reason : undefined;
  }

  /** Blocked for any reason: hidden from search, turned away when requested, never swapped in. */
  isRefused(videoId: string): boolean {
    return this.blockReason(videoId) !== undefined;
  }

  /** The KJ says this video isn't a karaoke version. */
  async markNotKaraoke(videoId: string): Promise<void> {
    if (!/^[\w-]{11}$/.test(videoId)) return;
    this.refused.delete(videoId);
    this.refused.set(videoId, { at: this.now(), reason: 'not-karaoke' });
    this.checks.delete(videoId);
    this.expire();
    await this.save();
    this.onUpdate?.();
  }

  /** What the console and venue screen need: check results for tonight's YouTube videos. */
  view(): YouTubeEmbed {
    const ids = new Set<string>();
    const { entries, nowPlaying } = this.deps.show.state;
    for (const e of nowPlaying ? [...entries, nowPlaying.entry] : entries) if (e.song.source.kind === 'youtube') ids.add(e.song.source.videoId);
    const status: YouTubeEmbed['status'] = {};
    const modes: YouTubeEmbed['modes'] = {};
    for (const id of ids) {
      if (this.isRefused(id)) status[id] = 'refused';
      const c = this.checks.get(id);
      if (c?.ok && this.now() - c.at < OK_FOR_MS) {
        status[id] = 'ok';
        if (c.mode) modes[id] = c.mode;
      }
    }
    return { frameUrl: this.deps.frameUrl, status, modes };
  }

  /**
   * A video was tried, by the console's preview player or at showtime. A
   * refusal swaps every request for it to another version.
   */
  async report(videoId: string, ok: boolean, mode?: YouTubeMode): Promise<void> {
    if (!/^[\w-]{11}$/.test(videoId)) return;
    if (ok) {
      this.checks.set(videoId, { ok: true, mode: mode === 'site' || mode === 'direct' ? mode : undefined, at: this.now() });
      // It plays after all; a KJ's "not karaoke" still stands.
      if (this.refused.get(videoId)?.reason === 'refused') {
        this.refused.delete(videoId);
        await this.save();
      }
      this.onUpdate?.();
      return;
    }
    this.checks.delete(videoId);
    if (this.refused.get(videoId)?.reason !== 'not-karaoke') {
      this.refused.delete(videoId);
      this.refused.set(videoId, { at: this.now(), reason: 'refused' });
    }
    this.expire();
    await this.save();
    const { entries, nowPlaying } = this.deps.show.state;
    const hit = [...entries, ...(nowPlaying ? [nowPlaying.entry] : [])].filter(
      (e) => e.song.source.kind === 'youtube' && e.song.source.videoId === videoId,
    );
    await Promise.all(hit.map((e) => this.swap(e.id)));
    this.onUpdate?.();
  }

  /** Called when check results change, so consoles can be updated. */
  onUpdate?: () => void;

  /** Find another version of the song that isn't known to be refused, and swap it in. */
  private async swap(entryId: string): Promise<void> {
    if (this.swapping.has(entryId)) return;
    this.swapping.add(entryId);
    try {
      const entry = this.deps.show.findEntry(entryId);
      if (!entry || entry.song.source.kind !== 'youtube') return;
      if ((entry.swaps ?? 0) >= MAX_SWAPS) {
        this.deps.show.markWontPlay(entryId);
        return;
      }
      let results: SearchResult[] = [];
      try {
        results = await this.deps.search(entry.song.title);
      } catch (err) {
        this.deps.log?.(`Couldn’t look for another version of “${entry.song.title}”: ${(err as Error).message}`);
      }
      // The singer's other requests are off limits, so a swap never duplicates one.
      const taken = new Set(
        this.deps.show.state.entries
          .filter((e) => e.singerId === entry.singerId && e.id !== entry.id && e.song.source.kind === 'youtube')
          .map((e) => (e.song.source as { videoId: string }).videoId),
      );
      const current = this.deps.show.findEntry(entryId);
      if (!current || sourceId(current) !== sourceId(entry)) return; // changed meanwhile
      const pick = pickReplacement(entry.song, results, (id) => this.isRefused(id) || taken.has(id));
      if (!pick) {
        this.deps.show.markWontPlay(entryId);
        return;
      }
      this.deps.show.replaceSong(entryId, pick, entry.swappedFrom ?? entry.song.title);
      this.deps.log?.(`YouTube won’t play “${entry.song.title}” here; swapped in “${pick.title}”.`);
    } finally {
      this.swapping.delete(entryId);
    }
  }
}

function sourceId(e: Entry): string {
  return e.song.source.kind === 'youtube' ? e.song.source.videoId : '';
}

// Words that say how a karaoke video was made rather than which song it is.
const NOISE = new Set(
  (
    'karaoke version versions lyrics lyric instrumental official video videos music hd hq 4k 1080p with without backing vocals vocal ' +
    'track tracks original key in the a an of and by style sing along singalong no lead minus one on screen cover audio feat ft ' +
    'mv karafun zoom tyme party channel songs song made famous'
  ).split(' '),
);

/** The words that identify a song in a YouTube title. */
export function songWords(title: string): Set<string> {
  return new Set(normalize(title).split(' ').filter((w) => w && !NOISE.has(w)));
}

/**
 * The best other version of `original` among search results: titles must
 * share most of their identifying words, so "Ever So Sweet" never becomes
 * "So Sweet" by someone else.
 */
export function pickReplacement(original: Song, results: SearchResult[], excluded: (videoId: string) => boolean): Song | undefined {
  if (original.source.kind !== 'youtube') return undefined;
  const originalId = original.source.videoId;
  const want = songWords(original.title);
  let best: { song: Song; score: number } | undefined;
  for (const r of results) {
    const s = r.song;
    if (s.source.kind !== 'youtube' || s.source.videoId === originalId || excluded(s.source.videoId)) continue;
    const have = songWords(s.title);
    const shared = [...want].filter((w) => have.has(w)).length;
    const smaller = Math.min(want.size, have.size);
    const enough = want.size === 1 && have.size === 1 ? shared === 1 : shared >= 2;
    if (!enough || smaller === 0) continue;
    const score = shared / smaller;
    if (score >= 0.75 && (!best || score > best.score)) best = { song: s, score };
  }
  return best?.song;
}
