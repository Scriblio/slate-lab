// The live show: singers, requests, the stage, and what everyone sees.
// All mutations go through this class so they are validated, persisted and
// broadcast the same way whether they came from the KJ or a phone.

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlayerCommand, SingerAction, SongRef } from '../shared/protocol.ts';
import {
  changeMode,
  chooseNext,
  placeNewSinger,
  prepareRound,
  recordPerformance,
  upcoming,
  type Rng,
} from '../shared/rotation.ts';
import {
  DEFAULT_SETTINGS,
  type DisplayView,
  type Entry,
  type HistoryItem,
  type RotationMode,
  type Settings,
  type ShowState,
  type Singer,
  type SingerView,
  type Song,
  type UpcomingItem,
} from '../shared/types.ts';

export class UserError extends Error {}

export interface ShowDeps {
  /** Where show.json lives; omit for an in-memory show (tests). */
  dataDir?: string;
  now?: () => number;
  rng?: Rng;
  /** Resolve a library track id to a song. */
  resolveLocal: (trackId: string) => Song | undefined;
  onChange: () => void;
  onPlayerCommand: (playId: string, cmd: PlayerCommand) => void;
}

/** What the KJ needs to undo a call-up when the singer doesn't show. */
interface CallSnapshot {
  playId: string;
  entryIndex: number;
  singer?: Singer;
  sungThisRound: string[];
  round: number;
  playNext: string[];
}

interface Persisted {
  version: 1;
  state: ShowState;
  tokens: Record<string, string>;
  snapshot?: CallSnapshot;
}

const MAX_NAME = 32;
const MAX_NOTE = 80;
const MAX_TEXT = 140;
const MAX_HISTORY = 500;

export class Show {
  state: ShowState;
  /** token -> singer id. Tokens identify a phone; they are never broadcast. */
  private tokens = new Map<string, string>();
  private snapshot: CallSnapshot | undefined;
  private autoStartTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly rng: Rng;

  constructor(private deps: ShowDeps) {
    this.now = deps.now ?? Date.now;
    this.rng = deps.rng ?? Math.random;
    this.state = freshShow(this.now());
  }

