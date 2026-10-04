// The venue screen: plays the song, introduces each singer, and shows the
// QR code between songs. Open it on the TV / projector.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { PlayerCommand } from '../../shared/protocol.ts';
import type { DisplayView } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { setOutputDevice } from '../common/audio-output.ts';
import { desktop } from '../common/desktop.ts';
import { connect, savePin, storedPin, useConnection, type AppSocket } from '../common/socket.ts';
import { useTick } from '../common/ui.tsx';
import { BreakLayer } from './BreakLayer.tsx';
import { Player, type PlayerHandle } from './players.tsx';

export function DisplayApp() {
  const [pin, setPin] = useState(storedPin);
  const socket = useMemo(() => connect('display', pin), [pin]);
  useEffect(() => () => void socket.disconnect(), [socket]);
  const conn = useConnection(socket);
  const [view, setView] = useState<DisplayView | null>(null);
  // The desktop app may play sound without a click; browsers need one.
  const [armed, setArmed] = useState(Boolean(desktop));

  useEffect(() => {
    socket.on('display:view', setView);
    return () => void socket.off('display:view', setView);
  }, [socket]);

  // The speakers the KJ picked in Settings.
  useEffect(() => setOutputDevice(view?.audioOutput), [view?.audioOutput]);

  // F toggles fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (conn === 'pin')
    return (
      <PinGate
        onPin={(p) => {
          savePin(p);
          setPin(p);
        }}
      />
    );

  return (
    <div className="stage" onDoubleClick={toggleFullscreen}>
      {view ? <Show socket={socket} view={view} armed={armed} /> : <div className="stage-loading">Connecting to Encore…</div>}
      {conn === 'offline' && view && (
        <div className="offline-pill">
          <I.Wifi /> Reconnecting to the KJ laptop…
        </div>
      )}
      {!armed && (
        <button
          className="arm"
          onClick={() => {
            setArmed(true);
            void document.documentElement.requestFullscreen?.().catch(() => {});
          }}
        >
          <div className="arm-card">
            <div className="arm-icon">
              <I.Monitor />
            </div>
            <h1>Venue screen</h1>
            <p>Move this window to the TV or projector, then click anywhere to start.</p>
            <p className="muted">
              Clicking lets the browser play sound. Press <kbd>F</kbd> or double-click for fullscreen.
            </p>
          </div>
        </button>
      )}
    </div>
  );
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

function PinGate({ onPin }: { onPin: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pin.trim()) onPin(pin.trim());
  };
  return (
    <div className="stage pin-gate">
      <form className="arm-card" onSubmit={submit}>
        <div className="arm-icon">
          <I.Monitor />
        </div>
        <h1>Connect this screen</h1>
        <p>Enter the DJ PIN shown in the Encore console (Settings) or the terminal.</p>
        <input className="input pin-input" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••••" />
        <button className="btn primary lg">Connect</button>
      </form>
    </div>
  );
}

// --- the show ------------------------------------------------------------------

