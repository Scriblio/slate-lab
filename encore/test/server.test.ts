// End-to-end over real sockets: phones join and request, the KJ runs the
// stage, the display reports playback.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app.ts';
import type { ClientToServer, ServerToClient } from '../src/shared/protocol.ts';
import type { SongKey } from '../src/shared/songkey.ts';
import type { BrowseResult, DisplayView, DjView, SearchResult, SingerView } from '../src/shared/types.ts';

type Client = Socket<ServerToClient, ClientToServer>;

let app: App;
let base: string;
let dir: string;
const sockets: Client[] = [];

/** A zip with stored (uncompressed) and deflated entries, written by hand. */
function makeZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const deflate = name.endsWith('.mp3');
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cen = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cen.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, end]);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'encore-'));
  const lib = join(dir, 'library');
  await mkdir(join(lib, 'Sunfly'), { recursive: true });
  await writeFile(join(lib, 'SC8125-01 - Adele - Hello.mp4'), Buffer.alloc(2048, 1));
  await writeFile(join(lib, 'Sunfly', 'SF001-07 - Queen - Bohemian Rhapsody.mp3'), Buffer.alloc(1000, 2));
  await writeFile(join(lib, 'Sunfly', 'SF001-07 - Queen - Bohemian Rhapsody.CDG'), Buffer.alloc(24 * 300, 0));
  await writeFile(
    join(lib, 'ZM-1234 - Toto - Africa.zip'),
    makeZip({ 'Toto - Africa.mp3': Buffer.alloc(5000, 7), 'Toto - Africa.cdg': Buffer.alloc(240, 9) }),
  );
  await writeFile(join(lib, '.hidden.mp4'), Buffer.alloc(10));
  process.env.ENCORE_LIBRARY = lib;
  process.env.DJ_PIN = '424242';
  app = await createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(dir, 'data'),
    quiet: true,
    fetchImpl: fakeFetch,
    cloud: false,
    youtubeProxy: { url: SEARCH_URL, key: 'pk_test' },
  });
  base = await app.listen();
  // wait for the initial library scan
  for (let i = 0; i < 50 && app.library.getStatus().trackCount < 3; i++) await new Promise((r) => setTimeout(r, 20));
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await app.close();
  delete process.env.ENCORE_LIBRARY;
  delete process.env.DJ_PIN;
  await rm(dir, { recursive: true, force: true });
});

const SEARCH_URL = 'https://search.example/functions/v1/youtube-search';
const searches: { apikey: string | null; body: { q: string; installId: string } }[] = [];

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === SEARCH_URL) {
    const body = JSON.parse(String(init?.body)) as { q: string; installId: string };
    searches.push({ apikey: new Headers(init?.headers).get('apikey'), body });
    if (body.q === 'busy') return Response.json({ ok: false, error: 'YouTube search is busy right now.', code: 'limit' }, { status: 429 });
    return Response.json({
      ok: true,
      results: [
        { videoId: 'aaaaaaaaaaa', title: 'Toto - Africa (Karaoke Version)', channel: 'Sing King', durationSec: 295 },
        { videoId: 'bad id', title: 'Dropped', channel: 'x' },
      ],
    });
  }
  if (url.includes('/oembed')) {
    if (url.includes('NOEMBEDxxxx')) return new Response('Unauthorized', { status: 401 });
    return Response.json({ title: 'Toto - Africa (Karaoke Version)', author_name: 'Sing King' });
  }
  return new Response('nope', { status: 500 });
}

function client(auth: Record<string, string> = {}, extraHeaders?: Record<string, string>): Client {
  const s: Client = connect(base, { auth, transports: ['websocket'], forceNew: true, extraHeaders });
  sockets.push(s);
  return s;
}

function call<T>(fn: (ack: (r: { ok: boolean; data?: T; error?: string }) => void) => void): Promise<T> {
  return new Promise((ok, fail) => fn((r) => (r.ok ? ok(r.data as T) : fail(new Error(r.error)))));
}

function nextEvent<T>(s: Client, event: keyof ServerToClient, pred: (v: T) => boolean = () => true): Promise<T> {
  return new Promise((ok) => {
    const h = (v: T) => {
      if (pred(v)) {
        s.off(event, h as never);
        ok(v);
      }
    };
    s.on(event, h as never);
  });
}

