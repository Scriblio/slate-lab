// Show settings, library folders, YouTube search and remote access.

import { useEffect, useState, type ReactNode } from 'react';
import type { ServerConfigView } from '../../shared/protocol.ts';
import { formatTipAmount, parseTipAmounts, parseTipLink } from '../../shared/tips.ts';
import type { Settings } from '../../shared/types.ts';
import { listOutputDevices, playTestSound, type OutputDevice } from '../common/audio-output.ts';
import { desktop } from '../common/desktop.ts';
import * as I from '../common/icons.tsx';
import { request } from '../common/socket.ts';
import { Modal, Toggle, useToast, YouTubeTerms } from '../common/ui.tsx';
import { useDj } from './context.ts';
import { PrintSheet, type PrintLayout, type TentFold } from './PrintSheet.tsx';

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
  const [tipLink, setTipLink] = useState(s.tipLink);
  const [tipText, setTipText] = useState(s.tipText);
  const [tipAmounts, setTipAmounts] = useState(s.tipAmounts.map(formatTipAmount).join(', '));
  const [confirmNew, setConfirmNew] = useState(false);
  // A new number mounts a new sheet, so printing twice in a row prints twice.
  const [printing, setPrinting] = useState<{ layout: PrintLayout; n: number } | null>(null);
  const [printTip, setPrintTip] = useState(true);
  const [tentFold, setTentFold] = useState<TentFold>('bottom');
  const print = (layout: PrintLayout) => setPrinting((p) => ({ layout, n: (p?.n ?? 0) + 1 }));

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

        <Section title="Tips">
          <Field label="Tip link" hint="Your Venmo, Cash App or PayPal.me link. A QR code for it shows on the venue screen between songs, and phones get a button in The line. Encore never touches the money. Leave it empty to turn tips off.">
            <input
              className="input"
              value={tipLink}
              maxLength={300}
              onChange={(e) => setTipLink(e.target.value)}
              onBlur={() => tipLink.trim() !== s.tipLink && set({ tipLink: tipLink.trim() })}
              placeholder="https://venmo.com/u/yourname"
            />
          </Field>
          {s.tipLink && (
            <>
              <Field label="Message" hint="Shown next to the QR code and on the button.">
                <input className="input" value={tipText} maxLength={40} onChange={(e) => setTipText(e.target.value)} onBlur={() => tipText.trim() && tipText.trim() !== s.tipText && set({ tipText: tipText.trim() })} />
              </Field>
              <Field
                label="Quick tip amounts"
                hint={
                  parseTipLink(s.tipLink)
                    ? 'Phones show a button for each amount that opens the payment app with it filled in (singers can still change it), plus Other amount. Leave empty for just one button.'
                    : 'Quick amounts work with Venmo, Cash App and PayPal.me links. With this link, phones get one tip button.'
                }
              >
                <input
                  className="input tip-amounts-input"
                  value={tipAmounts}
                  maxLength={40}
                  placeholder="1, 5, 10"
                  onChange={(e) => setTipAmounts(e.target.value)}
                  onBlur={() => {
                    const amounts = parseTipAmounts(tipAmounts);
                    setTipAmounts(amounts.map(formatTipAmount).join(', '));
                    if (amounts.join() !== s.tipAmounts.join()) set({ tipAmounts: amounts });
                  }}
                />
              </Field>
              <Switch
                label="Ask for a tip after each song"
                hint="Right after a singer’s song ends, their phone thanks them and shows the tip buttons, once."
                checked={s.tipAfterSong}
                onChange={(v) => set({ tipAfterSong: v })}
              />
            </>
          )}
        </Section>

        <Section title="Print QR codes">
          <p className="muted small">Put codes on the tables and at the bar, so people can join without looking up at the screen. Each button opens the print window, where you can also save a PDF.</p>
          {view.print.lasting ? (
            <div className="print-notes">
              <strong>Good to know</strong>
              <ul>
                <li>
                  <b>Print them once.</b> The code stays the same every show, through restarts and updates.
                </li>
                <li>
                  <b>It changes only</b> if you move Encore to a different computer, uninstall it, or turn off the secure online link. Moving to a new computer? Copy Encore’s data folder over first to keep the same code.
                  {desktop && (
                    <>
                      {' '}
                      <button className="link-btn" onClick={() => void desktop?.openDataFolder()}>
                        Open the data folder
                      </button>
                    </>
                  )}
                </li>
                <li>
                  <b>Printed codes need this laptop online.</b> Without internet, the code on the big screen switches to the Wi-Fi link by itself, but printed ones work again only once you’re back online.
                </li>
              </ul>
            </div>
          ) : (
            <p className="settings-error">
              <I.Alert /> These codes use this laptop’s Wi-Fi address ({view.print.label}), which can change on another night or at another venue.{' '}
              {config?.onlineJoinAvailable ? 'Turn on the secure online link (under How phones join) for codes that keep working every show.' : 'Print new ones if it does.'}
            </p>
          )}
          {s.tipLink && <Switch label="Include the tip QR" hint="A small second code for your tip link." checked={printTip} onChange={setPrintTip} />}
          <div className="print-options">
            <div className="print-option">
              <div>
                <strong>Table tent</strong>
                <span className="muted small">The code on the top half and how to join and leave on the bottom half. Fold it in half for a table stand.</span>
                <select className="input print-fold-select" value={tentFold} onChange={(e) => setTentFold(e.target.value as TentFold)} aria-label="How the folded sheet stands">
                  <option value="bottom">Fold at the bottom (in a sign holder)</option>
                  <option value="top">Fold on top (stands by itself)</option>
                </select>
              </div>
              <button className="btn sm primary" onClick={() => print('tent')}>
                <I.Printer /> Print
              </button>
            </div>
            <div className="print-option">
              <div>
                <strong>Poster</strong>
                <span className="muted small">One big code with your show name, for the wall or the bar.</span>
              </div>
              <button className="btn sm" onClick={() => print('poster')}>
                <I.Printer /> Print
              </button>
            </div>
            <div className="print-option">
              <div>
                <strong>Table cards</strong>
                <span className="muted small">Four smaller codes to a page, with lines to cut along.</span>
              </div>
              <button className="btn sm" onClick={() => print('cards')}>
                <I.Printer /> Print
              </button>
            </div>
            <div className="print-option">
              <div>
                <strong>Just the code</strong>
                <span className="muted small">The QR code on its own, as big as the page, for your own signs and flyers.</span>
              </div>
              <button className="btn sm" onClick={() => print('qr')}>
                <I.Printer /> Print
              </button>
            </div>
          </div>
          {printing && (
            <PrintSheet
              key={printing.n}
              layout={printing.layout}
              showName={s.showName}
              typedLink={view.print.url.includes('#') ? undefined : view.print.label}
              tip={s.tipLink && printTip && printing.layout !== 'qr' ? { text: s.tipText } : undefined}
              alerts={view.print.url.includes('#')}
              fold={tentFold}
              onDone={() => setPrinting(null)}
            />
          )}
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
            Music and videos for between singers, kept in a folder of their own. Music plays over moving graphics on the venue screen, and videos play full screen. With auto play on, it plays by itself whenever nothing is on stage. With it off, start and stop it with Play on the Break music card. Either way it fades out when a singer starts.
          </p>
          <Switch label="Auto play break music" hint="Off: music only plays when you press Play on the Break music card, and stops when you press Stop or a singer starts." checked={s.breakMusic} onChange={(v) => set({ breakMusic: v })} />
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
          {!brk.scanning && brk.folders.length > 0 && brk.karaoke > 0 && (
            <p className={brk.tracks ? 'muted small' : 'settings-error'}>
              {brk.tracks ? null : <I.Alert />} {brk.karaoke.toLocaleString()} karaoke {brk.karaoke === 1 ? 'song was' : 'songs were'} left out: break music is for plain music and videos.
              {brk.tracks ? '' : ' Pick a folder with music or video files in it.'}
            </p>
          )}
          {brk.errors.map((e) => (
            <p key={e} className="settings-error">
              <I.Alert /> {e}
            </p>
          ))}
          <p className="muted small">
            Need some? Free-to-use libraries such as Pixabay Music and the Free Music Archive have plenty; check each track’s licence. A bar that plays commercial music needs its own public-performance licences, but royalty-free music doesn’t.
          </p>
        </Section>

        <Section title="Help">
          <div className="settings-row">
            <span className="muted small">New here? The setup guide walks through your music, the big screen and getting singers in.</span>
            <span className="spacer" />
            <button
              className="btn sm"
              onClick={() => {
                onClose();
                window.dispatchEvent(new Event('encore:setup'));
              }}
            >
              Show the setup guide
            </button>
          </div>
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
