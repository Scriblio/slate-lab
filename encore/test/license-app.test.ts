// The license in the running app, over real sockets: what each state lets a KJ and the
// singers do, that a show already running is never cut off, what Encore Cloud turns on and
// off, and that no state ever touches YouTube.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/server/app.ts';
import { NOT_OPEN } from '../src/server/show.ts';
import type { ClientToServer, ServerToClient } from '../src/shared/protocol.ts';
import { MemoryHub } from '../src/shared/relay.ts';
import type { DjView, SearchResult, SingerView } from '../src/shared/types.ts';
import { fakeSupabase, SUPABASE_KEY, SUPABASE_URL, type FakeSupabase } from './fakesupabase.ts';
import { DAY, makeKeys } from './licensekit.ts';
import { memoryWorld, type World } from './licenseworld.ts';

type Client = Socket<ServerToClient, ClientToServer>;

const SEARCH_URL = 'https://search.example/functions/v1/youtube-search';
const ORIGIN = 'https://sing.example';
const SONG = { kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Never Gonna', artist: 'Rick' } as const;

let dir: string;
let clock: { t: number };
let world: World;
let keys: Awaited<ReturnType<typeof makeKeys>>;
let fake: FakeSupabase;
let hub: MemoryHub;
const apps: App[] = [];
const sockets: Client[] = [];
const now = () => clock.t;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'encore-licapp-'));
  clock = { t: Date.UTC(2026, 10, 5, 12, 0, 0) };
  world = memoryWorld({ now });
  keys = await makeKeys();
  fake = fakeSupabase({ world, signing: keys.signing, now });
  hub = new MemoryHub();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  for (const a of apps.splice(0)) await a.close();
  await rm(dir, { recursive: true, force: true });
});

/** YouTube, as the search service and oEmbed answer it. */
async function youtubeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === SEARCH_URL) return Response.json({ ok: true, results: [{ videoId: 'aaaaaaaaaaa', title: 'Toto - Africa (Karaoke Version)', channel: 'Sing King', durationSec: 295 }] });
  if (url.includes('/oembed')) return Response.json({ title: 'Toto - Africa (Karaoke Version)', author_name: 'Sing King' });
  return Response.json({}, { status: 404 });
}

async function start(opts: { cloud?: boolean; license?: boolean; planCheckMs?: number; dataDir?: string } = {}) {
  const app = await createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: opts.dataDir ?? dir,
    quiet: true,
    fetchImpl: youtubeFetch,
    youtubeProxy: { url: SEARCH_URL, key: 'pk_test' },
    cloud: opts.cloud ? { joinOrigin: ORIGIN, transport: () => hub.transport(), checkJoinPage: async () => true } : false,
    license: opts.license === false ? false : { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, publicKeys: [{ kid: keys.kid, key: keys.publicKey }], fetchImpl: fake.fetch, now },
    planCheckMs: opts.planCheckMs,
  });
  apps.push(app);
  const base = await app.listen();
  const dj = client(base, 'dj');
  let latest: DjView | undefined;
  dj.on('dj:view', (v) => (latest = v));
  await until(() => latest !== undefined);
  return {
    app,
    base,
    dj,
    view: () => latest!,
    act: <T,>(action: ClientToServer['dj:action'] extends (a: infer A, ...r: never[]) => void ? A : never) => ack<T>(dj, 'dj:action', action),
    async signIn(email = 'kj@example.com') {
      await ack(dj, 'dj:action', { type: 'accountSendCode', email });
      await ack(dj, 'dj:action', { type: 'accountVerify', email, code: fake.codeFor(email) });
      await until(() => latest!.license.state !== 'signed-out');
    },
    phone: () => phone(base),
  };
}

