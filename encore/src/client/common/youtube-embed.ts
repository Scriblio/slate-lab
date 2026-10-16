// One YouTube player, embedded one of two ways:
//
//   'site'   inside a page on Encore's website (the join origin's /yt-frame),
//            so YouTube sees a real https site as the embedder. YouTube asks
//            embedders to identify themselves this way, and some videos
//            refuse to play for an unidentified local address.
//   'direct' straight into this page, as before. Used when the site page
//            can't load, or when a video only plays this way.
//
// playYouTube() tries the modes in order and moves on when YouTube refuses
// a video or the player can't load; checkYouTube() does the same for the
// console's preview, to learn ahead of time whether a queued video plays.

import type { YouTubeMode } from '../../shared/types.ts';

export interface YouTubeOptions {
  videoId: string;
  start?: number;
  muted?: boolean;
  volume?: number;
  autoplay?: boolean;
  /** Show YouTube's own controls (the console preview); the venue screen hides them. */
  controls?: boolean;
}

export interface YouTubeEvents {
  onReady?: () => void;
  onState?: (state: number) => void;
  onProgress?: (time: number, duration?: number) => void;
  onEnded?: () => void;
  /** YouTube's error code; -1 when the player itself couldn't load. */
  onError?: (code: number) => void;
}

export interface YouTubeHandle {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number, muted: boolean): void;
  destroy(): void;
}

/** Player state YouTube reports once a video is loaded and ready to play. */
export const CUED = 5;

/** Errors worth retrying the other way: embedding refused, unidentified embedder, or no player. */
const RETRY = new Set([101, 150, 152, 153, -1]);

export const YOUTUBE_ERRORS: Record<number, string> = {
  [-1]: 'Couldn’t load the YouTube player. Is this laptop online?',
  2: 'YouTube says that video id is invalid.',
  5: 'YouTube couldn’t play this video in the browser.',
  100: 'That YouTube video was removed or made private.',
  101: 'YouTube won’t play this video here.',
  150: 'YouTube won’t play this video here.',
  152: 'YouTube won’t play this video here.',
  153: 'YouTube couldn’t confirm where it is being played.',
};

/** The order to try embeddings in: what worked before first, the site page by default. */
export function modeOrder(frameUrl: string | undefined, known?: YouTubeMode): YouTubeMode[] {
  if (!frameUrl) return ['direct'];
  return known === 'direct' ? ['direct', 'site'] : ['site', 'direct'];
}

/** Play a video, falling back to the next embedding when one doesn't work. */
export function playYouTube(
  host: HTMLElement,
  frameUrl: string | undefined,
  modes: YouTubeMode[],
  opts: YouTubeOptions,
  events: YouTubeEvents & { onMode?: (mode: YouTubeMode) => void },
): YouTubeHandle {
  let index = 0;
  let position = opts.start ?? 0;
  let volume = { value: opts.volume ?? 100, muted: Boolean(opts.muted) };
  let wantPlay = Boolean(opts.autoplay);
  let current: YouTubeHandle;

  const start = () => {
    const mode = modes[index]!;
    events.onMode?.(mode);
    const o = { ...opts, start: position, volume: volume.value, muted: volume.muted, autoplay: wantPlay };
    const ev: YouTubeEvents = {
      ...events,
      onProgress: (t, d) => {
        position = t;
        events.onProgress?.(t, d);
      },
      onError: (code) => {
        if (RETRY.has(code) && index < modes.length - 1) {
          current.destroy();
          index++;
          start();
        } else events.onError?.(code);
      },
    };
    current = mode === 'site' && frameUrl ? framePlayer(host, frameUrl, o, ev) : directPlayer(host, o, ev);
  };
  start();

  return {
    play: () => {
      wantPlay = true;
      current.play();
    },
    pause: () => {
      wantPlay = false;
      current.pause();
    },
    seek: (s) => current.seek(s),
    setVolume: (value, muted) => {
      volume = { value, muted };
      current.setVolume(value, muted);
    },
    destroy: () => current.destroy(),
  };
}

export type CheckResult = { ok: true; mode: YouTubeMode } | { ok: false; code: number };

/**
 * Load a video without playing it and see whether YouTube allows it here.
 * Resolves ok once it's cued (or a few seconds pass without an error), and
 * not ok when every embedding is refused. The player stays on screen as a
 * preview until destroyed.
 */
export function checkYouTube(
  host: HTMLElement,
  frameUrl: string | undefined,
  videoId: string,
): { result: Promise<CheckResult>; handle: YouTubeHandle } {
  let mode: YouTubeMode = 'direct';
  let settle: (r: CheckResult) => void = () => {};
  const result = new Promise<CheckResult>((resolve) => (settle = resolve));
  let timer = 0;
  const handle = playYouTube(
    host,
    frameUrl,
    modeOrder(frameUrl),
    { videoId, muted: true, controls: true },
    {
      onMode: (m) => {
        mode = m;
        clearTimeout(timer);
      },
      onReady: () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => settle({ ok: true, mode }), 4000);
      },
      onState: (state) => {
        if (state === CUED) {
          clearTimeout(timer);
          settle({ ok: true, mode });
        }
      },
      onError: (code) => {
        clearTimeout(timer);
        settle({ ok: false, code });
      },
    },
  );
  return { result, handle };
}

