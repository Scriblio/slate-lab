// Keeps what YouTube told Encore about a video for no more than 30 days.
//
// YouTube's developer policies (III.E.4) let an app keep what it gets from the YouTube API (a video's
// title, channel name, thumbnail and length) for at most 30 days, and then it must delete or refresh it.
// Encore's show records hold those details for every YouTube song that was requested: tonight's list, the
// history, and the archive of each past show in the data folder. Once a request or a performance is 30
// days old its details are deleted: the title becomes "YouTube video", and the channel name, thumbnail
// address and length go. The video's id stays, so the record still points at the video, and nothing else
// changes (the singer, the times, how it went).
//
// The server side keeps to the same limit: the search service's cache, reports and catalog are deleted at
// 30 days (supabase/migrations). Encore's one other copy, the ids of videos that wouldn't play, is
// forgotten after 30 days in ytguard.ts.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, HistoryItem, ShowState } from '../shared/types.ts';
import { writeFileAtomic } from './atomicfile.ts';

/** How long Encore keeps what YouTube told it about a video. */
export const YOUTUBE_DATA_MS = 30 * 24 * 60 * 60 * 1000;
/** What a YouTube video is called once its details are gone. */
export const FORGOTTEN_TITLE = 'YouTube video';

type Records = Pick<ShowState, 'entries' | 'history'>;

/** A YouTube request with the details YouTube gave removed; anything else comes back untouched. */
function forgetEntry(entry: Entry): Entry {
  const { song } = entry;
  if (song.source.kind !== 'youtube') return entry;
  const gone = song.title === FORGOTTEN_TITLE && !song.artist && song.thumbnail === undefined && song.durationSec === undefined && entry.swappedFrom === undefined;
  if (gone) return entry;
  const { swappedFrom: _title, ...rest } = entry;
  return { ...rest, song: { title: FORGOTTEN_TITLE, artist: '', source: song.source } };
}

/** The same list when nothing in it changed, so callers can tell cheaply. */
function mapChanged<T>(list: T[], f: (item: T) => T): T[] {
  let changed = false;
  const out = list.map((item) => {
    const next = f(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : list;
}

/**
 * The show's records with YouTube's details removed from every YouTube song requested (still queued) or
 * performed (in the history) 30 days ago or more. Returns the same object when there is nothing to remove.
 */
export function forgetOldYouTube<S extends Records>(state: S, now: number): S {
  const old = (at: number) => now - at >= YOUTUBE_DATA_MS;
  // A list that's missing (a very old file) is left as it is.
  const entries = Array.isArray(state.entries) ? mapChanged(state.entries, (e) => (old(e.requestedAt) ? forgetEntry(e) : e)) : state.entries;
  const history = Array.isArray(state.history)
    ? mapChanged<HistoryItem>(state.history, (h) => {
        if (!old(h.endedAt)) return h;
        const entry = forgetEntry(h.entry);
        return entry === h.entry ? h : { ...h, entry };
      })
    : state.history;
  if (entries === state.entries && history === state.history) return state;
  return { ...state, entries, history };
}

/** When a past show began, from its file name ("2026-10-18-19-30-<id>.json", in UTC). */
function beganAt(name: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-/.exec(name);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : undefined;
}

/**
 * Do the same to the archive of past shows in the data folder. A show that began less than 30 days ago can't
 * hold anything that old, so those files aren't opened. Returns how many files were changed.
 */
export async function forgetOldYouTubeInPastShows(dataDir: string, now: number): Promise<number> {
  const dir = join(dataDir, 'past-shows');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no past shows yet
  }
  let changed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const began = beganAt(name);
    if (began !== undefined && now - began < YOUTUBE_DATA_MS) continue;
    const file = join(dir, name);
    try {
      const show = JSON.parse(await readFile(file, 'utf8')) as ShowState;
      if (!show || typeof show !== 'object') continue;
      const next = forgetOldYouTube(show, now);
      if (next === show) continue;
      await writeFileAtomic(file, JSON.stringify(next, null, 1));
      changed++;
    } catch {
      // Not readable, or not one of ours: leave it alone.
    }
  }
  return changed;
}
