import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { tableFromArrays, tableToIPC } from '@uwdata/flechette';
import type { Connector } from '@uwdata/mosaic-core';
import { count, Query } from '@uwdata/mosaic-sql';
import { expect, test } from 'vitest';
import { createCoordinator, engineConnector, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import { buildFormat4Report, openFixtureDb, spansOnlyRequest } from '../../test-support/format4-fixture.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const ipcBytes = (cols: Record<string, unknown[]>): Uint8Array =>
  tableToIPC(tableFromArrays(cols as Parameters<typeof tableFromArrays>[0]), {
    format: 'stream',
  }) as Uint8Array;

function fakeConnector(
  cols: Record<string, unknown[]>,
): Connector & { requests: { type: string; sql: string }[] } {
  const requests: { type: string; sql: string }[] = [];
  const query = async (r: { type: string; sql: string }) => {
    requests.push({ type: r.type, sql: r.sql });
    return r.type === 'exec' ? undefined : ipcBytes(cols);
  };
  return { query, requests } as unknown as Connector & { requests: { type: string; sql: string }[] };
}

function failingConnector(message: string): Connector {
  return { query: async () => Promise.reject(new Error(message)) } as unknown as Connector;
}

function fakeFiles() {
  const texts = new Map<string, string>();
  return { texts, registerText: (n: string, t: string) => void texts.set(n, t), close: () => undefined };
}

test('query decodes int64 as bigint and the coordinator caches the same SQL', async () => {
  const conn = fakeConnector({ n: [5n] });
  const qe = mosaicQueryEngine(createCoordinator(conn, silentLogger), fakeFiles());
  const t1 = await qe.query(Query.from('spans').select({ n: count() }));
  expect(t1.getChild('n')?.at(0)).toBe(5n);
  await qe.query(Query.from('spans').select({ n: count() }));
  expect(conn.requests).toHaveLength(1);
});

test('an aborted signal rejects with AbortError', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const qe = mosaicQueryEngine(createCoordinator(fakeConnector({}), silentLogger), fakeFiles());
  await expect(qe.query(Query.from('spans').select('x'), ctl.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
});

test('aborting while the query is pending rejects with AbortError', async () => {
  const ctl = new AbortController();
  const qe = mosaicQueryEngine(createCoordinator(fakeConnector({ n: [1n] }), silentLogger), fakeFiles());
  const pending = qe.query(Query.from('spans').select('x'), ctl.signal);
  ctl.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

test('an engine error carries the SQL as its hint', async () => {
  const qe = mosaicQueryEngine(
    createCoordinator(failingConnector('Binder Error: x'), silentLogger),
    fakeFiles(),
  );
  await expect(qe.query(Query.from('spans').select('x'))).rejects.toMatchObject({
    code: 'invalid-report',
    hint: expect.stringContaining('SELECT'),
  });
});

test('exec is an exec request and registerText reaches the engine files', async () => {
  const conn = fakeConnector({});
  const files = fakeFiles();
  const qe = mosaicQueryEngine(createCoordinator(conn, silentLogger), files);
  await qe.exec('CREATE TEMP TABLE t AS SELECT 1');
  expect(conn.requests.at(-1)).toMatchObject({
    type: 'exec',
    sql: expect.stringContaining('CREATE TEMP TABLE'),
  });
  await qe.registerText('ids.csv', 'filename,row\n');
  expect(files.texts.get('ids.csv')).toBe('filename,row\n');
});

test('engineConnector runs arrow and exec requests through useUnsafe/runQuery', async () => {
  const seen: string[] = [];
  const connection = {
    useUnsafe: (f: (b: { runQuery(id: number, sql: string): Promise<Uint8Array> }, id: number) => unknown) =>
      f(
        {
          runQuery: async (_id, sql) => {
            seen.push(sql);
            return ipcBytes({ n: [1n] });
          },
        },
        1,
      ),
  } as unknown as AsyncDuckDBConnection;
  const c = engineConnector(connection);
  const bytes = await c.query({ type: 'arrow', sql: 'SELECT 1 AS n' });
  expect(bytes).toBeInstanceOf(Uint8Array);
  await expect(c.query({ type: 'exec', sql: 'CREATE VIEW v AS SELECT 1' })).resolves.toBeUndefined();
  expect(seen).toEqual(['SELECT 1 AS n', 'CREATE VIEW v AS SELECT 1']);
  await expect(
    (c as unknown as { query(r: { type: string; sql: string }): Promise<unknown> }).query({
      type: 'json',
      sql: 'x',
    }),
  ).rejects.toMatchObject({ code: 'invalid-report' });
});

test('the same connector shape runs against the Node engine', async () => {
  const db = await openFixtureDb(await buildFormat4Report([spansOnlyRequest(3)]));
  const t = await mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db).query(
    Query.from('spans').select({ n: count() }),
  );
  expect(t.getChild('n')?.at(0)).toBe(3n);
});

test('aborting after the request reached the connector rejects with AbortError', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reached: () => void = () => undefined;
  const sent = new Promise<void>((r) => {
    reached = r;
  });
  const connector = {
    query: async () => {
      reached();
      await gate;
      return ipcBytes({ n: [1n] });
    },
  } as unknown as Connector;
  const ctl = new AbortController();
  const qe = mosaicQueryEngine(createCoordinator(connector, silentLogger), fakeFiles());
  const pending = qe.query(Query.from('spans').select('x'), ctl.signal);
  const outcome = pending.catch((e: unknown) => e);
  await sent;
  ctl.abort();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  release();
});

test('close clears the coordinator before closing the files', async () => {
  const events: string[] = [];
  const coordinator = createCoordinator(fakeConnector({}), silentLogger);
  const clear = coordinator.clear.bind(coordinator);
  coordinator.clear = (...a: Parameters<typeof clear>) => {
    events.push('clear');
    clear(...a);
  };
  const qe = mosaicQueryEngine(coordinator, {
    ...fakeFiles(),
    close: () => void events.push('files.close'),
  });
  await qe.close();
  expect(events).toEqual(['clear', 'files.close']);
});
