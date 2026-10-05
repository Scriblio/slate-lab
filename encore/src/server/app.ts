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
import type { BrowseRequest, DjView, Entry, SearchResult, Song } from '../shared/types.ts';
import { CLOUD, cloudConfigured } from '../shared/cloud.ts';
import { joinLink, supabaseTransport, type RelayTransport } from '../shared/relay.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { KeyMemory } from './keys.ts';
import { BreakMusic } from './breakmusic.ts';
import { Library } from './library.ts';
import { SongKeys } from './songkeys.ts';
import type { SongKey } from '../shared/songkey.ts';
import { serveMedia } from './media.ts';
import { PushNotifier, turnAlerts } from './push.ts';
import { loadIdentity, RelayHost, type RelayIdentity } from './relay.ts';
import { blockedMessage, Show, UserError } from './show.ts';
import { YouTube } from './youtube.ts';
import { REFUSAL_CODES, YouTubeGuard } from './ytguard.ts';

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
  /** Scanned only while the KJ has no library folders of their own. */
  fallbackLibraryFolder?: string;
  /** If the port is taken, take any free one instead of failing. */
  portFallback?: boolean;
  /** The online join link. Defaults to shared/cloud.ts (plus env overrides); false turns it off. */
  cloud?: false | { joinOrigin: string; transport: () => RelayTransport; checkJoinPage?: () => Promise<boolean> };
  /** Encore's YouTube search service. Defaults to shared/cloud.ts (plus env overrides); false turns it off. */
  youtubeProxy?: false | { url: string; key: string };
  /** How long a phone waits for the console to work out a song's key (default 12 s). */
  keyWaitMs?: number;
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
  const breakMusic = new BreakMusic();
  const proxy = resolveYouTubeProxy(opts.youtubeProxy);
  const youtube = new YouTube(config.youtubeApiKey, opts.fetchImpl, proxy && { ...proxy, installId: config.installId });
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

  const keys = new KeyMemory({ dataDir: opts.dataDir, log });
  await keys.load();
  const songKeys = new SongKeys({ dataDir: opts.dataDir, log });
  await songKeys.load();
  const songKeyOf = (song: Song) => (song.source.kind === 'local' ? songKeys.get(song.source.trackId) : undefined);
  /**
   * Phones waiting for a song's key while the console works it out. The
   * console is asked at most once a minute per song, so a song it can't
   * decode isn't retried in a loop.
   */
  const pendingKeys = new Map<string, { askedAt: number; waiters: Set<(k: SongKey | null) => void> }>();
  const KEY_WAIT_MS = opts.keyWaitMs ?? 12_000;
  function detectKeyNow(id: string): Promise<SongKey | null> {
    // Only the KJ's console can listen to a song, so with none connected there's nothing to wait for.
    if (!io?.sockets.adapter.rooms.get('dj')?.size) return Promise.resolve(null);
    let p = pendingKeys.get(id);
    if (!p) pendingKeys.set(id, (p = { askedAt: 0, waiters: new Set() }));
    const entry = p;
    return new Promise((resolve) => {
      const done = (k: SongKey | null) => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve(k);
      };
      const timer = setTimeout(() => {
        done(null);
        if (!entry.waiters.size && pendingKeys.get(id) === entry && Date.now() - entry.askedAt > 60_000) pendingKeys.delete(id);
      }, KEY_WAIT_MS);
      entry.waiters.add(done);
      if (Date.now() - entry.askedAt > 60_000) {
        entry.askedAt = Date.now();
        io.to('dj').emit('dj:detect', { trackId: id });
      }
    });
  }
  const trackIds = (entries: Entry[]) => entries.flatMap((e) => (e.song.source.kind === 'local' ? [e.song.source.trackId] : []));

  // Created once the online settings are known (it needs the player page's address).
  let guard: YouTubeGuard | undefined;
  const show = new Show({
    dataDir: opts.dataDir,
    keys,
    blockReason: (videoId) => guard?.blockReason(videoId),
    onNotice: (text) => io?.to('dj').emit('dj:notice', { text }),
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
  const lanJoinUrl = () => `${baseUrl()}/join`;

  // --- online join link ----------------------------------------------------------

  const cloud = resolveCloud(opts.cloud);
  // Lock-screen alerts work only on the online join page (push needs https),
  // and this laptop sends them itself, signed with its own key.
  const push = cloud ? new PushNotifier({ dataDir: opts.dataDir, subject: cloud.joinOrigin, fetchImpl: opts.fetchImpl, log }) : undefined;
  await push?.load(show.state.id);
  guard = new YouTubeGuard({
    dataDir: opts.dataDir,
    show,
    search: (q) => youtube.search(q),
    // The YouTube player runs from a page on Encore's site, so YouTube sees a
    // real https website as the embedder rather than this laptop's address.
    frameUrl: cloud ? `${cloud.joinOrigin.replace(/\/$/, '')}/yt-frame` : undefined,
    // Refusals and "not karaoke" are shared with every KJ through the search service.
    shared: youtube.mode === 'built-in' ? { report: (id, kind) => youtube.report(id, kind), check: (ids) => youtube.checkShared(ids) } : undefined,
    log,
  });
  guard.onUpdate = scheduleBroadcast;
  await guard.load();
  const ytGuard = guard;
  let relay: RelayHost | undefined;
  let identity: RelayIdentity | undefined;
  const onlineJoinUrl = () => (cloud && identity ? joinLink(cloud.joinOrigin, { room: identity.room, hostKey: identity.publicKey }) : undefined);
  // Only advertise the online link once its page actually loads, so a site
  // that's down (or not set up yet) can never strand singers.
  let joinPageOk = false;
  let joinPageTimer: ReturnType<typeof setTimeout> | undefined;
  async function checkJoinPage() {
    if (!cloud) return;
    const ok = await (cloud.checkJoinPage ?? (() => pageLoads(cloud.joinOrigin)))().catch(() => false);
    if (ok !== joinPageOk) {
      joinPageOk = ok;
      scheduleBroadcast();
    }
  }
  /** Check now, then again in a minute while the page is down, or in 15 while it's up. */
  async function watchJoinPage() {
    await checkJoinPage();
    joinPageTimer = setTimeout(() => void watchJoinPage(), (joinPageOk ? 15 : 1) * 60_000);
    joinPageTimer.unref?.();
  }
  const onlineReady = () => relay?.state === 'online' && joinPageOk;
  /** The link in the QR code: the secure online one while it works, else the Wi-Fi one. */
  const joinUrl = () => (onlineReady() ? onlineJoinUrl()! : lanJoinUrl());
  const joinLabel = () => (onlineReady() ? new URL(cloud!.joinOrigin).host : lanJoinUrl().replace(/^https?:\/\//, ''));

  async function startRelay() {
    if (!cloud || relay || config.onlineJoin === false) return;
    identity ??= await loadIdentity(opts.dataDir);
    relay = new RelayHost({ transport: cloud.transport(), identity, localUrl: `http://127.0.0.1:${port}`, onState: scheduleBroadcast });
    relay.start();
    if (!joinPageTimer) await watchJoinPage();
    scheduleBroadcast();
  }

  function stopRelay() {
    relay?.stop();
    relay = undefined;
    scheduleBroadcast();
  }

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

    if (path === '/api/tip-qr.svg') {
      const link = show.state.settings.tipLink;
      if (!link) return notFound(res);
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
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
      // Library songs, or a file from the break music folder.
      const from = library.get(media[1]!) ? library : breakMusic.library;
      return serveMedia(from, media[1]!, media[2] as 'main' | 'cdg', req, res);
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
        breakFolders: config.breakFolders,
        audioOutput: config.audioOutput,
        setupDone: config.setupDone,
        filenameOrder: config.filenameOrder,
        youtubeSearch: youtube.mode,
        djPin: config.djPin,
        publicUrl: config.publicUrl,
        onlineJoinAvailable: Boolean(cloud),
        onlineJoin: config.onlineJoin !== false,
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
    socket.on('singer:reclaim', (name, code, ack) =>
      respond(ack, () => {
        if (!rateOk(socket, 'join', 5, 60_000)) throw new UserError('Slow down a little and try again.');
        const { token, singer } = show.reclaim(String(name ?? ''), String(code ?? ''));
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
        if (action?.type === 'pushSubscribe' || action?.type === 'pushUnsubscribe') {
          if (!push) throw new UserError('Lock-screen alerts aren’t available here.');
          if (action.type === 'pushSubscribe') push.subscribe(id, action.subscription);
          else push.unsubscribe(id);
          scheduleBroadcast();
          return null;
        }
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
    socket.on('display:breakEnded', (p) => fromPrimary() && p && breakMusic.ended(Number(p.nonce)) && scheduleBroadcast());
    socket.on('display:breakError', (p) => {
      if (!fromPrimary() || !p) return;
      if (breakMusic.failed(Number(p.nonce))) {
        if (p.message) log(`  Break music: ${String(p.message).slice(0, 120)}`);
        scheduleBroadcast();
      }
    });
    socket.on('display:error', (p) => {
      if (!fromPrimary() || !p) return;
      const np = show.state.nowPlaying;
      const code = Number(p.code);
      if (np?.playId === String(p.playId) && np.entry.song.source.kind === 'youtube' && REFUSAL_CODES.has(code)) {
        // Refused at showtime: find another version and carry on with it.
        show.playbackError(np.playId, 'YouTube won’t play this version here. Finding another one…');
        void ytGuard.report(np.entry.song.source.videoId, false);
        return;
      }
      show.playbackError(String(p.playId), String(p.message));
    });
  }

  function wireSearch(socket: IoSocket) {
    const isDj = socket.data.role === 'dj';
    // A singer sees the key they sang each song in last time, so it comes up that way again.
    const decorate = (results: SearchResult[]): SearchResult[] => {
      const me = !isDj && socket.data.singerId ? show.singer(socket.data.singerId)?.name : undefined;
      return results.map((r) => {
        const lastKey = me ? keys.get(me, r.song) : undefined;
        const songKey = songKeyOf(r.song);
        return { ...r, playedTonight: show.playedTonight(r.song), ...(lastKey ? { lastKey } : {}), ...(songKey ? { songKey } : {}) };
      });
    };
    socket.on('search', (query, ack) =>
      respond(ack, () => {
        const results = library.search(String(query ?? '').slice(0, 100), { limit: isDj ? 60 : 30, dedupe: !isDj });
        return decorate(results);
      }),
    );
    socket.on('songKey', (trackId, ack) =>
      respondAsync(ack, async () => {
        const id = String(trackId ?? '');
        if (!/^[a-f0-9]{16}$/.test(id) || !library.get(id)) return null;
        const known = songKeys.get(id);
        if (known) return known;
        if (!isDj && !rateOk(socket, 'songkey', 20, 60_000)) return null;
        return detectKeyNow(id);
      }),
    );
    socket.on('browse', (req, ack) =>
      respond(ack, () => {
        if (!isDj && !show.state.settings.allowBrowse) throw new UserError('The KJ has turned off browsing the song list tonight. You can still search.');
        if (!isDj && !rateOk(socket, 'browse', 120, 60_000)) throw new UserError('Slow down a little, then keep scrolling.');
        const r = (req ?? {}) as Partial<BrowseRequest>;
        const page = library.browse({
          sort: r.sort === 'title' ? 'title' : 'artist',
          offset: Number(r.offset) || 0,
          letter: typeof r.letter === 'string' ? r.letter.slice(0, 1) : undefined,
          limit: Math.min(Number(r.limit) || 40, 50),
        });
        return { ...page, items: decorate(page.items) };
      }),
    );
    socket.on('searchYouTube', (query, ack) =>
      respondAsync(ack, async () => {
        if (!isDj && !show.state.settings.allowYouTube) throw new UserError('YouTube requests are off tonight.');
        if (!isDj && !rateOk(socket, 'yt', 12, 10 * 60_000)) throw new UserError('That’s a lot of searches — try again in a few minutes.');
        const q = String(query ?? '').trim();
        if (!q) return [];
        const results = await youtube.search(q);
        return results
          .filter((r) => r.song.source.kind !== 'youtube' || !ytGuard.isRefused(r.song.source.videoId))
          .map((r) => ({ ...r, playedTonight: show.playedTonight(r.song) }));
      }),
    );
    socket.on('lookupYouTube', (input, ack) =>
      respondAsync(ack, async () => {
        if (!isDj && !show.state.settings.allowYouTube) throw new UserError('YouTube requests are off tonight.');
        const id = parseYouTubeId(String(input ?? ''));
        if (!id) throw new UserError('That doesn’t look like a YouTube link.');
        await ytGuard.checkShared([id]);
        const blocked = blockedMessage(ytGuard.blockReason(id));
        if (blocked) throw new UserError(blocked);
        const result = await youtube.lookup(id);
        return { ...result, playedTonight: show.playedTonight(result.song) } satisfies SearchResult;
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
      case 'mergeSingers': {
        show.mergeSingers(a.fromId, a.intoId);
        push?.transfer(a.fromId, a.intoId);
        // Phones signed in as the duplicate now act as the merged singer.
        for (const raw of io.sockets.sockets.values()) {
          const s = raw as IoSocket;
          if (s.data.singerId === a.fromId) bindSinger(s, a.intoId);
        }
        return null;
      }
      case 'setSingerStatus':
        return show.setSingerStatus(a.singerId, a.status === 'away' ? 'away' : 'active');
      case 'moveSinger':
        return show.moveSinger(a.singerId, Number(a.toIndex));
      case 'addEntry':
        return show.addEntry(a.singerId, a.song, { note: a.note, fromPhone: false, key: a.key }).id;
      case 'setKey':
        return show.setKey(String(a.entryId), Number(a.key)).key ?? 0;
      case 'setSongKey': {
        const id = String(a.trackId);
        if (!library.get(id)) throw new UserError('That track is not in the library any more.');
        if (songKeys.set(id, a.key, { detected: Boolean(a.detected) })) scheduleBroadcast();
        const now = songKeys.get(id) ?? null;
        if (now) {
          // Phones waiting to hear this song's key get it now.
          for (const done of pendingKeys.get(id)?.waiters ?? []) done(now);
          pendingKeys.delete(id);
        }
        return now;
      }
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
      case 'changeStageSong':
        return show.changeStageSong(a.song, { fromPhone: false }).id;
      case 'notKaraoke': {
        // The KJ says this YouTube video isn't a karaoke version: off the list,
        // hidden from searches on this laptop, and the singer is told why.
        const entry = show.findEntry(String(a.entryId));
        if (!entry || entry.song.source.kind !== 'youtube') throw new UserError('That isn’t a YouTube request any more.');
        await ytGuard.markNotKaraoke(entry.song.source.videoId);
        show.dropRequest(entry.id);
        io.to(`singer:${entry.singerId}`).emit('singer:notice', {
          text: `The KJ removed “${entry.song.title}” because it isn’t a karaoke version. Pick a karaoke version of the song (tap Preview to check before you add it).`,
        });
        return null;
      }
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
        push?.reset(show.state.id);
        await archive(old);
        io.to('singer').emit('singer:removed');
        return null;
      }
      case 'rescanLibrary':
        void rescan();
        return null;
      case 'breakSkip':
        breakMusic.skip();
        scheduleBroadcast();
        return null;
      case 'breakPause':
        breakMusic.setPaused(typeof a.paused === 'boolean' ? a.paused : undefined);
        scheduleBroadcast();
        return null;
      case 'breakPlay':
        if (a.on) {
          if (!breakMusic.count) throw new UserError('There’s no break music yet. Pick a folder with music or videos in Settings.');
          if (songOnStage()) throw new UserError('A song is playing. Break music can start when it ends.');
        }
        breakMusic.started = Boolean(a.on);
        scheduleBroadcast();
        return null;
      case 'youtubeCheck':
        await ytGuard.report(String(a.videoId), Boolean(a.ok), a.mode);
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
    if (a.breakFolders) {
      config.breakFolders = a.breakFolders.map((f) => String(f).trim()).filter(Boolean).slice(0, 20);
      saved.breakFolders = config.breakFolders;
    }
    if (typeof a.setupDone === 'boolean') {
      config.setupDone = a.setupDone;
      saved.setupDone = a.setupDone;
    }
    if (typeof a.audioOutput === 'string') {
      config.audioOutput = a.audioOutput.slice(0, 300);
      saved.audioOutput = config.audioOutput;
    }
    if (a.filenameOrder) {
      config.filenameOrder = a.filenameOrder === 'title-artist' ? 'title-artist' : 'artist-title';
      saved.filenameOrder = config.filenameOrder;
      library.setOrder(config.filenameOrder);
    }
    if (a.onlineJoin !== undefined) {
      config.onlineJoin = Boolean(a.onlineJoin);
      saved.onlineJoin = config.onlineJoin;
      if (config.onlineJoin) await startRelay();
      else stopRelay();
    }
    // Save only what is in the file plus this change, so values that came
    // from environment variables are never written to disk.
    await saveConfig(opts.dataDir, saved as Config);
    if (a.libraryFolders || a.filenameOrder) void rescan();
    if (a.breakFolders) void rescanBreak();
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
    if (folders.length === 0 && opts.fallbackLibraryFolder) folders.push(opts.fallbackLibraryFolder);
    await library.scan(folders, scheduleBroadcast);
    log(`  Library: ${library.getStatus().trackCount} tracks from ${folders.length} folder(s)`);
  }

  async function rescanBreak() {
    if (breakMusic.library.getStatus().scanning) return;
    await breakMusic.scan(config.breakFolders, scheduleBroadcast);
    if (config.breakFolders.length) log(`  Break music: ${breakMusic.count} tracks from ${config.breakFolders.length} folder(s)`);
    scheduleBroadcast();
  }

  /** A singer's song has started (the walk-up doesn't count). */
  function songOnStage(): boolean {
    const np = show.state.nowPlaying;
    return Boolean(np && np.stage !== 'intro');
  }
  /**
   * Music only plays while nothing is on stage: between songs, while the next singer walks up, and with an
   * empty list. With auto play on it plays by itself then; with it off, only once the KJ presses Play.
   */
  function breakIsOn(): boolean {
    return !songOnStage() && breakMusic.count > 0 && (show.state.settings.breakMusic || breakMusic.started);
  }
  let breakWasOn = false;
  /** Starts a fresh track when a break begins, and lets go of the pause when it ends. */
  function updateBreak(): boolean {
    // Pressing Play lasts until the next song, and auto play takes over from it, so turning auto play
    // back off goes quiet rather than carrying on.
    if (songOnStage() || show.state.settings.breakMusic) breakMusic.started = false;
    const on = breakIsOn();
    if (on !== breakWasOn) {
      breakWasOn = on;
      if (on) breakMusic.startBreak();
      else breakMusic.endBreak();
    } else if (on) breakMusic.ensureTrack();
    return on;
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
    const breakOn = updateBreak();
    const displays = displaySockets();
    if (push) {
      push.retain(new Set(show.state.singers.map((s) => s.id)));
      push.update(turnAlerts(show.state, list), onlineJoinUrl());
    }
    // Other KJs may have found a queued video won't play; at most once a minute.
    void ytGuard.syncShared().catch(() => {});
    const dj: DjView = {
      show: show.state,
      upcoming: list,
      joinUrl: joinUrl(),
      joinLabel: joinLabel(),
      relay: {
        state: !relay ? (cloud && config.onlineJoin !== false ? 'connecting' : 'off') : relay.state === 'online' && !joinPageOk ? 'page-down' : relay.state,
        onlineHost: cloud ? new URL(cloud.joinOrigin).host : undefined,
        lanUrl: lanJoinUrl(),
        phones: relay?.sessionCount ?? 0,
      },
      library: library.getStatus(),
      youtubeSearch: youtube.canSearch,
      youtube: ytGuard.view(),
      displays: displays.length,
      mediaKey,
      songKeys: songKeys.pick(trackIds(show.state.nowPlaying ? [show.state.nowPlaying.entry, ...show.state.entries] : show.state.entries)),
      breakMusic: breakMusic.status(breakOn),
      audioOutput: config.audioOutput,
    };
    io.to('dj').emit('dj:view', dj);
    const breakView = breakMusic.count
      ? { on: breakOn, paused: breakMusic.paused, volume: show.state.settings.breakVolume, nonce: breakMusic.nonce, track: breakMusic.current() }
      : undefined;
    displays.forEach((s, i) =>
      s.emit('display:view', { ...show.displayView(list, joinUrl(), joinLabel(), i === 0, mediaKey, ytGuard.view()), ...(breakView ? { breakMusic: breakView } : {}), audioOutput: config.audioOutput }),
    );
    for (const raw of io.sockets.sockets.values()) {
      const s = raw as IoSocket;
      if (s.data.role !== 'singer') continue;
      if (s.data.singerId && !show.singer(s.data.singerId)) {
        s.emit('singer:removed');
        void s.leave(`singer:${s.data.singerId}`);
        s.data.singerId = undefined;
      }
      const view = show.singerView(s.data.singerId, list, youtube.canSearch, library.getStatus().trackCount > 0);
      const id = s.data.singerId;
      const mine = songKeys.pick(trackIds(view.myEntries));
      s.emit('singer:view', {
        ...view,
        ...(push ? { push: { key: push.publicKey, on: Boolean(id && push.has(id)) } } : {}),
        ...(Object.keys(mine).length ? { songKeys: mine } : {}),
      });
    }
  }

  // --- lifecycle -------------------------------------------------------------

  async function listen(): Promise<string> {
    const bind = (p: number) =>
      new Promise<void>((ok, fail) => {
        server.once('error', fail);
        server.listen(p, opts.host ?? '0.0.0.0', () => {
          server.off('error', fail);
          ok();
        });
      });
    try {
      await bind(opts.port);
    } catch (err) {
      if (!opts.portFallback || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      await bind(0);
    }
    const addr = server.address();
    if (addr && typeof addr === 'object') port = addr.port;
    void rescan();
    void rescanBreak();
    await startRelay().catch((err) => console.warn('Online join link unavailable:', (err as Error).message));
    return `http://localhost:${port}`;
  }

  async function close(): Promise<void> {
    clearTimeout(joinPageTimer);
    relay?.stop();
    show.dispose();
    await show.flush().catch(() => {});
    await push?.settle();
    await push?.flush();
    await keys.flush();
    await songKeys.flush();
    io.disconnectSockets(true);
    await new Promise<void>((ok) => io.close(() => ok()));
    await vite?.close();
  }

  return {
    server,
    io,
    show,
    library,
    youtube,
    config,
    push,
    listen,
    close,
    joinUrl,
    get relay() {
      return relay;
    },
    get port() {
      return port;
    },
  };
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
    reply({ ok: false, error: err instanceof Error ? err.message : 'Something went wrong.', code: err instanceof UserError ? err.code : undefined });
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

/** The online join link's settings: explicit option, else shared/cloud.ts with env overrides. */
function resolveCloud(opt: AppOptions['cloud']): Exclude<AppOptions['cloud'], false> | undefined {
  if (opt === false) return undefined;
  if (opt) return opt;
  const c = {
    joinOrigin: process.env.ENCORE_JOIN_ORIGIN || CLOUD.joinOrigin,
    supabaseUrl: process.env.ENCORE_SUPABASE_URL || CLOUD.supabaseUrl,
    supabaseKey: process.env.ENCORE_SUPABASE_KEY || CLOUD.supabaseKey,
  };
  if (!cloudConfigured(c) || process.env.ENCORE_ONLINE_JOIN === '0') return undefined;
  return { joinOrigin: c.joinOrigin, transport: () => supabaseTransport(c.supabaseUrl, c.supabaseKey) };
}

/** Encore's YouTube search service (a Supabase Edge Function), unless turned off. */
function resolveYouTubeProxy(opt: AppOptions['youtubeProxy']): { url: string; key: string } | undefined {
  if (opt === false) return undefined;
  if (opt) return opt;
  const c = {
    joinOrigin: CLOUD.joinOrigin,
    supabaseUrl: process.env.ENCORE_SUPABASE_URL || CLOUD.supabaseUrl,
    supabaseKey: process.env.ENCORE_SUPABASE_KEY || CLOUD.supabaseKey,
  };
  if (!cloudConfigured(c) || process.env.ENCORE_YOUTUBE_SEARCH === '0') return undefined;
  return { url: `${c.supabaseUrl.replace(/\/$/, '')}/functions/v1/youtube-search`, key: c.supabaseKey };
}

async function pageLoads(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
  await res.body?.cancel();
  return res.ok;
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
