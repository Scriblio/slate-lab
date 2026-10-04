// The song list on the phone: every song in the KJ's library, in order, to
// scroll through. Loads a page at a time as it nears the bottom, can sort by
// artist or title, and has an A-Z bar to jump around a big library.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { BrowseResult, SearchResult } from '../../shared/types.ts';
import * as I from '../common/icons.tsx';
import { request, type AppSocket } from '../common/socket.ts';
import { useToast } from '../common/ui.tsx';

type Sort = 'artist' | 'title';

/**
 * Keeps a CSS variable on the page equal to an element's height, so pieces
 * that stick to the top can stack neatly under it (see --head-h and
 * --search-h in join.css).
 */
export function useHeightVar(ref: RefObject<HTMLElement | null>, name: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty(name, `${el.offsetHeight}px`);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty(name);
    };
  }, [ref, name]);
}

interface Page {
  items: SearchResult[];
  /** Where the first item sits in the whole list. */
  start: number;
  total: number;
  letters: string[];
  loading: boolean;
}

const EMPTY: Page = { items: [], start: 0, total: 0, letters: [], loading: true };

export function BrowseList({ socket, renderRow }: { socket: AppSocket; renderRow: (r: SearchResult) => ReactNode }) {
  const toast = useToast();
  const [sort, setSort] = useState<Sort>('artist');
  const [letter, setLetter] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(EMPTY);
  const [failed, setFailed] = useState(false);
  /** Bumped by "Try again" to start the list over. */
  const [attempt, setAttempt] = useState(0);
  /** Ignores answers to a request the singer has already moved on from. */
  const generation = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);
  const listTop = useRef<HTMLUListElement>(null);
  const fetching = useRef(false);
  /** Set when the singer picks a sort or a letter, so the new list is scrolled into view when it arrives. */
  const jumped = useRef(false);

  // Start (or restart) the list: from the top, or at a letter.
  useEffect(() => {
    const gen = ++generation.current;
    fetching.current = true;
    setFailed(false);
    setPage((p) => ({ ...EMPTY, letters: p.letters }));
    request<BrowseResult>(socket, 'browse', letter ? { sort, letter } : { sort, offset: 0 })
      .then((r) => {
        if (gen !== generation.current) return;
        setPage({ items: r.items, start: r.offset, total: r.total, letters: r.letters, loading: false });
        if (jumped.current) {
          jumped.current = false;
          requestAnimationFrame(() => listTop.current?.scrollIntoView({ block: 'start' }));
        }
      })
      .catch((e: Error) => {
        if (gen !== generation.current) return;
        setFailed(true);
        setPage((p) => ({ ...p, loading: false }));
        toast(e.message, 'error');
      })
      .finally(() => {
        if (gen === generation.current) fetching.current = false;
      });
  }, [socket, sort, letter, attempt, toast]);

  const more = useCallback(() => {
    const gen = generation.current;
    const next = page.start + page.items.length;
    if (fetching.current || page.loading || failed || next >= page.total) return;
    fetching.current = true;
    setPage((p) => ({ ...p, loading: true }));
    request<BrowseResult>(socket, 'browse', { sort, offset: next })
      .then((r) => {
        if (gen !== generation.current) return;
        setPage((p) => ({ ...p, items: [...p.items, ...r.items], total: r.total, loading: false }));
      })
      .catch((e: Error) => {
        if (gen !== generation.current) return;
        setFailed(true);
        setPage((p) => ({ ...p, loading: false }));
        toast(e.message, 'error');
      })
      .finally(() => {
        if (gen === generation.current) fetching.current = false;
      });
  }, [socket, sort, page.start, page.items.length, page.total, page.loading, failed, toast]);

  // Load the next page when the end of the list scrolls into view (a little early, so it never runs dry).
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && more(), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  // Keep the chosen letter visible in the jump bar.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = bar.current?.querySelector<HTMLElement>('button.on');
    if (on && bar.current) bar.current.scrollTo({ left: on.offsetLeft - bar.current.clientWidth / 2 + on.clientWidth / 2, behavior: 'smooth' });
  }, [letter]);

  const atEnd = page.start + page.items.length >= page.total;

  return (
    <section className="browse">
      <div className="browse-head">
        <h3 className="section-title">
          <I.Disc /> All songs{page.total > 0 && <span className="browse-count">{page.total.toLocaleString()}</span>}
        </h3>
        <div className="seg" role="group" aria-label="Sort songs">
          {(['artist', 'title'] as const).map((s) => (
            <button
              key={s}
              className={sort === s ? 'on' : ''}
              aria-pressed={sort === s}
              onClick={() => {
                if (s === sort) return;
                jumped.current = true;
                setSort(s);
                setLetter(null);
              }}
            >
              {s === 'artist' ? 'Artist' : 'Title'}
            </button>
          ))}
        </div>
      </div>

      {page.letters.length > 1 && (
        <div className="letters" role="group" aria-label="Jump to a letter" ref={bar}>
          <button
            onClick={() => {
              jumped.current = true;
              setLetter(null);
            }}
            aria-label="Back to the top"
          >
            Top
          </button>
          {page.letters.map((l) => (
            <button
              key={l}
              className={letter === l ? 'on' : ''}
              onClick={() => {
                jumped.current = true;
                setLetter(l);
              }}
              aria-label={l === '#' ? 'Numbers and symbols' : `Songs starting with ${l}`}
            >
              {l}
            </button>
          ))}
        </div>
      )}

      <ul className="results" ref={listTop}>
        {page.items.map((r) => renderRow(r))}
      </ul>

      {page.loading && (
        <p className="muted small pad browse-status">
          <I.Loader /> Loading songs…
        </p>
      )}
      {failed && !page.loading && (
        <div className="browse-status">
          <button
            className="btn sm"
            onClick={() => {
              setFailed(false);
              if (page.items.length === 0) setAttempt((n) => n + 1);
              else more();
            }}
          >
            Try again
          </button>
        </div>
      )}
      {!page.loading && !failed && atEnd && page.items.length > 0 && <p className="muted small pad browse-status">That’s every song. Use search for anything else.</p>}
      {!page.loading && !failed && page.total === 0 && <p className="muted pad">The KJ’s library is empty right now.</p>}
      <div ref={sentinel} aria-hidden="true" style={{ height: 1 }} />
    </section>
  );
}
