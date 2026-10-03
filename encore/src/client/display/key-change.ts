// Key change for library songs on the venue screen (and the console preview):
// the media element's sound goes through the pitch-shift worklet instead of
// straight to the speakers. Only songs whose key is changed are routed, so
// everything else plays exactly as before. YouTube can't be routed: it plays in
// YouTube's own player, whose sound Encore never touches.

import { PITCH_LATENCY } from '../../shared/pitch.ts';
import workletUrl from './pitch-worklet.ts?worker&url';

export interface KeyRoute {
  setKey(semitones: number): void;
  /** Volume now goes through the route; the element itself stays at full volume. */
  setVolume(volume: number, muted: boolean): void;
  /** Seconds the shifted sound lags the element's clock (0 at the original key). */
  readonly latency: number;
  dispose(): void;
}

let shared: { ctx: AudioContext; ready: Promise<void> } | undefined;

function audio(): { ctx: AudioContext; ready: Promise<void> } {
  if (!shared) {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    shared = { ctx, ready: ctx.audioWorklet.addModule(workletUrl) };
    // Browsers start audio only after the page has been clicked; the venue
    // screen asks for that click already, and this picks it up.
    const wake = () => void ctx.resume().catch(() => {});
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
  }
  return shared;
}

export async function routeKey(el: HTMLMediaElement, initialKey = 0): Promise<KeyRoute> {
  const { ctx, ready } = audio();
  await ready;
  void ctx.resume().catch(() => {});
  const source = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  // Once the element feeds the graph it's silent unless the graph plays it, so
  // if the shifter can't start, play the song in its original key instead.
  let node: AudioWorkletNode | undefined;
  try {
    node = new AudioWorkletNode(ctx, 'encore-pitch', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { semitones: initialKey },
    });
    source.connect(node).connect(gain);
  } catch (err) {
    console.warn('Key change unavailable:', (err as Error).message);
    source.connect(gain);
  }
  el.volume = 1;
  el.muted = false;
  let semitones = node ? initialKey : 0;
  return {
    setKey(s) {
      semitones = node ? s : 0;
      node?.port.postMessage({ semitones: s });
    },
    setVolume(volume, muted) {
      gain.gain.value = muted ? 0 : Math.max(0, Math.min(1, volume / 100));
    },
    get latency() {
      return semitones ? PITCH_LATENCY / ctx.sampleRate : 0;
    },
    dispose() {
      source.disconnect();
      node?.disconnect();
      gain.disconnect();
    },
  };
}
