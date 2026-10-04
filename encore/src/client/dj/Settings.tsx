// Show settings, library folders, YouTube search and remote access.

import { useEffect, useState, type ReactNode } from 'react';
import type { ServerConfigView } from '../../shared/protocol.ts';
import type { Settings } from '../../shared/types.ts';
import { listOutputDevices, playTestSound, type OutputDevice } from '../common/audio-output.ts';
import { desktop } from '../common/desktop.ts';
import * as I from '../common/icons.tsx';
import { request } from '../common/socket.ts';
import { Modal, Toggle, useToast, YouTubeTerms } from '../common/ui.tsx';
import { useDj } from './context.ts';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { view, act, socket } = useDj();
  const toast = useToast();
  const s = view.show.settings;
  const [config, setConfig] = useState<ServerConfigView | null>(null);
  const [folders, setFolders] = useState('');
  const [breakFolders, setBreakFolders] = useState('');
  const [devices, setDevices] = useState<OutputDevice[] | null>(null);

  // The speakers this computer has, kept up to date as they're plugged in and out.
  useEffect(() => {
    let live = true;
    const load = () => void listOutputDevices().then((d) => live && setDevices(d));
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, []);
  const [showName, setShowName] = useState(s.showName);
  const [blocked, setBlocked] = useState(s.blockedWords);
  const [confirmNew, setConfirmNew] = useState(false);

  useEffect(() => {
    request<ServerConfigView>(socket, 'dj:config').then((c) => {
      setConfig(c);
      setFolders(c.libraryFolders.join('\n'));
      setBreakFolders(c.breakFolders.join('\n'));
    });
  }, [socket]);

  const set = (patch: Partial<Settings>) => act({ type: 'updateSettings', patch });
  const lib = view.library;
  const foldersChanged = config && folders.trim() !== config.libraryFolders.join('\n').trim();
  const breakChanged = config && breakFolders.trim() !== config.breakFolders.join('\n').trim();
  const brk = view.breakMusic;

  return (
    <Modal title="Settings" onClose={onClose} width={640}>
      <div className="settings">
        <Section title="Tonight’s show">
          <Field label="Show name" hint="Shown on phones and the venue screen.">
            <input
              className="input"
              value={showName}
              maxLength={60}
              onChange={(e) => setShowName(e.target.value)}
              onBlur={() => showName.trim() && showName !== s.showName && set({ showName })}
            />
          </Field>
          <Switch label="Sign-ups open" hint="Turn off for last call: no new singers or requests from phones." checked={s.joinOpen} onChange={(v) => set({ joinOpen: v })} />
          <Switch label="Approve phone requests" hint="Requests wait in your inbox until you OK them." checked={s.requireApproval} onChange={(v) => set({ requireApproval: v })} />
          <Field label="Songs a singer can have waiting" hint="0 means no limit. You can always add more yourself.">
            <input className="input narrow" type="number" min={0} max={50} value={s.maxQueuedPerSinger} onChange={(e) => set({ maxQueuedPerSinger: Number(e.target.value) })} />
          </Field>
          <Switch label="Allow YouTube requests" hint="Singers can pick YouTube karaoke videos as well as your library." checked={s.allowYouTube} onChange={(v) => set({ allowYouTube: v })} />
          <Switch label="Let singers browse the song list" hint="Phones get a scrollable list of your whole library, by artist or title, as well as search." checked={s.allowBrowse} onChange={(v) => set({ allowBrowse: v })} />
          <Switch label="Block rude names" hint="Names go up on the venue screen. Phones can’t join with a rude one, and you can always add someone yourself." checked={s.nameFilter} onChange={(v) => set({ nameFilter: v })} />
          {s.nameFilter && (
            <Field label="Also block these words" hint="Your own list, separated by commas. Short words only match a whole name; longer ones match inside a name too.">
              <input
                className="input"
                value={blocked}
                maxLength={300}
                onChange={(e) => setBlocked(e.target.value)}
                onBlur={() => blocked.trim() !== s.blockedWords.trim() && set({ blockedWords: blocked })}
                placeholder="e.g. gary, karen"
              />
            </Field>
          )}
          <Switch label="Show song titles to singers" hint="Off keeps everyone’s picks a surprise; phones only see names." checked={s.showSongsToSingers} onChange={(v) => set({ showSongsToSingers: v })} />
        </Section>

        <Section title="Stage">
          <Switch label="Call the next singer automatically" hint="When a song ends, the next singer’s intro card goes up right away." checked={s.autoAdvance} onChange={(v) => set({ autoAdvance: v })} />
          <Field label="Auto-start after intro (seconds)" hint="0 waits for you to press Start — best when singers need time to reach the mic.">
            <input className="input narrow" type="number" min={0} max={120} value={s.autoStartSec} onChange={(e) => set({ autoStartSec: Number(e.target.value) })} />
          </Field>
          <Field label="Changeover time (seconds)" hint="Time between singers, used for wait estimates.">
            <input className="input narrow" type="number" min={0} max={600} value={s.changeoverSec} onChange={(e) => set({ changeoverSec: Number(e.target.value) })} />
          </Field>
        </Section>

        <Section title="Speakers">
          <Field label="Play sound through" hint="Pick the output your PA or mixer is plugged into. Songs and break music follow it. YouTube videos play in YouTube’s own player and always use the Windows default output.">
            <div className="settings-row">
              <select
                className="input"
                value={config?.audioOutput ?? ''}
                onChange={async (e) => {
                  const audioOutput = e.target.value;
                  await act({ type: 'setConfig', audioOutput });
                  setConfig((c) => c && { ...c, audioOutput });
                }}
              >
                <option value="">System default (whatever Windows is using)</option>
                {(devices ?? []).filter((d) => d.id !== 'default').map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
                {config?.audioOutput && devices && !devices.some((d) => d.id === config.audioOutput) && <option value={config.audioOutput}>(not connected right now)</option>}
              </select>
              <button className="btn sm" onClick={() => playTestSound(config?.audioOutput ?? '').catch((e: Error) => toast(e.message, 'error'))}>
                <I.Volume /> Test
              </button>
            </div>
          </Field>
          {config?.audioOutput && devices && !devices.some((d) => d.id === config.audioOutput) && (
            <p className="settings-error">
              <I.Alert /> The speakers you picked aren’t connected, so sound is using the Windows default. Plug them back in and they’ll be used again.
            </p>
          )}
        </Section>

        <Section title="Karaoke library">
          <Field
            label="Folders (one per line)"
            hint="Encore scans for MP4/MKV/WebM video, MP3+G pairs (.mp3 + .cdg), and zipped MP3+G. Files named “DiscID - Artist - Title” are understood."
          >
            <textarea className="input mono" rows={3} value={folders} onChange={(e) => setFolders(e.target.value)} placeholder={'/Users/me/Karaoke\nD:\\Karaoke'} />
          </Field>
          <div className="settings-row">
            <select
              className="input narrow-select"
              value={config?.filenameOrder ?? 'artist-title'}
              onChange={async (e) => {
                const filenameOrder = e.target.value as ServerConfigView['filenameOrder'];
                await act({ type: 'setConfig', filenameOrder });
                setConfig((c) => c && { ...c, filenameOrder });
              }}
            >
              <option value="artist-title">Artist - Title</option>
              <option value="title-artist">Title - Artist</option>
            </select>
            <span className="muted small">filename order</span>
            <span className="spacer" />
            {desktop && (
              <button
                className="btn sm"
                onClick={async () => {
                  const picked = (await desktop?.pickFolders()) ?? [];
                  if (!picked.length) return;
                  const current = folders.split('\n').map((f) => f.trim()).filter(Boolean);
                  setFolders([...current, ...picked.filter((p) => !current.includes(p))].join('\n'));
                }}
              >
                <I.Folder /> Browse…
              </button>
            )}
            {foldersChanged ? (
              <button
                className="btn sm primary"
                onClick={async () => {
                  const libraryFolders = folders.split('\n').map((f) => f.trim()).filter(Boolean);
                  await act({ type: 'setConfig', libraryFolders }, 'Scanning library…');
                  setConfig((c) => c && { ...c, libraryFolders });
                }}
              >
                Save & scan
              </button>
            ) : (
              <button className="btn sm" onClick={() => act({ type: 'rescanLibrary' })} disabled={lib.scanning}>
                {lib.scanning ? <I.Loader /> : <I.Restart />} Rescan
              </button>
            )}
          </div>
          <p className="muted small">
            {lib.scanning ? 'Scanning…' : `${lib.trackCount.toLocaleString()} tracks`}
            {lib.lastScanAt && !lib.scanning && ` · scanned ${new Date(lib.lastScanAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
          </p>
          {lib.errors.map((e) => (
            <p key={e} className="settings-error">
              <I.Alert /> {e}
            </p>
          ))}
        </Section>

        <Section title="Break music">
          <p className="muted small">
            Music and videos for between singers, kept in a folder of their own. Music plays over moving graphics on the venue screen, and videos play full screen. It plays whenever nothing is on stage, and fades out when a singer starts.
          </p>
          <Switch label="Play break music" hint="Turn it off to keep the venue screen quiet between songs." checked={s.breakMusic} onChange={(v) => set({ breakMusic: v })} />
          <Field label="Folders (one per line)" hint="MP3, M4A, WAV, FLAC and OGG music, and MP4, MKV, WebM and MOV videos. Karaoke files in here are left out.">
            <textarea className="input mono" rows={2} value={breakFolders} onChange={(e) => setBreakFolders(e.target.value)} placeholder={'D:\Break Music'} />
          </Field>
          <div className="settings-row">
            <span className="spacer" />
            {desktop && (
              <button
                className="btn sm"
                onClick={async () => {
                  const picked = (await desktop?.pickFolders()) ?? [];
                  if (!picked.length) return;
                  const current = breakFolders.split('\n').map((f) => f.trim()).filter(Boolean);
                  setBreakFolders([...current, ...picked.filter((p) => !current.includes(p))].join('\n'));
                }}
              >
                <I.Folder /> Browse…
              </button>
            )}
            {breakChanged ? (
              <button
                className="btn sm primary"
                onClick={async () => {
                  const folders = breakFolders.split('\n').map((f) => f.trim()).filter(Boolean);
                  await act({ type: 'setConfig', breakFolders: folders }, 'Scanning break music…');
                  setConfig((c) => c && { ...c, breakFolders: folders });
                }}
              >
                Save & scan
              </button>
            ) : (
              <button className="btn sm" onClick={() => act({ type: 'setConfig', breakFolders: config?.breakFolders ?? [] })} disabled={brk.scanning}>
                {brk.scanning ? <I.Loader /> : <I.Restart />} Rescan
              </button>
            )}
          </div>
          <p className="muted small">{brk.scanning ? 'Scanning…' : `${brk.tracks.toLocaleString()} songs and videos`}</p>
          {brk.errors.map((e) => (
            <p key={e} className="settings-error">
              <I.Alert /> {e}
            </p>
          ))}
          <p className="muted small">
            Need some? Free-to-use libraries such as Pixabay Music and the Free Music Archive have plenty; check each track’s licence. A bar that plays commercial music needs its own public-performance licences, but royalty-free music doesn’t.
          </p>
        </Section>

        <Section title="YouTube search">
          <p className="muted small">
            {config?.youtubeSearch === 'off'
              ? 'YouTube search is turned off in this copy of Encore. Pasting a YouTube link still works.'
              : config?.youtubeSearch === 'own-key'
                ? 'Searching YouTube directly with the developer key from YOUTUBE_API_KEY.'
                : 'Built in: search YouTube right from Encore, with nothing to set up. Pasting a YouTube link works too.'}{' '}
            Some uploaders block their videos from playing outside YouTube; Encore only lists videos that allow it and flags any that fail.
          </p>
          <p className="muted small">
            <YouTubeTerms />
          </p>
        </Section>

        {config?.onlineJoinAvailable && (
          <Section title="How phones join">
            <Switch
              label="Secure online link"
              hint="The QR code opens a secure https page, so phones don't show a 'not secure' warning and can join on any network, even cellular data. Messages are encrypted end to end. Needs internet; without it, Encore uses the Wi-Fi link automatically."
              checked={config.onlineJoin}
              onChange={async (onlineJoin) => {
                await act({ type: 'setConfig', onlineJoin });
                setConfig((c) => c && { ...c, onlineJoin });
              }}
            />
            <p className="muted small">
              Status:{' '}
              {
                {
                  online: 'online',
                  connecting: 'connecting…',
                  offline: 'no internet, so using the Wi-Fi link',
                  'page-down': `waiting for ${view.relay.onlineHost} to come online, using the Wi-Fi link meanwhile`,
                  off: 'off (using the Wi-Fi link)',
                }[view.relay.state]
              }
              {view.relay.state === 'online' && view.relay.phones > 0 && ` · ${view.relay.phones} phone${view.relay.phones > 1 ? 's' : ''} connected`}
            </p>
          </Section>
        )}

        <Section title="Other devices">
          <p className="muted small">
            On the same Wi-Fi, phones can also join at <span className="mono">{view.relay.lanUrl}</span>. To run the console or a venue screen from another device on the same network, open{' '}
            <span className="mono">/dj</span> or <span className="mono">/display</span> there and enter this PIN:
          </p>
          <div className="pin-display">{config?.djPin ?? '······'}</div>
        </Section>

        <Section title="End of the night">
          {confirmNew ? (
            <div className="danger-zone">
              <span>Clear every singer and song and start a fresh list? Tonight’s history is saved to the data folder.</span>
              <button className="btn sm" onClick={() => setConfirmNew(false)}>
                Cancel
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  await act({ type: 'newShow' }, 'New show started');
                  onClose();
                }}
              >
                Start new show
              </button>
            </div>
          ) : (
            <button className="btn danger" onClick={() => setConfirmNew(true)}>
              <I.Restart /> Start a new show…
            </button>
          )}
        </Section>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function Switch({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="switch-row">
      <div>
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}
