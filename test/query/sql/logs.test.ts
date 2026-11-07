import { beforeAll, describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../../src/model/errors.js';
import { parseTraceId } from '../../../src/model/ids.js';
import { buildFilter } from '../../../src/query/sql/filter.js';
import {
  logByRefQuery,
  logRowsQuery,
  logTimelineQuery,
  logTracesQuery,
  patternsQuery,
  pointsTimelineQuery,
  surroundingQueries,
  traceLogsQuery,
} from '../../../src/query/sql/logs.js';
import { absWindow } from '../../../src/query/sql/prune.js';
import type { BucketSpec } from '../../../src/query/sql/time.js';
import { partitionOfFilename } from '../../../src/query/sql/views.js';
import type { LogRow } from '../../../src/viewer/data/log-query.js';
import type { TestDb } from '../../../test-support/duckdb-node.js';
import {
  buildFormat4Report,
  type Format4Fixture,
  openFixtureDb,
} from '../../../test-support/format4-fixture.js';
import {
  attr,
  gauge,
  type JsonObject,
  logsRequest,
  metricsRequest,
} from '../../../test-support/otlp-builders.js';
import { EPOCH_NS, otlp } from '../../../test-support/writer-deps.js';

type Key =
  | 'total'
  | 'time_rel'
  | 'filename'
  | 'file_row_number'
  | 'attributes'
  | 'bucket'
  | 'band'
  | 'n'
  | 'trace_id'
  | 'log_count'
  | 'first_ns'
  | 'last_ns'
  | 'max_severity'
  | 'services'
  | 'service_name'
  | 'host_name'
  | 'template'
  | 'count'
  | 'sample'
  | 'sev_trace'
  | 'sev_debug'
  | 'sev_info'
  | 'sev_warn'
  | 'sev_error'
  | 'sev_fatal';
type Row = Partial<Record<Key, unknown>> & Record<string, unknown>;

const BASE = BigInt(EPOCH_NS);
const OFFSET = 123_456n;
const ns = (ms: number): bigint => BigInt(Math.round(ms * 1e6));
const str = (v: string): JsonObject => ({ stringValue: v });
const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
const abs = (ms: number): string => String(BASE + OFFSET + ns(ms));

interface L {
  id: string;
  svc: string;
  host: string | null;
  /** Milliseconds from the first log; null for a record with neither time. */
  ms: number | null;
  /** Set for a record that has only an observed time. */
  observed?: true;
  sev: number;
  trace?: number;
  body: JsonObject;
}

const user = (n: number): JsonObject => str(`user ${n} logged in`);
const failed = (n: number): JsonObject => str(`failed to connect to db ${n}`);

// Partition 0 and partition 1 (the writer sorts a file by service, then time). Bodies: strings, an int and maps.
const P0: L[] = [
  { id: 'a1', svc: 'svc-a', host: 'host-1', ms: 0, sev: 9, body: user(1) },
  { id: 'a2', svc: 'svc-a', host: 'host-1', ms: 10, sev: 17, trace: 1, body: failed(10) },
  { id: 'b1', svc: 'svc-b', host: 'host-1', ms: 10, sev: 5, body: user(3) },
  { id: 'b2', svc: 'svc-b', host: 'host-1', ms: 20, sev: 13, trace: 1, body: failed(11) },
  { id: 'c1', svc: 'svc-c', host: 'host-2', ms: 30, sev: 21, body: { intValue: '42' } },
];
const P1: L[] = [
  { id: 'a3', svc: 'svc-a', host: 'host-1', ms: 40, sev: 1, body: user(2) },
  { id: 'a4', svc: 'svc-a', host: 'host-1', ms: 70, sev: 17, trace: 2, body: failed(12) },
  { id: 'b3', svc: 'svc-b', host: 'host-1', ms: 50, sev: 9, trace: 1, body: user(4) },
  { id: 'b4', svc: 'svc-b', host: 'host-2', ms: 55, observed: true, sev: 9, body: failed(13) },
  {
    id: 'b5',
    svc: 'svc-b',
    host: null,
    ms: null,
    sev: 9,
    body: { kvlistValue: { values: [attr('k', str('v'))] } },
  },
  {
    id: 'c2',
    svc: 'svc-c',
    host: 'host-2',
    ms: 60,
    sev: 24,
    body: { kvlistValue: { values: [attr('k', str('w'))] } },
  },
];

function logsOf(rows: L[]): ReturnType<typeof otlp> {
  const resourceLogs: unknown[] = [];
  for (const l of rows) {
    const record: JsonObject = {
      severityNumber: l.sev,
      body: l.body,
      attributes: [attr('id', str(l.id))],
      ...(l.ms === null
        ? {}
        : l.observed === true
          ? { observedTimeUnixNano: abs(l.ms) }
          : { timeUnixNano: abs(l.ms) }),
      ...(l.trace === undefined ? {} : { traceId: hex(l.trace, 32), spanId: hex(l.trace, 16) }),
    };
    const r = logsRequest(
      [record],
      [attr('service.name', str(l.svc)), ...(l.host === null ? [] : [attr('host.name', str(l.host))])],
    ) as { resourceLogs: unknown[] };
    resourceLogs.push(...r.resourceLogs);
  }
  return otlp({ resourceLogs } as never);
}

function pointsOf(msList: number[]): ReturnType<typeof otlp> {
  return otlp(
    metricsRequest(
      [
        gauge(
          'm',
          msList.map((ms) => ({ timeUnixNano: abs(ms), asDouble: ms })),
        ),
      ],
      [attr('service.name', str('svc-a'))],
    ) as never,
  );
}

const T1 = parseTraceId(hex(1, 32), 'test');
let f: Format4Fixture;
let db: TestDb;

beforeAll(async () => {
  f = await buildFormat4Report([logsOf(P0), logsOf(P1), pointsOf([5, 15, 25]), pointsOf([55, 105])], {
    close: false,
  });
  db = await openFixtureDb(f);
});

const relBig = (ms: number): bigint => BASE + OFFSET + ns(ms) - f.epoch;
const rel = (ms: number): number => Number(relBig(ms));
const run = (q: { toString(): string }): Row[] => db.rows(q.toString());
const num = (v: unknown): number => Number(v);
const labelOf = (r: Row): string => (JSON.parse(String(r.attributes)) as { id: string }).id;
const labels = (rows: Row[]): string[] => rows.map(labelOf);
const logFile = (n: number): string => {
  const p = f.manifest.partitions.find((x) => x.n === n)?.files.logs?.path;
  if (p === undefined) throw new Error(`no logs file in partition ${n}`);
  return p;
};

function filter(
  over: { condition?: string | null; text?: string; window?: { start: number; end: number } | null } = {},
) {
  return buildFilter({
    manifest: f.manifest,
    table: 'logs',
    condition: over.condition ?? null,
    text: over.text ?? '',
    window: over.window ?? null,
  });
}

/** The row with this id as the surrounding queries want a target. */
function target(id: string): Pick<LogRow, 'n' | 'i' | 'time' | 'service' | 'host'> {
  const r = run(logRowsQuery(filter().filter, { column: 'time', dir: 'asc' }, 100)).find(
    (x) => labelOf(x) === id,
  );
  if (r === undefined) throw new Error(`no log ${id}`);
  return {
    n: partitionOfFilename(String(r.filename)),
    i: num(r.file_row_number),
    time: num(r.time_rel) as LogRow['time'],
    service: String(r.service_name),
    host: r.host_name === null ? null : String(r.host_name),
  };
}

describe('logRowsQuery', () => {
  test('time order, ties by file then row; a log with no time sorts at the epoch; times are relative', () => {
    const rows = run(logRowsQuery(filter().filter, { column: 'time', dir: 'asc' }, 100));
    // a1 (0 ms, partition 0) before b5 (no time, partition 1); a2 and b1 tie at 10 ms in file order.
    expect(labels(rows)).toEqual(['a1', 'b5', 'a2', 'b1', 'b2', 'c1', 'a3', 'b3', 'b4', 'c2', 'a4']);
    expect(num(rows[0]?.time_rel)).toBe(rel(0));
    expect(num(rows[1]?.time_rel)).toBe(0);
    expect(num(rows[8]?.time_rel)).toBe(rel(55));
    expect(Object.keys(rows[0] ?? {})).not.toContain('time_unix_nano');
    expect(Object.keys(rows[0] ?? {})).toEqual(
      expect.arrayContaining(['filename', 'file_row_number', 'body', 'total']),
    );
  });

  test('severity descending breaks ties by time, and total counts the whole filtered set', () => {
    const rows = run(logRowsQuery(filter().filter, { column: 'severity', dir: 'desc' }, 4));
    expect(labels(rows)).toEqual(['c2', 'c1', 'a2', 'a4']);
    expect(rows.map((r) => num(r.total))).toEqual([11, 11, 11, 11]);
  });

  test('service sort, and the limit', () => {
    const rows = run(logRowsQuery(filter().filter, { column: 'service', dir: 'asc' }, 3));
    expect(labels(rows)).toEqual(['a1', 'a2', 'a3']);
  });

  test('a window uses the effective time (observed time counts) and drops a log with neither', () => {
    const w = filter({ window: { start: rel(35), end: rel(65) } });
    expect(w.filter.files.files).toEqual([logFile(1)]);
    const rows = run(logRowsQuery(w.filter, { column: 'time', dir: 'asc' }, 100));
    expect(labels(rows)).toEqual(['a3', 'b3', 'b4', 'c2']);
    expect(num(rows[0]?.total)).toBe(4);
  });

  test('a condition narrows rows and total alike', () => {
    const c = filter({ condition: 'severity_number >= 17' });
    const rows = run(logRowsQuery(c.filter, { column: 'time', dir: 'asc' }, 2));
    expect(labels(rows)).toEqual(['a2', 'c1']);
    expect(num(rows[0]?.total)).toBe(4);
  });

  test('the total is a scalar subquery, not a window over every row', () => {
    const sql = logRowsQuery(filter().filter, { column: 'time', dir: 'asc' }, 10).toString();
    expect(sql).not.toMatch(/OVER\s*\(/);
  });
});

describe('logTimelineQuery', () => {
  const spec: BucketSpec = { widthNs: 50_000_000, startNs: 0, endNs: 50_000_000 };
  test('severity band counts per bucket of the effective time', () => {
    const rows = run(logTimelineQuery(filter().filter, spec));
    const got = new Map(rows.map((r) => [`${num(r.bucket)}:${String(r.band)}`, num(r.n)]));
    const expected = new Map<string, number>();
    const bandOf = (s: number): string =>
      s === 0
        ? 'unspecified'
        : s <= 4
          ? 'trace'
          : s <= 8
            ? 'debug'
            : s <= 12
              ? 'info'
              : s <= 16
                ? 'warn'
                : s <= 20
                  ? 'error'
                  : 'fatal';
    for (const l of [...P0, ...P1]) {
      const r = l.ms === null ? 0 : rel(l.ms);
      const bucket = Math.max(Math.floor(r / 50_000_000) * 50_000_000, 0);
      const k = `${bucket}:${bandOf(l.sev)}`;
      expected.set(k, (expected.get(k) ?? 0) + 1);
    }
    expect(got).toEqual(expected);
    expect([...got.values()].reduce((a, b) => a + b, 0)).toBe(11);
    expect(new Set(rows.map((r) => String(r.band)))).toEqual(
      new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    );
  });

  test('a window limits the counted logs', () => {
    const w = filter({ window: { start: rel(35), end: rel(65) } });
    const rows = run(logTimelineQuery(w.filter, spec));
    expect(rows.reduce((a, r) => a + num(r.n), 0)).toBe(4);
  });
});

describe('logTracesQuery', () => {
  test('one row per trace: count, first and last effective time, worst severity, sorted services', () => {
    const rows = run(logTracesQuery(filter().filter, { column: 'first', dir: 'asc' }, 10));
    expect(rows.map((r) => r.trace_id)).toEqual([hex(1, 32), hex(2, 32)]);
    const t1 = rows[0] as Row;
    expect(num(t1.log_count)).toBe(3);
    expect(num(t1.first_ns)).toBe(rel(10));
    expect(num(t1.last_ns)).toBe(rel(50));
    expect(num(t1.max_severity)).toBe(17);
    expect(Array.from(t1.services as Iterable<string>)).toEqual(['svc-a', 'svc-b']);
    expect(num(t1.total)).toBe(2);
  });

  test('sorts by logs and by severity (ties by trace id)', () => {
    const byLogs = run(logTracesQuery(filter().filter, { column: 'logs', dir: 'desc' }, 10));
    expect(byLogs.map((r) => r.trace_id)).toEqual([hex(1, 32), hex(2, 32)]);
    const bySev = run(logTracesQuery(filter().filter, { column: 'severity', dir: 'desc' }, 1));
    expect(bySev.map((r) => r.trace_id)).toEqual([hex(1, 32)]);
    expect(num(bySev[0]?.total)).toBe(2);
  });
});

describe('logByRefQuery', () => {
  test('finds the row of partition n and row i', () => {
    const t = target('b3');
    const rows = run(logByRefQuery(`${t.n}.${t.i}` as never, f.manifest));
    expect(labels(rows)).toEqual(['b3']);
  });
  test('a partition without logs is an invalid-report error', () => {
    expect(() => logByRefQuery('99.0' as never, f.manifest)).toThrow(OtelHtmlError);
  });
});

describe('surroundingQueries', () => {
  test('same service and host, crossing the partition boundary, nearest first', () => {
    const { before, after } = surroundingQueries(target('b3') as LogRow, f.manifest, 5, f.epoch);
    expect(labels(run(before))).toEqual(['b2', 'b1']);
    expect(labels(run(after))).toEqual([]);
    const mid = surroundingQueries(target('b2') as LogRow, f.manifest, 5, f.epoch);
    expect(labels(run(mid.after))).toEqual(['b3']);
    expect(labels(run(mid.before))).toEqual(['b1']);
  });
  test('the limit, and a missing host matches only a missing host', () => {
    const a = surroundingQueries(target('a4') as LogRow, f.manifest, 2, f.epoch);
    expect(labels(run(a.before))).toEqual(['a3', 'a2']);
    const n = surroundingQueries(target('b5') as LogRow, f.manifest, 5, f.epoch);
    expect(labels(run(n.before))).toEqual([]);
    expect(labels(run(n.after))).toEqual([]);
  });
});

describe('traceLogsQuery', () => {
  test('every logs file for null, in time order', () => {
    expect(labels(run(traceLogsQuery(T1, null, f.epoch)))).toEqual(['a2', 'b2', 'b3']);
  });
  test('only the named files; no files is no rows', () => {
    expect(labels(run(traceLogsQuery(T1, [logFile(0)], f.epoch)))).toEqual(['a2', 'b2']);
    expect(run(traceLogsQuery(T1, [], f.epoch))).toEqual([]);
  });
});

describe('patternsQuery', () => {
  const opts = {
    window: null,
    sort: { column: 'count' as const, dir: 'desc' as const },
    limit: 10,
    epoch: 0n,
  };
  test('combined across partitions by template, with severity sums', () => {
    const rows = run(patternsQuery({ ...opts, epoch: f.epoch }));
    const byTemplate = new Map(rows.map((r) => [String(r.template), r]));
    const users = [...byTemplate].find(([t]) => t.startsWith('user'))?.[1] as Row;
    const fails = [...byTemplate].find(([t]) => t.startsWith('failed'))?.[1] as Row;
    expect(num(users.count)).toBe(4);
    expect([num(users.sev_info), num(users.sev_debug), num(users.sev_trace), num(users.sev_error)]).toEqual([
      2, 1, 1, 0,
    ]);
    expect(num(users.first_ns)).toBe(rel(0));
    expect(num(users.last_ns)).toBe(rel(50));
    expect(String(users.sample)).toBe('user 1 logged in');
    expect(num(fails.count)).toBe(4);
    expect([num(fails.sev_error), num(fails.sev_warn), num(fails.sev_info)]).toEqual([2, 1, 1]);
    expect(num(fails.total)).toBe(rows.length);
  });
  test('window by overlap, sort, limit', () => {
    const only = run(
      patternsQuery({
        ...opts,
        epoch: f.epoch,
        window: absWindow({ start: rel(65), end: rel(80) }, f.epoch),
      }),
    );
    expect(only.map((r) => String(r.template)).every((t) => t.startsWith('failed'))).toBe(true);
    const first = run(
      patternsQuery({ ...opts, epoch: f.epoch, sort: { column: 'first', dir: 'desc' }, limit: 1 }),
    );
    expect(first).toHaveLength(1);
    expect(String(first[0]?.template)).toBe('{"k":"w"}');
  });
});

describe('pointsTimelineQuery', () => {
  test('counts points per bucket of time_unix_nano', () => {
    const spec: BucketSpec = { widthNs: 50_000_000, startNs: 0, endNs: 100_000_000 };
    const rows = run(pointsTimelineQuery(spec, f.epoch));
    const got = rows.map((r) => [num(r.bucket), num(r.n)]);
    const b = (ms: number): number => Math.floor(rel(ms) / 50_000_000) * 50_000_000;
    const expected = new Map<number, number>();
    for (const ms of [5, 15, 25, 55, 105]) expected.set(b(ms), (expected.get(b(ms)) ?? 0) + 1);
    expect(got).toEqual([...expected].sort((x, y) => x[0] - y[0]));
  });
});
