// Text helpers: turning karaoke filenames and YouTube titles into
// artist/title pairs, and normalising strings for search.

/** What counts as "the same name" for sign-ups: "Matt", " matt ", "MATT (2)" all match. */
export function nameKey(name: string): string {
  return normalize(name.replace(/\s*\(\d+\)\s*$/, ''));
}

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Catalog ids look like SC8125-01, SF001-07, CB30042-03, PHM1203-11, ZM-1234,
// or a bare number. Uppercase only, so band names like "Blink-182" survive.
const DISC_ID = /^(?:[A-Z]{1,6}[-_ ]?\d{2,}(?:[-_ ]?\d{1,3})?[A-Z]?|\d{3,}(?:-\d{1,3})?)$/;

const NOISE = [
  /\((?:[^)]*\b(?:karaoke|instrumental|backing track|lyrics?|official|hd|4k|no vocals?|with vocals?|minus one|sing ?along)\b[^)]*)\)/gi,
  /\[(?:[^\]]*\b(?:karaoke|instrumental|backing track|lyrics?|official|hd|4k|no vocals?|with vocals?|minus one|sing ?along)\b[^\]]*)\]/gi,
  /\b(?:karaoke version|karaoke|instrumental version|with lyrics|lyrics video|backing track)\b/gi,
];

export function stripNoise(s: string): string {
  let out = s;
  for (const re of NOISE) out = out.replace(re, ' ');
  return out
    .replace(/\s*[|•·]\s*$/g, '')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—|:]+|[\s\-–—|:]+$/g, '')
    .trim();
}

export interface ParsedName {
  artist: string;
  title: string;
  discId?: string;
}

export type FilenameOrder = 'artist-title' | 'title-artist';

/**
 * Parse a karaoke filename (without extension). Handles the common
 * "DISCID - Artist - Title", "Artist - Title" and "DISCID - Title - Artist"
 * shapes; `order` says which way round the two text parts go.
 */
export function parseFilename(base: string, order: FilenameOrder = 'artist-title'): ParsedName {
  const cleaned = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  let parts = cleaned.split(/\s+[-–—]\s+|\s*~\s*/).map((p) => p.trim()).filter(Boolean);
  let discId: string | undefined;
  if (parts.length >= 2 && DISC_ID.test(parts[0]!)) {
    discId = parts[0]!;
    parts = parts.slice(1);
  }
  if (parts.length === 0) return { artist: '', title: stripNoise(cleaned), discId };
  if (parts.length === 1) return { artist: '', title: stripNoise(parts[0]!), discId };
  const [a, ...rest] = parts;
  const first = stripNoise(a!);
  const second = stripNoise(rest.join(' - '));
  return order === 'artist-title'
    ? { artist: first, title: second, discId }
    : { artist: second, title: first, discId };
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Extract an 11-character video id from any common YouTube URL, or a bare id. */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (!id && m) id = m[1]!;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

/** "3:45" / "1:02:03" */
/** A key change for display: "+2", "−3" (a real minus sign), or "" for the original key. */
export function formatKey(semitones: number | undefined): string {
  if (!semitones) return '';
  return semitones > 0 ? `+${semitones}` : `−${-semitones}`;
}

export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '–:––';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "now", "~4 min", "~1 hr 10 min" */
export function formatWait(sec: number): string {
  if (sec < 45) return 'now';
  const min = Math.round(sec / 60);
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `~${h} hr ${rem} min` : `~${h} hr`;
}

/** ISO-8601 duration (PT4M13S) from the YouTube API, to seconds. */
export function parseIsoDuration(iso: string): number | undefined {
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return undefined;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
}
