// End-to-end over real sockets: phones join and request, the KJ runs the
// stage, the display reports playback.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app.ts';
import type { ClientToServer, ServerToClient } from '../src/shared/protocol.ts';
import type { DisplayView, DjView, SearchResult, SingerView } from '../src/shared/types.ts';

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
  app = await createApp({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data'), quiet: true, fetchImpl: fakeFetch });
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

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
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

  it('looks up pasted YouTube links without an API key', async () => {
    const phone = client();
    const r = await call<SearchResult>((a) => phone.emit('lookupYouTube', 'https://youtu.be/abcdefghijk', a));
    expect(r.song).toMatchObject({ artist: 'Toto', title: 'Africa', source: { kind: 'youtube', videoId: 'abcdefghijk' } });
    await expect(call((a) => phone.emit('lookupYouTube', 'https://youtu.be/NOEMBEDxxxx', a))).rejects.toThrow(/embedding/);
    await expect(call((a) => phone.emit('searchYouTube', 'africa', a))).rejects.toThrow(/API key/);
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

  it('persists the show across restarts', async () => {
    await app.show.flush();
    const again = await createApp({ port: 0, host: '127.0.0.1', dataDir: join(dir, 'data'), quiet: true });
    expect(again.show.state.singers.map((s) => s.name)).toEqual(app.show.state.singers.map((s) => s.name));
    expect(again.show.state.history).toHaveLength(1);
    await again.close();
  });
});
