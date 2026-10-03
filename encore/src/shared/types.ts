// Domain model shared by the server, the DJ console, the venue display and
// the phone sign-up page. The server owns the one authoritative ShowState;
// every client sees a view of it shaped for its role.

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
}

export interface Entry {
  id: string;
  singerId: string;
  song: Song;
  requestedAt: number;
  /** Phone requests wait in "pending" when the KJ requires approval. */
  status: 'pending' | 'queued';
  note?: string;
}

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

export interface SearchResult {
  song: Song;
  /** Library tracks carry their disc id; YouTube results carry their channel. */
  detail?: string;
  /** Already queued or sung tonight. */
  playedTonight?: boolean;
}

/** What a phone sees. Never includes other singers' private details. */
export interface SingerView {
  showName: string;
  joinOpen: boolean;
  allowYouTube: boolean;
  youtubeSearch: boolean;
  maxQueuedPerSinger: number;
  me: Singer | null;
  myEntries: Entry[];
  /** Position (1-based) of my next performance in the upcoming list. */
  myNextPosition: number | null;
  myNextEtaSec: number | null;
  nowPlaying: { singerName: string; title?: string; artist?: string; stage: Stage; isMe: boolean } | null;
  upcoming: { singerName: string; title?: string; artist?: string; isMe: boolean; etaSec: number }[];
  mode: RotationMode;
}

/** What the venue screen sees. */
export interface DisplayView {
  showName: string;
  joinUrl: string;
  nowPlaying: NowPlaying | null;
  upNext: { singerName: string; title: string; artist: string }[];
  volume: number;
  primary: boolean;
  /** Appended to /media URLs; only the KJ and displays are given it. */
  mediaKey: string;
}

/** What the KJ console sees. */
export interface DjView {
  show: ShowState;
  upcoming: UpcomingItem[];
  joinUrl: string;
  library: LibraryStatus;
  youtubeSearch: boolean;
  displays: number;
  mediaKey: string;
}
