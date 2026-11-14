import { tableFromArrays } from '@uwdata/flechette';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { serviceShareOf } from '../../src/format/service-share.js';
import { parseTraceId } from '../../src/model/ids.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { createCoordinator, mosaicQueryEngine } from '../../src/viewer/data/mosaic.js';
import type { SpanQuery, TraceRow } from '../../src/viewer/data/results.js';
import { traceRows } from '../../src/viewer/data/span-results.js';
import { alignLongWindow } from '../../src/viewer/data/time-window.js';
import type { TestDb } from '../../test-support/duckdb-node.js';
import { buildFormat4Report, openFixtureDb } from '../../test-support/format4-fixture.js';
import { format6Fixture } from '../../test-support/format6.js';
import { attr, span, traceRequest } from '../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../test-support/writer-deps.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const BASE = BigInt(EPOCH_NS);
const ms = (n: number): bigint => BigInt(n) * 1_000_000n;

interface S {
  trace: number;
  id: number;
  parent?: number;
  svc: string;
  startMs: number;
  durMs: number;
}

function request(spans: S[]) {
  const resourceSpans: unknown[] = [];
  for (const svc of [...new Set(spans.map((s) => s.svc))]) {
    const mine = spans
      .filter((s) => s.svc === svc)
      .map((s) =>
        span({
          traceId: hex(s.trace, 32),
          spanId: hex(s.id, 16),
          ...(s.parent === undefined ? {} : { parentSpanId: hex(s.parent, 16) }),
          name: `op ${s.id}`,
          startTimeUnixNano: String(BASE + ms(s.startMs)),
          endTimeUnixNano: String(BASE + ms(s.startMs + s.durMs)),
        }),
      );
    const r = traceRequest(mine, [attr('service.name', { stringValue: svc })]) as {
      resourceSpans: unknown[];
    };
    resourceSpans.push(...r.resourceSpans);
  }
  return otlp({ resourceSpans } as never);
}

// Partitions 0 and 1 store the share, 2 does not. Trace 1 is only in 0, trace 3 only in 1, trace 4 only in 2;
// trace 2 is spread over 0 and 2.
const P0: S[] = [
  { trace: 1, id: 1, svc: 'svc-a', startMs: 0, durMs: 100 },
  { trace: 1, id: 2, parent: 1, svc: 'svc-b', startMs: 10, durMs: 40 },
  { trace: 2, id: 3, svc: 'svc-a', startMs: 200, durMs: 50 },
];
const P1: S[] = [
  { trace: 3, id: 4, svc: 'svc-a', startMs: 300, durMs: 20 },
  { trace: 3, id: 5, parent: 4, svc: 'svc-b', startMs: 305, durMs: 5 },
];
const P2: S[] = [
  { trace: 2, id: 6, parent: 3, svc: 'svc-b', startMs: 210, durMs: 20 },
  { trace: 4, id: 7, svc: 'svc-a', startMs: 400, durMs: 10 },
];

let db: TestDb;
let close: () => Promise<void>;
let rows: Map<string, TraceRow>;

const query = (over: Partial<SpanQuery> = {}): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'traces',
  sort: { column: 'start', dir: 'asc' },
  limit: 100,
  groupBy: null,
  measureBy: null,
  needs: ['rows'],
  facetKeys: null,
  ...over,
});

const byId = (rs: readonly unknown[]): Map<string, TraceRow> =>
  new Map((rs as TraceRow[]).map((r) => [r.traceId as string, r]));

beforeAll(async () => {
  const f = await buildFormat4Report([request(P0), request(P1), request(P2)], { close: false });
  const six = await format6Fixture(f, [0, 1]);
  close = six.close;
  db = await openFixtureDb(six);
  const ds = createDuckDbDataSource({
    engine: mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db),
    manifest: six.manifest,
  });
  rows = byId((await ds.querySpans(query())).rows);
});
afterAll(async () => {
  await close();
});

const t = (n: number) => parseTraceId(hex(n, 32), 'test') as string;

