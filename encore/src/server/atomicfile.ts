// Saves a file whole, so a crash or a power cut can't leave half of one: it is written to a temp
// file beside it and then renamed over it. On Windows that rename fails for a moment (EPERM, EBUSY
// or EACCES) when a virus scanner, the search indexer or a backup tool has the old file or the new
// one open, so it tries again a few times before giving up. Anything else (no folder, a full disk)
// is a real problem and is thrown straight away.

import { rename, rm, writeFile } from 'node:fs/promises';

/** What Windows says while something else has the file open for a moment. */
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** How long to wait before each new try: about two seconds in all, far longer than a scan takes. */
const WAITS_MS = [10, 20, 40, 80, 160, 320, 640, 640];

/** The few things it does to the disk, so a test can make them fail. */
export interface FileOps {
  write(path: string, data: string | Uint8Array, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  wait(ms: number): Promise<void>;
}

const real: FileOps = {
  write: (path, data, mode) => writeFile(path, data, { mode }),
  rename,
  remove: (path) => rm(path, { force: true }),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Saves to one file go one at a time, so two at once can't trample the same temp file. */
const queues = new Map<string, Promise<void>>();

/**
 * Replace `file` with `data`, all or nothing. The folder must exist. The temp file is named
 * `<file>.<pid>.tmp`, which is what the show's start-up tidying looks for.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number; ops?: Partial<FileOps> } = {}): Promise<void> {
  const ops: FileOps = { ...real, ...opts.ops };
  const run = async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await ops.write(tmp, data, opts.mode);
    for (let attempt = 0; ; attempt++) {
      try {
        await ops.rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const wait = WAITS_MS[attempt];
        if (!code || !BUSY.has(code) || wait === undefined) {
          await ops.remove(tmp).catch(() => {});
          throw err;
        }
        await ops.wait(wait);
      }
    }
  };
  const done = (queues.get(file) ?? Promise.resolve()).then(run);
  // The next save waits for this one, whether it worked or not, and the list doesn't grow.
  const last = done.catch(() => {}).finally(() => {
    if (queues.get(file) === last) queues.delete(file);
  });
  queues.set(file, last);
  return done;
}
