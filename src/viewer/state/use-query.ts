import { useEffect, useMemo, useRef, useState } from 'react';
import type { DataSource } from '../data/data-source.js';

type QueryState<R> =
  | { status: 'loading'; previous: R | null }
  | { status: 'ready'; result: R }
  | { status: 'error'; message: string };

export interface QueryHandle<R> {
  state: QueryState<R>;
}

/** One data-source query method: what `useQuery` calls. */
export type QueryRunner<Q, R> = (dataSource: DataSource, q: Q, signal: AbortSignal) => Promise<R>;

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * Runs `query` through `run` whenever it changes. The previous in-flight query is aborted and its result
 * discarded, so a slow earlier query can never replace a newer one. While a query runs, the last result stays
 * available as `previous`. `run` must be a stable (module-level) function.
 */
export function useQuery<Q, R>(dataSource: DataSource, query: Q, run: QueryRunner<Q, R>): QueryHandle<R> {
  const key = JSON.stringify(query);
  // The query object is rebuilt each render; its serialisation is the identity that matters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the query's identity
  const stable = useMemo(() => query, [key]);
  const [state, setState] = useState<QueryState<R>>({ status: 'loading', previous: null });
  const lastResult = useRef<R | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', previous: lastResult.current });
    // A data source may throw before returning a promise (invalid query); that is a query failure too.
    let pending: Promise<R>;
    try {
      pending = run(dataSource, stable, controller.signal);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (result) => {
        if (controller.signal.aborted) return;
        lastResult.current = result;
        setState({ status: 'ready', result });
      },
      (e: unknown) => {
        if (controller.signal.aborted || isAbort(e)) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => controller.abort();
  }, [dataSource, stable, run]);

  return { state };
}
