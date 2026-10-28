import { useEffect, useState } from 'react';

export type KeyedState<V> =
  | { status: 'loading' }
  | { status: 'ready'; value: V }
  | { status: 'error'; message: string };

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
    Promise.resolve()
      .then(() => load(key, ctl.signal))
      .then(
        (value) => ctl.signal.aborted || setState({ key, result: { status: 'ready', value } }),
        (e: unknown) =>
          ctl.signal.aborted ||
          setState({
            key,
            result: { status: 'error', message: e instanceof Error ? e.message : String(e) },
          }),
      );
    return () => ctl.abort();
  }, [key, load]);
  return key !== null && state !== null && state.key === key ? state.result : { status: 'loading' };
}
