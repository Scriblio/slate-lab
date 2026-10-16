// Detects a library song's key from its audio, the standard way: add up how
// much of each of the 12 pitch classes the song uses (a chromagram), then see
// which of the 24 keys' typical profiles it matches best. The profiles are
// corpus-derived ones for popular music (after Albrecht & Shanahan 2013).
// Here they beat Krumhansl & Kessler's classical listening profiles on
// pop-style progressions and on Encore's own test tracks. It's right about
// four times in five; misses are usually the relative minor/major (Am-F-C-G
// and C-Am-F-G use the same chords) or a neighbouring key, which is why the KJ
// can correct it. Only for the KJ's own files: YouTube videos are never analysed.
//
// Plain TypeScript: the console decodes the file and calls this; tests run it in Node.

import { FFT } from './pitch.ts';
import type { Mode, SongKey } from './songkey.ts';

// How much each scale degree is used in songs in a key. Index 0 is the tonic.
const MAJOR_PROFILE = [0.238, 0.006, 0.111, 0.006, 0.137, 0.094, 0.016, 0.214, 0.009, 0.08, 0.008, 0.081];
const MINOR_PROFILE = [0.22, 0.006, 0.104, 0.123, 0.019, 0.103, 0.012, 0.214, 0.062, 0.022, 0.061, 0.052];

const LOW_HZ = 60;
const HIGH_HZ = 2100;

export interface DetectedKey extends SongKey {
  /** How clearly the best key beat the runner-up (0 = a coin toss, 1 = unambiguous). */
  confidence: number;
}

/** How much the audio uses each pitch class (C = 0 … B = 11), each frame weighted equally. */
export function chromagram(samples: ArrayLike<number>, rate: number): Float64Array {
  // About 1.3 Hz per bin, enough to tell semitones apart down near 60 Hz.
  const n = 2 ** Math.ceil(Math.log2(rate / 1.4));
  const hop = n / 2;
  const fft = new FFT(n);
  const window = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const lo = Math.max(1, Math.ceil((LOW_HZ * n) / rate));
  const hi = Math.min(n / 2 - 1, Math.floor((HIGH_HZ * n) / rate));
  // Each bin's pitch class, and how close it sits to an actual note (bins between notes count less).
  const binPc = new Int8Array(hi + 1);
  const binWeight = new Float64Array(hi + 1);
  for (let k = lo; k <= hi; k++) {
    const midi = 69 + 12 * Math.log2((k * rate) / n / 440);
    const near = Math.round(midi);
    binPc[k] = ((near % 12) + 12) % 12;
    binWeight[k] = Math.max(0, 1 - 2 * Math.abs(midi - near));
  }
  const frames: { chroma: Float64Array; total: number }[] = [];
  let loudest = 0;
  for (let start = 0; start + n <= samples.length; start += hop) {
    for (let i = 0; i < n; i++) {
      re[i] = samples[start + i]! * window[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    const chroma = new Float64Array(12);
    let total = 0;
    for (let k = lo; k <= hi; k++) {
      // Square-root compression, so a few loud partials don't drown out the harmony.
      const v = Math.sqrt(Math.hypot(re[k]!, im[k]!)) * binWeight[k]!;
      chroma[binPc[k]!] = chroma[binPc[k]!]! + v;
      total += v;
    }
    frames.push({ chroma, total });
    if (total > loudest) loudest = total;
  }
  const sum = new Float64Array(12);
  for (const { chroma, total } of frames) {
    // Skip near-silence (intros, fades, gaps between songs).
    if (total < loudest * 0.05) continue;
    for (let p = 0; p < 12; p++) sum[p] = sum[p]! + chroma[p]! / total;
  }
  return sum;
}

function correlation(a: ArrayLike<number>, b: ArrayLike<number>, shift: number): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + shift) % 12]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The key whose profile best matches a chromagram. */
export function keyFromChroma(chroma: ArrayLike<number>): DetectedKey | null {
  let energy = 0;
  for (let i = 0; i < 12; i++) energy += chroma[i]!;
  if (!(energy > 0)) return null;
  const scores: { tonic: number; mode: Mode; r: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    scores.push({ tonic, mode: 'major', r: correlation(chroma, MAJOR_PROFILE, tonic) });
    scores.push({ tonic, mode: 'minor', r: correlation(chroma, MINOR_PROFILE, tonic) });
  }
  scores.sort((a, b) => b.r - a.r);
  const [best, second] = scores as [(typeof scores)[0], (typeof scores)[0]];
  const confidence = Math.max(0, Math.min(1, (best.r - second.r) / Math.max(1e-9, 1 - second.r)));
  return { tonic: best.tonic, mode: best.mode, confidence };
}

export function detectKey(samples: ArrayLike<number>, rate: number): DetectedKey | null {
  return keyFromChroma(chromagram(samples, rate));
}
