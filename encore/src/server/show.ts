// The live show: singers, requests, the stage, and what everyone sees.
// All mutations go through this class so they are validated, persisted and
// broadcast the same way whether they came from the KJ or a phone.

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isBlockedName, parseWords } from '../shared/namefilter.ts';
import { parseTipAmounts, tipLinkWithAmount } from '../shared/tips.ts';
import { clampKey } from '../shared/pitch.ts';
import type { PlayerCommand, SingerAction, SongRef } from '../shared/protocol.ts';
import { nameKey } from '../shared/text.ts';
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
  type YouTubeEmbed,
} from '../shared/types.ts';

/** A problem to show the user as-is. `code` lets the client react (e.g. 'name-taken'). */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface ShowDeps {
  /** Where show.json lives; omit for an in-memory show (tests). */
  dataDir?: string;
  now?: () => number;
  rng?: Rng;
  /** Resolve a library track id to a song. */
  resolveLocal: (trackId: string) => Song | undefined;
  onChange: () => void;
  onPlayerCommand: (playId: string, cmd: PlayerCommand) => void;
  /** YouTube videos that won't play here, or that the KJ marked not karaoke, are turned away. */
  blockReason?: (videoId: string) => 'refused' | 'not-karaoke' | undefined;
  /** Something the KJ should hear about right away (a singer left, or asked to wait). */
  onNotice?: (text: string) => void;
  /** The key each singer likes for a library song, remembered from night to night. */
  keys?: { get(singerName: string, song: Song): number | undefined; set(singerName: string, song: Song, key: number): void };
}

const NO_KEY_FOR_YOUTUBE = 'YouTube songs can’t change key: they play in YouTube’s own player. Key change works for songs from the KJ’s library.';

/** What the KJ needs to undo a call-up when the singer doesn't show. */
interface CallSnapshot {
  playId: string;
  entryIndex: number;
  singer?: Singer;
  sungThisRound: string[];
  round: number;
  playNext: string[];
  /** Everyone's held turns before the call counted them down. */
  holds?: Record<string, number>;
}

/** How long after their song a singer's phone keeps the tip thank-you up. */
const TIP_PROMPT_MS = 10 * 60 * 1000;
/** A song cut short counts as sung after this long. */
const MIN_SUNG_MS = 60 * 1000;
/** How many singers go first when someone can't sing right now. */
export const HOLD_TURNS = 2;
const MAX_HOLD = 6;

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
const MAX_CLAIM_TRIES = 5;
const CLAIM_LOCK_MS = 10 * 60_000;
const CLAIM_WINDOW_MS = 10 * 60_000;

export class Show {
  state: ShowState;
  /** token -> singer id. Tokens identify a phone; they are never broadcast. */
  private tokens = new Map<string, string>();
  private snapshot: CallSnapshot | undefined;
  private autoStartTimer: NodeJS.Timeout | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private saving: Promise<void> = Promise.resolve();
  /** Wrong rejoin-code attempts per name, so a 4-digit code can't be guessed. */
  private claimFailures = new Map<string, { count: number; until: number }>();
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

  /** Temp files left by an earlier session that was closed between writing and renaming. */
  private async removeStaleTemps(): Promise<void> {
    const file = this.file;
    if (!file) return;
    try {
      const mine = `${basename(file)}.${process.pid}.tmp`;
      const stale = (await readdir(dirname(file))).filter((n) => n.startsWith(`${basename(file)}.`) && n.endsWith('.tmp') && n !== mine);
      await Promise.all(stale.map((n) => unlink(join(dirname(file), n)).catch(() => {})));
    } catch {
      // No folder yet, or nothing to tidy.
    }
  }

