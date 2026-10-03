// The stage card: who's on, transport controls, and calling the next singer.

import { useEffect, useRef, useState } from 'react';
import { MAX_SEMITONES } from '../../shared/pitch.ts';
import { formatDuration, formatKey } from '../../shared/text.ts';
import * as I from '../common/icons.tsx';
import { Eq, SongThumb, SourceBadge, useTick } from '../common/ui.tsx';
import { useDj } from './context.ts';

function NoScreen() {
  const { view } = useDj();
  if (view.displays > 0) return null;
  return (
    <div className="stage-warn">
      <I.Monitor /> No venue screen is connected, so nothing will play.
      <button className="btn sm" onClick={() => window.open('/display', 'encore-display', 'popup,width=1280,height=720')}>
        Open screen
      </button>
    </div>
  );
}

/** Pick a different song for whoever is on stage, in the finder. */
function ChangeSong() {
  const { view, setTarget, setStageSwap, focusFinder } = useDj();
  const np = view.show.nowPlaying!;
  return (
    <button
      className="btn sm ghost change-song"
      onClick={() => {
        setTarget(np.entry.singerId);
        setStageSwap(np.playId);
        focusFinder();
      }}
      title="Pick a different song for this singer"
    >
      <I.Restart /> Change song
    </button>
  );
}

/** Key change for the song on stage. Library songs only; remembered for this singer and song. */
function KeyControl() {
  const { view, act } = useDj();
  const entry = view.show.nowPlaying!.entry;
  const [key, setKey] = useState(entry.key ?? 0);
  useEffect(() => setKey(entry.key ?? 0), [entry.id, entry.key]);
  if (entry.song.source.kind !== 'local')
    return (
      <span className="badge key-off" title="YouTube songs play in YouTube’s own player, so Encore can’t change their key.">
        Original key only
      </span>
    );
  const set = (k: number) => {
    setKey(k);
    void act({ type: 'setKey', entryId: entry.id, key: k });
  };
  return (
    <span className={`key-control ${key ? 'on' : ''}`} title="Change the key without changing the speed. Encore remembers it for this singer and song.">
      <button className="key-step" disabled={key <= -MAX_SEMITONES} onClick={() => set(key - 1)} aria-label="Key down a semitone">
        −
      </button>
      <button className="key-value" disabled={!key} onClick={() => set(0)} title={key ? 'Back to the original key' : undefined}>
        {key ? `Key ${formatKey(key)}` : 'Key'}
      </button>
      <button className="key-step" disabled={key >= MAX_SEMITONES} onClick={() => set(key + 1)} aria-label="Key up a semitone">
        +
      </button>
    </span>
  );
}

export function Stage() {
  const { view, act } = useDj();
  const np = view.show.nowPlaying;
  const next = view.upcoming[0];
  const now = useTick(250);

  if (!np) {
    return (
      <div className="card stage-card idle">
        <div className="stage-label">
          <span className="live-dot off" /> Stage is open
        </div>
        {next ? (
          <>
            <div className="stage-next">
              <span className="muted">Next in rotation</span>
              <h2 className="stage-name">{next.singer.name}</h2>
              <p className="stage-song ellipsis">
                {next.entry.song.title}
                {next.entry.song.artist && <span className="muted"> · {next.entry.song.artist}</span>}
              </p>
            </div>
            <button className="btn primary lg block" onClick={() => act({ type: 'callNext' })}>
              <I.Mic /> Call up {next.singer.name}
              <kbd>Space</kbd>
            </button>
          </>
        ) : (
          <div className="stage-empty">
            <h2 className="stage-name muted">Nobody in line yet</h2>
            <p className="muted">Put the QR code on the screen — singers join from their phones in seconds.</p>
          </div>
        )}
      </div>
    );
  }

  const song = np.entry.song;
  if (np.stage === 'intro') {
    const left = np.autoStartAt ? Math.max(0, Math.ceil((np.autoStartAt - now) / 1000)) : null;
    return (
      <div className="card stage-card intro">
        <div className="stage-label">
          <span className="live-dot amber" /> Calling up
          {left !== null && <span className="badge amber">auto-start in {left}s</span>}
        </div>
        <div className="stage-head">
          <SongThumb song={song} size={64} />
          <div className="ellipsis">
            <h2 className="stage-name ellipsis">{np.singerName}</h2>
            <p className="stage-song ellipsis">
              {song.title}
              {song.artist && <span className="muted"> · {song.artist}</span>}
            </p>
            <div className="stage-tags">
              <SourceBadge song={song} />
              {np.entry.note && <span className="badge violet">“{np.entry.note}”</span>}
              <KeyControl />
              <ChangeSong />
            </div>
          </div>
        </div>
        <NoScreen />
        <div className="stage-intro-actions">
          <button className="btn primary lg" onClick={() => act({ type: 'play' })}>
            <I.Play /> Start song <kbd>Space</kbd>
          </button>
          <button className="btn lg" onClick={() => act({ type: 'noShow' }, `${np.singerName} marked away — they keep their spot`)} title="Singer isn't here: mark them away, keep their turn, call the next person">
            <I.Coffee /> No-show
          </button>
          <button className="btn lg ghost icon" onClick={() => act({ type: 'stop' })} title="Cancel — put this song back in line" aria-label="Cancel call-up">
            <I.X />
          </button>
        </div>
      </div>
    );
  }

  return <Playing />;
}

