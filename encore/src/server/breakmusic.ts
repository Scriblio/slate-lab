// Music and videos for between karaoke songs: a folder of their own that the
// KJ fills, shuffled so nothing repeats until everything has played. The
// server decides what plays and when; the venue screen plays it (audio over
// motion graphics, video full screen) and says when it ends.

import type { BreakStatus, BreakTrack, LibraryTrack } from '../shared/types.ts';
import { Library } from './library.ts';

/** This many tracks in a row that won't play, and it stays quiet until the next break. */
const MAX_FAILURES = 5;

export class BreakMusic {
  /** The folder's files, served like library media (the id is the same kind of hash). */
  readonly library = new Library();
  /** Counts up with every track the screen should start. */
  nonce = 0;
  paused = false;
  private bag: string[] = [];
  private currentId: string | undefined;
  private lastId: string | undefined;
  private failures = 0;
  private gaveUp = false;

  constructor(private random: () => number = Math.random) {}

  async scan(folders: string[], onProgress?: () => void): Promise<void> {
    await this.library.scan(folders, onProgress);
    this.bag = [];
    if (this.currentId && !this.library.get(this.currentId)) this.currentId = undefined;
  }

  private tracks(): LibraryTrack[] {
    // Karaoke files (MP3+G, zips) don't belong here; everything else with sound does.
    return this.library.playable(['video', 'audio']);
  }

  get count(): number {
    return this.tracks().length;
  }

  current(): BreakTrack | null {
    const t = this.currentId && !this.gaveUp ? this.library.get(this.currentId) : undefined;
    return t ? { id: t.id, title: t.title, artist: t.artist, kind: t.format === 'video' ? 'video' : 'audio' } : null;
  }

  /** A break starts (nothing is on stage any more): a fresh track, unpaused. */
  startBreak(): void {
    this.paused = false;
    this.failures = 0;
    this.gaveUp = false;
    this.advance();
  }

  /** The break ends (a song starts). The next break picks a new track. */
  endBreak(): void {
    this.paused = false;
  }

  /** During a break with nothing queued up to play (the folder was rescanned, say): pick something. */
  ensureTrack(): void {
    if (!this.currentId && !this.gaveUp && this.count) this.advance();
  }

  skip(): void {
    this.gaveUp = false;
    this.advance();
  }

  setPaused(paused?: boolean): void {
    this.paused = paused ?? !this.paused;
  }

  /** The screen finished the track it was told to play. */
  ended(nonce: number): boolean {
    if (nonce !== this.nonce || this.gaveUp) return false;
    this.failures = 0;
    this.advance();
    return true;
  }

  /** The screen couldn't play it: move on, but not forever. */
  failed(nonce: number): boolean {
    if (nonce !== this.nonce || this.gaveUp) return false;
    if (++this.failures >= MAX_FAILURES) {
      this.gaveUp = true;
      this.nonce++;
      return true;
    }
    this.advance();
    return true;
  }

  status(on: boolean): BreakStatus {
    const s = this.library.getStatus();
    return { folders: s.folders, tracks: this.count, karaoke: this.library.playable(['mp3+g', 'zip']).length, scanning: s.scanning, errors: s.errors, on, paused: this.paused, track: this.current() };
  }

  private advance(): void {
    this.nonce++;
    const all = this.tracks();
    if (!all.length) {
      this.currentId = undefined;
      return;
    }
    for (let tries = 0; tries < 2; tries++) {
      if (!this.bag.length) this.refill(all);
      let id: string | undefined;
      while ((id = this.bag.pop()) && !this.library.get(id)) {
        // gone since the last scan
      }
      if (id) {
        this.currentId = this.lastId = id;
        return;
      }
    }
    this.currentId = undefined;
  }

  /** Shuffle everything into a new bag, never starting with what just played. */
  private refill(all: LibraryTrack[]): void {
    const ids = all.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
    // The bag is played from the end.
    if (ids.length > 1 && ids[ids.length - 1] === this.lastId) [ids[0], ids[ids.length - 1]] = [ids[ids.length - 1]!, ids[0]!];
    this.bag = ids;
  }
}