describe('server', () => {
  it('indexes the library, skipping hidden files', () => {
    expect(app.library.getStatus().trackCount).toBe(3);
  });

  it('runs a full song from phone request to finished', async () => {
    const dj = client({ role: 'dj' });
    const display = client({ role: 'display' });
    const phone = client();
    await nextEvent<DisplayView>(display, 'display:view');

    const { token } = await call<{ token: string; singerId: string }>((a) => phone.emit('singer:join', 'Robin', a));
    expect(token.length).toBeGreaterThan(20);

    const results = await call<SearchResult[]>((a) => phone.emit('search', 'queen bohemian', a));
    expect(results[0]!.song.title).toBe('Bohemian Rhapsody');
    expect(results[0]!.detail).toBe('SF001-07 · MP3+G');
    const src = results[0]!.song.source;
    if (src.kind !== 'local') throw new Error('expected local');
    expect(src.format).toBe('mp3+g');

    const djSaw = nextEvent<DjView>(dj, 'dj:view', (v) => v.show.entries.length === 1);
    const phoneSaw = nextEvent<SingerView>(phone, 'singer:view', (v) => v.myEntries.length === 1);
    await call((a) => phone.emit('singer:action', { type: 'request', song: { kind: 'local', trackId: src.trackId } }, a));
    const view = await djSaw;
    expect(view.upcoming[0]!.singer.name).toBe('Robin');
    expect((await phoneSaw).myNextPosition).toBe(1);

    // KJ calls Robin up; the display gets the intro, then the play command.
    const intro = nextEvent<DisplayView>(display, 'display:view', (v) => v.nowPlaying?.stage === 'intro');
    await call((a) => dj.emit('dj:action', { type: 'callNext' }, a));
    const { nowPlaying } = await intro;
    expect(nowPlaying!.singerName).toBe('Robin');
    const cmd = nextEvent<{ playId: string; cmd: string }>(display, 'player:cmd');
    await call((a) => dj.emit('dj:action', { type: 'play' }, a));
    expect(await cmd).toEqual({ playId: nowPlaying!.playId, cmd: 'play' });

    // The display streams the media with the key it was given.
    const mediaUrl = `${base}/media/${src.trackId}/cdg?k=${(await intro).mediaKey}`;
    const ranged = await fetch(mediaUrl, { headers: { range: 'bytes=0-23' } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(24);
    expect((await fetch(`${base}/media/${src.trackId}/cdg?k=wrong`)).status).toBe(403);

    // Progress reaches the KJ; "ended" finishes the song.
    const progress = nextEvent<{ position: number }>(dj, 'dj:progress');
    display.emit('display:progress', { playId: nowPlaying!.playId, position: 12.5, duration: 200 });
    expect((await progress).position).toBe(12.5);
    const done = nextEvent<DjView>(dj, 'dj:view', (v) => v.show.history.length === 1);
    display.emit('display:ended', { playId: nowPlaying!.playId });
    const after = await done;
    expect(after.show.history[0]!.outcome).toBe('finished');
    expect(after.show.singers[0]!.songsSung).toBe(1);
  });

  it('serves zipped MP3+G tracks from inside the zip', async () => {
    const [hit] = app.library.search('africa');
    const src = hit!.song.source;
    if (src.kind !== 'local') throw new Error('expected local');
    const key = (await nextEvent<DisplayView>(client({ role: 'display' }), 'display:view')).mediaKey;
    const audio = await fetch(`${base}/media/${src.trackId}/main?k=${key}`);
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await audio.arrayBuffer()).equals(Buffer.alloc(5000, 7))).toBe(true);
    const cdg = await fetch(`${base}/media/${src.trackId}/cdg?k=${key}`, { headers: { range: 'bytes=-40' } });
    expect(cdg.status).toBe(206);
    expect(Buffer.from(await cdg.arrayBuffer()).equals(Buffer.alloc(40, 9))).toBe(true);
  });

  it('lets a phone resume its spot with its token', async () => {
    const phone = client();
    const { token, singerId } = await call<{ token: string; singerId: string }>((a) => phone.emit('singer:join', 'Kai', a));
    phone.disconnect();
    const again = client();
    const resumed = await call<{ singerId: string }>((a) => again.emit('singer:resume', token, a));
    expect(resumed.singerId).toBe(singerId);
    await expect(call((a) => again.emit('singer:resume', 'bogus', a))).rejects.toThrow('not-found');
  });

  it('sends a second sign-up under the same name to the reclaim flow', async () => {
    const first = client();
    const code = new Promise<string>((ok) => first.on('singer:view', (v: SingerView) => v.me && ok(v.me.code)));
    await call((a) => first.emit('singer:join', 'Lily', a));
    const second = client();
    const err = await new Promise<{ ok: boolean; error?: string; code?: string }>((r) => second.emit('singer:join', 'lily', r as never));
    expect(err).toMatchObject({ ok: false, code: 'name-taken' });
    const back = await call<{ token: string; singerId: string }>(async (a) => second.emit('singer:reclaim', 'Lily', await code, a));
    expect(app.show.singer(back.singerId)?.name).toBe('Lily');
    expect(app.show.state.singers.filter((s) => s.name.toLowerCase().startsWith('lily'))).toHaveLength(1);
  });

  it('looks up pasted YouTube links, keeping YouTube’s title as is', async () => {
    const phone = client();
    const r = await call<SearchResult>((a) => phone.emit('lookupYouTube', 'https://youtu.be/abcdefghijk', a));
    expect(r.song).toMatchObject({ title: 'Toto - Africa (Karaoke Version)', artist: '', source: { kind: 'youtube', videoId: 'abcdefghijk' } });
    expect(r.detail).toBe('Sing King');
    await expect(call((a) => phone.emit('lookupYouTube', 'https://youtu.be/NOEMBEDxxxx', a))).rejects.toThrow(/embedding/);
  });

  it('searches YouTube through Encore’s search service, with no key of its own', async () => {
    const phone = client();
    const r = await call<SearchResult[]>((a) => phone.emit('searchYouTube', 'africa', a));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ detail: 'Sing King', song: { title: 'Toto - Africa (Karaoke Version)', durationSec: 295, source: { videoId: 'aaaaaaaaaaa' } } });
    expect(searches.at(-1)).toEqual({ apikey: 'pk_test', body: { q: 'africa', installId: app.config.installId } });
    expect(app.config.installId).toMatch(/^[\w-]{20,}$/);
    // Repeats come from the laptop's own cache.
    const before = searches.length;
    await call<SearchResult[]>((a) => client({ role: 'dj' }).emit('searchYouTube', 'Africa', a));
    expect(searches.length).toBe(before);
    await expect(call((a) => phone.emit('searchYouTube', 'busy', a))).rejects.toThrow(/busy right now/);
  });

  it('tells the KJ when a singer can’t sing right now', async () => {
    const dj = client({ role: 'dj' });
    const phone = client();
    await call((a) => phone.emit('singer:join', 'Quinn', a));
    await call((a) => phone.emit('singer:action', { type: 'request', song: { kind: 'youtube', videoId: 'qqqqqqqqqqq', title: 'Q' } }, a));
    const notice = nextEvent<{ text: string }>(dj, 'dj:notice');
    await call((a) => phone.emit('singer:action', { type: 'notNow' }, a));
    expect((await notice).text).toMatch(/^Quinn can’t sing right now/);
  });

  it('keeps phones out of the DJ console', async () => {
    const phone = client();
    await new Promise((r) => phone.on('connect', () => r(null)));
    const result = await Promise.race([
      call((a) => phone.emit('dj:action', { type: 'newShow' }, a)).then(() => 'ran'),
      new Promise((r) => setTimeout(() => r('ignored'), 300)),
    ]);
    expect(result).toBe('ignored');

    // Through a tunnel, loopback is not trusted: a PIN is required.
    const tunneled = client({ role: 'dj' }, { 'x-forwarded-for': '203.0.113.9' });
    const err = await new Promise<Error>((r) => tunneled.on('connect_error', r));
    expect(err.message).toBe('PIN required');
    const withPin = client({ role: 'dj', pin: '424242' }, { 'x-forwarded-for': '203.0.113.9' });
    await nextEvent<DjView>(withPin, 'dj:view');
  });

  it('redirects / by who is asking and serves a QR code', async () => {
    const local = await fetch(`${base}/`, { redirect: 'manual' });
    expect(local.headers.get('location')).toBe('/dj');
    const remote = await fetch(`${base}/`, { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(remote.headers.get('location')).toBe('/join');
    const qr = await fetch(`${base}/api/qr.svg`);
    expect(qr.headers.get('content-type')).toBe('image/svg+xml');
    expect(await qr.text()).toContain('<svg');
  });

  it('takes a key with a library request, lets the KJ change it, and remembers it for the singer', async () => {
    const dj = client({ role: 'dj' });
    const phone = client();
    await call((a) => phone.emit('singer:join', 'Lena', a));
    const [found] = await call<SearchResult[]>((a) => phone.emit('search', 'adele hello', a));
    if (found?.song.source.kind !== 'local') throw new Error('expected a library track');
    expect(found.lastKey).toBeUndefined();
    const { trackId } = found.song.source;

    const id = (await call<unknown>((a) => phone.emit('singer:action', { type: 'request', song: { kind: 'local', trackId }, key: -2 }, a))) as string;
    expect(app.show.findEntry(id)?.key).toBe(-2);
    const seen = nextEvent<DjView>(dj, 'dj:view', (v) => v.show.entries.find((e) => e.id === id)?.key === 1);
    await call((a) => dj.emit('dj:action', { type: 'setKey', entryId: id, key: 1 }, a));
    await seen;

    // Next time Lena looks it up, it comes up in her key.
    const [again] = await call<SearchResult[]>((a) => phone.emit('search', 'adele hello', a));
    expect(again!.lastKey).toBe(1);

    // The song's own key: detected by a console, then corrected by the KJ.
    const detected = nextEvent<DjView>(dj, 'dj:view', (v) => v.songKeys[trackId]?.tonic === 9);
    await call((a) => dj.emit('dj:action', { type: 'setSongKey', trackId, key: { tonic: 9, mode: 'minor' }, detected: true }, a));
    expect((await detected).songKeys[trackId]).toEqual({ tonic: 9, mode: 'minor' });
    const phoneSaw = nextEvent<SingerView>(phone, 'singer:view', (v) => v.songKeys?.[trackId]?.confirmed === true);
    await call((a) => dj.emit('dj:action', { type: 'setSongKey', trackId, key: { tonic: 0, mode: 'major' } }, a));
    expect((await phoneSaw).songKeys![trackId]).toEqual({ tonic: 0, mode: 'major', confirmed: true });
    // A late detection doesn't overrule the KJ, and searches carry the key.
    await call((a) => dj.emit('dj:action', { type: 'setSongKey', trackId, key: { tonic: 9, mode: 'minor' }, detected: true }, a));
    const [withKey] = await call<SearchResult[]>((a) => phone.emit('search', 'adele hello', a));
    expect(withKey!.songKey).toEqual({ tonic: 0, mode: 'major', confirmed: true });
    await expect(call((a) => dj.emit('dj:action', { type: 'setSongKey', trackId: '0123456789abcdef', key: { tonic: 0, mode: 'major' } }, a))).rejects.toThrow(/not in the library/);
    await call((a) => phone.emit('singer:action', { type: 'removeMyEntry', entryId: id }, a));
  });

  it('persists the show across restarts', async () => {
    await app.show.flush();
    const again = await createApp({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data'), quiet: true, cloud: false, youtubeProxy: false });
    expect(again.show.state.singers.map((s) => s.name)).toEqual(app.show.state.singers.map((s) => s.name));
    expect(again.show.state.history).toHaveLength(1);
    await again.close();
  });
});

describe('YouTube videos that won’t play here', () => {
  it('swaps them for another version, before showtime and on stage, and hides them from search', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'encore-refused-'));
    const own = await createApp({ port: 0, host: '127.0.0.1', dataDir, quiet: true, fetchImpl: fakeFetch, cloud: false, youtubeProxy: { url: SEARCH_URL, key: 'pk_test' } });
    const url = await own.listen();
    const conn = (auth: Record<string, string> = {}) => {
      const s: Client = connect(url, { auth, transports: ['websocket'], forceNew: true });
      sockets.push(s);
      return s;
    };
    const dj = conn({ role: 'dj' });
    const display = conn({ role: 'display' });
    const phone = conn();
    await nextEvent<DisplayView>(display, 'display:view');
    await call((a) => phone.emit('singer:join', 'Robin', a));
    const request = (videoId: string, title: string) =>
      call<unknown>((a) => phone.emit('singer:action', { type: 'request', song: { kind: 'youtube', videoId, title } }, a)) as Promise<string>;

    // The console's preview player finds that YouTube refuses the video here.
    const id = await request('bbbbbbbbbbb', 'Toto - Africa (Karaoke)');
    const swapped = nextEvent<SingerView>(phone, 'singer:view', (v) => v.myEntries[0]?.swappedFrom !== undefined);
    await call((a) => dj.emit('dj:action', { type: 'youtubeCheck', videoId: 'bbbbbbbbbbb', ok: false }, a));
    const mine = (await swapped).myEntries[0]!;
    expect(mine).toMatchObject({ id, swappedFrom: 'Toto - Africa (Karaoke)', song: { title: 'Toto - Africa (Karaoke Version)', source: { videoId: 'aaaaaaaaaaa' } } });
    await expect(request('bbbbbbbbbbb', 'again')).rejects.toThrow(/won’t play/);

    // The replacement checks out, and the venue screen is told how it played.
    const checked = nextEvent<DisplayView>(display, 'display:view', (v) => v.youtube.modes.aaaaaaaaaaa === 'direct');
    await call((a) => dj.emit('dj:action', { type: 'youtubeCheck', videoId: 'aaaaaaaaaaa', ok: true, mode: 'direct' }, a));
    expect((await checked).youtube.status).toEqual({ aaaaaaaaaaa: 'ok' });

    // At showtime YouTube refuses it after all: another version goes on instead.
    await call((a) => dj.emit('dj:action', { type: 'callEntry', entryId: id }, a));
    await call((a) => dj.emit('dj:action', { type: 'play' }, a));
    const playId = own.show.state.nowPlaying!.playId;
    const back = nextEvent<DisplayView>(display, 'display:view', (v) => v.nowPlaying?.entry.wontPlay === true || (v.nowPlaying?.playId !== playId && v.nowPlaying?.stage === 'playing'));
    display.emit('display:error', { playId, message: 'refused', code: 150 });
    const np = (await back).nowPlaying!;
    // The fake search only knows two versions and both are refused now, so it's flagged.
    expect(np).toMatchObject({ entry: { wontPlay: true }, error: expect.stringMatching(/no other version/) });

    // The KJ marks a video "not karaoke": the request goes, the singer is told, and it's hidden.
    const vocalId = await request('ccccccccccc', 'Toto - Africa (Official Video)');
    const told = nextEvent<{ text: string }>(phone, 'singer:notice');
    await call((a) => dj.emit('dj:action', { type: 'notKaraoke', entryId: vocalId }, a));
    expect((await told).text).toMatch(/isn’t a karaoke version/);
    expect(own.show.findEntry(vocalId)).toBeUndefined();
    await expect(request('ccccccccccc', 'again')).rejects.toThrow(/not a karaoke version/);

    // Refused videos no longer show up in YouTube search on this laptop.
    const results = await call<SearchResult[]>((a) => phone.emit('searchYouTube', 'toto africa', a));
    expect(results.map((r) => r.song.source.kind === 'youtube' && r.song.source.videoId)).not.toContain('aaaaaaaaaaa');
    await own.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lets a phone scroll through the whole library, in order, until the KJ turns it off', async () => {
    const dj = client({ role: 'dj' });
    const phone = client();
    const joined = nextEvent<SingerView>(phone, 'singer:view', (v) => v.me?.name === 'Scroller');
    await call((a) => phone.emit('singer:join', 'Scroller', a));
    expect((await joined).canBrowse).toBe(true);
    const page = (req: object) => call<BrowseResult>((a) => phone.emit('browse', req as never, a));
    const titles = (r: BrowseResult) => r.items.map((i) => i.song.title);

    const byArtist = await page({ sort: 'artist' });
    expect(titles(byArtist)).toEqual(['Hello', 'Bohemian Rhapsody', 'Africa']); // Adele, Queen, Toto
    expect(byArtist).toMatchObject({ total: 3, offset: 0, letters: ['A', 'Q', 'T'] });
    expect(byArtist.items[1]).toMatchObject({ detail: 'SF001-07 · MP3+G' });
    // Songs already sung or requested tonight (by earlier tests, here) are marked, as in search.
    expect(byArtist.items.every((i) => i.playedTonight === app.show.playedTonight(i.song))).toBe(true);
    expect(titles(await page({ sort: 'title' }))).toEqual(['Africa', 'Bohemian Rhapsody', 'Hello']);
    // Paging, and jumping to a letter.
    expect(titles(await page({ sort: 'artist', offset: 1, limit: 1 }))).toEqual(['Bohemian Rhapsody']);
    expect(await page({ sort: 'artist', letter: 'q' })).toMatchObject({ offset: 1 });

    const song = byArtist.items[0]!.song.source;
    if (song.kind !== 'local') throw new Error('expected local');
    await call((a) => phone.emit('singer:action', { type: 'request', song: { kind: 'local', trackId: song.trackId } }, a));
    expect((await page({ sort: 'artist' })).items[0]).toMatchObject({ playedTonight: true });

    // Nonsense can't break it, and a phone sees only what it's allowed to.
    expect(await page({ sort: 'sideways', offset: -5, limit: 'lots' })).toMatchObject({ offset: 0, total: 3 });
    expect(await call<BrowseResult>((a) => phone.emit('browse', null as never, a))).toMatchObject({ total: 3 });

    // The KJ turns browsing off: the phones are told, and the list is refused.
    const off = nextEvent<SingerView>(phone, 'singer:view', (v) => v.canBrowse === false);
    await call((a) => dj.emit('dj:action', { type: 'updateSettings', patch: { allowBrowse: false } }, a));
    await off;
    await expect(page({ sort: 'artist' })).rejects.toThrow(/turned off browsing/);
    // The KJ's own console is not affected, and search still works for singers.
    expect((await call<BrowseResult>((a) => dj.emit('browse', { sort: 'artist' }, a))).total).toBe(3);
    expect((await call<SearchResult[]>((a) => phone.emit('search', 'adele', a)))[0]!.song.title).toBe('Hello');
    await call((a) => dj.emit('dj:action', { type: 'updateSettings', patch: { allowBrowse: true } }, a));
  });

  it('tells a phone which key a song is in, asking the console to work it out first if nobody knows', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'encore-songkey-'));
    const own = await createApp({ port: 0, host: '127.0.0.1', dataDir, quiet: true, cloud: false, youtubeProxy: false, keyWaitMs: 400, extraLibraryFolders: [join(dir, 'library')] });
    const url = await own.listen();
    for (let i = 0; i < 50 && own.library.getStatus().trackCount < 3; i++) await new Promise((r) => setTimeout(r, 20));
    const conn = (auth: Record<string, string> = {}) => {
      const s: Client = connect(url, { auth, transports: ['websocket'], forceNew: true });
      sockets.push(s);
      return s;
    };
    const phone = conn();
    await call((a) => phone.emit('singer:join', 'Singer', a));
    const ask = (id: string) => call<SongKey | null>((a) => phone.emit('songKey', id as never, a));
    const ids = ['adele', 'queen', 'toto'].map((q) => {
      const src = own.library.search(q)[0]!.song.source;
      if (src.kind !== 'local') throw new Error('expected local');
      return src.trackId;
    });

    // Nothing to ask while no console is connected, and nonsense is just "unknown".
    expect(await ask(ids[0]!)).toBeNull();
    expect(await ask('nope')).toBeNull();
    expect(await ask('0123456789abcdef')).toBeNull();

    // The console connects. It's asked once, listens to the song, and the phone gets the answer.
    const dj = conn({ role: 'dj' });
    const asked: string[] = [];
    dj.on('dj:detect', ({ trackId }) => {
      asked.push(trackId);
      if (trackId === ids[0]) void call((a) => dj.emit('dj:action', { type: 'setSongKey', trackId, key: { tonic: 0, mode: 'major' }, detected: true }, a));
    });
    await new Promise((r) => dj.on('connect', () => r(null)));
    expect(await ask(ids[0]!)).toEqual({ tonic: 0, mode: 'major' });
    expect(asked).toEqual([ids[0]]);
    // Known now: answered at once, without asking again. The phone sees it with the song, too.
    expect(await ask(ids[0]!)).toEqual({ tonic: 0, mode: 'major' });
    expect(asked).toEqual([ids[0]]);
    const found = await call<SearchResult[]>((a) => phone.emit('search', 'adele', a));
    expect(found[0]!.songKey).toEqual({ tonic: 0, mode: 'major' });

    // A console that can't work it out: the phone waits a moment, then moves on, and nobody keeps asking.
    expect(await ask(ids[1]!)).toBeNull();
    expect(await ask(ids[1]!)).toBeNull();
    expect(asked).toEqual([ids[0], ids[1]]);
    await own.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('plays break music whenever nothing is on stage, and gets out of the way for songs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'encore-break-'));
    const breakDir = join(dir, 'break-music');
    await mkdir(breakDir, { recursive: true });
    for (const f of ['Lounge Cat - Velvet Hour.mp3', 'Lounge Cat - Slow Jam.mp3', 'Neon Loop.mp4']) await writeFile(join(breakDir, f), Buffer.alloc(300, 5));
    const own = await createApp({ port: 0, host: '127.0.0.1', dataDir, quiet: true, cloud: false, youtubeProxy: false, extraLibraryFolders: [join(dir, 'library')] });
    const url = await own.listen();
    const conn = (auth: Record<string, string> = {}) => {
      const s: Client = connect(url, { auth, transports: ['websocket'], forceNew: true });
      sockets.push(s);
      return s;
    };
    const dj = conn({ role: 'dj' });
    const display = conn({ role: 'display' });
    const act = <T = unknown>(action: object) => call<T>((a) => dj.emit('dj:action', action as never, a as never));
    const view = (pred: (v: DisplayView) => boolean = () => true) => nextEvent<DisplayView>(display, 'display:view', pred);
    for (let i = 0; i < 50 && own.library.getStatus().trackCount < 3; i++) await new Promise((r) => setTimeout(r, 20));

    // No break folder yet: the screen is told nothing about break music.
    expect((await view()).breakMusic).toBeUndefined();
    expect((await call<{ breakFolders: string[] }>((a) => dj.emit('dj:config', a))).breakFolders).toEqual([]);

    // The KJ points Encore at the folder: with nothing on stage, music starts.
    const started = view((v) => v.breakMusic?.on === true && v.breakMusic.track !== null);
    const djSaw = nextEvent<DjView>(dj, 'dj:view', (v) => v.breakMusic.tracks === 3 && v.breakMusic.on);
    await act({ type: 'setConfig', breakFolders: [breakDir] });
    const startedView = await started;
    const first = startedView.breakMusic!;
    expect(first).toMatchObject({ on: true, paused: false, volume: 60 });
    expect(['audio', 'video']).toContain(first.track!.kind);
    expect((await djSaw).breakMusic).toMatchObject({ on: true, folders: [breakDir], tracks: 3 });
    expect((await call<{ breakFolders: string[] }>((a) => dj.emit('dj:config', a))).breakFolders).toEqual([breakDir]);

    // The track plays from /media like a library song, but only with the screen's key.
    const mediaKey = startedView.mediaKey;
    const fetchTrack = (key: string) => fetch(`${url}/media/${first.track!.id}/main?k=${encodeURIComponent(key)}`);
    expect((await fetchTrack(mediaKey)).status).toBe(200);
    expect((await fetchTrack('wrong')).status).toBe(403);

    // It ends: the screen asks for the next one. A late report about an old track changes nothing.
    const next = view((v) => v.breakMusic!.nonce > first.nonce);
    display.emit('display:breakEnded', { nonce: first.nonce - 1 });
    display.emit('display:breakEnded', { nonce: first.nonce });
    const second = (await next).breakMusic!;
    expect(second.track!.id).not.toBe(first.track!.id);
    // Skip and pause come from the console.
    const skipped = view((v) => v.breakMusic!.nonce > second.nonce);
    await act({ type: 'breakSkip' });
    await skipped;
    const paused = view((v) => v.breakMusic!.paused === true);
    await act({ type: 'breakPause' });
    expect((await paused).breakMusic).toMatchObject({ on: true, paused: true });

    // A singer is called up: the walk-up is still a break, and the pause is kept.
    const singer = await act<string>({ type: 'addSinger', name: 'Robin' });
    const [hello] = own.library.search('adele hello');
    if (hello!.song.source.kind !== 'local') throw new Error('expected local');
    await act({ type: 'addEntry', singerId: singer, song: { kind: 'local', trackId: hello!.song.source.trackId } });
    const intro = view((v) => v.nowPlaying?.stage === 'intro');
    await act({ type: 'callNext' });
    expect((await intro).breakMusic).toMatchObject({ on: true });
    // The song starts: the music is off. When it ends and the stage is empty again, a new break starts, unpaused.
    const playing = view((v) => v.nowPlaying?.stage === 'playing');
    await act({ type: 'play' });
    expect((await playing).breakMusic).toMatchObject({ on: false });
    const playId = own.show.state.nowPlaying!.playId;
    const again = view((v) => v.nowPlaying === null && v.breakMusic?.on === true);
    display.emit('display:ended', { playId });
    expect((await again).breakMusic).toMatchObject({ on: true, paused: false });

    // The KJ switches it off in Settings, and turns the volume down for next time.
    const off = view((v) => v.breakMusic?.on === false && v.breakMusic.volume === 30);
    await act({ type: 'updateSettings', patch: { breakMusic: false, breakVolume: 30 } });
    await off;

    // A track that won't play is skipped over, quietly.
    const liveAgain = view((v) => v.breakMusic?.on === true);
    await act({ type: 'updateSettings', patch: { breakMusic: true } });
    const live = (await liveAgain).breakMusic!;
    const moved = view((v) => v.breakMusic!.nonce > live.nonce);
    display.emit('display:breakError', { nonce: live.nonce, message: 'decode error' });
    await moved;
    await own.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('remembers which speakers the KJ picked and tells the screen and the console', async () => {
    const dj = client({ role: 'dj' });
    const display = client({ role: 'display' });
    const act = (action: object) => call((a) => dj.emit('dj:action', action as never, a as never));
    const onScreen = nextEvent<DisplayView>(display, 'display:view', (v) => v.audioOutput === 'speaker-123');
    const onConsole = nextEvent<DjView>(dj, 'dj:view', (v) => v.audioOutput === 'speaker-123');
    await act({ type: 'setConfig', audioOutput: 'speaker-123' });
    await onScreen;
    await onConsole;
    expect((await call<{ audioOutput: string }>((a) => dj.emit('dj:config', a))).audioOutput).toBe('speaker-123');
    const saved = JSON.parse(await readFile(join(dir, 'data', 'config.json'), 'utf8')) as { audioOutput: string };
    expect(saved.audioOutput).toBe('speaker-123');
    // Back to the system default.
    const reset = nextEvent<DisplayView>(display, 'display:view', (v) => v.audioOutput === '');
    await act({ type: 'setConfig', audioOutput: '' });
    await reset;
  });

  it('turns away rude names before they reach the screen, tells the KJ, and lets the KJ add their own words', async () => {
    const dj = client({ role: 'dj' });
    const act = (action: object) => call((a) => dj.emit('dj:action', action as never, a as never));
    const join = (name: string) => call<{ singerId: string }>((a) => client().emit('singer:join', name, a));
    const notice = nextEvent<{ text: string }>(dj, 'dj:notice');
    await expect(join('F.U.C.K')).rejects.toThrow(/can’t go up on the screen/);
    expect((await notice).text).toMatch(/tried a name that isn’t allowed/);
    expect((await notice).text).not.toMatch(/f\.u\.c\.k/i);
    expect(app.show.state.singers.some((x) => /f\.u/i.test(x.name))).toBe(false);
    expect(await join('Scunthorpe Sue')).toHaveProperty('singerId');

    // The KJ's own words, and the KJ can always add anyone themselves.
    await act({ type: 'updateSettings', patch: { blockedWords: 'Gary, ' } });
    expect(app.show.state.settings.blockedWords).toBe('gary');
    await expect(join('Gary')).rejects.toThrow(/pick a different one/);
    expect(await act({ type: 'addSinger', name: 'Gary' })).toBeTruthy();

    // Switched off, anything goes.
    await act({ type: 'updateSettings', patch: { nameFilter: false } });
    expect(await join('Gary the Great')).toHaveProperty('singerId');
    await act({ type: 'updateSettings', patch: { nameFilter: true, blockedWords: '' } });
  });
});
