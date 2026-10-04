import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.ts';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'encore-config-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const dirWith = async (name: string, saved?: object) => {
  const dir = join(root, name);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  if (saved) await writeFile(join(dir, 'config.json'), JSON.stringify(saved));
  return dir;
};

describe('the first-run guide flag', () => {
  it('a brand new installation hasn’t been set up', async () => {
    const config = await loadConfig(await dirWith('fresh'), {});
    expect(config.setupDone).toBe(false);
    expect(config.libraryFolders).toEqual([]);
    expect(config.breakFolders).toEqual([]);
    expect(config.audioOutput).toBe('');
  });

  it('an installation that already has a library doesn’t get the guide after an update', async () => {
    const config = await loadConfig(await dirWith('old', { libraryFolders: ['D:/Karaoke'], installId: 'abc', djPin: '123456' }), {});
    expect(config.setupDone).toBe(true);
  });

  it('remembers a choice, whichever way it went', async () => {
    expect((await loadConfig(await dirWith('done', { setupDone: true, installId: 'abc', djPin: '123456' }), {})).setupDone).toBe(true);
    expect((await loadConfig(await dirWith('shown', { setupDone: false, libraryFolders: ['D:/Karaoke'], installId: 'abc', djPin: '123456' }), {})).setupDone).toBe(false);
  });

  it('a library set through the environment doesn’t count as set up', async () => {
    expect((await loadConfig(await dirWith('env'), { ENCORE_LIBRARY: 'D:/Karaoke' })).setupDone).toBe(false);
  });
});
