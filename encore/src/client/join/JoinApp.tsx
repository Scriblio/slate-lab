// The singer's phone: join by name, find a song (library or YouTube), and
// watch your place in line.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { songRef, type SingerAction } from '../../shared/protocol.ts';
import { formatWait, parseYouTubeId } from '../../shared/text.ts';
import type { Entry, SearchResult, SingerView, Song } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { connect, request, safeGet, safeSet, useConnection, type AppSocket, type ServerError } from '../common/socket.ts';
import { Eq, SongThumb, SourceBadge, useAction, useDebounced, useTick, useToast, YouTubeTerms } from '../common/ui.tsx';

type Tab = 'search' | 'mine' | 'line';

export interface JoinAppProps {
  /** Defaults to a Socket.IO connection to this page's own server (the Wi-Fi link). */
  socket?: AppSocket;
  /** Where this phone keeps its spot; the online link keeps one per room. */
  tokenKey?: string;
  offlineHint?: string;
  /** Show the connection's own error messages (the online link's are written for people). */
  showConnectionErrors?: boolean;
}

export function JoinApp({ socket: given, tokenKey = 'encore.token', offlineHint, showConnectionErrors }: JoinAppProps = {}) {
  const TOKEN_KEY = tokenKey;
  const socket = useMemo(() => given ?? connect('singer'), [given]);
  const conn = useConnection(socket);
  const [view, setView] = useState<SingerView | null>(null);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [resuming, setResuming] = useState(() => Boolean(safeGet(TOKEN_KEY)));
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('search');
  const [connError, setConnError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    const onView = (v: SingerView) => {
      setView(v);
      setReceivedAt(Date.now());
    };
    const onConnect = () => {
      const token = safeGet(TOKEN_KEY);
      if (!token) return setResuming(false);
      request(socket, 'singer:resume', token)
        .catch(() => {
          safeSet(TOKEN_KEY, null);
          setNotice('Your spot from last time has ended. Join again to sing!');
        })
        .finally(() => setResuming(false));
    };
    const onRemoved = () => {
      if (safeGet(TOKEN_KEY)) setNotice('The KJ cleared the list. Join again to sing!');
      safeSet(TOKEN_KEY, null);
    };
    const onError = (e: Error) => setConnError(e.message);
    const onUp = () => setConnError(null);
    socket.on('singer:view', onView);
    socket.on('connect', onConnect);
    socket.on('connect', onUp);
    socket.on('singer:removed', onRemoved);
    socket.on('connect_error', onError);
    return () => {
      socket.off('singer:view', onView);
      socket.off('connect', onConnect);
      socket.off('connect', onUp);
      socket.off('singer:removed', onRemoved);
      socket.off('connect_error', onError);
    };
  }, [socket]);

  useEffect(() => {
    document.title = view ? `${view.showName} · Karaoke` : 'Join the Karaoke List';
  }, [view?.showName]);

  if (!view || resuming) return <Splash offline={conn === 'offline'} hint={(showConnectionErrors && connError) || offlineHint} />;

  return (
    <>
      {conn !== 'online' && (
        <div className="conn-banner">
          <I.Loader /> Reconnecting…
        </div>
      )}
      {view.me ? (
        <Main socket={socket} view={view} receivedAt={receivedAt} tab={tab} setTab={setTab} />
      ) : (
        <JoinScreen
          view={view}
          notice={notice}
          onJoin={async (name) => {
            const res = await request<{ token: string }>(socket, 'singer:join', name);
            safeSet(TOKEN_KEY, res.token);
            setNotice(null);
            setTab('search');
          }}
          onReclaim={async (name, code) => {
            const res = await request<{ token: string }>(socket, 'singer:reclaim', name, code);
            safeSet(TOKEN_KEY, res.token);
            setNotice(null);
            toast('Welcome back! You’re in your old spot.');
            setTab('mine');
          }}
        />
      )}
    </>
  );
}

function Splash({ offline, hint }: { offline: boolean; hint?: string }) {
  return (
    <div className="splash">
      <div className="logo-mark">
        <I.Mic />
      </div>
      <p className="muted">{offline ? (hint ?? 'Can’t reach the KJ’s laptop. Are you on the venue Wi-Fi?') : 'Connecting…'}</p>
    </div>
  );
}

