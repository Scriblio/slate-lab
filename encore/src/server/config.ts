// Server configuration: data/config.json, overridable by environment
// variables. Holds things the KJ sets once per laptop rather than per show.

import { randomBytes, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { FilenameOrder } from '../shared/text.ts';

export interface Config {
  libraryFolders: string[];
  /** Music and videos played between karaoke songs. */
  breakFolders: string[];
  /** The first-run guide has been seen (or skipped), so it doesn't open again by itself. */
  setupDone: boolean;
  /** The speakers the venue screen plays through (a device id from the browser); '' is the system default. */
  audioOutput: string;
  filenameOrder: FilenameOrder;
  /** Development only: search YouTube directly with this key (env YOUTUBE_API_KEY). */
  youtubeApiKey?: string;
  /** Random id for this installation, so the YouTube search service can share its quota fairly. */
  installId: string;
  /** Lets the console or a display connect from another device. */
  djPin: string;
  /** Base URL phones should use, when the LAN address isn't right (tunnels). */
  publicUrl?: string;
  /** Use the secure online join link when the internet is available (default on). */
  onlineJoin?: boolean;
}

export async function loadConfig(dataDir: string, env = process.env): Promise<Config> {
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Partial<Config>;
  } catch {
    // first run
  }
  const config: Config = {
    libraryFolders: saved.libraryFolders ?? [],
    breakFolders: saved.breakFolders ?? [],
    // An installation that already has a library from before the guide existed doesn't need it.
    setupDone: typeof saved.setupDone === 'boolean' ? saved.setupDone : Boolean(saved.libraryFolders?.length),
    audioOutput: typeof saved.audioOutput === 'string' ? saved.audioOutput : '',
    filenameOrder: saved.filenameOrder === 'title-artist' ? 'title-artist' : 'artist-title',
    installId: saved.installId ?? randomBytes(16).toString('base64url'),
    djPin: saved.djPin ?? String(randomInt(100000, 1000000)),
    publicUrl: saved.publicUrl,
    onlineJoin: saved.onlineJoin,
  };
  if (!saved.djPin || !saved.installId) await saveConfig(dataDir, config);
  // Environment wins over the file, but is not written back to it.
  const lib = env.ENCORE_LIBRARY ?? env.LIBRARY;
  return {
    ...config,
    libraryFolders: lib ? lib.split(delimiter).filter(Boolean) : config.libraryFolders,
    youtubeApiKey: env.YOUTUBE_API_KEY || undefined,
    djPin: env.DJ_PIN || config.djPin,
    publicUrl: env.PUBLIC_URL || config.publicUrl,
  };
}

export async function saveConfig(dataDir: string, config: Config): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
}
