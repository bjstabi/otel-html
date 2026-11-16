import { useCallback, useEffect, useRef, useState } from 'react';
import type { RowCursor } from '../../query/sql/cursor.js';

/** Rows a list asks for at a time, and loads more of as the reader scrolls near the end. */
const PAGE_SIZE = 200;

/** The rows one statement asks for: a page, never more than the report's `listCap`. */
export function pageSize(listCap: number): number {
  return Math.min(PAGE_SIZE, listCap);
}

export interface ListPages<Row> {
  /** The first page's rows, then every page loaded after it (never more than `cap`). */
  rows: readonly Row[];
  /** Whether a page is on its way. */
  loading: boolean;
  /** The message of the last failed page; cleared by the next try. */
  error: string | null;
  /** Asks for the next page; does nothing while one is on its way, after the last, or at `cap`. */
  loadMore(): void;
}

interface Loaded<Row> {
  /** The first-page result these rows continue: another result starts the list over. */
  base: object;
  rows: readonly Row[];
  next: RowCursor | null;
}

/**
 * The rows of a list that loads further pages after its first. `first` is the first page's result and `key` the
 * identity of its query: when either changes, the pages loaded so far are dropped and a page still on its way is
 * aborted, so a slow old page never joins a newer list.
 */
export function useListPages<Row>(
  first: { rows: readonly Row[]; next: RowCursor | null } | null,
  key: string,
  cap: number,
  loadNext: (
    cursor: RowCursor,
    signal: AbortSignal,
  ) => Promise<{ rows: readonly Row[]; next: RowCursor | null }>,
): ListPages<Row> {
  const [loaded, setLoaded] = useState<Loaded<Row> | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });
  const flight = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or first page starts the list over
  useEffect(() => {
    flight.current?.abort();
    flight.current = null;
    setState({ loading: false, error: null });
  }, [key, first]);
  useEffect(() => () => flight.current?.abort(), []);

  // The key `first` arrived under: while a new query loads, `first` is still the previous result, so its rows and its
  // cursor belong to a query that is no longer asked and continue nothing until another `first` arrives.
  const [owner, setOwner] = useState<{ first: object | null; key: string }>({ first, key });
  if (owner.first !== first) setOwner({ first, key });
  const current = owner.first !== first || owner.key === key;

  const extra = current && first !== null && loaded !== null && loaded.base === first ? loaded : null;
  const rows = first === null ? [] : extra === null ? first.rows : [...first.rows, ...extra.rows];
  const held = rows.length > cap ? rows.slice(0, cap) : rows;
  const next = first === null ? null : extra === null ? first.next : extra.next;
  const cursor = !current || held.length >= cap ? null : next;

  const latest = useRef({ first, cursor, loadNext, loading: state.loading });
  latest.current = { first, cursor, loadNext, loading: state.loading };

  const loadMore = useCallback((): void => {
    const { first: base, cursor: at, loadNext: load, loading } = latest.current;
    if (base === null || at === null || loading) return;
    const controller = new AbortController();
    flight.current = controller;
    latest.current = { ...latest.current, loading: true };
    setState({ loading: true, error: null });
    load(at, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setLoaded((prev) => ({
          base,
          rows: prev !== null && prev.base === base ? [...prev.rows, ...page.rows] : page.rows,
          next: page.next,
        }));
        setState({ loading: false, error: null });
      },
      (e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ loading: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
  }, []);

  return {
    rows: held,
    loading: state.loading,
    error: state.error,
    loadMore: cursor === null ? noop : loadMore,
  };
}

function noop(): void {}
