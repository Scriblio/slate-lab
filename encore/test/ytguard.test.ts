// Keeping YouTube videos that won't play here off the stage: remembering
// refusals, and swapping requests for another version of the same song.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Show } from '../src/server/show.ts';
import { pickReplacement, songWords, YouTubeGuard } from '../src/server/ytguard.ts';
import type { SearchResult, Song } from '../src/shared/types.ts';

const ytSong = (videoId: string, title: string, durationSec?: number): Song => ({
  title,
  artist: '',
  source: { kind: 'youtube', videoId },
  durationSec,
});
const result = (videoId: string, title: string): SearchResult => ({ song: ytSong(videoId, title, 200), detail: 'Some Channel' });

const EVER_SO_SWEET = [
  result('sweetsweet1', 'Echa Paramitha - So Sweet (Karaoke)'),
  result('sweetsweet2', 'The Early November - Ever So Sweet (Karaoke Version)'),
  result('sweetsweet3', 'The Early November – Ever So Sweet | Karaoke Instrumental'),
];

function setup(opts: { results?: SearchResult[]; dataDir?: string; now?: () => number } = {}) {
  let clock = 1_000_000;
  const now = opts.now ?? (() => (clock += 1000));
  const searches: string[] = [];
  let guard: YouTubeGuard | undefined;
  const show = new Show({
    now,
    resolveLocal: () => undefined,
    onChange: () => {},
    onPlayerCommand: () => {},
    blockReason: (id) => guard?.blockReason(id),
  });
  guard = new YouTubeGuard({
    show,
    dataDir: opts.dataDir,
    now,
    search: async (q) => {
      searches.push(q);
      return opts.results ?? EVER_SO_SWEET;
    },
  });
  return { show, guard, searches };
}

describe('pickReplacement', () => {
  const original = ytSong('original111', 'The Early November - Ever So Sweet (Acoustic) [Karaoke]');

  it('picks another version of the same song, never a different song with a similar name', () => {
    expect(pickReplacement(original, EVER_SO_SWEET, () => false)?.source).toEqual({ kind: 'youtube', videoId: 'sweetsweet2' });
    expect(pickReplacement(original, [EVER_SO_SWEET[0]!], () => false)).toBeUndefined();
  });

  it('skips the original, refused videos, and other songs by the same artist', () => {
    expect(pickReplacement(original, EVER_SO_SWEET, (id) => id === 'sweetsweet2')?.source).toEqual({ kind: 'youtube', videoId: 'sweetsweet3' });
    expect(pickReplacement(original, [result('original111', original.title)], () => false)).toBeUndefined();
    const hello = ytSong('hello000001', 'Adele - Hello (Karaoke Version)');
    expect(pickReplacement(hello, [result('richie00001', 'Lionel Richie - Hello (Karaoke)')], () => false)).toBeUndefined();
    expect(pickReplacement(hello, [result('adele000002', 'Hello - Adele | Karaoke Version | KaraFun')], () => false)).toBeDefined();
  });

  it('reads the song out of the title, ignoring karaoke wording', () => {
    expect([...songWords('Toto - Africa | Karaoke With Backing Vocals (Original Key)')]).toEqual(['toto', 'africa']);
  });
});

