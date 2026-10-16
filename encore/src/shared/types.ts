// Domain model shared by the server, the DJ console, the venue display and
// the phone sign-up page. The server owns the one authoritative ShowState;
// every client sees a view of it shaped for its role.

import type { LicenseView } from './license.ts';
import type { SongKey } from './songkey.ts';
import { DEFAULT_TIP_AMOUNTS } from './tips.ts';

export type RotationMode = 'rotation' | 'fair' | 'fifo' | 'shuffle';

export const ROTATION_MODES: { id: RotationMode; label: string; blurb: string }[] = [
  {
    id: 'rotation',
    label: 'Classic Rotation',
    blurb: 'Everyone sings once before anyone sings twice. New singers join the bottom. Drag to reorder.',
  },
  {
    id: 'fair',
    label: 'Fair Play',
    blurb: 'Fewest songs tonight goes first; ties go to whoever has waited longest. Newcomers get on fast.',
  },
  {
    id: 'fifo',
    label: 'First Come',
    blurb: 'Songs play in the order they were requested, no matter who asked.',
  },
  {
    id: 'shuffle',
    label: 'Shuffle Rounds',
    blurb: 'Everyone still sings once per round, but the order is reshuffled every round.',
  },
];

export type LocalFormat = 'video' | 'mp3+g' | 'zip' | 'audio';

export type SongSource =
  | { kind: 'local'; trackId: string; format: LocalFormat }
  | { kind: 'youtube'; videoId: string };

export interface Song {
  title: string;
  artist: string;
  source: SongSource;
  /** Seconds, when known. Used for wait-time estimates. */
  durationSec?: number;
  thumbnail?: string;
}

export interface Singer {
  id: string;
  name: string;
  joinedAt: number;
  /** "away" singers keep their place and songs but are skipped. */
  status: 'active' | 'away';
  songsSung: number;
  lastSangAt?: number;
  /** True when the singer signed up from their phone (vs. added by the KJ). */
  fromPhone: boolean;
  /**
   * "Can't sing right now": let this many performances by others go first.
   * Counts down as others are called; the singer keeps their songs and place.
   */
  holdTurns?: number;
  /**
   * 4-digit code that gets a singer back into their spot from another
   * phone or browser. Shown to the singer themselves and to the KJ only.
   */
  code: string;
}

export interface Entry {
  id: string;
  singerId: string;
  song: Song;
  requestedAt: number;
  /** Phone requests wait in "pending" when the KJ requires approval. */
  status: 'pending' | 'queued';
  note?: string;
  /** Title of the YouTube video Encore swapped out because YouTube wouldn't play it here. */
  swappedFrom?: string;
  /** How many times Encore has swapped this request's video. */
  swaps?: number;
  /** YouTube won't play this video here and Encore found no other version. */
  wontPlay?: boolean;
  /**
   * Key change in semitones (−6 to +6), library songs only; absent means the
   * original key. YouTube songs can't change key: they play in YouTube's own player.
   */
  key?: number;
}

/** How the YouTube player is embedded: from Encore's site, or straight into the page. */
export type YouTubeMode = 'site' | 'direct';

export type Stage = 'intro' | 'playing' | 'paused';

export interface NowPlaying {
  /** Changes every time something new is loaded; the display keys off it. */
  playId: string;
  entry: Entry;
  singerName: string;
  stage: Stage;
  calledAt: number;
  startedAt?: number;
  /** Last position reported by the display, in seconds. */
  position: number;
  duration?: number;
  /** Epoch ms at which an auto-start countdown fires, if one is running. */
  autoStartAt?: number;
  error?: string;
}

export interface HistoryItem {
  entry: Entry;
  singerName: string;
  startedAt: number;
  endedAt: number;
  outcome: 'finished' | 'skipped' | 'error';
}

