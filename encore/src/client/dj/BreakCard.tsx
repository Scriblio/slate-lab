// The console's break music card: what's playing between songs, with Skip
// and a volume of its own. With auto play on, the music plays by itself
// whenever nothing is on stage (see src/server/breakmusic.ts) and the card
// can pause it; with auto play off, the KJ starts and stops it here.

import { useEffect, useRef, useState } from 'react';
import * as I from '../common/icons.tsx';
import { Toggle } from '../common/ui.tsx';
import { useDj } from './context.ts';

export function BreakCard() {
  const { view, act } = useDj();
  const b = view.breakMusic;
  const s = view.show.settings;
  const [volume, setVolume] = useState(s.breakVolume);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setVolume(s.breakVolume), [s.breakVolume]);

  // Nothing set up yet: a short pointer, not a card of dead buttons.
  if (b.tracks === 0 && !b.scanning) {
    return (
      <div className="card break-card break-empty">
        <I.Music />
        <div>
          <strong>Break music</strong>
          <span className="muted small">
            {!b.folders.length
              ? 'Play music or videos between singers. Pick a folder in Settings.'
              : b.karaoke
                ? `That folder only has karaoke songs (${b.karaoke.toLocaleString()}). Break music needs plain music or video files, so pick a different folder.`
                : 'No songs or videos found in your break music folder.'}
          </span>
        </div>
        <button className="btn sm" onClick={() => window.dispatchEvent(new Event('encore:settings'))}>
          Set up
        </button>
      </div>
    );
  }

  const auto = s.breakMusic;
  const np = view.show.nowPlaying;
  const songOn = Boolean(np && np.stage !== 'intro');
  const status = b.on
    ? b.paused
      ? 'Paused'
      : 'Playing'
    : auto
      ? 'Plays by itself between songs'
      : songOn
        ? 'Press Play when the song ends'
        : 'Press Play to start the music';
  return (
    <div className="card break-card">
      <div className="card-head">
        <h3>
          <I.Music /> Break music
        </h3>
        <div className="break-auto small" title="On: music plays by itself whenever nothing is on stage. Off: press Play to start it.">
          <span>Auto play</span>
          <Toggle checked={auto} onChange={(v) => act({ type: 'updateSettings', patch: { breakMusic: v } })} label="Auto play break music" />
        </div>
      </div>
      <div className="break-body">
        <div className="break-track">
          <div className="break-status muted small">{status}</div>
          {b.track && b.on ? (
            <div className="break-name ellipsis" title={b.track.artist ? `${b.track.artist} – ${b.track.title}` : b.track.title}>
              {b.track.artist ? `${b.track.artist} – ` : ''}
              {b.track.title}
              {b.track.kind === 'video' && <span className="badge">video</span>}
            </div>
          ) : (
            <div className="break-name muted">{b.scanning ? 'Scanning…' : `${b.tracks.toLocaleString()} tracks ready`}</div>
          )}
        </div>
        <div className="break-actions">
          {auto ? (
            <button className="btn icon sm" onClick={() => act({ type: 'breakPause' })} disabled={!b.on} title={b.paused ? 'Resume' : 'Pause'} aria-label={b.paused ? 'Resume break music' : 'Pause break music'}>
              {b.paused ? <I.Play /> : <I.Pause />}
            </button>
          ) : b.on ? (
            <button className="btn sm" onClick={() => act({ type: 'breakPlay', on: false })} title="Stop the break music">
              <I.Stop /> Stop
            </button>
          ) : (
            <button className="btn sm primary" onClick={() => act({ type: 'breakPlay', on: true })} disabled={songOn || b.scanning} title={songOn ? 'A song is playing. Start the music when it ends.' : 'Start the break music'}>
              <I.Play /> Play
            </button>
          )}
          <button className="btn icon sm" onClick={() => act({ type: 'breakSkip' })} disabled={!b.on} title="Next track" aria-label="Next break music track">
            <I.SkipNext />
          </button>
        </div>
      </div>
      <div className="volume break-volume">
        <I.Volume />
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Break music volume"
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            clearTimeout(timer.current);
            timer.current = window.setTimeout(() => act({ type: 'updateSettings', patch: { breakVolume: v } }), 120);
          }}
        />
        <span className="muted">{volume}</span>
      </div>
    </div>
  );
}
