// The signed pass the license service hands out and the laptop checks, and the
// unlock code format.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashCode, normalizeCode } from '../supabase/functions/encore-license/codes.ts';
import { b64url, importSigningKey, importVerifyKey, readPass, signPass, unb64url } from '../supabase/functions/encore-license/pass.ts';
import { makeKeys, passPayload } from './licensekit.ts';

describe('the license pass', () => {
  it('is read back exactly as it was signed', async () => {
    const k = await makeKeys();
    const payload = passPayload({ app: true, source: 'code', cloudUntil: 'forever', trialUntil: '2026-10-18T12:00:00.000Z' });
    expect(await readPass(await signPass(payload, k.signing), k.keys)).toEqual(payload);
  });

  it('is rejected when another key signed it', async () => {
    const [mine, theirs] = [await makeKeys(), await makeKeys()];
    const forged = await signPass(passPayload({ owner: true, app: true }), theirs.signing);
    expect(await readPass(forged, mine.keys)).toBeNull();
  });

  it('is rejected when its contents were changed after signing', async () => {
    const k = await makeKeys();
    const [head, , sig] = (await signPass(passPayload(), k.signing)).split('.');
    const upgraded = b64url(new TextEncoder().encode(JSON.stringify(passPayload({ owner: true, app: true, cloudUntil: 'forever' }))));
    expect(await readPass(`${head}.${upgraded}.${sig}`, k.keys)).toBeNull();
  });

  it('is rejected under any other algorithm, so "none" and shared secrets can’t be used', async () => {
    const k = await makeKeys();
    const body = b64url(new TextEncoder().encode(JSON.stringify(passPayload({ owner: true, app: true }))));
    for (const alg of ['none', 'HS256', 'ES256']) {
      const head = b64url(new TextEncoder().encode(JSON.stringify({ alg, typ: 'JWT', kid: 'k1' })));
      expect(await readPass(`${head}.${body}.`, k.keys)).toBeNull();
      expect(await readPass(`${head}.${body}.${b64url(new Uint8Array(64))}`, k.keys)).toBeNull();
    }
  });

  it('is rejected when it is not a pass at all', async () => {
    const k = await makeKeys();
    for (const junk of ['', 'a.b', 'a.b.c', '...', 'not a token', '{}', null, undefined, 42]) expect(await readPass(junk as string, k.keys)).toBeNull();
  });

  it('is rejected when signed correctly but shaped wrongly', async () => {
    const k = await makeKeys();
    for (const bad of [{ app: 'yes' }, { cloudUntil: 'next year' }, { trialUntil: 12 }, { source: 'friend' }, { exp: 1.5 }, { sub: undefined }, { v: 2 }]) {
      expect(await readPass(await signPass({ ...passPayload(), ...bad } as never, k.signing), k.keys)).toBeNull();
    }
  });

  it('does not judge its own age: an old pass is still read, and the laptop decides what that means', async () => {
    const k = await makeKeys();
    const old = passPayload({}, Date.now() - 400 * 24 * 60 * 60 * 1000);
    expect((await readPass(await signPass(old, k.signing), k.keys))?.exp).toBe(old.exp);
  });

  it('picks the key named in its header, and still tries every key if the name is unknown', async () => {
    const [a, b] = [await makeKeys('k1'), await makeKeys('k2')];
    const both = [...a.keys, ...b.keys];
    expect(await readPass(await signPass(passPayload(), b.signing, 'k2'), both)).not.toBeNull();
    expect(await readPass(await signPass(passPayload(), a.signing, 'k1'), both)).not.toBeNull();
    expect(await readPass(await signPass(passPayload(), b.signing, 'renamed'), both)).not.toBeNull();
    // A key that is not in the list never works, whatever its header claims.
    const outsider = await makeKeys('k1');
    expect(await readPass(await signPass(passPayload(), outsider.signing, 'k1'), both)).toBeNull();
  });
});

describe('license keys', () => {
  it('takes the signing secret as the 32-byte key or as a whole PKCS#8 key', async () => {
    const k = await makeKeys();
    const token = await signPass(passPayload(), await importSigningKey(k.pkcs8));
    expect(await readPass(token, k.keys)).not.toBeNull();
    expect(unb64url(k.seed)).toHaveLength(32);
    // Whitespace around a pasted secret is harmless.
    expect(await readPass(await signPass(passPayload(), await importSigningKey(`  ${k.seed}\n`)), k.keys)).not.toBeNull();
  });

  it('refuses a key of the wrong size or alphabet', async () => {
    await expect(importSigningKey(b64url(new Uint8Array(31)))).rejects.toThrow(/32-byte/);
    await expect(importSigningKey('not base64!')).rejects.toThrow();
    await expect(importVerifyKey(b64url(new Uint8Array(33)))).rejects.toThrow(/32 bytes/);
  });
});

describe('unlock codes', () => {
  const GOOD = 'ENC-7K4Q-M2XP-9R8T';

  it('are read the way a KJ types them: case, spaces, dashes and the prefix do not matter', () => {
    for (const typed of [GOOD, 'enc-7k4q-m2xp-9r8t', 'ENC 7K4Q M2XP 9R8T', '  enc7k4qm2xp9r8t ', '7K4Q-M2XP-9R8T', '7k4qm2xp9r8t', 'ENC–7K4Q–M2XP–9R8T', 'ENC.7K4Q.M2XP.9R8T']) {
      expect(normalizeCode(typed)).toBe(GOOD);
    }
  });

  it('read O as 0 and I or L as 1, like Crockford’s base32 does', () => {
    expect(normalizeCode('ENC-0O0O-1I1L-ABCD')).toBe('ENC-0000-1111-ABCD');
    expect(normalizeCode('ENC-7K4Q-M2XP-9R8O')).toBe('ENC-7K4Q-M2XP-9R80');
  });

  it('still work when the code itself begins with ENC', () => {
    expect(normalizeCode('ENC-ENC1-ABCD-EFGH')).toBe('ENC-ENC1-ABCD-EFGH');
    expect(normalizeCode('ENC1-ABCD-EFGH')).toBe('ENC-ENC1-ABCD-EFGH');
  });

  it('are refused when they cannot be a code', () => {
    for (const bad of ['', '   ', 'ENC-7K4Q-M2XP', 'ENC-7K4Q-M2XP-9R8T-AAAA', 'ENC-7K4Q-M2XP-9R8U', 'ENC-7K4Q-M2XP-9R8!', 'hello', null, undefined, 12345, {}]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it('are stored as the SHA-256 of their proper form', async () => {
    const hash = await hashCode(GOOD);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(GOOD).digest('hex'));
    expect(await hashCode(normalizeCode('enc7k4qm2xp9r8t')!)).toBe(hash);
  });
});
