// Checks queued YouTube songs ahead of time, in a small preview player on
// the console, so a video YouTube won't play here is caught (and swapped for
// another version) before its singer is on stage. The card stays a one-line
// summary and only opens its preview while a check is running.

import { useEffect, useRef, useState } from 'react';
import { YOUTUBE_REFUSALS } from '../../shared/protocol.ts';
import type { UpcomingItem } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { checkYouTube, type YouTubeHandle } from '../common/youtube-embed.ts';
import { useDj } from './context.ts';

/** Wait this long before retrying a video whose check didn't finish (offline, say). */
const RETRY_MS = 3 * 60_000;

const videoId = (u: UpcomingItem) => (u.entry.song.source.kind === 'youtube' ? u.entry.song.source.videoId : '');

export function YouTubeCheck() {
  const { view, act } = useDj();
  const yt = view.youtube;
  const queue = view.upcoming.filter((u) => u.entry.song.source.kind === 'youtube').slice(0, 6);
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<YouTubeHandle | null>(null);
  // One check at a time; `running` survives re-renders, `checking` drives the UI.
  const running = useRef<string | null>(null);
  const mounted = useRef(true);
  const [checking, setChecking] = useState<string | null>(null);
  const [inconclusive, setInconclusive] = useState<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const next = queue.map(videoId).find((id) => !yt.status[id] && !(now - (inconclusive[id] ?? 0) < RETRY_MS));

  useEffect(
    () => () => {
      mounted.current = false;
      preview.current?.destroy();
    },
    [],
  );

  useEffect(() => {
    if (!next || running.current || !host.current) return;
    const id = next;
    preview.current?.destroy();
    const { result, handle } = checkYouTube(host.current, yt.frameUrl, id);
    preview.current = handle;
    running.current = id;
    setChecking(id);
    void result.then(async (r) => {
      if (!mounted.current) return;
      // Close the preview: a player is only on screen while it's checking.
      handle.destroy();
      if (preview.current === handle) preview.current = null;
      if (r.ok) await act({ type: 'youtubeCheck', videoId: id, ok: true, mode: r.mode });
      else if (YOUTUBE_REFUSALS.includes(r.code)) await act({ type: 'youtubeCheck', videoId: id, ok: false });
      else setInconclusive((m) => ({ ...m, [id]: Date.now() }));
      running.current = null;
      setChecking(null);
      setTick((t) => t + 1);
    });
    // Runs again when there's a different video to check, or a check finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next, tick]);

  if (queue.length === 0) return null;
  const ready = queue.filter((u) => yt.status[videoId(u)] === 'ok').length;
  const problems = queue.filter((u) => u.entry.wontPlay).length;
  // Shown from the render before a check starts, so the player is never created hidden.
  const previewing = Boolean(checking || next);

  return (
    <div className={`card yt-check-card ${problems ? 'has-problem' : ''}`}>
      <button className="yt-check-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.YouTube className="yt-icon" />
        <span className="yt-check-title">YouTube check</span>
        <span className={`small ${problems ? 'problem' : 'muted'}`}>
          {checking ? 'checking…' : problems ? `${problems} won’t play` : `${ready} of ${queue.length} ready`}
        </span>
        <I.ChevronDown className={open ? 'flip' : ''} />
      </button>
      <div className="yt-preview" ref={host} hidden={!previewing} />
      {open && (
        <ul className="yt-check-list">
          {queue.map((u) => {
            const id = videoId(u);
            const s = yt.status[id];
            const e = u.entry;
            return (
              <li key={e.id} className="yt-check-row">
                {e.wontPlay ? (
                  <I.Alert className="bad" />
                ) : s === 'ok' ? (
                  <I.Check className="good" />
                ) : s === 'refused' || checking === id ? (
                  <I.Loader />
                ) : (
                  <span className="dot-wait" />
                )}
                <div className="ellipsis">
                  <div className="ellipsis">
                    <strong>{u.singer.name}</strong> · {e.song.title}
                  </div>
                  <div className="muted small ellipsis">
                    {e.wontPlay
                      ? 'YouTube won’t play it here and no other version turned up. Pick one in the finder.'
                      : s === 'ok'
                        ? e.swappedFrom
                          ? `Plays here. Swapped in for “${e.swappedFrom}”.`
                          : 'Plays here.'
                        : s === 'refused'
                          ? 'YouTube won’t play it here. Finding another version…'
                          : checking === id
                            ? 'Checking…'
                            : 'Waiting to be checked.'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