  async load(): Promise<void> {
    if (!this.file) return;
    await this.removeStaleTemps();
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Persisted;
      if (raw.version !== 1) return;
      this.state = {
        ...freshShow(this.now()),
        ...raw.state,
        settings: { ...DEFAULT_SETTINGS, ...raw.state.settings },
      };
      this.tokens = new Map(Object.entries(raw.tokens ?? {}));
      // Shows saved before rejoin codes existed: give everyone one.
      this.state.singers = this.state.singers.map((s) => (s.code ? s : { ...s, code: this.newCode() }));
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

  /** The singer already on the list under this name, if any (case, spacing and accents ignored). */
  singerNamed(name: string): Singer | undefined {
    const key = nameKey(name);
    return key ? this.state.singers.find((s) => nameKey(s.name) === key) : undefined;
  }

  private newCode(): string {
    const used = new Set(this.state.singers.map((s) => s.code));
    for (;;) {
      const code = String(randomInt(0, 10_000)).padStart(4, '0');
      if (!used.has(code) || used.size > 5000) return code;
    }
  }

  /**
   * The KJ can add two people with the same name (it adds "(2)"). A phone
   * can't: a second sign-up under a name that's already listed is almost
   * always the same person on a fresh browser, so they're asked to reclaim
   * their spot with their code instead.
   */
  addSinger(rawName: string, fromPhone: boolean): Singer {
    let name = cleanText(rawName, MAX_NAME);
    if (!name) throw new UserError('Please enter a name.');
    const existing = this.singerNamed(name);
    if (existing && fromPhone) throw new UserError(`${existing.name} is already on the list.`, 'name-taken');
    if (existing) {
      const taken = new Set(this.state.singers.map((s) => s.name.toLowerCase()));
      let n = 2;
      while (taken.has(`${name} (${n})`.toLowerCase())) n++;
      name = `${name} (${n})`;
    }
    const singer: Singer = { id: shortId(), name, joinedAt: this.now(), status: 'active', songsSung: 0, fromPhone, code: this.newCode() };
    this.state = { ...this.state, singers: placeNewSinger(this.state, singer, this.rng) };
    this.changed();
    return singer;
  }

  private issueToken(singerId: string): string {
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, singerId);
    this.scheduleSave();
    return token;
  }

  join(name: string): { token: string; singer: Singer } {
    if (!this.state.settings.joinOpen) throw new UserError('Sign-ups are closed for tonight.');
    const { nameFilter, blockedWords } = this.state.settings;
    if (nameFilter && isBlockedName(String(name ?? ''), parseWords(blockedWords))) {
      // Names go up on the venue screen. The KJ is told someone tried, without repeating what they typed.
      this.deps.onNotice?.('A singer tried a name that isn’t allowed on the screen, so it was turned away. You can add them yourself under another name.');
      throw new UserError('That name can’t go up on the screen. Please pick a different one.', 'name-blocked');
    }
    const singer = this.addSinger(name, true);
    return { token: this.issueToken(singer.id), singer };
  }

  /**
   * Get back into an existing spot (new phone or browser) with the singer's
   * code. If the KJ listed two people under one name ("Alex", "Alex (2)"),
   * the code says which one you are.
   */
  reclaim(name: string, code: string): { token: string; singer: Singer } {
    const key = nameKey(cleanText(name, MAX_NAME));
    const candidates = key ? this.state.singers.filter((s) => nameKey(s.name) === key) : [];
    if (!candidates.length) throw new UserError('Nobody by that name is on the list yet, so just join.', 'not-on-list');
    const now = this.now();
    const fails = this.claimFailures.get(key);
    if (fails && fails.until > now) throw new UserError('Too many wrong codes. Ask the KJ for yours.', 'locked');
    const digits = String(code ?? '').replace(/\D/g, '');
    const singer = candidates.find((s) => s.code === digits);
    if (!singer) {
      const count = (fails && fails.until > now - CLAIM_WINDOW_MS ? fails.count : 0) + 1;
      this.claimFailures.set(key, { count, until: count >= MAX_CLAIM_TRIES ? now + CLAIM_LOCK_MS : now });
      throw new UserError('That code doesn’t match. It’s in “My songs” on the phone you joined with, or the KJ can tell you.', 'bad-code');
    }
    this.claimFailures.delete(key);
    return { token: this.issueToken(singer.id), singer };
  }