function Playing() {
  const { view, act, socket } = useDj();
  const np = view.show.nowPlaying!;
  const song = np.entry.song;
  const [clock, setClock] = useState({ position: np.position, duration: np.duration, at: Date.now() });
  const now = useTick(250);
  const [volume, setVolume] = useState(view.show.settings.volume);
  const volTimer = useRef<number>(0);

  useEffect(() => setClock({ position: np.position, duration: np.duration, at: Date.now() }), [np.playId, np.position, np.duration]);
  useEffect(() => {
    const onProgress = (p: { playId: string; position: number; duration?: number }) => {
      if (p.playId === np.playId) setClock({ position: p.position, duration: p.duration, at: Date.now() });
    };
    socket.on('dj:progress', onProgress);
    return () => void socket.off('dj:progress', onProgress);
  }, [socket, np.playId]);
  useEffect(() => setVolume(view.show.settings.volume), [view.show.settings.volume]);

  const playing = np.stage === 'playing';
  const pos = Math.min(clock.duration ?? Infinity, clock.position + (playing ? (now - clock.at) / 1000 : 0));
  const pct = clock.duration ? Math.min(100, (pos / clock.duration) * 100) : 0;

  return (
    <div className={`card stage-card live ${np.error ? 'has-error' : ''}`}>
      <div className="stage-label">
        {playing ? <span className="live-dot" /> : <span className="live-dot amber" />}
        {playing ? 'Now singing' : 'Paused'}
        <Eq paused={!playing} />
      </div>
      <div className="stage-head">
        <SongThumb song={song} size={64} />
        <div className="ellipsis">
          <h2 className="stage-name ellipsis">{np.singerName}</h2>
          <p className="stage-song ellipsis">
            {song.title}
            {song.artist && <span className="muted"> · {song.artist}</span>}
          </p>
          <div className="stage-tags">
            <SourceBadge song={song} />
            {np.entry.note && <span className="badge violet">“{np.entry.note}”</span>}
            <KeyControl />
            <ChangeSong />
          </div>
        </div>
      </div>

      <NoScreen />
      {np.error && (
        <div className="stage-error">
          <I.Alert />
          <div>
            <strong>Playback problem</strong>
            <span>{np.error}</span>
          </div>
          <button className="btn sm" onClick={() => act({ type: 'skip' })}>
            Skip
          </button>
        </div>
      )}

      <div className="progress">
        <div
          className="progress-track"
          onClick={(e) => {
            if (!clock.duration) return;
            const r = e.currentTarget.getBoundingClientRect();
            const target = ((e.clientX - r.left) / r.width) * clock.duration;
            act({ type: 'seekBy', seconds: target - pos });
          }}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-times">
          <span>{formatDuration(pos)}</span>
          <span>{clock.duration ? `-${formatDuration(Math.max(0, clock.duration - pos))}` : formatDuration(undefined)}</span>
        </div>
      </div>

      <div className="transport">
        <button className="btn icon" onClick={() => act({ type: 'restart' })} title="Restart" aria-label="Restart">
          <I.Restart />
        </button>
        <button className="btn icon" onClick={() => act({ type: 'seekBy', seconds: -10 })} title="Back 10s (←)" aria-label="Back 10 seconds">
          <I.Back10 />
        </button>
        <button className="btn primary icon xl" onClick={() => act({ type: playing ? 'pause' : 'play' })} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <I.Pause /> : <I.Play />}
        </button>
        <button className="btn icon" onClick={() => act({ type: 'seekBy', seconds: 10 })} title="Forward 10s (→)" aria-label="Forward 10 seconds">
          <I.Fwd10 />
        </button>
        <button className="btn icon" onClick={() => act({ type: 'skip' })} title="End song and call the next singer" aria-label="End song">
          <I.SkipNext />
        </button>
      </div>

      <div className="volume">
        <I.Volume />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Volume"
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            clearTimeout(volTimer.current);
            volTimer.current = window.setTimeout(() => act({ type: 'setVolume', volume: v }), 120);
          }}
        />
        <span className="muted">{volume}</span>
      </div>
    </div>
  );
}