// --- through Encore's site ------------------------------------------------------

function framePlayer(host: HTMLElement, frameUrl: string, options: YouTubeOptions, events: YouTubeEvents): YouTubeHandle {
  // Commands that arrive before the page is up are folded into what it's told to load.
  const opts = { ...options };
  const origin = new URL(frameUrl).origin;
  const iframe = document.createElement('iframe');
  iframe.src = frameUrl;
  iframe.className = 'yt-frame';
  iframe.title = 'YouTube video player';
  iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
  let dead = false;
  // The page must say hello, then YouTube's player must load, or we move on.
  let timer = window.setTimeout(() => fail(-1), 8000);

  const fail = (code: number) => {
    if (dead) return;
    events.onError?.(code);
  };
  const post = (msg: Record<string, unknown>) => {
    if (!dead) iframe.contentWindow?.postMessage({ encoreYt: 1, ...msg }, origin);
  };
  const onMessage = (e: MessageEvent) => {
    if (dead || e.source !== iframe.contentWindow || e.origin !== origin) return;
    const d = e.data as { encoreYt?: number; type?: string; state?: number; time?: number; duration?: number; code?: number };
    if (!d || d.encoreYt !== 1) return;
    switch (d.type) {
      case 'up':
        clearTimeout(timer);
        timer = window.setTimeout(() => fail(-1), 15000);
        post({ type: 'load', ...opts });
        break;
      case 'ready':
        clearTimeout(timer);
        events.onReady?.();
        break;
      case 'state':
        events.onState?.(Number(d.state));
        if (d.state === 0) events.onEnded?.();
        break;
      case 'progress':
        events.onProgress?.(Number(d.time) || 0, Number(d.duration) > 0 ? Number(d.duration) : undefined);
        break;
      case 'error':
        clearTimeout(timer);
        fail(Number(d.code));
        break;
    }
  };
  window.addEventListener('message', onMessage);
  host.appendChild(iframe);

  return {
    play: () => {
      opts.autoplay = true;
      post({ type: 'play' });
    },
    pause: () => {
      opts.autoplay = false;
      post({ type: 'pause' });
    },
    seek: (to) => {
      opts.start = to;
      post({ type: 'seek', to });
    },
    setVolume: (value, muted) => {
      opts.volume = value;
      opts.muted = muted;
      post({ type: 'volume', value, muted });
    },
    destroy: () => {
      dead = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
  };
}

// --- straight into this page ----------------------------------------------------

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  setVolume(v: number): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
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
      s.remove();
      reject(new Error('offline'));
    };
    document.head.appendChild(s);
  });
  return ytApi;
}

function directPlayer(host: HTMLElement, options: YouTubeOptions, events: YouTubeEvents): YouTubeHandle {
  const opts = { ...options };
  let player: YTPlayer | null = null;
  let ready = false;
  let dead = false;
  let poll = 0;
  const mount = document.createElement('div');
  host.appendChild(mount);
  loadYouTubeApi().then(
    (YT) => {
      if (dead) return;
      player = new YT.Player(mount, {
        videoId: opts.videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: opts.controls ? 1 : 0,
          disablekb: opts.controls ? 0 : 1,
          fs: 0,
          iv_load_policy: 3,
          playsinline: 1,
          rel: 0,
          start: Math.floor(opts.start ?? 0),
          origin: location.origin,
        },
        events: {
          onReady: () => {
            if (dead) return;
            ready = true;
            player?.setVolume(opts.volume ?? 100);
            if (opts.muted) player?.mute();
            events.onReady?.();
            if (opts.autoplay) player?.playVideo();
            poll = window.setInterval(() => {
              if (!ready || !player) return;
              const d = player.getDuration();
              events.onProgress?.(player.getCurrentTime(), d > 0 ? d : undefined);
            }, 1000);
          },
          onStateChange: (e) => {
            if (dead) return;
            events.onState?.(e.data);
            if (e.data === 0) events.onEnded?.();
          },
          onError: (e) => !dead && events.onError?.(e.data),
        },
      });
    },
    () => !dead && events.onError?.(-1),
  );
  // Before the player is ready, remember what was asked for and apply it then.
  return {
    play: () => {
      if (ready && player) player.playVideo();
      else opts.autoplay = true;
    },
    pause: () => {
      if (ready && player) player.pauseVideo();
      else opts.autoplay = false;
    },
    seek: (s) => {
      if (ready && player) player.seekTo(s, true);
      else opts.start = s;
    },
    setVolume: (value, muted) => {
      opts.volume = value;
      opts.muted = muted;
      if (!ready || !player) return;
      player.setVolume(value);
      if (muted) player.mute();
      else player.unMute();
    },
    destroy: () => {
      dead = true;
      ready = false;
      clearInterval(poll);
      player?.destroy();
      player = null;
      mount.remove();
    },
  };
}
