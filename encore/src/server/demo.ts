// A tiny demo library so Encore can be tried without a karaoke collection:
// an original MP3+G-style track (WAV + CD+G lyrics), the same track zipped,
// and, when ffmpeg is installed, a short video. Everything is generated.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import { cdgBorderPreset, cdgColors, cdgMemoryPreset, cdgTile, PACKETS_PER_SECOND } from '../client/cdg/decoder.ts';

const TITLE = 'Encore Band - Step Up (Demo)';
const SECONDS = 40;

// 5x7 glyphs, one string of 35 bits per character (rows top to bottom).
const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001',
  B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111',
  F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111',
  H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001',
  L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001',
  N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101',
  R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110',
  T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010',
  X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100',
  Z: '11111000010001000100010001000011111',
  '!': '00100001000010000100001000000000100',
  "'": '00100001000100000000000000000000000',
  ',': '00000000000000000000001100010001000',
  '.': '00000000000000000000000000110001100',
  '-': '00000000000000011111000000000000000',
  ' ': '0'.repeat(35),
};

const BG = 0;
const WHITE = 1;
const PINK = 2;
const CYAN = 3;

interface Line {
  text: string;
  at: number;
  /** When the highlight wipe starts and ends. */
  sing?: [number, number];
  color?: number;
}

const PAGES: { at: number; lines: Line[] }[] = [
  {
    at: 0,
    lines: [
      { text: 'ENCORE', at: 0.2, color: CYAN },
      { text: 'STEP UP', at: 0.6, color: WHITE },
      { text: 'DEMO TRACK', at: 1.0, color: WHITE },
    ],
  },
  {
    at: 4,
    lines: [
      { text: 'STEP UP TO THE MIC', at: 4.1, sing: [6, 9.5] },
      { text: 'THE LIGHTS ARE ON', at: 4.3, sing: [10, 13.5] },
      { text: 'THE ROOM IS YOURS', at: 4.5, sing: [14, 17.5] },
      { text: 'SO SING IT LOUD!', at: 4.7, sing: [18, 21.5] },
    ],
  },
  {
    at: 22,
    lines: [
      { text: 'EVERY VOICE TONIGHT', at: 22.1, sing: [23, 26.5] },
      { text: 'GETS ONE MORE TURN', at: 22.3, sing: [27, 30.5] },
      { text: "WHEN THE MUSIC'S DONE", at: 22.5, sing: [31, 34.5] },
      { text: 'WE CHEER FOR YOU', at: 22.7, sing: [35, 37.5] },
    ],
  },
  {
    at: 38,
    lines: [{ text: 'THANK YOU!', at: 38.2, color: CYAN }],
  },
];

/** The four 6x12 tiles that draw one 2x-scaled character in a 12x24 cell. */
function charTiles(ch: string): number[][] {
  const bits = FONT[ch] ?? FONT[' ']!;
  const on = (x: number, y: number) => {
    const gx = Math.floor((x - 1) / 2);
    const gy = Math.floor((y - 5) / 2);
    return gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && bits[gy * 5 + gx] === '1';
  };
  const tiles: number[][] = [];
  for (let ty = 0; ty < 2; ty++)
    for (let tx = 0; tx < 2; tx++) {
      const rows: number[] = [];
      for (let y = 0; y < 12; y++) {
        let mask = 0;
        for (let x = 0; x < 6; x++) if (on(tx * 6 + x, ty * 12 + y)) mask |= 1 << (5 - x);
        rows.push(mask);
      }
      tiles.push(rows);
    }
  return tiles;
}

function drawChar(packets: Uint8Array[], cellRow: number, cellCol: number, ch: string, color: number): void {
  const tiles = charTiles(ch);
  for (let i = 0; i < 4; i++) {
    const row = 1 + cellRow * 2 + Math.floor(i / 2);
    const col = 1 + cellCol * 2 + (i % 2);
    packets.push(cdgTile(row, col, BG, color, tiles[i]!));
  }
}

