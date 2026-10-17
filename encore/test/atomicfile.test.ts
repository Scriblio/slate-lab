import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, type FileOps } from '../src/server/atomicfile.ts';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'encore-atomic-'));
  file = join(dir, 'thing.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const refused = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const noWaiting = async () => {};
const inDir = () => readdir(dir);

/** A rename that is refused this many times, as Windows does while a scanner has the file open, and then works. */
function busyFor(times: number, code = 'EPERM'): Partial<FileOps> & { tries: () => number } {
  let tries = 0;
  return {
    rename: async (from, to) => {
      if (tries++ < times) throw refused(code);
      await rename(from, to);
    },
    tries: () => tries,
  };
}

describe('writeFileAtomic', () => {
  it('writes the file whole and leaves nothing else in the folder', async () => {
    await writeFileAtomic(file, '{"a":1}');
    expect(await readFile(file, 'utf8')).toBe('{"a":1}');
    expect(await inDir()).toEqual(['thing.json']);
  });

  it('replaces what was there', async () => {
    await writeFile(file, 'old');
    await writeFileAtomic(file, 'new', { mode: 0o600 });
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(await inDir()).toEqual(['thing.json']);
  });

  it('names its temp file after the process, as the show’s start-up tidying expects', async () => {
    const seen: string[] = [];
    await writeFileAtomic(file, 'x', {
      ops: {
        write: async (path, data) => {
          seen.push(path);
          await writeFile(path, data);
        },
      },
    });
    expect(seen).toEqual([`${file}.${process.pid}.tmp`]);
  });

  it('tries again when the file is open somewhere else for a moment, waiting a little longer each time', async () => {
    const waits: number[] = [];
    const flaky = busyFor(3);
    await writeFile(file, 'old');
    await writeFileAtomic(file, 'new', { ops: { ...flaky, wait: async (ms) => void waits.push(ms) } });
    expect(await readFile(file, 'utf8')).toBe('new');
    expect(flaky.tries()).toBe(4);
    expect(waits).toEqual([10, 20, 40]);
    expect(await inDir()).toEqual(['thing.json']);
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])('counts %s as a moment, not a failure', async (code) => {
    await writeFileAtomic(file, 'ok', { ops: { ...busyFor(1, code), wait: noWaiting } });
    expect(await readFile(file, 'utf8')).toBe('ok');
  });

  it('gives up in the end, says why, keeps the old file and clears its temp file', async () => {
    await writeFile(file, 'old');
    const waits: number[] = [];
    const stuck = busyFor(Infinity);
    await expect(writeFileAtomic(file, 'new', { ops: { ...stuck, wait: async (ms) => void waits.push(ms) } })).rejects.toThrow(/EPERM/);
    expect(waits.length).toBeGreaterThanOrEqual(6);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(5000);
    expect(stuck.tries()).toBe(waits.length + 1);
    expect(await readFile(file, 'utf8')).toBe('old');
    expect(await inDir()).toEqual(['thing.json']);
  });

  it('does not wait on a real problem, like a folder that is not there', async () => {
    const waits: number[] = [];
    await expect(writeFileAtomic(join(dir, 'missing', 'thing.json'), 'x', { ops: { wait: async (ms) => void waits.push(ms) } })).rejects.toMatchObject({ code: 'ENOENT' });
    expect(waits).toEqual([]);
  });

  it('does not wait on a full disk either, and tidies up', async () => {
    const waits: number[] = [];
    const full: Partial<FileOps> = {
      rename: async () => {
        throw refused('ENOSPC');
      },
      wait: async (ms) => void waits.push(ms),
    };
    await expect(writeFileAtomic(file, 'x', { ops: full })).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(waits).toEqual([]);
    expect(await inDir()).toEqual([]);
  });

  describe('saves to the same file', () => {
    /** Disk operations that take a moment and note when each starts, to see whether saves overlap. */
    const slow = (log: string[]): Partial<FileOps> => ({
      write: async (path, data) => {
        log.push(`write ${data}`);
        await new Promise((r) => setTimeout(r, 3));
        await writeFile(path, data);
      },
      rename: async (from, to) => {
        log.push('rename');
        await new Promise((r) => setTimeout(r, 3));
        await rename(from, to);
      },
    });

    it('go one at a time, so they cannot trample each other’s temp file, and the last one wins', async () => {
      const log: string[] = [];
      await Promise.all(['a', 'b', 'c', 'd'].map((text) => writeFileAtomic(file, text, { ops: slow(log) })));
      // A rename Windows refuses for a moment is tried again, and that adds a line, so repeats count once.
      const order = log.filter((line, i) => line !== log[i - 1]);
      expect(order).toEqual(['write a', 'rename', 'write b', 'rename', 'write c', 'rename', 'write d', 'rename']);
      expect(await readFile(file, 'utf8')).toBe('d');
      expect(await inDir()).toEqual(['thing.json']);
    });

    it('carry on after one fails', async () => {
      const first = writeFileAtomic(file, 'a', { ops: { rename: async () => { throw refused('ENOSPC'); } } });
      const second = writeFileAtomic(file, 'b');
      await expect(first).rejects.toMatchObject({ code: 'ENOSPC' });
      await second;
      expect(await readFile(file, 'utf8')).toBe('b');
    });
  });

  it('does not make saves to different files wait for each other', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const held = writeFileAtomic(file, 'held', {
      ops: {
        write: async (path, data) => {
          await gate;
          await writeFile(path, data);
        },
      },
    });
    const other = join(dir, 'other.json');
    await writeFileAtomic(other, 'free');
    expect(await readFile(other, 'utf8')).toBe('free');
    open();
    await held;
    expect(await readFile(file, 'utf8')).toBe('held');
  });
});
