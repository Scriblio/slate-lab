// The Microsoft Store build keeps its data in the user's profile, not AppData, because Windows sends a
// Store app's writes to AppData to a private place that Explorer can't open and uninstalling deletes
// (STORE.md, "The data folder"). These check where the data goes and how a first run picks up an
// installer version's data.

import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptInstallerData, dataDirFor, installerDataDir, STORE_FOLDER, worthCopying } from '../src/desktop/datadir.ts';

let root: string;
let userData: string;
let from: string; // the installer version's data folder
let to: string; // the Store build's
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'encore-datadir-'));
  userData = join(root, 'AppData', 'Roaming', 'Encore Karaoke');
  from = installerDataDir(userData);
  to = join(root, 'home', STORE_FOLDER);
  await mkdir(from, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(dir: string, files: Record<string, string>) {
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}
const names = async (dir: string) => (await readdir(dir)).sort();

/** What an installer version leaves: its data files, a sign-in and pass of its own, scratch from an interrupted save, and the demo songs. */
async function installerData() {
  await put(from, {
    'config.json': '{"installId":"abc","djPin":"1234"}',
    'show.json': '{"singers":[1,2,3]}',
    'relay.json': '{"room":"r","key":"k"}',
    'keys.json': '{"alex":2}',
    'song-keys.json': '{}',
    'youtube-refused.json': '[]',
    'push.json': '{"vapid":"x"}',
    'push-subscriptions.json': '[]',
    'account.json': '{"refresh":"one-time"}',
    'license.json': '{"pass":"for the installer"}',
    'show.json.4242.tmp': 'half written',
    'config.json.bak-msix-test': 'old',
  });
  await put(join(from, 'demo-library'), { 'Step Up.mp3': 'not really audio' });
  // each night's list, filed away when the KJ starts a new one
  await put(join(from, 'past-shows'), {
    '2026-10-03-18-01-aaaa.json': '{"night":1}',
    '2026-10-04-21-07-bbbb.json': '{"night":2}',
    '2026-10-16-22-20-cccc.json.77.tmp': 'half written',
  });
}

describe('dataDirFor', () => {
  const home = join(tmpdir(), 'someone');
  const userDataDir = join(home, 'AppData', 'Roaming', 'Encore Karaoke');

  it('keeps the installer version and a run from source in Electron’s own folder', () => {
    expect(dataDirFor({ windowsStore: false, userData: userDataDir, home })).toBe(join(userDataDir, 'data'));
  });

  it('puts the Store build in a folder of its own in the user’s profile, outside AppData', () => {
    const dir = dataDirFor({ windowsStore: true, userData: userDataDir, home });
    expect(dir).toBe(join(home, 'Encore Karaoke'));
    // Windows redirects what a Store app writes under AppData; this must not be anywhere near it.
    expect(dir.startsWith(join(home, 'AppData'))).toBe(false);
    expect(dir.startsWith(userDataDir)).toBe(false);
  });
});

describe('worthCopying', () => {
  it('takes the data files', () => {
    for (const name of ['config.json', 'show.json', 'relay.json', 'keys.json', 'song-keys.json', 'youtube-refused.json', 'push.json', 'push-subscriptions.json']) {
      expect(worthCopying(name), name).toBe(true);
    }
  });

  it('leaves the sign-in and the license pass, which belong to one installation', () => {
    expect(worthCopying('account.json')).toBe(false);
    expect(worthCopying('license.json')).toBe(false);
  });

  it('leaves scratch files and backups', () => {
    expect(worthCopying('show.json.4242.tmp')).toBe(false);
    expect(worthCopying('config.json.bak-msix-test')).toBe(false);
    expect(worthCopying('notes.txt')).toBe(false);
  });
});

describe('adoptInstallerData', () => {
  it('carries the settings, show and printed-QR identity over, and leaves the rest', async () => {
    await installerData();
    const result = await adoptInstallerData(from, to);

    expect(result?.failed).toEqual([]);
    expect(await names(to)).toEqual(['config.json', 'keys.json', 'past-shows', 'push-subscriptions.json', 'push.json', 'relay.json', 'show.json', 'song-keys.json', 'youtube-refused.json']);
    expect(await readFile(join(to, 'relay.json'), 'utf8')).toBe('{"room":"r","key":"k"}');
    expect(await readFile(join(to, 'config.json'), 'utf8')).toBe('{"installId":"abc","djPin":"1234"}');
    // a new sign-in, not the installer's one-time refresh token; and no scratch, backups or demo songs
    expect(await names(to)).not.toContain('account.json');
    expect(await names(to)).not.toContain('license.json');
    expect(await names(to)).not.toContain('demo-library');
  });

  it('carries the past shows over, but not the scratch files beside them', async () => {
    await installerData();
    await adoptInstallerData(from, to);
    expect(await names(join(to, 'past-shows'))).toEqual(['2026-10-03-18-01-aaaa.json', '2026-10-04-21-07-bbbb.json']);
    expect(await readFile(join(to, 'past-shows', '2026-10-04-21-07-bbbb.json'), 'utf8')).toBe('{"night":2}');
  });

  it('copies config.json last, so a copy that is cut short starts again', async () => {
    await installerData();
    const result = await adoptInstallerData(from, to);
    expect(result?.copied.at(-1)).toBe('config.json');
    expect(result?.copied).toHaveLength(10); // eight data files and two past shows
    expect(result?.copied).toContain(join('past-shows', '2026-10-03-18-01-aaaa.json'));
  });

  it('moves nothing: the installer version keeps all of its own', async () => {
    await installerData();
    const before = await names(from);
    await adoptInstallerData(from, to);
    expect(await names(from)).toEqual(before);
    expect(await readFile(join(from, 'account.json'), 'utf8')).toBe('{"refresh":"one-time"}');
  });

  it('does nothing once the Store folder has its own config.json', async () => {
    await installerData();
    await put(to, { 'config.json': '{"installId":"store"}', 'relay.json': '{"room":"mine"}' });

    expect(await adoptInstallerData(from, to)).toBeUndefined();
    expect(await readFile(join(to, 'config.json'), 'utf8')).toBe('{"installId":"store"}');
    expect(await readFile(join(to, 'relay.json'), 'utf8')).toBe('{"room":"mine"}');
    expect(await names(to)).toEqual(['config.json', 'relay.json']);
  });

  it('does nothing, and makes no folder, on a PC that never had the installer version', async () => {
    await rm(from, { recursive: true });
    expect(await adoptInstallerData(from, to)).toBeUndefined();
    await expect(readdir(to)).rejects.toThrow();
  });

  it('does nothing when the installer folder has no settings yet', async () => {
    await put(from, { 'account.json': '{}', 'show.json': '{}' });
    expect(await adoptInstallerData(from, to)).toBeUndefined();
    await expect(readdir(to)).rejects.toThrow();
  });

  it('finishes a copy that was cut short without replacing what is already there', async () => {
    await installerData();
    // an earlier run got as far as relay.json (and the KJ has since printed from a changed one) before it stopped
    await put(to, { 'relay.json': '{"room":"newer"}' });

    const result = await adoptInstallerData(from, to);

    expect(result?.copied).not.toContain('relay.json');
    expect(result?.failed).toEqual([]);
    expect(await readFile(join(to, 'relay.json'), 'utf8')).toBe('{"room":"newer"}');
    expect(await readFile(join(to, 'config.json'), 'utf8')).toBe('{"installId":"abc","djPin":"1234"}');
    expect(await readFile(join(to, 'keys.json'), 'utf8')).toBe('{"alex":2}');
  });

  it('reports a file it can’t copy and carries on with the rest', async () => {
    await installerData();
    const { copyFile } = await import('node:fs/promises');
    const result = await adoptInstallerData(from, to, {
      copyFile: async (src, dst, mode) => {
        if (basename(src) === 'keys.json') throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        await copyFile(src, dst, mode);
      },
    });

    expect(result?.failed).toEqual(['keys.json']);
    expect(result?.copied).toContain('config.json');
    expect(await names(to)).not.toContain('keys.json');
    expect(await names(from)).toContain('keys.json'); // still there, so nothing is lost
  });
});
