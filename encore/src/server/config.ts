// Server configuration: data/config.json, overridable by environment
// variables. Holds things the KJ sets once per laptop rather than per show.

import { randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { FilenameOrder } from '../shared/text.ts';

export interface Config {
  libraryFolders: string[];
  filenameOrder: FilenameOrder;
  youtubeApiKey?: string;
  /** Lets the console or a display connect from another device. */
  djPin: string;
  /** Base URL phones should use, when the LAN address isn't right (tunnels). */
  publicUrl?: string;
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
    filenameOrder: saved.filenameOrder === 'title-artist' ? 'title-artist' : 'artist-title',
    youtubeApiKey: saved.youtubeApiKey,
    djPin: saved.djPin ?? String(randomInt(100000, 1000000)),
    publicUrl: saved.publicUrl,
  };
  if (!saved.djPin) await saveConfig(dataDir, config);
  // Environment wins over the file, but is not written back to it.
  const lib = env.ENCORE_LIBRARY ?? env.LIBRARY;
  return {
    ...config,
    libraryFolders: lib ? lib.split(delimiter).filter(Boolean) : config.libraryFolders,
    youtubeApiKey: env.YOUTUBE_API_KEY || config.youtubeApiKey,
    djPin: env.DJ_PIN || config.djPin,
    publicUrl: env.PUBLIC_URL || config.publicUrl,
  };
}

export async function saveConfig(dataDir: string, config: Config): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
}
