import type { Query } from '@uwdata/mosaic-sql';
import type { QueryEngine } from './query-engine.js';

type Table = Awaited<ReturnType<QueryEngine['query']>>;

interface Pending {
  q: Query;
  signal: AbortSignal | undefined;
  resolve: (t: Table) => void;
  reject: (e: unknown) => void;
}

const abortError = (): DOMException => new DOMException('The query was aborted', 'AbortError');

/**
 * What the data source reads through: `prepare` goes straight to the engine, and the `query` calls of one microtask
 * leave together as one `queryBatch`, so a server can answer a page's statements in one request. Each caller gets its
 * own entry: a failed statement rejects only its caller, and a caller whose signal aborts rejects with
 * `DOMException('AbortError')` alone (a statement already aborted never runs). The batch's own signal aborts when
 * every statement in it has.
 */
export function createBatcher(engine: QueryEngine): Pick<QueryEngine, 'prepare' | 'query'> {
  let pending: Pending[] = [];
  const flush = (): void => {
    const items = pending;
    pending = [];
    const live = items.filter((i) => {
      if (!i.signal?.aborted) return true;
      i.reject(abortError());
      return false;
    });
    if (live.length === 0) return;
    let signal: AbortSignal | undefined;
    const first = live[0]?.signal;
    if (live.every((i) => i.signal === first))
      signal = first; // the common case: one page signal
    else if (live.every((i) => i.signal !== undefined)) {
      const all = new AbortController();
      const check = (): void => {
        if (live.every((i) => i.signal?.aborted)) all.abort();
      };
      for (const i of live) i.signal?.addEventListener('abort', check, { once: true });
      signal = all.signal;
    }
    engine
      .queryBatch(
        live.map((i) => i.q),
        signal,
      )
      .then(
        (settled) => {
          live.forEach((item, at) => {
            const r = settled[at];
            if (r?.status === 'fulfilled') item.resolve(r.value);
            else item.reject(r?.reason ?? new Error('the engine settled fewer statements than it was sent'));
          });
        },
        (error: unknown) => {
          for (const item of live) item.reject(error);
        },
      );
  };
  return {
    prepare: (paths, signal) => engine.prepare(paths, signal),
    query(q, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<Table>((resolve, reject) => {
        // the caller's own abort rejects it at once, whatever the rest of the batch does
        const onAbort = (): void => reject(abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        const item: Pending = {
          q,
          signal,
          resolve: (t) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(t);
          },
          reject: (e) => {
            signal?.removeEventListener('abort', onAbort);
            reject(e);
          },
        };
        pending.push(item);
        if (pending.length === 1) queueMicrotask(flush);
      });
    },
  };
}

const batchers = new WeakMap<QueryEngine, Pick<QueryEngine, 'prepare' | 'query'>>();

/** The one batcher of an engine, shared by every data source over it so a page's statements meet in one batch. */
export function batcherFor(engine: QueryEngine): Pick<QueryEngine, 'prepare' | 'query'> {
  const hit = batchers.get(engine);
  if (hit) return hit;
  const made = createBatcher(engine);
  batchers.set(engine, made);
  return made;
}