// --- join --------------------------------------------------------------------

function JoinScreen({
  view,
  notice,
  onJoin,
  onReclaim,
}: {
  view: SingerView;
  notice: string | null;
  onJoin: (name: string) => Promise<void>;
  onReclaim: (name: string, code: string) => Promise<void>;
}) {
  const [name, setName] = useState(() => safeGet('encore.name') ?? '');
  const [code, setCode] = useState('');
  /** 'claim' = getting back into a spot that's already on the list. */
  const [mode, setMode] = useState<'join' | 'claim'>('join');
  const [taken, setTaken] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function attempt(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      const err = e as ServerError;
      if (err.code === 'name-taken') {
        setTaken(err.message);
        setMode('claim');
        setCode('');
      } else if (err.code === 'not-on-list') {
        setMode('join');
        setTaken(null);
        setHint(err.message);
      } else toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function submitJoin(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    safeSet('encore.name', name.trim());
    setHint(null);
    void attempt(() => onJoin(name));
  }

  function submitClaim(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || code.length !== 4 || busy) return;
    safeSet('encore.name', name.trim());
    void attempt(() => onReclaim(name, code));
  }

  const nameInput = (
    <input
      id="name"
      className="input xl"
      value={name}
      onChange={(e) => setName(e.target.value)}
      placeholder="Your name or stage name"
      maxLength={32}
      autoComplete="nickname"
      enterKeyHint="go"
    />
  );

  return (
    <div className="join">
      <div className="join-hero">
        <div className="logo-mark big">
          <I.Mic />
        </div>
        <p className="eyebrow">Tonight at</p>
        <h1>{view.showName}</h1>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {mode === 'claim' ? (
        <form className="join-card" onSubmit={submitClaim}>
          {taken ? (
            <>
              <h2 className="claim-title">{taken}</h2>
              <p className="muted claim-copy">If that’s you, enter your 4-digit rejoin code to get your spot and songs back.</p>
            </>
          ) : (
            <>
              <h2 className="claim-title">Get back in</h2>
              <p className="muted claim-copy">Already on the list from another phone or browser? Enter your name and rejoin code.</p>
              <label htmlFor="name">Your name on the list</label>
              {nameInput}
            </>
          )}
          <label htmlFor="code">Rejoin code</label>
          <input
            id="code"
            className="input xl code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="••••"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            enterKeyHint="go"
          />
          <button className="btn primary lg block" disabled={!name.trim() || code.length !== 4 || busy}>
            {busy ? <I.Loader /> : <I.Check />} That’s me, get my spot back
          </button>
          <p className="fine">Your code is under “My songs” on the phone you joined with. Lost it? The KJ can look it up.</p>
          {view.joinOpen && (
            <button
              type="button"
              className="btn ghost block"
              onClick={() => {
                setMode('join');
                setTaken(null);
                setHint('Add something that tells you apart, like your last initial.');
              }}
            >
              I’m someone else
            </button>
          )}
        </form>
      ) : view.joinOpen ? (
        <form className="join-card" onSubmit={submitJoin}>
          <label htmlFor="name">What should the KJ call you?</label>
          {nameInput}
          {hint && <p className="hint">{hint}</p>}
          <button className="btn primary lg block" disabled={!name.trim() || busy}>
            {busy ? <I.Loader /> : <I.Mic />} Get in line
          </button>
          <p className="fine">No app, no account. Your spot stays on this phone tonight.</p>
          <button type="button" className="link-btn" onClick={() => (setTaken(null), setMode('claim'))}>
            Already on the list from another phone? Get back in
          </button>
        </form>
      ) : (
        <div className="join-card closed">
          <I.Clock />
          <h2>Sign-ups are closed</h2>
          <p className="muted">The KJ has stopped taking new singers for tonight. Thanks for coming out!</p>
          <button type="button" className="link-btn" onClick={() => (setTaken(null), setMode('claim'))}>
            Already on the list? Get back in
          </button>
        </div>
      )}
    </div>
  );
}

// --- main --------------------------------------------------------------------

