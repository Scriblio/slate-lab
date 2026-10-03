import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SongKeys } from '../src/server/songkeys.ts';
import { keyLabel } from '../src/shared/songkey.ts';

const T1 = 'aaaaaaaaaaaaaaaa';
const T2 = 'bbbbbbbbbbbbbbbb';
const C = { tonic: 0, mode: 'major' as const };
const G = { tonic: 7, mode: 'major' as const };
const Am = { tonic: 9, mode: 'minor' as const };

describe('SongKeys', () => {
  it('keeps the first detection, and lets the KJ overrule it', () => {
    const keys = new SongKeys();
    expect(keys.set(T1, Am, { detected: true })).toBe(true);
    expect(keys.get(T1)).toEqual(Am);
    expect(keys.set(T1, G, { detected: true })).toBe(false); // a second console's detection doesn't flip it
    expect(keys.set(T1, C, { detected: false })).toBe(true);
    expect(keys.get(T1)).toEqual({ ...C, confirmed: true });
    expect(keys.set(T1, Am, { detected: true })).toBe(false); // never over the KJ's word
    expect(keys.set(T1, C, { detected: false })).toBe(false); // nothing new
  });

  it('confirms a detection when the KJ says it’s right, and forgets on request', () => {
    const keys = new SongKeys();
    keys.set(T1, G, { detected: true });
    expect(keys.set(T1, G, { detected: false })).toBe(true);
    expect(keys.get(T1)).toEqual({ ...G, confirmed: true });
    expect(keys.set(T1, null, { detected: true })).toBe(false);
    expect(keys.set(T1, null, { detected: false })).toBe(true);
    expect(keys.get(T1)).toBeUndefined();
  });

  it('turns away keys that aren’t keys', () => {
    const keys = new SongKeys();
    expect(keys.set(T1, { tonic: 12, mode: 'major' }, { detected: false })).toBe(false);
    expect(keys.set(T1, { tonic: 2, mode: 'lydian' }, { detected: false })).toBe(false);
    expect(keys.set(T1, 'C', { detected: false })).toBe(false);
    expect(keys.pick([T1, T2])).toEqual({});
  });

  it('remembers keys across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encore-songkeys-'));
    try {
      const first = new SongKeys({ dataDir: dir });
      first.set(T1, Am, { detected: true });
      first.set(T2, G, { detected: false });
      await first.flush();
      const again = new SongKeys({ dataDir: dir });
      await again.load();
      expect(again.pick([T1, T2, 'cccccccccccccccc'])).toEqual({ [T1]: Am, [T2]: { ...G, confirmed: true } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('keyLabel', () => {
  it('names the key a request will be sung in', () => {
    expect(keyLabel(-5, { ...C, confirmed: true })).toBe('G (−5)');
    expect(keyLabel(-5, C)).toBe('≈G (−5)');
    expect(keyLabel(2, undefined)).toBe('+2');
    expect(keyLabel(0, Am)).toBe('≈Am');
    expect(keyLabel(0, undefined)).toBe('');
  });
});
