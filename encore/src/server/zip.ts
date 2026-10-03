// Minimal ZIP reader for zipped MP3+G tracks. Karaoke zips are small
// (a few MB) and hold one .mp3 and one .cdg, so we read the central
// directory and inflate single entries on demand. No ZIP64, no encryption.

import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export async function listZip(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 0xffff + 22);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cenSize = tail.readUInt32LE(eocd + 12);
    const cenOffset = tail.readUInt32LE(eocd + 16);
    const cen = Buffer.alloc(cenSize);
    await fh.read(cen, 0, cenSize, cenOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cen.length; i++) {
      if (cen.readUInt32LE(p) !== CEN_SIG) break;
      const flags = cen.readUInt16LE(p + 8);
      const nameLen = cen.readUInt16LE(p + 28);
      const extraLen = cen.readUInt16LE(p + 30);
      const commentLen = cen.readUInt16LE(p + 32);
      const nameBuf = cen.subarray(p + 46, p + 46 + nameLen);
      entries.push({
        name: nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1'),
        method: cen.readUInt16LE(p + 10),
        compressedSize: cen.readUInt32LE(p + 20),
        size: cen.readUInt32LE(p + 24),
        localHeaderOffset: cen.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

export async function readZipEntry(path: string, entry: ZipEntry): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const loc = Buffer.alloc(30);
    await fh.read(loc, 0, 30, entry.localHeaderOffset);
    if (loc.readUInt32LE(0) !== LOC_SIG) throw new Error('bad zip local header');
    const start = entry.localHeaderOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
    const raw = Buffer.alloc(entry.compressedSize);
    await fh.read(raw, 0, entry.compressedSize, start);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${entry.method}`);
  } finally {
    await fh.close();
  }
}

/** Find the first entry whose name ends with one of the extensions. */
export function findEntry(entries: ZipEntry[], exts: string[]): ZipEntry | undefined {
  return entries.find((e) => {
    const n = e.name.toLowerCase();
    return !n.startsWith('__macosx/') && exts.some((x) => n.endsWith(x));
  });
}