function Main({
  socket,
  view,
  receivedAt,
  tab,
  setTab,
}: {
  socket: ReturnType<typeof connect>;
  view: SingerView;
  receivedAt: number;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const me = view.me!;
  const now = useTick(15_000);
  const elapsed = Math.max(0, (now - receivedAt) / 1000);
  const eta = view.myNextEtaSec === null ? null : Math.max(0, view.myNextEtaSec - elapsed);
  const onStage = view.nowPlaying?.isMe ?? false;
  const [takeover, setTakeover] = useState(false);
  const prev = useRef({ pos: view.myNextPosition, onStage });

  // Buzz the phone when it's nearly your turn, and again when you're called.
  useEffect(() => {
    const p = prev.current;
    if (view.myNextPosition === 1 && p.pos !== 1 && !onStage) navigator.vibrate?.(200);
    if (onStage && !p.onStage) {
      navigator.vibrate?.([300, 120, 300, 120, 300]);
      setTakeover(true);
    }
    if (!onStage) setTakeover(false);
    prev.current = { pos: view.myNextPosition, onStage };
  }, [view.myNextPosition, onStage]);

  const call = (action: SingerAction) => request(socket, 'singer:action', action);

  return (
    <div className="app">
      <header className="app-head">
        <div className="who">
          <div className="avatar">{initials(me.name)}</div>
          <div className="ellipsis">
            <div className="name ellipsis">{me.name}</div>
            <div className="show ellipsis">
              {view.showName} · rejoin code <strong className="code-chip">{me.code}</strong>
            </div>
          </div>
        </div>
        <StatusCard view={view} eta={eta} onBack={() => call({ type: 'setAway', away: false })} />
      </header>

      <main className="app-body">
        {tab === 'search' && <SearchTab socket={socket} view={view} onAdded={() => setTab('mine')} />}
        {tab === 'mine' && <MineTab view={view} call={call} goSearch={() => setTab('search')} />}
        {tab === 'line' && <LineTab view={view} elapsed={elapsed} />}
      </main>

      <nav className="tabbar">
        <TabButton active={tab === 'search'} onClick={() => setTab('search')} icon={<I.Search />} label="Find a song" />
        <TabButton active={tab === 'mine'} onClick={() => setTab('mine')} icon={<I.Music />} label="My songs" count={view.myEntries.length} />
        <TabButton active={tab === 'line'} onClick={() => setTab('line')} icon={<I.Users />} label="The line" />
      </nav>

      {takeover && view.nowPlaying && (
        <div className="takeover" onClick={() => setTakeover(false)}>
          <div className="takeover-inner">
            <div className="logo-mark big pulse">
              <I.Mic />
            </div>
            <h1>It’s your turn!</h1>
            <p>Head to the stage, {me.name}.</p>
            {view.nowPlaying.title && (
              <p className="takeover-song">
                {view.nowPlaying.title}
                {view.nowPlaying.artist && <span> · {view.nowPlaying.artist}</span>}
              </p>
            )}
            <button className="btn lg">Got it</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusCard({ view, eta, onBack }: { view: SingerView; eta: number | null; onBack: () => Promise<unknown> }) {
  const me = view.me!;
  const np = view.nowPlaying;
  const run = useAction();
  if (np?.isMe)
    return (
      <div className="status live">
        <Eq paused={np.stage !== 'playing'} />
        <div>
          <strong>{np.stage === 'intro' ? 'You’re up — head to the stage!' : 'You’re on! Sing it!'}</strong>
        </div>
      </div>
    );
  if (me.status === 'away')
    return (
      <button className="status away" onClick={() => run(onBack, 'Welcome back!')}>
        <I.Coffee />
        <div>
          <strong>On a break</strong>
          <span>Tap when you’re back — you keep your spot</span>
        </div>
      </button>
    );
  if (view.myNextPosition === 1)
    return (
      <div className="status next">
        <I.Bolt />
        <div>
          <strong>You’re up next!</strong>
          <span>Stay close to the stage{eta !== null && eta > 45 ? ` · ${formatWait(eta)}` : ''}</span>
        </div>
      </div>
    );
  if (view.myNextPosition)
    return (
      <div className="status queued">
        <div className="pos">#{view.myNextPosition}</div>
        <div>
          <strong>in line</strong>
          <span>{eta !== null ? `Your turn in ${formatWait(eta)}` : ''}</span>
        </div>
      </div>
    );
  if (view.myEntries.some((e) => e.status === 'pending'))
    return (
      <div className="status idle">
        <I.Clock />
        <div>
          <strong>Waiting on the KJ</strong>
          <span>Your request is being reviewed</span>
        </div>
      </div>
    );
  return (
    <div className="status idle">
      <I.Sparkle />
      <div>
        <strong>Pick a song to get in line</strong>
        <span>Search below — the KJ handles the rest</span>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number }) {
  return (
    <button className={`tab ${active ? 'active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>
      <span className="tab-icon">
        {icon}
        {count ? <span className="tab-count">{count}</span> : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

// --- search ------------------------------------------------------------------

function SearchTab({ socket, view, onAdded }: { socket: ReturnType<typeof connect>; view: SingerView; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const [local, setLocal] = useState<SearchResult[] | null>(null);
  const [yt, setYt] = useState<{ q: string; results: SearchResult[] } | null>(null);
  const [ytBusy, setYtBusy] = useState(false);
  const [picked, setPicked] = useState<SearchResult | null>(null);
  const toast = useToast();
  const ytId = parseYouTubeId(q);
  const full = view.maxQueuedPerSinger > 0 && view.myEntries.length >= view.maxQueuedPerSinger;

  useEffect(() => {
    let live = true;
    if (!query || ytId) {
      setLocal(null);
      return;
    }
    request<SearchResult[]>(socket, 'search', query)
      .then((r) => live && setLocal(r))
      .catch(() => live && setLocal([]));
    return () => {
      live = false;
    };
  }, [query, ytId, socket]);

  useEffect(() => {
    if (!ytId || !view.allowYouTube) return;
    let live = true;
    request<SearchResult>(socket, 'lookupYouTube', ytId)
      .then((r) => live && setPicked(r))
      .catch((e: Error) => live && toast(e.message, 'error'));
    return () => {
      live = false;
    };
  }, [ytId, view.allowYouTube, socket, toast]);

  async function searchYouTube() {
    if (!query) return;
    setYtBusy(true);
    try {
      setYt({ q: query, results: await request<SearchResult[]>(socket, 'searchYouTube', query) });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setYtBusy(false);
    }
  }

  return (
    <div className="search-tab">
      <div className="search-sticky">
        <div className="search-box">
          <I.Search />
          <input
            className="input xl"
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setYt(null);
            }}
            placeholder={view.allowYouTube ? 'Song, artist, or YouTube link' : 'Search by song or artist'}
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="search"
          />
        </div>
        {full && <div className="hint warn">You have {view.myEntries.length} songs waiting — the max for tonight. Sing one first, or swap one out.</div>}
      </div>

      {!query && !ytId && (
        <div className="empty">
          <I.Music />
          <strong>What are you singing tonight?</strong>
          <span>
            Search the KJ’s library by song or artist.
            {view.allowYouTube && !view.youtubeSearch && ' You can also paste a YouTube karaoke link.'}
          </span>
        </div>
      )}

      {local && local.length > 0 && (
        <section>
          <h3 className="section-title">
            <I.Disc /> KJ library
          </h3>
          <ul className="results">
            {local.map((r) => (
              <ResultRow key={sourceId(r.song)} r={r} onPick={() => setPicked(r)} disabled={full} />
            ))}
          </ul>
        </section>
      )}

      {query && !ytId && local && local.length === 0 && (
        <div className="empty small">
          <span>
            Nothing in the library for “{query}”.
            {view.youtubeSearch ? ' Try YouTube below.' : view.allowYouTube ? ' Paste a YouTube karaoke link instead.' : ''}
          </span>
        </div>
      )}

      {query && !ytId && view.youtubeSearch && (
        <section>
          {yt?.q === query ? (
            <>
              <h3 className="section-title">
                <I.YouTube /> YouTube
              </h3>
              {yt.results.length === 0 ? (
                <p className="muted pad">No karaoke videos found that can play here.</p>
              ) : (
                <>
                  <ul className="results">
                    {yt.results.map((r) => (
                      <ResultRow key={sourceId(r.song)} r={r} onPick={() => setPicked(r)} disabled={full} />
                    ))}
                  </ul>
                  <p className="muted small pad">
                    <YouTubeTerms short />
                  </p>
                </>
              )}
            </>
          ) : (
            <button className="btn block yt-search" onClick={searchYouTube} disabled={ytBusy}>
              {ytBusy ? <I.Loader /> : <I.YouTube />} Search YouTube for “{query}”
            </button>
          )}
        </section>
      )}

      {picked && (
        <AddSheet
          result={picked}
          disabled={full}
          onClose={() => setPicked(null)}
          onAdd={async (note) => {
            await request(socket, 'singer:action', { type: 'request', song: songRef(picked.song), note });
            setPicked(null);
            setQ('');
            setYt(null);
            toast(view.myEntries.length === 0 ? 'You’re in line!' : 'Added to your songs');
            onAdded();
          }}
        />
      )}
    </div>
  );
}

function ResultRow({ r, onPick, disabled }: { r: SearchResult; onPick: () => void; disabled?: boolean }) {
  return (
    <li>
      <button className="result" onClick={onPick} disabled={disabled}>
        <SongThumb song={r.song} />
        <div className="result-text">
          <div className="title ellipsis">{r.song.title}</div>
          <div className="sub ellipsis">{r.song.artist || r.detail}</div>
          {r.playedTonight && <span className="badge amber">Already sung or requested tonight</span>}
        </div>
        <span className="add-dot">
          <I.Plus />
        </span>
      </button>
    </li>
  );
}

function AddSheet({ result, onClose, onAdd, disabled }: { result: SearchResult; onClose: () => void; onAdd: (note?: string) => Promise<void>; disabled?: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useAction();
  const { song } = result;
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Add song">
        <div className="sheet-grip" />
        <div className="sheet-song">
          <SongThumb song={song} size={64} />
          <div className="ellipsis">
            <h2 className="ellipsis">{song.title}</h2>
            <p className="muted ellipsis">{song.artist || result.detail}</p>
            <SourceBadge song={song} />
          </div>
        </div>
        {result.playedTonight && <div className="hint warn">Someone already sang or picked this tonight. You can still add it.</div>}
        <label className="note-label" htmlFor="note">
          Note for the KJ <span className="muted">(optional)</span>
        </label>
        <input
          id="note"
          className="input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. duet with Sam, key down 2"
          maxLength={80}
        />
        <div className="sheet-actions">
          <button className="btn lg ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn lg primary"
            disabled={busy || disabled}
            onClick={async () => {
              setBusy(true);
              await run(() => onAdd(note.trim() || undefined));
              setBusy(false);
            }}
          >
            {busy ? <I.Loader /> : <I.Plus />} Add to my songs
          </button>
        </div>
      </div>
    </div>
  );
}

// --- my songs ----------------------------------------------------------------

function MineTab({ view, call, goSearch }: { view: SingerView; call: (a: SingerAction) => Promise<unknown>; goSearch: () => void }) {
  const run = useAction();
  const me = view.me!;
  const act = (a: SingerAction, ok?: string) => run(() => call(a), ok);
  const [confirmLeave, setConfirmLeave] = useState(false);
  return (
    <div className="mine">
      <div className="code-card">
        <div>
          <strong>Your rejoin code</strong>
          <span className="muted">Switching phones or browsers? Join with the same name and this code to keep your spot.</span>
        </div>
        <span className="code-big">{me.code}</span>
      </div>
      {view.myEntries.length === 0 ? (
        <div className="empty">
          <I.Music />
          <strong>No songs yet</strong>
          <span>Add one and you’re in the rotation.</span>
          <button className="btn primary" onClick={goSearch}>
            <I.Search /> Find a song
          </button>
        </div>
      ) : (
        <ol className="my-list">
          {view.myEntries.map((e, i) => (
            <MyEntry
              key={e.id}
              entry={e}
              first={i === 0}
              last={i === view.myEntries.length - 1}
              onMove={(d) => act({ type: 'moveMyEntry', entryId: e.id, direction: d })}
              onRemove={() => act({ type: 'removeMyEntry', entryId: e.id }, 'Removed')}
            />
          ))}
        </ol>
      )}
      {view.myEntries.length > 1 && <p className="fine center">Your top song is the one you’ll sing next. Use the arrows to change it.</p>}
      <div className="mine-actions">
        <div className="row-setting">
          <div>
            <strong>Taking a break</strong>
            <span className="muted">You’ll be skipped but keep your place.</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={me.status === 'away'}
              onChange={(e) => act({ type: 'setAway', away: e.target.checked }, e.target.checked ? 'Enjoy your break' : 'Welcome back!')}
            />
            <span />
          </label>
        </div>
        {confirmLeave ? (
          <div className="confirm">
            <span>Leave the list and drop your songs?</span>
            <button className="btn sm" onClick={() => setConfirmLeave(false)}>
              Stay
            </button>
            <button className="btn sm danger" onClick={() => act({ type: 'leave' }, 'You’ve left the list')}>
              Leave
            </button>
          </div>
        ) : (
          <button className="btn ghost block" onClick={() => setConfirmLeave(true)}>
            <I.Logout /> Leave the list
          </button>
        )}
      </div>
    </div>
  );
}

function MyEntry({ entry, first, last, onMove, onRemove }: { entry: Entry; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; onRemove: () => void }) {
  return (
    <li className={`my-entry ${first ? 'next' : ''}`}>
      <SongThumb song={entry.song} />
      <div className="result-text">
        <div className="title ellipsis">{entry.song.title}</div>
        <div className="sub ellipsis">{entry.song.artist}</div>
        <div className="tags">
          {first && <span className="badge accent">Next up for you</span>}
          {entry.status === 'pending' && <span className="badge amber">Waiting for approval</span>}
          {entry.note && <span className="badge">“{entry.note}”</span>}
        </div>
      </div>
      <div className="my-entry-actions">
        <button className="btn ghost icon sm" disabled={first} onClick={() => onMove(-1)} aria-label="Move up">
          <I.ChevronUp />
        </button>
        <button className="btn ghost icon sm" disabled={last} onClick={() => onMove(1)} aria-label="Move down">
          <I.ChevronDown />
        </button>
        <button className="btn ghost icon sm danger" onClick={onRemove} aria-label="Remove">
          <I.Trash />
        </button>
      </div>
    </li>
  );
}

// --- the line ------------------------------------------------------------------

function LineTab({ view, elapsed }: { view: SingerView; elapsed: number }) {
  const np = view.nowPlaying;
  return (
    <div className="line">
      {np ? (
        <div className={`now-card ${np.isMe ? 'me' : ''}`}>
          <div className="now-label">
            <Eq paused={np.stage !== 'playing'} /> {np.stage === 'intro' ? 'Coming up to the mic' : 'Singing now'}
          </div>
          <div className="now-name">{np.isMe ? 'You!' : np.singerName}</div>
          {np.title && (
            <div className="now-song ellipsis">
              {np.title}
              {np.artist && <span className="muted"> · {np.artist}</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="now-card idle">
          <div className="now-label">Stage</div>
          <div className="now-name">Between songs</div>
        </div>
      )}
      {view.upcoming.length === 0 ? (
        <div className="empty small">
          <span>Nobody’s waiting — add a song and you’re next!</span>
        </div>
      ) : (
        <ol className="line-list">
          {view.upcoming.map((u, i) => (
            <li key={i} className={u.isMe ? 'me' : ''}>
              <span className="line-pos">{i + 1}</span>
              <div className="ellipsis">
                <div className="line-name ellipsis">{u.isMe ? `${u.singerName} (you)` : u.singerName}</div>
                {u.title && <div className="sub ellipsis">{u.title}</div>}
              </div>
              <span className="line-eta">{formatWait(Math.max(0, u.etaSec - elapsed))}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="fine center">Wait times are estimates. The KJ can change the order.</p>
    </div>
  );
}

// --- helpers -------------------------------------------------------------------


function sourceId(song: Song): string {
  return song.source.kind === 'local' ? song.source.trackId : song.source.videoId;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '♪';
}
