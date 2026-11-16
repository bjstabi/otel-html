import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { RowCursor } from '../../src/query/sql/cursor.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { SpanQuery, TraceRow } from '../../src/viewer/data/results.js';
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
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');

let f: Format4Fixture;
let db: TestDb;
const sources: DataSource[] = [];

/** One partition: spans as [trace, start in ns after the epoch]. */
function partition(spans: [number, number][]) {
  const mine = spans.map(([trace, start], i) =>
    span({
      traceId: hex(trace, 32),
      spanId: hex(trace * 100 + start + i, 16),
      name: `t${trace}`,
      startTimeUnixNano: String(BASE + BigInt(start)),
      endTimeUnixNano: String(BASE + BigInt(start) + 1n),
    }),
  );
  return otlp(traceRequest(mine, [attr('service.name', { stringValue: 'svc' })]) as never);
}

beforeAll(async () => {
  // trace 1 (A) has spans at 10 and 100 in files that do not overlap in time; B and C start between them
  f = await buildFormat4Report(
    [
      partition([[1, 10]]),
      partition([
        [2, 50],
        [3, 40],
      ]),
      partition([[1, 100]]),
    ],
    {
      close: false,
    },
  );
  db = await openFixtureDb(f);
});
afterAll(async () => {
  await Promise.all(sources.map((s) => s.close()));
});

const query = (over: Partial<SpanQuery>): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'traces',
  sort: { column: 'start', dir: 'desc' },
  limit: 2,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});

async function pageToEnd(dir: 'asc' | 'desc', limit: number): Promise<TraceRow[]> {
  const source = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest: f.manifest,
  });
  sources.push(source);
  const sort = { column: 'start', dir } as const;
  const got: TraceRow[] = [];
  let cursor: RowCursor | null = null;
  for (;;) {
    const r = await source.querySpans(query({ sort, limit, cursor }));
    got.push(...(r.rows as TraceRow[]));
    if (r.next == null) break;
    cursor = r.next;
  }
  return got;
}

describe('trace lists decide membership over every traces file', () => {
  for (const dir of ['asc', 'desc'] as const) {
    test(`a trace with spans in two files that do not overlap in time, ${dir}`, async () => {
      const all = await pageToEnd(dir, 10);
      expect(all).toHaveLength(3);
      const paged = await pageToEnd(dir, 2);
      expect(paged.map((t) => [t.traceId, t.start])).toEqual(all.map((t) => [t.traceId, t.start]));
    });
  }
});
