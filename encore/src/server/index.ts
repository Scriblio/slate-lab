// Entry point: `npm start` (built client) or `npm run dev` (live reload).

import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { makeDemoLibrary } from './demo.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : undefined;
};

const port = Number(flag('port') ?? process.env.PORT ?? 4747);
const dataDir = resolve(flag('data') ?? process.env.ENCORE_DATA ?? resolve(import.meta.dirname, '../../data'));
const dev = args.includes('--dev');
const demo = args.includes('--demo');

const extraLibraryFolders = demo ? [await makeDemoLibrary(resolve(dataDir, 'demo-library'))] : [];
const app = await createApp({ port, dataDir, dev, host: process.env.HOST, extraLibraryFolders });
const local = await app.listen();

const line = '─'.repeat(52);
console.log(`
  ${line}
   🎤  Encore is running${dev ? ' (dev mode)' : ''}
  ${line}
   DJ console   ${local}/dj
   Venue screen ${local}/display
   Phones join  ${app.joinUrl()}

   DJ PIN (for the console on another device): ${app.config.djPin}
   Data folder  ${dataDir}
  ${line}
`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n  Saving the show…');
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
