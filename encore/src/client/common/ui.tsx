import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Song } from '../../shared/types.ts';
import { Alert, Check, Disc, Film, Music, X, YouTube } from './icons.tsx';

// --- toasts ------------------------------------------------------------------

interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 5000 : kind === 'info' ? 7000 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'error' ? <Alert /> : <Check />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: show errors as toasts. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (err) {
        toast((err as Error).message, 'error');
        return undefined;
      }
    },
    [toast],
  );
}

// --- modal -------------------------------------------------------------------

export function Modal({ title, onClose, children, width }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// --- song bits -----------------------------------------------------------------

export function SourceBadge({ song }: { song: Song }) {
  if (song.source.kind === 'youtube')
    return (
      <span className="badge yt">
        <YouTube /> YouTube
      </span>
    );
  const label = { video: 'Video', 'mp3+g': 'MP3+G', zip: 'MP3+G', audio: 'Audio' }[song.source.format];
  return (
    <span className="badge local">
      {song.source.format === 'video' ? <Film /> : <Disc />} {label}
    </span>
  );
}

export function SongThumb({ song, size = 44 }: { song: Song; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (song.thumbnail && !failed)
    return (
      <div className="thumb" style={style}>
        <img src={song.thumbnail} alt="" loading="lazy" onError={() => setFailed(true)} />
      </div>
    );
  return (
    <div className="thumb" style={style}>
      {song.source.kind === 'youtube' ? <YouTube /> : song.source.kind === 'local' && song.source.format === 'video' ? <Film /> : <Music />}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span />
    </label>
  );
}

export function Eq({ paused }: { paused?: boolean }) {
  return (
    <span className={`eq ${paused ? 'paused' : ''}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Re-render every `ms` so relative times stay fresh. */
export function useTick(ms: number): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function songLine(song: { title: string; artist: string }): string {
  return song.artist ? `${song.title} — ${song.artist}` : song.title;
}

/** YouTube's API terms ask apps that search YouTube to link these. */
export function YouTubeTerms({ short }: { short?: boolean }) {
  const tos = (
    <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">
      YouTube Terms of Service
    </a>
  );
  const privacy = (
    <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
      Google Privacy Policy
    </a>
  );
  return short ? (
    <span className="yt-terms">
      Results from YouTube · {tos} · {privacy}
    </span>
  ) : (
    <span className="yt-terms">
      YouTube search is provided by YouTube; using it means agreeing to the {tos}. See also the {privacy}.
    </span>
  );
}
