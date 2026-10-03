// Media players for the venue screen. Each one plays a single song and
// exposes the same small imperative API so the display can drive any source.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Song } from '../../shared/types.ts';
import { CDG_HEIGHT, CDG_WIDTH, CdgDecoder } from '../cdg/decoder.ts';
import * as I from '../common/icons.tsx';

export interface PlayerHandle {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
}

export interface PlayerProps {
  song: Song;
  mediaKey: string;
  playing: boolean;
  volume: number;
  muted: boolean;
  /** Where to resume when the display reloads mid-song. */
  startAt: number;
  onProgress: (position: number, duration?: number) => void;
  onEnded: () => void;
  onError: (message: string) => void;
}

export const Player = forwardRef<PlayerHandle, PlayerProps>(function Player(props, ref) {
  const { source } = props.song;
  if (source.kind === 'youtube') return <YouTubePlayer ref={ref} {...props} videoId={source.videoId} />;
  const base = `/media/${source.trackId}`;
  const key = `k=${encodeURIComponent(props.mediaKey)}`;
  if (source.format === 'video') return <VideoPlayer ref={ref} {...props} src={`${base}/main?${key}`} />;
  if (source.format === 'mp3+g' || source.format === 'zip')
    return <CdgPlayer ref={ref} {...props} audioSrc={`${base}/main?${key}`} cdgSrc={`${base}/cdg?${key}`} />;
  return <AudioOnlyPlayer ref={ref} {...props} src={`${base}/main?${key}`} />;
});

// --- shared <audio>/<video> wiring ----------------------------------------------

function useMediaElement<T extends HTMLMediaElement>(props: PlayerProps, ref: React.ForwardedRef<PlayerHandle>) {
  const el = useRef<T>(null);
  const started = useRef(false);
  const { playing, volume, muted, onProgress, onEnded, onError, startAt } = props;
  // An aborted play() (e.g. a quick pause) is not an error worth reporting.
  const report = (message: string) => message && onError(message);
  const cb = useRef({ onProgress, onEnded, onError: report });
  cb.current = { onProgress, onEnded, onError: report };

  useImperativeHandle(ref, () => ({
    play: () => void el.current?.play().catch((e: Error) => cb.current.onError(playError(e))),
    pause: () => el.current?.pause(),
    seek: (s) => {
      if (el.current) el.current.currentTime = s;
    },
  }));

  useEffect(() => {
    const m = el.current;
    if (!m) return;
    if (playing) m.play().catch((e: Error) => cb.current.onError(playError(e)));
    else m.pause();
  }, [playing]);

  useEffect(() => {
    if (el.current) {
      el.current.volume = Math.max(0, Math.min(1, volume / 100));
      el.current.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    const m = el.current;
    if (!m) return;
    let last = 0;
    const onTime = () => {
      const now = performance.now();
      if (now - last < 900) return;
      last = now;
      cb.current.onProgress(m.currentTime, Number.isFinite(m.duration) ? m.duration : undefined);
    };
    const onMeta = () => {
      if (!started.current && startAt > 1) m.currentTime = startAt;
      started.current = true;
      cb.current.onProgress(m.currentTime, Number.isFinite(m.duration) ? m.duration : undefined);
    };
    const ended = () => cb.current.onEnded();
    const error = () => cb.current.onError(mediaError(m.error));
    m.addEventListener('timeupdate', onTime);
    m.addEventListener('loadedmetadata', onMeta);
    m.addEventListener('ended', ended);
    m.addEventListener('error', error);
    return () => {
      m.removeEventListener('timeupdate', onTime);
      m.removeEventListener('loadedmetadata', onMeta);
      m.removeEventListener('ended', ended);
      m.removeEventListener('error', error);
    };
  }, [startAt]);

  return el;
}

function playError(e: Error): string {
  if (e.name === 'NotAllowedError') return 'The browser blocked playback. Click the venue screen once to allow sound.';
  if (e.name === 'AbortError') return '';
  return e.message;
}

function mediaError(err: MediaError | null): string {
  switch (err?.code) {
    case 2:
      return 'Network error while loading the file.';
    case 3:
      return 'The file is damaged or uses an unsupported codec.';
    case 4:
      return 'This browser can’t play that file format.';
    default:
      return 'The file couldn’t be played.';
  }
}

// --- local video ----------------------------------------------------------------

const VideoPlayer = forwardRef<PlayerHandle, PlayerProps & { src: string }>(function VideoPlayer(props, ref) {
  const el = useMediaElement<HTMLVideoElement>(props, ref);
  return <video ref={el} className="media-fill" src={props.src} preload="auto" playsInline />;
});

// --- MP3+G ------------------------------------------------------------------------

const CdgPlayer = forwardRef<PlayerHandle, PlayerProps & { audioSrc: string; cdgSrc: string }>(function CdgPlayer(props, ref) {
  const audio = useMediaElement<HTMLAudioElement>(props, ref);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [bg, setBg] = useState('#000');
  const [failed, setFailed] = useState<string | null>(null);
  const onError = useRef(props.onError);
  onError.current = props.onError;

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    const image = ctx.createImageData(CDG_WIDTH, CDG_HEIGHT);
    fetch(props.cdgSrc)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'This track has no CD+G graphics file.' : `Couldn’t load the graphics (${r.status}).`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const dec = new CdgDecoder(buf);
        const frame = () => {
          const t = audio.current?.currentTime ?? 0;
          dec.seekTo(t);
          if (dec.dirty) {
            dec.renderTo(image.data);
            ctx.putImageData(image, 0, 0);
            const c = dec.palette[dec.borderColor] ?? 0;
            setBg(`#${c.toString(16).padStart(6, '0')}`);
          }
          raf = requestAnimationFrame(frame);
        };
        frame();
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setFailed(e.message);
        onError.current(e.message);
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [props.cdgSrc, audio]);

  return (
    <div className="cdg-stage" style={{ background: bg }}>
      <canvas ref={canvas} className="cdg-canvas" width={CDG_WIDTH} height={CDG_HEIGHT} />
      {failed && <div className="cdg-failed">{failed}</div>}
      <audio ref={audio} src={props.audioSrc} preload="auto" />
    </div>
  );
});

