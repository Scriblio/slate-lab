// Encore as a desktop app. Starts the Encore server inside the app and
// opens the DJ console in its own window. The venue screen goes fullscreen
// on a second monitor when there is one. Phones still join over Wi-Fi.

import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron';
import { join } from 'node:path';
import { createApp, type App } from '../server/app.ts';
import { makeDemoLibrary } from '../server/demo.ts';

const PORT = 4747;
const PRODUCT = 'Encore Karaoke';

let encore: App | undefined;
let base = '';
let dj: BrowserWindow | null = null;
let display: BrowserWindow | null = null;
let quitting = false;
let quitConfirmed = false;

// Let the venue screen play sound without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('com.scriblio.encore');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dj) {
      if (dj.isMinimized()) dj.restore();
      dj.focus();
    }
  });
  app.whenReady().then(start).catch(fatal);
}

async function start(): Promise<void> {
  const dataDir = join(app.getPath('userData'), 'data');
  const demo = await makeDemoLibrary(join(dataDir, 'demo-library'), { video: false });
  encore = await createApp({
    port: PORT,
    portFallback: true,
    dataDir,
    distDir: join(app.getAppPath(), 'dist'),
    fallbackLibraryFolder: demo,
    quiet: true,
  });
  const local = await encore.listen();
  // Use 127.0.0.1 so this window is always recognized as the KJ.
  base = local.replace('localhost', '127.0.0.1');

  ipcMain.handle('encore:pick-folders', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: OpenDialogOptions = { title: 'Choose your karaoke folders', properties: ['openDirectory', 'multiSelections'] };
    const res = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('encore:open-data-folder', () => shell.openPath(dataDir));

  buildMenu(dataDir);
  openDj();
  if (process.env.ENCORE_SMOKE) void smokeTest();
}

function webPreferences() {
  return {
    preload: join(import.meta.dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

/** Keep every window on Encore's own pages; send anything else to the browser. */
function guard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).pathname.startsWith('/display')) {
      openDisplay();
      return { action: 'deny' };
    }
    if (/^https?:\/\//.test(url) && !url.startsWith(base)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(base)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

function openDj(): void {
  // Never open bigger than the screen; on smaller laptop screens, fill it.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const small = work.width < 1440 || work.height < 900;
  dj = new BrowserWindow({
    title: PRODUCT,
    width: Math.min(1440, work.width),
    height: Math.min(900, work.height),
    minWidth: Math.min(1024, work.width),
    minHeight: Math.min(600, work.height),
    backgroundColor: '#07070c',
    show: false,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  guard(dj);
  dj.once('ready-to-show', () => {
    if (small) dj?.maximize();
    dj?.show();
  });
  dj.on('close', (e) => {
    if (!quitting && !okToQuit()) e.preventDefault();
  });
  dj.on('closed', () => {
    dj = null;
    app.quit();
  });
  void dj.loadURL(`${base}/dj`);
}

/** The venue screen: fullscreen on the second monitor when there is one. */
function openDisplay(): void {
  if (display) {
    display.show();
    display.focus();
    return;
  }
  const primary = screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
  const area = (other ?? primary).bounds;
  // With one screen, a 16:9 window that fits on it (press F11 for fullscreen).
  const fitWidth = Math.min(1280, Math.round(primary.workAreaSize.width * 0.8), Math.round((primary.workAreaSize.height * 0.8 * 16) / 9));
  display = new BrowserWindow({
    title: `${PRODUCT} · Venue Screen`,
    x: other ? area.x : undefined,
    y: other ? area.y : undefined,
    width: other ? area.width : fitWidth,
    height: other ? area.height : Math.round((fitWidth * 9) / 16),
    fullscreen: Boolean(other),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPreferences(),
  });
  guard(display);
  display.once('ready-to-show', () => display?.show());
  display.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && display?.isFullScreen()) display.setFullScreen(false);
  });
  display.on('closed', () => (display = null));
  void display.loadURL(`${base}/display`);
}

function buildMenu(dataDir: string): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'Show',
      submenu: [
        { label: 'Open Venue Screen', accelerator: 'CmdOrCtrl+Shift+S', click: openDisplay },
        { label: 'Venue Screen Fullscreen', accelerator: 'F11', click: () => display?.setFullScreen(!display.isFullScreen()) },
        { type: 'separator' },
        { label: 'Open Data Folder', click: () => void shell.openPath(dataDir) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Quit Encore' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }])],
    },
    {
      role: 'help',
      submenu: [
        {
          label: `About ${PRODUCT}`,
          click: () =>
            dialog.showMessageBox({
              title: PRODUCT,
              message: `${PRODUCT} ${app.getVersion()}`,
              detail: `Phones join at ${encore?.joinUrl() ?? ''}\nDJ PIN for other devices: ${encore?.config.djPin ?? ''}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Ask before cutting someone off mid-song. */
function okToQuit(): boolean {
  if (quitConfirmed) return true;
  const np = encore?.show.state.nowPlaying;
  if (!np || np.stage !== 'playing') return (quitConfirmed = true);
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Keep the show going', 'Quit Encore'],
    defaultId: 0,
    cancelId: 0,
    title: PRODUCT,
    message: `${np.singerName} is still singing.`,
    detail: 'Quitting stops the music on the venue screen. The rotation is saved either way.',
  });
  quitConfirmed = choice === 1;
  return quitConfirmed;
}

app.on('before-quit', (e) => {
  if (quitting || !encore) return;
  e.preventDefault();
  if (!okToQuit()) return;
  quitting = true;
  encore
    .close()
    .catch(() => {})
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => app.quit());

function fatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  dialog.showErrorBox(`${PRODUCT} couldn’t start`, message);
  app.exit(1);
}

/** ENCORE_SMOKE=<dir>: screenshot both windows once loaded, then quit (used in CI and testing). */
async function smokeTest(): Promise<void> {
  const out = process.env.ENCORE_SMOKE!;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(out, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);
  openDisplay();
  await wait(2500);
  if (dj) await writeFile(join(out, 'desktop-dj.png'), (await dj.webContents.capturePage()).toPNG());
  if (display) await writeFile(join(out, 'desktop-display.png'), (await display.webContents.capturePage()).toPNG());
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  await writeFile(join(out, 'smoke.json'), JSON.stringify({ base, health, join: encore?.joinUrl(), tracks: encore?.library.getStatus().trackCount }));
  app.quit();
}
