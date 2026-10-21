// YouTube lets an app keep what it says about a video for 30 days. Encore's show records (tonight's list,
// the history, the archive of past shows) delete a YouTube video's title, channel name, thumbnail and length
// at that age, and keep everything else.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { Show } from '../src/server/show.ts';
import { FORGOTTEN_TITLE, YOUTUBE_DATA_MS, forgetOldYouTube, forgetOldYouTubeInPastShows } from '../src/server/ytretention.ts';
import type { Entry, HistoryItem, ShowState } from '../src/shared/types.ts';
import { emptyShow } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12, 0);

const id11 = (name: string) => name.padEnd(11, 'x');
/** A YouTube request, with everything YouTube would have told Encore about the video. */
function yt(name: string, requestedAt: number, extra: Partial<Entry> = {}): Entry {
  return {
    id: `entry-${name}`,
    singerId: 'dee',
    song: {
      title: `Title of ${name}`,
      artist: `Channel of ${name}`,
      source: { kind: 'youtube', videoId: id11(name) },
      durationSec: 215,
      thumbnail: `https://i.ytimg.com/vi/${id11(name)}/mqdefault.jpg`,
    },
    requestedAt,
    status: 'queued',
    ...extra,
  };
}
const local = (requestedAt: number): Entry => ({
  id: 'entry-local',
  singerId: 'dee',
  song: { title: 'A library song', artist: 'The Band', source: { kind: 'local', trackId: 'abc', format: 'mp3+g' }, durationSec: 180 },
  requestedAt,
  status: 'queued',
});
const played = (entry: Entry, endedAt: number, outcome: HistoryItem['outcome'] = 'finished'): HistoryItem => ({
  entry,
  singerName: 'Dee',
  startedAt: endedAt - 200_000,
  endedAt,
  outcome,
});
const records = (entries: Entry[], history: HistoryItem[]): ShowState => ({ ...emptyShow(), entries, history });

describe('forgetting what YouTube said about a video', () => {
  it('keeps the video id and everything about the show, and forgets the rest', () => {
    const old = yt('old', NOW - 31 * DAY, { note: 'for Sam', swappedFrom: 'The first video’s title' });
    const state = records([], [played(old, NOW - 31 * DAY, 'skipped')]);
    const next = forgetOldYouTube(state, NOW);
    expect(next.history[0]).toEqual({
      entry: { id: 'entry-old', singerId: 'dee', song: { title: FORGOTTEN_TITLE, artist: '', source: { kind: 'youtube', videoId: id11('old') } }, requestedAt: NOW - 31 * DAY, status: 'queued', note: 'for Sam' },
      singerName: 'Dee',
      startedAt: NOW - 31 * DAY - 200_000,
      endedAt: NOW - 31 * DAY,
      outcome: 'skipped',
    });
    expect(JSON.stringify(next)).not.toMatch(/Title of old|Channel of old|ytimg|first video/);
  });

  it('waits until 30 days are up', () => {
    const justUnder = NOW - YOUTUBE_DATA_MS + 60_000;
    const state = records([yt('queued', justUnder)], [played(yt('sung', justUnder), justUnder)]);
    expect(forgetOldYouTube(state, NOW)).toBe(state);
    const next = forgetOldYouTube(state, NOW + 60_000);
    expect(next.entries[0]!.song.title).toBe(FORGOTTEN_TITLE);
    expect(next.history[0]!.entry.song.title).toBe(FORGOTTEN_TITLE);
  });

  it('goes by when a queued request was made and when a performance ended', () => {
    const state = records(
      [yt('oldreq', NOW - 40 * DAY), yt('newreq', NOW - 1 * DAY)],
      [played(yt('oldplay', NOW - 50 * DAY), NOW - 40 * DAY), played(yt('requestedold', NOW - 50 * DAY), NOW - 1 * DAY)],
    );
    const next = forgetOldYouTube(state, NOW);
    expect(next.entries.map((e) => e.song.title)).toEqual([FORGOTTEN_TITLE, 'Title of newreq']);
    expect(next.history.map((h) => h.entry.song.title)).toEqual([FORGOTTEN_TITLE, 'Title of requestedold']);
  });

  it('never touches songs from the KJ’s library', () => {
    const state = records([local(NOW - 90 * DAY)], [played(local(NOW - 90 * DAY), NOW - 90 * DAY)]);
    expect(forgetOldYouTube(state, NOW)).toBe(state);
  });

  it('returns the same records when there is nothing to forget, so it is cheap to run often', () => {
    const state = records([yt('queued', NOW - DAY)], [played(yt('sung', NOW - 2 * DAY), NOW - 2 * DAY)]);
    expect(forgetOldYouTube(state, NOW)).toBe(state);
    const once = forgetOldYouTube(records([yt('a', NOW - 40 * DAY)], []), NOW);
    expect(forgetOldYouTube(once, NOW)).toBe(once);
  });

  it('copes with old records that lack a list', () => {
    const odd = { ...emptyShow(), entries: undefined, history: undefined } as unknown as ShowState;
    expect(forgetOldYouTube(odd, NOW)).toBe(odd);
  });
});

describe('the live show', () => {
  it('forgets on request, tells the screens once, and then has nothing left to do', () => {
    let changes = 0;
    const show = new Show({ now: () => NOW, resolveLocal: () => undefined, onChange: () => changes++, onPlayerCommand: () => {} });
    show.state.history = [played(yt('old', NOW - 31 * DAY), NOW - 31 * DAY), played(yt('new', NOW - 2 * DAY), NOW - 2 * DAY)];
    expect(show.forgetOldYouTube()).toBe(true);
    expect(changes).toBe(1);
    expect(show.state.history.map((h) => h.entry.song.title)).toEqual([FORGOTTEN_TITLE, 'Title of new']);
    expect(show.forgetOldYouTube()).toBe(false);
    expect(changes).toBe(1);
  });
});

