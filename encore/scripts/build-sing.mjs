// Builds the secure online join page (the site at the join origin, e.g.
// https://sing.scriblio.co) into dist-sing/, ready for any static host.

import react from '@vitejs/plugin-react';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const client = join(root, 'src/client');
const out = join(root, 'dist-sing');

const cloud = await readFile(join(root, 'src/shared/cloud.ts'), 'utf8');
const supabaseUrl = process.env.ENCORE_SUPABASE_URL || cloud.match(/supabaseUrl:\s*'([^']*)'/)?.[1] || '';
if (!supabaseUrl) console.warn('Note: no Supabase URL in src/shared/cloud.ts yet; the page will only show "scan the QR code".');

await build({
  configFile: false,
  root: client,
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { sing: join(client, 'sing.html') } } },
});
await rename(join(out, 'sing.html'), join(out, 'index.html'));

// Icons from the app's artwork (see scripts/make-icons.mjs): a favicon.ico
// wrapping the 256px PNG (ICO files may embed PNGs), and the home-screen icon.
const png256 = await readFile(join(root, 'build/appx/Square44x44Logo.targetsize-256_altform-unplated.png'));
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // one image
ico.writeUInt8(0, 6); // width 256
ico.writeUInt8(0, 7); // height 256
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bits per pixel
ico.writeUInt32LE(png256.length, 14);
ico.writeUInt32LE(22, 18); // image data offset
await writeFile(join(out, 'favicon.ico'), Buffer.concat([ico, png256]));
await copyFile(join(root, 'build/appx/Square150x150Logo.scale-200.png'), join(out, 'apple-touch-icon.png'));
await writeFile(join(out, 'icon-256.png'), png256);

// Lock-screen alerts: the service worker that shows them, and the web app
// manifest iPhones need before they allow alerts (from the home screen).
await copyFile(join(root, 'src/sw/sw.js'), join(out, 'sw.js'));
await copyFile(join(root, 'src/sw/manifest.webmanifest'), join(out, 'manifest.webmanifest'));

// The YouTube player page Encore embeds (see src/client/common/youtube-embed.ts).
await copyFile(join(root, 'src/ytframe/yt-frame.html'), join(out, 'yt-frame.html'));
await copyFile(join(root, 'src/ytframe/yt-frame.js'), join(out, 'yt-frame.js'));

// Hosting headers (strict CSP) come from vercel.json, which Vercel uses when
// it builds from the repo. Copy them next to the page for other deploys, and
// make sure the CSP allows the Supabase project the page talks to.
const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
// The player page needs its own rule: YouTube must get a Referer, and Encore must be able to frame it.
const frameRule = vercel.headers.find((r) => r.source.startsWith('/yt-frame'));
const frameHeader = (k) => frameRule?.headers.find((h) => h.key === k)?.value ?? '';
if (!frameRule || frameHeader('Referrer-Policy') === 'no-referrer' || !frameHeader('Content-Security-Policy').includes('frame-ancestors http: https:')) {
  throw new Error('vercel.json needs a /yt-frame rule that sends a Referer and allows framing.');
}
// Phones must always fetch the latest service worker, or a fix could take a day to reach them.
const swRule = vercel.headers.find((r) => r.source === '/sw.js');
if (!swRule?.headers.some((h) => h.key === 'Cache-Control' && /no-cache|max-age=0/.test(h.value))) {
  throw new Error('vercel.json needs a /sw.js rule with Cache-Control: no-cache.');
}
if (supabaseUrl && !csp.includes(supabaseUrl)) {
  throw new Error(`vercel.json's Content-Security-Policy must allow ${supabaseUrl} (connect-src https and wss).`);
}
const { headers, cleanUrls } = vercel;
await writeFile(join(out, 'vercel.json'), JSON.stringify({ cleanUrls, headers }, null, 2));
console.log('Built dist-sing/ (online join page)');
