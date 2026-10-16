import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreakMusic } from '../src/server/breakmusic.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'encore-break-'));
  await mkdir(join(root, 'Chill'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });
  for (const f of ['Lounge Cat - Velvet Hour.mp3', 'Rain Sounds.m4a', 'Chill/Slow Jam.flac', 'Chill/Neon Loop.mp4', 'Party Mix.webm']) await writeFile(join(root, f), '');
  // Karaoke files and other things that aren't break music.
  await writeFile(join(root, 'Karaoke Song.mp3'), '');
  await writeFile(join(root, 'Karaoke Song.cdg'), '');
  await writeFile(join(root, 'Zipped Karaoke.zip'), '');
  await writeFile(join(root, 'notes.txt'), '');
  await writeFile(join(root, '.hidden', 'Secret.mp3'), '');
});

afterAll(() => rm(root, { recursive: true, force: true }));

/** A repeatable "random": cycles through these values. */
const seeded = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

async function loaded(random?: () => number): Promise<BreakMusic> {
  const b = new BreakMusic(random);
  await b.scan([root]);
  return b;
}

/** Play `n` tracks in a row, as the screen would, and return their titles. */
function playThrough(b: BreakMusic, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(b.current()!.title);
    b.ended(b.nonce);
  }
  return out;
}

describe('BreakMusic', () => {
  it('finds the music and videos, and leaves out karaoke files and hidden folders', async () => {
    const b = await loaded();
    expect(b.count).toBe(5);
    b.startBreak();
    const kinds = new Map<string, string>();
    for (let i = 0; i < 5; i++) {
      const t = b.current()!;
      kinds.set(t.title, t.kind);
      b.ended(b.nonce);
    }
    expect([...kinds.entries()].sort()).toEqual([
      ['Neon Loop', 'video'],
      ['Party Mix', 'video'],
      ['Rain Sounds', 'audio'],
      ['Slow Jam', 'audio'],
      ['Velvet Hour', 'audio'],
    ]);
    expect(b.library.playable(['video', 'audio']).find((t) => t.title === 'Velvet Hour')!.artist).toBe('Lounge Cat');
  });

  it('plays everything once before anything repeats, and never the same track twice running', async () => {
    const b = await loaded(seeded([0.1, 0.9, 0.4, 0.7, 0.2, 0.6, 0.3, 0.8]));
    b.startBreak();
    const first = playThrough(b, 5);
    expect(new Set(first).size).toBe(5);
    const second = playThrough(b, 5);
    expect(new Set(second).size).toBe(5);
    expect(second[0]).not.toBe(first[4]);
    for (let round = 0; round < 40; round++) {
      const before = b.current()!.title;
      b.skip();
      expect(b.current()!.title).not.toBe(before);
    }
  });

  it('moves on only for the track the screen is on, and gives up after tracks keep failing', async () => {
    const b = await loaded();
    b.startBreak();
    const n = b.nonce;
    const was = b.current()!.title;
    expect(b.ended(n - 1)).toBe(false); // a late report about an older track
    expect(b.current()!.title).toBe(was);
    expect(b.ended(n)).toBe(true);
    expect(b.nonce).toBe(n + 1);

    // Four failures in a row skip ahead; the fifth stops it until the next break.
    for (let i = 0; i < 4; i++) expect(b.failed(b.nonce)).toBe(true);
    expect(b.current()).not.toBeNull();
    expect(b.failed(b.nonce)).toBe(true);
    expect(b.current()).toBeNull();
    expect(b.failed(b.nonce)).toBe(false);
    b.startBreak();
    expect(b.current()).not.toBeNull();
    // A track that plays resets the count.
    b.failed(b.nonce);
    b.ended(b.nonce);
    for (let i = 0; i < 4; i++) b.failed(b.nonce);
    expect(b.current()).not.toBeNull();
  });

  it('pauses and resumes, and a new break starts unpaused with a fresh track', async () => {
    const b = await loaded();
    b.startBreak();
    b.setPaused();
    expect(b.paused).toBe(true);
    b.setPaused();
    expect(b.paused).toBe(false);
    b.setPaused(true);
    b.endBreak();
    expect(b.paused).toBe(false);
    const nonce = b.nonce;
    b.startBreak();
    expect(b.nonce).toBe(nonce + 1);
    // The karaoke pair and the zip in the folder are counted, so the console can say why they were left out.
    expect(b.status(true)).toMatchObject({ on: true, paused: false, tracks: 5, karaoke: 2, errors: [] });
  });

  it('copes with an empty or missing folder, and with files that vanish after a rescan', async () => {
    const empty = new BreakMusic();
    await empty.scan([join(root, 'nowhere')]);
    expect(empty.count).toBe(0);
    expect(empty.status(false).errors[0]).toMatch(/nowhere/);
    empty.startBreak();
    expect(empty.current()).toBeNull();
    empty.skip();
    expect(empty.failed(empty.nonce)).toBe(true);

    const b = await loaded();
    b.startBreak();
    await b.scan([join(root, 'Chill')]);
    expect(b.count).toBe(2);
    b.ensureTrack();
    expect(['Slow Jam', 'Neon Loop']).toContain(b.current()!.title);
  });

  it('says so when a folder has only karaoke songs, so nobody wonders why nothing plays', async () => {
    const karaoke = await mkdtemp(join(tmpdir(), 'encore-break-karaoke-'));
    for (const f of ['Adele - Hello.mp3', 'Adele - Hello.cdg', 'Queen - Radio Gaga.mp3', 'Queen - Radio Gaga.cdg']) await writeFile(join(karaoke, f), '');
    const b = new BreakMusic();
    await b.scan([karaoke]);
    expect(b.count).toBe(0);
    expect(b.status(false)).toMatchObject({ tracks: 0, karaoke: 2, folders: [karaoke] });
    await rm(karaoke, { recursive: true, force: true });
  });
});
