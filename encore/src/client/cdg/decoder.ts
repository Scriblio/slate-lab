// CD+G (CD+Graphics) decoder: the lyric graphics in MP3+G karaoke files.
//
// A .cdg file is a stream of 24-byte subcode packets, 300 per second of
// audio. The decoder keeps a 300x216 indexed-colour framebuffer (16 colours
// from a 4096-colour palette) and applies packets up to a given time; the
// player renders the buffer to a canvas. Format reference: the CD+G section
// of the Red Book subcode spec, as documented by Jim Bumgardner's notes.

export const CDG_WIDTH = 300;
export const CDG_HEIGHT = 216;
export const PACKETS_PER_SECOND = 300;
const PACKET_SIZE = 24;
const TILE_W = 6;
const TILE_H = 12;
const CDG_COMMAND = 0x09;

const Instr = {
  MemoryPreset: 1,
  BorderPreset: 2,
  TileBlock: 6,
  ScrollPreset: 20,
  ScrollCopy: 24,
  DefineTransparent: 28,
  LoadColorsLow: 30,
  LoadColorsHigh: 31,
  TileBlockXor: 38,
} as const;

export class CdgDecoder {
  readonly pixels = new Uint8Array(CDG_WIDTH * CDG_HEIGHT);
  /** Palette as packed 0xRRGGBB. */
  readonly palette = new Uint32Array(16);
  borderColor = 0;
  hOffset = 0;
  vOffset = 0;
  /** Index of the next packet to apply. */
  position = 0;
  /** Set whenever the picture changes; the renderer clears it. */
  dirty = true;

  private readonly data: Uint8Array;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  get packetCount(): number {
    return Math.floor(this.data.length / PACKET_SIZE);
  }

  get durationSec(): number {
    return this.packetCount / PACKETS_PER_SECOND;
  }

  reset(): void {
    this.pixels.fill(0);
    this.palette.fill(0);
    this.borderColor = 0;
    this.hOffset = 0;
    this.vOffset = 0;
    this.position = 0;
    this.dirty = true;
  }

  /** Bring the picture to the given playback time, rewinding if needed. */
  seekTo(seconds: number): void {
    const target = Math.min(this.packetCount, Math.max(0, Math.floor(seconds * PACKETS_PER_SECOND)));
    if (target < this.position) this.reset();
    while (this.position < target) this.apply(this.position++);
  }

  private apply(index: number): void {
    const o = index * PACKET_SIZE;
    const d = this.data;
    if ((d[o]! & 0x3f) !== CDG_COMMAND) return;
    const instr = d[o + 1]! & 0x3f;
    const b = (i: number) => d[o + 4 + i]! & 0x3f;
    switch (instr) {
      case Instr.MemoryPreset:
        this.pixels.fill(b(0) & 0x0f);
        this.dirty = true;
        break;
      case Instr.BorderPreset:
        this.borderColor = b(0) & 0x0f;
        this.dirty = true;
        break;
      case Instr.TileBlock:
      case Instr.TileBlockXor:
        this.tile(b, instr === Instr.TileBlockXor);
        break;
      case Instr.ScrollPreset:
      case Instr.ScrollCopy:
        this.scroll(b, instr === Instr.ScrollCopy);
        break;
      case Instr.LoadColorsLow:
      case Instr.LoadColorsHigh: {
        const base = instr === Instr.LoadColorsLow ? 0 : 8;
        for (let i = 0; i < 8; i++) {
          const hi = b(i * 2);
          const lo = b(i * 2 + 1);
          const r = (hi >> 2) & 0x0f;
          const g = ((hi & 0x03) << 2) | ((lo >> 4) & 0x03);
          const bl = lo & 0x0f;
          this.palette[base + i] = ((r * 17) << 16) | ((g * 17) << 8) | (bl * 17);
        }
        this.dirty = true;
        break;
      }
      case Instr.DefineTransparent:
      default:
        break;
    }
  }

  private tile(b: (i: number) => number, xor: boolean): void {
    const color0 = b(0) & 0x0f;
    const color1 = b(1) & 0x0f;
    const row = b(2) & 0x1f;
    const col = b(3) & 0x3f;
    const x0 = col * TILE_W;
    const y0 = row * TILE_H;
    if (x0 + TILE_W > CDG_WIDTH || y0 + TILE_H > CDG_HEIGHT) return;
    for (let y = 0; y < TILE_H; y++) {
      const bits = b(4 + y);
      const rowStart = (y0 + y) * CDG_WIDTH + x0;
      for (let x = 0; x < TILE_W; x++) {
        const c = (bits >> (5 - x)) & 1 ? color1 : color0;
        const p = rowStart + x;
        this.pixels[p] = xor ? this.pixels[p]! ^ c : c;
      }
    }
    this.dirty = true;
  }

