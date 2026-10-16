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

describe('Library.browse', () => {
  function lib(): Library {
    const l = new Library();
    l.addForTest([
      { path: '/lib/Toto - Africa.mp4', format: 'video' },
      { path: '/lib/Toto - Africa.mp3', format: 'audio' }, // the same song as a plain audio file
      { path: '/lib/Adele - Hello.mp4', format: 'video' },
      { path: '/lib/Queen - Bohemian Rhapsody.mp4', format: 'video' },
      { path: '/lib/Queen - Another One Bites The Dust.mp4', format: 'video' },
      { path: '/lib/10cc - Im Not In Love.mp4', format: 'video' },
      { path: '/lib/Zebra - Stripes.mp4', format: 'video' },
    ]);
    return l;
  }
  const names = (r: ReturnType<Library['browse']>) => r.items.map((i) => `${i.song.artist} - ${i.song.title}`);

  it('lists every song once, by artist or by title, with the best file for each', () => {
    const l = lib();
    const byArtist = l.browse({ sort: 'artist', limit: 100 });
    expect(names(byArtist)).toEqual([
      '10cc - Im Not In Love',
      'Adele - Hello',
      'Queen - Another One Bites The Dust',
      'Queen - Bohemian Rhapsody',
      'Toto - Africa',
      'Zebra - Stripes',
    ]);
    expect(byArtist.total).toBe(6);
    const africa = byArtist.items.find((i) => i.song.title === 'Africa')!;
    expect(africa.song.source).toMatchObject({ kind: 'local', format: 'video' });
    expect(names(l.browse({ sort: 'title', limit: 100 }))).toEqual([
      'Toto - Africa',
      'Queen - Another One Bites The Dust',
      'Queen - Bohemian Rhapsody',
      'Adele - Hello',
      '10cc - Im Not In Love',
      'Zebra - Stripes',
    ]);
  });

  it('pages through the list and jumps to a letter', () => {
    const l = lib();
    const first = l.browse({ sort: 'artist', limit: 2 });
    expect(names(first)).toEqual(['10cc - Im Not In Love', 'Adele - Hello']);
    expect(first.letters).toEqual(['#', 'A', 'Q', 'T', 'Z']);
    const second = l.browse({ sort: 'artist', offset: 2, limit: 2 });
    expect(names(second)).toEqual(['Queen - Another One Bites The Dust', 'Queen - Bohemian Rhapsody']);
    expect(l.browse({ sort: 'artist', offset: 99 })).toMatchObject({ items: [], offset: 6, total: 6 });
    expect(l.browse({ sort: 'artist', letter: 'T' })).toMatchObject({ offset: 4 });
    expect(l.browse({ sort: 'artist', letter: 'q' }).offset).toBe(2);
    expect(l.browse({ sort: 'artist', letter: '#' }).offset).toBe(0);
    // A letter with no songs lands on the next one that has some (R -> T).
    expect(l.browse({ sort: 'artist', letter: 'R' }).offset).toBe(4);
    expect(l.browse({ sort: 'artist', limit: -5 }).items).toHaveLength(1);
    expect(l.browse({ sort: 'artist', limit: 0 }).items).toHaveLength(6); // no limit given: a normal page
  });

  it('keeps up when the library changes', () => {
    const l = lib();
    expect(l.browse({ sort: 'artist' }).total).toBe(6);
    l.addForTest([{ path: '/lib/ABBA - Waterloo.mp4', format: 'video' }]);
    const after = l.browse({ sort: 'artist', limit: 100 });
    expect(after.total).toBe(7);
    expect(after.items[1]!.song.artist).toBe('ABBA');
  });

  it('is empty for an empty library', () => {
    expect(new Library().browse({ sort: 'title' })).toEqual({ items: [], total: 0, offset: 0, letters: [] });
  });
});
