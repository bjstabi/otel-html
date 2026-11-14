import { useEffect, useState } from 'react';
import { isGoneFile } from '../data/refresh-report.js';

export type KeyedState<V> =
  | { status: 'loading' }
  | { status: 'ready'; value: V }
  | {
      status: 'error';
      message: string /** D56: a registered file the site no longer serves. */;
      gone: boolean;
    };

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/**
 * Loads one value per key. A change of key aborts the previous load and resets to `loading`, so a result for a key
 * the user has moved on from is never shown. A `null` key loads nothing. `load` must be stable (module-level, or
 * memoized on what it closes over); a new `load` reloads. A load that throws synchronously still lands in `error`.
 */
export function useKeyedAsync<K, V>(
  key: K | null,
  load: (key: K, signal: AbortSignal) => Promise<V>,
): KeyedState<V> {
  const [state, setState] = useState<{ key: K; result: KeyedState<V> } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const ctl = new AbortController();
    // a synchronous throw is the load's own failure, an AbortError included; a rejection with one is a source that was
    // superseded (below)
    let sync = false;
    Promise.resolve()
      .then(() => {
        try {
          return load(key, ctl.signal);
        } catch (e) {
          sync = true;
          throw e;
        }
      })
      .then(
        (value) => ctl.signal.aborted || setState({ key, result: { status: 'ready', value } }),
        (e: unknown) =>
          // an abort is not a failure, whoever aborted: the key or the data source is about to change
          ctl.signal.aborted ||
          (!sync && isAbort(e)) ||
          setState({
            key,
            result: {
              status: 'error',
              message: e instanceof Error ? e.message : String(e),
              gone: isGoneFile(e),
            },
          }),
      );
    return () => ctl.abort();
  }, [key, load]);
  return key !== null && state !== null && state.key === key ? state.result : { status: 'loading' };
}
