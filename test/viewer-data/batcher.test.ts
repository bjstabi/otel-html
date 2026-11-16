import type { Table } from '@uwdata/flechette';
import type { Query } from '@uwdata/mosaic-sql';
import { describe, expect, test } from 'vitest';
import { createBatcher } from '../../src/viewer/data/batcher.js';
import { type BatchItem, type QueryEngine, sequentialBatch } from '../../src/viewer/data/query-engine.js';

const q = (name: string): Query => name as unknown as Query;
const table = (name: string): Table => name as unknown as Table;

interface Fake {
  engine: QueryEngine;
  batches: string[][];
  /** Lets the statement of that name finish. */
  release: (name: string) => void;
  /** The signals the engine saw abort, by statement. */
  sawAbort: string[];
}

/** An engine whose statements finish when released (or at once for those not held), honouring each signal like `query`. */
function fake(opts: { fail?: ReadonlySet<string>; hold?: ReadonlySet<string> } = {}): Fake {
  const batches: string[][] = [];
  const gates = new Map<string, () => void>();
  const sawAbort: string[] = [];
  const engine: QueryEngine = {
    tempTables: true,
    prepare: () => Promise.resolve(),
    query: (x: Query, signal?: AbortSignal) => {
      const name = String(x);
      if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
      return new Promise<Table>((resolve, reject) => {
        const onAbort = (): void => {
          sawAbort.push(name);
          reject(new DOMException('aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const done = (): void => {
          signal?.removeEventListener('abort', onAbort);
          if (opts.fail?.has(name)) reject(new Error(`bad ${name}`));
          else resolve(table(name));
        };
        if (opts.hold?.has(name)) gates.set(name, done);
        else done();
      });
    },
    queryBatch(items: readonly BatchItem[]) {
      batches.push(items.map((i) => String(i.query)));
      return sequentialBatch(engine)(items);
    },
  } as unknown as QueryEngine;
  return { engine, batches, release: (n) => gates.get(n)?.(), sawAbort };
}

describe('the batcher', () => {
  test('three reads in one tick make one batch of three, each caller with its own result', async () => {
    const { engine, batches } = fake();
    const b = createBatcher(engine);
    const out = await Promise.all([b.query(q('a')), b.query(q('b')), b.query(q('c'))]);
    expect(batches).toEqual([['a', 'b', 'c']]);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  test('a read in a later tick is a batch of its own', async () => {
    const { engine, batches } = fake();
    const b = createBatcher(engine);
    await b.query(q('a'));
    await b.query(q('b'));
    expect(batches).toEqual([['a'], ['b']]);
  });

  test('an aborted signal rejects only its own query, which does not run', async () => {
    const { engine, batches } = fake();
    const b = createBatcher(engine);
    const gone = new AbortController();
    gone.abort();
    const results = await Promise.allSettled([b.query(q('a'), gone.signal), b.query(q('b'))]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'b' });
    expect(batches).toEqual([['b']]);
  });

  test('an abort between enqueue and send rejects only its caller', async () => {
    const { engine, batches } = fake();
    const b = createBatcher(engine);
    const c = new AbortController();
    const first = b.query(q('a'), c.signal);
    const second = b.query(q('b'));
    c.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBe('b');
    expect(batches).toEqual([['b']]);
  });

  test('a failing statement rejects only its own caller', async () => {
    const { engine } = fake({ fail: new Set(['b']) });
    const b = createBatcher(engine);
    const results = await Promise.allSettled([b.query(q('a')), b.query(q('b')), b.query(q('c'))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[1]).toMatchObject({ reason: { message: 'bad b' } });
  });

  test('a fast statement batched with a slow one resolves before the slow one', async () => {
    const f = fake({ hold: new Set(['slow']) });
    const b = createBatcher(f.engine);
    const slow = b.query(q('slow'));
    const fast = b.query(q('fast'));
    let slowDone = false;
    void slow.then(() => {
      slowDone = true;
    });
    await expect(fast).resolves.toBe('fast');
    expect(slowDone).toBe(false);
    f.release('slow');
    await expect(slow).resolves.toBe('slow');
    expect(f.batches).toEqual([['slow', 'fast']]);
  });

  test('an abort after the flush cancels that statement; its siblings complete', async () => {
    const f = fake({ hold: new Set(['a', 'b']) });
    const b = createBatcher(f.engine);
    const c = new AbortController();
    const a = b.query(q('a'), c.signal);
    const sibling = b.query(q('b'));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.batches).toEqual([['a', 'b']]);
    c.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.sawAbort).toEqual(['a']);
    f.release('b');
    await expect(sibling).resolves.toBe('b');
  });

  test('no abort listener stays on a signal after its statement settled', async () => {
    const { engine } = fake();
    const b = createBatcher(engine);
    const c = new AbortController();
    let open = 0;
    const add = c.signal.addEventListener.bind(c.signal);
    const remove = c.signal.removeEventListener.bind(c.signal);
    c.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      open++;
      add(...args);
    }) as typeof add;
    c.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      open--;
      remove(...args);
    }) as typeof remove;
    await Promise.all([b.query(q('a'), c.signal), b.query(q('b'), c.signal)]);
    expect(open).toBe(0);
  });
});