describe('YouTubeGuard', () => {
  it('swaps every request for a refused video and tells the singer what changed', async () => {
    const { show, guard, searches } = setup();
    const robin = show.join('Robin').singer;
    const entry = show.addEntry(robin.id, { kind: 'youtube', videoId: 'original111', title: 'The Early November - Ever So Sweet (Acoustic) [Karaoke]' }, { fromPhone: true });

    await guard.report('original111', false);
    const swapped = show.findEntry(entry.id)!;
    expect(swapped.song.source).toEqual({ kind: 'youtube', videoId: 'sweetsweet2' });
    expect(swapped.swappedFrom).toBe('The Early November - Ever So Sweet (Acoustic) [Karaoke]');
    expect(searches).toEqual(['The Early November - Ever So Sweet (Acoustic) [Karaoke]']);
    // The new version hasn't been checked yet, so the console will check it next.
    expect(guard.view().status).toEqual({});

    // The refused video can't be requested again, by anyone.
    const sam = show.join('Sam').singer;
    expect(() => show.addEntry(sam.id, { kind: 'youtube', videoId: 'original111', title: 'x' }, { fromPhone: true })).toThrow(/won’t play/);

    // If the replacement is refused too, the next version goes in, still crediting the original pick.
    await guard.report('sweetsweet2', false);
    expect(show.findEntry(entry.id)!.song.source).toEqual({ kind: 'youtube', videoId: 'sweetsweet3' });
    expect(show.findEntry(entry.id)!.swappedFrom).toBe('The Early November - Ever So Sweet (Acoustic) [Karaoke]');

    // Out of versions: flag it for the KJ and the singer.
    await guard.report('sweetsweet3', false);
    expect(show.findEntry(entry.id)!.wontPlay).toBe(true);
  });

  it('records what plays, and how', async () => {
    const { show, guard } = setup();
    const robin = show.join('Robin').singer;
    show.addEntry(robin.id, { kind: 'youtube', videoId: 'okvideo0001', title: 'Toto - Africa' }, { fromPhone: true });
    await guard.report('okvideo0001', true, 'site');
    expect(guard.view()).toMatchObject({ status: { okvideo0001: 'ok' }, modes: { okvideo0001: 'site' } });
  });

  it('swaps the song on stage and keeps the show going', async () => {
    const { show, guard } = setup({ results: [result('africa00002', 'Toto - Africa (Karaoke Version)')] });
    const robin = show.join('Robin').singer;
    show.addEntry(robin.id, { kind: 'youtube', videoId: 'africa00001', title: 'Toto - Africa | Karaoke' }, { fromPhone: true });
    show.callNext();
    show.play();
    const before = show.state.nowPlaying!;
    show.playbackError(before.playId, 'refused');
    await guard.report('africa00001', false);
    const after = show.state.nowPlaying!;
    expect(after.entry.song.source).toEqual({ kind: 'youtube', videoId: 'africa00002' });
    expect(after).toMatchObject({ stage: 'playing', error: undefined, position: 0 });
    expect(after.playId).not.toBe(before.playId);
  });

  it('never swaps in a video the singer already requested', async () => {
    const { show, guard } = setup({ results: [result('africa00002', 'Toto - Africa (Karaoke Version)')] });
    const robin = show.join('Robin').singer;
    const a = show.addEntry(robin.id, { kind: 'youtube', videoId: 'africa00001', title: 'Toto - Africa' }, { fromPhone: true });
    show.addEntry(robin.id, { kind: 'youtube', videoId: 'africa00002', title: 'Toto - Africa (Karaoke Version)' }, { fromPhone: true });
    await guard.report('africa00001', false);
    expect(show.findEntry(a.id)!.wontPlay).toBe(true);
  });

  it('remembers refusals across restarts for 30 days, keeping only ids and times', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encore-ytguard-'));
    let t = Date.UTC(2026, 9, 1);
    const now = () => t;
    const first = setup({ dataDir: dir, now });
    await first.guard.report('refused0001', false);
    expect(JSON.parse(await readFile(join(dir, 'youtube-refused.json'), 'utf8'))).toEqual({ refused0001: { at: t, reason: 'refused' } });

    const again = setup({ dataDir: dir, now });
    await again.guard.load();
    expect(again.guard.isRefused('refused0001')).toBe(true);
    t += 31 * 24 * 60 * 60 * 1000;
    expect(again.guard.isRefused('refused0001')).toBe(false);

    // A video that plays after all is forgiven.
    t = Date.UTC(2026, 9, 2);
    await again.guard.report('refused0001', true, 'direct');
    expect(again.guard.isRefused('refused0001')).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('“Not karaoke”', () => {
  it('blocks the video for that reason, which a later good check doesn’t undo', async () => {
    const { show, guard } = setup();
    const robin = show.join('Robin').singer;
    await guard.markNotKaraoke('vocalsvid01');
    expect(guard.blockReason('vocalsvid01')).toBe('not-karaoke');
    expect(() => show.addEntry(robin.id, { kind: 'youtube', videoId: 'vocalsvid01', title: 'x' }, { fromPhone: true })).toThrow(/not a karaoke version/);
    await guard.report('vocalsvid01', true, 'site');
    await guard.report('vocalsvid01', false);
    expect(guard.blockReason('vocalsvid01')).toBe('not-karaoke');
  });

  it('reads the older refusal file format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encore-ytguard-old-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'youtube-refused.json'), JSON.stringify({ oldrefused1: Date.now() }));
    const { guard } = setup({ dataDir: dir, now: Date.now });
    await guard.load();
    expect(guard.blockReason('oldrefused1')).toBe('refused');
    await rm(dir, { recursive: true, force: true });
  });
});
