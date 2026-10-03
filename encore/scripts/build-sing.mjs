// Builds the secure online join page (the site at the join origin, e.g.
// https://sing.scriblio.co) into dist-sing/, ready for any static host.
// It includes vercel.json with security headers for Vercel.

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

const realtime = supabaseUrl ? `${supabaseUrl} ${supabaseUrl.replace(/^https/, 'wss')}` : '';
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://i.ytimg.com",
  `connect-src 'self' ${realtime}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const vercel = {
  cleanUrls: true,
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
    { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
  ],
};
await writeFile(join(out, 'vercel.json'), JSON.stringify(vercel, null, 2));
console.log('Built dist-sing/ (online join page)');
