// Break music on the venue screen: the folder's videos play full screen, and
// music-only tracks play over motion graphics that move with the sound. The
// server says what plays and when (src/server/breakmusic.ts); this plays it,
// fades it in and out, and says when it ends.

import { useEffect, useRef } from 'react';
import type { BreakTrack } from '../../shared/types.ts';
import { routeToOutput } from '../common/audio-output.ts';

export interface BreakLayerProps {
  track: BreakTrack;
  /** Changes with every track; reported back so a late answer about an older one is ignored. */
  nonce: number;
  /** Nothing is on stage, so the music belongs on screen (it fades out when this goes false). */
  on: boolean;
  paused: boolean;
  /** 0-100. */
  volume: number;
  /** Only the primary screen is heard. */
  muted: boolean;
  /** The screen has been clicked (browsers won't play sound before that); the desktop app is always ready. */
  ready: boolean;
  mediaKey: string;
  onEnded: (nonce: number) => void;
  onError: (nonce: number, message: string) => void;
}

const FADE_IN_MS = 1400;
const FADE_OUT_MS = 900;

// One audio context for every track: browsers allow only a few.
let sharedContext: AudioContext | undefined;
function breakContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = routeToOutput(new AudioContext());
  return sharedContext;
}

export function BreakLayer({ track, nonce, on, paused, volume, muted, ready, mediaKey, onEnded, onError }: BreakLayerProps) {
  const el = useRef<HTMLMediaElement>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const cb = useRef({ onEnded, onError });
  cb.current = { onEnded, onError };
  /** The track whose element has started from silence, so each new one fades in. */
  const started = useRef(-1);
  const src = `/media/${track.id}/main?k=${encodeURIComponent(mediaKey)}`;
  const audible = on && !paused && ready;
  const target = audible && !muted ? Math.max(0, Math.min(1, volume / 100)) : 0;

  // Music-only tracks go through an analyser, so the graphics can move with them.
  useEffect(() => {
    const m = el.current;
    if (!m || track.kind !== 'audio') return;
    try {
      const ctx = breakContext();
      void ctx.resume();
      const source = ctx.createMediaElementSource(m);
      const a = ctx.createAnalyser();
      a.fftSize = 256;
      a.smoothingTimeConstant = 0.78;
      source.connect(a);
      a.connect(ctx.destination);
      analyser.current = a;
      return () => {
        source.disconnect();
        a.disconnect();
        analyser.current = null;
      };
    } catch (err) {
      // Without the analyser the graphics still move, just not with the beat.
      console.warn('Break music visuals are on their own:', (err as Error).message);
    }
  }, [track.id, track.kind, nonce]);

  // Fade to the right level, and start or stop playing around it.
  useEffect(() => {
    const m = el.current;
    if (!m) return;
    routeToOutput(m);
    if (started.current !== nonce) {
      started.current = nonce;
      m.volume = 0;
    }
    // A browser keeps the audio engine asleep until the page has been clicked; wake it now that music should play.
    if (audible && sharedContext?.state === 'suspended') void sharedContext.resume().catch(() => {});
    // Not being allowed to play yet (no click so far) or a quick pause aren't a bad track.
    if (audible && m.paused) m.play().catch((e: Error) => e.name !== 'AbortError' && e.name !== 'NotAllowedError' && cb.current.onError(nonce, e.message));
    const from = m.volume;
    const began = performance.now();
    const ms = target > from ? FADE_IN_MS : FADE_OUT_MS;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / ms);
      m.volume = Math.max(0, Math.min(1, from + (target - from) * t));
      if (t < 1) raf = requestAnimationFrame(step);
      else if (!audible) m.pause();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [audible, target, nonce]);

  const common = {
    ref: el as never,
    src,
    preload: 'auto' as const,
    onEnded: () => cb.current.onEnded(nonce),
    onError: () => cb.current.onError(nonce, `Could not play ${track.title}`),
  };

  return (
    <div className={`break-layer ${on ? 'on' : ''} ${paused ? 'paused' : ''}`} aria-hidden="true">
      {track.kind === 'video' ? <video key={nonce} {...common} playsInline muted={muted} /> : <audio key={nonce} {...common} />}
      {track.kind === 'audio' && <Graphics analyser={analyser} active={on} />}
    </div>
  );
}

