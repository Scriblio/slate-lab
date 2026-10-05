import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SongRef } from '../src/shared/protocol.ts';
import { seededRng } from '../src/shared/rotation.ts';
import type { Song } from '../src/shared/types.ts';
import { KeyMemory } from '../src/server/keys.ts';
import { Show, UserError } from '../src/server/show.ts';

const track = (id: string): Song => ({ title: `Song ${id}`, artist: 'Artist', source: { kind: 'local', trackId: id, format: 'mp3+g' } });
const ytSong: Song = { title: 'A video', artist: '', source: { kind: 'youtube', videoId: 'abcdefghijk' } };
const lib = (id: string): SongRef => ({ kind: 'local', trackId: id });
const yt: SongRef = { kind: 'youtube', videoId: 'abcdefghijk', title: 'A video' };

describe('KeyMemory', () => {
  it('remembers a key per singer and song, matching names the way sign-ups do', () => {
    const keys = new KeyMemory();
    keys.set('Matt', track('a'), -2);
    expect(keys.get('  MATT ', track('a'))).toBe(-2);
    expect(keys.get('Matt (2)', track('a'))).toBe(-2);
    expect(keys.get('Bea', track('a'))).toBeUndefined();
    expect(keys.get('Matt', track('b'))).toBeUndefined();
    keys.set('Matt', track('a'), 9);
    expect(keys.get('Matt', track('a'))).toBe(6);
    keys.set('Matt', track('a'), 0);
    expect(keys.get('Matt', track('a'))).toBeUndefined();
    keys.set('Matt', ytSong, 3);
    expect(keys.size).toBe(0);
  });

  it('keeps keys from night to night, and forgets them after a year unused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encore-keys-'));
    try {
      let now = Date.UTC(2026, 9, 3);
      const first = new KeyMemory({ dataDir: dir, now: () => now });
      first.set('Matt', track('a'), -2);
      first.set('Bea', track('b'), 3);
      await first.flush();

      const nextWeek = new KeyMemory({ dataDir: dir, now: () => now + 7 * 86_400_000 });
      await nextWeek.load();
      expect([nextWeek.get('Matt', track('a')), nextWeek.get('Bea', track('b'))]).toEqual([-2, 3]);

      now += 400 * 86_400_000;
      const muchLater = new KeyMemory({ dataDir: dir, now: () => now });
      await muchLater.load();
      expect(muchLater.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the 5000 most recently used', () => {
    const keys = new KeyMemory();
    for (let i = 0; i <= 5000; i++) keys.set(`Singer ${i}`, track('a'), 1);
    expect(keys.size).toBe(5000);
    expect(keys.get('Singer 0', track('a'))).toBeUndefined();
    expect(keys.get('Singer 5000', track('a'))).toBe(1);
  });
});

describe('key change in the show', () => {
  function setup(keys = new KeyMemory()) {
    let t = 1_000_000;
    const show = new Show({
      now: () => (t += 1000),
      rng: seededRng(1),
      resolveLocal: (id) => (['a', 'b', 'c'].includes(id) ? track(id) : undefined),
      onChange: () => {},
      onPlayerCommand: () => {},
      keys,
    });
    return { show, keys };
  }

  it('takes a key with a phone request, and brings it back next time', () => {
    const { show, keys } = setup();
    const matt = show.join('Matt').singer;
    const e = show.addEntry(matt.id, lib('a'), { fromPhone: true, key: -2 });
    expect(e.key).toBe(-2);
    expect(keys.get('Matt', track('a'))).toBe(-2);

    show.newShow(); // next night
    const again = show.join('matt').singer;
    expect(show.addEntry(again.id, lib('a'), { fromPhone: true }).key).toBe(-2);
    // Choosing the original key on purpose sticks too.
    expect(show.addEntry(again.id, lib('b'), { fromPhone: true, key: 0 }).key).toBeUndefined();
  });

  it('won’t change the key of a YouTube song', () => {
    const { show } = setup();
    const matt = show.join('Matt').singer;
    expect(() => show.addEntry(matt.id, yt, { fromPhone: true, key: 2 })).toThrow(UserError);
    const e = show.addEntry(matt.id, yt, { fromPhone: true, key: 0 });
    expect(e.key).toBeUndefined();
    expect(() => show.setKey(e.id, 1)).toThrow(/YouTube’s own player/);
  });

  it('lets the KJ change the key in line and on stage, and remembers it', () => {
    const { show, keys } = setup();
    const bea = show.join('Bea').singer;
    const e = show.addEntry(bea.id, lib('a'), { fromPhone: true });
    expect(show.setKey(e.id, 3).key).toBe(3);
    expect(show.state.entries[0]!.key).toBe(3);
    show.callNext();
    expect(show.state.nowPlaying!.entry.key).toBe(3);
    show.setKey(e.id, -1);
    expect(show.state.nowPlaying!.entry.key).toBe(-1);
    expect(keys.get('Bea', track('a'))).toBe(-1);
    show.setKey(e.id, 0);
    expect(show.state.nowPlaying!.entry.key).toBeUndefined();
    expect(keys.get('Bea', track('a'))).toBeUndefined();
    expect(show.setKey(e.id, 20).key).toBe(6);
  });

  it('keeps each song’s own key when the singer on stage switches songs', () => {
    const { show, keys } = setup();
    const cat = show.join('Cat').singer;
    keys.set('Cat', track('c'), -3);
    show.addEntry(cat.id, lib('a'), { fromPhone: true, key: 2 });
    show.addEntry(cat.id, lib('b'), { fromPhone: true, key: -1 });
    show.callNext();
    // One of her own songs: they trade places, keys and all.
    show.changeStageSong(lib('b'), { fromPhone: true });
    expect(show.state.nowPlaying!.entry.key).toBe(-1);
    expect(show.state.entries.find((e) => e.song.source.kind === 'local' && e.song.source.trackId === 'a')!.key).toBe(2);
    // A new song comes up in the key she liked last time.
    show.changeStageSong(lib('c'), { fromPhone: true });
    expect(show.state.nowPlaying!.entry.key).toBe(-3);
  });
});
