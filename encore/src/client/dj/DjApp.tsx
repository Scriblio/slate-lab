// The KJ console: run the stage, manage the rotation, find songs.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DjAction } from '../../shared/protocol.ts';
import { ROTATION_MODES, type DjView } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { connect, request, savePin, storedPin, useConnection } from '../common/socket.ts';
import { Modal, useToast } from '../common/ui.tsx';
import { DjContext, useDj, type DjCtx } from './context.ts';
import { Finder } from './Finder.tsx';
import { Rotation } from './Rotation.tsx';
import { SettingsModal } from './Settings.tsx';
import { Stage } from './Stage.tsx';
import { UpNext } from './UpNext.tsx';

export function DjApp() {
  const [pin, setPin] = useState(storedPin);
  const socket = useMemo(() => connect('dj', pin), [pin]);
  useEffect(() => () => void socket.disconnect(), [socket]);
  const conn = useConnection(socket);
  const [view, setView] = useState<DjView | null>(null);
  const toast = useToast();
  const [target, setTarget] = useState<string | null>(null);
  const finderInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    socket.on('dj:view', setView);
    return () => void socket.off('dj:view', setView);
  }, [socket]);

  const act = useCallback(
    async <T,>(action: DjAction, success?: string): Promise<T | undefined> => {
      try {
        const r = await request<T>(socket, 'dj:action', action);
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, 'error');
        return undefined;
      }
    },
    [socket, toast],
  );

  // Drop the finder target once that singer leaves. (A just-added singer may
  // not be in the view yet, so only clear ids we have actually seen.)
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!view) return;
    const ids = new Set(view.show.singers.map((s) => s.id));
    if (target && seen.current.has(target) && !ids.has(target)) setTarget(null);
    for (const id of ids) seen.current.add(id);
  }, [view, target]);

  if (conn === 'pin')
    return (
      <PinGate
        onPin={(p) => {
          savePin(p);
          setPin(p);
        }}
      />
    );
  if (!view)
    return (
      <div className="dj-loading">
        <div className="logo-mark">
          <I.Mic />
        </div>
        {conn === 'offline' ? 'Can’t reach the Encore server.' : 'Starting the show…'}
      </div>
    );

  const ctx: DjCtx = {
    socket,
    view,
    act,
    target,
    setTarget,
    focusFinder: () => window.dispatchEvent(new Event('encore:find')),
  };

  return (
    <DjContext.Provider value={ctx}>
      <Shortcuts />
      <div className="dj">
        <TopBar offline={conn !== 'online'} />
        <main className="dj-grid">
          <section className="col col-stage">
            <Stage />
            <UpNext />
          </section>
          <section className="col col-rotation">
            <Rotation />
          </section>
          <section className="col col-finder">
            <Finder inputRef={finderInput} />
          </section>
        </main>
      </div>
    </DjContext.Provider>
  );
}

function PinGate({ onPin }: { onPin: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pin.trim()) onPin(pin.trim());
  };
  return (
    <div className="dj-loading">
      <form className="pin-card" onSubmit={submit}>
        <div className="logo-mark">
          <I.Mic />
        </div>
        <h1>DJ console</h1>
        <p className="muted">This device isn’t the Encore laptop. Enter the DJ PIN printed when Encore started.</p>
        <input className="input pin-input" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)} placeholder="••••••" />
        <button className="btn primary lg">Unlock</button>
      </form>
    </div>
  );
}

// --- top bar -------------------------------------------------------------------

function TopBar({ offline }: { offline: boolean }) {
  const { view, act } = useDj();
  const [qr, setQr] = useState(false);
  const [settings, setSettings] = useState(false);
  const mode = ROTATION_MODES.find((m) => m.id === view.show.mode)!;
  const pending = view.show.entries.filter((e) => e.status === 'pending').length;

  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo-mark sm">
          <I.Mic />
        </div>
        <div className="brand-text">
          <span className="brand-name">Encore</span>
          <span className="brand-show ellipsis">{view.show.settings.showName}</span>
        </div>
      </div>

      <div className="mode-picker">
        <div className="seg" role="radiogroup" aria-label="Rotation mode">
          {ROTATION_MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={m.id === view.show.mode}
              className={m.id === view.show.mode ? 'on' : ''}
              title={m.blurb}
              onClick={() => m.id !== view.show.mode && act({ type: 'setMode', mode: m.id }, `${m.label} mode`)}
            >
              {m.id === 'shuffle' && <I.Shuffle />}
              {m.label}
            </button>
          ))}
        </div>
        <span className="mode-blurb ellipsis">{mode.blurb}</span>
      </div>

      <div className="topbar-right">
        {offline && (
          <span className="badge red">
            <I.Wifi /> Reconnecting
          </span>
        )}
        {!view.show.settings.joinOpen && <span className="badge amber">Sign-ups closed</span>}
        {pending > 0 && <span className="badge amber">{pending} to approve</span>}
        <button className={`join-pill ${view.relay.state === 'online' ? 'online' : ''}`} onClick={() => setQr(true)} title="Show the join QR code">
          <I.QrCode />
          <span className="ellipsis">{view.joinLabel}</span>
          {view.relay.state === 'online' && <I.Lock className="pill-lock" aria-label="secure online link" />}
        </button>
        <button
          className={`btn sm ${view.displays ? 'screen-on' : 'screen-off'}`}
          onClick={() => window.open('/display', 'encore-display', 'popup,width=1280,height=720')}
          title={view.displays ? `${view.displays} screen${view.displays > 1 ? 's' : ''} connected` : 'Open the venue screen'}
        >
          <I.Monitor />
          {view.displays ? 'Screen live' : 'Open screen'}
          <i className="dot" />
        </button>
        <button className="btn sm icon" onClick={() => setSettings(true)} aria-label="Settings" title="Settings">
          <I.Settings />
        </button>
      </div>

      {qr && (
        <Modal title="Scan to join the list" onClose={() => setQr(false)} width={460}>
          <div className="qr-modal">
            <img src="/api/qr.svg" alt="Join QR code" />
            <p className="qr-url">{view.joinLabel}</p>
            {view.relay.state === 'online' ? (
              <p className="muted">
                Secure online link: phones can join on any network, including cellular data. If this laptop loses its internet connection,
                the code switches to the Wi-Fi link automatically.
              </p>
            ) : (
              <p className="muted">
                Wi-Fi link: phones must be on the same network as this laptop.
                {view.relay.state === 'page-down' &&
                  ` The secure online link turns on by itself as soon as ${view.relay.onlineHost} is reachable.`}
                {(view.relay.state === 'offline' || view.relay.state === 'connecting') &&
                  ' The secure online link turns on by itself when this laptop is back online.'}
              </p>
            )}
          </div>
        </Modal>
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </header>
  );
}

// --- keyboard ------------------------------------------------------------------

function Shortcuts() {
  const { view, act } = useDj();
  const np = view.show.nowPlaying;
  const state = useRef({ np, act, hasNext: view.upcoming.length > 0 });
  state.current = { np, act, hasNext: view.upcoming.length > 0 };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const { np, act, hasNext } = state.current;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!np) hasNext && act({ type: 'callNext' });
        else if (np.stage === 'playing') act({ type: 'pause' });
        else act({ type: 'play' });
      } else if (e.key === 'ArrowLeft' && np) act({ type: 'seekBy', seconds: -10 });
      else if (e.key === 'ArrowRight' && np) act({ type: 'seekBy', seconds: 10 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
