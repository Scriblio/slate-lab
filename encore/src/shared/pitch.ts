// Key change: shifts a track's pitch by whole semitones without changing its
// speed, so CD+G lyrics and videos stay in time. It's a phase vocoder with
// peak phase locking (after Laroche & Dolson): each overlapping frame goes to
// the frequency domain, and every spectral peak (a note's partial) has its
// true frequency measured from how its phase moved since the last frame. Each
// peak then moves, with the bins around it as one block so its shape and inner
// phases survive, to the bin nearest its new frequency. Its phase keeps
// advancing at exactly that frequency, so the pitch is exact and partials
// don't smear or cancel (the plain bin-by-bin version loses up to 40% of the
// volume when shifting up).
//
// Plain TypeScript with no browser APIs: the venue screen runs it inside an
// AudioWorklet (src/client/display/pitch-worklet.ts) and the tests run it in Node.

/** Samples per analysis frame. Bigger is smoother for low notes but adds delay. */
export const PITCH_FRAME = 2048;
/** Frames overlap 4 to 1. */
export const PITCH_HOP = PITCH_FRAME / 4;
/** How many samples later a sample comes back out (plus the audio system's own buffering). */
export const PITCH_LATENCY = PITCH_FRAME - PITCH_HOP;
/** Karaoke hosts' usual range; past this the artifacts get obvious. */
export const MAX_SEMITONES = 6;

export function clampKey(semitones: unknown): number {
  const n = Math.round(Number(semitones));
  return Number.isFinite(n) ? Math.max(-MAX_SEMITONES, Math.min(MAX_SEMITONES, n)) : 0;
}

const TWO_PI = 2 * Math.PI;

