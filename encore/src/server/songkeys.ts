// The original key of each library track, so the KJ can say "play it in G"
// rather than counting semitones. Keys are detected by the console from the
// audio (src/shared/keydetect.ts) or set by the KJ, whose word always wins
// over a detection. Kept on this laptop in data/song-keys.json.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSongKey, type SongKey } from '../shared/songkey.ts';

const MAX_TRACKS = 50_000;

interface Stored {
  tonic: number;
  mode: SongKey['mode'];
  confirmed: boolean;
  at: number;
}

export class SongKeys {
  private keys = new Map<string, Stored>();
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private opts: { dataDir?: string; now?: () => number; log?: (...a: unknown[]) => void } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private get file(): string | undefined {
    return this.opts.dataDir ? join(this.opts.dataDir, 'song-keys.json') : undefined;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { keys?: Record<string, Stored> };
      for (const [id, v] of Object.entries(saved.keys ?? {})) {
        const key = parseSongKey(v);
        if (key && /^[a-f0-9]{16}$/.test(id)) this.keys.set(id, { ...key, confirmed: Boolean(v.confirmed), at: Number(v.at) || 0 });
      }
    } catch {
      // nothing saved yet
    }
  }

  get(trackId: string): SongKey | undefined {
    const k = this.keys.get(trackId);
    return k ? { tonic: k.tonic, mode: k.mode, ...(k.confirmed ? { confirmed: true } : {}) } : undefined;
  }

  /**
   * Record a track's key. A detection never replaces a key that's already
   * known; the KJ's choice replaces anything (null forgets it). Returns
   * whether anything changed.
   */
  set(trackId: string, raw: unknown, how: { detected: boolean }): boolean {
    const old = this.keys.get(trackId);
    if (raw === null) {
      if (how.detected || !old) return false;
      this.keys.delete(trackId);
      this.persist();
      return true;
    }
    const key = parseSongKey(raw);
    if (!key || (how.detected && old)) return false;
    if (old && old.tonic === key.tonic && old.mode === key.mode && old.confirmed === !how.detected) return false;
    this.keys.delete(trackId);
    this.keys.set(trackId, { ...key, confirmed: !how.detected, at: this.now() });
    while (this.keys.size > MAX_TRACKS) this.keys.delete(this.keys.keys().next().value!);
    this.persist();
    return true;
  }

  /** The known keys of these tracks, for a view. */
  pick(trackIds: Iterable<string>): Record<string, SongKey> {
    const out: Record<string, SongKey> = {};
    for (const id of trackIds) {
      const k = this.get(id);
      if (k) out[id] = k;
    }
    return out;
  }

  private persist(): void {
    const file = this.file;
    if (!file) return;
    const run = async () => {
      await mkdir(this.opts.dataDir!, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, keys: Object.fromEntries(this.keys) }));
      await rename(tmp, file);
    };
    this.saving = this.saving.then(run, run).catch((err: Error) => this.opts.log?.(`  Could not save song keys: ${err.message}`));
  }

  flush(): Promise<void> {
    return this.saving;
  }
}
