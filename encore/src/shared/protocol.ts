// Socket.IO event contracts between the server and the three clients.

import type { SongKey } from './songkey.ts';
import type { BrowseRequest, BrowseResult, DisplayView, DjView, RotationMode, SearchResult, Settings, SingerView, Song, YouTubeMode } from './types.ts';
import type { FilenameOrder } from './text.ts';

/** What a client may send to describe a song; the server rebuilds the rest. */
export type SongRef =
  | { kind: 'local'; trackId: string }
  | { kind: 'youtube'; videoId: string; title?: string; artist?: string; durationSec?: number };

/** The reference a client sends for a song it found in search. */
export function songRef(song: Song): SongRef {
  return song.source.kind === 'local'
    ? { kind: 'local', trackId: song.source.trackId }
    : { kind: 'youtube', videoId: song.source.videoId, title: song.title, artist: song.artist, durationSec: song.durationSec };
}

/** YouTube player errors meaning a video won't play here: bad id, removed, or embedding refused. */
export const YOUTUBE_REFUSALS: readonly number[] = [2, 100, 101, 150, 152];

export type Ack<T = undefined> = (res: { ok: true; data: T } | { ok: false; error: string; code?: string }) => void;

export interface ServerConfigView {
  libraryFolders: string[];
  filenameOrder: FilenameOrder;
  /** 'built-in': through Encore's search service; 'own-key': a developer's YOUTUBE_API_KEY. */
  youtubeSearch: 'built-in' | 'own-key' | 'off';
  djPin: string;
  publicUrl?: string;
  /** This build has an online join link configured. */
  onlineJoinAvailable: boolean;
  onlineJoin: boolean;
}

export type PlayerCommand =
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'seek'; to: number }
  | { cmd: 'volume'; value: number };

export type DjAction =
  | { type: 'setMode'; mode: RotationMode }
  | { type: 'updateSettings'; patch: Partial<Settings> }
  | { type: 'addSinger'; name: string }
  | { type: 'renameSinger'; singerId: string; name: string }
  | { type: 'removeSinger'; singerId: string }
  | { type: 'mergeSingers'; fromId: string; intoId: string }
  | { type: 'setSingerStatus'; singerId: string; status: 'active' | 'away' }
  | { type: 'moveSinger'; singerId: string; toIndex: number }
  | { type: 'addEntry'; singerId: string; song: SongRef; note?: string; key?: number }
  /** Key change for a library song, queued or on stage (semitones, −6 to +6). */
  | { type: 'setKey'; entryId: string; key: number }
  /**
   * A library track's original key: detected by the console from the audio,
   * or set by the KJ (which always wins). null forgets it.
   */
  | { type: 'setSongKey'; trackId: string; key: { tonic: number; mode: 'major' | 'minor' } | null; detected?: boolean }
  | { type: 'removeEntry'; entryId: string }
  | { type: 'moveEntry'; entryId: string; toIndex: number }
  | { type: 'approveEntry'; entryId: string }
  | { type: 'approveAll' }
  | { type: 'pinEntry'; entryId: string }
  | { type: 'unpinEntry'; entryId: string }
  | { type: 'callNext' }
  | { type: 'callEntry'; entryId: string }
  /** Give the singer on stage a different song; it goes up on the intro card. */
  | { type: 'changeStageSong'; song: SongRef }
  /** This YouTube request isn't a karaoke version: remove it and hide the video from searches. */
  | { type: 'notKaraoke'; entryId: string }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'restart' }
  | { type: 'seekBy'; seconds: number }
  | { type: 'skip' }
  | { type: 'noShow' }
  | { type: 'stop' }
  | { type: 'setVolume'; volume: number }
  | { type: 'newShow' }
  | { type: 'rescanLibrary' }
  /** From the console's preview player: whether a queued YouTube video plays here. */
  | { type: 'youtubeCheck'; videoId: string; ok: boolean; mode?: YouTubeMode }
  | { type: 'setConfig'; libraryFolders?: string[]; filenameOrder?: FilenameOrder; onlineJoin?: boolean };

/** A Web Push subscription, as the browser's PushSubscription.toJSON() gives it. */
export interface PushSubscriptionRef {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export type SingerAction =
  /** key: semitones up or down, for library songs. */
  | { type: 'request'; song: SongRef; note?: string; key?: number }
  | { type: 'removeMyEntry'; entryId: string }
  | { type: 'moveMyEntry'; entryId: string; direction: -1 | 1 }
  | { type: 'setAway'; away: boolean }
  /** "Can't sing right now": let the next couple of singers go first. */
  | { type: 'notNow' }
  /** Once called up: sing this instead (one of my songs, or a new one). */
  | { type: 'changeMySong'; song: SongRef }
  /** Lock-screen alerts: send "you're up" to this phone even when it's locked. */
  | { type: 'pushSubscribe'; subscription: PushSubscriptionRef }
  | { type: 'pushUnsubscribe' }
  | { type: 'leave' };

export interface ClientToServer {
  'dj:action': (action: DjAction, ack: Ack<unknown>) => void;
  'dj:config': (ack: Ack<ServerConfigView>) => void;
  'singer:join': (name: string, ack: Ack<{ token: string; singerId: string }>) => void;
  'singer:resume': (token: string, ack: Ack<{ singerId: string }>) => void;
  /** Get back into an existing spot from another phone or browser. */
  'singer:reclaim': (name: string, code: string, ack: Ack<{ token: string; singerId: string }>) => void;
  'singer:action': (action: SingerAction, ack: Ack<unknown>) => void;
  search: (query: string, ack: Ack<SearchResult[]>) => void;
  /** A page of the whole library list, for scrolling through on a phone. */
  browse: (req: BrowseRequest, ack: Ack<BrowseResult>) => void;
  /**
   * A library song's original key, so a phone can say which key a change lands
   * in. If it isn't known yet, the KJ's console is asked to work it out now
   * (this waits a few seconds for it); null when it can't be told.
   */
  songKey: (trackId: string, ack: Ack<SongKey | null>) => void;
  searchYouTube: (query: string, ack: Ack<SearchResult[]>) => void;
  lookupYouTube: (urlOrId: string, ack: Ack<SearchResult>) => void;
  'display:progress': (p: { playId: string; position: number; duration?: number }) => void;
  'display:ended': (p: { playId: string }) => void;
  /** code: the YouTube player's error code, when it was a YouTube error. */
  'display:error': (p: { playId: string; message: string; code?: number }) => void;
}

export interface ServerToClient {
  'dj:view': (view: DjView) => void;
  'dj:progress': (p: { playId: string; position: number; duration?: number }) => void;
  /** Something the KJ should see right away, e.g. a singer left from their phone. */
  'dj:notice': (p: { text: string }) => void;
  /** A phone is about to pick this song: work out its key now (the console does, in the background). */
  'dj:detect': (p: { trackId: string }) => void;
  'singer:view': (view: SingerView) => void;
  'singer:removed': () => void;
  /** Something this singer should know, e.g. the KJ removed a song that wasn't karaoke. */
  'singer:notice': (p: { text: string }) => void;
  'display:view': (view: DisplayView) => void;
  'player:cmd': (p: { playId: string } & PlayerCommand) => void;
}

export type Role = 'dj' | 'display' | 'singer';

export interface HandshakeAuth {
  role?: Role;
  pin?: string;
}
