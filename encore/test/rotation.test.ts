import { describe, expect, it } from 'vitest';
import {
  changeMode,
  chooseNext,
  placeNewSinger,
  prepareRound,
  recordPerformance,
  seededRng,
  upcoming,
  type Rng,
} from '../src/shared/rotation.ts';
import type { ShowState } from '../src/shared/types.ts';
import { entry, show, singer } from './helpers.ts';

/** Perform `n` songs (or until the queue is empty), returning titles in order. */
function perform(state: ShowState, n = Infinity, rng?: Rng): { order: string[]; state: ShowState } {
  const order: string[] = [];
  let s = state;
  let now = 10_000;
  while (order.length < n) {
    s = prepareRound(s, rng);
    const e = chooseNext(s);
    if (!e) break;
    order.push(e.song.title);
    now += 1000;
    s = recordPerformance(s, e.id, now);
  }
  return { order, state: s };
}

describe('Classic Rotation', () => {
  it('gives everyone one song per round, in rotation order', () => {
    const s = show('rotation', { A: ['a1', 'a2'], B: ['b1', 'b2'], C: ['c1'] });
    expect(perform(s).order).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
  });

  it('puts a singer who joins mid-round at the end of the current round', () => {
    let s = show('rotation', { A: ['a1', 'a2'], B: ['b1', 'b2'], C: ['c1', 'c2'] });
    const first = perform(s, 1);
    s = first.state;
    const d = singer('D');
    s = { ...s, singers: placeNewSinger(s, d, Math.random), entries: [...s.entries, entry('D', 'd1')] };
    expect([...first.order, ...perform(s).order]).toEqual(['a1', 'b1', 'c1', 'd1', 'a2', 'b2', 'c2']);
  });

  it('still owes a turn to a singer who had no song when their slot came up', () => {
    let s = show('rotation', { A: ['a1', 'a2'], B: [], C: ['c1', 'c2'] });
    const first = perform(s, 1); // a1; B has nothing queued
    s = { ...first.state, entries: [...first.state.entries, entry('B', 'b1')] };
    // B adds a song while C is up next: B still sings before A's second song.
    expect([...first.order, ...perform(s).order]).toEqual(['a1', 'b1', 'c1', 'a2', 'c2']);
  });

  it('skips away singers without losing their place', () => {
    let s = show('rotation', { A: ['a1', 'a2'], B: ['b1'], C: ['c1'] });
    s = { ...s, singers: s.singers.map((x) => (x.id === 'B' ? { ...x, status: 'away' } : x)) };
    const first = perform(s, 2);
    expect(first.order).toEqual(['a1', 'c1']);
    // B comes back before the round rolls over and gets their turn.
    const back = { ...first.state, singers: first.state.singers.map((x) => ({ ...x, status: 'active' as const })) };
    expect(perform(back).order).toEqual(['b1', 'a2']);
  });

  it('ignores songs still waiting for KJ approval', () => {
    const s = show('rotation', { A: ['a1'], B: ['b1'] });
    s.entries = s.entries.map((e) => (e.singerId === 'A' ? { ...e, status: 'pending' } : e));
    expect(perform(s).order).toEqual(['b1']);
  });

  it('counts rounds', () => {
    const s = show('rotation', { A: ['a1', 'a2', 'a3'], B: ['b1', 'b2'] });
    const r = perform(s);
    expect(r.order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
    expect(r.state.round).toBe(3);
  });
});

describe('Fair Play', () => {
  it('lets a newcomer jump ahead of singers who have already sung', () => {
    let s = show('fair', { A: ['a1', 'a2'], B: ['b1', 'b2'] });
    const first = perform(s, 2); // a1, b1
    s = { ...first.state, singers: [...first.state.singers, singer('C')], entries: [...first.state.entries, entry('C', 'c1')] };
    expect([...first.order, ...perform(s).order]).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
  });

  it('breaks ties by who has waited longest', () => {
    const s = show('fair', { A: ['a1', 'a2'], B: ['b1', 'b2'] });
    s.singers = s.singers.map((x) => (x.id === 'A' ? { ...x, songsSung: 1, lastSangAt: 50_000 } : { ...x, songsSung: 1, lastSangAt: 40_000 }));
    expect(chooseNext(s)?.song.title).toBe('b1');
  });
});

describe('First Come', () => {
  it('plays songs in request order regardless of singer', () => {
    const s = show('fifo', {});
    s.singers = [singer('A'), singer('B')];
    s.entries = [entry('A', 'a1'), entry('A', 'a2'), entry('B', 'b1')];
    expect(perform(s).order).toEqual(['a1', 'a2', 'b1']);
  });

  it('holds an away singer’s spot until they return', () => {
    const s = show('fifo', {});
    s.singers = [singer('A', { status: 'away' }), singer('B')];
    s.entries = [entry('A', 'a1'), entry('B', 'b1'), entry('B', 'b2')];
    const r = perform(s, 1);
    expect(r.order).toEqual(['b1']);
    const back = { ...r.state, singers: r.state.singers.map((x) => ({ ...x, status: 'active' as const })) };
    expect(perform(back).order).toEqual(['a1', 'b2']);
  });
});

describe('Shuffle Rounds', () => {
  it('reshuffles each round but never lets anyone sing twice in one round', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const spec = Object.fromEntries(names.map((n) => [n, [1, 2, 3].map((i) => `${n.toLowerCase()}${i}`)]));
    const s = show('shuffle', spec);
    const { order } = perform(s, Infinity, seededRng(7));
    expect(order).toHaveLength(18);
    const rounds = [order.slice(0, 6), order.slice(6, 12), order.slice(12)];
    for (const [i, r] of rounds.entries()) {
      expect(new Set(r.map((t) => t[0])).size).toBe(6);
      expect(r.every((t) => t.endsWith(String(i + 1)))).toBe(true);
    }
    // With six singers, at least one reshuffle should change the order.
    const firsts = rounds.map((r) => r.map((t) => t[0]).join(''));
    expect(new Set(firsts).size).toBeGreaterThan(1);
  });

  it('drops a newcomer into the part of the round still to come', () => {
    let s = show('shuffle', { A: ['a1'], B: ['b1'], C: ['c1'], D: ['d1'] });
    s = recordPerformance(s, 'C:c1', 1);
    for (let seed = 0; seed < 20; seed++) {
      const order = placeNewSinger(s, singer('N'), seededRng(seed)).map((x) => x.id);
      expect(order.indexOf('N')).toBeGreaterThan(order.indexOf('C'));
    }
  });
});

