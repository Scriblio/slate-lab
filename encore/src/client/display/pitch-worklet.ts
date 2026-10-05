// Key change on the audio thread: an AudioWorklet that runs each channel through
// the pitch shifter in src/shared/pitch.ts. At the original key it passes the
// sound straight through, but keeps the shifter fed, so changing key mid-song
// doesn't drop out.

import { clampKey, PitchShifter } from '../../shared/pitch.ts';

// The AudioWorklet global scope isn't in TypeScript's DOM library.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
type Options = { processorOptions?: { semitones?: number } };
declare function registerProcessor(name: string, processor: new (options?: Options) => AudioWorkletProcessor): void;

class EncorePitch extends AudioWorkletProcessor {
  private semitones: number;
  private shifters: PitchShifter[] = [];

  /** The starting key comes with the node, so even the first moment of the song is in key. */
  constructor(options?: Options) {
    super();
    this.semitones = clampKey(options?.processorOptions?.semitones);
    this.port.onmessage = (e: MessageEvent<{ semitones?: number }>) => {
      this.semitones = clampKey(e.data?.semitones);
      for (const s of this.shifters) s.setSemitones(this.semitones);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    for (let c = 0; c < output.length; c++) {
      const out = output[c]!;
      // A mono track feeds both speakers.
      const inp = input[c] ?? input[0];
      if (!inp) {
        out.fill(0);
        continue;
      }
      const shifter = (this.shifters[c] ??= new PitchShifter(this.semitones));
      shifter.process(inp, out);
      if (this.semitones === 0) out.set(inp);
    }
    return true;
  }
}

registerProcessor('encore-pitch', EncorePitch);
