// Media players for the venue screen. Each one plays a single song and
// exposes the same small imperative API so the display can drive any source.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Song, YouTubeMode } from '../../shared/types.ts';
import { CDG_HEIGHT, CDG_WIDTH, CdgDecoder } from '../cdg/decoder.ts';
import * as I from '../common/icons.tsx';
import { modeOrder, playYouTube, YOUTUBE_ERRORS, type YouTubeHandle } from '../common/youtube-embed.ts';

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
  /** code: the YouTube player's error code, for YouTube songs. */
  onError: (message: string, code?: number) => void;
  /** Where YouTube's player loads from, and the embedding known to work for this video. */
  youtube?: { frameUrl?: string; mode?: YouTubeMode };
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

const YouTubePlayer = forwardRef<PlayerHandle, PlayerProps & { videoId: string }>(function YouTubePlayer(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<YouTubeHandle | null>(null);
  const { playing, volume, muted, startAt } = props;
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(ref, () => ({
    play: () => player.current?.play(),
    pause: () => player.current?.pause(),
    seek: (s) => player.current?.seek(s),
  }));

  useEffect(() => {
    const p = latest.current;
    player.current = playYouTube(
      host.current!,
      p.youtube?.frameUrl,
      modeOrder(p.youtube?.frameUrl, p.youtube?.mode),
      { videoId: props.videoId, start: startAt, volume: p.volume, muted: p.muted, autoplay: p.playing },
      {
        onProgress: (t, d) => latest.current.onProgress(t, d),
        onEnded: () => latest.current.onEnded(),
        onError: (code) => latest.current.onError(YOUTUBE_ERRORS[code] ?? `YouTube error ${code}.`, code),
      },
    );
    return () => {
      player.current?.destroy();
      player.current = null;
    };
    // startAt only matters when the player is created
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.videoId]);

  useEffect(() => {
    if (playing) player.current?.play();
    else player.current?.pause();
  }, [playing]);

  useEffect(() => {
    player.current?.setVolume(volume, muted);
  }, [volume, muted]);

  return <div ref={host} className="media-fill yt-host" />;
});
