import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import { type QueryEngine, sequentialBatch } from '../../src/viewer/data/query-engine.js';
import type { SpanPointsQuery } from '../../src/viewer/data/results.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../test-support/format4-fixture.js';
import { attr, span, traceRequest } from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const BASE = BigInt(EPOCH_NS);
// more spans than a list page (200), so a point plot that stays on the first page shows
const N = 260;
const hex = (n: number, w: number): string => n.toString(16).padStart(w, '0');

let f: Format4Fixture;
let db: TestDb;
const sources: DataSource[] = [];

function recording() {
  const inner = mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db);
  const statements: string[] = [];
  const engine: QueryEngine = {
    ...inner,
    queryBatch: (items) => sequentialBatch(engine)(items),
    query: (q, signal) => {
      statements.push(String(q));
      return inner.query(q, signal);
    },
  };
  const source = createDuckDbDataSource({ engine, manifest: f.manifest });
  sources.push(source);
  return { source, statements };
}

beforeAll(async () => {
  const spans = Array.from({ length: N }, (_, i) =>
    span({
      traceId: hex(i + 1, 32),
      spanId: hex(i + 1, 16),
      name: `op-${i}`,
      startTimeUnixNano: String(BASE + BigInt(i) * 1_000_000n),
      endTimeUnixNano: String(BASE + BigInt(i) * 1_000_000n + BigInt(i + 1) * 1000n),
      status: { code: i % 4 === 0 ? 2 : 1 },
    }),
  );
  f = await buildFormat4Report(
    [otlp(traceRequest(spans, [attr('service.name', { stringValue: 'svc' })]) as never)],
    { close: false },
  );
  db = await openFixtureDb(f);
});
afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
});

const points: SpanPointsQuery = {
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'desc' },
  limit: 1000,
};
const signal = new AbortController().signal;

describe('spanPoints', () => {
  test('one statement that selects start, duration and status only, with every span up to the limit', async () => {
    const { source, statements } = recording();
    const got = await source.spanPoints(points, signal);
    // more than a page of the list holds
    expect(got).toHaveLength(N);
    expect(got.map((p) => p.start)).toEqual([...got.map((p) => p.start)].sort((a, b) => b - a));
    expect(got.filter((p) => p.error)).toHaveLength(N / 4);
    expect(got[0]?.durationNs).toBe(N * 1000);
    const own = statements.filter((s) => /FROM "?spans"?/.test(s) && /status_code/.test(s));
    expect(own).toHaveLength(1);
    expect(statements).toHaveLength(1);
    const projection = (own[0] ?? '').split(/\bFROM\b/)[0] ?? '';
    expect(projection).toMatch(/AS "?start_ns"?/);
    for (const wide of ['name', 'attributes', 'trace_id', 'span_id', 'resource', 'scope', 'events'])
      expect(projection, wide).not.toContain(wide);
  });

  test('the limit bounds the statement and a duration sort orders it', async () => {
    const { source } = recording();
    const got = await source.spanPoints(
      { ...points, sort: { column: 'duration', dir: 'desc' }, limit: 5 },
      signal,
    );
    expect(got.map((p) => p.durationNs)).toEqual([260, 259, 258, 257, 256].map((n) => n * 1000));
  });

  test('traces and a condition the browser evaluates plot every match up to the limit', async () => {
    const { source } = recording();
    const traces = await source.spanPoints({ ...points, mode: 'traces' }, signal);
    expect(traces).toHaveLength(N);
    expect(traces.filter((p) => p.error)).toHaveLength(N / 4);
    const res = await source.spanPoints({ ...points, condition: 'Len(name) > 5' }, signal);
    expect(res.length).toBeGreaterThan(0);
    expect(res.length).toBeLessThan(N);
  });
});
