// The local karaoke library: scan folders for video files, MP3+G pairs and
// zipped MP3+G tracks, and search them by artist / title / disc id.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import type { BrowseRequest, BrowseResult, LibraryStatus, LibraryTrack, LocalFormat, SearchResult } from '../shared/types.ts';
import { normalize, parseFilename, type FilenameOrder } from '../shared/text.ts';

const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv']);
const AUDIO = new Set(['.mp3', '.m4a', '.ogg', '.wav', '.flac']);

interface Indexed extends LibraryTrack {
  /** Companion file (the .cdg for an MP3+G pair). */
  companion?: string;
  hay: string;
  nTitle: string;
  nArtist: string;
}

export class Library {
  private tracks: Indexed[] = [];
  private byId = new Map<string, Indexed>();
  private status: LibraryStatus = { folders: [], trackCount: 0, scanning: false, errors: [] };
  /** The browse lists (each song once), built when first asked for and dropped when the tracks change. */
  private lists = new Map<'artist' | 'title', { items: Indexed[]; letters: string[]; starts: Map<string, number> }>();

  constructor(private order: FilenameOrder = 'artist-title') {}

  getStatus(): LibraryStatus {
    return { ...this.status, trackCount: this.tracks.length };
  }

  get(id: string): Indexed | undefined {
    return this.byId.get(id);
  }

  /** Every track in one of these formats (the break music folder only wants video and audio). */
  playable(formats: LocalFormat[]): LibraryTrack[] {
    return this.tracks.filter((t) => formats.includes(t.format));
  }

  setOrder(order: FilenameOrder): void {
    this.order = order;
  }

  async scan(folders: string[], onProgress?: () => void): Promise<void> {
    this.status = { ...this.status, folders, scanning: true, errors: [] };
    onProgress?.();
    const found: Indexed[] = [];
    const errors: string[] = [];
    for (const folder of folders) {
      try {
        found.push(...(await this.scanFolder(folder)));
      } catch (err) {
        errors.push(`${folder}: ${(err as Error).message}`);
      }
    }
    found.sort((a, b) => a.nArtist.localeCompare(b.nArtist) || a.nTitle.localeCompare(b.nTitle));
    this.tracks = found;
    this.lists.clear();
    this.byId = new Map(found.map((t) => [t.id, t]));
    this.status = { folders, trackCount: found.length, scanning: false, lastScanAt: Date.now(), errors };
    onProgress?.();
  }

  private async scanFolder(folder: string): Promise<Indexed[]> {
    const dirents = await readdir(folder, { recursive: true, withFileTypes: true });
    // Group files by directory + lowercase stem so .mp3 finds its .cdg.
    const stems = new Map<string, Map<string, string>>();
    for (const d of dirents) {
      if (!d.isFile() || d.name.startsWith('.')) continue;
      const dir = d.parentPath;
      // Skip hidden subfolders, but not a hidden folder the library lives in.
      if (relative(folder, dir).split(/[\\/]/).some((part) => part.startsWith('.'))) continue;
      const ext = extname(d.name).toLowerCase();
      const key = join(dir, basename(d.name, extname(d.name))).toLowerCase();
      let group = stems.get(key);
      if (!group) stems.set(key, (group = new Map()));
      group.set(ext, join(dir, d.name));
    }
    const out: Indexed[] = [];
    for (const group of stems.values()) {
      const cdg = group.get('.cdg');
      let picked: { path: string; format: LocalFormat; companion?: string } | undefined;
      for (const [ext, path] of group) {
        if (VIDEO.has(ext)) {
          picked = { path, format: 'video' };
          break;
        }
      }
      if (!picked && group.has('.zip')) picked = { path: group.get('.zip')!, format: 'zip' };
      if (!picked) {
        const audio = [...group].find(([ext]) => AUDIO.has(ext));
        if (audio) picked = cdg ? { path: audio[1], format: 'mp3+g', companion: cdg } : { path: audio[1], format: 'audio' };
      }
      if (picked) out.push(this.index(picked.path, picked.format, picked.companion));
    }
    return out;
  }

  private index(path: string, format: LocalFormat, companion?: string): Indexed {
    const parsed = parseFilename(basename(path, extname(path)), this.order);
    const id = createHash('sha1').update(path).digest('hex').slice(0, 16);
    const nTitle = normalize(parsed.title);
    const nArtist = normalize(parsed.artist);
    return {
      id,
      path,
      format,
      companion,
      artist: parsed.artist,
      title: parsed.title,
      discId: parsed.discId,
      nTitle,
      nArtist,
      hay: `${nArtist} ${nTitle} ${normalize(parsed.discId ?? '')}`,
    };
  }

