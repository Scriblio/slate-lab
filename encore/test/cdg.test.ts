import { describe, expect, it } from 'vitest';
import {
  CDG_HEIGHT,
  CDG_WIDTH,
  CdgDecoder,
  cdgBorderPreset,
  cdgColors,
  cdgEmpty,
  cdgMemoryPreset,
  cdgScroll,
  cdgTile,
} from '../src/client/cdg/decoder.ts';

function stream(...packets: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(packets.length * 24);
  packets.forEach((p, i) => out.set(p, i * 24));
  return out;
}

const px = (d: CdgDecoder, x: number, y: number) => d.pixels[y * CDG_WIDTH + x];
const CHECKER = [0b101010, 0b010101, 0b101010, 0b010101, 0b101010, 0b010101, 0b101010, 0b010101, 0b101010, 0b010101, 0b101010, 0b010101];

describe('CdgDecoder', () => {
  it('decodes the colour table (4 bits per channel)', () => {
    const colors: [number, number, number][] = [
      [15, 0, 0],
      [0, 15, 0],
      [0, 0, 15],
      [15, 15, 15],
      [1, 2, 3],
      [8, 9, 10],
      [0, 0, 0],
      [7, 7, 7],
    ];
    const d = new CdgDecoder(stream(cdgColors(false, colors), cdgColors(true, colors)));
    d.seekTo(1);
    expect(d.palette[0]).toBe(0xff0000);
    expect(d.palette[1]).toBe(0x00ff00);
    expect(d.palette[2]).toBe(0x0000ff);
    expect(d.palette[4]).toBe((17 << 16) | (34 << 8) | 51);
    expect(d.palette[13]).toBe((136 << 16) | (153 << 8) | 170);
  });

  it('fills memory, draws tiles and XORs them', () => {
    const d = new CdgDecoder(stream(cdgMemoryPreset(3), cdgTile(2, 4, 1, 7, CHECKER), cdgTile(2, 4, 0, 2, CHECKER, true)));
    d.seekTo(1 / 300);
    expect(px(d, 0, 0)).toBe(3);
    d.seekTo(2 / 300);
    // Tile at column 4 (x 24..29), row 2 (y 24..35); bit set => colour 1.
    expect(px(d, 24, 24)).toBe(7);
    expect(px(d, 25, 24)).toBe(1);
    expect(px(d, 24, 25)).toBe(1);
    expect(px(d, 23, 24)).toBe(3);
    d.seekTo(3 / 300);
    expect(px(d, 24, 24)).toBe(7 ^ 2);
    expect(px(d, 25, 24)).toBe(1 ^ 0);
  });

  it('rewinds when seeking backwards', () => {
    const d = new CdgDecoder(stream(cdgMemoryPreset(1), cdgEmpty(), cdgMemoryPreset(5)));
    d.seekTo(1);
    expect(px(d, 10, 10)).toBe(5);
    d.seekTo(1 / 300);
    expect(px(d, 10, 10)).toBe(1);
    expect(d.position).toBe(1);
  });

  it('scroll preset fills the vacated strip; scroll copy wraps it', () => {
    const tile = cdgTile(0, 0, 9, 9, new Array(12).fill(0));
    const preset = new CdgDecoder(stream(cdgMemoryPreset(0), tile, cdgScroll(false, 4, 1, 0)));
    preset.seekTo(1);
    // Scrolled right one tile: the tile now sits at x 6..11 and x 0..5 is filled.
    expect(px(preset, 7, 0)).toBe(9);
    expect(px(preset, 0, 0)).toBe(4);

    const copy = new CdgDecoder(stream(cdgMemoryPreset(0), cdgTile(0, 49, 9, 9, new Array(12).fill(0)), cdgScroll(true, 4, 1, 0)));
    copy.seekTo(1);
    // The rightmost tile wraps around to the left edge.
    expect(px(copy, 0, 0)).toBe(9);
  });

  it('renders the border colour around the picture', () => {
    const d = new CdgDecoder(
      stream(cdgColors(false, [[0, 0, 0], [15, 0, 0], [0, 15, 0]]), cdgMemoryPreset(2), cdgBorderPreset(1)),
    );
    d.seekTo(1);
    const rgba = new Uint8ClampedArray(CDG_WIDTH * CDG_HEIGHT * 4);
    d.renderTo(rgba);
    expect([...rgba.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    const mid = ((CDG_HEIGHT / 2) * CDG_WIDTH + CDG_WIDTH / 2) * 4;
    expect([...rgba.slice(mid, mid + 4)]).toEqual([0, 255, 0, 255]);
    expect(d.dirty).toBe(false);
  });

  it('ignores non-CDG subcode packets', () => {
    const junk = cdgMemoryPreset(7);
    junk[0] = 0x08;
    const d = new CdgDecoder(stream(cdgMemoryPreset(1), junk));
    d.seekTo(1);
    expect(px(d, 0, 0)).toBe(1);
  });
});
