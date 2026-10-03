// The rotation engine: given the show state, who sings next?
//
// Everything here is pure: functions take a ShowState and return a new one.
// The server applies them to the live show; the same functions run forward
// on a copy to preview the upcoming list and estimate wait times.

import type { Entry, RotationMode, ShowState, Singer, UpcomingItem } from './types.ts';

export type Rng = () => number;

const ROUND_BASED: ReadonlySet<RotationMode> = new Set(['rotation', 'shuffle']);

export function isRoundBased(mode: RotationMode): boolean {
  return ROUND_BASED.has(mode);
}

/** A singer's songs that are approved and waiting, in their chosen order. */
export function queuedFor(state: ShowState, singerId: string): Entry[] {
  return state.entries.filter((e) => e.singerId === singerId && e.status === 'queued');
}

export function hasQueued(state: ShowState, singerId: string): boolean {
  return state.entries.some((e) => e.singerId === singerId && e.status === 'queued');
}

/** Singers who could be called right now: present and with a song waiting. */
export function eligibleSingers(state: ShowState): Singer[] {
  return state.singers.filter((s) => s.status === 'active' && hasQueued(state, s.id));
}

function findSinger(state: ShowState, id: string): Singer | undefined {
  return state.singers.find((s) => s.id === id);
}

/** Pinned entries that still exist and are approved. */
function livePins(state: ShowState): Entry[] {
  const out: Entry[] = [];
  for (const id of state.playNext) {
    const e = state.entries.find((x) => x.id === id);
    if (e && e.status === 'queued' && findSinger(state, e.singerId)) out.push(e);
  }
  return out;
}

/**
 * In round-based modes, roll over to a new round once every eligible singer
 * has had their turn. Shuffle mode reorders the rotation as the round begins.
 * Pass no rng to keep the order (used for previews, where the future shuffle
 * is unknown).
 */
export function prepareRound(state: ShowState, rng?: Rng): ShowState {
  if (!isRoundBased(state.mode)) return state;
  if (livePins(state).length > 0) return state;
  const eligible = eligibleSingers(state);
  if (eligible.length === 0) return state;
  const sung = new Set(state.sungThisRound);
  if (eligible.some((s) => !sung.has(s.id))) return state;
  const singers = state.mode === 'shuffle' && rng ? shuffle(state.singers, rng) : state.singers;
  return { ...state, singers, round: state.round + 1, sungThisRound: [] };
}

/**
 * The entry that should be performed next, or null when nobody is waiting.
 * Call prepareRound first so a finished round rolls over. Singers holding
 * their turn ("can't sing right now") let others go first, unless nobody
 * else is waiting; the KJ's pins still win.
 */
export function chooseNext(state: ShowState): Entry | null {
  const pinned = livePins(state)[0];
  if (pinned) return pinned;
  if (state.singers.some((s) => s.holdTurns)) {
    const others: ShowState = { ...state, singers: state.singers.map((s) => (s.holdTurns ? { ...s, status: 'away' as const } : s)) };
    const e = chooseByMode(others);
    if (e) return e;
  }
  return chooseByMode(state);
}

