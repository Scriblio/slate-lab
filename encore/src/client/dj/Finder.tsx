// Right column: find songs (library + YouTube), approve requests, history.

import { useEffect, useState, type RefObject } from 'react';
import { songRef } from '../../shared/protocol.ts';
import { keyLabel } from '../../shared/songkey.ts';
import { formatDuration, parseYouTubeId } from '../../shared/text.ts';
import type { SearchResult, Song } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { request } from '../common/socket.ts';
import { SongThumb, SourceBadge, useDebounced, useToast, YouTubeTerms } from '../common/ui.tsx';
import { useDj } from './context.ts';
import { NotKaraokeButton } from './NotKaraoke.tsx';

type Tab = 'search' | 'requests' | 'history';

export function Finder({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { view } = useDj();
  const [tab, setTab] = useState<Tab>('search');
  const pending = view.show.entries.filter((e) => e.status === 'pending').length;

  // "Add a song" elsewhere in the console: switch to search and focus it.
  useEffect(() => {
    const onFind = () => {
      setTab('search');
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('encore:find', onFind);
    return () => window.removeEventListener('encore:find', onFind);
  }, [inputRef]);

  return (
    <div className="card finder-card">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>
          <I.Search /> Songs
        </button>
        <button role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>
          <I.Inbox /> Requests {pending > 0 && <span className="count hot">{pending}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
          <I.History /> Tonight <span className="count">{view.show.history.length}</span>
        </button>
      </div>
      <div className={tab === 'search' ? 'tab-pane' : 'tab-pane hidden'}>
        <SongSearch inputRef={inputRef} />
      </div>
      {tab === 'requests' && <Requests />}
      {tab === 'history' && <HistoryList />}
    </div>
  );
}

function SongSearch({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const { view, act, socket, target, setTarget, stageSwap, setStageSwap } = useDj();
  const np = view.show.nowPlaying;
  // Picking a replacement for the song on stage (until that performance changes).
  const swapping = np && stageSwap === np.playId ? np : null;
  const theirList = swapping ? view.show.entries.filter((e) => e.singerId === swapping.entry.singerId) : [];
  const toast = useToast();
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 200);
  const [local, setLocal] = useState<SearchResult[] | null>(null);
  const [yt, setYt] = useState<{ q: string; results: SearchResult[] } | null>(null);
  const [linked, setLinked] = useState<SearchResult | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const ytId = parseYouTubeId(q);
  const singer = view.show.singers.find((s) => s.id === target);
  const lib = view.library;

  useEffect(() => {
    let live = true;
    if (!query || ytId) return setLocal(null);
    request<SearchResult[]>(socket, 'search', query)
      .then((r) => live && setLocal(r))
      .catch(() => live && setLocal([]));
    return () => {
      live = false;
    };
  }, [query, ytId, socket, lib.trackCount]);

  useEffect(() => {
    setLinked(null);
    if (!ytId) return;
    let live = true;
    request<SearchResult>(socket, 'lookupYouTube', ytId)
      .then((r) => live && setLinked(r))
      .catch((e: Error) => live && toast(e.message, 'error'));
    return () => {
      live = false;
    };
  }, [ytId, socket, toast]);

  async function searchYouTube() {
    if (!query || ytId) return;
    setYtBusy(true);
    try {
      setYt({ q: query, results: await request<SearchResult[]>(socket, 'searchYouTube', query) });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setYtBusy(false);
    }
  }

  async function add(song: Song, pin: boolean) {
    if (swapping) {
      const ok = await act({ type: 'changeStageSong', song: songRef(song) });
      if (ok === undefined) return;
      toast(`${swapping.singerName} will sing “${song.title}” instead`);
      setStageSwap(null);
      setQ('');
      return;
    }
    if (!target || !singer) {
      toast('Pick a singer first (click one in the list).', 'error');
      return;
    }
    const id = await act<string>({ type: 'addEntry', singerId: target, song: songRef(song) });
    if (!id) return;
    if (pin) await act({ type: 'pinEntry', entryId: id });
    toast(`${song.title} → ${singer.name}${pin ? ' (plays next)' : ''}`);
  }

  return (
    <div className="song-search">
      {swapping ? (
        <div className="swap-banner">
          <I.Restart />
          <div className="ellipsis">
            <strong>New song for {swapping.singerName}</strong>
            <span className="ellipsis">Replaces “{swapping.entry.song.title}” on stage. Pick one of theirs, or search.</span>
          </div>
          <button className="btn sm ghost" onClick={() => setStageSwap(null)}>
            Cancel
          </button>
        </div>
      ) : (
      <div className="target-row">
        <span className="muted small">Adding for</span>
        <select className="input sm" value={target ?? ''} onChange={(e) => setTarget(e.target.value || null)}>
          <option value="">Choose a singer…</option>
          {view.show.singers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      )}
      <div className="search-box">
        <I.Search />
        <input
          ref={inputRef}
          className="input"
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setYt(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && view.youtubeSearch && local?.length === 0 && searchYouTube()}
          placeholder="Search library, or paste a YouTube link"
        />
      </div>

      <div className="results-scroll">
        {swapping && theirList.length > 0 && (
          <ResultList title={`${swapping.singerName}’s other songs`} icon={<I.Music />} results={theirList.map((e) => ({ song: e.song }))} onAdd={add} canAdd swap />
        )}
        {!query && !ytId && !swapping && <LibraryHint />}

        {linked && (
          <ResultList title="YouTube link" icon={<I.Link />} results={[linked]} onAdd={add} canAdd={Boolean(singer || swapping)} swap={Boolean(swapping)} />
        )}

        {local && local.length > 0 && <ResultList title={`Library · ${local.length}${local.length >= 60 ? '+' : ''}`} icon={<I.Disc />} results={local} onAdd={add} canAdd={Boolean(singer || swapping)} swap={Boolean(swapping)} />}
        {query && !ytId && local?.length === 0 && <p className="muted small pad">No library matches for “{query}”.</p>}

        {query && !ytId && (
          <div className="yt-block">
            {yt?.q === query ? (
              yt.results.length ? (
                <>
                  <ResultList title="YouTube" icon={<I.YouTube />} results={yt.results} onAdd={add} canAdd={Boolean(singer || swapping)} swap={Boolean(swapping)} />
                  <p className="muted small pad">
                    <YouTubeTerms short />
                  </p>
                </>
              ) : (
                <p className="muted small pad">YouTube found no videos that can play here.</p>
              )
            ) : view.youtubeSearch ? (
              <button className="btn block yt-btn" onClick={searchYouTube} disabled={ytBusy}>
                {ytBusy ? <I.Loader /> : <I.YouTube />} Search YouTube for “{query}”
              </button>
            ) : (
              <p className="muted small pad">
                <I.YouTube className="inline-icon" /> Paste a YouTube link to queue it.
              </p>
            )}
          </div>
        )}
      </div>
      <p className="finder-foot muted small">
        <kbd>Shift</kbd>-click <I.Plus className="inline-icon" /> to add <em>and</em> play next.
      </p>
    </div>
  );
}

function LibraryHint() {
  const { view } = useDj();
  const lib = view.library;
  if (lib.scanning)
    return (
      <div className="empty small">
        <I.Loader />
        <span>Scanning your library…</span>
      </div>
    );
  if (lib.folders.length === 0)
    return (
      <div className="empty small">
        <I.Folder />
        <strong>No library folder yet</strong>
        <span>Point Encore at your karaoke files in Settings (MP4, MP3+G, or zipped MP3+G). YouTube links work right away.</span>
      </div>
    );
  return (
    <div className="empty small">
      <I.Disc />
      <strong>{lib.trackCount.toLocaleString()} tracks ready</strong>
      <span>Search by title, artist, or disc number.</span>
      {lib.errors.map((e) => (
        <span key={e} className="badge red">
          {e}
        </span>
      ))}
    </div>
  );
}

function ResultList({
  title,
  icon,
  results,
  onAdd,
  canAdd,
  swap,
}: {
  title: string;
  icon: React.ReactNode;
  results: SearchResult[];
  onAdd: (song: Song, pin: boolean) => void;
  canAdd: boolean;
  /** Picking a replacement for the song on stage: "Sing now" instead of "+". */
  swap?: boolean;
}) {
  return (
    <section>
      <h4 className="list-title">
        {icon} {title}
      </h4>
      <ul className="result-list">
        {results.map((r) => (
          <li key={r.song.source.kind === 'local' ? r.song.source.trackId : r.song.source.videoId} className="result-row">
            <SongThumb song={r.song} size={38} />
            <div className="result-main ellipsis">
              <div className="result-title ellipsis">{r.song.title}</div>
              <div className="result-sub ellipsis">
                {r.song.artist}
                {r.song.artist && r.detail ? ' · ' : ''}
                <span className="muted">{r.detail}</span>
              </div>
            </div>
            <div className="result-meta">
              {r.playedTonight && (
                <span className="badge amber" title="Already sung or queued tonight">
                  tonight
                </span>
              )}
              {r.song.durationSec ? <span className="muted small">{formatDuration(r.song.durationSec)}</span> : <SourceBadge song={r.song} />}
            </div>
            {swap ? (
              <button className="btn sm primary swap-btn" onClick={() => onAdd(r.song, false)} title="Sing this instead, now">
                <I.Mic /> Sing now
              </button>
            ) : (
              <button className="btn sm icon add-btn" disabled={!canAdd} onClick={(e) => onAdd(r.song, e.shiftKey)} title={canAdd ? 'Add (shift: play next)' : 'Pick a singer first'} aria-label="Add">
                <I.Plus />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Requests() {
  const { view, act, setPreview } = useDj();
  const pending = view.show.entries.filter((e) => e.status === 'pending');
  const name = (id: string) => view.show.singers.find((s) => s.id === id)?.name ?? '—';
  if (!view.show.settings.requireApproval && pending.length === 0)
    return (
      <div className="empty">
        <I.Inbox />
        <strong>Requests go straight into the rotation</strong>
        <span>Turn on “Approve phone requests” in Settings to review each one first.</span>
      </div>
    );
  return (
    <div className="requests">
      {pending.length === 0 ? (
        <div className="empty">
          <I.Check />
          <strong>All caught up</strong>
          <span>New phone requests will wait here for your OK.</span>
        </div>
      ) : (
        <>
          <div className="requests-head">
            <span className="muted small">{pending.length} waiting</span>
            <button className="btn sm" onClick={() => act({ type: 'approveAll' }, 'All approved')}>
              <I.Check /> Approve all
            </button>
          </div>
          <ul className="result-list">
            {pending.map((e) => (
              <li key={e.id} className="result-row">
                <SongThumb song={e.song} size={38} />
                <div className="result-main ellipsis previewable" onClick={() => setPreview(e.id)} title="Preview this song">
                  <div className="result-title ellipsis">{e.song.title}</div>
                  <div className="result-sub ellipsis">
                    <strong>{name(e.singerId)}</strong> · {e.song.artist}
                    {e.key ? <span className="entry-key"> · Key {keyLabel(e.key, e.song.source.kind === 'local' ? view.songKeys[e.song.source.trackId] : undefined)}</span> : null}
                    {e.note && <span className="entry-note"> “{e.note}”</span>}
                  </div>
                </div>
                <SourceBadge song={e.song} />
                <NotKaraokeButton entry={e} compact />
                <button className="btn sm" onClick={() => act({ type: 'approveEntry', entryId: e.id })}>
                  <I.Check />
                </button>
                <button className="btn sm ghost danger icon" onClick={() => act({ type: 'removeEntry', entryId: e.id })} aria-label="Reject">
                  <I.X />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function HistoryList() {
  const { view } = useDj();
  const items = view.show.history;
  if (items.length === 0)
    return (
      <div className="empty">
        <I.History />
        <strong>Nothing sung yet</strong>
        <span>Every performance tonight is logged here.</span>
      </div>
    );
  return (
    <ul className="result-list history">
      {items.map((h, i) => (
        <li key={`${h.entry.id}-${i}`} className="result-row">
          <span className="hist-time muted small">{new Date(h.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <div className="result-main ellipsis">
            <div className="result-title ellipsis">{h.singerName}</div>
            <div className="result-sub ellipsis">
              {h.entry.song.title}
              {h.entry.song.artist && ` · ${h.entry.song.artist}`}
            </div>
          </div>
          {h.outcome !== 'finished' && <span className={`badge ${h.outcome === 'error' ? 'red' : ''}`}>{h.outcome}</span>}
          <SourceBadge song={h.entry.song} />
        </li>
      ))}
    </ul>
  );
}