function client(base: string, role: 'dj' | 'singer'): Client {
  const s: Client = connect(base, { auth: { role }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

function phone(base: string) {
  const s = client(base, 'singer');
  let latest: SingerView | undefined;
  s.on('singer:view', (v) => (latest = v));
  return { socket: s, view: () => latest, ready: () => until(() => latest !== undefined) };
}

const ack = <T,>(s: { emit(ev: string, ...a: unknown[]): unknown }, ev: string, ...args: unknown[]) =>
  new Promise<T>((ok, fail) => s.emit(ev, ...args, (r: { ok: boolean; data?: T; error?: string; code?: string }) => (r.ok ? ok(r.data as T) : fail(Object.assign(new Error(r.error), { code: r.code })))));

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Running = Awaited<ReturnType<typeof start>>;

/** The trial ends, and the laptop checks in (as it does every twelve hours). */
async function endTheTrial(a: Running) {
  clock.t += 15 * DAY;
  await ack(a.dj, 'dj:action', { type: 'refreshLicense' });
  await until(() => a.view().license.state === 'ended');
}

describe('a copy that nobody has signed in to', () => {
  it('still opens: the console gets everything but the show, and says what to do', async () => {
    const a = await start();
    expect(a.view().license).toMatchObject({ state: 'signed-out', app: false, cloud: false, showOpen: false });
    // Library, settings and printing are all there.
    expect(a.view().library).toBeDefined();
    expect(a.view().print.url).toMatch(/^http/);
    await ack(a.dj, 'dj:action', { type: 'updateSettings', patch: { showName: 'Still works' } });
    expect(a.app.show.state.settings.showName).toBe('Still works');
  });

  it('turns phones away with a neutral message, and shows them no plans, prices or buttons', async () => {
    const a = await start();
    const p = a.phone();
    await p.ready();
    const rejected = await ack(p.socket, 'singer:join', 'Robin').catch((e: Error & { code?: string }) => e);
    expect(rejected).toMatchObject({ message: NOT_OPEN, code: 'show-closed' });
    expect(NOT_OPEN).toBe('This show isn’t open yet. Ask the KJ.');
    await expect(ack(p.socket, 'singer:reclaim', 'Robin', '1234')).rejects.toMatchObject({ message: NOT_OPEN });
    const view = p.view()!;
    expect(view).toMatchObject({ notOpen: true, joinOpen: false, me: null, nowPlaying: null, upcoming: [] });
    const everything = JSON.stringify(view);
    expect(everything).not.toMatch(/license|trial|price|\$|unlock|upgrade|buy|subscri|cloud|plan/i);
    expect(a.app.show.state.singers).toHaveLength(0);
  });

  it('will not add a singer or call anyone up from the console, and says where to go', async () => {
    const a = await start();
    await expect(a.act({ type: 'addSinger', name: 'Pat' })).rejects.toMatchObject({ message: expect.stringMatching(/Sign in to start your free trial.*Settings → Your Encore/), code: 'show-closed' });
    await expect(a.act({ type: 'callNext' })).rejects.toMatchObject({ code: 'show-closed' });
    await expect(a.act({ type: 'play' })).rejects.toMatchObject({ code: 'show-closed' });
    expect(a.app.show.state.singers).toHaveLength(0);
    // Clearing the list is not running a show.
    await a.act({ type: 'newShow' });
  });

});

describe('signing in from the console', () => {
  it('starts the free trial, and the show opens', async () => {
    const a = await start();
    await a.signIn('kj@example.com');
    expect(a.view().license).toMatchObject({ state: 'trial', email: 'kj@example.com', trialDaysLeft: 14, cloud: true, showOpen: true });
    const p = a.phone();
    await p.ready();
    const { token } = await ack<{ token: string }>(p.socket, 'singer:join', 'Robin');
    expect(token).toBeTruthy();
    await ack(a.dj, 'dj:action', { type: 'addSinger', name: 'Pat' });
    expect(a.app.show.state.singers.map((s) => s.name)).toEqual(['Robin', 'Pat']);
  });

  it('is cleared to the console as plain words when something is wrong', async () => {
    const a = await start();
    await expect(ack(a.dj, 'dj:action', { type: 'accountSendCode', email: 'nope' })).rejects.toMatchObject({ message: 'That doesn’t look like an email address.' });
    await ack(a.dj, 'dj:action', { type: 'accountSendCode', email: 'kj@example.com' });
    await expect(ack(a.dj, 'dj:action', { type: 'accountVerify', email: 'kj@example.com', code: '000000' })).rejects.toMatchObject({ message: expect.stringMatching(/code didn’t work/) });
    expect(a.view().license.state).toBe('signed-out');
  });

  it('can be undone: signing out closes the show again', async () => {
    const a = await start();
    await a.signIn();
    await ack(a.dj, 'dj:action', { type: 'accountSignOut' });
    await until(() => a.view().license.state === 'signed-out');
    expect(a.view().license.showOpen).toBe(false);
    const p = a.phone();
    await p.ready();
    await expect(ack(p.socket, 'singer:join', 'Robin')).rejects.toMatchObject({ message: NOT_OPEN });
  });

  it('takes an unlock code, and refuses a wrong one in the service’s words', async () => {
    const a = await start();
    await a.signIn();
    await expect(ack(a.dj, 'dj:action', { type: 'redeemCode', code: 'ENC-0000-0000-0000' })).rejects.toMatchObject({ message: 'That unlock code isn’t right. Check it and try again.' });
    await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('dave') });
    await until(() => a.view().license.state === 'licensed');
    expect(a.view().license).toMatchObject({ app: true, cloud: true, cloudUntil: 'forever', source: 'code' });
  });
});

describe('when the plan has ended', () => {
  it('closes the show to phones and to Add singer, once nothing is running', async () => {
    const a = await start();
    await a.signIn();
    await endTheTrial(a);
    expect(a.view().license).toMatchObject({ state: 'ended', showOpen: false, cloud: false });
    const p = a.phone();
    await p.ready();
    await expect(ack(p.socket, 'singer:join', 'Robin')).rejects.toMatchObject({ message: NOT_OPEN });
    await expect(a.act({ type: 'addSinger', name: 'Pat' })).rejects.toMatchObject({ message: expect.stringMatching(/free trial has ended.*Settings → Your Encore/) });
    expect(a.app.show.state.singers).toHaveLength(0);
  });

  it('opens again the moment an unlock code is used', async () => {
    const a = await start();
    await a.signIn();
    await endTheTrial(a);
    await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('welcome back') });
    await until(() => a.view().license.showOpen);
    const p = a.phone();
    await p.ready();
    await expect(ack(p.socket, 'singer:join', 'Robin')).resolves.toBeTruthy();
  });

  it('shows a plan that ended mid-evening on its own, with nobody asking', async () => {
    const a = await start({ planCheckMs: 30 });
    await a.signIn();
    expect(a.view().license.state).toBe('trial');
    clock.t += 14 * DAY + 1000; // the trial (and the pass) run out while nothing is happening
    await until(() => a.view().license.state === 'offline-expired');
    expect(a.view().license.showOpen).toBe(false);
  });

  it('asks to go online when the pass is too old and there is no internet', async () => {
    const a = await start();
    await a.signIn();
    fake.online = false;
    clock.t += 14 * DAY + 1000;
    await expect(ack(a.dj, 'dj:action', { type: 'refreshLicense' })).rejects.toMatchObject({ message: expect.stringMatching(/Is this laptop online/) });
    await until(() => a.view().license.state === 'offline-expired');
    await expect(a.act({ type: 'addSinger', name: 'Pat' })).rejects.toMatchObject({ message: 'Encore needs to check your license. Connect this laptop to the internet.' });
  });
});

