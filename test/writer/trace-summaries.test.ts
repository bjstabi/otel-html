import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Table } from '../../src/format/parquet/columns.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { decodeServiceShare, encodeServiceShare, serviceShareOf } from '../../src/format/service-share.js';
import { shareSpanOf } from '../../src/viewer/data/trace-tree.js';
import { PartitionWriter } from '../../src/writer/partition-writer.js';
import { traceRows as traceRowsOf } from '../../src/writer/trace-summaries.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { viewerRow } from '../../test-support/viewer-row.js';

const traceRows = (spans: readonly Row[], logs: readonly Row[]): Row[] =>
  traceRowsOf(batchFromRows('spans', spans), batchFromRows('logs', logs));

function span(trace: string, id: string, start: bigint, end: bigint, extra: Row = {}): Row {
  return {
    trace_id: trace,
    span_id: id,
    parent_span_id: 'p',
    name: `n${id}`,
    start_time_unix_nano: start,
    end_time_unix_nano: end,
    status_code: 0,
    service_name: 'svc',
    resource_name: `r${id}`,
    ...extra,
  };
}

describe('traceRows', () => {
  test('two spans of one trace make one row', () => {
    const rows = traceRows([span('t', 'a', 10n, 20n), span('t', 'b', 5n, 15n)], []);
    expect(rows).toEqual([
      {
        trace_id: 't',
        start_time_unix_nano: 5n,
        end_time_unix_nano: 20n,
        span_count: 2,
        error_count: 0,
        root_service: null,
        root_name: null,
        root_resource: null,
        log_count: 0,
        service_share: expect.any(String),
      },
    ]);
  });

  test('the root span promotes its service, name and resource', () => {
    const [row] = traceRows(
      [span('t', 'a', 10n, 20n), span('t', 'r', 5n, 25n, { parent_span_id: null })],
      [],
    );
    expect(row).toMatchObject({ root_service: 'svc', root_name: 'nr', root_resource: 'rr' });
  });

  test('with two roots the earliest start wins, whatever the row order', () => {
    const a = span('t', 'a', 30n, 40n, { parent_span_id: null });
    const b = span('t', 'b', 10n, 20n, { parent_span_id: null });
    expect(Reflect.get(traceRows([a, b], [])[0] ?? {}, 'root_name')).toBe('nb');
    expect(Reflect.get(traceRows([b, a], [])[0] ?? {}, 'root_name')).toBe('nb');
  });

  test('error_count counts status ERROR (2)', () => {
    const rows = traceRows(
      [
        span('t', 'a', 1n, 2n, { status_code: 2 }),
        span('t', 'b', 1n, 2n, { status_code: 1 }),
        span('t', 'c', 1n, 2n, { status_code: 2 }),
      ],
      [],
    );
    expect(Reflect.get(rows[0] ?? {}, 'error_count')).toBe(2);
  });

  test('a trace with only logs has span_count 0, its log count and the log time range', () => {
    const logs: Row[] = [
      { trace_id: 't', time_unix_nano: 50n },
      { trace_id: 't', time_unix_nano: null, observed_time_unix_nano: 40n },
      { trace_id: null, time_unix_nano: 1n },
    ];
    expect(traceRows([], logs)).toEqual([
      expect.objectContaining({
        trace_id: 't',
        span_count: 0,
        log_count: 2,
        start_time_unix_nano: 40n,
        end_time_unix_nano: 50n,
      }),
    ]);
  });

  test('logs add to a span trace without moving its range', () => {
    const [row] = traceRows([span('t', 'a', 10n, 20n)], [{ trace_id: 't', time_unix_nano: 99n }]);
    expect(row).toMatchObject({
      span_count: 1,
      log_count: 1,
      start_time_unix_nano: 10n,
      end_time_unix_nano: 20n,
    });
  });

  test('equal-start roots break on span_id, whatever the row order', () => {
    const a = span('t', 'b', 10n, 20n, { parent_span_id: null });
    const b = span('t', 'a', 10n, 20n, { parent_span_id: null });
    expect(Reflect.get(traceRows([a, b], [])[0] ?? {}, 'root_name')).toBe('na');
    expect(Reflect.get(traceRows([b, a], [])[0] ?? {}, 'root_name')).toBe('na');
  });

  test('a logs-only trace whose logs carry no time has null start and end', () => {
    const [row] = traceRows([], [{ trace_id: 't', time_unix_nano: null, observed_time_unix_nano: null }]);
    expect(row).toMatchObject({ start_time_unix_nano: null, end_time_unix_nano: null, log_count: 1 });
  });
});

