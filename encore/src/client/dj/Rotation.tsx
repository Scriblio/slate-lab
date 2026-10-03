// The rotation: every singer tonight, their songs, and their place.

import { useState, type FormEvent } from 'react';
import { isRoundBased } from '../../shared/rotation.ts';
import { formatWait, nameKey } from '../../shared/text.ts';
import type { Entry, Singer } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { SongThumb, SourceBadge } from '../common/ui.tsx';
import { useDj } from './context.ts';
import { NotKaraokeButton } from './NotKaraoke.tsx';

export function Rotation() {
  const { view, act, setTarget, setPreview, focusFinder } = useDj();
  const { show } = view;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const draggable = isRoundBased(show.mode);
  const sung = new Set(show.sungThisRound);
  const pendingCount = show.entries.filter((e) => e.status === 'pending').length;
  const activeCount = show.singers.filter((s) => s.status === 'active').length;

  async function addSinger(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const id = await act<string>({ type: 'addSinger', name });
    if (id) {
      setName('');
      setTarget(id);
      setExpanded(id);
      focusFinder();
    }
  }

  function drop() {
    if (!drag) return;
    const from = show.singers.findIndex((s) => s.id === drag.id);
    let to = drag.over;
    if (from < to) to -= 1;
    if (from >= 0 && to !== from) void act({ type: 'moveSinger', singerId: drag.id, toIndex: to });
    setDrag(null);
  }

  return (
    <div className="card rotation-card">
      <div className="card-head">
        <h3>
          Singers <span className="count">{show.singers.length}</span>
        </h3>
        {draggable && show.singers.length > 0 && (
          <span className="round-pill">
            Round {show.round} · {show.sungThisRound.filter((id) => show.singers.some((s) => s.id === id)).length}/{activeCount} sung
          </span>
        )}
      </div>

      <form className="add-singer" onSubmit={addSinger}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a walk-up singer…" maxLength={32} />
        <button className="btn" disabled={!name.trim()}>
          <I.Plus /> Add
        </button>
      </form>

      {pendingCount > 0 && (
        <div className="pending-banner">
          <I.Inbox />
          <span>
            {pendingCount} request{pendingCount > 1 ? 's' : ''} waiting for approval
          </span>
          <button className="btn sm" onClick={() => act({ type: 'approveAll' }, 'All requests approved')}>
            Approve all
          </button>
        </div>
      )}

      {!draggable && show.singers.length > 1 && (
        <p className="mode-note">
          <I.Sparkle /> {show.mode === 'fair' ? 'Fair Play' : 'First Come'} orders the line automatically — see Up next. Use <I.Pin className="inline-icon" /> to bump a song.
        </p>
      )}

      {show.singers.length === 0 ? (
        <div className="empty">
          <I.Users />
          <strong>No singers yet</strong>
          <span>Singers who scan the QR code show up here. You can also add walk-ups above.</span>
        </div>
      ) : (
        <ol className="singer-list" onDragOver={(e) => draggable && e.preventDefault()} onDrop={drop}>
          {show.singers.map((s, i) => (
            <SingerRow
              key={s.id}
              singer={s}
              index={i}
              last={i === show.singers.length - 1}
              sung={sung.has(s.id)}
              expanded={expanded === s.id}
              onToggle={() => {
                setExpanded(expanded === s.id ? null : s.id);
                setTarget(s.id);
                // Opening a singer previews their next song.
                const first = expanded === s.id ? undefined : show.entries.find((e) => e.singerId === s.id);
                if (first) setPreview(first.id);
              }}
              draggable={draggable}
              dropBefore={drag?.over === i && drag.id !== s.id}
              dropAfter={drag?.over === show.singers.length && i === show.singers.length - 1}
              onDragStart={() => setDrag({ id: s.id, over: i })}
              onDragOver={(before) => drag && setDrag({ ...drag, over: before ? i : i + 1 })}
              onDragEnd={() => setDrag(null)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

interface RowProps {
  singer: Singer;
  index: number;
  last: boolean;
  sung: boolean;
  expanded: boolean;
  onToggle: () => void;
  draggable: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragStart: () => void;
  onDragOver: (before: boolean) => void;
  onDragEnd: () => void;
}

function SingerRow({ singer: s, index, last, sung, expanded, onToggle, draggable, dropBefore, dropAfter, onDragStart, onDragOver, onDragEnd }: RowProps) {
  const { view, act, target, setTarget, focusFinder } = useDj();
  const { show } = view;
  const entries = show.entries.filter((e) => e.singerId === s.id);
  const upIndex = view.upcoming.findIndex((u) => u.singer.id === s.id);
  const onStage = show.nowPlaying?.entry.singerId === s.id;
  const away = s.status === 'away';
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(s.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const roundBased = isRoundBased(show.mode);
  // Others whose name matches this one ("Matt" / "matt (2)"): probably the same person.
  const twins = show.singers.filter((o) => o.id !== s.id && nameKey(o.name) === nameKey(s.name));
  const [mergeInto, setMergeInto] = useState('');

  return (
    <li
      className={[
        'singer',
        expanded && 'open',
        away && 'away',
        onStage && 'on-stage',
        upIndex === 0 && !onStage && 'is-next',
        target === s.id && 'targeted',
        dropBefore && 'drop-before',
        dropAfter && 'drop-after',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable={draggable && !renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', s.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        if (!draggable) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY < r.top + r.height / 2);
      }}
      onDragEnd={onDragEnd}
    >
      <div className="singer-row" onClick={onToggle}>
        {draggable ? (
          <span className="grip" title="Drag to reorder">
            <I.Grip />
          </span>
        ) : (
          <span className="grip off" />
        )}
        <span className="singer-n">{index + 1}</span>
        <div className="singer-main ellipsis">
          <div className="singer-name ellipsis" title={s.fromPhone ? 'Joined from their phone' : 'Added by the KJ'}>
            {s.name}
          </div>
          <div className="singer-sub ellipsis">
            {entries.length === 0 ? (
              <span className="muted">No songs queued</span>
            ) : (
              <>
                {entries[0]!.song.title}
                {entries.length > 1 && <span className="muted"> +{entries.length - 1} more</span>}
              </>
            )}
          </div>
        </div>
        <div className="singer-badges">
          {onStage && <span className="badge accent">On stage</span>}
          {!onStage && upIndex === 0 && <span className="badge green">Next</span>}
          {!onStage && upIndex > 0 && <span className="badge">{formatWait(view.upcoming[upIndex]!.etaSec)}</span>}
          {away && (
            <span className="badge amber">
              <I.Coffee /> Away
            </span>
          )}
          {!away && s.holdTurns && (
            <span className="badge amber" title={`Can’t sing right now: ${s.holdTurns} more singer${s.holdTurns === 1 ? '' : 's'} go first`}>
              <I.Clock /> Waiting
            </span>
          )}
          {roundBased && sung && !onStage && (
            <span className="badge violet" title="Sung this round">
              <I.Check /> Sung
            </span>
          )}
          {entries.some((e) => e.status === 'pending') && <span className="badge amber">Needs OK</span>}
          {twins.length > 0 && (
            <span className="badge red" title={`Same name as ${twins.map((t) => t.name).join(', ')}. Open to merge.`}>
              Duplicate?
            </span>
          )}
          <span className="sung-count" title="Songs sung tonight">
            {s.songsSung}
            <I.Mic />
          </span>
        </div>
        <span className={`chev ${expanded ? 'open' : ''}`}>
          <I.ChevronRight />
        </span>
      </div>

      {expanded && (
        <div className="singer-body">
          {entries.length > 0 ? (
            <ol className="entry-list">
              {entries.map((e, k) => (
                <EntryRow key={e.id} entry={e} first={k === 0} last={k === entries.length - 1} index={k} />
              ))}
            </ol>
          ) : (
            <p className="muted small pad-y">No songs waiting.</p>
          )}
          <div className="singer-tools">
            <button
              className="btn sm"
              onClick={() => {
                setTarget(s.id);
                focusFinder();
              }}
            >
              <I.Plus /> Add a song
            </button>
            <button className="btn sm" onClick={() => act({ type: 'setSingerStatus', singerId: s.id, status: away ? 'active' : 'away' })}>
              <I.Coffee /> {away ? 'Back from break' : 'Mark away'}
            </button>
            {roundBased && (
              <>
                <button className="btn sm icon" disabled={index === 0} onClick={() => act({ type: 'moveSinger', singerId: s.id, toIndex: index - 1 })} aria-label="Move up">
                  <I.ChevronUp />
                </button>
                <button className="btn sm icon" disabled={last} onClick={() => act({ type: 'moveSinger', singerId: s.id, toIndex: index + 1 })} aria-label="Move down">
                  <I.ChevronDown />
                </button>
              </>
            )}
            {renaming ? (
              <form
                className="rename"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await act({ type: 'renameSinger', singerId: s.id, name: newName });
                  setRenaming(false);
                }}
              >
                <input className="input sm" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={32} onBlur={() => setRenaming(false)} />
              </form>
            ) : (
              <button className="btn sm icon" onClick={() => setRenaming(true)} aria-label="Rename" title="Rename">
                <I.Edit />
              </button>
            )}
            <span className="badge" title="The singer can use this to get back into their spot from another phone or browser">
              Rejoin code <strong className="code">{s.code}</strong>
            </span>
            <span className="spacer" />
            {confirmRemove ? (
              <button className="btn sm danger" onClick={() => act({ type: 'removeSinger', singerId: s.id }, `${s.name} removed`)} onBlur={() => setConfirmRemove(false)} autoFocus>
                Remove {s.name}?
              </button>
            ) : (
              <button className="btn sm ghost danger icon" onClick={() => setConfirmRemove(true)} aria-label="Remove singer" title="Remove singer">
                <I.Trash />
              </button>
            )}
          </div>
          {show.singers.length > 1 && (
            <div className="merge-row">
              <span className="muted small">Same person twice?</span>
              <select className="input sm" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} aria-label="Merge into">
                <option value="">Merge {s.name} into…</option>
                {[...twins, ...show.singers.filter((o) => o.id !== s.id && !twins.includes(o))].map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {twins.includes(o) ? ' (same name)' : ''}
                  </option>
                ))}
              </select>
              <button
                className="btn sm"
                disabled={!mergeInto}
                onClick={async () => {
                  const target = show.singers.find((o) => o.id === mergeInto);
                  await act({ type: 'mergeSingers', fromId: s.id, intoId: mergeInto }, `Merged ${s.name} into ${target?.name ?? 'singer'}`);
                  setMergeInto('');
                }}
              >
                Merge
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function EntryRow({ entry: e, first, last, index }: { entry: Entry; first: boolean; last: boolean; index: number }) {
  const { view, act, preview, setPreview } = useDj();
  const pinned = view.show.playNext.includes(e.id);
  const np = view.show.nowPlaying;
  const canCall = !np || np.stage === 'intro';
  return (
    <li className={`entry ${first ? 'first' : ''} ${preview === e.id ? 'previewing' : ''}`}>
      <SongThumb song={e.song} size={36} />
      <div className="entry-main ellipsis" onClick={() => setPreview(e.id)} title="Preview this song">
        <div className="entry-title ellipsis">{e.song.title}</div>
        <div className="entry-sub ellipsis">
          {e.song.artist}
          {e.note && <span className="entry-note"> “{e.note}”</span>}
        </div>
      </div>
      <div className="entry-badges">
        <SourceBadge song={e.song} />
        {e.wontPlay ? (
          <span className="badge red" title="YouTube won’t play this video here and Encore found no other version">
            won’t play
          </span>
        ) : (
          e.swappedFrom && (
            <span className="badge amber" title={`YouTube wouldn’t play “${e.swappedFrom}” here, so Encore swapped in this version`}>
              swapped
            </span>
          )
        )}
        {pinned && (
          <span className="badge accent">
            <I.Pin /> next
          </span>
        )}
      </div>
      <div className="row-actions show">
        {e.status === 'pending' ? (
          <>
            <button className="btn sm" onClick={() => act({ type: 'approveEntry', entryId: e.id })}>
              <I.Check /> Approve
            </button>
            <button className="btn ghost icon sm danger" onClick={() => act({ type: 'removeEntry', entryId: e.id })} aria-label="Reject">
              <I.X />
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost icon sm" disabled={first} onClick={() => act({ type: 'moveEntry', entryId: e.id, toIndex: index - 1 })} aria-label="Move up">
              <I.ChevronUp />
            </button>
            <button className="btn ghost icon sm" disabled={last} onClick={() => act({ type: 'moveEntry', entryId: e.id, toIndex: index + 1 })} aria-label="Move down">
              <I.ChevronDown />
            </button>
            <button
              className={`btn ghost icon sm ${pinned ? 'on' : ''}`}
              onClick={() => act({ type: pinned ? 'unpinEntry' : 'pinEntry', entryId: e.id })}
              title={pinned ? 'Unpin' : 'Play next (jump the line)'}
              aria-label={pinned ? 'Unpin' : 'Play next'}
            >
              <I.Pin />
            </button>
            {canCall && (
              <button className="btn ghost icon sm" onClick={() => act({ type: 'callEntry', entryId: e.id })} title="Call up now" aria-label="Call up now">
                <I.Mic />
              </button>
            )}
            <NotKaraokeButton entry={e} compact />
            <button className="btn ghost icon sm danger" onClick={() => act({ type: 'removeEntry', entryId: e.id })} aria-label="Remove song" title="Remove song">
              <I.Trash />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
