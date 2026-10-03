// Remembers the key each singer likes for a library song, from night to night
// ("Matt sings Africa two down"), so a regular's request comes up in their key.
// Keyed by the singer's name, compared the way sign-ups compare names, and the
// track. Kept on this laptop only, in data/keys.json, and forgotten after a year
// without use.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clampKey } from '../shared/pitch.ts';
import { nameKey } from '../shared/text.ts';
import type { Song } from '../shared/types.ts';

const YEAR_MS = 365 * 24 * 60 * 60_000;
const MAX_ENTRIES = 5000;

interface Saved {
  version: 1;
  keys: Record<string, { key: number; at: number }>;
}

export class KeyMemory {
  private keys = new Map<string, { key: number; at: number }>();
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private opts: { dataDir?: string; now?: () => number; log?: (...a: unknown[]) => void } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private get file(): string | undefined {
    return this.opts.dataDir ? join(this.opts.dataDir, 'keys.json') : undefined;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Saved;
      const cutoff = this.now() - YEAR_MS;
      for (const [k, v] of Object.entries(saved.keys ?? {})) {
        if (v && typeof v.at === 'number' && v.at > cutoff && clampKey(v.key) !== 0) this.keys.set(k, { key: clampKey(v.key), at: v.at });
      }
    } catch {
      // nothing saved yet
    }
  }

  private id(singerName: string, song: Song): string | undefined {
    const who = nameKey(singerName);
    return who && song.source.kind === 'local' ? `${who}|${song.source.trackId}` : undefined;
  }

  /** The key this singer last used for this song, if it wasn't the original. */
  get(singerName: string, song: Song): number | undefined {
    const id = this.id(singerName, song);
    return id ? this.keys.get(id)?.key : undefined;
  }

  set(singerName: string, song: Song, semitones: number): void {
    const id = this.id(singerName, song);
    if (!id) return;
    const key = clampKey(semitones);
    if (key === 0) {
      if (!this.keys.delete(id)) return;
    } else {
      // Setting the same key again still counts as use, so a regular's key isn't forgotten.
      this.keys.delete(id);
      this.keys.set(id, { key, at: this.now() });
      // Oldest first in insertion order, so trimming drops the least recently changed.
      while (this.keys.size > MAX_ENTRIES) this.keys.delete(this.keys.keys().next().value!);
    }
    this.persist();
  }

  get size(): number {
    return this.keys.size;
  }

  private persist(): void {
    const file = this.file;
    if (!file) return;
    const run = async () => {
      const data: Saved = { version: 1, keys: Object.fromEntries(this.keys) };
      await mkdir(this.opts.dataDir!, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    };
    this.saving = this.saving.then(run, run).catch((err: Error) => this.opts.log?.(`  Could not save key changes: ${err.message}`));
  }

  /** Wait for pending saves (tests, shutdown). */
  flush(): Promise<void> {
    return this.saving;
  }
}