  get file(): string | undefined {
    return this.deps.dataDir ? join(this.deps.dataDir, 'show.json') : undefined;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Persisted;
      if (raw.version !== 1) return;
      this.state = {
        ...freshShow(this.now()),
        ...raw.state,
        settings: { ...DEFAULT_SETTINGS, ...raw.state.settings },
      };
      this.tokens = new Map(Object.entries(raw.tokens ?? {}));
      this.snapshot = raw.snapshot;
      // A show that was mid-song when the laptop restarted resumes paused.
      const np = this.state.nowPlaying;
      if (np && np.stage === 'playing') this.state.nowPlaying = { ...np, stage: 'paused', autoStartAt: undefined };
      if (np?.autoStartAt) this.state.nowPlaying = { ...this.state.nowPlaying!, autoStartAt: undefined };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Could not read ${this.file}:`, err);
    }
  }

  private changed(): void {
    this.deps.onChange();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save().catch((err) => console.warn('Could not save the show:', err));
    }, 400);
  }

  /** Saves run one at a time so two writers never race on the temp file. */
  save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const run = async () => {
      const data: Persisted = { version: 1, state: this.state, tokens: Object.fromEntries(this.tokens), snapshot: this.snapshot };
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    };
    this.saving = this.saving.then(run, run);
    return this.saving;
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.save();
  }

  dispose(): void {
    clearTimeout(this.autoStartTimer);
    clearTimeout(this.saveTimer);
  }

  // --- lookups ---------------------------------------------------------------

  singer(id: string): Singer | undefined {
    return this.state.singers.find((s) => s.id === id);
  }

  private entry(id: string): Entry {
    const e = this.state.entries.find((x) => x.id === id);
    if (!e) throw new UserError('That song is no longer in the queue.');
    return e;
  }

  singerForToken(token: string): Singer | undefined {
    const id = this.tokens.get(token);
    return id ? this.singer(id) : undefined;
  }

  remainingSec(): number {
    const np = this.state.nowPlaying;
    if (!np) return 0;
    const length = np.duration ?? np.entry.song.durationSec ?? this.state.settings.defaultSongSec;
    return Math.max(0, length - np.position);
  }

  upcoming(limit = 50): UpcomingItem[] {
    return upcoming(this.state, { limit, now: this.now(), remainingSec: this.remainingSec() });
  }

  /** Has this exact song been sung or requested tonight? */
  playedTonight(song: Song): boolean {
    const key = sourceKey(song);
    return (
      this.state.entries.some((e) => sourceKey(e.song) === key) ||
      this.state.history.some((h) => sourceKey(h.entry.song) === key) ||
      (this.state.nowPlaying ? sourceKey(this.state.nowPlaying.entry.song) === key : false)
    );
  }

  // --- singers ---------------------------------------------------------------

  addSinger(rawName: string, fromPhone: boolean): Singer {
    let name = cleanText(rawName, MAX_NAME);
    if (!name) throw new UserError('Please enter a name.');
    const taken = new Set(this.state.singers.map((s) => s.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name} (${n})`.toLowerCase())) n++;
      name = `${name} (${n})`;
    }
    const singer: Singer = { id: shortId(), name, joinedAt: this.now(), status: 'active', songsSung: 0, fromPhone };
    this.state = { ...this.state, singers: placeNewSinger(this.state, singer, this.rng) };
    this.changed();
    return singer;
  }

  join(name: string): { token: string; singer: Singer } {
    if (!this.state.settings.joinOpen) throw new UserError('Sign-ups are closed for tonight.');
    const singer = this.addSinger(name, true);
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, singer.id);
    this.scheduleSave();
    return { token, singer };
  }

  renameSinger(id: string, name: string): void {
    const clean = cleanText(name, MAX_NAME);
    if (!clean) throw new UserError('Please enter a name.');
    this.updateSinger(id, { name: clean });
  }

  private updateSinger(id: string, patch: Partial<Singer>): void {
    if (!this.singer(id)) throw new UserError('That singer has left.');
    this.state = { ...this.state, singers: this.state.singers.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
    this.changed();
  }

  setSingerStatus(id: string, status: 'active' | 'away'): void {
    this.updateSinger(id, { status });
  }

  removeSinger(id: string): void {
    if (!this.singer(id)) return;
    const gone = new Set(this.state.entries.filter((e) => e.singerId === id).map((e) => e.id));
    this.state = {
      ...this.state,
      singers: this.state.singers.filter((s) => s.id !== id),
      entries: this.state.entries.filter((e) => e.singerId !== id),
      playNext: this.state.playNext.filter((e) => !gone.has(e)),
      sungThisRound: this.state.sungThisRound.filter((s) => s !== id),
    };
    for (const [token, singerId] of this.tokens) if (singerId === id) this.tokens.delete(token);
    this.changed();
  }

  moveSinger(id: string, toIndex: number): void {
    const from = this.state.singers.findIndex((s) => s.id === id);
    if (from < 0) return;
    const singers = [...this.state.singers];
    const [s] = singers.splice(from, 1);
    singers.splice(clamp(toIndex, 0, singers.length), 0, s!);
    this.state = { ...this.state, singers };
    this.changed();
  }

  // --- requests --------------------------------------------------------------

  /** Turn a client's song reference into a trusted Song. */
  resolveSong(ref: SongRef): Song {
    if (ref.kind === 'local') {
      const song = this.deps.resolveLocal(String(ref.trackId));
      if (!song) throw new UserError('That track is not in the library any more.');
      return song;
    }
    if (ref.kind === 'youtube') {
      const videoId = String(ref.videoId);
      if (!/^[\w-]{11}$/.test(videoId)) throw new UserError('That is not a YouTube video id.');
      const duration = Number(ref.durationSec);
      return {
        title: cleanText(ref.title ?? '', MAX_TEXT) || 'YouTube video',
        artist: cleanText(ref.artist ?? '', MAX_TEXT),
        source: { kind: 'youtube', videoId },
        durationSec: Number.isFinite(duration) && duration > 0 && duration < 3 * 3600 ? Math.round(duration) : undefined,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      };
    }
    throw new UserError('Unknown song source.');
  }

  addEntry(singerId: string, ref: SongRef, opts: { note?: string; fromPhone: boolean }): Entry {
    const singer = this.singer(singerId);
    if (!singer) throw new UserError('That singer has left.');
    const song = this.resolveSong(ref);
    const { settings } = this.state;
    const mine = this.state.entries.filter((e) => e.singerId === singerId);
    if (opts.fromPhone) {
      if (!settings.joinOpen) throw new UserError('Requests are closed for tonight.');
      if (song.source.kind === 'youtube' && !settings.allowYouTube) throw new UserError('The KJ isn’t taking YouTube requests tonight.');
      if (settings.maxQueuedPerSinger > 0 && mine.length >= settings.maxQueuedPerSinger) {
        throw new UserError(`You can have ${settings.maxQueuedPerSinger} song${settings.maxQueuedPerSinger === 1 ? '' : 's'} waiting at a time.`);
      }
    }
    if (mine.some((e) => sourceKey(e.song) === sourceKey(song))) throw new UserError('That song is already on your list.');
    const entry: Entry = {
      id: shortId(),
      singerId,
      song,
      requestedAt: this.now(),
      status: opts.fromPhone && settings.requireApproval ? 'pending' : 'queued',
      note: cleanText(opts.note ?? '', MAX_NOTE) || undefined,
    };
    this.state = { ...this.state, entries: [...this.state.entries, entry] };
    this.changed();
    return entry;
  }

  removeEntry(id: string): void {
    this.state = {
      ...this.state,
      entries: this.state.entries.filter((e) => e.id !== id),
      playNext: this.state.playNext.filter((e) => e !== id),
    };
    this.changed();
  }

  /**
   * Reorder within one singer's own songs. Entries keep their slots in the
   * global request order (which First Come mode uses); only which song fills
   * which slot changes.
   */
  moveEntry(id: string, toIndex: number): void {
    const e = this.entry(id);
    const slots: number[] = [];
    this.state.entries.forEach((x, i) => x.singerId === e.singerId && slots.push(i));
    const mine = slots.map((i) => this.state.entries[i]!);
    const from = mine.findIndex((x) => x.id === id);
    const [moved] = mine.splice(from, 1);
    mine.splice(clamp(toIndex, 0, mine.length), 0, moved!);
    const entries = [...this.state.entries];
    slots.forEach((slot, k) => (entries[slot] = mine[k]!));
    this.state = { ...this.state, entries };
    this.changed();
  }

  approve(id?: string): void {
    this.state = {
      ...this.state,
      entries: this.state.entries.map((e) => (e.status === 'pending' && (!id || e.id === id) ? { ...e, status: 'queued' } : e)),
    };
    this.changed();
  }

  pin(id: string): void {
    const e = this.entry(id);
    const playNext = [...this.state.playNext.filter((x) => x !== id), e.id];
    this.state = {
      ...this.state,
      playNext,
      entries: this.state.entries.map((x) => (x.id === id ? { ...x, status: 'queued' } : x)),
    };
    this.changed();
  }

  unpin(id: string): void {
    this.state = { ...this.state, playNext: this.state.playNext.filter((x) => x !== id) };
    this.changed();
  }

  // --- show-wide -------------------------------------------------------------

  setMode(mode: RotationMode): void {
    this.state = changeMode(this.state, mode, this.rng);
    this.changed();
  }

  updateSettings(patch: Partial<Settings>): void {
    const settings = sanitizeSettings({ ...this.state.settings, ...patch });
    this.state = { ...this.state, settings };
    if (patch.volume !== undefined && this.state.nowPlaying) {
      this.deps.onPlayerCommand(this.state.nowPlaying.playId, { cmd: 'volume', value: settings.volume });
    }
    this.changed();
  }

  /** Start a new night: same settings and mode, empty list. Returns the old show. */
  newShow(): ShowState {
    const old = this.state;
    clearTimeout(this.autoStartTimer);
    this.state = { ...freshShow(this.now()), mode: old.mode, settings: old.settings };
    this.tokens.clear();
    this.snapshot = undefined;
    this.changed();
    return old;
  }

  // --- the stage -------------------------------------------------------------

  /** Bring the next singer up (intro card on the display). */
  callNext(): Entry | null {
    // Someone is already being called up; "next" means start or no-show them.
    if (this.state.nowPlaying?.stage === 'intro') return this.state.nowPlaying.entry;
    this.finish('skipped');
    this.state = prepareRound(this.state, this.rng);
    const next = chooseNext(this.state);
    if (!next) {
      this.changed();
      return null;
    }
    this.callEntry(next.id);
    return next;
  }

  callEntry(entryId: string): void {
    this.finish('skipped');
    const entry = this.entry(entryId);
    if (entry.status !== 'queued') throw new UserError('Approve that request before calling it.');
    const singer = this.singer(entry.singerId);
    const playId = shortId();
    this.snapshot = {
      playId,
      entryIndex: this.state.entries.indexOf(entry),
      singer,
      sungThisRound: this.state.sungThisRound,
      round: this.state.round,
      playNext: this.state.playNext,
    };
    const now = this.now();
    this.state = recordPerformance(this.state, entry.id, now);
    const { autoStartSec } = this.state.settings;
    this.state.nowPlaying = {
      playId,
      entry,
      singerName: singer?.name ?? 'Guest',
      stage: 'intro',
      calledAt: now,
      position: 0,
      duration: entry.song.durationSec,
      autoStartAt: autoStartSec > 0 ? now + autoStartSec * 1000 : undefined,
    };
    clearTimeout(this.autoStartTimer);
    if (autoStartSec > 0) {
      this.autoStartTimer = setTimeout(() => {
        if (this.state.nowPlaying?.playId === playId && this.state.nowPlaying.stage === 'intro') this.play();
      }, autoStartSec * 1000);
    }
    this.changed();
  }

  play(): void {
    const np = this.state.nowPlaying;
    if (!np) {
      this.callNext();
      return;
    }
    clearTimeout(this.autoStartTimer);
    this.state.nowPlaying = { ...np, stage: 'playing', startedAt: np.startedAt ?? this.now(), autoStartAt: undefined };
    this.deps.onPlayerCommand(np.playId, { cmd: 'play' });
    this.changed();
  }

  pause(): void {
    const np = this.state.nowPlaying;
    if (!np || np.stage !== 'playing') return;
    this.state.nowPlaying = { ...np, stage: 'paused' };
    this.deps.onPlayerCommand(np.playId, { cmd: 'pause' });
    this.changed();
  }

  seekTo(seconds: number): void {
    const np = this.state.nowPlaying;
    if (!np) return;
    const to = clamp(seconds, 0, np.duration ?? Infinity);
    this.state.nowPlaying = { ...np, position: to };
    this.deps.onPlayerCommand(np.playId, { cmd: 'seek', to });
    this.changed();
  }

  /** End the current performance, then (optionally) bring up the next singer. */
  skip(): void {
    if (this.state.nowPlaying?.stage === 'intro') {
      this.noShow();
      return;
    }
    this.finish('skipped');
    if (this.state.settings.autoAdvance) this.callNext();
    else this.changed();
  }

  stop(): void {
    this.finish('skipped');
    this.changed();
  }

  /**
   * The called singer isn't here: undo the call-up so they keep their turn,
   * mark them away (they — or the KJ — flip back when they return), and move on.
   */
  noShow(): void {
    const np = this.state.nowPlaying;
    if (!np) return;
    clearTimeout(this.autoStartTimer);
    const snap = this.snapshot?.playId === np.playId ? this.snapshot : undefined;
    const entries = [...this.state.entries];
    const singerExists = Boolean(this.singer(np.entry.singerId));
    if (singerExists) entries.splice(clamp(snap?.entryIndex ?? 0, 0, entries.length), 0, np.entry);
    this.state = {
      ...this.state,
      nowPlaying: null,
      entries,
      sungThisRound: snap ? snap.sungThisRound : this.state.sungThisRound.filter((id) => id !== np.entry.singerId),
      round: snap?.round ?? this.state.round,
      playNext: snap ? snap.playNext.filter((id) => entries.some((e) => e.id === id)) : this.state.playNext,
      singers: this.state.singers.map((s) =>
        s.id === np.entry.singerId
          ? { ...s, ...(snap?.singer ? { songsSung: snap.singer.songsSung, lastSangAt: snap.singer.lastSangAt } : {}), status: 'away' }
          : s,
      ),
    };
    this.snapshot = undefined;
    this.callNext();
  }

  private finish(outcome: HistoryItem['outcome']): void {
    const np = this.state.nowPlaying;
    if (!np) return;
    clearTimeout(this.autoStartTimer);
    // A song that never left the intro card was not performed: put it back.
    if (np.stage === 'intro' && outcome === 'skipped') {
      this.undoCall(np.playId);
      return;
    }
    const item: HistoryItem = {
      entry: np.entry,
      singerName: np.singerName,
      startedAt: np.startedAt ?? np.calledAt,
      endedAt: this.now(),
      outcome: np.error ? 'error' : outcome,
    };
    this.state = { ...this.state, nowPlaying: null, history: [item, ...this.state.history].slice(0, MAX_HISTORY) };
    this.snapshot = undefined;
  }

  /** Revert a call-up that never started, without marking the singer away. */
  private undoCall(playId: string): void {
    const np = this.state.nowPlaying;
    if (!np || np.playId !== playId) return;
    const snap = this.snapshot?.playId === playId ? this.snapshot : undefined;
    const entries = [...this.state.entries];
    if (this.singer(np.entry.singerId)) entries.splice(clamp(snap?.entryIndex ?? 0, 0, entries.length), 0, np.entry);
    this.state = {
      ...this.state,
      nowPlaying: null,
      entries,
      sungThisRound: snap ? snap.sungThisRound : this.state.sungThisRound,
      round: snap?.round ?? this.state.round,
      playNext: snap ? snap.playNext.filter((id) => entries.some((e) => e.id === id)) : this.state.playNext,
      singers: snap?.singer
        ? this.state.singers.map((s) => (s.id === snap.singer!.id ? { ...s, songsSung: snap.singer!.songsSung, lastSangAt: snap.singer!.lastSangAt } : s))
        : this.state.singers,
    };
    this.snapshot = undefined;
  }

  // --- reports from the display ---------------------------------------------

  /** Returns true when the position should be relayed to the KJ. */
  progress(playId: string, position: number, duration?: number): boolean {
    const np = this.state.nowPlaying;
    if (!np || np.playId !== playId || !Number.isFinite(position)) return false;
    const d = duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : np.duration;
    const durationChanged = d !== np.duration;
    this.state.nowPlaying = { ...np, position: Math.max(0, position), duration: d };
    // Durations feed wait estimates, so a newly learned one is a real change.
    if (durationChanged) this.changed();
    return true;
  }

  ended(playId: string): void {
    if (this.state.nowPlaying?.playId !== playId) return;
    if (this.state.nowPlaying.stage === 'intro') return;
    this.finish('finished');
    if (this.state.settings.autoAdvance) this.callNext();
    else this.changed();
  }

  playbackError(playId: string, message: string): void {
    const np = this.state.nowPlaying;
    if (!np || np.playId !== playId) return;
    this.state.nowPlaying = { ...np, error: cleanText(message, 200) || 'Playback failed', stage: 'paused' };
    this.changed();
  }

  // --- phone actions ---------------------------------------------------------

  singerAction(singerId: string, action: SingerAction): unknown {
    switch (action.type) {
      case 'request':
        return this.addEntry(singerId, action.song, { note: action.note, fromPhone: true }).id;
      case 'removeMyEntry': {
        const e = this.entry(action.entryId);
        if (e.singerId !== singerId) throw new UserError('That isn’t your song.');
        this.removeEntry(e.id);
        return null;
      }
      case 'moveMyEntry': {
        const e = this.entry(action.entryId);
        if (e.singerId !== singerId) throw new UserError('That isn’t your song.');
        const mine = this.state.entries.filter((x) => x.singerId === singerId);
        this.moveEntry(e.id, mine.indexOf(e) + (action.direction < 0 ? -1 : 1));
        return null;
      }
      case 'setAway':
        this.setSingerStatus(singerId, action.away ? 'away' : 'active');
        return null;
      case 'leave':
        this.removeSinger(singerId);
        return null;
      default:
        throw new UserError('Unknown action.');
    }
  }

  // --- views -----------------------------------------------------------------

  singerView(singerId: string | undefined, list: UpcomingItem[], youtubeSearch: boolean): SingerView {
    const { settings } = this.state;
    const me = singerId ? (this.singer(singerId) ?? null) : null;
    const np = this.state.nowPlaying;
    const showSong = (isMe: boolean) => settings.showSongsToSingers || isMe;
    const myIndex = me ? list.findIndex((u) => u.singer.id === me.id) : -1;
    return {
      showName: settings.showName,
      joinOpen: settings.joinOpen,
      allowYouTube: settings.allowYouTube,
      youtubeSearch: settings.allowYouTube && youtubeSearch,
      maxQueuedPerSinger: settings.maxQueuedPerSinger,
      me,
      myEntries: me ? this.state.entries.filter((e) => e.singerId === me.id) : [],
      myNextPosition: myIndex >= 0 ? myIndex + 1 : null,
      myNextEtaSec: myIndex >= 0 ? list[myIndex]!.etaSec : null,
      nowPlaying: np
        ? {
            singerName: np.singerName,
            stage: np.stage,
            isMe: np.entry.singerId === me?.id,
            ...(showSong(np.entry.singerId === me?.id) || np.stage !== 'intro'
              ? { title: np.entry.song.title, artist: np.entry.song.artist }
              : {}),
          }
        : null,
      upcoming: list.slice(0, 12).map((u) => {
        const isMe = u.singer.id === me?.id;
        return {
          singerName: u.singer.name,
          isMe,
          etaSec: u.etaSec,
          ...(showSong(isMe) ? { title: u.entry.song.title, artist: u.entry.song.artist } : {}),
        };
      }),
      mode: this.state.mode,
    };
  }

  displayView(list: UpcomingItem[], joinUrl: string, primary: boolean, mediaKey: string): DisplayView {
    return {
      showName: this.state.settings.showName,
      joinUrl,
      nowPlaying: this.state.nowPlaying,
      upNext: list.slice(0, 3).map((u) => ({ singerName: u.singer.name, title: u.entry.song.title, artist: u.entry.song.artist })),
      volume: this.state.settings.volume,
      primary,
      mediaKey,
    };
  }
}

