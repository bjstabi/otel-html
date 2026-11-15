import { describe, expect, test } from 'vitest';
import type { Table } from '../../src/format/parquet/columns.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, metricsRequest } from '../../test-support/otlp-builders.js';
import {
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { spansRequest, tableRowsOf } from './helpers.js';

const SEC = 1_000_000_000n;
const base = BigInt(EPOCH_NS);
const at = (s: number): string => String(base + BigInt(s) * SEC);

const counter = (points: readonly (readonly [number, number])[]) =>
  metricsRequest([
    {
      name: 'jobs',
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: points.map(([s, v]) => ({
          startTimeUnixNano: String(base),
          timeUnixNano: at(s),
          asInt: String(v),
          exemplars: [{ timeUnixNano: at(s), asInt: String(v) }],
        })),
      },
    } as never,
  ]);

const histogram = (points: readonly (readonly [number, number])[]) =>
  metricsRequest([
    {
      name: 'lat',
      histogram: {
        aggregationTemporality: 2,
        dataPoints: points.map(([s, n]) => ({
          startTimeUnixNano: String(base),
          timeUnixNano: at(s),
          count: String(n),
          sum: n,
          bucketCounts: [String(n), '0'],
          explicitBounds: [10],
        })),
      },
    } as never,
  ]);

const logs = (s: number, body: string) =>
  logsRequest([logRecord({ timeUnixNano: at(s), observedTimeUnixNano: at(s), body: { stringValue: body } })]);

// The first request of the second session is a span 50 s in: its anchor is not the first session's (10 s).
const first = [
  counter([
    [10, 5],
    [20, 8],
  ]),
  histogram([
    [10, 3],
    [20, 5],
  ]),
  logs(12, 'user 1 logged in'),
  logs(14, 'disk full on /dev/sda'),
  spansRequest(2, 1_000_000_000, 0),
];
const second = [
  spansRequest(2, 50_000_000_000, 10),
  counter([
    [30, 12],
    [40, 20],
  ]),
  histogram([
    [30, 9],
    [40, 11],
  ]),
  logs(52, 'user 2 logged in'),
  logs(54, 'brand new shape of message here'),
];

async function write(w: TestWriter, out: string, sessions: readonly (readonly object[])[]): Promise<void> {
  for (const [i, requests] of sessions.entries()) {
    const s = await openSession(w.deps, {
      out,
      config: testConfig(),
      mode: i === 0 ? 'replace' : 'append',
    });
    for (const [j, r] of requests.entries()) await s.add(otlp(r as never), `s${i}-${j}.json`);
    await s.close();
  }
}

const json = (row: object): string =>
  JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

const rowsOf = (w: TestWriter, out: string, table: Table): string[] =>
  tableRowsOf(w, out, table).map(json).sort();

describe('a resumed session writes the same times as a fresh one', () => {
  test('spans, logs, points (with exemplars), traces and the pattern times match', async () => {
    const w = createTestWriter();
    await write(w, 'fresh', [[...first, ...second]]);
    await write(w, 'split', [first, second]);
    for (const table of ['spans', 'logs', 'points', 'traces'] as const) {
      const a = rowsOf(w, 'fresh', table);
      expect(a.length).toBeGreaterThan(0);
      expect(rowsOf(w, 'split', table), table).toEqual(a);
    }
    // Patterns are per partition, so the counts differ; the first and last time of each template must not.
    const span = (out: string) => {
      const times = new Map<string, bigint[]>();
      for (const r of tableRowsOf(w, out, 'patterns')) {
        const t = String(Reflect.get(r, 'template'));
        const ts = [
          Reflect.get(r, 'first_time_unix_nano'),
          Reflect.get(r, 'last_time_unix_nano'),
        ] as bigint[];
        times.set(t, [...(times.get(t) ?? []), ...ts]);
      }
      return [...times]
        .map(([t, v]) => {
          const sorted = [...v].sort((x, y) => (x < y ? -1 : 1));
          return `${t}:${sorted[0]}:${sorted.at(-1)}`;
        })
        .sort();
    };
    expect(span('fresh').length).toBeGreaterThan(0);
    expect(span('split')).toEqual(span('fresh'));
  });

  test('rollups cover the same time buckets', async () => {
    const w = createTestWriter();
    await write(w, 'fresh', [[...first, ...second]]);
    await write(w, 'split', [first, second]);
    const keys = (out: string, table: 'span_rollups' | 'log_rollups') => {
      const col = table === 'span_rollups' ? 'start_time_unix_nano' : 'time_unix_nano';
      return [...new Set(tableRowsOf(w, out, table).map((r) => String(Reflect.get(r, col))))].sort();
    };
    for (const table of ['span_rollups', 'log_rollups'] as const) {
      expect(keys('split', table), table).toEqual(keys('fresh', table));
    }
  });
});

describe('a rejected first request leaves the session unanchored', () => {
  const FAR = 2n ** 54n;
  const badLogs = (anchored: bigint) =>
    logsRequest([
      logRecord({
        timeUnixNano: String(anchored),
        observedTimeUnixNano: String(anchored),
        severityNumber: 25,
        body: { stringValue: 'bad severity' },
      }),
    ]);

  test.each(['add', 'addRecords'] as const)(
    '%s: later data near the old anchor is still accepted',
    async (via) => {
      const w = createTestWriter();
      await write(w, 'plain', [first, second]);
      await write(w, 'failed', [first]);
      const s = await openSession(w.deps, { out: 'failed', config: testConfig(), mode: 'append' });
      if (via === 'add') {
        await expect(s.add(otlp(badLogs(base + FAR) as never), 'bad.json')).rejects.toThrow();
      } else {
        await expect(
          s.addRecords({
            signal: 'logs',
            rows: [
              {
                time: 0,
                observedTime: 0,
                severityNumber: 25,
                severityText: '',
                body: { kind: 'string', value: 'bad severity' },
                attributes: [],
                traceId: null,
                spanId: null,
                flags: 0,
                resource: 0,
                scope: 0,
              },
            ] as never,
            resources: [{ attributes: [], droppedAttributesCount: 0 }] as never,
            scopes: [{ name: '', version: '', attributes: [], droppedAttributesCount: 0 }] as never,
            epoch: (base + FAR) as never,
          }),
        ).rejects.toThrow();
      }
      for (const [j, r] of second.entries()) await s.add(otlp(r as never), `s1-${j}.json`);
      await s.close();
      for (const table of ['spans', 'logs', 'points', 'traces'] as const) {
        expect(rowsOf(w, 'failed', table), table).toEqual(rowsOf(w, 'plain', table));
      }
    },
  );
});