describe('the archive of past shows', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function dataDir() {
    const dir = await mkdtemp(join(tmpdir(), 'encore-retention-'));
    dirs.push(dir);
    await mkdir(join(dir, 'past-shows'));
    return dir;
  }
  const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const write = (dir: string, name: string, state: unknown) => writeFile(join(dir, 'past-shows', name), JSON.stringify(state, null, 1));
  const read = async (dir: string, name: string) => JSON.parse(await readFile(join(dir, 'past-shows', name), 'utf8')) as ShowState;

  it('forgets in shows that began over 30 days ago, and only what is old, once', async () => {
    const dir = await dataDir();
    const began = NOW - 45 * DAY;
    await write(dir, `${stamp(began)}-aaa.json`, { ...records([], [played(yt('first', began + DAY), began + DAY), played(yt('late', NOW - 5 * DAY), NOW - 5 * DAY)]), id: 'aaa', createdAt: began });
    expect(await forgetOldYouTubeInPastShows(dir, NOW)).toBe(1);
    const after = await read(dir, `${stamp(began)}-aaa.json`);
    expect(after.id).toBe('aaa');
    expect(after.history.map((h) => h.entry.song.title)).toEqual([FORGOTTEN_TITLE, 'Title of late']);
    expect(await forgetOldYouTubeInPastShows(dir, NOW)).toBe(0);
    // The last of it goes when it too is 30 days old.
    expect(await forgetOldYouTubeInPastShows(dir, NOW + 26 * DAY)).toBe(1);
    expect((await read(dir, `${stamp(began)}-aaa.json`)).history.map((h) => h.entry.song.title)).toEqual([FORGOTTEN_TITLE, FORGOTTEN_TITLE]);
  });

  it('leaves recent shows, other files and a missing folder alone', async () => {
    const dir = await dataDir();
    const recent = NOW - 10 * DAY;
    const body = { ...records([], [played(yt('keep', recent), recent)]), id: 'bbb', createdAt: recent };
    await write(dir, `${stamp(recent)}-bbb.json`, body);
    await writeFile(join(dir, 'past-shows', 'notes.txt'), 'not a show');
    await writeFile(join(dir, 'past-shows', `${stamp(NOW - 60 * DAY)}-broken.json`), '{ half a file');
    expect(await forgetOldYouTubeInPastShows(dir, NOW)).toBe(0);
    expect(await read(dir, `${stamp(recent)}-bbb.json`)).toEqual(JSON.parse(JSON.stringify(body)));
    expect(await readFile(join(dir, 'past-shows', 'notes.txt'), 'utf8')).toBe('not a show');
    expect(await forgetOldYouTubeInPastShows(join(dir, 'nowhere'), NOW)).toBe(0);
  });
});

describe('the running app', () => {
  afterEach(() => vi.useRealTimers());

  it('forgets when it starts, and again when a show is archived', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // only the clock: sockets and timers stay real
    const now = Date.now();
    const dir = await mkdtemp(join(tmpdir(), 'encore-retention-app-'));
    const pastDir = join(dir, 'past-shows');
    await mkdir(pastDir);
    // Last night's show is still open, with a song from 40 days ago left in its history; a show from 50 days ago is archived.
    const state = { ...records([], [played(yt('ancient', now - 40 * DAY), now - 40 * DAY), played(yt('recent', now - 2 * DAY), now - 2 * DAY)]), createdAt: now - 41 * DAY };
    await writeFile(join(dir, 'show.json'), JSON.stringify({ version: 1, state, tokens: {} }));
    const long = `${new Date(now - 50 * DAY).toISOString().slice(0, 16).replace(/[:T]/g, '-')}-old.json`;
    await writeFile(join(pastDir, long), JSON.stringify({ ...records([], [played(yt('older', now - 50 * DAY), now - 50 * DAY)]), id: 'old', createdAt: now - 50 * DAY }, null, 1));

    const app = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, cloud: false, youtubeProxy: false });
    const url = await app.listen();
    const titles = (s: ShowState) => s.history.map((h) => h.entry.song.title);
    await vi.waitFor(async () => {
      expect(titles(app.show.state)).toEqual([FORGOTTEN_TITLE, 'Title of recent']);
      expect(titles(JSON.parse(await readFile(join(pastDir, long), 'utf8')) as ShowState)).toEqual([FORGOTTEN_TITLE]);
    });

    // A month passes, then the KJ starts a new show: what was recent is 30 days old by now, so it is archived forgotten.
    vi.setSystemTime(now + 30 * DAY);
    const dj = connect(url, { auth: { role: 'dj' }, transports: ['websocket'], forceNew: true });
    try {
      await new Promise<void>((resolve, reject) =>
        dj.emit('dj:action', { type: 'newShow' }, (r: { ok: boolean; error?: string }) => (r.ok ? resolve() : reject(new Error(r.error)))),
      );
    } finally {
      dj.close();
    }
    const archived = (await readdir(pastDir)).filter((n) => n !== long);
    expect(archived).toHaveLength(1);
    expect(titles(JSON.parse(await readFile(join(pastDir, archived[0]!), 'utf8')) as ShowState)).toEqual([FORGOTTEN_TITLE, FORGOTTEN_TITLE]);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
});
