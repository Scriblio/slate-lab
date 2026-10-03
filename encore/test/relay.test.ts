import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelaySocket } from '../src/client/common/relay-socket.ts';
import { createApp, type App } from '../src/server/app.ts';
import {
  deriveSessionKeys,
  generateKeyPair,
  hostTopic,
  joinLink,
  MemoryHub,
  open,
  parseJoinFragment,
  seal,
  type JoinTarget,
} from '../src/shared/relay.ts';
import type { DjView, SearchResult } from '../src/shared/types.ts';

describe('relay crypto', () => {
  it('gives both ends the same keys, and nobody else', async () => {
    const host = await generateKeyPair();
    const phone = await generateKeyPair();
    const other = await generateKeyPair();
    const a = await deriveSessionKeys(phone.privateKey, host.publicKey, 'room1');
    const b = await deriveSessionKeys(host.privateKey, phone.publicKey, 'room1');
    const box = await seal(a.up, { hello: 'world' });
    expect(await open(b.up, box)).toEqual({ hello: 'world' });
    // Wrong direction, wrong room, or another phone: all fail.
    await expect(open(b.down, box)).rejects.toThrow();
    await expect(open((await deriveSessionKeys(host.privateKey, phone.publicKey, 'room2')).up, box)).rejects.toThrow();
    await expect(open((await deriveSessionKeys(host.privateKey, other.publicKey, 'room1')).up, box)).rejects.toThrow();
    // Tampering is detected.
    const flipped = { ...box, ct: box.ct.slice(0, -2) + (box.ct.endsWith('A') ? 'B' : 'A') + box.ct.slice(-1) };
    await expect(open(b.up, flipped)).rejects.toThrow();
  });

  it('reports a broken link to listeners that attach late', async () => {
    const hub = new MemoryHub();
    const sock = new RelaySocket(hub.transport(), { room: 'abc234defg', hostKey: 'A'.repeat(87) });
    await new Promise((r) => setTimeout(r, 50));
    const err = await new Promise<Error>((r) => sock.on('connect_error', (e) => r(e as Error)));
    expect(err.message).toMatch(/damaged/);
    sock.disconnect();
  });

  it('round-trips join links', async () => {
    const { publicKey } = await generateKeyPair();
    const link = joinLink('https://sing.example/', { room: 'abc234defg', hostKey: publicKey });
    expect(link).toMatch(/^https:\/\/sing\.example\/#abc234defg\./);
    expect(parseJoinFragment(new URL(link).hash)).toEqual({ room: 'abc234defg', hostKey: publicKey });
    expect(parseJoinFragment('#nonsense')).toBeNull();
  });
});

describe('online join link, end to end', () => {
  let dir: string;
  let app: App;
  let hub: MemoryHub;
  let target: JoinTarget;
  const cleanup: (() => void)[] = [];

  const ack = <T,>(s: { emit(ev: string, ...a: unknown[]): unknown }, ev: string, ...args: unknown[]) =>
    new Promise<T>((ok, fail) => s.emit(ev, ...args, (r: { ok: boolean; data?: T; error?: string }) => (r.ok ? ok(r.data as T) : fail(new Error(r.error)))));

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'encore-relay-'));
    hub = new MemoryHub();
    app = await createApp({
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      quiet: true,
      cloud: { joinOrigin: 'https://sing.example', transport: () => hub.transport() },
    });
    await app.listen();
    await until(() => app.relay?.state === 'online');
    target = parseJoinFragment(new URL(app.joinUrl()).hash)!;
  });

  afterAll(async () => {
    cleanup.forEach((f) => f());
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  function phone(): RelaySocket {
    const p = new RelaySocket(hub.transport(), target);
    cleanup.push(() => p.disconnect());
    return p;
  }

  it('puts the secure link in the QR code once the relay is online', () => {
    expect(app.joinUrl()).toMatch(/^https:\/\/sing\.example\/#[a-z0-9]{10}\.[A-Za-z0-9_-]{87}$/);
  });

  it('lets a phone join and request a song, and the relay only ever sees ciphertext', async () => {
    const p = phone();
    await new Promise((r) => p.on('connect', r));
    const views: unknown[] = [];
    p.on('singer:view', (v) => views.push(v));
    const { token } = await ack<{ token: string }>(p, 'singer:join', 'Robin Sparkles');
    expect(token.length).toBeGreaterThan(20);

    const dj = connect(`http://127.0.0.1:${app.port}`, { auth: { role: 'dj' }, transports: ['websocket'], forceNew: true });
    cleanup.push(() => dj.disconnect());
    const seen = new Promise<DjView>((ok) => dj.on('dj:view', (v: DjView) => v.show.entries.length === 1 && ok(v)));
    const id = await ack<string>(p, 'singer:action', { type: 'request', song: { kind: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Never Gonna' } });
    expect(id).toBeTruthy();
    expect((await seen).show.singers.map((s) => s.name)).toContain('Robin Sparkles');
    await until(() => views.some((v) => (v as { myEntries: unknown[] }).myEntries.length === 1));

    const wire = JSON.stringify(hub.log);
    expect(wire).not.toContain('Robin');
    expect(wire).not.toContain('Never Gonna');
    expect(wire).not.toContain(token);
  });

  it('only allows singer events through the relay', async () => {
    const p = phone();
    await new Promise((r) => p.on('connect', r));
    const before = app.show.state.singers.length;
    // A DJ action from a phone is dropped by the bridge, so it never answers.
    const result = await Promise.race([
      ack(p, 'dj:action', { type: 'addSinger', name: 'Mallory' }).then(() => 'ran'),
      new Promise((r) => setTimeout(() => r('ignored'), 300)),
    ]);
    expect(result).toBe('ignored');
    expect(app.show.state.singers.length).toBe(before);
  });

  it('ignores replayed and forged messages', async () => {
    const p = phone();
    await new Promise((r) => p.on('connect', r));
    const start = hub.log.length;
    await ack(p, 'singer:join', 'Ted');
    const count = app.show.state.singers.length;
    const t = hub.transport();
    // Replay every phone -> laptop message we just saw.
    for (const m of hub.log.slice(start).filter((m) => m.topic === hostTopic(target.room))) t.publish(m.topic, m.event, m.payload);
    // And a forgery from someone without the session key.
    const forger = await generateKeyPair();
    const keys = await deriveSessionKeys(forger.privateKey, target.hostKey, target.room);
    const box = await seal(keys.down, { n: 1, t: 'emit', ev: 'singer:join', args: ['Mallory'] });
    t.publish(hostTopic(target.room), 'p', { s: 'AAAAAAAAAAAAAAAAAAAAAA', k: forger.publicKey, ...box });
    await new Promise((r) => setTimeout(r, 200));
    expect(app.show.state.singers.length).toBe(count);
    t.close();
  });

  it('reconnects a phone after the laptop’s relay restarts, and the phone keeps its spot', async () => {
    const p = phone();
    await new Promise((r) => p.on('connect', r));
    const { token } = await ack<{ token: string }>(p, 'singer:join', 'Barney');
    let connects = 0;
    p.on('connect', () => connects++);

    const dj = connect(`http://127.0.0.1:${app.port}`, { auth: { role: 'dj' }, transports: ['websocket'], forceNew: true });
    cleanup.push(() => dj.disconnect());
    await new Promise((r) => dj.on('connect', () => r(null)));
    await ack(dj, 'dj:action', { type: 'setConfig', onlineJoin: false });
    expect(app.relay).toBeUndefined();
    await ack(dj, 'dj:action', { type: 'setConfig', onlineJoin: true });
    await until(() => app.relay?.state === 'online');
    // Same room and key, so the same QR code keeps working.
    expect(parseJoinFragment(new URL(app.joinUrl()).hash)).toEqual(target);

    // The phone's next message reaches the new relay, which welcomes it back.
    const results = await ack<SearchResult[]>(p, 'search', 'anything');
    expect(Array.isArray(results)).toBe(true);
    await until(() => connects > 0);
    const back = await ack<{ singerId: string }>(p, 'singer:resume', token);
    expect(app.show.singer(back.singerId)?.name).toBe('Barney');
  });

  it('falls back to the Wi-Fi link when the online link is off', async () => {
    const dj = connect(`http://127.0.0.1:${app.port}`, { auth: { role: 'dj' }, transports: ['websocket'], forceNew: true });
    cleanup.push(() => dj.disconnect());
    await new Promise((r) => dj.on('connect', () => r(null)));
    await ack(dj, 'dj:action', { type: 'setConfig', onlineJoin: false });
    expect(app.joinUrl()).toMatch(/^http:\/\/.+\/join$/);
    await ack(dj, 'dj:action', { type: 'setConfig', onlineJoin: true });
    await until(() => app.relay?.state === 'online');
  });
});
