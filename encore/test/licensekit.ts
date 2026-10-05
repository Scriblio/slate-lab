// Throwaway keys and passes for the licensing tests. The real signing key is
// never anywhere near the tests.

import { b64url, importPassKeys, importSigningKey, type PassPayload } from '../supabase/functions/encore-license/pass.ts';

export const DAY = 24 * 60 * 60 * 1000;

export async function makeKeys(kid = 'k1') {
  const pair = (await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const publicKey = b64url(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  const seed = b64url(pkcs8.slice(pkcs8.length - 32));
  return {
    kid,
    /** The secret LICENSE_SIGNING_KEY would hold: the 32-byte private key. */
    seed,
    /** The same key as a whole PKCS#8 file's bytes. */
    pkcs8: b64url(pkcs8),
    /** What src/shared/license-key.ts holds. */
    publicKey,
    signing: await importSigningKey(seed),
    keys: await importPassKeys([{ kid, key: publicKey }]),
  };
}

/** A pass's contents: by default, Encore's owner, with a fortnight to go. */
export function passPayload(over: Partial<PassPayload> = {}, now = Date.now()): PassPayload {
  return {
    v: 1,
    sub: '11111111-1111-4111-8111-111111111111',
    email: 'kj@example.com',
    installId: 'abcdefghijklmnopqrstuv',
    app: false,
    cloudUntil: null,
    trialUntil: null,
    owner: false,
    source: null,
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + 14 * DAY) / 1000),
    ...over,
  };
}