describe('a show that is running', () => {
  /** A night under way: two singers, one on stage, with the trial still going. */
  async function nightUnderWay() {
    const a = await start({ cloud: true });
    await a.signIn();
    await until(() => a.app.relay?.state === 'online');
    const robin = a.phone();
    await robin.ready();
    await ack(robin.socket, 'singer:join', 'Robin');
    await ack(robin.socket, 'singer:action', { type: 'request', song: SONG });
    await ack(a.dj, 'dj:action', { type: 'addSinger', name: 'Pat' });
    await ack(a.dj, 'dj:action', { type: 'addEntry', singerId: a.app.show.state.singers[1]!.id, song: { ...SONG, videoId: 'bbbbbbbbbbb', title: 'Africa' } });
    await ack(a.dj, 'dj:action', { type: 'callNext' });
    expect(a.app.show.state.nowPlaying).not.toBeNull();
    return { a, robin };
  }

  it('is never cut off when the plan runs out: phones still join, the KJ still adds and calls, songs carry on to the next singer', async () => {
    const { a, robin } = await nightUnderWay();
    await endTheTrial(a);
    expect(a.view().license).toMatchObject({ state: 'ended', showOpen: true });

    // A new phone joins and asks for a song, the KJ adds a singer, and the singer on stage is not interrupted.
    const late = a.phone();
    await late.ready();
    await ack(late.socket, 'singer:join', 'Late Larry');
    await ack(late.socket, 'singer:action', { type: 'request', song: { ...SONG, videoId: 'ccccccccccc', title: 'Late song' } });
    await ack(a.dj, 'dj:action', { type: 'addSinger', name: 'Sam' });
    expect(a.app.show.state.singers.map((s) => s.name)).toEqual(['Robin', 'Pat', 'Late Larry', 'Sam']);
    expect(robin.view()?.notOpen).toBeUndefined();
    expect(robin.view()).toMatchObject({ me: { name: 'Robin' } });

    // The song ends and the next singer is called up as usual.
    const first = a.app.show.state.nowPlaying!;
    await ack(a.dj, 'dj:action', { type: 'play' });
    await ack(a.dj, 'dj:action', { type: 'skip' });
    expect(a.app.show.state.nowPlaying?.playId).not.toBe(first.playId);
    expect(a.app.show.state.nowPlaying?.singerName).toBe('Pat');
    await ack(a.dj, 'dj:action', { type: 'callNext' });
  });

  it('is held open even if the plan runs out the instant after its first singer joins', async () => {
    const a = await start();
    await a.signIn();
    // No awaits between these: the first singer is added, and the plan runs out before anything has had a
    // chance to look at the show (a broadcast, say).
    a.app.show.addSinger('First', false);
    clock.t += 400 * DAY;
    expect(a.app.license?.state()).toBe('offline-expired');
    expect(() => a.app.show.addSinger('Second', true)).not.toThrow();
    // A show that had no singers when the plan ran out is a different matter.
    a.app.show.newShow();
    expect(() => a.app.show.addSinger('Third', true)).toThrow(NOT_OPEN);
  });

  it('ends with the show: a new list starts closed once the plan has run out', async () => {
    const { a, robin } = await nightUnderWay();
    await endTheTrial(a);
    await ack(a.dj, 'dj:action', { type: 'newShow' });
    await until(() => a.view().license.showOpen === false);
    await robin.ready();
    const fresh = a.phone();
    await fresh.ready();
    await expect(ack(fresh.socket, 'singer:join', 'Next Night Nina')).rejects.toMatchObject({ message: NOT_OPEN });
    await expect(a.act({ type: 'addSinger', name: 'Pat' })).rejects.toMatchObject({ code: 'show-closed' });
  });

  /** Close the app and open it again on the same folder, as quitting Encore and starting it later does. */
  async function restart(a: Running): Promise<Running> {
    await a.app.close();
    apps.splice(apps.indexOf(a.app), 1);
    return start({ cloud: true });
  }

  it('ends when the app is closed: it comes back closed, and the singers get back their places when the plan does', async () => {
    const { a, robin } = await nightUnderWay();
    // Pat sings later; Robin (on stage) keeps the spot the phone remembers.
    const token = await ack<{ token: string }>(robin.socket, 'singer:reclaim', 'Robin', a.app.show.state.singers[0]!.code).then((r) => r.token);
    await endTheTrial(a);
    expect(a.view().license.showOpen).toBe(true);

    // Same folder, same saved show, the plan already run out.
    const b = await restart(a);
    expect(b.view().license).toMatchObject({ state: 'ended', showOpen: false });
    expect(b.app.show.state.singers.map((s) => s.name)).toEqual(['Robin', 'Pat']);
    const again = b.phone();
    await again.ready();
    await expect(ack(again.socket, 'singer:join', 'Somebody New')).rejects.toMatchObject({ message: NOT_OPEN });
    await expect(b.act({ type: 'callNext' })).rejects.toMatchObject({ code: 'show-closed' });
    // A returning singer's phone is told only that the show isn't open.
    await ack(again.socket, 'singer:resume', token);
    await until(() => again.view()?.notOpen === true);
    expect(again.view()).toMatchObject({ notOpen: true, me: null, myEntries: [], nowPlaying: null });
    await expect(ack(again.socket, 'singer:action', { type: 'request', song: SONG })).rejects.toMatchObject({ message: NOT_OPEN });

    // An unlock code, and they are back where they were.
    await ack(b.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('rescued') });
    await until(() => again.view()?.me?.name === 'Robin');
    expect(again.view()?.notOpen).toBeUndefined();
    expect(again.view()).toMatchObject({ nowPlaying: { singerName: 'Robin', isMe: true } });
  });

  it('has no way round it by a side door: with the show closed, skip and no-show call nobody either', async () => {
    const { a } = await nightUnderWay();
    await endTheTrial(a);
    const b = await restart(a);
    // Yesterday's singer is still on the intro card, and Pat is waiting.
    expect(b.app.show.state.nowPlaying?.singerName).toBe('Robin');
    expect(b.view().license.showOpen).toBe(false);
    expect(b.app.show.callNext()).toBeNull();
    await ack(b.dj, 'dj:action', { type: 'skip' });
    expect(b.app.show.state.nowPlaying).toBeNull();
    await ack(b.dj, 'dj:action', { type: 'noShow' });
    expect(b.app.show.state.nowPlaying).toBeNull();
    await expect(b.act({ type: 'callEntry', entryId: b.app.show.state.entries[0]!.id })).rejects.toMatchObject({ code: 'show-closed' });
    expect(b.app.show.state.nowPlaying).toBeNull();
  });
});