  /**
   * Fold a duplicate into the real singer: songs, counts, this round's turn
   * and phone sessions all move over, then the duplicate is removed.
   */
  mergeSingers(fromId: string, intoId: string): void {
    const from = this.singer(fromId);
    const into = this.singer(intoId);
    if (!from || !into) throw new UserError('That singer has left.');
    if (from.id === into.id) throw new UserError('Pick a different singer to merge into.');
    if (this.state.nowPlaying?.entry.singerId === from.id) throw new UserError(`Wait until ${from.name} is off stage.`);
    const intoSongs = new Set(this.state.entries.filter((e) => e.singerId === into.id).map((e) => sourceKey(e.song)));
    const dropped = new Set<string>();
    const entries = this.state.entries.flatMap((e) => {
      if (e.singerId !== from.id) return [e];
      if (intoSongs.has(sourceKey(e.song))) {
        dropped.add(e.id);
        return [];
      }
      intoSongs.add(sourceKey(e.song));
      return [{ ...e, singerId: into.id }];
    });
    const sung = new Set(this.state.sungThisRound);
    const sungThisRound = sung.has(from.id) && !sung.has(into.id) ? [...this.state.sungThisRound, into.id] : this.state.sungThisRound;
    this.state = {
      ...this.state,
      entries,
      playNext: this.state.playNext.filter((id) => !dropped.has(id)),
      sungThisRound: sungThisRound.filter((id) => id !== from.id),
      singers: this.state.singers
        .filter((s) => s.id !== from.id)
        .map((s) =>
          s.id === into.id
            ? {
                ...s,
                songsSung: s.songsSung + from.songsSung,
                lastSangAt: Math.max(s.lastSangAt ?? 0, from.lastSangAt ?? 0) || undefined,
                fromPhone: s.fromPhone || from.fromPhone,
              }
            : s,
        ),
    };
    for (const [token, singerId] of this.tokens) if (singerId === from.id) this.tokens.set(token, into.id);
    this.changed();
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

  addEntry(singerId: string, ref: SongRef, opts: { note?: string; fromPhone: boolean; key?: number }): Entry {
    const singer = this.singer(singerId);
    if (!singer) throw new UserError('That singer has left.');
    const song = this.resolveSong(ref);
    const asked = opts.key === undefined ? undefined : clampKey(opts.key);
    if (asked && song.source.kind !== 'local') throw new UserError(NO_KEY_FOR_YOUTUBE);
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
    this.checkBlocked(song);
    // A key the singer picked becomes their key for this song; otherwise use the one they liked last time.
    if (asked !== undefined) this.deps.keys?.set(singer.name, song, asked);
    const key = asked ?? this.rememberedKey(singer.name, song);
    const entry: Entry = {
      id: shortId(),
      singerId,
      song,
      requestedAt: this.now(),
      status: opts.fromPhone && settings.requireApproval ? 'pending' : 'queued',
      note: cleanText(opts.note ?? '', MAX_NOTE) || undefined,
      ...(key ? { key } : {}),
    };
    this.state = { ...this.state, entries: [...this.state.entries, entry] };
    this.changed();
    return entry;
  }

  private rememberedKey(singerName: string, song: Song): number | undefined {
    return song.source.kind === 'local' ? clampKey(this.deps.keys?.get(singerName, song) ?? 0) || undefined : undefined;
  }

  /**
   * Key change for a library song, waiting or on stage. On stage the venue
   * screen follows straight away. Remembered for this singer and song.
   */
  setKey(entryId: string, semitones: number): Entry {
    const old = this.findEntry(entryId);
    if (!old) throw new UserError('That song is no longer in the queue.');
    if (old.song.source.kind !== 'local') throw new UserError(NO_KEY_FOR_YOUTUBE);
    const key = clampKey(semitones);
    const entry: Entry = { ...old, key: key || undefined };
    if (!key) delete entry.key;
    const np = this.state.nowPlaying;
    if (np?.entry.id === entryId) this.state.nowPlaying = { ...np, entry };
    else this.state = { ...this.state, entries: this.state.entries.map((e) => (e.id === entryId ? entry : e)) };
    const name = this.singer(entry.singerId)?.name ?? (np?.entry.id === entryId ? np.singerName : undefined);
    if (name) this.deps.keys?.set(name, entry.song, key);
    this.changed();
    return entry;
  }

  private checkBlocked(song: Song): void {
    if (song.source.kind !== 'youtube') return;
    const msg = blockedMessage(this.deps.blockReason?.(song.source.videoId));
    if (msg) throw new UserError(msg);
  }

  /**
   * Take a request off the list wherever it is. On stage, a song that hasn't
   * started is undone as if never called; one that has is ended. Either way the
   * next singer comes up when auto-advance is on.
   */
  dropRequest(entryId: string): void {
    const np = this.state.nowPlaying;
    if (np?.entry.id === entryId) {
      if (np.stage === 'intro') {
        this.undoCall(np.playId);
        this.removeEntry(entryId);
      } else {
        this.finish('skipped');
      }
      if (this.state.settings.autoAdvance) this.callNext();
      else this.changed();
      return;
    }
    this.removeEntry(entryId);
  }

  /** Where a request lives now: waiting in the queue, or on stage. */
  findEntry(id: string): Entry | undefined {
    return this.state.entries.find((e) => e.id === id) ?? (this.state.nowPlaying?.entry.id === id ? this.state.nowPlaying.entry : undefined);
  }

  /**
   * Swap the video of a request for another version, because YouTube won't
   * play the one that was picked here. On stage, the new video starts in
   * place of the old one.
   */
  replaceSong(entryId: string, song: Song, swappedFrom: string): boolean {
    const old = this.findEntry(entryId);
    if (!old) return false;
    const entry: Entry = { ...old, song, swappedFrom, swaps: (old.swaps ?? 0) + 1, wontPlay: undefined };
    const np = this.state.nowPlaying;
    if (np?.entry.id === entryId) {
      // Pick up where the singer was: playing if the song had started.
      const stage = np.stage === 'intro' ? 'intro' : np.startedAt !== undefined ? 'playing' : np.stage;
      this.state.nowPlaying = { ...np, entry, playId: shortId(), stage, position: 0, duration: song.durationSec, error: undefined };
    } else {
      this.state = { ...this.state, entries: this.state.entries.map((e) => (e.id === entryId ? entry : e)) };
    }
    this.changed();
    return true;
  }

  /** YouTube won't play this request's video and no other version turned up. */
  markWontPlay(entryId: string): void {
    const old = this.findEntry(entryId);
    if (!old || old.wontPlay) return;
    const entry: Entry = { ...old, wontPlay: true };
    const np = this.state.nowPlaying;
    if (np?.entry.id === entryId) {
      // Already failed on stage: say what the KJ can do now.
      const error = np.error ? 'YouTube won’t play this video here, and no other version turned up. Skip, or pick another version.' : undefined;
      this.state.nowPlaying = { ...np, entry, error };
    }
    else this.state = { ...this.state, entries: this.state.entries.map((e) => (e.id === entryId ? entry : e)) };
    this.changed();
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
      holds: Object.fromEntries(this.state.singers.filter((s) => s.holdTurns).map((s) => [s.id, s.holdTurns!])),
    };
    const now = this.now();
    this.state = recordPerformance(this.state, entry.id, now);
    this.state.nowPlaying = {
      playId,
      entry,
      singerName: singer?.name ?? 'Guest',
      stage: 'intro',
      calledAt: now,
      position: 0,
      duration: entry.song.durationSec,
      autoStartAt: this.armAutoStart(playId),
    };
    this.changed();
  }

