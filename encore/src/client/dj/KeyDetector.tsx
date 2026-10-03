// Works out the original key of the library songs in the queue, one at a time
// in the background, so the console can say "C → G" instead of "−5". The
// console decodes the file (the browser resamples it to 11 kHz on the way) and
// runs the detector in src/shared/keydetect.ts; the laptop remembers the
// result per track. YouTube songs are never analysed.

import { useEffect, useMemo, useRef, useState } from 'react';
import { detectKey, type DetectedKey } from '../../shared/keydetect.ts';
import type { Entry } from '../../shared/types.ts';
import { request } from '../common/socket.ts';
import { useDj } from './context.ts';

const RATE = 11025;
/** A few minutes is plenty to hear the key; skip the intro and fade by taking the middle. */
const MAX_SECONDS = 240;
/** Very large video files aren't worth decoding just for this. */
const MAX_BYTES = 400 * 1024 * 1024;

export async function detectTrackKey(url: string): Promise<DetectedKey | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await res.arrayBuffer());
  const length = Math.min(audio.length, MAX_SECONDS * audio.sampleRate);
  const start = Math.floor((audio.length - length) / 2);
  const mono = new Float32Array(length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] = mono[i]! + ch[start + i]! / audio.numberOfChannels;
  }
  return detectKey(mono, audio.sampleRate);
}

export function KeyDetector() {
  const { view, socket } = useDj();
  const tried = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);

  // On stage first, then in running order, then anything else waiting.
  const next = useMemo(() => {
    const entries = [view.show.nowPlaying?.entry, ...view.upcoming.map((u) => u.entry), ...view.show.entries].filter(Boolean) as Entry[];
    for (const e of entries) {
      if (e.song.source.kind !== 'local') continue;
      const id = e.song.source.trackId;
      if (!view.songKeys[id] && !tried.current.has(id)) return id;
    }
    return null;
  }, [view, busy]);

  useEffect(() => {
    if (!next || busy) return;
    tried.current.add(next);
    setBusy(true);
    detectTrackKey(`/media/${next}/main?k=${encodeURIComponent(view.mediaKey)}`)
      .then((k) => k && request(socket, 'dj:action', { type: 'setSongKey', trackId: next, key: { tonic: k.tonic, mode: k.mode }, detected: true }))
      .catch(() => {
        // A format the browser can't decode, or the track went away: the KJ can still set the key by hand.
      })
      .finally(() => setBusy(false));
  }, [next, busy, socket, view.mediaKey]);

  return null;
}
