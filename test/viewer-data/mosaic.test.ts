import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { tableFromArrays, tableToIPC } from '@uwdata/flechette';
import type { Connector } from '@uwdata/mosaic-core';
import { count, Query } from '@uwdata/mosaic-sql';
import { expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import {
  createCoordinator,
  engineConnector,
  mosaicQueryEngine,
  restQueryEngine,
} from '../../src/viewer/data/mosaic.js';
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

function fakeFetch(respond: (body: string) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond(String(init.body));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('restQueryEngine posts {type, sql} as JSON and decodes the Arrow answer', async () => {
  const f = fakeFetch(() => new Response(ipcBytes({ n: [5n] }) as BodyInit));
  const qe = restQueryEngine('http://127.0.0.1:1/query', silentLogger, f.impl);
  const q = Query.from('spans').select({ n: count() });
  expect(qe.tempTables).toBe(false);
  const t = await qe.query(q);
  expect(t.getChild('n')?.at(0)).toBe(5n);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.url).toBe('http://127.0.0.1:1/query');
  expect(f.calls[0]?.init.method).toBe('POST');
  expect(new Headers(f.calls[0]?.init.headers).get('content-type')).toBe('application/json');
  expect(JSON.parse(String(f.calls[0]?.init.body))).toEqual({ type: 'arrow', sql: String(q) });
});

test('restQueryEngine maps a 400 to invalid-report with the body and the SQL', async () => {
  const f = fakeFetch(() => new Response('Parser Error: x', { status: 400 }));
  const qe = restQueryEngine('http://127.0.0.1:1/query', silentLogger, f.impl);
  const q = Query.from('spans').select({ n: count() });
  const err = await qe.query(q).catch((e: unknown) => e);
  expect(err).toMatchObject({ code: 'invalid-report' });
  expect((err as OtelHtmlError).actual).toBe('Parser Error: x');
  expect(JSON.stringify(err)).toContain('Parser Error: x');
  expect((err as OtelHtmlError).hint).toBe(String(q));
});

test.each([
  [413, "the result is larger than the host's --max-result-bytes"],
  [503, 'the host is busy or stopping'],
  [504, 'the host did not finish the query in time (--timeout)'],
])('restQueryEngine maps a %i to an accurate invalid-report', async (status, text) => {
  const f = fakeFetch(() => new Response('body', { status }));
  const qe = restQueryEngine('http://127.0.0.1:1/query', silentLogger, f.impl);
  const q = Query.from('spans').select({ n: count() });
  const err = (await qe.query(q).catch((e: unknown) => e)) as OtelHtmlError;
  expect(err).toBeInstanceOf(OtelHtmlError);
  expect(err.code).toBe('invalid-report');
  expect(err.actual).toBe(`${text}: body`);
  expect(err.hint).toBe(String(q));
});

test.each([413, 503, 504])(
  'restQueryEngine keeps only the ruled wording for a %i with an empty body',
  async (status) => {
    const f = fakeFetch(() => new Response('', { status }));
    const qe = restQueryEngine('http://127.0.0.1:1/query', silentLogger, f.impl);
    const err = (await qe
      .query(Query.from('spans').select({ n: count() }))
      .catch((e: unknown) => e)) as OtelHtmlError;
    expect(err.actual).not.toMatch(/: $/);
    expect(err.actual).not.toContain('undefined');
  },
);

test('restQueryEngine maps a network failure to "the host did not answer"', async () => {
  const impl = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  const qe = restQueryEngine('http://127.0.0.1:1/query', silentLogger, impl);
  const err = (await qe
    .query(Query.from('spans').select({ n: count() }))
    .catch((e: unknown) => e)) as OtelHtmlError;
  expect(err.code).toBe('invalid-report');
  expect(err.actual).toBe('the host did not answer (is otel-html host still running?)');
});

test('restQueryEngine refuses temp tables and DDL, close resolves, abort rejects', async () => {
  const f = fakeFetch(() => new Response(ipcBytes({ n: [1n] }) as BodyInit));
  const qe = restQueryEngine('http://127.0.0.1:1/query', silentLogger, f.impl);
  await expect(qe.registerText('a', 'b')).rejects.toMatchObject({ code: 'usage' });
  await expect(qe.exec('CREATE TABLE t (a INT)')).rejects.toMatchObject({ code: 'usage' });
  const ctl = new AbortController();
  ctl.abort();
  await expect(qe.query(Query.from('spans').select('x'), ctl.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(f.calls).toHaveLength(0);
  await expect(qe.close()).resolves.toBeUndefined();
});

test('clearCache forgets cached results: the same query reaches the connector again', async () => {
  const connector = fakeConnector({ n: [1n] });
  const qe = mosaicQueryEngine(createCoordinator(connector, silentLogger), fakeFiles());
  const q = Query.from('spans').select({ n: count() });
  await qe.query(q);
  await qe.query(q);
  const cached = connector.requests.length;
  qe.clearCache();
  await qe.query(q);
  expect(connector.requests.length).toBe(cached + 1);
});
