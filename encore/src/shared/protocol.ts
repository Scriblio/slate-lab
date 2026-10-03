// Socket.IO event contracts between the server and the three clients.

import type { DisplayView, DjView, RotationMode, SearchResult, Settings, SingerView, Song, YouTubeMode } from './types.ts';
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
  | { type: 'addEntry'; singerId: string; song: SongRef; note?: string }
  | { type: 'removeEntry'; entryId: string }
  | { type: 'moveEntry'; entryId: string; toIndex: number }
  | { type: 'approveEntry'; entryId: string }
  | { type: 'approveAll' }
  | { type: 'pinEntry'; entryId: string }
  | { type: 'unpinEntry'; entryId: string }
  | { type: 'callNext' }
  | { type: 'callEntry'; entryId: string }
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

export type SingerAction =
  | { type: 'request'; song: SongRef; note?: string }
  | { type: 'removeMyEntry'; entryId: string }
  | { type: 'moveMyEntry'; entryId: string; direction: -1 | 1 }
  | { type: 'setAway'; away: boolean }
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
  'singer:view': (view: SingerView) => void;
  'singer:removed': () => void;
  'display:view': (view: DisplayView) => void;
  'player:cmd': (p: { playId: string } & PlayerCommand) => void;
}

export type Role = 'dj' | 'display' | 'singer';

export interface HandshakeAuth {
  role?: Role;
  pin?: string;
}
