// The laptop end of the online join link. Each phone that reaches us through
// the relay gets its own local Socket.IO connection to this server, with
// the singer role and nothing more. So phones joining online go through
// exactly the same rules, limits and validation as phones on the Wi-Fi.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { io as connectLocal, type Socket as LocalSocket } from 'socket.io-client';
import {
  deriveSessionKeys,
  generateKeyPair,
  hostTopic,
  importPrivateKey,
  open,
  phoneTopic,
  randomRoom,
  seal,
  type HostKeys,
  type RelayTransport,
  type SessionKeys,
} from '../shared/relay.ts';

/** Events a phone may send. Never the DJ or display events. */
const ALLOWED = new Set(['singer:join', 'singer:resume', 'singer:action', 'search', 'searchYouTube', 'lookupYouTube']);
/** Events forwarded from the server to the phone. */
const FORWARD = ['singer:view', 'singer:removed'] as const;

const IDLE_MS = 75_000;
const MAX_SESSIONS = 400;
const NEW_SESSIONS_PER_10S = 40;

export interface RelayIdentity extends HostKeys {
  room: string;
}

/** The room id and key pair live in the data folder so printed QR codes keep working. */
export async function loadIdentity(dataDir: string): Promise<RelayIdentity> {
  const file = join(dataDir, 'relay.json');
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as { room: string; publicKey: string; privateJwk: JsonWebKey };
    return { room: saved.room, publicKey: saved.publicKey, privateKey: await importPrivateKey(saved.privateJwk) };
  } catch {
    const pair = await generateKeyPair();
    const room = randomRoom();
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify({ room, publicKey: pair.publicKey, privateJwk: pair.privateJwk }), { mode: 0o600 });
    return { room, publicKey: pair.publicKey, privateKey: await importPrivateKey(pair.privateJwk) };
  }
}

/**
 * Each session the laptop opens gets a larger epoch than the last, even
 * across restarts. The phone uses it to tell a restarted laptop (fresh
 * message numbers) from a replay of old messages.
 */
let lastEpoch = 0;
function nextEpoch(): number {
  lastEpoch = Math.max(Date.now(), lastEpoch + 1);
  return lastEpoch;
}

interface Session {
  sid: string;
  epoch: number;
  keys: SessionKeys;
  local: LocalSocket;
  lastSeen: number;
  sent: number;
  seen: Set<number>;
  maxSeen: number;
}

export type RelayState = 'connecting' | 'online' | 'offline';

export class RelayHost {
  state: RelayState = 'connecting';
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Promise<Session | null>>();
  private recentNew: number[] = [];
  private unsubscribe: (() => void) | undefined;
  private sweep: ReturnType<typeof setInterval> | undefined;

  constructor(
    private opts: {
      transport: RelayTransport;
      identity: RelayIdentity;
      /** Where this server listens, e.g. http://127.0.0.1:4747 */
      localUrl: string;
      onState?: (state: RelayState) => void;
    },
  ) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  start(): void {
    const { transport, identity } = this.opts;
    this.unsubscribe = transport.subscribe(
      hostTopic(identity.room),
      'p',
      (payload) => void this.receive(payload).catch(() => {}),
      (online) => this.setState(online ? 'online' : 'offline'),
    );
    this.sweep = setInterval(() => this.dropIdle(), 15_000);
    this.sweep.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    clearInterval(this.sweep);
    for (const s of this.sessions.values()) s.local.disconnect();
    this.sessions.clear();
    this.opts.transport.close();
    this.setState('offline');
  }

  private setState(state: RelayState): void {
    if (state === this.state) return;
    this.state = state;
    this.opts.onState?.(state);
  }

  private async receive(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const { s: sid, k, iv, ct } = raw as Record<string, unknown>;
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{16,32}$/.test(sid)) return;
    if (typeof iv !== 'string' || typeof ct !== 'string' || ct.length > 64_000) return;
    const session = this.sessions.get(sid) ?? (typeof k === 'string' ? await this.openSession(sid, k) : null);
    if (!session) return;
    let msg: { n?: unknown; t?: unknown; id?: unknown; ev?: unknown; args?: unknown };
    try {
      msg = await open(session.keys.up, { iv, ct });
    } catch {
      return; // not from this phone
    }
    if (typeof msg.n !== 'number' || !this.fresh(session, msg.n)) return;
    session.lastSeen = Date.now();
    switch (msg.t) {
      case 'hello':
        if (session.local.connected) await this.send(session, { t: 'welcome' });
        break;
      case 'ping':
        await this.send(session, { t: 'pong' });
        break;
      case 'bye':
        this.close(session);
        break;
      case 'emit': {
        if (typeof msg.ev !== 'string' || !ALLOWED.has(msg.ev)) return;
        const args = Array.isArray(msg.args) ? msg.args.slice(0, 4) : [];
        const id = typeof msg.id === 'number' ? msg.id : undefined;
        if (id === undefined) session.local.emit(msg.ev, ...args);
        else session.local.emit(msg.ev, ...args, (res: unknown) => void this.send(session, { t: 'ack', id, res }));
        break;
      }
    }
  }

  /** Accept each message number once; tolerate out-of-order delivery. */
  private fresh(s: Session, n: number): boolean {
    if (!Number.isSafeInteger(n) || n <= s.maxSeen - 256 || s.seen.has(n)) return false;
    s.seen.add(n);
    if (n > s.maxSeen) s.maxSeen = n;
    if (s.seen.size > 512) for (const x of s.seen) if (x <= s.maxSeen - 256) s.seen.delete(x);
    return true;
  }

  private openSession(sid: string, phoneKey: string): Promise<Session | null> {
    const existing = this.pending.get(sid);
    if (existing) return existing;
    const now = Date.now();
    this.recentNew = this.recentNew.filter((t) => now - t < 10_000);
    if (this.sessions.size >= MAX_SESSIONS || this.recentNew.length >= NEW_SESSIONS_PER_10S) return Promise.resolve(null);
    this.recentNew.push(now);
    const p = (async () => {
      let keys: SessionKeys;
      try {
        keys = await deriveSessionKeys(this.opts.identity.privateKey, phoneKey, this.opts.identity.room);
      } catch {
        return null;
      }
      const local = connectLocal(this.opts.localUrl, {
        auth: { role: 'singer' },
        transports: ['websocket'],
        forceNew: true,
        reconnectionDelay: 300,
      });
      const session: Session = { sid, epoch: nextEpoch(), keys, local, lastSeen: Date.now(), sent: 0, seen: new Set(), maxSeen: 0 };
      // Every (re)connection to the server is a fresh start for the phone:
      // it resumes its place with its token, just as after a page reload.
      local.on('connect', () => void this.send(session, { t: 'welcome' }));
      for (const ev of FORWARD) local.on(ev, (data: unknown) => void this.send(session, { t: 'ev', ev, data }));
      this.sessions.set(sid, session);
      return session;
    })();
    this.pending.set(sid, p);
    void p.finally(() => this.pending.delete(sid));
    return p;
  }

  private async send(s: Session, msg: Record<string, unknown>): Promise<void> {
    if (!this.sessions.has(s.sid)) return;
    const box = await seal(s.keys.down, { ...msg, e: s.epoch, n: ++s.sent });
    this.opts.transport.publish(phoneTopic(this.opts.identity.room, s.sid), 'h', box);
  }

  private close(s: Session): void {
    s.local.disconnect();
    this.sessions.delete(s.sid);
  }

  private dropIdle(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) if (now - s.lastSeen > IDLE_MS) this.close(s);
  }
}