  /** Start the intro countdown, when the KJ uses one. Returns when it fires. */
  private armAutoStart(playId: string): number | undefined {
    clearTimeout(this.autoStartTimer);
    const { autoStartSec } = this.state.settings;
    if (autoStartSec <= 0) return undefined;
    this.autoStartTimer = setTimeout(() => {
      if (this.state.nowPlaying?.playId === playId && this.state.nowPlaying.stage === 'intro') this.play();
    }, autoStartSec * 1000);
    return this.now() + autoStartSec * 1000;
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
      singers: restoreHolds(
        this.state.singers.map((s) =>
          s.id === np.entry.singerId
            ? { ...s, ...(snap?.singer ? { songsSung: snap.singer.songsSung, lastSangAt: snap.singer.lastSangAt } : {}), status: 'away' }
            : s,
        ),
        snap,
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
      singers: restoreHolds(
        snap?.singer
          ? this.state.singers.map((s) => (s.id === snap.singer!.id ? { ...s, songsSung: snap.singer!.songsSung, lastSangAt: snap.singer!.lastSangAt } : s))
          : this.state.singers,
        snap,
      ),
    };
    this.snapshot = undefined;
  }

  /**
   * "Can't sing right now": the next few singers go first and this one keeps
   * their songs. If they were just called up, the call is undone and the
   * next singer comes up instead.
   */
  holdTurn(singerId: string, turns = HOLD_TURNS): void {
    const singer = this.singer(singerId);
    if (!singer) throw new UserError('Join the list first.');
    const np = this.state.nowPlaying;
    const called = np?.entry.singerId === singerId;
    if (called && np.stage !== 'intro') throw new UserError('You’re already singing!');
    if (called) this.undoCall(np.playId);
    const holdTurns = Math.min(MAX_HOLD, (this.singer(singerId)?.holdTurns ?? 0) + turns);
    this.state = { ...this.state, singers: this.state.singers.map((s) => (s.id === singerId ? { ...s, holdTurns } : s)) };
    this.deps.onNotice?.(`${singer.name} can’t sing right now, so the next ${turns} singers go first.`);
    if (called && this.state.settings.autoAdvance) this.callNext();
    else this.changed();
  }