// --- motion graphics ------------------------------------------------------------

const ORBS = [
  { color: '255, 61, 127', speed: 0.11, phase: 0, size: 0.46 },
  { color: '91, 44, 255', speed: 0.083, phase: 2.1, size: 0.52 },
  { color: '24, 198, 192', speed: 0.137, phase: 4.2, size: 0.38 },
  { color: '255, 138, 76', speed: 0.071, phase: 5.4, size: 0.3 },
];
const BARS = 72;

/** Soft colour orbs that swell with the bass, and a spectrum along the bottom. */
function Graphics({ analyser, active }: { analyser: React.RefObject<AnalyserNode | null>; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (!c || !g || !active) return;
    let raf = 0;
    let bins = new Uint8Array(128);
    // Energy eased over time so the picture breathes instead of flickering.
    const level = { bass: 0, mid: 0, high: 0 };
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      c.width = Math.max(2, Math.round(c.clientWidth * scale));
      c.height = Math.max(2, Math.round(c.clientHeight * scale));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);

    const draw = (now: number) => {
      const w = c.width;
      const h = c.height;
      const t = now / 1000;
      const a = analyser.current;
      let live = false;
      if (a) {
        if (bins.length !== a.frequencyBinCount) bins = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(bins);
        live = bins.some((v) => v > 0);
      }
      const band = (from: number, to: number) => {
        let sum = 0;
        for (let i = from; i < to; i++) sum += bins[i] ?? 0;
        return sum / ((to - from) * 255);
      };
      // Without a signal (a silent moment, or no analyser) the graphics gently pulse by themselves.
      const want = live ? { bass: band(0, 6), mid: band(6, 30), high: band(30, 90) } : { bass: 0.25 + 0.12 * Math.sin(t * 1.3), mid: 0.2, high: 0.12 };
      for (const k of ['bass', 'mid', 'high'] as const) level[k] += (want[k] - level[k]) * 0.18;

      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#07060c';
      g.fillRect(0, 0, w, h);

      g.globalCompositeOperation = 'lighter';
      const unit = Math.max(w, h);
      ORBS.forEach((o, i) => {
        const x = w * (0.5 + 0.36 * Math.sin(t * o.speed * 2 + o.phase));
        const y = h * (0.46 + 0.3 * Math.cos(t * o.speed * 1.6 + o.phase * 1.3));
        const swell = [level.bass, level.mid, level.high, level.bass][i]!;
        const r = unit * o.size * (0.8 + swell * 0.75);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(${o.color}, ${0.5 + swell * 0.35})`);
        grad.addColorStop(1, `rgba(${o.color}, 0)`);
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      });

      // Spectrum along the bottom, mirrored from the middle.
      const barW = w / BARS;
      const base = h * 0.985;
      for (let i = 0; i < BARS; i++) {
        const idx = Math.min(bins.length - 1, Math.floor((Math.abs(i - BARS / 2) / (BARS / 2)) ** 1.35 * bins.length * 0.7));
        const v = live ? (bins[idx] ?? 0) / 255 : 0.1 + 0.08 * Math.sin(t * 2 + i * 0.4);
        const bh = Math.max(barW * 0.5, v * h * 0.2);
        const grad = g.createLinearGradient(0, base - bh, 0, base);
        grad.addColorStop(0, 'rgba(24, 198, 192, 0.85)');
        grad.addColorStop(1, 'rgba(255, 61, 127, 0.55)');
        g.fillStyle = grad;
        g.fillRect(i * barW + barW * 0.18, base - bh, barW * 0.64, bh);
      }
      g.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyser, active]);

  return <canvas ref={canvas} className="break-canvas" />;
}
