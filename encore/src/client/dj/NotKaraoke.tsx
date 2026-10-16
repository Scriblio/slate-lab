// "Not karaoke": the KJ's call that a YouTube request isn't a karaoke version.
// It removes the request, tells the singer, and hides the video from searches
// on this laptop. Two taps, so a stray click can't do it.

import { useEffect, useState } from 'react';
import type { Entry } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { useDj } from './context.ts';

export function NotKaraokeButton({ entry, compact }: { entry: Entry; compact?: boolean }) {
  const { act } = useDj();
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);

  if (entry.song.source.kind !== 'youtube') return null;
  return (
    <button
      className={`btn sm not-karaoke ${armed ? 'danger' : 'ghost'} ${compact && !armed ? 'icon' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) return setArmed(true);
        setArmed(false);
        void act({ type: 'notKaraoke', entryId: entry.id }, 'Removed. The singer was told, and this video is hidden from YouTube searches here.');
      }}
      title="Not a karaoke version: remove it, tell the singer, and hide this video from searches on this laptop"
      aria-label="Not a karaoke version"
    >
      {armed ? (
        'Sure? Not karaoke'
      ) : compact ? (
        <I.Alert />
      ) : (
        <>
          <I.Alert /> Not karaoke
        </>
      )}
    </button>
  );
}