/** In-place iterative radix-2 complex FFT of a fixed size. */
export class FFT {
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(readonly size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two.');
    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((TWO_PI * i) / size);
      this.sin[i] = Math.sin((TWO_PI * i) / size);
    }
  }

  /** Forward transform (e^-iωt); `inverse` uses e^+iωt and does not scale by 1/size. */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]!;
      if (j > i) {
        let t = re[i]!;
        re[i] = re[j]!;
        re[j] = t;
        t = im[i]!;
        im[i] = im[j]!;
        im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!;
          const wi = sign * this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = re[b]! * wr - im[b]! * wi;
          const xi = re[b]! * wi + im[b]! * wr;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

/** One channel's pitch shifter. Feed it any block size; output lags input by PITCH_LATENCY samples. */
export class PitchShifter {
  private ratio = 1;
  private readonly n = PITCH_FRAME;
  private readonly bins = PITCH_FRAME / 2 + 1;
  private readonly fft = new FFT(PITCH_FRAME);
  private readonly window = new Float64Array(PITCH_FRAME);
  private readonly inFifo = new Float64Array(PITCH_FRAME);
  private readonly outFifo = new Float64Array(PITCH_FRAME);
  private readonly accum = new Float64Array(PITCH_FRAME * 2);
  /** Analysis phase of every bin in the previous frame. */
  private readonly lastPhase = new Float64Array(PITCH_FRAME / 2 + 1);
  private readonly mag = new Float64Array(PITCH_FRAME / 2 + 1);
  private readonly phase = new Float64Array(PITCH_FRAME / 2 + 1);
  /** True frequency of each bin, in bins (fractional). */
  private readonly freq = new Float64Array(PITCH_FRAME / 2 + 1);
  private readonly peaks = new Int32Array(PITCH_FRAME / 2 + 1);
  /** Synthesis phase of every output bin in the previous frame, and this one. */
  private synPhase = new Float64Array(PITCH_FRAME / 2 + 1);
  private nextPhase = new Float64Array(PITCH_FRAME / 2 + 1);
  private readonly written = new Uint8Array(PITCH_FRAME / 2 + 1);
  private readonly re = new Float64Array(PITCH_FRAME);
  private readonly im = new Float64Array(PITCH_FRAME);
  private rover = PITCH_LATENCY;
  /** Overlap-added Hann² windows at 4x overlap sum to 1.5; undo that. */
  private readonly gain: number;

  constructor(semitones = 0) {
    for (let i = 0; i < this.n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / this.n);
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += this.window[i]! * this.window[i]!;
    this.gain = PITCH_HOP / sum;
    this.setSemitones(semitones);
  }

  get semitones(): number {
    return Math.round(12 * Math.log2(this.ratio));
  }

  setSemitones(semitones: number): void {
    this.ratio = 2 ** (clampKey(semitones) / 12);
  }

  process(input: ArrayLike<number>, output: { [i: number]: number; length: number }): void {
    for (let i = 0; i < input.length; i++) {
      this.inFifo[this.rover] = input[i]!;
      output[i] = this.outFifo[this.rover - PITCH_LATENCY]!;
      if (++this.rover >= this.n) {
        this.rover = PITCH_LATENCY;
        this.frame();
      }
    }
  }

  private frame(): void {
    const { n, bins, re, im, window, mag, phase, freq, peaks } = this;
    /** Phase a bin-centred sinusoid gains over one hop, per bin of frequency. */
    const perBin = (TWO_PI * PITCH_HOP) / n;
    const osamp = n / PITCH_HOP;

    // Analysis: magnitude, phase and true frequency (in bins) of every bin.
    for (let i = 0; i < n; i++) {
      re[i] = this.inFifo[i]! * window[i]!;
      im[i] = 0;
    }
    this.fft.transform(re, im);
    let loud = 0;
    for (let k = 0; k < bins; k++) {
      const p = Math.atan2(im[k]!, re[k]!);
      let delta = p - this.lastPhase[k]! - k * perBin;
      this.lastPhase[k] = p;
      delta -= TWO_PI * Math.round(delta / TWO_PI);
      phase[k] = p;
      mag[k] = Math.hypot(re[k]!, im[k]!);
      freq[k] = k + (osamp * delta) / TWO_PI;
      if (mag[k]! > loud) loud = mag[k]!;
    }

    // Peaks: local maxima that aren't just rounding noise.
    let count = 0;
    const floor = loud * 1e-7;
    for (let k = 1; k < bins - 1; k++) {
      if (mag[k]! > floor && mag[k]! > mag[k - 1]! && mag[k]! >= mag[k + 1]!) peaks[count++] = k;
    }

    // Move each peak, with the bins around it (up to the quietest bin between
    // it and its neighbours), to the bin nearest its new frequency.
    re.fill(0);
    im.fill(0);
    this.written.fill(0);
    let lo = 0;
    for (let i = 0; i < count; i++) {
      const p = peaks[i]!;
      let hi = bins - 1;
      if (i + 1 < count) {
        const q = peaks[i + 1]!;
        hi = p;
        for (let k = p + 1; k < q; k++) if (mag[k]! < mag[hi]!) hi = k;
        if (hi === p) hi = q - 1;
      }
      const target = freq[p]! * this.ratio;
      const to = Math.round(target);
      if (to > 0 && to < bins) {
        const shift = to - p;
        // The peak keeps advancing from where it was at exactly its new frequency;
        // the bins around it keep the same phase offsets from it as they arrived with.
        const peakPhase = this.synPhase[to]! + perBin * target;
        for (let k = lo; k <= hi; k++) {
          const k2 = k + shift;
          if (k2 < 0 || k2 >= bins) continue;
          const ph = peakPhase + phase[k]! - phase[p]!;
          re[k2] = re[k2]! + mag[k]! * Math.cos(ph);
          im[k2] = im[k2]! + mag[k]! * Math.sin(ph);
          this.nextPhase[k2] = ph % TWO_PI;
          this.written[k2] = 1;
        }
      }
      lo = hi + 1;
    }
    // Empty bins carry on at their own centre frequency, ready for a partial that moves in.
    for (let k = 0; k < bins; k++) if (!this.written[k]) this.nextPhase[k] = (this.synPhase[k]! + perBin * k) % TWO_PI;
    [this.synPhase, this.nextPhase] = [this.nextPhase, this.synPhase];

    // Rebuild the frame (a real signal, so the upper half mirrors the lower).
    for (let k = bins; k < n; k++) {
      re[k] = re[n - k]!;
      im[k] = -im[n - k]!;
    }
    this.fft.transform(re, im, true);

    const scale = this.gain / n;
    for (let i = 0; i < n; i++) this.accum[i] = this.accum[i]! + window[i]! * re[i]! * scale;
    for (let i = 0; i < PITCH_HOP; i++) this.outFifo[i] = this.accum[i]!;
    this.accum.copyWithin(0, PITCH_HOP);
    this.accum.fill(0, this.accum.length - PITCH_HOP);
    this.inFifo.copyWithin(0, PITCH_HOP, n);
  }
}