describe('traceRows service share', () => {
  const shareOf = (rows: Row[]) => decodeServiceShare(String(Reflect.get(rows[0] ?? {}, 'service_share')));

  test('is exclusive time per service, with a provisional copy giving way to the final one', () => {
    const attrs = (provisional: boolean) => JSON.stringify({ 'otel_html.ci.provisional': provisional });
    const rows = traceRows(
      [
        span('t', 'r', 0n, 100n, { parent_span_id: null, service_name: 'a', duration_ns: 100n }),
        span('t', 'c', 10n, 40n, { parent_span_id: 'r', service_name: 'b', duration_ns: 30n }),
        span('t', 'c', 10n, 90n, {
          parent_span_id: 'r',
          service_name: 'b',
          duration_ns: 80n,
          attributes: attrs(true),
        }),
      ],
      [],
    );
    expect(shareOf(rows)).toEqual([
      { service: 'a', ns: 70n },
      { service: 'b', ns: 30n },
    ]);
  });

  test('a trace with only logs has an empty share', () => {
    const rows = traceRows([], [{ trace_id: 't', time_unix_nano: 1n }]);
    expect(shareOf(rows)).toEqual([]);
  });
});

describe('a flushed partition stores the share the viewer computes', () => {
  const PROV = JSON.stringify({ 'otel_html.ci.provisional': true });
  const written = async (spans: Row[]) => {
    const fs = createMemoryFileSystem();
    const w = new PartitionWriter(fs, {
      out: '/o',
      rowGroupRows: 100,
      statisticsKeys: {
        spans: [],
        logs: [],
        points: [],
        traces: [],
        patterns: [],
        span_rollups: [],
        log_rollups: [],
      },
      facetValueCap: 10,
      nextPartition: 0,
    });
    for (const r of spans) w.add('spans', r);
    for (const r of traceRowsOf(batchFromRows('spans', spans), batchFromRows('logs', []))) w.add('traces', r);
    const e = await w.cut('flush:0');
    const read = async (t: Table) => decodeTable(t, await fs.readBytes(`/o/${e?.files[t]?.path}`));
    return { spans: await read('spans'), traces: await read('traces') };
  };
  const full = (
    id: string,
    parent: string | null,
    start: bigint,
    end: bigint,
    svc: string,
    attributes = '{}',
  ): Row => ({
    ...span('t', id, start, end, { parent_span_id: parent, service_name: svc, attributes }),
    duration_ns: end - start,
  });

  test('a span id twice, a provisional and a final copy with different ends', async () => {
    const { spans, traces } = await written([
      full('r', null, 1_000n, 1_100n, 'a'),
      full('c', 'r', 1_010n, 1_040n, 'b', PROV),
      full('c', 'r', 1_010n, 1_090n, 'b'),
      full('d', 'r', 1_020n, 1_030n, 'c'),
      full('d', 'r', 1_020n, 1_050n, 'c'),
    ]);
    const origin = spans.reduce(
      (m, r) =>
        (Reflect.get(r, 'start_time_unix_nano') as bigint) < m
          ? (Reflect.get(r, 'start_time_unix_nano') as bigint)
          : m,
      1n << 62n,
    );
    const fallback = serviceShareOf(spans.map((r) => shareSpanOf(viewerRow(r, origin))));
    expect(fallback.length).toBe(3);
    expect(traces).toHaveLength(1);
    expect(Reflect.get(traces[0] ?? {}, 'service_share')).toBe(encodeServiceShare(fallback));
  });

  test('a span without a start or end adds nothing and does not throw', () => {
    const none: Row = { ...span('t', 'x', 0n, 0n), start_time_unix_nano: null, end_time_unix_nano: null };
    const half: Row = { ...span('t', 'y', 5n, 0n), end_time_unix_nano: null };
    const ok = [span('t', 'a', 10n, 30n, { parent_span_id: null, duration_ns: 20n })];
    const withNulls = traceRowsOf(batchFromRows('spans', [none, half, ...ok]), batchFromRows('logs', []));
    const without = traceRowsOf(batchFromRows('spans', ok), batchFromRows('logs', []));
    // the origin is the earliest start among spans that have one: `half` starts at 5, so the share is that of `a` alone
    expect(Reflect.get(withNulls[0] ?? {}, 'service_share')).toBe(
      Reflect.get(without[0] ?? {}, 'service_share'),
    );
    const allNull = traceRowsOf(batchFromRows('spans', [none]), batchFromRows('logs', []));
    expect(allNull[0]).toMatchObject({ span_count: 1, start_time_unix_nano: null, service_share: '[]' });
  });
});
