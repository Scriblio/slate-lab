// The license pass: a small signed note saying what one KJ account may do on one
// laptop. The license service signs it with a private key only it holds, and
// every copy of Encore checks it with the matching public key built into the
// app, so nothing the app's own screens say can grant access by themselves.
//
// It's a compact JWT (header.payload.signature) signed with Ed25519 ("EdDSA"),
// made and checked with WebCrypto, which Deno (the service), Node (the app) and
// browsers all have. Plain TypeScript with no imports, so the app and the tests
// use this very file.

/** How Encore became theirs, so Settings can say so ("yours forever (unlock code)"). */
export type PassSource = 'owner' | 'code' | 'purchase' | 'trial';

export interface PassPayload {
  /** The pass format. */
  v: 1;
  /** The KJ's account id. */
  sub: string;
  email: string;
  /** The laptop this pass was issued to. */
  installId: string;
  /** Encore itself is theirs: owner, unlock code or purchase. */
  app: boolean;
  /** When Encore Cloud ends: an ISO date, "forever", or null for none. */
  cloudUntil: string | null;
  /** When the free trial ends (or ended): an ISO date, or null if there has been none. */
  trialUntil: string | null;
  owner: boolean;
  source: PassSource | null;
  /** Seconds since 1970. Past `exp`, the laptop must check in again before it trusts this pass. */
  iat: number;
  exp: number;
}

/** A public key and the id the pass header names it by, so keys can be replaced without breaking older apps. */
export interface PassKey {
  kid: string;
  key: CryptoKey;
}

const subtle = () => globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- encoding ------------------------------------------------------------------

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url (or plain base64) to bytes; throws on anything else. */
export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const s = text.trim().replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error('not base64');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- keys ------------------------------------------------------------------------

// What an Ed25519 private key looks like in PKCS#8, up to its 32-byte seed.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * The private key from the secret LICENSE_SIGNING_KEY: the 32-byte key as
 * base64url (43 characters), or a whole PKCS#8 key (48 bytes) as base64.
 */
export async function importSigningKey(secret: string): Promise<CryptoKey> {
  const bytes = unb64url(secret);
  let pkcs8: Uint8Array<ArrayBuffer>;
  if (bytes.length === 32) {
    pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
    pkcs8.set(PKCS8_PREFIX);
    pkcs8.set(bytes, PKCS8_PREFIX.length);
  } else if (bytes.length === 48) {
    pkcs8 = bytes;
  } else {
    throw new Error('The license signing key should be the 32-byte private key as base64url.');
  }
  return subtle().importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
}

/** A public key as the app ships it: the 32 raw bytes as base64url (43 characters). */
export async function importVerifyKey(publicKey: string): Promise<CryptoKey> {
  const bytes = unb64url(publicKey);
  if (bytes.length !== 32) throw new Error('A license public key is 32 bytes (43 characters of base64url).');
  return subtle().importKey('raw', bytes, 'Ed25519', true, ['verify']);
}

export async function importPassKeys(list: readonly { kid: string; key: string }[]): Promise<PassKey[]> {
  return Promise.all(list.map(async ({ kid, key }) => ({ kid, key: await importVerifyKey(key) })));
}

// --- signing and reading ------------------------------------------------------------

export async function signPass(payload: PassPayload, key: CryptoKey, kid = 'k1'): Promise<string> {
  const head = b64url(encoder.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })));
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = await subtle().sign('Ed25519', key, encoder.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(signature)}`;
}

/**
 * The pass's contents if it was signed by one of these keys, else null: a
 * wrong key, a changed payload and a different algorithm all fail. It does
 * not look at `exp`; what an old pass means is for the caller to decide.
 */
export async function readPass(token: string, keys: readonly PassKey[]): Promise<PassPayload | null> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  try {
    const header = JSON.parse(decoder.decode(unb64url(parts[0]!))) as { alg?: unknown; kid?: unknown };
    if (header.alg !== 'EdDSA') return null;
    const named = keys.filter((k) => k.kid === header.kid);
    const signature = unb64url(parts[2]!);
    const signed = encoder.encode(`${parts[0]}.${parts[1]}`);
    let good = false;
    for (const { key } of named.length ? named : keys) {
      if (await subtle().verify('Ed25519', key, signature, signed)) {
        good = true;
        break;
      }
    }
    if (!good) return null;
    const payload: unknown = JSON.parse(decoder.decode(unb64url(parts[1]!)));
    return isPassPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

const SOURCES: readonly unknown[] = ['owner', 'code', 'purchase', 'trial'];

function isPassPayload(p: unknown): p is PassPayload {
  if (!p || typeof p !== 'object') return false;
  const x = p as Record<string, unknown>;
  const date = (v: unknown) => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));
  return (
    x.v === 1 &&
    typeof x.sub === 'string' &&
    typeof x.email === 'string' &&
    typeof x.installId === 'string' &&
    typeof x.app === 'boolean' &&
    typeof x.owner === 'boolean' &&
    (x.cloudUntil === 'forever' || date(x.cloudUntil)) &&
    date(x.trialUntil) &&
    (x.source === null || SOURCES.includes(x.source)) &&
    Number.isSafeInteger(x.iat) &&
    Number.isSafeInteger(x.exp)
  );
}
