// The first-run guide: three short steps from a fresh install to singers
// joining. It opens by itself on a new installation, can be skipped, and can
// be run again from Settings.

import { useEffect, useState } from 'react';
import type { ServerConfigView } from '../../shared/protocol.ts';
import { desktop } from '../common/desktop.ts';
import * as I from '../common/icons.tsx';
import { request } from '../common/socket.ts';
import { Modal } from '../common/ui.tsx';
import { useDj } from './context.ts';

const STEPS = ['Your music', 'The big screen', 'Singers'] as const;

export function SetupGuide({ onClose }: { onClose: () => void }) {
  const { view, act, socket } = useDj();
  const [step, setStep] = useState(0);
  const [folders, setFolders] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const lib = view.library;

  useEffect(() => {
    request<ServerConfigView>(socket, 'dj:config')
      .then((c) => setFolders(c.libraryFolders))
      .catch(() => {});
  }, [socket]);

  const save = async (next: string[]) => {
    setFolders(next);
    await act({ type: 'setConfig', libraryFolders: next }, undefined);
  };
  const finish = async () => {
    await act({ type: 'setConfig', setupDone: true });
    onClose();
  };

  return (
    <Modal title="Welcome to Encore" onClose={finish} width={620}>
      <div className="guide">
        <ol className="guide-steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
              <span>{i < step ? <I.Check /> : i + 1}</span> {s}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="guide-body">
            <h3>Add your karaoke music</h3>
            <p className="muted">
              Encore plays karaoke from folders on this computer: MP3+G pairs (an .mp3 with a .cdg), zipped MP3+G, and video files like MP4. Choose the folder, or folders, where yours live.
            </p>
            <ul className="guide-folders">
              {folders.map((f) => (
                <li key={f}>
                  <I.Folder /> <span className="ellipsis mono">{f}</span>
                  <button className="btn ghost icon sm" aria-label={`Remove ${f}`} onClick={() => save(folders.filter((x) => x !== f))}>
                    <I.X />
                  </button>
                </li>
              ))}
            </ul>
            <div className="guide-add">
              {desktop ? (
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = (await desktop?.pickFolders()) ?? [];
                    if (picked.length) await save([...folders, ...picked.filter((p) => !folders.includes(p))]);
                  }}
                >
                  <I.Folder /> Add a folder…
                </button>
              ) : (
                <>
                  <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="D:\Karaoke" />
                  <button
                    className="btn"
                    disabled={!typed.trim()}
                    onClick={async () => {
                      await save([...folders, typed.trim()]);
                      setTyped('');
                    }}
                  >
                    Add
                  </button>
                </>
              )}
            </div>
            <p className={`guide-status ${folders.length && lib.trackCount ? 'ok' : ''}`}>
              {lib.scanning ? (
                <>
                  <I.Loader /> Looking through your folders…
                </>
              ) : folders.length ? (
                <>
                  <I.Check /> Found {lib.trackCount.toLocaleString()} songs
                </>
              ) : (
                'Demo songs are included, so you can try Encore without any music.'
              )}
            </p>
            <p className="muted small">No music yet? That’s fine. Singers can also request YouTube karaoke, and you can add folders any time in Settings.</p>
          </div>
        )}

        {step === 1 && (
          <div className="guide-body">
            <h3>Put the song lyrics on the big screen</h3>
            <p className="muted">
              The venue screen shows the lyrics, introduces each singer and shows the QR code. Open it, drag its window onto the TV or projector, then click it once so it can play sound. Press <kbd>F</kbd> for full screen.
            </p>
            <div className="guide-add">
              <button className="btn primary" onClick={() => window.open('/display', 'encore-display', 'popup,width=1280,height=720')}>
                <I.Monitor /> Open the venue screen
              </button>
              <span className={`guide-status ${view.displays ? 'ok' : ''}`}>
                {view.displays ? (
                  <>
                    <I.Check /> Screen connected
                  </>
                ) : (
                  'Waiting for a screen…'
                )}
              </span>
            </div>
            <p className="muted small">Using a laptop with no TV for now? Skip this and come back to it with the “Open screen” button at the top.</p>
          </div>
        )}

        {step === 2 && (
          <div className="guide-body">
            <h3>Let singers join</h3>
            <div className="guide-qr">
              <img src="/api/qr.svg" alt="QR code to join" />
              <div>
                <p>
                  Singers scan this with their phone camera. No app and no account: they type a name, pick a song, and they’re in line.
                </p>
                <p className="mono guide-link">{view.joinLabel}</p>
                <p className={`guide-status ${view.show.singers.length ? 'ok' : ''}`}>
                  {view.show.singers.length ? (
                    <>
                      <I.Check /> {view.show.singers.length} on the list
                    </>
                  ) : (
                    'Try it with your own phone.'
                  )}
                </p>
              </div>
            </div>
            <p className="muted small">
              Break music between songs, your speakers, a tip QR code and more are in Settings (the gear at the top).{' '}
              <button
                className="link"
                onClick={async () => {
                  await finish();
                  window.dispatchEvent(new Event('encore:settings'));
                }}
              >
                Open Settings
              </button>
            </p>
          </div>
        )}

        <div className="guide-foot">
          <button className="btn ghost" onClick={finish}>
            Skip setup
          </button>
          <span className="spacer" />
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button className="btn primary" onClick={finish}>
              Start the show
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