  /** Add tracks without touching the disk (tests and the demo library). */
  addForTest(tracks: { path: string; format: LocalFormat; companion?: string }[]): void {
    for (const t of tracks) {
      const ix = this.index(t.path, t.format, t.companion);
      this.tracks.push(ix);
      this.byId.set(ix.id, ix);
    }
    this.lists.clear();
  }

  /**
   * A page of the whole library in order, for a phone to scroll through. Each
   * song shows once (the best file for it) however many files it has.
   */
  browse(req: BrowseRequest): BrowseResult {
    const list = this.list(req.sort === 'title' ? 'title' : 'artist');
    const limit = Math.max(1, Math.min(100, Math.floor(Number(req.limit) || 40)));
    let offset = Math.max(0, Math.floor(Number(req.offset) || 0));
    if (typeof req.letter === 'string' && req.letter) {
      // The first song under that letter, or under the next letter that has any.
      const want = letterOf(req.letter.trim().toLowerCase());
      offset = list.items.length;
      for (const [letter, at] of list.starts) {
        if (letter >= want && at < offset) offset = at;
      }
      if (want === '#') offset = 0;
    }
    offset = Math.min(offset, list.items.length);
    const items = list.items.slice(offset, offset + limit).map((t) => this.toResult(t));
    return { items, total: list.items.length, offset, letters: list.letters };
  }

  private list(sort: 'artist' | 'title') {
    let list = this.lists.get(sort);
    if (list) return list;
    const keyOf = (t: Indexed) => (sort === 'artist' ? t.nArtist || t.nTitle : t.nTitle || t.nArtist);
    const second = (t: Indexed) => (sort === 'artist' ? t.nTitle : t.nArtist);
    // Files of the same song: keep the one search would rank first (video, MP3+G and zip over plain audio).
    const best = new Map<string, Indexed>();
    for (const t of this.tracks) {
      const id = `${t.nArtist}|${t.nTitle}`;
      const have = best.get(id);
      if (!have || rank(t) > rank(have)) best.set(id, t);
    }
    const items = [...best.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || second(a).localeCompare(second(b)) || a.path.localeCompare(b.path));
    const starts = new Map<string, number>();
    items.forEach((t, i) => {
      const letter = letterOf(keyOf(t));
      if (!starts.has(letter)) starts.set(letter, i);
    });
    list = { items, letters: [...starts.keys()], starts };
    this.lists.set(sort, list);
    return list;
  }

  private toResult(t: Indexed): SearchResult {
    return {
      song: { title: t.title, artist: t.artist, source: { kind: 'local', trackId: t.id, format: t.format } },
      detail: [t.discId, FORMAT_LABEL[t.format]].filter(Boolean).join(' · '),
    };
  }

  search(query: string, opts: { limit?: number; dedupe?: boolean } = {}): SearchResult[] {
    const limit = opts.limit ?? 50;
    const q = normalize(query);
    if (!q) return [];
    const tokens = q.split(' ');
    const wordStarts = tokens.map((tok) => new RegExp(`(^| )${tok}`));
    const scored: { t: Indexed; score: number }[] = [];
    for (const t of this.tracks) {
      if (!tokens.every((tok) => t.hay.includes(tok))) continue;
      let score = 0;
      if (t.nTitle === q) score += 6;
      else if (t.nTitle.startsWith(q)) score += 4;
      else if (t.nTitle.includes(q)) score += 2;
      if (t.nArtist === q) score += 3;
      else if (t.nArtist.includes(q)) score += 2;
      for (const re of wordStarts) if (re.test(t.hay)) score += 1;
      if (t.format === 'video' || t.format === 'mp3+g' || t.format === 'zip') score += 0.5;
      scored.push({ t, score });
    }
    scored.sort((a, b) => b.score - a.score || a.t.nArtist.localeCompare(b.t.nArtist) || a.t.nTitle.localeCompare(b.t.nTitle));
    const out: SearchResult[] = [];
    const seen = new Set<string>();
    for (const { t } of scored) {
      if (opts.dedupe) {
        const key = `${t.nArtist}|${t.nTitle}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push({
        song: { title: t.title, artist: t.artist, source: { kind: 'local', trackId: t.id, format: t.format } },
        detail: [t.discId, FORMAT_LABEL[t.format]].filter(Boolean).join(' · '),
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** The jump-bar letter for a sort key: 'A'-'Z', or '#' for digits and anything else. */
function letterOf(key: string): string {
  const c = key.charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

/** Of several files for one song, the one to show: playable video and MP3+G over plain audio. */
function rank(t: Indexed): number {
  return t.format === 'audio' ? 0 : 1;
}

const FORMAT_LABEL: Record<LocalFormat, string> = {
  video: 'Video',
  'mp3+g': 'MP3+G',
  zip: 'MP3+G zip',
  audio: 'Audio only',
};
