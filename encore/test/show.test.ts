import { describe, expect, it, vi } from 'vitest';
import { seededRng } from '../src/shared/rotation.ts';
import type { SongRef } from '../src/shared/protocol.ts';
import { Show } from '../src/server/show.ts';

const yt = (id: string, title = id): SongRef => ({ kind: 'youtube', videoId: id.padEnd(11, 'x'), title });

function makeShow() {
  let t = 1_000_000;
  const commands: { playId: string; cmd: string }[] = [];
  const show = new Show({
    now: () => (t += 1000),
    rng: seededRng(3),
    resolveLocal: () => undefined,
    onChange: () => {},
    onPlayerCommand: (playId, cmd) => commands.push({ playId, cmd: cmd.cmd }),
  });
  return { show, commands };
}

describe('Show', () => {
  it('runs a night: call up, play, finish, next', () => {
    const { show, commands } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });

    show.callNext();
    const np = show.state.nowPlaying!;
    expect(np.singerName).toBe('Alex');
    expect(np.stage).toBe('intro');
    show.play();
    expect(show.state.nowPlaying!.stage).toBe('playing');
    expect(commands.at(-1)).toEqual({ playId: np.playId, cmd: 'play' });

    show.ended(np.playId);
    expect(show.state.history[0]!.outcome).toBe('finished');
    // autoAdvance is on by default: Bea is already being called up.
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(show.singer(a.id)!.songsSung).toBe(1);
  });

  it('ignores stale reports from the display', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.callNext();
    show.play();
    show.ended('not-the-current-play');
    expect(show.state.nowPlaying).not.toBeNull();
    expect(show.progress('nope', 10)).toBe(false);
  });

  it('a no-show keeps their turn, goes away, and the next singer is called', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });
    show.callNext();
    show.noShow();
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    const alex = show.singer(a.id)!;
    expect(alex.status).toBe('away');
    expect(alex.songsSung).toBe(0);
    expect(show.state.entries.map((e) => e.song.title)).toEqual(['a1']);
    expect(show.state.sungThisRound).toEqual([b.id]);

    // Alex comes back from the bar: still owed a turn this round.
    show.setSingerStatus(a.id, 'active');
    show.addEntry(b.id, yt('b2'), { fromPhone: true });
    expect(show.upcoming().map((u) => u.entry.song.title)).toEqual(['a1', 'b2']);
  });

  it('calling someone else from the intro card puts the first singer back untouched', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    const b1 = show.addEntry(b.id, yt('b1'), { fromPhone: true });
    show.callNext();
    show.callEntry(b1.id);
    expect(show.state.nowPlaying!.singerName).toBe('Bea');
    expect(show.singer(a.id)!.status).toBe('active');
    expect(show.state.history).toHaveLength(0);
    expect(show.upcoming().map((u) => u.entry.song.title)).toEqual(['a1']);
  });

  it('enforces the per-singer limit and duplicates for phones, not for the KJ', () => {
    const { show } = makeShow();
    show.updateSettings({ maxQueuedPerSinger: 2 });
    const a = show.join('Alex').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    expect(() => show.addEntry(a.id, yt('a1'), { fromPhone: true })).toThrow(/already on your list/);
    show.addEntry(a.id, yt('a2'), { fromPhone: true });
    expect(() => show.addEntry(a.id, yt('a3'), { fromPhone: true })).toThrow(/2 songs/);
    expect(() => show.addEntry(a.id, yt('a3'), { fromPhone: false })).not.toThrow();
  });

  it('holds phone requests for approval when asked to', () => {
    const { show } = makeShow();
    show.updateSettings({ requireApproval: true });
    const a = show.join('Alex').singer;
    const e = show.addEntry(a.id, yt('a1'), { fromPhone: true });
    expect(e.status).toBe('pending');
    expect(show.callNext()).toBeNull();
    show.approve(e.id);
    expect(show.callNext()?.id).toBe(e.id);
  });

  it('closes sign-ups', () => {
    const { show } = makeShow();
    show.updateSettings({ joinOpen: false });
    expect(() => show.join('Late')).toThrow(/closed/);
  });

  it('cleans names and de-duplicates them', () => {
    const { show } = makeShow();
    expect(show.join('  Sam​ \n ').singer.name).toBe('Sam');
    expect(show.join('sam').singer.name).toBe('sam (2)');
    expect(() => show.join('   ')).toThrow(/name/);
  });

  it('never trusts song details from a phone', () => {
    const { show } = makeShow();
    const song = show.resolveSong({ kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'x'.repeat(500), durationSec: 1e9 });
    expect(song.title).toHaveLength(140);
    expect(song.durationSec).toBeUndefined();
    expect(song.thumbnail).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
    expect(() => show.resolveSong({ kind: 'youtube', videoId: '"><script>' })).toThrow();
    expect(() => show.resolveSong({ kind: 'local', trackId: 'missing' })).toThrow(/library/);
  });

  it('lets a singer reorder only their own songs, keeping First Come slots', () => {
    const { show } = makeShow();
    show.setMode('fifo');
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    const a1 = show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });
    const a2 = show.addEntry(a.id, yt('a2'), { fromPhone: true });
    show.singerAction(a.id, { type: 'moveMyEntry', entryId: a2.id, direction: -1 });
    expect(show.state.entries.map((e) => e.song.title)).toEqual(['a2', 'b1', 'a1']);
    expect(() => show.singerAction(b.id, { type: 'removeMyEntry', entryId: a1.id })).toThrow(/your song/);
  });

  it('auto-starts after the intro countdown', () => {
    vi.useFakeTimers();
    try {
      const { show } = makeShow();
      show.updateSettings({ autoStartSec: 10 });
      const a = show.join('Alex').singer;
      show.addEntry(a.id, yt('a1'), { fromPhone: true });
      show.callNext();
      expect(show.state.nowPlaying!.stage).toBe('intro');
      vi.advanceTimersByTime(10_000);
      expect(show.state.nowPlaying!.stage).toBe('playing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows phones their place in line without leaking other singers’ songs', () => {
    const { show } = makeShow();
    const a = show.join('Alex').singer;
    const b = show.join('Bea').singer;
    show.addEntry(a.id, yt('a1'), { fromPhone: true });
    show.addEntry(b.id, yt('b1'), { fromPhone: true });
    const view = show.singerView(b.id, show.upcoming(), false);
    expect(view.myNextPosition).toBe(2);
    expect(view.upcoming[0]).toEqual({ singerName: 'Alex', isMe: false, etaSec: 0 });
    expect(view.upcoming[1]!.title).toBe('b1');
    expect(JSON.stringify(view)).not.toContain('a1');
  });

  it('removing a singer drops their songs, pins and tokens', () => {
    const { show } = makeShow();
    const { token, singer } = show.join('Alex');
    const e = show.addEntry(singer.id, yt('a1'), { fromPhone: true });
    show.pin(e.id);
    show.removeSinger(singer.id);
    expect(show.state.entries).toHaveLength(0);
    expect(show.state.playNext).toHaveLength(0);
    expect(show.singerForToken(token)).toBeUndefined();
  });
});
