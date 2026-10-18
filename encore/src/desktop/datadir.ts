// Where the desktop app keeps its data folder, and how the Microsoft Store build picks up an installer
// version's data the first time it runs. Plain Node, with no Electron in it, so the tests can run it.
//
// Why the Store build is different: Windows sends the writes a Store (MSIX) desktop app makes to
// AppData to a private place that Explorer can't open and that uninstalling the app deletes. The data
// folder holds what a KJ can't lose (settings, song keys, show history, and the room and key behind
// their printed QR codes), so the Store build keeps it in a folder of its own in the user's profile,
// which Windows doesn't redirect. That needs no special permission from Microsoft. See STORE.md ("The
// data folder").

import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The Store build's data folder, in the user's profile: C:\Users\name\Encore Karaoke. */
export const STORE_FOLDER = 'Encore Karaoke';

export interface DataDirInput {
  /** True when running from a Microsoft Store (MSIX) package: Electron's `process.windowsStore`. */
  windowsStore: boolean;
  /** Electron's per-user folder for Encore: %APPDATA%\Encore Karaoke on Windows. */
  userData: string;
  /** The user's profile folder, such as C:\Users\name. */
  home: string;
}

/** The folder Encore keeps its data in. */
export function dataDirFor({ windowsStore, userData, home }: DataDirInput): string {
  return windowsStore ? join(home, STORE_FOLDER) : installerDataDir(userData);
}

/** Where the installer version (and `npm run desktop`) keeps its data. The Store build looks here once. */
export function installerDataDir(userData: string): string {
  return join(userData, 'data');
}

/** The sign-in and the license pass belong to one installation, so a second one starts signed out. */
const PER_INSTALLATION = new Set(['account.json', 'license.json']);

/** Made again by every start, so there's no point carrying it over. */
const REMADE = new Set(['demo-library']);

/** Is this file, anywhere in an installer data folder, something the Store build should carry over? */
export function worthCopying(name: string): boolean {
  // Only the data files (all .json): not the scratch files an interrupted save leaves, such as show.json.123.tmp.
  return name.endsWith('.json') && !PER_INSTALLATION.has(name);
}

export interface Adopted {
  /** The files copied, as paths inside the data folder, in the order they were. config.json is always last. */
  copied: string[];
  /** The files that couldn't be copied (still in the installer's folder, so nothing is lost). */
  failed: string[];
}

export interface AdoptOps {
  copyFile: (from: string, to: string, mode: number) => Promise<void>;
}

const exists = (path: string) => access(path).then(() => true, () => false);

/** Every file worth carrying over under `dir`, as paths relative to `base`: the top-level files and the folders such as past-shows. */
async function filesToCopy(base: string, dir = base): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir !== base || !REMADE.has(entry.name)) out.push(...(await filesToCopy(base, path)));
    } else if (entry.isFile() && worthCopying(entry.name)) {
      out.push(path.slice(base.length + 1));
    }
  }
  return out;
}

/**
 * The first run of the Store build on a PC that already has the installer version: copy the settings,
 * song keys, show, past shows and the printed QR codes' room and key across, so nothing about the KJ's
 * setup is lost by switching. Nothing is moved: the installer version keeps its own folder.
 *
 * It only does anything when the Store folder has no config.json yet (a new one, or one a crash left
 * half filled) and the installer folder has one. Files already in the Store folder are never replaced.
 * config.json goes last, so a copy that is cut short starts again on the next run.
 */
export async function adoptInstallerData(from: string, to: string, ops: AdoptOps = { copyFile }): Promise<Adopted | undefined> {
  if (await exists(join(to, 'config.json'))) return undefined;
  if (!(await exists(join(from, 'config.json')))) return undefined;
  await mkdir(to, { recursive: true });

  const files = (await filesToCopy(from)).sort((a, b) => Number(a === 'config.json') - Number(b === 'config.json') || a.localeCompare(b));

  const result: Adopted = { copied: [], failed: [] };
  for (const name of files) {
    try {
      await mkdir(dirname(join(to, name)), { recursive: true });
      await ops.copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
      result.copied.push(name);
    } catch (err) {
      // A file that is already there stays as it is; anything else is reported and the rest carries on.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') result.failed.push(name);
    }
  }
  return result;
}