function Show({ socket, view, armed }: { socket: AppSocket; view: DisplayView; armed: boolean }) {
  const np = view.nowPlaying;
  const player = useRef<PlayerHandle>(null);
  const playId = np?.playId;
  const report = view.primary;

  useEffect(() => {
    const onCmd = (c: { playId: string } & PlayerCommand) => {
      if (c.playId !== playId) return;
      if (c.cmd === 'seek') player.current?.seek(c.to);
      if (c.cmd === 'play') player.current?.play();
      if (c.cmd === 'pause') player.current?.pause();
    };
    socket.on('player:cmd', onCmd);
    return () => void socket.off('player:cmd', onCmd);
  }, [socket, playId]);

  // The server doesn't rebroadcast every tick, so track position locally.
  const [clock, setClock] = useState({ position: 0, duration: undefined as number | undefined });
  useEffect(() => setClock({ position: np?.position ?? 0, duration: np?.duration }), [playId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onProgress = useCallback(
    (position: number, duration?: number) => {
      setClock({ position, duration });
      if (report && playId) socket.emit('display:progress', { playId, position, duration });
    },
    [socket, playId, report],
  );
  const onEnded = useCallback(() => {
    if (report && playId) socket.emit('display:ended', { playId });
  }, [socket, playId, report]);
  const onError = useCallback(
    (message: string, code?: number) => {
      if (report && playId) socket.emit('display:error', { playId, message, code });
    },
    [socket, playId, report],
  );

  // Remember where we were so a reload mid-song picks up close to it.
  const startAt = useMemo(() => np?.position ?? 0, [playId]); // eslint-disable-line react-hooks/exhaustive-deps
  // YouTube's terms forbid covering its player, so during YouTube songs the
  // player leaves a band at the bottom for the lower thirds and status pills.
  const ytBand = np?.entry.song.source.kind === 'youtube' && np.stage !== 'intro';
  // Break music: under the idle and walk-up screens, which let it show through.
  const bm = view.breakMusic;
  const breakShown = bm?.on && bm.track ? bm.track : null;
  const onBreakEnded = useCallback((nonce: number) => report && socket.emit('display:breakEnded', { nonce }), [socket, report]);
  const onBreakError = useCallback((nonce: number, message: string) => report && socket.emit('display:breakError', { nonce, message }), [socket, report]);

  return (
    <div className={`show-root ${ytBand ? 'yt-band' : ''} ${breakShown ? `break-${breakShown.kind}` : ''}`}>
      {bm?.track && (
        <BreakLayer
          track={bm.track}
          nonce={bm.nonce}
          on={bm.on}
          paused={bm.paused}
          volume={bm.volume}
          muted={!view.primary}
          ready={armed}
          mediaKey={view.mediaKey}
          onEnded={onBreakEnded}
          onError={onBreakError}
        />
      )}
      {breakShown && (
        <div className="break-now">
          <span className="lt-label">{bm?.paused ? 'Break music paused' : 'Break music'}</span>
          <span className="break-title">{breakShown.title}</span>
          {breakShown.artist && <span className="break-artist">{breakShown.artist}</span>}
        </div>
      )}
      {np && (
        <div className={`media-layer ${np.stage === 'intro' ? 'hidden' : ''}`}>
          <Player
            key={np.playId}
            ref={player}
            song={np.entry.song}
            mediaKey={view.mediaKey}
            playing={np.stage === 'playing'}
            volume={view.volume}
            muted={!view.primary}
            startAt={startAt}
            semitones={np.entry.key ?? 0}
            youtube={{
              frameUrl: view.youtube.frameUrl,
              mode: np.entry.song.source.kind === 'youtube' ? view.youtube.modes[np.entry.song.source.videoId] : undefined,
            }}
            onProgress={onProgress}
            onEnded={onEnded}
            onError={onError}
          />
        </div>
      )}
      {!np && <Idle view={view} />}
      {np?.stage === 'intro' && <Intro view={view} />}
      {np && np.stage !== 'intro' && <LowerThirds view={view} position={clock.position} duration={clock.duration ?? np.duration} />}
      {np?.stage === 'paused' && !np.error && (
        <div className="paused-pill">
          <I.Pause /> Paused
        </div>
      )}
      {np?.error && <div className="error-pill">{np.error}</div>}
    </div>
  );
}

function Idle({ view }: { view: DisplayView }) {
  return (
    <div className="idle">
      <div className="blobs" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="idle-grid">
        <div className="idle-join">
          <p className="eyebrow">Karaoke tonight</p>
          <h1 className="show-title">{view.showName}</h1>
          <div className="qr-row">
            <div className="qr-card">
              <img src="/api/qr.svg" alt="QR code to join" />
            </div>
            <div className="qr-copy">
              <h2>Scan to sing</h2>
              <p>Point your phone camera at the code, pick a song, and you’re in line.</p>
              <p className="join-url">{view.joinLabel}</p>
            </div>
          </div>
        </div>
        <UpNextList view={view} />
      </div>
    </div>
  );
}

function UpNextList({ view }: { view: DisplayView }) {
  if (view.upNext.length === 0)
    return (
      <div className="upnext-panel">
        <p className="eyebrow">Up next</p>
        <p className="upnext-empty">The mic is open. Be the first!</p>
      </div>
    );
  return (
    <div className="upnext-panel">
      <p className="eyebrow">Up next</p>
      <ol className="upnext">
        {view.upNext.map((u, i) => (
          <li key={i}>
            <span className="upnext-n">{i + 1}</span>
            <div>
              <div className="upnext-name">{u.singerName}</div>
              <div className="upnext-song">{u.title}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Intro({ view }: { view: DisplayView }) {
  const np = view.nowPlaying!;
  const now = useTick(250);
  const left = np.autoStartAt ? Math.max(0, Math.ceil((np.autoStartAt - now) / 1000)) : null;
  const next = view.upNext[0];
  return (
    <div className="intro">
      <div className="blobs hot" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="intro-inner">
        <p className="eyebrow">Please welcome to the stage</p>
        <h1 className="intro-name">{np.singerName}</h1>
        <p className="intro-song">
          {np.entry.song.title}
          {np.entry.song.artist && <span> · {np.entry.song.artist}</span>}
        </p>
        {left !== null && (
          <div className="countdown" aria-live="polite">
            <span>{left}</span>
          </div>
        )}
      </div>
      <div className="intro-foot">
        {next ? (
          <span>
            Then: <strong>{next.singerName}</strong>
          </span>
        ) : (
          <span />
        )}
        <span className="intro-qr">
          <img src="/api/qr.svg" alt="" /> Scan to sing
        </span>
      </div>
    </div>
  );
}

/** "Now singing" for the first few seconds, "Up next" near the end. */
function LowerThirds({ view, position, duration }: { view: DisplayView; position: number; duration?: number }) {
  const np = view.nowPlaying!;
  const next = view.upNext[0];
  const showNow = position < 8;
  const remaining = duration ? duration - position : Infinity;
  const showNext = !showNow && next && remaining < 30 && remaining > 2;
  return (
    <>
      <div className={`lower-third ${showNow ? 'in' : ''}`}>
        <span className="lt-label">Now singing</span>
        <span className="lt-name">{np.singerName}</span>
      </div>
      <div className={`lower-third right ${showNext ? 'in' : ''}`}>
        <span className="lt-label">Up next</span>
        <span className="lt-name">{next?.singerName}</span>
      </div>
    </>
  );
}
