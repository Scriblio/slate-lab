// The keys that sign and check license passes: the one built into the app, and the
// script that makes them (which handles a secret, so it's tested for what it must not do).

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importPassKeys, importSigningKey, readPass, signPass, unb64url } from '../supabase/functions/encore-license/pass.ts';
import { LICENSE_PUBLIC_KEYS } from '../src/shared/license-key.ts';
import { passPayload } from './licensekit.ts';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'make-license-key.mjs');

describe('the public keys built into the app', () => {
  it('are real keys, so a build can never ship with a placeholder', async () => {
    expect(LICENSE_PUBLIC_KEYS.length).toBeGreaterThan(0);
    expect(new Set(LICENSE_PUBLIC_KEYS.map((k) => k.kid)).size).toBe(LICENSE_PUBLIC_KEYS.length);
    for (const { kid, key } of LICENSE_PUBLIC_KEYS) {
      expect(kid).toMatch(/^k\d+$/);
      expect(key, kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(unb64url(key), kid).toHaveLength(32);
    }
    await expect(importPassKeys(LICENSE_PUBLIC_KEYS)).resolves.toHaveLength(LICENSE_PUBLIC_KEYS.length);
  });

  it('are not the key the tests sign with', async () => {
    // A pass made by a test key is not one the app would take.
    const stranger = await globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const token = await signPass(passPayload({ owner: true, app: true }), (stranger as CryptoKeyPair).privateKey);
    expect(await readPass(token, await importPassKeys(LICENSE_PUBLIC_KEYS))).toBeNull();
  });
});

describe('the key-making script', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'encore-keys-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    execFileSync(process.execPath, [SCRIPT, '--out', join(dir, 'private.txt'), '--key-file', join(dir, 'license-key.ts'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  /** The keys the script wrote, read out of the file's text. */
  const publicKeys = async () => {
    const text = await readFile(join(dir, 'license-key.ts'), 'utf8');
    return { LICENSE_PUBLIC_KEYS: [...text.matchAll(/\{ kid: '([^']+)', key: '([^']+)' \}/g)].map((m) => ({ kid: m[1]!, key: m[2]! })) };
  };

  it('makes a pair that works together, and never shows the private key', async () => {
    const out = run();
    const secret = (await readFile(join(dir, 'private.txt'), 'utf8')).trim();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The screen gets the public key and where the private one went, never the private key itself.
    expect(out).not.toContain(secret);
    expect(out).toContain(join(dir, 'private.txt'));
    const { LICENSE_PUBLIC_KEYS: made } = await publicKeys();
    expect(made).toHaveLength(1);
    expect(made[0]!.kid).toBe('k1');
    expect(out).toContain(made[0]!.key);
    // What it signs with the private key, the public key checks.
    const token = await signPass(passPayload({ owner: true, app: true }), await importSigningKey(secret), 'k1');
    expect(await readPass(token, await importPassKeys(made))).not.toBeNull();
    if (process.platform !== 'win32') expect((await stat(join(dir, 'private.txt'))).mode & 0o077).toBe(0);
  });

  it('refuses to overwrite a private key that is already there', async () => {
    await writeFile(join(dir, 'private.txt'), 'precious');
    expect(() => run()).toThrow(/already exists/);
    expect(await readFile(join(dir, 'private.txt'), 'utf8')).toBe('precious');
    await expect(readFile(join(dir, 'license-key.ts'), 'utf8')).rejects.toThrow();
  });

  it('adds a second key, keeping the first so copies already installed keep working', async () => {
    run();
    const first = (await publicKeys()).LICENSE_PUBLIC_KEYS[0]!;
    await rm(join(dir, 'private.txt'));
    const out = run('--add');
    const { LICENSE_PUBLIC_KEYS: both } = await publicKeys();
    expect(both.map((k) => k.kid)).toEqual(['k1', 'k2']);
    expect(both[0]).toEqual(first);
    expect(out).toMatch(/LICENSE_KEY_ID to k2/);
    // Both keys' passes are accepted.
    const secret = (await readFile(join(dir, 'private.txt'), 'utf8')).trim();
    expect(await readPass(await signPass(passPayload(), await importSigningKey(secret), 'k2'), await importPassKeys(both))).not.toBeNull();
  });

  it('replaces the key without --add', async () => {
    run();
    const first = (await publicKeys()).LICENSE_PUBLIC_KEYS[0]!.key;
    await rm(join(dir, 'private.txt'));
    run();
    const now = (await publicKeys()).LICENSE_PUBLIC_KEYS;
    expect(now).toHaveLength(1);
    expect(now[0]!.key).not.toBe(first);
  });
});
