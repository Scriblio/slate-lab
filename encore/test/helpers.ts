import { DEFAULT_SETTINGS, type Entry, type RotationMode, type ShowState, type Singer } from '../src/shared/types.ts';

export function emptyShow(mode: RotationMode = 'rotation'): ShowState {
  return {
    id: 'show',
    createdAt: 0,
    mode,
    settings: { ...DEFAULT_SETTINGS, changeoverSec: 0, defaultSongSec: 60 },
    singers: [],
    entries: [],
    round: 1,
    sungThisRound: [],
    playNext: [],
    nowPlaying: null,
    history: [],
  };
}

let clock = 1000;

export function singer(name: string, extra: Partial<Singer> = {}): Singer {
  clock += 1000;
  return { id: name, name, joinedAt: clock, status: 'active', songsSung: 0, fromPhone: true, code: '1234', ...extra };
}

export function entry(singerId: string, title: string, extra: Partial<Entry> = {}): Entry {
  clock += 1000;
  return {
    id: `${singerId}:${title}`,
    singerId,
    song: { title, artist: 'Artist', source: { kind: 'youtube', videoId: title } },
    requestedAt: clock,
    status: 'queued',
    ...extra,
  };
}

/** Build a show from a compact spec: { A: ['a1', 'a2'], B: ['b1'] } in rotation order. */
export function show(mode: RotationMode, spec: Record<string, string[]>): ShowState {
  const s = emptyShow(mode);
  for (const [name, songs] of Object.entries(spec)) {
    s.singers.push(singer(name));
    for (const t of songs) s.entries.push(entry(name, t));
  }
  return s;
}
