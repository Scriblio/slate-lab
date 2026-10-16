import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encrypt,
  generateVapidKeys,
  importVapidKeys,
  parseSubscription,
  pushHostAllowed,
  sendPush,
  vapidAuthorization,
} from '../src/server/webpush.ts';
import { decrypt, phoneKeys } from './pushkit.ts';

const b64 = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

describe('Web Push encryption', () => {
  it('matches the worked example in RFC 8291', () => {
    // Appendix A of RFC 8291.
    const body = encrypt(
      b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      { salt: b64('DGv6ra1nlYgDCS1FRnbzlw'), serverPrivateKey: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    );
    const header = b64(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
      mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`);
    const ciphertext = b64(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
      bI_0LpXMuGvnzQ`);
    expect(header.length).toBe(86);
    expect(body.toString('base64url')).toBe(Buffer.concat([header, ciphertext]).toString('base64url'));
  });

  it('round-trips through what the phone does, with fresh keys every time', () => {
    const phone = phoneKeys();
    const message = Buffer.from(JSON.stringify({ title: 'It’s your turn!', body: 'Head to the stage for “Africa”.' }));
    const a = encrypt(message, phone.keys);
    const b = encrypt(message, phone.keys);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, phone).equals(message)).toBe(true);
    expect(decrypt(b, phone).equals(message)).toBe(true);
  });

  it('refuses messages too long for a push service', () => {
    expect(() => encrypt(Buffer.alloc(5000), phoneKeys().keys)).toThrow(/too long/);
  });
});

describe('VAPID', () => {
  it('signs a token for the push service that the public key verifies', () => {
    const saved = generateVapidKeys();
    const keys = importVapidKeys(saved);
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65);
    const now = Date.UTC(2026, 9, 3, 20, 0, 0);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc123', keys, 'https://sing.example', now);
    const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
    expect(m).toBeTruthy();
    const [, h, c, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://sing.example' });
    const point = Buffer.from(k!, 'base64url');
    const pub = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
  });

  it('keeps the same public key after saving and loading', () => {
    const saved = JSON.parse(JSON.stringify(generateVapidKeys()));
    expect(importVapidKeys(saved).publicKey).toBe(saved.publicKey);
  });
});

describe('subscriptions from phones', () => {
  it('only sends to the browsers’ own push services', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGkVq',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(pushHostAllowed(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com@192.168.1.1/x',
      'https://evil.example/fcm.googleapis.com',
      'https://192.168.1.1/admin',
      'https://localhost/x',
      'https://notify.windows.com/x',
      'https://.notify.windows.com/x',
      'not a url',
    ]) expect(pushHostAllowed(bad), bad).toBe(false);
  });

  it('checks the keys are the right shape', () => {
    const { keys } = phoneKeys();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(parseSubscription({ endpoint, expirationTime: null, keys })).toEqual({ endpoint, keys });
    expect(parseSubscription({ endpoint, keys: { ...keys, auth: 'short' } })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, p256dh: Buffer.alloc(65, 1).toString('base64url') } })).toBeNull();
    expect(parseSubscription({ endpoint: 'https://evil.example/x', keys })).toBeNull();
    expect(parseSubscription({ endpoint })).toBeNull();
    expect(parseSubscription('nope')).toBeNull();
  });
});

describe('sendPush', () => {
  it('posts an encrypted, signed message and reports expired subscriptions', async () => {
    const phone = phoneKeys();
    const vapid = importVapidKeys(generateVapidKeys());
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: phone.keys };
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;

    const res = await sendPush(sub, { title: 'Hi' }, { vapid, subject: 'https://sing.example', ttl: 300, topic: 'encore-turn', fetchImpl });
    expect(res).toEqual({ ok: true, status: 201, gone: false });
    const { url, init } = calls[0]!;
    expect(url).toBe(sub.endpoint);
    const h = init.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('300');
    expect(h.Topic).toBe('encore-turn');
    expect(h.Authorization).toMatch(/^vapid t=.+, k=/);
    const body = Buffer.from(init.body as Uint8Array);
    expect(JSON.parse(decrypt(body, phone).toString())).toEqual({ title: 'Hi' });

    status = 410;
    expect(await sendPush(sub, { title: 'Hi' }, { vapid, subject: 'https://sing.example', ttl: 300, fetchImpl })).toEqual({ ok: false, status: 410, gone: true });
  });
});
