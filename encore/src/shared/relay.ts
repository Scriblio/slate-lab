// End-to-end encrypted relay between singers' phones and the KJ's laptop.
//
// The laptop has a long-lived P-256 key pair. Its public key and a random
// room id travel in the QR code's URL fragment, which browsers never send to
// any server. Each phone makes a throwaway key pair; ECDH + HKDF give the
// phone and laptop a pair of AES-GCM keys (one per direction) that only they
// share. The relay (Supabase Realtime broadcast) sees topic names and
// ciphertext, nothing else. Other singers can't read or forge each other's
// traffic either, because each phone has its own keys.
//
//   phone  -> laptop   topic `encore:<room>`        event 'p'  { s, k, n?, iv, ct }
//   laptop -> phone    topic `encore:<room>:<sid>`  event 'h'  { iv, ct }
//
// Plaintext messages (JSON):
//   phone:  { n, t: 'hello' | 'ping' | 'bye' } | { n, t: 'emit', id?, ev, args }
//   laptop: { n, t: 'welcome' | 'pong' } | { n, t: 'ack', id, res } | { n, t: 'ev', ev, data }

import { RealtimeClient } from '@supabase/realtime-js';

const subtle = () => globalThis.crypto.subtle;
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const INFO = new TextEncoder().encode('encore-relay-v1');

// --- encoding ------------------------------------------------------------------

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function randomId(bytes = 16): string {
  return b64url(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A short room id: 10 lowercase letters/digits (~51 bits). */
export function randomRoom(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = globalThis.crypto.getRandomValues(new Uint8Array(10));
  return [...r].map((x) => alphabet[x % alphabet.length]).join('');
}

// --- keys ------------------------------------------------------------------------

export interface HostKeys {
  privateKey: CryptoKey;
  /** Uncompressed P-256 point, base64url (87 chars). Goes in the QR code. */
  publicKey: string;
}

export async function generateKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: string; privateJwk: JsonWebKey }> {
  const pair = (await subtle().generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = await subtle().exportKey('raw', pair.publicKey);
  const privateJwk = await subtle().exportKey('jwk', pair.privateKey);
  return { privateKey: pair.privateKey, publicKey: b64url(raw), privateJwk };
}

export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', jwk, ECDH, false, ['deriveBits']);
}

export interface SessionKeys {
  /** Phone -> laptop. */
  up: CryptoKey;
  /** Laptop -> phone. */
  down: CryptoKey;
}

/** Both sides call this with their own private key and the other side's public key. */
export async function deriveSessionKeys(myPrivate: CryptoKey, theirPublic: string, room: string): Promise<SessionKeys> {
  const pub = await subtle().importKey('raw', unb64url(theirPublic), ECDH, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: pub }, myPrivate, 256);
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(
    await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(room), info: INFO }, hkdf, 512),
  );
  const aes = (b: Uint8Array<ArrayBuffer>) => subtle().importKey('raw', b, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { up: await aes(bits.slice(0, 32)), down: await aes(bits.slice(32)) };
}

export interface Sealed {
  iv: string;
  ct: string;
}

export async function seal(key: CryptoKey, message: unknown): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(message)));
  return { iv: b64url(iv), ct: b64url(ct) };
}

/** Decrypt, or throw if the message was not sealed with this key. */
export async function open<T = unknown>(key: CryptoKey, box: Sealed): Promise<T> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64url(box.iv) }, key, unb64url(box.ct));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

// --- join links ------------------------------------------------------------------

export interface JoinTarget {
  room: string;
  hostKey: string;
}

export function joinLink(origin: string, target: JoinTarget): string {
  return `${origin.replace(/\/$/, '')}/#${target.room}.${target.hostKey}`;
}

export function parseJoinFragment(hash: string): JoinTarget | null {
  const m = hash.replace(/^#/, '').match(/^([a-z0-9]{6,32})\.([A-Za-z0-9_-]{80,100})$/);
  return m ? { room: m[1]!, hostKey: m[2]! } : null;
}

export const hostTopic = (room: string) => `encore:${room}`;
export const phoneTopic = (room: string, sid: string) => `encore:${room}:${sid}`;

// --- transport -------------------------------------------------------------------

/** A pub/sub pipe. The real one is Supabase Realtime; tests use an in-memory hub. */
export interface RelayTransport {
  subscribe(topic: string, event: string, onMessage: (payload: unknown) => void, onStatus?: (online: boolean) => void): () => void;
  publish(topic: string, event: string, payload: unknown): void;
  close(): void;
}

export function supabaseTransport(url: string, key: string): RelayTransport {
  const base = url.replace(/\/$/, '');
  const client = new RealtimeClient(`${base.replace(/^http/, 'ws')}/realtime/v1`, { params: { apikey: key } });
  const endpoint = `${base}/realtime/v1/api/broadcast`;
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;

  // Sends go over HTTPS, batched, so senders never have to join (and then
  // receive) each other's topics.
  let queue: { topic: string; event: string; payload: unknown; private: false }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const batch = queue.slice(0, 50);
    queue = queue.slice(50);
    if (queue.length) timer = setTimeout(flush, 0);
    fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ messages: batch }) })
      .then((r) => r.body?.cancel())
      .catch(() => {
        // Dropped messages are recovered by the next view or a retry.
      });
  };

  return {
    subscribe(topic, event, onMessage, onStatus) {
      const channel = client.channel(topic, { config: { broadcast: { self: false } } });
      channel.on('broadcast', { event }, (msg: { payload?: unknown }) => onMessage(msg.payload));
      channel.subscribe((status: string) => onStatus?.(status === 'SUBSCRIBED'));
      return () => void client.removeChannel(channel);
    },
    publish(topic, event, payload) {
      queue.push({ topic, event, payload, private: false });
      timer ??= setTimeout(flush, 0);
    },
    close() {
      void client.disconnect();
    },
  };
}

/** In-memory transport for tests and offline demos. Delivery is async. */
export class MemoryHub {
  private subs = new Map<string, Set<(payload: unknown) => void>>();
  /** Every published message, for assertions. */
  readonly log: { topic: string; event: string; payload: unknown }[] = [];

  transport(): RelayTransport {
    const mine: (() => void)[] = [];
    return {
      subscribe: (topic, event, onMessage, onStatus) => {
        const key = `${topic}|${event}`;
        let set = this.subs.get(key);
        if (!set) this.subs.set(key, (set = new Set()));
        set.add(onMessage);
        setTimeout(() => onStatus?.(true), 0);
        const off = () => set!.delete(onMessage);
        mine.push(off);
        return off;
      },
      publish: (topic, event, payload) => {
        this.log.push({ topic, event, payload });
        const copy = JSON.parse(JSON.stringify(payload)) as unknown;
        setTimeout(() => this.subs.get(`${topic}|${event}`)?.forEach((fn) => fn(copy)), 0);
      },
      close: () => mine.forEach((off) => off()),
    };
  }
}
