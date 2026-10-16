// The computed running order: who sings when, with wait estimates.

import { Fragment } from 'react';
import { isRoundBased } from '../../shared/rotation.ts';
import { formatWait } from '../../shared/text.ts';
import * as I from '../common/icons.tsx';
import { useDj } from './context.ts';

export function UpNext() {
  const { view, act, preview, setPreview } = useDj();
  const list = view.upcoming;
  const roundBased = isRoundBased(view.show.mode);
  const shuffle = view.show.mode === 'shuffle';
  // Calling someone up mid-song would cut the current singer off.
  const canCall = !view.show.nowPlaying || view.show.nowPlaying.stage === 'intro';
  const total = list.reduce((s, u) => s + (u.entry.song.durationSec ?? view.show.settings.defaultSongSec) + view.show.settings.changeoverSec, 0);

  return (
    <div className="card upnext-card">
      <div className="card-head">
        <h3>
          Up next <span className="count">{list.length}</span>
        </h3>
        {list.length > 0 && <span className="muted small">≈ {formatWait(total).replace('~', '')} of singing queued</span>}
      </div>
      {list.length === 0 ? (
        <div className="empty small">
          <span>When singers add songs, the running order shows up here.</span>
        </div>
      ) : (
        <ol className="upnext-list">
          {list.map((u, i) => {
            const newRound = roundBased && i > 0 && u.round !== list[i - 1]!.round;
            return (
              <Fragment key={u.entry.id}>
                {newRound && (
                  <li className="round-divider">
                    <span>
                      Round {u.round}
                      {shuffle && ' · order reshuffles'}
                    </span>
                  </li>
                )}
                <li className={`upnext-row ${i === 0 ? 'first' : ''} ${preview === u.entry.id ? 'previewing' : ''}`}>
                  <span className="upnext-pos">{i + 1}</span>
                  <div className="upnext-main ellipsis" onClick={() => setPreview(u.entry.id)} title="Preview this song">
                    <div className="upnext-singer ellipsis">
                      {u.singer.name}
                      {u.pinned && (
                        <span className="badge accent" title="Pinned to play next">
                          <I.Pin /> next
                        </span>
                      )}
                    </div>
                    <div className="upnext-song ellipsis">{u.entry.song.title}</div>
                  </div>
                  <span className="upnext-eta">{i === 0 && !view.show.nowPlaying ? 'now' : formatWait(u.etaSec)}</span>
                  <div className="row-actions">
                    {u.pinned ? (
                      <button className="btn ghost icon sm" onClick={() => act({ type: 'unpinEntry', entryId: u.entry.id })} title="Unpin" aria-label="Unpin">
                        <I.X />
                      </button>
                    ) : (
                      i > 0 && (
                        <button className="btn ghost icon sm" onClick={() => act({ type: 'pinEntry', entryId: u.entry.id })} title="Play next" aria-label="Play next">
                          <I.Pin />
                        </button>
                      )
                    )}
                    {canCall && (
                      <button className="btn ghost icon sm" onClick={() => act({ type: 'callEntry', entryId: u.entry.id })} title="Call up now" aria-label="Call up now">
                        <I.Mic />
                      </button>
                    )}
                  </div>
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
    </div>
  );
}