function chooseByMode(state: ShowState): Entry | null {
  switch (state.mode) {
    case 'fifo': {
      for (const e of state.entries) {
        if (e.status !== 'queued') continue;
        if (findSinger(state, e.singerId)?.status === 'active') return e;
      }
      return null;
    }
    case 'fair': {
      const eligible = eligibleSingers(state);
      if (eligible.length === 0) return null;
      const order = new Map(state.singers.map((s, i) => [s.id, i]));
      const best = [...eligible].sort(
        (a, b) =>
          a.songsSung - b.songsSung ||
          (a.lastSangAt ?? a.joinedAt) - (b.lastSangAt ?? b.joinedAt) ||
          (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      )[0]!;
      return queuedFor(state, best.id)[0] ?? null;
    }
    case 'rotation':
    case 'shuffle': {
      const eligible = eligibleSingers(state);
      if (eligible.length === 0) return null;
      const sung = new Set(state.sungThisRound);
      // prepareRound guarantees someone is unsung; fall back to the top of
      // the rotation if it wasn't called.
      const singer = eligible.find((s) => !sung.has(s.id)) ?? eligible[0]!;
      return queuedFor(state, singer.id)[0] ?? null;
    }
  }
}

/**
 * Take an entry out of the queue because it is being performed: the singer's
 * count goes up and, in round-based modes, they have had their turn this round.
 * Anyone holding their turn is one performance closer to theirs.
 */
export function recordPerformance(state: ShowState, entryId: string, now: number): ShowState {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return state;
  const singers = state.singers.map((s) =>
    s.id === entry.singerId
      ? { ...s, songsSung: s.songsSung + 1, lastSangAt: now, holdTurns: undefined }
      : s.holdTurns
        ? { ...s, holdTurns: s.holdTurns - 1 || undefined }
        : s,
  );
  let { sungThisRound } = state;
  if (isRoundBased(state.mode) && !sungThisRound.includes(entry.singerId)) {
    sungThisRound = [...sungThisRound, entry.singerId];
  }
  return {
    ...state,
    singers,
    sungThisRound,
    entries: state.entries.filter((e) => e.id !== entryId),
    playNext: state.playNext.filter((id) => id !== entryId),
  };
}

export interface UpcomingOptions {
  limit?: number;
  now: number;
  /** Seconds until the current performance ends (0 when the stage is empty). */
  remainingSec: number;
}

/** Simulate the queue forward to list the next performances with wait times. */
export function upcoming(state: ShowState, opts: UpcomingOptions): UpcomingItem[] {
  const limit = opts.limit ?? 50;
  const { changeoverSec, defaultSongSec } = state.settings;
  const out: UpcomingItem[] = [];
  let sim = state;
  let clock = opts.remainingSec > 0 ? opts.remainingSec + changeoverSec : 0;
  while (out.length < limit) {
    sim = prepareRound(sim);
    const entry = chooseNext(sim);
    if (!entry) break;
    const singer = findSinger(sim, entry.singerId)!;
    out.push({
      entry,
      singer,
      round: isRoundBased(sim.mode) ? sim.round : 0,
      etaSec: Math.round(clock),
      pinned: sim.playNext.includes(entry.id),
    });
    clock += (entry.song.durationSec ?? defaultSongSec) + changeoverSec;
    sim = recordPerformance(sim, entry.id, opts.now + clock * 1000);
  }
  return out;
}

/** Fisher-Yates over a copy. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Small seeded PRNG (mulberry32) so tests and replays are deterministic. */
export function seededRng(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where a newly joined singer goes in the rotation list. Classic and the
 * automatic modes put them at the bottom; Shuffle drops them somewhere among
 * the singers who haven't had their turn yet this round.
 */
export function placeNewSinger(state: ShowState, singer: Singer, rng: Rng): Singer[] {
  if (state.mode !== 'shuffle' || state.singers.length === 0) return [...state.singers, singer];
  const sung = new Set(state.sungThisRound);
  // Any index after the last singer who already sang this round lands the
  // newcomer in the current round.
  let lastSung = -1;
  state.singers.forEach((s, i) => {
    if (sung.has(s.id)) lastSung = i;
  });
  const lo = lastSung + 1;
  const at = lo + Math.floor(rng() * (state.singers.length - lo + 1));
  return [...state.singers.slice(0, at), singer, ...state.singers.slice(at)];
}

/** Switching into a round-based mode starts a fresh round from the current order. */
export function changeMode(state: ShowState, mode: RotationMode, rng: Rng): ShowState {
  if (mode === state.mode) return state;
  const next: ShowState = { ...state, mode };
  if (!isRoundBased(mode)) return next;
  return {
    ...next,
    singers: mode === 'shuffle' ? shuffle(state.singers, rng) : state.singers,
    round: state.round + 1,
    sungThisRound: [],
  };
}