// --- audio only -------------------------------------------------------------------

const AudioOnlyPlayer = forwardRef<PlayerHandle, PlayerProps & { src: string }>(function AudioOnlyPlayer(props, ref) {
  const el = useMediaElement<HTMLAudioElement>(props, ref);
  return (
    <div className="audio-stage">
      <I.Music />
      <h2>{props.song.title}</h2>
      <p>{props.song.artist}</p>
      <p className="audio-note">Backing track · no on-screen lyrics</p>
      <audio ref={el} src={props.src} preload="auto" />
    </div>
  );
});

// --- YouTube ----------------------------------------------------------------------

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApi: Promise<YTNamespace> | null = null;
function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytApi ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      ytApi = null;
      reject(new Error('Couldn’t reach YouTube. Is this laptop online?'));
    };
    document.head.appendChild(s);
  });
  return ytApi;
}

const YT_ERRORS: Record<number, string> = {
  2: 'YouTube says that video id is invalid.',
  5: 'YouTube couldn’t play this video in the browser.',
  100: 'That YouTube video was removed or made private.',
  101: 'The uploader doesn’t allow this video to play outside YouTube. Pick another version.',
  150: 'The uploader doesn’t allow this video to play outside YouTube. Pick another version.',
};

const YouTubePlayer = forwardRef<PlayerHandle, PlayerProps & { videoId: string }>(function YouTubePlayer(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const ready = useRef(false);
  const { playing, volume, muted, startAt } = props;
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(ref, () => ({
    play: () => ready.current && player.current?.playVideo(),
    pause: () => ready.current && player.current?.pauseVideo(),
    seek: (s) => ready.current && player.current?.seekTo(s, true),
  }));

  useEffect(() => {
    let disposed = false;
    let poll = 0;
    const mount = document.createElement('div');
    host.current?.appendChild(mount);
    loadYouTubeApi()
      .then((YT) => {
        if (disposed) return;
        player.current = new YT.Player(mount, {
          videoId: props.videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            start: Math.floor(startAt),
            origin: location.origin,
          },
          events: {
            onReady: () => {
              ready.current = true;
              const p = latest.current;
              player.current?.setVolume(p.volume);
              if (p.muted) player.current?.mute();
              if (p.playing) player.current?.playVideo();
            },
            onStateChange: (e) => {
              if (e.data === 0) latest.current.onEnded();
            },
            onError: (e) => latest.current.onError(YT_ERRORS[e.data] ?? `YouTube error ${e.data}.`),
          },
        });
        poll = window.setInterval(() => {
          const p = player.current;
          if (!ready.current || !p) return;
          const d = p.getDuration();
          latest.current.onProgress(p.getCurrentTime(), d > 0 ? d : undefined);
        }, 1000);
      })
      .catch((e: Error) => latest.current.onError(e.message));
    return () => {
      disposed = true;
      clearInterval(poll);
      ready.current = false;
      player.current?.destroy();
      player.current = null;
      mount.remove();
    };
    // startAt only matters when the player is created
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.videoId]);

  useEffect(() => {
    if (!ready.current) return;
    if (playing) player.current?.playVideo();
    else player.current?.pauseVideo();
  }, [playing]);

  useEffect(() => {
    if (!ready.current) return;
    player.current?.setVolume(volume);
    if (muted) player.current?.mute();
    else player.current?.unMute();
  }, [volume, muted]);

  return <div ref={host} className="media-fill yt-host" />;
});
