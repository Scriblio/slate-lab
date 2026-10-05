// Unlock codes look like ENC-7K4Q-M2XP-9R8T: twelve characters from Crockford's
// base32 (no I, L, O or U, so a code read aloud or copied off a napkin isn't
// misread) carrying 60 random bits. Only a hash is stored. make_unlock_code()
// in the database makes them (see the licensing migration); this file reads
// them back the way a KJ types them.
//
// Plain TypeScript with no imports, shared by the service and the app.

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const BODY = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;

/**
 * A typed code in its one proper form (ENC-XXXX-XXXX-XXXX), or null if it
 * can't be a code. Case, spaces, dashes and the ENC prefix don't matter, and
 * O, I and L are read as 0, 1 and 1, as Crockford's base32 does. The SQL
 * function normalize_unlock_code does exactly the same.
 */
export function normalizeCode(input: unknown): string | null {
  // Not String(input): "[object Object]" happens to spell twelve valid characters.
  if (typeof input !== 'string') return null;
  let s = input
    .replace(/[^0-9A-Za-z]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  // The prefix is optional; a code that happens to start with ENC has no prefix to drop, so go by length.
  if (s.length === 15 && s.startsWith('ENC')) s = s.slice(3);
  if (!BODY.test(s)) return null;
  return `ENC-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** What the database keeps in place of a code: the SHA-256 of its proper form, as hex. */
export async function hashCode(canonical: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