export interface Settings {
  showName: string;
  requireApproval: boolean;
  /** 0 = unlimited songs waiting per singer. */
  maxQueuedPerSinger: number;
  allowYouTube: boolean;
  /** Let singers scroll through the whole library list on their phones. */
  allowBrowse: boolean;
  /**
   * Auto play: break music plays by itself whenever nothing is on stage. Off,
   * it plays only after the KJ presses Play, until Stop or the next song.
   */
  breakMusic: boolean;
  /** How loud the break music is, 0-100 (separate from the karaoke volume). */
  breakVolume: number;
  /** Refuse rude names, since they go up on the venue screen. */
  nameFilter: boolean;
  /** The KJ's own words to refuse as well, separated by commas. */
  blockedWords: string;
  /** Where tips go: the KJ's Venmo, Cash App or PayPal.me link (https only). Empty turns the tip QR off. */
  tipLink: string;
  /** What the tip QR and button say. */
  tipText: string;
  /** Quick-tip amounts for phones (Venmo, Cash App and PayPal.me links only). Empty: just the one button. */
  tipAmounts: number[];
  /** Ask each singer for a tip on their phone once their song ends. */
  tipAfterSong: boolean;
  /** Let phones see song titles for other singers in the queue. */
  showSongsToSingers: boolean;
  joinOpen: boolean;
  /** Call the next singer automatically when a song ends. */
  autoAdvance: boolean;
  /** Seconds the intro card shows before auto-start. 0 = wait for the KJ. */
  autoStartSec: number;
  changeoverSec: number;
  defaultSongSec: number;
  volume: number;
}

export const DEFAULT_SETTINGS: Settings = {
  showName: 'Karaoke Night',
  requireApproval: false,
  maxQueuedPerSinger: 3,
  allowYouTube: true,
  allowBrowse: true,
  breakMusic: true,
  breakVolume: 60,
  nameFilter: true,
  blockedWords: '',
  tipLink: '',
  tipText: 'Tip your KJ',
  tipAmounts: DEFAULT_TIP_AMOUNTS,
  tipAfterSong: true,
  showSongsToSingers: false,
  joinOpen: true,
  autoAdvance: true,
  autoStartSec: 0,
  changeoverSec: 45,
  defaultSongSec: 240,
  volume: 100,
};

export interface ShowState {
  id: string;
  createdAt: number;
  mode: RotationMode;
  settings: Settings;
  /** Array order is the rotation order (Classic and Shuffle modes). */
  singers: Singer[];
  /** Every request not yet performed, in the order it was made. */
  entries: Entry[];
  round: number;
  sungThisRound: string[];
  /** Entry ids the KJ forced to the front, in order. */
  playNext: string[];
  nowPlaying: NowPlaying | null;
  history: HistoryItem[];
}

export interface UpcomingItem {
  entry: Entry;
  singer: Singer;
  /** Round the performance falls in (Classic / Shuffle); 0 when not round-based. */
  round: number;
  /** Seconds from now until this performance is expected to start. */
  etaSec: number;
  pinned: boolean;
}

export interface LibraryTrack {
  id: string;
  artist: string;
  title: string;
  format: LocalFormat;
  /** Disc / catalog id parsed from the filename, e.g. "SC8125-01". */
  discId?: string;
  path: string;
}

export interface LibraryStatus {
  folders: string[];
  trackCount: number;
  scanning: boolean;
  lastScanAt?: number;
  errors: string[];
}

/** One page of the library list a singer scrolls through on their phone. */
export interface BrowseRequest {
  /** The order: by artist (then title) or by title (then artist). */
  sort: 'artist' | 'title';
  /** Start this far into the list. Ignored when `letter` is given. */
  offset?: number;
  /** Start at the first song under this letter ('A'-'Z', or '#' for digits and symbols). */
  letter?: string;
  limit?: number;
}

export interface BrowseResult {
  items: SearchResult[];
  /** Songs in the whole list (each song once, however many files it has). */
  total: number;
  /** Where `items` starts in the list. */
  offset: number;
  /** The letters that have songs, in order, for the jump bar. */
  letters: string[];
}

export interface SearchResult {
  song: Song;
  /** Library tracks carry their disc id; YouTube results carry their channel. */
  detail?: string;
  /** Already queued or sung tonight. */
  playedTonight?: boolean;
  /** On a phone: the key this singer sang this library song in last time. */
  lastKey?: number;
  /** The library song's original key, when Encore knows it. */
  songKey?: SongKey;
}

