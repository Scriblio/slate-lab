import { describe, expect, it } from 'vitest';
import { clampKey, FFT, PITCH_HOP, PITCH_LATENCY, PitchShifter } from '../src/shared/pitch.ts';

const RATE = 48_000;

function tone(freqs: number[], seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = freqs.reduce((s, f) => s + (amp / freqs.length) * Math.sin((2 * Math.PI * f * i) / RATE), 0);
  return out;
}

function shift(input: Float32Array, semitones: number, block = 128): Float32Array {
  const ps = new PitchShifter(semitones);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += block) {
    const end = Math.min(input.length, i + block);
    const o = new Float32Array(end - i);
    ps.process(input.subarray(i, end), o);
    out.set(o, i);
  }
  return out;
}

/** The steady part, after the shifter's start-up delay. */
const steady = (x: Float32Array) => x.subarray(PITCH_LATENCY + 4096, x.length - 1024);

/** Frequency from zero crossings, interpolated between samples. */
function frequency(x: Float32Array): number {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings.push(i - 1 + -x[i - 1]! / (x[i]! - x[i - 1]!));
  return (RATE * (crossings.length - 1)) / (crossings.at(-1)! - crossings[0]!);
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

/** How strongly frequency f is present (Goertzel), normalized by length. */
function level(x: Float32Array, f: number): number {
  const w = (2 * Math.PI * f) / RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s = v + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}

describe('FFT', () => {
  it('matches a plain DFT and inverts', () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + (i % 5) * 0.1);
    const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.3) * 0.2);
    const r0 = re.slice();
    const i0 = im.slice();
    const fft = new FFT(n);
    fft.transform(re, im);
    for (const k of [0, 1, 7, 31, 32, 63]) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += r0[t]! * Math.cos(a) - i0[t]! * Math.sin(a);
        si += r0[t]! * Math.sin(a) + i0[t]! * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 9);
      expect(im[k]).toBeCloseTo(si, 9);
    }
    fft.transform(re, im, true);
    for (let t = 0; t < n; t++) {
      expect(re[t]! / n).toBeCloseTo(r0[t]!, 9);
      expect(im[t]! / n).toBeCloseTo(i0[t]!, 9);
    }
  });

  it('only takes powers of two', () => {
    expect(() => new FFT(1000)).toThrow();
  });
});

describe('PitchShifter', () => {
  const a440 = tone([440], 1.5);

  it.each([
    [0, 440],
    [6, 440 * 2 ** (6 / 12)],
    [-6, 440 * 2 ** (-6 / 12)],
    [1, 440 * 2 ** (1 / 12)],
    [2, 440 * 2 ** (2 / 12)],
    [-3, 440 * 2 ** (-3 / 12)],
    [5, 440 * 2 ** (5 / 12)],
  ])('moves a 440 Hz tone by %i semitones', (semitones, expected) => {
    const out = steady(shift(a440, semitones));
    expect(frequency(out) / expected).toBeGreaterThan(0.99);
    expect(frequency(out) / expected).toBeLessThan(1.01);
  });

  it('keeps the loudness the same, shifting up as well as down', () => {
    // A plain bin-by-bin vocoder lost up to 40% of the volume shifting up; phase locking keeps it.
    const chord = tone([110, 247, 523, 1046, 2093], 1.5);
    for (const x of [a440, chord]) {
      for (const s of [-6, -4, -2, 0, 2, 4, 6]) {
        const ratio = rms(steady(shift(x, s))) / rms(steady(x));
        expect(ratio, `${s} semitones`).toBeGreaterThan(0.82);
        expect(ratio, `${s} semitones`).toBeLessThan(1.15);
      }
    }
  });

  it('doesn’t make a steady note wobble in volume', () => {
    for (const s of [-5, 3, 6]) {
      const out = steady(shift(a440, s));
      const windows: number[] = [];
      for (let i = 0; i + 960 <= out.length; i += 960) windows.push(rms(out.subarray(i, i + 960)));
      expect(Math.max(...windows) / Math.min(...windows), `${s} semitones`).toBeLessThan(1.1);
    }
  });

  it('moves every note of a chord, not just one', () => {
    // Notes chosen so none lands on another's old pitch after the shift.
    const notes = [300, 470, 610];
    const chord = tone(notes, 1.5);
    const r = 2 ** (3 / 12);
    const out = steady(shift(chord, 3));
    for (const f of notes) {
      expect(level(out, f * r), `${f} Hz moved`).toBeGreaterThan(5 * level(out, f));
    }
  });

  it('gives the same result whatever block size the audio arrives in', () => {
    const x = tone([300, 520], 0.5);
    const a = shift(x, -2, 128);
    const b = shift(x, -2, 1000);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it('starts silent for its delay, then passes sound through', () => {
    const out = shift(a440, 0);
    // Nothing until the first frame; then, until the delay is up, at most a trace (−45 dB or so).
    expect(Math.max(...out.subarray(0, PITCH_HOP).map(Math.abs))).toBe(0);
    expect(Math.max(...out.subarray(0, PITCH_LATENCY).map(Math.abs))).toBeLessThan(0.01);
    expect(rms(out.subarray(PITCH_LATENCY + 2048, PITCH_LATENCY + 6144))).toBeGreaterThan(0.25);
  });

  it('keeps keys within ±6 semitones', () => {
    expect([clampKey(9), clampKey(-20), clampKey(2.4), clampKey('x'), clampKey(-3)]).toEqual([6, -6, 2, 0, -3]);
    const ps = new PitchShifter(10);
    expect(ps.semitones).toBe(6);
  });
});
