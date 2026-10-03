// HTTP + Socket.IO server: serves the three web apps, library media and QR
// codes, and keeps every connected screen in sync with the show.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import QRCode from 'qrcode';
import sirv from 'sirv';
import { Server, type Socket } from 'socket.io';
import type { Ack, ClientToServer, DjAction, HandshakeAuth, Role, ServerToClient } from '../shared/protocol.ts';
import { parseYouTubeId } from '../shared/text.ts';
import type { DjView, SearchResult } from '../shared/types.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { Library } from './library.ts';
import { serveMedia } from './media.ts';
import { Show, UserError } from './show.ts';
import { YouTube } from './youtube.ts';

export interface AppOptions {
  port: number;
  host?: string;
  dataDir: string;
  dev?: boolean;
  /** Built client files (production). */
  distDir?: string;
  fetchImpl?: typeof fetch;
  /** Treat loopback connections as the KJ (default true). */
  trustLocal?: boolean;
  /** Folders scanned in addition to the configured ones (the demo library). */
  extraLibraryFolders?: string[];
  quiet?: boolean;
}

interface SocketData {
  role: Role;
  singerId?: string;
  connectedAt: number;
}

type IoSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

const ROOT = resolve(import.meta.dirname, '../..');

export async function createApp(opts: AppOptions) {
  await mkdir(opts.dataDir, { recursive: true });
  const config = await loadConfig(opts.dataDir);
  const library = new Library(config.filenameOrder);
  const youtube = new YouTube(config.youtubeApiKey, opts.fetchImpl);
  const mediaKey = randomBytes(12).toString('base64url');
  const trustLocal = opts.trustLocal ?? true;
  const log = opts.quiet ? () => {} : console.log;

  let io: Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
  let broadcastQueued = false;
  const scheduleBroadcast = () => {
    if (broadcastQueued) return;
    broadcastQueued = true;
    setImmediate(() => {
      broadcastQueued = false;
      broadcast();
    });
  };

  const show = new Show({
    dataDir: opts.dataDir,
    resolveLocal: (id) => {
      const t = library.get(id);
      return t ? { title: t.title, artist: t.artist, source: { kind: 'local', trackId: t.id, format: t.format } } : undefined;
    },
    onChange: scheduleBroadcast,
    onPlayerCommand: (playId, cmd) => io?.to('display').emit('player:cmd', { playId, ...cmd }),
  });
  await show.load();

  // --- URLs ------------------------------------------------------------------

  let port = opts.port;
  const baseUrl = () => (config.publicUrl ? config.publicUrl.replace(/\/$/, '') : `http://${lanAddress()}:${port}`);
  const joinUrl = () => `${baseUrl()}/join`;

  // --- HTTP ------------------------------------------------------------------

  const vite = opts.dev
    ? await (await import('vite')).createServer({
        configFile: join(ROOT, 'vite.config.ts'),
        server: { middlewareMode: true },
        appType: 'mpa',
      })
    : undefined;
  const distDir = opts.distDir ?? join(ROOT, 'dist');
  const assets = vite || !existsSync(distDir) ? undefined : sirv(distDir, { etag: true, gzip: true });

  const PAGES: Record<string, string> = { '/dj': 'dj.html', '/display': 'display.html', '/join': 'join.html' };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;

    if (path === '/') {
      res.writeHead(302, { location: isLocalRequest(req) && trustLocal ? '/dj' : '/join' });
      return void res.end();
    }

    if (path === '/api/qr.svg') {
      const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return void res.end(svg);
    }

    if (path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ ok: true }));
    }

    const media = path.match(/^\/media\/([a-f0-9]{16})\/(main|cdg)$/);
    if (media) {
      if (url.searchParams.get('k') !== mediaKey) {
        res.writeHead(403);
        return void res.end();
      }
      return serveMedia(library, media[1]!, media[2] as 'main' | 'cdg', req, res);
    }

    const page = PAGES[path.replace(/\/$/, '')];
    if (vite) {
      if (page) req.url = `/${page}${url.search}`;
      vite.middlewares(req, res, () => notFound(res));
      return;
    }
    if (page) {
      try {
        const html = await readFile(join(distDir, page));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return void res.end(html);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return void res.end('The web app has not been built yet. Run `npm run build` (or use `npm run dev`).');
      }
    }
    if (assets) assets(req, res, () => notFound(res));
    else notFound(res);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // --- sockets ---------------------------------------------------------------

  io = new Server(server, { serveClient: false, maxHttpBufferSize: 64 * 1024, pingInterval: 10_000, pingTimeout: 8_000 });
  const pinFailures = new Map<string, { count: number; until: number }>();

  io.use((socket, next) => {
    const auth = (socket.handshake.auth ?? {}) as HandshakeAuth;
    const role: Role = auth.role === 'dj' || auth.role === 'display' ? auth.role : 'singer';
    socket.data.role = role;
    socket.data.connectedAt = Date.now();
    if (role === 'singer') return next();
    const ip = socket.handshake.address;
    if (trustLocal && isLocalHandshake(socket)) return next();
    const fail = pinFailures.get(ip);
    if (fail && fail.until > Date.now()) return next(new Error('Too many wrong PINs. Wait a minute and try again.'));
    if (auth.pin && safeEqual(String(auth.pin), config.djPin)) {
      pinFailures.delete(ip);
      return next();
    }
    if (auth.pin) {
      const count = (fail?.count ?? 0) + 1;
      pinFailures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    }
    next(new Error('PIN required'));
  });

  io.on('connection', (raw) => {
    const socket = raw as IoSocket;
    const { role } = socket.data;
    void socket.join(role);
    if (role === 'dj') wireDj(socket);
    if (role === 'singer') wireSinger(socket);
    if (role === 'display') wireDisplay(socket);
    wireSearch(socket);
    socket.on('disconnect', scheduleBroadcast);
    scheduleBroadcast();
  });

  function wireDj(socket: IoSocket) {
    socket.on('dj:action', (action, ack) => respond(ack, () => djAction(action)));
    socket.on('dj:config', (ack) =>
      respond(ack, () => ({
        libraryFolders: config.libraryFolders,
        filenameOrder: config.filenameOrder,
        hasYouTubeKey: youtube.canSearch,
        djPin: config.djPin,
        publicUrl: config.publicUrl,
      })),
    );
  }

  function wireSinger(socket: IoSocket) {
    socket.on('singer:join', (name, ack) =>
      respond(ack, () => {
        if (!rateOk(socket, 'join', 5, 60_000)) throw new UserError('Slow down a little and try again.');
        const { token, singer } = show.join(String(name ?? ''));
        bindSinger(socket, singer.id);
        return { token, singerId: singer.id };
      }),
    );
    socket.on('singer:resume', (token, ack) =>
      respond(ack, () => {
        const singer = show.singerForToken(String(token ?? ''));
        if (!singer) throw new UserError('not-found');
        bindSinger(socket, singer.id);
        return { singerId: singer.id };
      }),
    );
    socket.on('singer:action', (action, ack) =>
      respond(ack, () => {
        const id = socket.data.singerId;
        if (!id || !show.singer(id)) throw new UserError('Join the list first.');
        if (!rateOk(socket, 'action', 30, 60_000)) throw new UserError('Slow down a little and try again.');
        return show.singerAction(id, action);
      }),
    );
  }

  function bindSinger(socket: IoSocket, singerId: string) {
    if (socket.data.singerId) void socket.leave(`singer:${socket.data.singerId}`);
    socket.data.singerId = singerId;
    void socket.join(`singer:${singerId}`);
    scheduleBroadcast();
  }

  function wireDisplay(socket: IoSocket) {
    const fromPrimary = () => primaryDisplay()?.id === socket.id;
    socket.on('display:progress', (p) => {
      if (!fromPrimary() || !p) return;
      if (show.progress(String(p.playId), Number(p.position), p.duration === undefined ? undefined : Number(p.duration))) {
        io.to('dj').emit('dj:progress', { playId: String(p.playId), position: Number(p.position), duration: show.state.nowPlaying?.duration });
      }
    });
    socket.on('display:ended', (p) => fromPrimary() && p && show.ended(String(p.playId)));
    socket.on('display:error', (p) => fromPrimary() && p && show.playbackError(String(p.playId), String(p.message)));
  }

  function wireSearch(socket: IoSocket) {
    const isDj = socket.data.role === 'dj';
    socket.on('search', (query, ack) =>
      respond(ack, () => {
        const results = library.search(String(query ?? '').slice(0, 100), { limit: isDj ? 60 : 30, dedupe: !isDj });
        return results.map((r) => ({ ...r, playedTonight: show.playedTonight(r.song) }));
      }),
    );
    socket.on('searchYouTube', (query, ack) =>
      respondAsync(ack, async () => {
        if (!isDj && !show.state.settings.allowYouTube) throw new UserError('YouTube requests are off tonight.');
        if (!isDj && !rateOk(socket, 'yt', 12, 10 * 60_000)) throw new UserError('That’s a lot of searches — try again in a few minutes.');
        const q = String(query ?? '').trim();
        if (!q) return [];
        const results = await youtube.search(q);
        return results.map((r) => ({ ...r, playedTonight: show.playedTonight(r.song) }));
      }),
    );
    socket.on('lookupYouTube', (input, ack) =>
      respondAsync(ack, async () => {
        if (!isDj && !show.state.settings.allowYouTube) throw new UserError('YouTube requests are off tonight.');
        const id = parseYouTubeId(String(input ?? ''));
        if (!id) throw new UserError('That doesn’t look like a YouTube link.');
        const song = await youtube.lookup(id);
        return { song, playedTonight: show.playedTonight(song) } satisfies SearchResult;
      }),
    );
  }

  async function djAction(a: DjAction): Promise<unknown> {
    switch (a.type) {
      case 'setMode':
        if (!['rotation', 'fair', 'fifo', 'shuffle'].includes(a.mode)) throw new UserError('Unknown mode.');
        return show.setMode(a.mode);
      case 'updateSettings':
        return show.updateSettings(a.patch ?? {});
      case 'addSinger':
        return show.addSinger(a.name, false).id;
      case 'renameSinger':
        return show.renameSinger(a.singerId, a.name);
      case 'removeSinger':
        return show.removeSinger(a.singerId);
      case 'setSingerStatus':
        return show.setSingerStatus(a.singerId, a.status === 'away' ? 'away' : 'active');
      case 'moveSinger':
        return show.moveSinger(a.singerId, Number(a.toIndex));
      case 'addEntry':
        return show.addEntry(a.singerId, a.song, { note: a.note, fromPhone: false }).id;
      case 'removeEntry':
        return show.removeEntry(a.entryId);
      case 'moveEntry':
        return show.moveEntry(a.entryId, Number(a.toIndex));
      case 'approveEntry':
        return show.approve(a.entryId);
      case 'approveAll':
        return show.approve();
      case 'pinEntry':
        return show.pin(a.entryId);
      case 'unpinEntry':
        return show.unpin(a.entryId);
      case 'callNext':
        return show.callNext()?.id ?? null;
      case 'callEntry':
        return show.callEntry(a.entryId);
      case 'play':
        return show.play();
      case 'pause':
        return show.pause();
      case 'restart':
        return show.seekTo(0);
      case 'seekBy':
        return show.seekTo((show.state.nowPlaying?.position ?? 0) + Number(a.seconds));
      case 'skip':
        return show.skip();
      case 'noShow':
        return show.noShow();
      case 'stop':
        return show.stop();
      case 'setVolume':
        return show.updateSettings({ volume: Number(a.volume) });
      case 'newShow': {
        const old = show.newShow();
        await archive(old);
        io.to('singer').emit('singer:removed');
        return null;
      }
      case 'rescanLibrary':
        void rescan();
        return null;
      case 'setConfig':
        return updateConfig(a);
      default:
        throw new UserError('Unknown action.');
    }
  }

  async function updateConfig(a: Extract<DjAction, { type: 'setConfig' }>) {
    const file = join(opts.dataDir, 'config.json');
    let saved: Partial<Config> = {};
    try {
      saved = JSON.parse(await readFile(file, 'utf8')) as Partial<Config>;
    } catch {
      // nothing saved yet
    }
    if (a.libraryFolders) {
      config.libraryFolders = a.libraryFolders.map((f) => String(f).trim()).filter(Boolean).slice(0, 20);
      saved.libraryFolders = config.libraryFolders;
    }
    if (a.filenameOrder) {
      config.filenameOrder = a.filenameOrder === 'title-artist' ? 'title-artist' : 'artist-title';
      saved.filenameOrder = config.filenameOrder;
      library.setOrder(config.filenameOrder);
    }
    if (a.youtubeApiKey !== undefined) {
      config.youtubeApiKey = String(a.youtubeApiKey).trim() || undefined;
      saved.youtubeApiKey = config.youtubeApiKey;
      youtube.setApiKey(config.youtubeApiKey);
    }
    await saveConfig(opts.dataDir, { ...config, ...saved } as Config);
    if (a.libraryFolders || a.filenameOrder) void rescan();
    scheduleBroadcast();
    return null;
  }

  async function archive(old: typeof show.state) {
    if (!old.history.length && !old.singers.length) return;
    const dir = join(opts.dataDir, 'past-shows');
    await mkdir(dir, { recursive: true });
    const stamp = new Date(old.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    await writeFile(join(dir, `${stamp}-${old.id}.json`), JSON.stringify(old, null, 1));
  }

  async function rescan() {
    if (library.getStatus().scanning) return;
    const folders = [...config.libraryFolders, ...(opts.extraLibraryFolders ?? [])];
    await library.scan(folders, scheduleBroadcast);
    log(`  Library: ${library.getStatus().trackCount} tracks from ${folders.length} folder(s)`);
  }

  // --- views -----------------------------------------------------------------

  function displaySockets(): IoSocket[] {
    return [...io.sockets.sockets.values()]
      .map((s) => s as IoSocket)
      .filter((s) => s.data.role === 'display')
      .sort((a, b) => a.data.connectedAt - b.data.connectedAt);
  }

  function primaryDisplay(): IoSocket | undefined {
    return displaySockets()[0];
  }

  function broadcast() {
    const list = show.upcoming(50);
    const displays = displaySockets();
    const dj: DjView = {
      show: show.state,
      upcoming: list,
      joinUrl: joinUrl(),
      library: library.getStatus(),
      youtubeSearch: youtube.canSearch,
      displays: displays.length,
      mediaKey,
    };
    io.to('dj').emit('dj:view', dj);
    displays.forEach((s, i) => s.emit('display:view', show.displayView(list, joinUrl(), i === 0, mediaKey)));
    for (const raw of io.sockets.sockets.values()) {
      const s = raw as IoSocket;
      if (s.data.role !== 'singer') continue;
      if (s.data.singerId && !show.singer(s.data.singerId)) {
        s.emit('singer:removed');
        void s.leave(`singer:${s.data.singerId}`);
        s.data.singerId = undefined;
      }
      s.emit('singer:view', show.singerView(s.data.singerId, list, youtube.canSearch));
    }
  }

  // --- lifecycle -------------------------------------------------------------

  async function listen(): Promise<string> {
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(opts.port, opts.host ?? '0.0.0.0', () => ok());
    });
    const addr = server.address();
    if (addr && typeof addr === 'object') port = addr.port;
    void rescan();
    return `http://localhost:${port}`;
  }

  async function close(): Promise<void> {
    show.dispose();
    await show.flush().catch(() => {});
    io.disconnectSockets(true);
    await new Promise<void>((ok) => io.close(() => ok()));
    await vite?.close();
  }

  return { server, io, show, library, youtube, config, listen, close, joinUrl, get port() { return port; } };
}

