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
 * leave together as one `queryBatch`, so a server can answer a page's statements in one request. Each caller gets the
 * promise of its own statement, which settles as that statement does and carries the caller's own signal: a statement
 * already aborted never runs, and one aborted later is cancelled by the engine as `query` would.
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
    let promises: Promise<Table>[];
    try {
      promises = engine.queryBatch(live.map((i) => ({ query: i.q, signal: i.signal })));
    } catch (error) {
      for (const item of live) item.reject(error);
      return;
    }
    live.forEach((item, at) => {
      const p = promises[at];
      if (p === undefined) item.reject(new Error('the engine returned fewer statements than it was sent'));
      else p.then(item.resolve, item.reject);
    });
  };
  return {
    prepare: (paths, signal) => engine.prepare(paths, signal),
    query(q, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<Table>((resolve, reject) => {
        pending.push({ q, signal, resolve, reject });
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
