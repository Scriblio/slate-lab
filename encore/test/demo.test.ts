import { describe, expect, it } from 'vitest';
import { CDG_HEIGHT, CDG_WIDTH, CdgDecoder } from '../src/client/cdg/decoder.ts';
import { makeDemoCdg, makeDemoWav } from '../src/server/demo.ts';

function colours(d: CdgDecoder): Set<number> {
  const rgba = new Uint8ClampedArray(CDG_WIDTH * CDG_HEIGHT * 4);
  d.renderTo(rgba);
  const seen = new Set<number>();
  for (let i = 0; i < rgba.length; i += 4) seen.add((rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!);
  return seen;
}

describe('demo track', () => {
  it('draws a title card, then lyrics that light up as they are sung', () => {
    const d = new CdgDecoder(makeDemoCdg());
    expect(d.durationSec).toBe(40);
    d.seekTo(2);
    expect(colours(d).has(0x44eeee)).toBe(true); // cyan title
    d.seekTo(5);
    expect(colours(d).has(0xff4499)).toBe(false); // lyrics up, nothing sung yet
    expect(colours(d).has(0xffffff)).toBe(true);
    d.seekTo(8);
    expect(colours(d).has(0xff4499)).toBe(true); // first line partly highlighted
  });

  it('writes a valid 40 second WAV', () => {
    const wav = makeDemoWav();
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect(wav.readUInt32LE(40) / (22050 * 2)).toBe(40);
  });
});