  private scroll(b: (i: number) => number, copy: boolean): void {
    const fill = b(0) & 0x0f;
    const h = b(1);
    const v = b(2);
    const hCmd = (h & 0x30) >> 4;
    const vCmd = (v & 0x30) >> 4;
    this.hOffset = Math.min(h & 0x07, TILE_W - 1);
    this.vOffset = Math.min(v & 0x0f, TILE_H - 1);
    // 1 = right/down by one tile, 2 = left/up by one tile.
    const dx = hCmd === 1 ? TILE_W : hCmd === 2 ? -TILE_W : 0;
    const dy = vCmd === 1 ? TILE_H : vCmd === 2 ? -TILE_H : 0;
    if (dx || dy) {
      const src = this.pixels.slice();
      for (let y = 0; y < CDG_HEIGHT; y++) {
        for (let x = 0; x < CDG_WIDTH; x++) {
          let sx = x - dx;
          let sy = y - dy;
          const outside = sx < 0 || sx >= CDG_WIDTH || sy < 0 || sy >= CDG_HEIGHT;
          if (outside && !copy) {
            this.pixels[y * CDG_WIDTH + x] = fill;
            continue;
          }
          sx = (sx + CDG_WIDTH) % CDG_WIDTH;
          sy = (sy + CDG_HEIGHT) % CDG_HEIGHT;
          this.pixels[y * CDG_WIDTH + x] = src[sy * CDG_WIDTH + sx]!;
        }
      }
    }
    this.dirty = true;
  }

  /**
   * Write the visible picture into an RGBA buffer (CDG_WIDTH x CDG_HEIGHT).
   * The outer 6px / 12px frame shows the border colour; the inside is the
   * framebuffer shifted by the current scroll offsets.
   */
  renderTo(rgba: Uint8ClampedArray): void {
    const border = this.palette[this.borderColor]!;
    for (let y = 0; y < CDG_HEIGHT; y++) {
      for (let x = 0; x < CDG_WIDTH; x++) {
        const inBorder = x < TILE_W || x >= CDG_WIDTH - TILE_W || y < TILE_H || y >= CDG_HEIGHT - TILE_H;
        let c = border;
        if (!inBorder) {
          const sx = Math.min(CDG_WIDTH - 1, x + this.hOffset);
          const sy = Math.min(CDG_HEIGHT - 1, y + this.vOffset);
          c = this.palette[this.pixels[sy * CDG_WIDTH + sx]!]!;
        }
        const o = (y * CDG_WIDTH + x) * 4;
        rgba[o] = (c >> 16) & 0xff;
        rgba[o + 1] = (c >> 8) & 0xff;
        rgba[o + 2] = c & 0xff;
        rgba[o + 3] = 255;
      }
    }
    this.dirty = false;
  }
}

// --- encoding helpers (used by tests and the demo track) -------------------

export function cdgPacket(instr: number, data: number[]): Uint8Array {
  const p = new Uint8Array(PACKET_SIZE);
  p[0] = CDG_COMMAND;
  p[1] = instr;
  data.slice(0, 16).forEach((v, i) => (p[4 + i] = v & 0x3f));
  return p;
}

/** Load 8 colours (0-7 or 8-15) given as [r, g, b] with 0-15 components. */
export function cdgColors(high: boolean, colors: [number, number, number][]): Uint8Array {
  const data: number[] = [];
  for (let i = 0; i < 8; i++) {
    const [r, g, b] = colors[i] ?? [0, 0, 0];
    data.push(((r & 0x0f) << 2) | ((g >> 2) & 0x03), ((g & 0x03) << 4) | (b & 0x0f));
  }
  return cdgPacket(high ? Instr.LoadColorsHigh : Instr.LoadColorsLow, data);
}

export function cdgMemoryPreset(color: number): Uint8Array {
  return cdgPacket(Instr.MemoryPreset, [color, 0]);
}

export function cdgBorderPreset(color: number): Uint8Array {
  return cdgPacket(Instr.BorderPreset, [color]);
}

/** One 6x12 tile; `rows` are 12 six-bit masks, MSB = leftmost pixel. */
export function cdgTile(row: number, col: number, color0: number, color1: number, rows: number[], xor = false): Uint8Array {
  return cdgPacket(xor ? Instr.TileBlockXor : Instr.TileBlock, [color0, color1, row, col, ...rows]);
}

export function cdgScroll(copy: boolean, fill: number, hCmd: number, vCmd: number, hOff = 0, vOff = 0): Uint8Array {
  return cdgPacket(copy ? Instr.ScrollCopy : Instr.ScrollPreset, [fill, (hCmd << 4) | hOff, (vCmd << 4) | vOff]);
}

export function cdgEmpty(): Uint8Array {
  return new Uint8Array(PACKET_SIZE);
}