export function makeDemoCdg(): Uint8Array {
  const total = SECONDS * PACKETS_PER_SECOND;
  const slots: (Uint8Array | undefined)[] = new Array(total);
  // Place a burst of packets as close after `t` as free slots allow.
  const at = (t: number, packets: Uint8Array[]) => {
    let i = Math.floor(t * PACKETS_PER_SECOND);
    for (const p of packets) {
      while (i < total && slots[i]) i++;
      if (i < total) slots[i++] = p;
    }
  };
  at(0, [
    cdgColors(false, [
      [1, 1, 3],
      [15, 15, 15],
      [15, 4, 9],
      [4, 14, 14],
      [3, 1, 6],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]),
    cdgBorderPreset(4),
  ]);
  for (const page of PAGES) {
    at(page.at, [cdgMemoryPreset(BG)]);
    const rowStep = page.lines.length > 3 ? 2 : 2;
    const firstRow = Math.max(0, Math.floor((8 - (page.lines.length - 1) * rowStep - 1) / 2));
    page.lines.forEach((line, li) => {
      const cellRow = firstRow + li * rowStep;
      const startCol = Math.floor((24 - line.text.length) / 2);
      const draw: Uint8Array[] = [];
      [...line.text].forEach((ch, ci) => drawChar(draw, cellRow, startCol + ci, ch, line.color ?? WHITE));
      at(line.at, draw);
      if (line.sing) {
        const [from, to] = line.sing;
        const chars = [...line.text];
        chars.forEach((ch, ci) => {
          if (ch === ' ') return;
          const wipe: Uint8Array[] = [];
          drawChar(wipe, cellRow, startCol + ci, ch, PINK);
          at(from + ((to - from) * ci) / chars.length, wipe);
        });
      }
    });
  }
  const out = new Uint8Array(total * 24);
  slots.forEach((p, i) => p && out.set(p, i * 24));
  return out;
}

/** An original little backing track: C - G - Am - F, with a guide melody. */
export function makeDemoWav(): Buffer {
  const rate = 22050;
  const n = SECONDS * rate;
  const pcm = new Float32Array(n);
  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const chords = [
    [48, 60, 64, 67],
    [43, 59, 62, 67],
    [45, 60, 64, 69],
    [41, 60, 65, 69],
  ];
  const melody = [67, 69, 67, 64, 62, 64, 67, 72, 71, 67, 69, 67, 65, 64, 62, 60];
  const beat = 0.5;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const bar = Math.floor(t / 2);
    const chord = chords[bar % 4]!;
    const fadeIn = Math.min(1, t / 1.5);
    const fadeOut = Math.min(1, (SECONDS - t) / 2.5);
    const env = fadeIn * fadeOut;
    let s = 0;
    // pad
    for (const m of chord.slice(1)) s += 0.06 * Math.sin(2 * Math.PI * hz(m) * t);
    // bass on the beat
    const beatPos = (t % beat) / beat;
    s += 0.16 * Math.sin(2 * Math.PI * hz(chord[0]!) * t) * Math.exp(-beatPos * 3);
    // guide melody while lyrics are on screen
    if (t > 6 && t < 37.5) {
      const note = melody[Math.floor(t / beat) % melody.length]!;
      s += 0.09 * Math.sin(2 * Math.PI * hz(note) * t) * Math.exp(-beatPos * 2.2);
    }
    // soft hat on off-beats
    if (beatPos > 0.5 && beatPos < 0.53) s += (Math.random() - 0.5) * 0.08;
    pcm[i] = s * env;
  }
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.max(-1, Math.min(1, pcm[i]!)) * 32767, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** A minimal zip writer (deflate), enough to package an MP3+G pair. */
export function zip(files: Record<string, Uint8Array>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const data = Buffer.from(raw);
    const body = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x800, 6);
    loc.writeUInt16LE(8, 8);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(body.length, 18);
    loc.writeUInt32LE(data.length, 22);
    loc.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    locals.push(loc, nameBuf, body);
    central.push(cen, nameBuf);
    offset += loc.length + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, end]);
}

export async function makeDemoLibrary(dir: string, opts: { video?: boolean } = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  const cdg = makeDemoCdg();
  const wav = makeDemoWav();
  const base = join(dir, `ENC001-01 - ${TITLE}`);
  if (!existsSync(`${base}.cdg`)) {
    await writeFile(`${base}.wav`, wav);
    await writeFile(`${base}.cdg`, cdg);
  }
  const zipped = join(dir, 'ENC001-02 - Encore Band - Step Up (Zipped Demo).zip');
  if (!existsSync(zipped)) await writeFile(zipped, zip({ 'Step Up.wav': wav, 'Step Up.cdg': cdg }));
  const video = join(dir, 'ENC001-03 - Encore Band - Test Pattern (Video Demo).webm');
  if ((opts.video ?? true) && !existsSync(video)) await makeVideo(video).catch(() => {});
  return dir;
}

function makeVideo(out: string): Promise<void> {
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=854x480:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=48000',
    '-t',
    '20',
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '600k',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-c:a',
    'libopus',
    '-shortest',
    '-f',
    'webm',
    `${out}.part`,
  ];
  // Encode to a temp name so an interrupted run doesn't leave a broken file.
  return new Promise((resolve, reject) =>
    execFile('ffmpeg', args, { timeout: 120_000 }, (err) => (err ? reject(err) : rename(`${out}.part`, out).then(resolve, reject))),
  );
}