// --- helpers -----------------------------------------------------------------

function respond<T>(ack: Ack<T> | undefined, fn: () => T | Promise<T>): void {
  void respondAsync(ack, async () => fn());
}

async function respondAsync<T>(ack: Ack<T> | undefined, fn: () => Promise<T>): Promise<void> {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    reply({ ok: true, data: (await fn()) as T });
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    reply({ ok: false, error: err instanceof Error ? err.message : 'Something went wrong.' });
  }
}

const rateWindows = new WeakMap<object, Map<string, number[]>>();
function rateOk(socket: IoSocket, key: string, max: number, windowMs: number): boolean {
  let m = rateWindows.get(socket);
  if (!m) rateWindows.set(socket, (m = new Map()));
  const now = Date.now();
  const hits = (m.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  m.set(key, hits);
  return true;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

function isLocalRequest(req: IncomingMessage): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? '') && !PROXY_HEADERS.some((h) => h in req.headers);
}

function isLocalHandshake(socket: Socket): boolean {
  // A tunnel (cloudflared, ngrok) also connects from loopback; its forwarding
  // headers give it away, and those visitors are phones, not the KJ.
  return LOOPBACK.has(socket.handshake.address) && !PROXY_HEADERS.some((h) => h in socket.handshake.headers);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

/** The address phones on the same Wi-Fi can reach this laptop at. */
export function lanAddress(): string {
  const candidates: { addr: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let score = 0;
      if (/^(192\.168|10\.)/.test(a.address)) score += 2;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (/^(en|eth|wl|wi-?fi|wlan)/i.test(name)) score += 2;
      if (/docker|veth|br-|vmnet|vbox|utun|tailscale|zt/i.test(name)) score -= 5;
      candidates.push({ addr: a.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.addr ?? 'localhost';
}

export type App = Awaited<ReturnType<typeof createApp>>;
