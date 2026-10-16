import { describe, expect, it } from 'vitest';
import { chromagram, detectKey, keyFromChroma } from '../src/shared/keydetect.ts';
import { PitchShifter } from '../src/shared/pitch.ts';
import { ALL_KEYS, keyName, parseSongKey, semitonesTo, transposeKey, type Mode } from '../src/shared/songkey.ts';

const RATE = 11025;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A little band: chords, bass and a melody, as harmonic tones with decaying envelopes. */
function song(tonic: number, mode: Mode, seconds = 24, noise = 0): Float32Array {
  const out = new Float32Array(RATE * seconds);
  let seed = 3 + tonic;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const note = (start: number, midi: number, dur: number, amp: number) => {
    const f = hz(midi);
    const i0 = Math.round(start * RATE);
    for (let i = 0; i < dur * RATE && i0 + i < out.length; i++) {
      const t = i / RATE;
      let s = 0;
      for (let k = 1; k <= 8; k++) if (f * k < RATE / 2) s += Math.sin(2 * Math.PI * f * k * t) / k ** 1.3;
      out[i0 + i] = out[i0 + i]! + amp * s * Math.exp(-t * 1.5) * Math.min(1, t / 0.01);
    }
  };
  const root = 48 + tonic;
  // Major: I vi IV V. Minor: i iv V i (harmonic minor, so the raised 7th shows up).
  const chords =
    mode === 'major'
      ? [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]]
      : [[0, 3, 7], [5, 8, 12], [7, 11, 14], [0, 3, 7]];
  const scale = mode === 'major' ? [0, 2, 4, 5, 7, 9, 11, 12] : [0, 2, 3, 5, 7, 8, 11, 12];
  for (let bar = 0; bar * 2 < seconds; bar++) {
    const c = chords[bar % 4]!;
    note(bar * 2, root - 12 + c[0]!, 2, 0.3);
    for (const iv of c) note(bar * 2, root + 12 + iv, 2, 0.12);
    for (let b = 0; b < 4; b++) note(bar * 2 + b * 0.5, root + 24 + scale[(bar * 3 + b * 2) % 8]!, 0.5, 0.1);
  }
  if (noise) for (let i = 0; i < out.length; i++) out[i] = out[i]! + noise * rand();
  return out;
}

describe('key names', () => {
  it('names and transposes keys the way singers say them', () => {
    expect(keyName({ tonic: 7, mode: 'major' })).toBe('G');
    expect(keyName({ tonic: 10, mode: 'major' })).toBe('B♭');
    expect(keyName({ tonic: 6, mode: 'minor' })).toBe('F♯m');
    expect(keyName(transposeKey({ tonic: 0, mode: 'major' }, -5))).toBe('G');
    expect(keyName(transposeKey({ tonic: 9, mode: 'minor' }, 3))).toBe('Cm');
  });

  it('works out the key change for "play it in G", the short way round', () => {
    expect(semitonesTo(0, 7)).toBe(-5); // C -> G: down a fourth, not up a fifth
    expect(semitonesTo(0, 2)).toBe(2);
    expect(semitonesTo(9, 0)).toBe(3);
    expect(semitonesTo(0, 6)).toBe(-6); // a tritone either way: go down
    for (let from = 0; from < 12; from++) for (let to = 0; to < 12; to++) {
      const s = semitonesTo(from, to);
      expect(s).toBeGreaterThanOrEqual(-6);
      expect(s).toBeLessThanOrEqual(5);
      expect(transposeKey({ tonic: from, mode: 'major' }, s).tonic).toBe(to);
    }
  });

  it('lists all 24 keys and checks keys sent in', () => {
    expect(new Set(ALL_KEYS.map(keyName)).size).toBe(24);
    expect(parseSongKey({ tonic: 7, mode: 'major' })).toEqual({ tonic: 7, mode: 'major' });
    expect(parseSongKey({ tonic: 12, mode: 'major' })).toBeNull();
    expect(parseSongKey({ tonic: 3, mode: 'dorian' })).toBeNull();
  });
});

describe('key detection', () => {
  it.each(Array.from({ length: 12 }, (_, t) => t))('finds major key %i', (tonic) => {
    expect(keyName(detectKey(song(tonic, 'major'), RATE)!)).toBe(keyName({ tonic, mode: 'major' }));
  });

  it.each([9, 4, 2, 7, 0, 11])('finds minor key %i', (tonic) => {
    expect(keyName(detectKey(song(tonic, 'minor'), RATE)!)).toBe(keyName({ tonic, mode: 'minor' }));
  });

  it('isn’t talked into the relative minor by a song that opens on a held A', () => {
    // Like Encore's key-test track (C - Am - F - G after an A tuning note), which
    // Krumhansl & Kessler's classical profiles read as A minor.
    const body = song(0, 'major');
    const x = new Float32Array(body.length + 3 * RATE);
    for (let i = 0; i < 3 * RATE; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE);
    x.set(body, 3 * RATE);
    expect(keyName(detectKey(x, RATE)!)).toBe('C');
  });

  it('copes with noise (drums, hiss)', () => {
    expect(keyName(detectKey(song(7, 'major', 24, 0.15), RATE)!)).toBe('G');
  });

  it('follows a key change made by Encore’s own pitch shifter', () => {
    const c = song(0, 'major', 16);
    const shifted = new Float32Array(c.length);
    new PitchShifter(-5).process(c, shifted);
    expect(keyName(detectKey(shifted, RATE)!)).toBe('G');
  });

  it('gives up on silence, and is more sure of a clear song than of a smudge', () => {
    expect(detectKey(new Float32Array(RATE * 4), RATE)).toBeNull();
    const clear = detectKey(song(2, 'major'), RATE)!;
    const flat = keyFromChroma(new Float64Array(12).fill(1).map((v, i) => v + (i === 2 ? 0.01 : 0)));
    expect(clear.confidence).toBeGreaterThan(flat?.confidence ?? 0);
    expect(chromagram(song(2, 'major', 8), RATE)).toHaveLength(12);
  });
});