describe('Play next pins', () => {
  it('jump the line in every mode', () => {
    for (const mode of ['rotation', 'fair', 'fifo', 'shuffle'] as const) {
      const s = show(mode, { A: ['a1', 'a2'], B: ['b1'], C: ['c1'] });
      s.playNext = ['C:c1'];
      expect(chooseNext(prepareRound(s, seededRng(1)))?.song.title).toBe('c1');
    }
  });

  it('count as the singer’s turn for the round', () => {
    const s = show('rotation', { A: ['a1', 'a2'], B: ['b1', 'b2'], C: ['c1'] });
    s.playNext = ['C:c1'];
    expect(perform(s).order).toEqual(['c1', 'a1', 'b1', 'a2', 'b2']);
  });
});

describe('upcoming()', () => {
  it('estimates wait times from song length plus changeover', () => {
    const s = show('rotation', { A: ['a1'], B: ['b1'], C: ['c1'] });
    s.settings = { ...s.settings, changeoverSec: 30, defaultSongSec: 200 };
    s.entries = s.entries.map((e) => (e.id === 'A:a1' ? { ...e, song: { ...e.song, durationSec: 100 } } : e));
    const list = upcoming(s, { now: 0, remainingSec: 60 });
    expect(list.map((u) => [u.entry.song.title, u.etaSec])).toEqual([
      ['a1', 90],
      ['b1', 220],
      ['c1', 450],
    ]);
  });

  it('labels rounds and does not mutate the show', () => {
    const s = show('rotation', { A: ['a1', 'a2'], B: ['b1'] });
    const before = JSON.stringify(s);
    const list = upcoming(s, { now: 0, remainingSec: 0 });
    expect(list.map((u) => `${u.entry.song.title}@${u.round}`)).toEqual(['a1@1', 'b1@1', 'a2@2']);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('changeMode()', () => {
  it('starts a fresh round when entering a round-based mode', () => {
    let s = show('fair', { A: ['a1', 'a2'], B: ['b1', 'b2'] });
    s = { ...s, sungThisRound: ['A'] };
    const next = changeMode(s, 'rotation', seededRng(1));
    expect(next.sungThisRound).toEqual([]);
    expect(next.round).toBe(s.round + 1);
  });
});

describe('“Can’t sing right now”', () => {
  const hold = (s: ShowState, name: string, turns = 2): ShowState => ({
    ...s,
    singers: s.singers.map((x) => (x.name === name ? { ...x, holdTurns: turns } : x)),
  });

  it.each(['rotation', 'fair', 'fifo', 'shuffle'] as const)('lets the next two singers go first in %s mode', (mode) => {
    const s = hold(show(mode, { A: ['a1'], B: ['b1'], C: ['c1'], D: ['d1'] }), 'A');
    expect(perform(s).order.slice(0, 3)).toEqual(['b1', 'c1', 'a1']);
  });

  it('still calls a waiting singer when nobody else is left', () => {
    const s = hold(show('rotation', { A: ['a1', 'a2'], B: ['b1'] }), 'A', 5);
    expect(perform(s).order).toEqual(['b1', 'a1', 'a2']);
  });

  it('counts down as others sing, and shows the wait in the running order', () => {
    const s = hold(show('rotation', { A: ['a1'], B: ['b1'], C: ['c1'] }), 'A');
    const list = upcoming(s, { now: 0, remainingSec: 0 });
    expect(list.map((u) => u.singer.name)).toEqual(['B', 'C', 'A']);
    const after = perform(s, 1).state;
    expect(after.singers.find((x) => x.name === 'A')!.holdTurns).toBe(1);
  });

  it('gives way to the KJ’s pins', () => {
    let s = hold(show('rotation', { A: ['a1'], B: ['b1'] }), 'A');
    s = { ...s, playNext: [s.entries.find((e) => e.song.title === 'a1')!.id] };
    expect(perform(s, 1).order).toEqual(['a1']);
  });
});