describe('Encore Cloud', () => {
  it('is on for the free trial and for an unlock code that includes it: the online link works', async () => {
    const a = await start({ cloud: true });
    await a.signIn();
    await until(() => a.app.relay?.state === 'online');
    await until(() => a.view().relay.state === 'online');
    expect(a.app.joinUrl()).toMatch(/^https:\/\/sing\.example\/#/);
    expect(a.view().print.lasting).toBe(true);
    const p = a.phone();
    await p.ready();
    await ack(p.socket, 'singer:join', 'Robin');
    await until(() => p.view()?.push !== undefined);
  });

  it('is off without it: the relay does not start, the link is the Wi-Fi one, and phones get no lock-screen alerts', async () => {
    const a = await start({ cloud: true });
    await a.signIn();
    await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('app only', 'app') });
    await until(() => a.view().license.state === 'licensed');
    await endTheTrial2(a);
    expect(a.app.relay).toBeUndefined();
    expect(a.app.joinUrl()).toMatch(/^http:\/\/.+:\d+\/join$/);
    expect(a.view().relay.state).toBe('off');
    expect(a.view().print).toMatchObject({ lasting: false });
    expect(a.view().print.url).toMatch(/^http:\/\//);
    expect(a.view().license).toMatchObject({ state: 'licensed', cloud: false, showOpen: true });

    // Shows still run, and phones join with the Wi-Fi link, but there are no alerts to offer.
    const p = a.phone();
    await p.ready();
    await ack(p.socket, 'singer:join', 'Robin');
    await until(() => p.view()?.me?.name === 'Robin');
    expect(p.view()?.push).toBeUndefined();
    await expect(ack(p.socket, 'singer:action', { type: 'pushSubscribe', subscription: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } } })).rejects.toMatchObject({
      message: expect.stringMatching(/Lock-screen alerts aren’t available/),
    });
  });

  it('turns on by itself, with no restart, when the plan gains it', async () => {
    const a = await start({ cloud: true });
    await a.signIn();
    await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('app only', 'app') });
    await endTheTrial2(a);
    expect(a.app.relay).toBeUndefined();
    await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('and cloud', 'forever') });
    await until(() => a.app.relay?.state === 'online');
    expect(a.app.joinUrl()).toMatch(/^https:\/\/sing\.example\/#/);
  });

  it('carries on through a show that is running when it runs out, then stops with the show', async () => {
    const a = await start({ cloud: true });
    await a.signIn();
    await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('cloud year', 'cloud_year') });
    await until(() => a.app.relay?.state === 'online');
    await ack(a.dj, 'dj:action', { type: 'addSinger', name: 'Pat' });
    // A year and a bit later the Cloud year has run out (the trial too, so the plan is just the app's absence)...
    clock.t += 400 * DAY;
    await ack(a.dj, 'dj:action', { type: 'refreshLicense' });
    await until(() => a.view().license.state === 'ended');
    // ...but the show that was running keeps its online link and alerts.
    expect(a.view().license).toMatchObject({ cloud: false, showOpen: true });
    expect(a.app.relay?.state).toBe('online');
    expect(a.app.joinUrl()).toMatch(/^https:\/\/sing\.example\/#/);
    // A new list is a new show: Cloud is not part of the plan, so it goes.
    await ack(a.dj, 'dj:action', { type: 'newShow' });
    await until(() => a.app.relay === undefined);
    expect(a.app.joinUrl()).toMatch(/^http:\/\//);
    expect(a.view().relay.state).toBe('off');
  });

  it('does not start for a copy that is signed out, even with Cloud configured', async () => {
    const a = await start({ cloud: true });
    expect(a.app.relay).toBeUndefined();
    expect(a.view().relay.state).toBe('off');
    expect(a.app.joinUrl()).toMatch(/^http:\/\//);
  });
});

