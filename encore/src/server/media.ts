// Serves library media to the display: video files, MP3+G audio and
// graphics, and the parts of zipped MP3+G tracks. Supports HTTP range
// requests so the browser can seek.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { Library } from './library.ts';
import { findEntry, listZip, readZipEntry } from './zip.ts';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.cdg': 'application/octet-stream',
};

const AUDIO_EXTS = ['.mp3', '.m4a', '.ogg', '.wav', '.flac'];

/** Small LRU of unzipped tracks: the current song and the next few. */
const zipCache = new Map<string, { audio: Buffer; audioType: string; cdg?: Buffer }>();

async function unzipTrack(id: string, path: string) {
  const hit = zipCache.get(id);
  if (hit) {
    zipCache.delete(id);
    zipCache.set(id, hit);
    return hit;
  }
  const entries = await listZip(path);
  const audioEntry = findEntry(entries, AUDIO_EXTS);
  if (!audioEntry) throw new Error('No audio file inside this zip.');
  const cdgEntry = findEntry(entries, ['.cdg']);
  const value = {
    audio: await readZipEntry(path, audioEntry),
    audioType: TYPES[extname(audioEntry.name).toLowerCase()] ?? 'audio/mpeg',
    cdg: cdgEntry ? await readZipEntry(path, cdgEntry) : undefined,
  };
  zipCache.set(id, value);
  while (zipCache.size > 4) zipCache.delete(zipCache.keys().next().value!);
  return value;
}

export async function serveMedia(
  library: Library,
  id: string,
  part: 'main' | 'cdg',
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const track = library.get(id);
  if (!track) return notFound(res);
  try {
    if (track.format === 'zip') {
      const z = await unzipTrack(id, track.path);
      if (part === 'cdg') return z.cdg ? sendBuffer(req, res, z.cdg, 'application/octet-stream') : notFound(res);
      return sendBuffer(req, res, z.audio, z.audioType);
    }
    const path = part === 'cdg' ? track.companion : track.path;
    if (!path) return notFound(res);
    await sendFile(req, res, path);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end((err as Error).message);
    } else {
      res.destroy();
    }
  }
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!suffix) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

async function sendFile(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const { size } = await stat(path);
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    res.end();
    return;
  }
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (range) {
    res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(path, range).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(path).pipe(res);
  }
}

function sendBuffer(req: IncomingMessage, res: ServerResponse, buf: Buffer, type: string): void {
  const range = parseRange(req.headers.range, buf.length);
  if (range === 'invalid') {
    res.writeHead(416, { 'content-range': `bytes */${buf.length}` });
    res.end();
    return;
  }
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' };
  if (range) {
    res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${buf.length}`, 'content-length': range.end - range.start + 1 });
    res.end(req.method === 'HEAD' ? undefined : buf.subarray(range.start, range.end + 1));
  } else {
    res.writeHead(200, { ...headers, 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}
