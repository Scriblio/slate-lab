// Renders the app icon and the Microsoft Store tile images from one design.
// Run with `npm run icons` (it uses Electron to draw them); outputs go to build/.

import { app, BrowserWindow } from 'electron';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const out = join(root, 'build');
const font = pathToFileURL(join(root, 'node_modules/@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2')).href;

const MIC = `
  <g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" fill="#fff" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
  </g>`;

/** The rounded-square mark, `size` px, with `pad` px of transparent margin. */
function mark(size, pad) {
  const s = size - pad * 2;
  const r = s * 0.23;
  const k = (s * 0.56) / 24;
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff3d7f" /><stop offset="1" stop-color="#ff8a4c" />
      </linearGradient>
      <radialGradient id="shine" cx="0.25" cy="0.15" r="0.9">
        <stop offset="0" stop-color="#fff" stop-opacity="0.32" /><stop offset="0.55" stop-color="#fff" stop-opacity="0" />
      </radialGradient>
    </defs>
    <rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${r}" fill="url(#g)" />
    <rect x="${pad}" y="${pad}" width="${s}" height="${s}" rx="${r}" fill="url(#shine)" />
    <g transform="translate(${size / 2} ${size / 2 + s * 0.01}) scale(${k}) translate(-12 -12)">${MIC}</g>
  </svg>`;
}

function page(body, w, h, bg = 'transparent') {
  return `<!doctype html><html><head><style>
    @font-face { font-family: Outfit; src: url(${font}); font-weight: 100 900; }
    html, body { margin: 0; width: ${w}px; height: ${h}px; background: ${bg}; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: center; gap: ${h * 0.09}px; font-family: Outfit, sans-serif; }
    .word { color: #fff; font-weight: 700; font-size: ${h * 0.3}px; letter-spacing: -0.02em; }
  </style></head><body>${body}</body></html>`;
}

let seq = 0;
async function render(html, w, h) {
  const file = join(tmp, `icon-${seq++}.html`);
  await writeFile(file, html);
  const win = new BrowserWindow({ width: w, height: h, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  await win.loadFile(file);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  win.destroy();
  return img.getSize().width === w ? img : img.resize({ width: w, height: h, quality: 'best' });
}

const sizedMark = async (size, padRatio) => {
  const big = await render(page(mark(1024, 1024 * padRatio), 1024, 1024), 1024, 1024);
  return size === 1024 ? big : big.resize({ width: size, height: size, quality: 'best' });
};

const wide = (w, h, bg) => page(`${mark(h * 0.62, 0)}<span class="word">Encore</span>`, w, h, bg);

app.disableHardwareAcceleration();
// Each render closes its window; don't let that end the script.
app.on('window-all-closed', () => {});
let tmp = '';
app.whenReady().then(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'encore-icons-'));
  await mkdir(join(out, 'appx'), { recursive: true });
  const save = (name, img) => writeFile(join(out, name), img.toPNG());

  // Desktop installer / window icon (electron-builder derives .ico and .icns).
  await save('icon.png', await sizedMark(1024, 0.06));

  // Microsoft Store package assets, at 100% and 200% scale.
  const squares = { StoreLogo: 50, Square44x44Logo: 44, Square150x150Logo: 150, SmallTile: 71, LargeTile: 310 };
  for (const [name, size] of Object.entries(squares)) {
    await save(`appx/${name}.png`, await sizedMark(size, 0.1));
    await save(`appx/${name}.scale-200.png`, await sizedMark(size * 2, 0.1));
  }
  // Taskbar / Start icon without a tile plate.
  await save('appx/Square44x44Logo.targetsize-256_altform-unplated.png', await sizedMark(256, 0.04));
  await save('appx/Wide310x150Logo.png', await render(wide(310, 150, 'transparent'), 310, 150));
  await save('appx/Wide310x150Logo.scale-200.png', await render(wide(620, 300, 'transparent'), 620, 300));
  await save('appx/SplashScreen.png', await render(wide(620, 300, '#07070c'), 620, 300));
  await rm(tmp, { recursive: true, force: true });
  console.log('Icons written to build/');
  app.quit();
});

