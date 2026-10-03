// The phone's side of Web Push, for tests: a subscription's keys, and how the
// browser decrypts a message (RFC 8291).

import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

export interface PhoneKeys {
  priv: Buffer;
  pub: Buffer;
  auth: Buffer;
  keys: { p256dh: string; auth: string };
}

export function phoneKeys(): PhoneKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    priv: ecdh.getPrivateKey(),
    pub: ecdh.getPublicKey(),
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

export function decrypt(body: Buffer, phone: PhoneKeys): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(phone.priv);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, phone.auth, Buffer.concat([Buffer.from('WebPush: info\0'), phone.pub, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const padded = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  if (padded.at(-1) !== 2) throw new Error('missing the last-record delimiter');
  return padded.subarray(0, -1);
}

/** A stand-in for the push services: records what was sent, answers with `status`. */
export function pushService() {
  const sent: { endpoint: string; headers: Record<string, string>; body: Buffer }[] = [];
  const service = {
    sent,
    status: 201,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ endpoint: String(input), headers: (init?.headers ?? {}) as Record<string, string>, body: Buffer.from(init?.body as Uint8Array) });
      return new Response(null, { status: service.status });
    }) as typeof fetch,
    /** What phone `p` would show for each message sent to `endpoint`. */
    messages(endpoint: string, p: PhoneKeys): { kind: string; title: string; body: string; url?: string }[] {
      return sent.filter((s) => s.endpoint === endpoint).map((s) => JSON.parse(decrypt(s.body, p).toString()));
    },
  };
  return service;
}
