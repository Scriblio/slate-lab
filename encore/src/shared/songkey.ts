// Musical keys for library songs: naming them, transposing them, and working
// out the key change for "can you play this in G?".

import { formatKey } from './text.ts';

export type Mode = 'major' | 'minor';

/** A song's original key: the tonic as a pitch class (C = 0 … B = 11), and the mode. */
export interface SongKey {
  tonic: number;
  mode: Mode;
  /** The KJ set or confirmed it. Otherwise it was detected from the audio and may be off. */
  confirmed?: boolean;
}

// The spellings singers and charts use most: E♭ and B♭ majors, F♯ and C♯ minors.
const MAJOR = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

const pc = (n: number) => (((Math.round(n) % 12) + 12) % 12);

/** "G", "B♭", "F♯m". */
export function keyName(key: { tonic: number; mode: Mode }): string {
  return key.mode === 'minor' ? `${MINOR[pc(key.tonic)]}m` : MAJOR[pc(key.tonic)]!;
}

export function transposeKey<K extends { tonic: number; mode: Mode }>(key: K, semitones: number): K {
  return { ...key, tonic: pc(key.tonic + semitones) };
}

/**
 * The key change (−6 … +5 semitones) that moves a song's tonic to `toTonic`.
 * The nearer way round, and down rather than up for the tritone: lower is
 * usually the easier way to sing it.
 */
export function semitonesTo(fromTonic: number, toTonic: number): number {
  const up = pc(toTonic - fromTonic);
  return up > 5 ? up - 12 : up;
}

/** All 24 keys, majors then minors, for picking a song's original key. */
export const ALL_KEYS: { tonic: number; mode: Mode }[] = [
  ...MAJOR.map((_, tonic) => ({ tonic, mode: 'major' as const })),
  ...MINOR.map((_, tonic) => ({ tonic, mode: 'minor' as const })),
];

/**
 * A key change for display: "G (−5)" when the song's key is known (with "≈"
 * while it's only detected), or just "−5".
 */
export function keyLabel(semitones: number | undefined, original?: SongKey): string {
  if (!semitones) return original ? `${original.confirmed ? '' : '≈'}${keyName(original)}` : '';
  if (!original) return formatKey(semitones);
  return `${original.confirmed ? '' : '≈'}${keyName(transposeKey(original, semitones))} (${formatKey(semitones)})`;
}

export function sameKey(a: { tonic: number; mode: Mode } | undefined, b: { tonic: number; mode: Mode } | undefined): boolean {
  return Boolean(a && b && pc(a.tonic) === pc(b.tonic) && a.mode === b.mode);
}

export function parseSongKey(raw: unknown): { tonic: number; mode: Mode } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { tonic, mode } = raw as { tonic?: unknown; mode?: unknown };
  const t = Number(tonic);
  if (!Number.isInteger(t) || t < 0 || t > 11 || (mode !== 'major' && mode !== 'minor')) return null;
  return { tonic: t, mode };
}
