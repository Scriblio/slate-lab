// The console's break music card: what's playing between songs, with Skip,
// Pause and a volume of its own. The music plays by itself whenever nothing
// is on stage (see src/server/breakmusic.ts), so this is just the remote.

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
            {b.folders.length
              ? 'No songs or videos found in your break music folder.'
              : 'Play music or videos between singers. Pick a folder in Settings.'}
          </span>
        </div>
        <button className="btn sm" onClick={() => window.dispatchEvent(new Event('encore:settings'))}>
          Set up
        </button>
      </div>
    );
  }

  const status = !s.breakMusic ? 'Off' : b.on ? (b.paused ? 'Paused' : 'Playing') : 'Plays when nothing is on stage';
  return (
    <div className="card break-card">
      <div className="card-head">
        <h3>
          <I.Music /> Break music
        </h3>
        <Toggle checked={s.breakMusic} onChange={(v) => act({ type: 'updateSettings', patch: { breakMusic: v } })} label="Play break music" />
      </div>
      <div className="break-body">
        <div className="break-track">
          <div className="break-status muted small">{status}</div>
          {b.track && s.breakMusic ? (
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
          <button className="btn icon sm" onClick={() => act({ type: 'breakPause' })} disabled={!b.on || !s.breakMusic} title={b.paused ? 'Resume' : 'Pause'} aria-label={b.paused ? 'Resume break music' : 'Pause break music'}>
            {b.paused ? <I.Play /> : <I.Pause />}
          </button>
          <button className="btn icon sm" onClick={() => act({ type: 'breakSkip' })} disabled={!s.breakMusic} title="Next track" aria-label="Next break music track">
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
