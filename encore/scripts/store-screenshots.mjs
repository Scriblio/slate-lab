// Makes the Microsoft Store screenshots from a running demo: real pages in Electron's own Chromium, 1920 x 1080,
// with a lively made-up night in them (singers, songs, a lyric on the venue screen). Nothing is shown on screen
// and nothing is played out loud.
//
//   npm run demo                                        (in one window; PORT=4790 ENCORE_DATA=<an empty folder> to keep your own data out of it)
//   SHOTS_URL=http://127.0.0.1:4790 npx electron scripts/store-screenshots.mjs
//
// The PNGs go to docs/store-screenshots/ (or SHOTS_OUT). Each one is at least 1366 x 768, which is Microsoft's
// minimum for a desktop screenshot (docs/STORE_LISTING.md has the rest of the rules).

import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { io } from 'socket.io-client';

const BASE = (process.env.SHOTS_URL ?? 'http://127.0.0.1:4790').replace(/\/$/, '');
const OUT = resolve(process.env.SHOTS_OUT ?? 'docs/store-screenshots');
const PRELOAD = resolve('dist-desktop/preload.cjs'); // from npm run build:desktop
const W = 1920;
const H = 1080;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Closing a window mustn't end the script: Electron quits when its last one goes.
app.on('window-all-closed', () => {});

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ---- driving the show, the way the console does -------------------------------------------------------------

const dj = io(BASE, { auth: { role: 'dj' }, transports: ['websocket'] });
const ask = (event, ...args) =>
  new Promise((resolveAck, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event}: no answer`)), 30_000);
    dj.emit(event, ...args, (res) => {
      clearTimeout(timer);
      if (res?.ok) resolveAck(res.data);
      else reject(new Error(`${event}: ${res?.error ?? 'failed'}`));
    });
  });
const act = (action) => ask('dj:action', action);

let lastView = null;
let position = 0;
dj.on('dj:view', (v) => (lastView = v));
dj.on('dj:progress', (p) => (position = p.position));

const songRef = (song) =>
  song.source.kind === 'local'
    ? { kind: 'local', trackId: song.source.trackId }
    : { kind: 'youtube', videoId: song.source.videoId, title: song.title, artist: song.artist, durationSec: song.durationSec };

// ---- the pages ---------------------------------------------------------------------------------------------

async function openPage(path, { width = W, height = H } = {}) {
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    backgroundColor: '#07070c',
    // The desktop app's own preload, so the pages know they are inside it (the venue screen then needs no click to start).
    webPreferences: { preload: PRELOAD, offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setFrameRate(30);
  win.webContents.on('console-message', (e) => {
    const text = e.message ?? '';
    if (/error/i.test(e.level ?? '') && !/YouTube|favicon|ERR_BLOCKED/.test(text)) console.log(`  [${path}] ${text.slice(0, 160)}`);
  });
  await win.loadURL(`${BASE}${path}`);
  return win;
}

async function shot(win, name) {
  await wait(700); // let the last paint land
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, name), image.toPNG());
  console.log(`  saved ${name}  ${size.width} x ${size.height}`);
}

const run = (win, code) => win.webContents.executeJavaScript(code, true);

/** Type into a React-controlled input the way a keyboard would, so its onChange runs. */
const typeInto = (win, selector, text) =>
  run(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'no input'; el.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'typed'; })()`,
  );

const clickText = (win, pattern) =>
  run(
    win,
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => ${pattern}.test(x.textContent || '')); if (!b) return 'no button'; b.click(); return 'clicked: ' + b.textContent.trim().slice(0, 40); })()`,
  );

// ---- the night ----------------------------------------------------------------------------------------------

async function bestKaraoke(query) {
  const results = await ask('searchYouTube', query);
  const pick = results.find((r) => /karaoke|instrumental|sing/i.test(`${r.song.title} ${r.song.artist ?? ''}`)) ?? results[0];
  if (!pick) throw new Error(`no YouTube result for ${query}`);
  return songRef(pick.song);
}

async function seedShow() {
  const lib = await ask('search', 'step up');
  const stepUp = lib.find((r) => r.song.source.kind === 'local' && !/zip/i.test(r.song.title));
  if (!stepUp) throw new Error('the demo library has no Step Up track');
  const local = songRef(stepUp.song);

  const queue = [
    ['Marcus', [local]],
    ['Jess', ['toto africa karaoke']],
    ['Priya', ['abba dancing queen karaoke']],
    ['Dee', ['journey dont stop believin karaoke']],
    ['Sam', ['whitney houston i wanna dance with somebody karaoke']],
    ['Alex', ['bon jovi livin on a prayer karaoke']],
  ];
  for (const [name, songs] of queue) {
    const id = await act({ type: 'addSinger', name });
    for (const s of songs) {
      const ref = typeof s === 'string' ? await bestKaraoke(s) : s;
      await act({ type: 'addEntry', singerId: id, song: ref });
      console.log(`  ${name}: ${ref.kind === 'local' ? 'Step Up (Demo)' : ref.title}`);
      // The console checks every queued YouTube song by loading its player. Say they have been checked (a record kept on
      // this computer only), so the Preview card reads "5 of 5 ready" and no video is on screen.
      if (ref.kind === 'youtube') await act({ type: 'youtubeCheck', videoId: ref.videoId, ok: true, mode: 'site' });
    }
  }
}

async function main() {
  await app.whenReady();
  await mkdir(OUT, { recursive: true });
  await new Promise((r) => (lastView ? r() : dj.once('dj:view', r)));
  console.log('connected to', BASE);

  // 1. the first-run guide, on a brand-new data folder
  const first = await openPage('/dj');
  await wait(2500);
  console.log('guide text:', (await run(first, 'document.body.innerText.slice(0, 160)')).replace(/\n+/g, ' | '));
  await shot(first, '06-setup-guide.png');
  await first.destroy();

  await seedShow();

  // 2. the venue screen waiting for the first singer
  const display = await openPage('/display');
  await wait(2500);
  await shot(display, '03-venue-screen.png');

  // 3. the first singer is called up
  await act({ type: 'callNext' });
  await wait(2500);
  await shot(display, '04-venue-welcome.png');

  // 4. the song plays; lyrics wipe across the screen
  const console_ = await openPage('/dj');
  await wait(2000);
  const dismiss = await clickText(console_, /Skip|Maybe later|Not now|Close|Got it|Start/i);
  console.log('first-run guide on the console:', dismiss);
  await act({ type: 'play' });
  await wait(2500);
  await act({ type: 'seekBy', seconds: 6.5 });
  for (let i = 0; i < 40 && position < 8.2; i++) await wait(250);
  console.log('position', position.toFixed(1));
  await shot(display, '05-lyrics.png');
  console.log(await typeInto(console_, 'input[placeholder^="Search"]', 'step'));
  await wait(1500);
  await shot(console_, '01-console.png');

  // 5. a YouTube search from the console
  console.log(await typeInto(console_, 'input[placeholder^="Search"]', 'dancing queen'));
  await wait(1200);
  console.log(await clickText(console_, /Search YouTube/i));
  await wait(6000);
  await shot(console_, '02-console-youtube.png');

  dj.close();
  app.quit();
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  app.exit(1);
});