describe('the trace list stored share', () => {
  test('a trace in one format-6 partition carries the share of its spans', () => {
    // trace 1: svc-a 100ms - 40ms of child = 60ms, svc-b 40ms
    const expected = serviceShareOf([
      {
        spanId: 'a',
        parentId: null,
        service: 'svc-a',
        start: 0,
        end: 100e6,
        durationNs: 100e6,
        provisional: false,
      },
      {
        spanId: 'b',
        parentId: 'a',
        service: 'svc-b',
        start: 10e6,
        end: 50e6,
        durationNs: 40e6,
        provisional: false,
      },
    ]);
    expect(rows.get(t(1))?.share).toEqual(expected);
    expect(rows.get(t(3))?.share).toEqual([
      { service: 'svc-a', ns: 15_000_000n },
      { service: 'svc-b', ns: 5_000_000n },
    ]);
  });

  test('a trace spread over a format-6 and a format-5 partition, and a format-5 trace, get null', () => {
    expect(rows.get(t(2))?.share).toBeNull();
    expect(rows.get(t(4))?.share).toBeNull();
  });

  test('a stored share that does not parse is not exact', () => {
    const table = tableFromArrays({
      trace_id: ['aa', 'bb'],
      root_name: ['r', 'r'],
      root_service: ['s', 's'],
      root_resource: ['r', 'r'],
      start_ns: [0n, 0n],
      duration_ns: [1n, 1n],
      span_count: [1n, 1n],
      error_count: [0n, 0n],
      share: ['not json', '[["s","5"]]'],
      total: [2n, 2n],
    });
    const out = traceRows(table).rows;
    expect(out[0]?.share).toBeNull();
    expect(out[1]?.share).toEqual([{ service: 's', ns: 5n }]);
  });
});

describe('a trace with a partition outside the window is never exact, on every list path', () => {
  const LONG = 16_777_216_000_000;
  const asked = { start: 60_000e6, end: 60_000e6 + LONG };
  const edge = alignLongWindow(asked, BASE);
  const rel = (n: number): number => n / 1e6;
  const inside = (extraMs: number): number => rel(edge.start) + extraMs;
  // every partition stores its share; trace 3 starts in partition 1 (inside) and ends in partition 2 (after the window)
  const PART0: S[] = [
    { trace: 1, id: 1, svc: 'svc-a', startMs: 0, durMs: 10 },
    { trace: 2, id: 2, svc: 'svc-a', startMs: inside(1000), durMs: 10 },
  ];
  const PART1: S[] = [{ trace: 3, id: 4, svc: 'svc-a', startMs: inside(3000), durMs: 10 }];
  const PART2: S[] = [
    { trace: 3, id: 6, parent: 4, svc: 'svc-b', startMs: rel(edge.end) + 2000, durMs: 10 },
    { trace: 4, id: 5, svc: 'svc-a', startMs: rel(edge.end) + 1000, durMs: 10 },
  ];
  let wdb: TestDb;
  let wclose: () => Promise<void>;
  let wds: ReturnType<typeof createDuckDbDataSource>;

  beforeAll(async () => {
    const f = await buildFormat4Report([request(PART0), request(PART1), request(PART2)], { close: false });
    const six = await format6Fixture(f);
    wclose = six.close;
    wdb = await openFixtureDb(six);
    wds = createDuckDbDataSource({
      engine: mosaicQueryEngine(createCoordinator(wdb.connector, silentLogger), wdb),
      manifest: six.manifest,
    });
  });
  afterAll(async () => {
    await wclose();
  });

  const list = async (over: Partial<SpanQuery>): Promise<Map<string, TraceRow>> =>
    byId((await wds.querySpans(query({ window: asked, ...over }))).rows);

  test('the windowed unconditioned list: the whole trace is counted, so the split trace is null', async () => {
    const got = await list({});
    expect([...got.keys()].sort()).toEqual([t(2), t(3)]);
    expect(got.get(t(2))?.share).not.toBeNull();
    expect(got.get(t(3))?.share).toBeNull();
  });

  test('the windowed conditioned list (windowTraceRowsQuery)', async () => {
    const got = await list({ condition: 'name != "no-such"' });
    expect([...got.keys()].sort()).toEqual([t(2), t(3)]);
    expect(got.get(t(2))?.share).not.toBeNull();
    expect(got.get(t(3))?.share).toBeNull();
  });

  test('the conditioned list with no window (traceRowsQuery), spans pruned by the condition to one partition', async () => {
    const got = await list({ window: null, condition: 'name == "op 4"' });
    expect([...got.keys()]).toEqual([t(3)]);
    expect(got.get(t(3))?.share).toBeNull();
    const one = await list({ window: null, condition: 'name == "op 2"' });
    expect(one.get(t(2))?.share).not.toBeNull();
  });
});