/** Move past the trial so only what was bought or redeemed is left (and check in, as the laptop does). */
async function endTheTrial2(a: Running) {
  clock.t += 15 * DAY;
  await ack(a.dj, 'dj:action', { type: 'refreshLicense' });
  await until(() => a.view().license.state === 'licensed' && !a.view().license.trialDaysLeft);
}

describe('YouTube, in every state', () => {
  /** Put the app in each state a KJ can be in. */
  const STATES: { name: string; ready: (a: Running) => Promise<void>; expected: string }[] = [
    { name: 'signed out', expected: 'signed-out', ready: async () => {} },
    { name: 'on the free trial', expected: 'trial', ready: (a) => a.signIn() },
    {
      name: 'with Encore but no Cloud',
      expected: 'licensed',
      ready: async (a) => {
        await a.signIn();
        await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('app only', 'app') });
        await until(() => a.view().license.state === 'licensed');
      },
    },
    {
      name: 'with Encore and Cloud forever',
      expected: 'licensed',
      ready: async (a) => {
        await a.signIn();
        await ack(a.dj, 'dj:action', { type: 'redeemCode', code: await world.makeCode('everything') });
        await until(() => a.view().license.state === 'licensed');
      },
    },
    {
      name: 'as the owner',
      expected: 'owner',
      ready: async (a) => {
        await a.signIn('owner@example.com');
        await world.setOwner('owner@example.com');
        await ack(a.dj, 'dj:action', { type: 'refreshLicense' });
        await until(() => a.view().license.state === 'owner');
      },
    },
    { name: 'after the trial', expected: 'ended', ready: async (a) => (await a.signIn(), endTheTrial(a)) },
    {
      name: 'with the pass too old and no internet',
      expected: 'offline-expired',
      ready: async (a) => {
        await a.signIn();
        fake.online = false;
        clock.t += 15 * DAY;
        await ack(a.dj, 'dj:action', { type: 'refreshLicense' }).catch(() => {});
        await until(() => a.view().license.state === 'offline-expired');
      },
    },
  ];

  it.each(STATES)('search, pasted links and the player page work the same $name', async ({ ready, expected }) => {
    const a = await start({ cloud: true });
    await ready(a);
    expect(a.view().license.state).toBe(expected);

    // The KJ's console.
    const found = await ack<SearchResult[]>(a.dj, 'searchYouTube', 'africa toto');
    expect(found.map((r) => r.song.title)).toEqual(['Toto - Africa (Karaoke Version)']);
    const pasted = await ack<SearchResult>(a.dj, 'lookupYouTube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
    expect(pasted.song).toMatchObject({ title: 'Toto - Africa (Karaoke Version)', source: { kind: 'youtube', videoId: 'aaaaaaaaaaa' } });
    expect(a.view().youtubeSearch).toBe(true);

    // A phone, whether or not there is a show to join.
    const p = a.phone();
    await p.ready();
    expect((await ack<SearchResult[]>(p.socket, 'searchYouTube', 'africa toto')).map((r) => r.song.title)).toEqual(['Toto - Africa (Karaoke Version)']);
    expect((await ack<SearchResult>(p.socket, 'lookupYouTube', 'aaaaaaaaaaa')).song.title).toBe('Toto - Africa (Karaoke Version)');

    // YouTube plays from Encore's own page whatever the plan: the player page doesn't depend on Cloud.
    expect(a.view().youtube.frameUrl).toBe(`${ORIGIN}/yt-frame`);
  });

  // A tripwire, not the main guard (the tests above are): YouTube's policies forbid charging for any YouTube
  // feature, so if one of these handlers ever starts asking about the plan, this says why that's not allowed.
  it('is untouched by the plan in the code too: the YouTube handlers never ask the license anything', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = (await readFile(join(import.meta.dirname, '..', 'src', 'server', 'app.ts'), 'utf8')).replace(/\r\n/g, '\n');
    /** The text from where a handler starts to where the next thing does. */
    const block = (start: string, end: RegExp) => {
      const i = src.indexOf(start);
      expect(i, `${start} is in app.ts`).toBeGreaterThan(-1);
      const rest = src.slice(i + start.length);
      return start + rest.slice(0, rest.search(end));
    };
    const handlers = {
      searchYouTube: block("socket.on('searchYouTube'", /\n {4}socket\.on\(/),
      lookupYouTube: block("socket.on('lookupYouTube'", /\n {2}\}\n/),
      youtubeCheck: block("case 'youtubeCheck':", /\n {6}case '/),
      notKaraoke: block("case 'notKaraoke':", /\n {6}case '/),
    };
    for (const [name, text] of Object.entries(handlers)) {
      expect(text.length, name).toBeGreaterThan(80);
      expect(text, `${name} must not depend on the plan (YouTube policies III.F.3.a and III.G.1.b)`).not.toMatch(/license|showOpen|cloudIncluded|closedMessage|access\./);
    }
    // And the player page comes from the service as configured, never from the plan.
    expect(src).toMatch(/frameUrl: cloud \? /);
  });

  it('works on a Wi-Fi copy with no Cloud at all, as before', async () => {
    const a = await start({ cloud: false, license: false });
    expect((await ack<SearchResult[]>(a.dj, 'searchYouTube', 'africa toto')).length).toBe(1);
  });
});

describe('a copy with licensing switched off', () => {
  it('behaves exactly as it always did, and says licensing is off', async () => {
    const a = await start({ license: false });
    expect(a.app.license).toBeUndefined();
    expect(a.view().license).toMatchObject({ state: 'off', showOpen: true });
    const p = a.phone();
    await p.ready();
    await expect(ack(p.socket, 'singer:join', 'Robin')).resolves.toBeTruthy();
    await expect(ack(a.dj, 'dj:action', { type: 'accountSendCode', email: 'kj@example.com' })).rejects.toMatchObject({ message: 'Licensing is switched off in this copy of Encore.' });
  });

  it('is what the environment asks for in development, but not for a copy that sets its own options', async () => {
    // The test environment says ENCORE_LICENSE=off (see vitest.config.ts).
    const dev = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, cloud: false, youtubeProxy: false });
    expect(dev.license).toBeUndefined();
    await dev.close();
    // The installed app passes {}: it checks the license whatever the environment says.
    const installed = await createApp({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, cloud: false, youtubeProxy: false, license: {} });
    expect(installed.license).toBeDefined();
    expect(installed.license?.state()).toBe('signed-out');
    await installed.close();
  });
});