/** What a phone sees. Never includes other singers' private details. */
export interface SingerView {
  showName: string;
  joinOpen: boolean;
  /**
   * There's no show to join yet: the KJ's Encore isn't unlocked. The phone says "This show isn't open
   * yet. Ask the KJ." and nothing else; singers are never shown plans, prices or upgrade buttons.
   */
  notOpen?: boolean;
  allowYouTube: boolean;
  youtubeSearch: boolean;
  /** The KJ lets singers scroll through the library, and there is a library. */
  canBrowse: boolean;
  maxQueuedPerSinger: number;
  me: Singer | null;
  myEntries: Entry[];
  /** Position (1-based) of my next performance in the upcoming list. */
  myNextPosition: number | null;
  myNextEtaSec: number | null;
  /**
   * The KJ's tip link, for a button in the line. `amounts` are quick-tip
   * buttons that open the payment app with the amount filled in (only for
   * links that can do that). Absent when no tip link is set.
   */
  tip?: { link: string; text: string; amounts: { amount: number; link: string }[] };
  /** This singer's song just ended: their phone thanks them and offers the tip buttons, once. */
  tipPrompt?: { id: string; title: string };
  nowPlaying: { singerName: string; title?: string; artist?: string; stage: Stage; isMe: boolean } | null;
  upcoming: { singerName: string; title?: string; artist?: string; isMe: boolean; etaSec: number }[];
  mode: RotationMode;
  /**
   * Lock-screen alerts (only with the online link): the key phones subscribe
   * with, and whether this singer has alerts on.
   */
  push?: { key: string; on: boolean };
  /** Original keys of the library songs in my list, by track id. */
  songKeys?: Record<string, SongKey>;
}

/** One song or video in the break music folder. */
export interface BreakTrack {
  /** Same kind of id as a library track; the file is served at /media/<id>/main. */
  id: string;
  title: string;
  artist: string;
  /** Videos play full screen; audio plays over motion graphics. */
  kind: 'audio' | 'video';
}

/** The break music folder, and what is playing from it. */
export interface BreakStatus {
  folders: string[];
  tracks: number;
  /** Karaoke songs (MP3+G, zips) found in the folder, which break music leaves out. */
  karaoke: number;
  scanning: boolean;
  errors: string[];
  /** Nothing is on stage, so music should be playing now (unless paused). */
  on: boolean;
  paused: boolean;
  track: BreakTrack | null;
}

/** What the venue screen sees. */
export interface DisplayView {
  showName: string;
  joinUrl: string;
  /** Short, readable form of the join link for the screen. */
  joinLabel: string;
  nowPlaying: NowPlaying | null;
  upNext: { singerName: string; title: string; artist: string }[];
  volume: number;
  primary: boolean;
  /** Appended to /media URLs; only the KJ and displays are given it. */
  mediaKey: string;
  youtube: YouTubeEmbed;
  /** The audio output device to play through ('' or absent: the system default). */
  audioOutput?: string;
  /** A tip QR code (at /api/tip-qr.svg) goes up between songs; absent when the KJ hasn't set one. */
  tip?: { text: string };
  /** Break music: absent when no break music folder has anything in it. */
  breakMusic?: {
    on: boolean;
    paused: boolean;
    /** 0-100. */
    volume: number;
    /** Changes with every track, so the screen starts the new one. */
    nonce: number;
    track: BreakTrack | null;
  };
}

/** Where YouTube players load from, and what Encore knows about tonight's videos. */
export interface YouTubeEmbed {
  /** Page on Encore's site that hosts the player (absent when offline features are off). */
  frameUrl?: string;
  /** Results of checking videos in the queue: 'ok' plays here, 'refused' doesn't. */
  status: Record<string, 'ok' | 'refused'>;
  /** The embedding that worked for each video that plays. */
  modes: Record<string, YouTubeMode>;
}

/** What the KJ console sees. */
export interface DjView {
  show: ShowState;
  upcoming: UpcomingItem[];
  joinUrl: string;
  joinLabel: string;
  /**
   * The join link for printed QR codes (served as /api/print-qr.svg). `lasting`
   * is false when it's this laptop's Wi-Fi address, which can change.
   */
  print: { url: string; label: string; lasting: boolean };
  relay: {
    /**
     * 'off': turned off or not configured. 'offline': no internet / relay down.
     * 'page-down': the relay works but the join page doesn't load yet.
     */
    state: 'off' | 'connecting' | 'online' | 'offline' | 'page-down';
    lanUrl: string;
    /** Where the online join page lives, e.g. sing.scriblio.co. */
    onlineHost?: string;
    /** Phones currently connected through the online link. */
    phones: number;
  };
  library: LibraryStatus;
  youtubeSearch: boolean;
  youtube: YouTubeEmbed;
  displays: number;
  mediaKey: string;
  /** Original keys of the library songs in the queue and on stage, by track id. */
  songKeys: Record<string, SongKey>;
  breakMusic: BreakStatus;
  /** The audio output device the screen plays through ('' = system default). */
  audioOutput: string;
  /** The KJ's plan: sign-in, free trial, unlock code. Only the console ever sees this. */
  license: LicenseView;
}