  /**
   * The singer on stage wants a different song. One of their own queued
   * songs trades places with the current one (so it goes back in line); any
   * other song replaces it. The new song goes up on the intro card, ready
   * for the KJ to start. From a phone, only before the song has started.
   */
  changeStageSong(ref: SongRef, opts: { fromPhone: boolean }): Entry {
    const np = this.state.nowPlaying;
    if (!np) throw new UserError('Nobody is on stage.');
    if (opts.fromPhone && np.stage !== 'intro') throw new UserError('Your song has already started. Ask the KJ.');
    const song = this.resolveSong(ref);
    this.checkBlocked(song);
    if (sourceKey(song) === sourceKey(np.entry.song)) return np.entry;
    if (opts.fromPhone && song.source.kind === 'youtube' && !this.state.settings.allowYouTube) {
      throw new UserError('The KJ isn’t taking YouTube requests tonight.');
    }
    const old = np.entry;
    // Picked from their own list: trade places, so the old song keeps that spot in line.
    const queued = this.state.entries.find((e) => e.singerId === old.singerId && sourceKey(e.song) === sourceKey(song));
    const entries = queued
      ? this.state.entries.map((e) =>
          e.id === queued.id ? { ...e, song: old.song, swappedFrom: old.swappedFrom, swaps: old.swaps, wontPlay: old.wontPlay, key: old.key } : e,
        )
      : this.state.entries;
    const entry: Entry = {
      ...old,
      song: queued?.song ?? song,
      note: queued ? queued.note : old.note,
      swappedFrom: queued?.swappedFrom,
      swaps: queued?.swaps,
      wontPlay: queued?.wontPlay,
      key: queued ? queued.key : this.rememberedKey(np.singerName, song),
    };
    const playId = shortId();
    this.state = {
      ...this.state,
      entries,
      nowPlaying: {
        ...np,
        entry,
        playId,
        stage: 'intro',
        position: 0,
        duration: entry.song.durationSec,
        error: undefined,
        startedAt: undefined,
        autoStartAt: this.armAutoStart(playId),
      },
    };
    if (opts.fromPhone) this.deps.onNotice?.(`${np.singerName} changed their song to “${entry.song.title}”.`);
    this.changed();
    return entry;
  }

