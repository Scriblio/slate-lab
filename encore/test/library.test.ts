import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Library } from '../src/server/library.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'encore-lib-'));
  // The library itself lives under a hidden folder, like ~/.karaoke.
  const lib = join(root, '.karaoke');
  await mkdir(join(lib, 'Pop', '.cache'), { recursive: true });
  await writeFile(join(lib, 'Pop', 'SC1-01 - Adele - Hello.mp4'), '');
  await writeFile(join(lib, 'Pop', 'Toto - Africa.mp3'), '');
  await writeFile(join(lib, 'Pop', 'Toto - Africa.cdg'), '');
  await writeFile(join(lib, 'Pop', 'Backing - Track.mp3'), '');
  await writeFile(join(lib, 'Pop', '.cache', 'Ignored - Song.mp4'), '');
  await writeFile(join(lib, 'notes.txt'), '');
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('Library', () => {
  it('scans a library inside a hidden folder but skips hidden subfolders', async () => {
    const lib = new Library();
    await lib.scan([join(root, '.karaoke')]);
    const status = lib.getStatus();
    expect(status.errors).toEqual([]);
    expect(status.trackCount).toBe(3);
    expect(lib.search('ignored')).toEqual([]);
    const formats = ['hello', 'africa', 'backing'].map((q) => {
      const src = lib.search(q)[0]!.song.source;
      return src.kind === 'local' ? src.format : 'yt';
    });
    expect(formats).toEqual(['video', 'mp3+g', 'audio']);
  });

  it('reports folders it cannot read instead of failing the scan', async () => {
    const lib = new Library();
    await lib.scan([join(root, 'missing'), join(root, '.karaoke')]);
    expect(lib.getStatus().trackCount).toBe(3);
    expect(lib.getStatus().errors[0]).toMatch(/missing/);
  });
});