// --- helpers -----------------------------------------------------------------

export function freshShow(now: number): ShowState {
  return {
    id: shortId(),
    createdAt: now,
    mode: 'rotation',
    settings: { ...DEFAULT_SETTINGS },
    singers: [],
    entries: [],
    round: 1,
    sungThisRound: [],
    playNext: [],
    nowPlaying: null,
    history: [],
  };
}

export function sourceKey(song: Song): string {
  return song.source.kind === 'local' ? `local:${song.source.trackId}` : `yt:${song.source.videoId}`;
}

function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

/** Trim, drop control characters, collapse whitespace, cap length. */
export function cleanText(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeSettings(s: Settings): Settings {
  const int = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? clamp(n, lo, hi) : d;
  };
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const D = DEFAULT_SETTINGS;
  return {
    showName: cleanText(s.showName, 60) || D.showName,
    requireApproval: bool(s.requireApproval, D.requireApproval),
    maxQueuedPerSinger: int(s.maxQueuedPerSinger, 0, 50, D.maxQueuedPerSinger),
    allowYouTube: bool(s.allowYouTube, D.allowYouTube),
    showSongsToSingers: bool(s.showSongsToSingers, D.showSongsToSingers),
    joinOpen: bool(s.joinOpen, D.joinOpen),
    autoAdvance: bool(s.autoAdvance, D.autoAdvance),
    autoStartSec: int(s.autoStartSec, 0, 120, D.autoStartSec),
    changeoverSec: int(s.changeoverSec, 0, 600, D.changeoverSec),
    defaultSongSec: int(s.defaultSongSec, 60, 900, D.defaultSongSec),
    volume: int(s.volume, 0, 100, D.volume),
  };
}