  /** The singer left from their phone: off the list, and off the stage if they were being called. */
  leaveFromPhone(singerId: string): void {
    const singer = this.singer(singerId);
    if (!singer) return;
    const np = this.state.nowPlaying;
    const called = np?.entry.singerId === singerId && np.stage === 'intro';
    if (called) this.undoCall(np.playId);
    this.removeSinger(singerId);
    this.deps.onNotice?.(`${singer.name} left and was taken off the list.`);
    if (called && this.state.settings.autoAdvance) this.callNext();
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
        return this.addEntry(singerId, action.song, { note: action.note, fromPhone: true, key: action.key }).id;
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
      case 'notNow':
        this.holdTurn(singerId);
        return null;
      case 'changeMySong': {
        const np = this.state.nowPlaying;
        if (np?.entry.singerId !== singerId) throw new UserError('You can change your song once you’re called up.');
        return this.changeStageSong(action.song, { fromPhone: true }).id;
      }
      case 'leave':
        this.leaveFromPhone(singerId);
        return null;
      default:
        throw new UserError('Unknown action.');
    }
  }

  // --- views -----------------------------------------------------------------

  private tipView(): NonNullable<SingerView['tip']> {
    const { tipLink, tipText, tipAmounts } = this.state.settings;
    const amounts = tipAmounts.flatMap((amount) => {
      const link = tipLinkWithAmount(tipLink, amount);
      return link ? [{ amount, link }] : [];
    });
    return { link: tipLink, text: tipText, amounts };
  }

  /**
   * A thank-you on the singer's phone for a while after their song ends. A song
   * the KJ cut off almost at once, or one that wouldn't play, doesn't count.
   */
  private tipPrompt(singerId: string): Pick<SingerView, 'tipPrompt'> {
    const np = this.state.nowPlaying;
    if (np?.entry.singerId === singerId) return {};
    const last = this.state.history.find((h) => h.entry.singerId === singerId);
    if (!last || this.now() - last.endedAt > TIP_PROMPT_MS) return {};
    const sang = last.outcome === 'finished' || (last.outcome === 'skipped' && last.endedAt - last.startedAt >= MIN_SUNG_MS);
    return sang ? { tipPrompt: { id: `${last.entry.id}:${last.endedAt}`, title: last.entry.song.title } } : {};
  }

  singerView(singerId: string | undefined, list: UpcomingItem[], youtubeSearch: boolean, hasLibrary = false): SingerView {
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
      ...(settings.tipLink ? { tip: this.tipView() } : {}),
      ...(me && settings.tipLink && settings.tipAfterSong ? this.tipPrompt(me.id) : {}),
      canBrowse: settings.allowBrowse && hasLibrary,
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

  displayView(list: UpcomingItem[], joinUrl: string, joinLabel: string, primary: boolean, mediaKey: string, youtube: YouTubeEmbed): DisplayView {
    return {
      showName: this.state.settings.showName,
      joinUrl,
      joinLabel,
      nowPlaying: this.state.nowPlaying,
      upNext: list.slice(0, 3).map((u) => ({ singerName: u.singer.name, title: u.entry.song.title, artist: u.entry.song.artist })),
      volume: this.state.settings.volume,
      ...(this.state.settings.tipLink ? { tip: { text: this.state.settings.tipText } } : {}),
      primary,
      mediaKey,
      youtube,
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

/** What a singer is told when they request a video that's kept off the list. */
export function blockedMessage(reason: 'refused' | 'not-karaoke' | undefined): string | undefined {
  if (reason === 'refused') return 'YouTube won’t play that video here. Pick another version of the song.';
  if (reason === 'not-karaoke') return 'The KJ marked that video as not a karaoke version. Pick a karaoke version of the song.';
  return undefined;
}

/** Give back the held turns an undone call-up counted down (holds asked for since then stay). */
function restoreHolds(singers: Singer[], snap: CallSnapshot | undefined): Singer[] {
  const holds = snap?.holds;
  if (!holds) return singers;
  return singers.map((s) => (holds[s.id] ? { ...s, holdTurns: Math.max(s.holdTurns ?? 0, holds[s.id]!) } : s));
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

/** The KJ's tip link as a clean https URL, or '' if it isn't one ("venmo.com/u/me" is taken as https). */
export function cleanTipLink(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.') ? u.toString().slice(0, 300) : '';
  } catch {
    return '';
  }
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
    allowBrowse: bool(s.allowBrowse, D.allowBrowse),
    breakMusic: bool(s.breakMusic, D.breakMusic),
    breakVolume: int(s.breakVolume, 0, 100, D.breakVolume),
    nameFilter: bool(s.nameFilter, D.nameFilter),
    blockedWords: parseWords(String(s.blockedWords ?? '')).join(', ').slice(0, 600),
    tipLink: cleanTipLink(s.tipLink),
    tipText: cleanText(s.tipText, 40) || D.tipText,
    tipAmounts: s.tipAmounts === undefined ? D.tipAmounts : parseTipAmounts(s.tipAmounts),
    tipAfterSong: bool(s.tipAfterSong, D.tipAfterSong),
    showSongsToSingers: bool(s.showSongsToSingers, D.showSongsToSingers),
    joinOpen: bool(s.joinOpen, D.joinOpen),
    autoAdvance: bool(s.autoAdvance, D.autoAdvance),
    autoStartSec: int(s.autoStartSec, 0, 120, D.autoStartSec),
    changeoverSec: int(s.changeoverSec, 0, 600, D.changeoverSec),
    defaultSongSec: int(s.defaultSongSec, 60, 900, D.defaultSongSec),
    volume: int(s.volume, 0, 100, D.volume),
  };
}
