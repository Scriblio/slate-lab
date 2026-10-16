// Web Push, sent straight from the KJ's laptop: VAPID signing (RFC 8292) and
// message encryption (RFC 8291, aes128gcm). Each installation makes its own
// signing key, so there's no shared secret anywhere and no cloud service in
// the middle. The browser's push service (Apple, Google, Mozilla, Microsoft)
// only ever sees ciphertext.

import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export interface PushSubscriptionData {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Uncompressed P-256 point, base64url. Phones subscribe with it. */
  publicKey: string;
  privateKey: KeyObject;
}

export interface SavedVapidKeys {
  publicKey: string;
  privateJwk: JsonWebKey;
}

export function generateVapidKeys(): SavedVapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  return { publicKey: publicKeyFromJwk(privateJwk), privateJwk };
}

export function importVapidKeys(saved: SavedVapidKeys): VapidKeys {
  const privateKey = createPrivateKey({ key: saved.privateJwk, format: 'jwk' });
  return { publicKey: publicKeyFromJwk(saved.privateJwk), privateKey };
}

function publicKeyFromJwk(jwk: JsonWebKey): string {
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  if (x.length !== 32 || y.length !== 32) throw new Error('Not a P-256 key.');
  return Buffer.concat([Buffer.from([4]), x, y]).toString('base64url');
}

// --- which addresses a phone may hand us ------------------------------------------

// A subscription's endpoint comes from a phone, so it's untrusted: only the
// browsers' own push services are allowed, or a phone could make the laptop
// send requests anywhere (say, to a router on the venue network).
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.notify.windows.com'];

export function pushHostAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** A subscription as the phone sent it (PushSubscription.toJSON()), or null if it isn't one we'll use. */
export function parseSubscription(raw: unknown): PushSubscriptionData | null {
  if (!raw || typeof raw !== 'object') return null;
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !pushHostAllowed(endpoint)) return null;
  const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys?.auth === 'string' ? keys.auth : '';
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  const point = Buffer.from(p256dh, 'base64url');
  if (point.length !== 65 || point[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

// --- encryption (RFC 8291) ----------------------------------------------------------

const RECORD_SIZE = 4096;
/** Push services take bodies up to 4096 bytes; leave room for the header and tag. */
export const MAX_PAYLOAD = 3000;

/**
 * Encrypt a message for one subscription. `salt` and `serverPrivateKey` are
 * only for tests (RFC 8291's worked example); normally both are random.
 */
export function encrypt(
  payload: Uint8Array,
  keys: { p256dh: string; auth: string },
  fixed: { salt?: Uint8Array; serverPrivateKey?: Uint8Array } = {},
): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error('Push message too long.');
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (fixed.serverPrivateKey) ecdh.setPrivateKey(Buffer.from(fixed.serverPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = Buffer.from(fixed.salt ?? randomBytes(16));

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record: the message, then the 0x02 delimiter that marks the last record.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ct]);
}

// --- VAPID (RFC 8292) -------------------------------------------------------------

/** The Authorization header that proves the message comes from the key the phone subscribed with. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc(claims)}`;
  const sig = sign('sha256', Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${unsigned}.${sig}, k=${keys.publicKey}`;
}

export interface PushOptions {
  vapid: VapidKeys;
  /** Who's sending: an https URL or mailto: (Apple requires one). */
  subject: string;
  /** Seconds the push service may hold the message for a phone that's off. */
  ttl: number;
  /** A newer message with the same topic replaces an undelivered older one. */
  topic?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** The subscription has expired or was cancelled: forget it. */
  gone: boolean;
}

export async function sendPush(sub: PushSubscriptionData, message: unknown, opts: PushOptions): Promise<PushResult> {
  if (!pushHostAllowed(sub.endpoint)) return { ok: false, status: 0, gone: true };
  const body = new Uint8Array(encrypt(Buffer.from(JSON.stringify(message)), sub.keys));
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(sub.endpoint, opts.vapid, opts.subject, opts.now ?? Date.now()),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.round(opts.ttl))),
    Urgency: 'high',
  };
  if (opts.topic) headers.Topic = opts.topic;
  const res = await (opts.fetchImpl ?? fetch)(sub.endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel().catch(() => {});
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
