// Builds the secure online join page (the site at the join origin, e.g.
// https://sing.scriblio.co) into dist-sing/, ready for any static host.

import react from '@vitejs/plugin-react';
import { readFile, rename, writeFile } from 'node:fs/promises';
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

// Hosting headers (strict CSP) come from vercel.json, which Vercel uses when
// it builds from the repo. Copy them next to the page for other deploys, and
// make sure the CSP allows the Supabase project the page talks to.
const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
const csp = vercel.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
if (supabaseUrl && !csp.includes(supabaseUrl)) {
  throw new Error(`vercel.json's Content-Security-Policy must allow ${supabaseUrl} (connect-src https and wss).`);
}
const { headers, cleanUrls } = vercel;
await writeFile(join(out, 'vercel.json'), JSON.stringify({ cleanUrls, headers }, null, 2));
console.log('Built dist-sing/ (online join page)');
