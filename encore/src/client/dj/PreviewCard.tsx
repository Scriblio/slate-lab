// The console's preview: click a singer or a song in the rotation to load it
// here, muted until you turn the sound on (it plays through the same
// speakers as the venue). In between, the card checks queued YouTube songs
// ahead of time, so a video YouTube won't play here is caught (and swapped
// for another version) before its singer is on stage. Either way a player
// is only on screen while it's in use.

import { useEffect, useRef, useState } from 'react';
import { YOUTUBE_REFUSALS } from '../../shared/protocol.ts';
import { formatDuration } from '../../shared/text.ts';
import type { Entry, UpcomingItem } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { checkYouTube, type YouTubeHandle } from '../common/youtube-embed.ts';
import { Player, type PlayerHandle } from '../display/players.tsx';
import { useDj } from './context.ts';
import { NotKaraokeButton } from './NotKaraoke.tsx';

/** Wait this long before retrying a video whose check didn't finish (offline, say). */
const RETRY_MS = 3 * 60_000;

const videoId = (u: UpcomingItem) => (u.entry.song.source.kind === 'youtube' ? u.entry.song.source.videoId : '');

export function PreviewCard() {
  const { view, act, preview, setPreview } = useDj();
  const yt = view.youtube;
  const np = view.show.nowPlaying;
  const picked = preview ? (view.show.entries.find((e) => e.id === preview) ?? (np?.entry.id === preview ? np.entry : undefined)) : undefined;
  const queue = view.upcoming.filter((u) => u.entry.song.source.kind === 'youtube').slice(0, 6);
  const [open, setOpen] = useState(false);

  // --- checking queued YouTube songs while nothing is being previewed ---
  const checkHost = useRef<HTMLDivElement>(null);
  const checkPlayer = useRef<YouTubeHandle | null>(null);
  // One check at a time; `running` survives re-renders, `checking` drives the UI.
  const running = useRef<string | null>(null);
  const token = useRef(0);
  const mounted = useRef(true);
  const [checking, setChecking] = useState<string | null>(null);
  const [inconclusive, setInconclusive] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const now = Date.now();
  const next = picked ? undefined : queue.map(videoId).find((id) => !yt.status[id] && !(now - (inconclusive[id] ?? 0) < RETRY_MS));

  const stopCheck = () => {
    token.current++;
    checkPlayer.current?.destroy();
    checkPlayer.current = null;
    running.current = null;
    setChecking(null);
  };

  useEffect(
    () => () => {
      mounted.current = false;
      checkPlayer.current?.destroy();
    },
    [],
  );

  useEffect(() => {
    // Previewing takes the card over; checks pick up again afterwards.
    if (picked && running.current) stopCheck();
    if (!next || running.current || !checkHost.current) return;
    const id = next;
    const mine = ++token.current;
    const { result, handle } = checkYouTube(checkHost.current, yt.frameUrl, id);
    checkPlayer.current = handle;
    running.current = id;
    setChecking(id);
    void result.then(async (r) => {
      if (!mounted.current || token.current !== mine) return;
      handle.destroy();
      checkPlayer.current = null;
      if (r.ok) await act({ type: 'youtubeCheck', videoId: id, ok: true, mode: r.mode });
      else if (YOUTUBE_REFUSALS.includes(r.code)) await act({ type: 'youtubeCheck', videoId: id, ok: false });
      else setInconclusive((m) => ({ ...m, [id]: Date.now() }));
      running.current = null;
      setChecking(null);
      setTick((t) => t + 1);
    });
    // Runs again when there's a different video to check, a check finished, or a preview started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, tick, Boolean(picked)]);

  const ready = queue.filter((u) => yt.status[videoId(u)] === 'ok').length;
  const problems = queue.filter((u) => u.entry.wontPlay).length;
  // Shown from the render before a check starts, so its player is never created hidden.
  const checkVisible = !picked && Boolean(checking || next);
  const summary = checking
    ? 'checking YouTube…'
    : problems
      ? `${problems} won’t play`
      : queue.length
        ? `YouTube ${ready} of ${queue.length} ready`
        : 'click a singer or song';

  return (
    <div className={`card preview-card ${problems ? 'has-problem' : ''}`}>
      <button className="preview-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Show the YouTube check list">
        <I.Monitor className="preview-icon" />
        <span className="preview-title">Preview</span>
        <span className={`small ${problems ? 'problem' : 'muted'}`}>{summary}</span>
        <I.ChevronDown className={open ? 'flip' : ''} />
      </button>

      {picked && <Previewing entry={picked} onClose={() => setPreview(null)} />}
      <div className="preview-media" ref={checkHost} hidden={!checkVisible} />

      {open && (
        <ul className="yt-check-list">
          {queue.length === 0 && <li className="muted small yt-check-empty">No YouTube songs in the queue.</li>}
          {queue.map((u) => {
            const id = videoId(u);
            const s = yt.status[id];
            const e = u.entry;
            return (
              <li key={e.id} className="yt-check-row" onClick={() => setPreview(e.id)} title="Preview this song">
                {e.wontPlay ? <I.Alert className="bad" /> : s === 'ok' ? <I.Check className="good" /> : s === 'refused' || checking === id ? <I.Loader /> : <span className="dot-wait" />}
                <div className="ellipsis">
                  <div className="ellipsis">
                    <strong>{u.singer.name}</strong> · {e.song.title}
                  </div>
                  <div className="muted small ellipsis">
                    {e.wontPlay
                      ? 'YouTube won’t play it here and no other version turned up. Pick one in the finder.'
                      : s === 'ok'
                        ? e.swappedFrom
                          ? `Plays here. Swapped in for “${e.swappedFrom}”.`
                          : 'Plays here.'
                        : s === 'refused'
                          ? 'YouTube won’t play it here. Finding another version…'
                          : checking === id
                            ? 'Checking…'
                            : 'Waiting to be checked.'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A song the KJ picked: their own play button, muted until they unmute. */
function Previewing({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const { view, act } = useDj();
  const song = entry.song;
  const singer = view.show.singers.find((s) => s.id === entry.singerId);
  const player = useRef<PlayerHandle>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [time, setTime] = useState<{ position: number; duration?: number }>({ position: 0, duration: song.durationSec });
  const [error, setError] = useState<string | null>(null);
  const key = song.source.kind === 'youtube' ? `yt:${song.source.videoId}` : `local:${song.source.trackId}`;

  // A new song (another pick, or a swapped-in version) starts from the top, paused.
  useEffect(() => {
    setPlaying(false);
    setError(null);
    setTime({ position: 0, duration: song.durationSec });
  }, [key, song.durationSec]);

  return (
    <div className="previewing">
      <div className="previewing-label">
        <div className="ellipsis">
          <strong>{singer?.name ?? 'Singer'}</strong> · {song.title}
        </div>
        <button className="btn ghost icon sm" onClick={onClose} aria-label="Close preview" title="Close preview">
          <I.X />
        </button>
      </div>
      <div className="preview-media">
        <Player
          key={key}
          ref={player}
          song={song}
          mediaKey={view.mediaKey}
          playing={playing}
          volume={100}
          muted={muted}
          startAt={0}
          youtube={{ frameUrl: view.youtube.frameUrl, mode: song.source.kind === 'youtube' ? view.youtube.modes[song.source.videoId] : undefined }}
          onProgress={(position, duration) => setTime({ position, duration: duration ?? song.durationSec })}
          onEnded={() => setPlaying(false)}
          onError={(message, code) => {
            setPlaying(false);
            setError(message);
            // A refusal found here gets the same treatment as one found by the checks.
            if (song.source.kind === 'youtube' && code !== undefined && YOUTUBE_REFUSALS.includes(code)) {
              void act({ type: 'youtubeCheck', videoId: song.source.videoId, ok: false });
            }
          }}
        />
      </div>
      {error && <p className="preview-error small">{error}</p>}
      <div className="preview-controls">
        <button className="btn sm icon" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause preview' : 'Play preview'} title={playing ? 'Pause' : 'Play'}>
          {playing ? <I.Pause /> : <I.Play />}
        </button>
        <button
          className={`btn sm ${muted ? '' : 'on'}`}
          onClick={() => setMuted((m) => !m)}
          title={muted ? 'Turn the preview’s sound on. It plays through this computer’s speakers, the same as the venue.' : 'Mute the preview'}
        >
          <I.Volume /> {muted ? 'Sound off' : 'Sound on'}
        </button>
        <NotKaraokeButton entry={entry} />
        <span className="muted small preview-time">
          {formatDuration(time.position)} / {formatDuration(time.duration)}
        </span>
      </div>
    </div>
  );
}
