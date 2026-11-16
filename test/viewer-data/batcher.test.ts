import type { Table } from '@uwdata/flechette';
import type { Query } from '@uwdata/mosaic-sql';
import { describe, expect, test } from 'vitest';
import { createBatcher } from '../../src/viewer/data/batcher.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';

const q = (name: string): Query => name as unknown as Query;
const table = (name: string): Table => name as unknown as Table;

function fake(fail: ReadonlySet<string> = new Set()): { engine: QueryEngine; batches: string[][] } {
  const batches: string[][] = [];
  const engine = {
    tempTables: true,
    prepare: () => Promise.resolve(),
    query: () => Promise.reject(new Error('the batcher goes through queryBatch')),
    queryBatch: (qs: readonly Query[]) => {
      batches.push(qs.map(String));
      return Promise.resolve(
        qs.map(
          (x): PromiseSettledResult<Table> =>
            fail.has(String(x))
              ? { status: 'rejected', reason: new Error(`bad ${String(x)}`) }
              : { status: 'fulfilled', value: table(String(x)) },
        ),
      );
    },
  } as unknown as QueryEngine;
  return { engine, batches };
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
    const { engine } = fake(new Set(['b']));
    const b = createBatcher(engine);
    const results = await Promise.allSettled([b.query(q('a')), b.query(q('b')), b.query(q('c'))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(results[1]).toMatchObject({ reason: { message: 'bad b' } });
  });
});
