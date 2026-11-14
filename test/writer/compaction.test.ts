import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ParquetFile } from 'parquet-wasm/esm';
import { describe, expect, test } from 'vitest';
import { wrapBinaryDataFilePieces } from '../../src/format/data-file.js';
import { type PartitionEntry, ROLLUP_GRAIN_NS, type RollupDescription } from '../../src/format/manifest.js';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import { decodeTable, encodeColumnsUnfiltered, encodeTable } from '../../src/format/parquet/codec.js';
import type { Table } from '../../src/format/parquet/columns.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { fileStatistics } from '../../src/format/parquet/stats.js';
import { partitionKey, partitionWrapperPath } from '../../src/format/paths.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { CompactOptions } from '../../src/writer/compaction.js';
import { COMPACTION_SPAN_NS, compactPartitions, timeGroups } from '../../src/writer/compaction.js';
import { mergeReports } from '../../src/writer/merge.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import { PartitionWriter } from '../../src/writer/partition-writer.js';
import type { FileSystem } from '../../src/writer/ports.js';
import {
  addRollupRows,
  logRollupRows,
  rollupDimensions,
  spanRollupRows,
} from '../../src/writer/rollup-rows.js';
import { openSession } from '../../src/writer/session.js';
import { traceRows } from '../../src/writer/trace-summaries.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { logRecord, logsRequest, span, traceRequest } from '../../test-support/otlp-builders.js';
import { chunksOf } from '../../test-support/parquet-footer.js';
import {
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { manifestOf, tableRowsOf } from './helpers.js';

const OUT = '/out';
const ROW_GROUP = 5;
const KEYS: Record<Table, string[]> = {
  spans: ['scope_name', 'service_name'],
  logs: ['scope_name', 'service_name', 'attr:k'],
  points: ['metric_name'],
  traces: [],
  patterns: [],
  span_rollups: [],
  log_rollups: [],
};

/** A small deterministic generator, so the rows differ run to run of the code but never run to run of the test. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s;
  };
}

const SCOPES = ['b', 'a', 'c', null] as const;
const SERVICES = ['svc2', 'svc1', null] as const;

function spanRow(i: number, r: () => number): Row {
  const start = BigInt(r() % 40);
  return {
    trace_id: `t${r() % 9}`,
    span_id: `s${i}`,
    name: `op${r() % 4}`,
    start_time_unix_nano: start,
    end_time_unix_nano: start + 5n,
    duration_ns: 5n,
    attributes: '{}',
    scope_name: SCOPES[r() % 4] ?? null,
    service_name: SERVICES[r() % 3] ?? null,
  };
}

function logRow(i: number, r: () => number): Row {
  const t = BigInt(r() % 40);
  return {
    time_unix_nano: r() % 5 === 0 ? null : t,
    observed_time_unix_nano: BigInt(r() % 40),
    body: `"b${i}"`,
    attributes: `{"k":"v${r() % 3}"}`,
    scope_name: SCOPES[r() % 4] ?? null,
    service_name: SERVICES[r() % 3] ?? null,
  };
}

function pointRow(i: number, r: () => number): Row {
  return {
    metric_name: `m${r() % 3}`,
    point_type: 'gauge',
    time_unix_nano: BigInt(r() % 40),
    series_id: `ser${i}`,
    value_double: i / 2,
    explicit_bounds: i % 2 === 0 ? [1, 2] : null,
    bucket_counts: i % 3 === 0 ? [1n, 2n, 3n] : null,
    scope_name: SCOPES[r() % 4] ?? null,
    service_name: SERVICES[r() % 3] ?? null,
  };
}

const MAKE = { spans: spanRow, logs: logRow, points: pointRow } as const;

/** Writes `parts` as partitions 0.. (each a sorted file per table) and returns their entries. */
async function writeParts(
  fs: FileSystem,
  parts: readonly Partial<Record<Table, Row[]>>[],
  rowGroupRows = ROW_GROUP,
  out = OUT,
): Promise<PartitionEntry[]> {
  const w = new PartitionWriter(fs, {
    out,
    rowGroupRows,
    statisticsKeys: KEYS,
    facetValueCap: 100,
    nextPartition: 0,
  });
  const entries: PartitionEntry[] = [];
  for (const [i, part] of parts.entries()) {
    for (const [table, rows] of Object.entries(part) as [Table, Row[]][])
      for (const r of rows) w.add(table, r);
    const e = await w.cut(`flush:${i}`);
    if (e === null) throw new Error('nothing cut');
    entries.push(e);
  }
  return entries;
}

const opts = (nextPartition: number, rowGroupRows = ROW_GROUP, facetValueCap = 100) => ({
  nextPartition,
  rowGroupRows,
  statisticsKeys: KEYS,
  facetValueCap,
  source: `compact:0..${nextPartition - 1}`,
});

async function bytesOf(fs: FileSystem, entry: PartitionEntry, t: Table) {
  const f = entry.files[t];
  if (f === undefined) throw new Error(`no ${t} file`);
  return fs.readBytes(`${OUT}/${f.path}`);
}

describe('compactPartitions: merged tables', () => {
  for (const table of ['spans', 'logs', 'points'] as const) {
    test(`${table}: the file equals encoding the union of the rows, with the same row groups`, async () => {
      const r = lcg(7);
      const sizes = [13, 1, 22];
      let id = 0;
      const rowsPer = sizes.map((n) => Array.from({ length: n }, () => MAKE[table](id++, r)));
      const fs = createMemoryFileSystem();
      const entries = await writeParts(
        fs,
        rowsPer.map((rows) => ({ [table]: rows })),
      );
      const out = await compactPartitions(fs, OUT, entries, opts(3));
      const expected = encodeTable(table, rowsPer.flat(), { rowGroupRows: ROW_GROUP });
      expect(Buffer.from(await bytesOf(fs, out, table)).equals(Buffer.from(expected))).toBe(true);
      expect(out.n).toBe(3);
      expect(out.source).toBe('compact:0..2');
      expect(out.files[table]?.path).toBe(`data/partitions/000003/${table}.parquet`);
      expect(out.files[table]?.bytes).toBe(expected.length);
      // A partition without a rollup gets one recomputed from the rows.
      expect(Object.keys(out.files).filter((k) => !k.endsWith('_rollups'))).toEqual([table]);
    });
  }

  test('past one merge chunk, with row groups that do not divide it, the bytes still equal the one-pass encoding', async () => {
    const r = lcg(99);
    let id = 0;
    const rowsPer = [9_000, 4_100, 6_300].map((n) => Array.from({ length: n }, () => logRow(id++, r)));
    const rowGroupRows = 3_000;
    const fs = createMemoryFileSystem();
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      rowGroupRows,
    );
    const out = await compactPartitions(fs, OUT, entries, opts(3, rowGroupRows));
    const expected = encodeTable('logs', rowsPer.flat(), { rowGroupRows });
    expect(Buffer.from(await bytesOf(fs, out, 'logs')).equals(Buffer.from(expected))).toBe(true);
    const { path, bytes, ...stats } = out.files.logs ?? { path: '', bytes: 0 };
    expect(stats).toEqual(fileStatistics('logs', batchFromRows('logs', rowsPer.flat()), KEYS.logs, 100));
  });

  test.each([
    [37, 3],
    [270, 2],
  ])(
    '%i partitions (more files than one merge takes) merge in rounds to the same bytes, leaving no temporary file',
    async (count, per) => {
      const r = lcg(count);
      let id = 0;
      const rowsPer = Array.from({ length: count }, () => Array.from({ length: per }, () => logRow(id++, r)));
      const fs = createMemoryFileSystem();
      const entries = await writeParts(
        fs,
        rowsPer.map((logs) => ({ logs })),
      );
      const out = await compactPartitions(fs, OUT, entries, opts(count));
      const expected = encodeTable('logs', rowsPer.flat(), { rowGroupRows: ROW_GROUP });
      expect(Buffer.from(await bytesOf(fs, out, 'logs')).equals(Buffer.from(expected))).toBe(true);
      expect(await fs.list(`${OUT}/data/partitions/${String(count).padStart(6, '0')}`)).toEqual([
        'log_rollups.parquet',
        'logs.parquet',
      ]);
      const { path, bytes, ...stats } = out.files.logs ?? { path: '', bytes: 0 };
      expect(stats).toEqual(fileStatistics('logs', batchFromRows('logs', rowsPer.flat()), KEYS.logs, 100));
    },
  );

  test('a facet cap exceeded only across merge chunks makes the key unknown, as in one pass', async () => {
    const mk = (i: number, svc: number): Row => ({
      time_unix_nano: BigInt(i),
      body: '"b"',
      scope_name: 'x',
      service_name: `svc${svc}`,
    });
    const rowsPer = [0, 1].map((p) =>
      Array.from({ length: 5000 }, (_, i) => mk(p * 5000 + i, Math.floor((p * 5000 + i) / 2000))),
    );
    const fs = createMemoryFileSystem();
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      50_000,
    );
    const out = await compactPartitions(fs, OUT, entries, opts(2, 50_000, 3));
    const whole = fileStatistics('logs', batchFromRows('logs', rowsPer.flat()), KEYS.logs, 3);
    expect(Reflect.get(whole.values, 'service_name')).toBeNull();
    expect(Reflect.get(out.files.logs?.values ?? {}, 'service_name')).toBeNull();
    expect(out.files.logs?.rows).toBe(10_000);
  });

  test('a failure in a merge round removes the folder with its temporary files', async () => {
    const r = lcg(4);
    let id = 0;
    const rowsPer = Array.from({ length: 20 }, () => Array.from({ length: 3 }, () => logRow(id++, r)));
    const fs = createMemoryFileSystem();
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
    );
    fs.failNextWrite('.merge-logs-0-1.parquet');
    await expect(compactPartitions(fs, OUT, entries, opts(20))).rejects.toThrow('injected write failure');
    expect(await fs.exists(`${OUT}/data/partitions/000020`)).toBe(false);
  });

  test('a corrupt row group rejects the compaction instead of hanging it', async () => {
    const r = lcg(8);
    let id = 0;
    const rowsPer = [0, 1].map(() => Array.from({ length: 20_000 }, () => logRow(id++, r)));
    const fs = createMemoryFileSystem();
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      5000,
    );
    const f = entries[1]?.files.logs;
    if (f === undefined) throw new Error('no file');
    const bad = await fs.readBytes(`${OUT}/${f.path}`);
    const from = Math.floor(bad.length * 0.6);
    for (let i = from; i < from + 200; i++) bad[i] = (bad[i] ?? 0) ^ 0xff;
    await fs.writeBytes(`${OUT}/${f.path}`, bad);
    await expect(compactPartitions(fs, OUT, entries, opts(2, 5000))).rejects.toMatchObject({
      code: 'invalid-report',
    });
    expect(await fs.exists(`${OUT}/data/partitions/000002`)).toBe(false);
    // The wasm instance still serves a good file afterwards.
    const again = encodeTable('logs', rowsPer[0]?.slice(0, 10) ?? [], { rowGroupRows: 5 });
    expect(decodeTable('logs', again)).toHaveLength(10);
  });

  test('the statistics are those of the merged rows', async () => {
    const r = lcg(3);
    let id = 0;
    const rowsPer = [10, 9].map((n) => Array.from({ length: n }, () => logRow(id++, r)));
    const fs = createMemoryFileSystem();
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
    );
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const { path, bytes, ...stats } = out.files.logs ?? { path: '', bytes: 0 };
    expect(path).toBe('data/partitions/000002/logs.parquet');
    expect(bytes).toBeGreaterThan(0);
    expect(stats).toEqual(fileStatistics('logs', batchFromRows('logs', rowsPer.flat()), KEYS.logs, 100));
  });

  test('a key that only one of two compacted files knows is computed for the other, not dropped', async () => {
    const r = lcg(5);
    let id = 0;
    const rowsPer = [4, 4].map((n) => Array.from({ length: n }, () => logRow(id++, r)));
    const fs = createMemoryFileSystem();
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
    );
    const first = entries[0]?.files.logs;
    if (first === undefined) throw new Error('no file');
    const second = entries[1]?.files.logs;
    if (second === undefined) throw new Error('no file');
    const { 'attr:k': _dropped, ...without } = first.values;
    first.values = without; // not computed
    second.values = { ...second.values, 'attr:k': ['stale'] }; // a recorded value the rows do not hold
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const expected = fileStatistics('logs', batchFromRows('logs', rowsPer.flat()), ['attr:k'], 100);
    expect(out.files.logs?.values['attr:k']).toEqual(expected.values['attr:k']);
    expect(out.files.logs?.values['attr:k']).not.toContain('stale');
    expect(Reflect.get(out.files.logs?.values ?? {}, 'scope_name')).not.toBeNull();
  });

  test('a table only some partitions have is merged from those, and a table none have gets no file', async () => {
    const r = lcg(11);
    let id = 0;
    const a = Array.from({ length: 6 }, () => spanRow(id++, r));
    const b = Array.from({ length: 7 }, () => logRow(id++, r));
    const c = Array.from({ length: 8 }, () => spanRow(id++, r));
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [{ spans: a }, { logs: b }, { spans: c }]);
    const out = await compactPartitions(fs, OUT, entries, opts(3));
    expect(
      Object.keys(out.files)
        .filter((k) => !k.endsWith('_rollups'))
        .sort(),
    ).toEqual(['logs', 'spans']);
    const spans = decodeTable('spans', await bytesOf(fs, out, 'spans'));
    expect(spans).toHaveLength(14);
    expect(out.files.logs?.rows).toBe(7);
  });

  test('every row survives; a null sort key sorts last; ties keep partition order', async () => {
    const mk = (id: string, service: string | null): Row => ({
      time_unix_nano: 1n,
      body: `"${id}"`,
      scope_name: 'x',
      service_name: service,
    });
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      { logs: [mk('p0a', 'a'), mk('p0n', null)] },
      { logs: [mk('p1a', 'a'), mk('p1b', 'b')] },
    ]);
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const rows = decodeTable('logs', await bytesOf(fs, out, 'logs'));
    expect(rows.map((x) => Reflect.get(x, 'body'))).toEqual(['"p0a"', '"p1a"', '"p1b"', '"p0n"']);
  });

  test('a file of another schema fails invalid-report and writes nothing', async () => {
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      { logs: [{ time_unix_nano: 1n, body: '"a"', scope_name: 'x', service_name: 'y' }] },
      { logs: [{ time_unix_nano: 2n, body: '"b"', scope_name: 'x', service_name: 'y' }] },
    ]);
    // A spans file where the second partition's logs file should be.
    const foreign = encodeTable('spans', [spanRow(0, lcg(1))], { rowGroupRows: ROW_GROUP });
    const f = entries[1]?.files.logs;
    if (f === undefined) throw new Error('no file');
    await fs.writeBytes(`${OUT}/${f.path}`, foreign);
    const err = await compactPartitions(fs, OUT, entries, opts(2)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OtelHtmlError);
    expect((err as OtelHtmlError).code).toBe('invalid-report');
    expect(await fs.exists(`${OUT}/data/partitions/000002/logs.parquet`)).toBe(false);
  });

  test('it makes no listing of its own: the output folder holds only the compacted files', async () => {
    const r = lcg(2);
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      { spans: [spanRow(0, r)] },
      { spans: [spanRow(1, r)], logs: [logRow(2, r)] },
    ]);
    await compactPartitions(fs, OUT, entries, opts(2));
    expect(await fs.list(`${OUT}/data/partitions/000002`)).toEqual([
      'log_rollups.parquet',
      'logs.parquet',
      'span_rollups.parquet',
      'spans.parquet',
    ]);
  });
});

function trace(id: string, over: Row = {}): Row {
  return {
    trace_id: id,
    start_time_unix_nano: null,
    end_time_unix_nano: null,
    span_count: 0,
    error_count: 0,
    root_service: null,
    root_name: null,
    root_resource: null,
    log_count: 0,
    ...over,
  };
}

describe('compactPartitions: traces', () => {
  test('rows of one trace id are re-aggregated', async () => {
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      {
        traces: [
          trace('a', {
            start_time_unix_nano: 50n,
            end_time_unix_nano: 60n,
            span_count: 2,
            error_count: 1,
            log_count: 1,
            root_service: 'late',
            root_name: 'late-root',
            root_resource: 'lr',
          }),
          trace('b', { start_time_unix_nano: 5n, end_time_unix_nano: 9n, span_count: 1 }),
        ],
      },
      {
        traces: [
          trace('a', {
            start_time_unix_nano: 40n,
            end_time_unix_nano: 45n,
            span_count: 3,
            error_count: 2,
            log_count: 4,
            root_service: 'early',
            root_name: 'early-root',
            root_resource: 'er',
          }),
        ],
      },
    ]);
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const rows = decodeTable('traces', await bytesOf(fs, out, 'traces'));
    expect(rows).toEqual([
      trace('b', { start_time_unix_nano: 5n, end_time_unix_nano: 9n, span_count: 1 }),
      trace('a', {
        start_time_unix_nano: 40n,
        end_time_unix_nano: 60n,
        span_count: 5,
        error_count: 3,
        log_count: 5,
        root_service: 'early',
        root_name: 'early-root',
        root_resource: 'er',
      }),
    ]);
    expect(out.files.traces?.rows).toBe(2);
  });

  test('rows with only logs set the range only when no row has spans; the log-only range is the min and max', async () => {
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      {
        traces: [
          trace('s', { start_time_unix_nano: 100n, end_time_unix_nano: 200n, span_count: 1 }),
          trace('l', { start_time_unix_nano: 30n, end_time_unix_nano: 40n, log_count: 2 }),
          trace('n', { log_count: 1 }),
        ],
      },
      {
        traces: [
          trace('s', { start_time_unix_nano: 10n, end_time_unix_nano: 20n, log_count: 3 }),
          trace('l', { start_time_unix_nano: 5n, end_time_unix_nano: 35n, log_count: 1 }),
          trace('n', { log_count: 1 }),
        ],
      },
    ]);
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const rows = decodeTable('traces', await bytesOf(fs, out, 'traces'));
    const byId = new Map(rows.map((x) => [Reflect.get(x, 'trace_id'), x]));
    expect(byId.get('s')).toMatchObject({
      start_time_unix_nano: 100n,
      end_time_unix_nano: 200n,
      span_count: 1,
      log_count: 3,
    });
    expect(byId.get('l')).toMatchObject({ start_time_unix_nano: 5n, end_time_unix_nano: 40n, log_count: 3 });
    expect(byId.get('n')).toMatchObject({
      start_time_unix_nano: null,
      end_time_unix_nano: null,
      log_count: 2,
    });
  });

  test('root_* comes from the root row with the smallest start; a tie goes to the lower partition', async () => {
    const fs = createMemoryFileSystem();
    const root = (service: string, start: bigint): Row =>
      trace('a', {
        start_time_unix_nano: start,
        end_time_unix_nano: start + 1n,
        span_count: 1,
        root_service: service,
        root_name: `${service}-n`,
        root_resource: null,
      });
    const entries = await writeParts(fs, [
      { traces: [root('p0', 10n)] },
      { traces: [root('p1', 10n)] },
      { traces: [trace('a', { start_time_unix_nano: 1n, end_time_unix_nano: 2n, span_count: 1 })] },
    ]);
    const out = await compactPartitions(fs, OUT, entries, opts(3));
    const [row] = decodeTable('traces', await bytesOf(fs, out, 'traces'));
    expect(row).toMatchObject({
      root_service: 'p0',
      root_name: 'p0-n',
      start_time_unix_nano: 1n,
      span_count: 3,
    });
  });
});

function pattern(id: number, over: Row = {}): Row {
  return {
    cluster_id: BigInt(id),
    template: `t${id}`,
    count: 1n,
    first_time_unix_nano: null,
    last_time_unix_nano: null,
    severity_counts: '{}',
    sample: null,
    ...over,
  };
}

describe('compactPartitions: patterns', () => {
  test('rows of one cluster are summed; the template is the highest partition and the sample the earliest', async () => {
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      {
        patterns: [
          pattern(1, {
            template: 'x <*>',
            count: 3n,
            first_time_unix_nano: 20n,
            last_time_unix_nano: 30n,
            severity_counts: '{"9":2,"17":1}',
            sample: 'x 1',
          }),
          pattern(2, { count: 2n, first_time_unix_nano: 5n, last_time_unix_nano: 6n, sample: 'only' }),
        ],
      },
      {
        patterns: [
          pattern(1, {
            template: '<*> <*>',
            count: 4n,
            first_time_unix_nano: 10n,
            last_time_unix_nano: 25n,
            severity_counts: '{"9":1,"13":3}',
            sample: 'y 2',
          }),
        ],
      },
    ]);
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const rows = decodeTable('patterns', await bytesOf(fs, out, 'patterns'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      pattern(1, {
        template: '<*> <*>',
        count: 7n,
        first_time_unix_nano: 10n,
        last_time_unix_nano: 30n,
        severity_counts: '{"9":3,"13":3,"17":1}',
        sample: 'y 2',
      }),
    );
    expect(Reflect.get(rows[1] ?? {}, 'cluster_id')).toBe(2n);
  });

  test('a tie on the first time takes the sample of the lower partition; a null first time loses', async () => {
    const fs = createMemoryFileSystem();
    const entries = await writeParts(fs, [
      { patterns: [pattern(1, { first_time_unix_nano: 7n, sample: 'p0' }), pattern(2, { sample: 'none' })] },
      {
        patterns: [
          pattern(1, { first_time_unix_nano: 7n, sample: 'p1' }),
          pattern(2, { first_time_unix_nano: 9n, sample: 'dated' }),
        ],
      },
    ]);
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    const rows = decodeTable('patterns', await bytesOf(fs, out, 'patterns'));
    expect(rows.map((x) => Reflect.get(x, 'sample'))).toEqual(['p0', 'dated']);
  });
});

describe('compactPartitions: chunked output', () => {
  const build = async (chunks: boolean) => {
    const fs = createMemoryFileSystem({ chunks });
    const r = lcg(33);
    let id = 0;
    const rowsPer = Array.from({ length: 2 }, () => Array.from({ length: 4_096 }, () => logRow(id++, r)));
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      1_000,
    );
    const out = await compactPartitions(fs, OUT, entries, opts(2, 1_000));
    return { fs, out, rows: rowsPer.flat() };
  };

  test('a two-file merge written in chunks equals the collected path, in bytes and statistics', async () => {
    const chunked = await build(true);
    const collected = await build(false);
    const path = chunked.out.files.logs?.path ?? '';
    expect(chunked.fs.chunkCount(`${OUT}/${path}`)).toBeGreaterThan(1);
    expect(collected.fs.chunkCount(`${OUT}/${path}`)).toBeUndefined();
    const a = await chunked.fs.readBytes(`${OUT}/${path}`);
    const b = await collected.fs.readBytes(`${OUT}/${path}`);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(
      Buffer.from(a).equals(Buffer.from(encodeTable('logs', chunked.rows, { rowGroupRows: 1_000 }))),
    ).toBe(true);
    expect(chunked.out.files.logs).toEqual(collected.out.files.logs);
    expect(chunked.out.files.logs?.rows).toBe(8_192);
    expect(chunked.out.files.logs?.bytes).toBe(a.length);
  });
});

describe('compactPartitions in the local format', () => {
  test('the wrapper of the compacted file is written from the file in pieces, without reading it whole', async () => {
    const base = createMemoryFileSystem({ pieces: true });
    const wholeReads: string[] = [];
    const fs: typeof base = {
      ...base,
      readBytes: (p) => {
        wholeReads.push(p);
        return base.readBytes(p);
      },
    };
    const r = lcg(41);
    let id = 0;
    const rowsPer = Array.from({ length: 3 }, () => Array.from({ length: 700 }, () => logRow(id++, r)));
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      ROW_GROUP,
    );
    wholeReads.length = 0;
    const out = await compactPartitions(fs, OUT, entries, { ...opts(3), format: 'local' });
    const path = `${OUT}/${out.files.logs?.path ?? ''}`;
    expect(wholeReads).not.toContain(path);
    const file = await base.readBytes(path);
    const wrapper = await base.readText(`${OUT}/${partitionWrapperPath(3, 'logs')}`);
    const base64 = (slice: Uint8Array): string => Buffer.from(slice).toString('base64');
    expect(wrapper).toBe([...wrapBinaryDataFilePieces(partitionKey(3, 'logs'), file, base64)].join(''));
  });
});

describe('compactPartitions: the files of the earlier rounds', () => {
  // parquet-wasm holds the metadata of every row group a file has (about 30 KB each) while it writes or reads the
  // file, so small row groups in a big temporary file cost memory in proportion to its rows (#227).
  test('are written with row groups of the configured size, not smaller', async () => {
    const base = createMemoryFileSystem();
    const temporaries: Uint8Array[] = [];
    const fs: typeof base = {
      ...base,
      writeByteChunksAtomic: async (p, chunks) => {
        await base.writeByteChunksAtomic?.(p, chunks);
        if (p.includes('.merge-')) temporaries.push(await base.readBytes(p));
      },
    };
    const r = lcg(51);
    let id = 0;
    const rowsPer = Array.from({ length: 17 }, () => Array.from({ length: 600 }, () => logRow(id++, r)));
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      1_000,
    );
    await compactPartitions(fs, OUT, entries, opts(17, 10_000));
    expect(temporaries).toHaveLength(1); // the first 16 of the 17 files
    const first = temporaries[0];
    if (first === undefined) throw new Error('no temporary file');
    const file = await ParquetFile.fromFile(new Blob([new Uint8Array(first)]));
    try {
      expect(file.metadata().numRowGroups()).toBe(1); // 9,600 rows; 4,096-row groups made three
    } finally {
      file.free();
    }
  });
});

describe('compactPartitions: fan-out', () => {
  test('the first round merges 16 flush partitions at once, later rounds 8 files', async () => {
    const base = createMemoryFileSystem();
    const written: string[] = [];
    const fs: typeof base = {
      ...base,
      writeByteChunksAtomic: async (p, chunks) => {
        written.push(p.slice(p.lastIndexOf('/') + 1));
        await base.writeByteChunksAtomic?.(p, chunks);
      },
    };
    const r = lcg(61);
    let id = 0;
    const rowsPer = Array.from({ length: 144 }, () => Array.from({ length: 2 }, () => logRow(id++, r)));
    const entries = await writeParts(
      fs,
      rowsPer.map((logs) => ({ logs })),
      ROW_GROUP,
    );
    written.length = 0;
    await compactPartitions(fs, OUT, entries, opts(144));
    // 144 partitions: nine files of 16, then nine files in two groups (8 and 1, the single one passing through),
    // then the last two merged into the result.
    expect(written.filter((p) => p.startsWith('.merge-logs-0-'))).toHaveLength(9);
    expect(written.filter((p) => p.startsWith('.merge-logs-1-'))).toHaveLength(1);
    expect(written).toContain('logs.parquet');
  });
});

describe('compactPartitions on the real file system', () => {
  test('more than one round of inputs merges through blobs on disk to the same bytes, leaving no temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'otel-html-compact-'));
    try {
      const fs = createNodeFileSystem();
      expect(fs.openBlob).toBeDefined();
      const r = lcg(21);
      let id = 0;
      const rowsPer = Array.from({ length: 20 }, () => Array.from({ length: 7 }, () => logRow(id++, r)));
      const entries = await writeParts(
        fs,
        rowsPer.map((logs) => ({ logs })),
        ROW_GROUP,
        dir,
      );
      const out = await compactPartitions(fs, dir, entries, opts(20));
      const expected = encodeTable('logs', rowsPer.flat(), { rowGroupRows: ROW_GROUP });
      const got = await fs.readBytes(join(dir, out.files.logs?.path ?? ''));
      expect(Buffer.from(got).equals(Buffer.from(expected))).toBe(true);
      expect((await readdir(join(dir, 'data/partitions/000020'))).sort()).toEqual([
        'log_rollups.parquet',
        'logs.parquet',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('bloom filters on trace_id', () => {
  const filtered = (bytes: Uint8Array): boolean[] =>
    chunksOf(bytes)
      .flat()
      .filter((c) => c.path === 'trace_id')
      .map((c) => c.offset !== undefined && c.length !== undefined);
  const anyFilter = (bytes: Uint8Array): boolean =>
    chunksOf(bytes)
      .flat()
      .some((c) => c.offset !== undefined);

  test('a cut and a compaction write one per row group of traces and logs, and none for spans, points and patterns', async () => {
    const fs = createMemoryFileSystem();
    const r = lcg(7);
    let id = 0;
    const part = (): Partial<Record<Table, Row[]>> => ({
      spans: Array.from({ length: 12 }, () => spanRow(id++, r)),
      logs: Array.from({ length: 12 }, () => logRow(id++, r)),
      points: Array.from({ length: 12 }, () => pointRow(id++, r)),
      traces: Array.from({ length: 12 }, (_, i) => trace(`t${id}-${i}`)),
    });
    const entries = await writeParts(fs, [part(), part(), part()]);
    for (const entry of entries) {
      for (const t of ['logs', 'traces'] as const) {
        const flags = filtered(await bytesOf(fs, entry, t));
        expect(flags.length, `cut ${t}`).toBeGreaterThan(1);
        expect(flags.every(Boolean), `cut ${t}`).toBe(true);
      }
      expect(anyFilter(await bytesOf(fs, entry, 'spans'))).toBe(false);
      expect(anyFilter(await bytesOf(fs, entry, 'points'))).toBe(false);
    }
    const out = await compactPartitions(fs, OUT, entries, opts(3));
    for (const t of ['logs', 'traces'] as const) {
      const flags = filtered(await bytesOf(fs, out, t));
      expect(flags.length, `compacted ${t}`).toBeGreaterThan(1);
      expect(flags.every(Boolean), `compacted ${t}`).toBe(true);
    }
    expect(anyFilter(await bytesOf(fs, out, 'spans'))).toBe(false);
    expect(anyFilter(await bytesOf(fs, out, 'points'))).toBe(false);
  });

  test('a compaction whose inputs have no filters (files written before them) still writes them', async () => {
    const fs = createMemoryFileSystem();
    const r = lcg(9);
    let id = 0;
    const rows = Array.from({ length: 14 }, () => logRow(id++, r));
    const plain = encodeColumnsUnfiltered('logs', batchFromRows('logs', rows), { rowGroupRows: ROW_GROUP });
    expect(anyFilter(plain)).toBe(false);
    const entries = await writeParts(fs, [{ logs: rows }]);
    await fs.writeBytes(`${OUT}/${entries[0]?.files.logs?.path ?? ''}`, plain);
    const out = await compactPartitions(fs, OUT, entries, opts(1));
    expect(filtered(await bytesOf(fs, out, 'logs')).every(Boolean)).toBe(true);
    expect(decodeTable('logs', await bytesOf(fs, out, 'logs'))).toHaveLength(14);
  });
});

// -- rollups and timeEndMax (query-scaling Task 16) --------------------------------------------------------------

const DIMS = rollupDimensions('spans', KEYS.spans);
const DESCRIPTION: RollupDescription = {
  grainNs: ROLLUP_GRAIN_NS,
  dimensions: DIMS,
  durationBuckets: 'log2x8',
};
const LOG_DESCRIPTION: RollupDescription = {
  grainNs: ROLLUP_GRAIN_NS,
  dimensions: rollupDimensions('logs', KEYS.logs),
};

/** Like `writeParts`, with a derive hook writing the span and log rollups of each cut under `dims` (null: none). */
async function writeRolled(
  fs: FileSystem,
  parts: readonly Partial<Record<Table, Row[]>>[],
  dims: readonly (string[] | null)[] = [],
  rowGroupRows = ROW_GROUP,
): Promise<PartitionEntry[]> {
  const entries: PartitionEntry[] = [];
  for (const [i, part] of parts.entries()) {
    const d = dims[i] === undefined ? DIMS : dims[i];
    const w = new PartitionWriter(fs, {
      out: OUT,
      rowGroupRows,
      statisticsKeys: KEYS,
      facetValueCap: 100,
      nextPartition: i,
      derive: (taken) => {
        const traces = traceRows(taken.spans, taken.logs);
        if (d === null) return { rows: { traces } };
        const description = { ...DESCRIPTION, dimensions: d };
        return {
          rows: {
            traces,
            span_rollups: spanRollupRows(taken.spans, d),
            log_rollups: logRollupRows(taken.logs, LOG_DESCRIPTION.dimensions),
          },
          rollups: {
            span_rollups: description,
            ...(taken.logs.length > 0 ? { log_rollups: LOG_DESCRIPTION } : {}),
          },
        };
      },
    });
    for (const [table, rows] of Object.entries(part) as [Table, Row[]][])
      for (const r of rows) w.add(table, r);
    const e = await w.cut(`flush:${i}`);
    if (e === null) throw new Error('nothing cut');
    entries.push(e);
  }
  return entries;
}

const rollupOpts = (n: number, extra: Partial<CompactOptions> = {}): CompactOptions => ({
  ...opts(n),
  statisticsKeys: KEYS,
  ...extra,
});

async function rowsOfFile(fs: FileSystem, e: PartitionEntry, t: Table): Promise<Row[]> {
  return decodeTable(t, await bytesOf(fs, e, t));
}

const canon = (rows: readonly Row[]): string[] =>
  rows.map((r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))).sort();

function spansOf(seed: number, n: number, offset: number): Row[] {
  const r = lcg(seed);
  return Array.from({ length: n }, (_, i) => spanRow(offset + i, r));
}

describe('compactPartitions: rollups', () => {
  test('compacting partitions with equal rollup descriptions equals the rollup of the compacted rows', async () => {
    const fs = createMemoryFileSystem();
    const a = spansOf(1, 30, 0);
    const b = spansOf(2, 25, 100);
    const entries = await writeRolled(fs, [{ spans: a }, { spans: b }]);
    const out = await compactPartitions(fs, OUT, entries, rollupOpts(2));
    const expected = spanRollupRows(batchFromRows('spans', [...a, ...b]), DIMS);
    expect(canon(await rowsOfFile(fs, out, 'span_rollups'))).toEqual(canon(expected));
    expect(out.files.span_rollups?.rollup).toEqual(DESCRIPTION);
    expect(out.files.span_rollups?.rows).toBe(expected.length);
  });

  test('log rollups add up too', async () => {
    const fs = createMemoryFileSystem();
    const r = lcg(3);
    const a = Array.from({ length: 12 }, (_, i) => logRow(i, r));
    const b = Array.from({ length: 12 }, (_, i) => logRow(50 + i, r));
    const entries = await writeRolled(fs, [{ logs: a }, { logs: b }]);
    const out = await compactPartitions(fs, OUT, entries, rollupOpts(2));
    const expected = logRollupRows(batchFromRows('logs', [...a, ...b]), LOG_DESCRIPTION.dimensions);
    expect(canon(await rowsOfFile(fs, out, 'log_rollups'))).toEqual(canon(expected));
    expect(out.files.span_rollups).toBeUndefined();
  });

  test('addRollupRows adds n and sum, keeps min of mins and max of maxes', () => {
    const base = { start_time_unix_nano: 0n, duration_bucket: 1 };
    const sum = addRollupRows(
      [{ ...base, n: 2n, duration_sum: 10n, duration_min: 3n, duration_max: 7n }],
      [
        { ...base, n: 1n, duration_sum: 2n, duration_min: 2n, duration_max: 2n },
        { ...base, duration_bucket: 2, n: 1n, duration_sum: 1n, duration_min: 1n, duration_max: 1n },
      ],
    );
    expect(sum).toHaveLength(2);
    expect(sum[0]).toEqual({ ...base, n: 3n, duration_sum: 12n, duration_min: 2n, duration_max: 7n });
  });

  test('compacting a partition without a rollup, or with other dimensions, recomputes from the rows', async () => {
    for (const dims of [
      [null, DIMS],
      [[...DIMS.slice(1)], DIMS],
    ] as const) {
      const fs = createMemoryFileSystem();
      const a = spansOf(4, 30, 0);
      const b = spansOf(5, 25, 100);
      const entries = await writeRolled(
        fs,
        [{ spans: a }, { spans: b }],
        dims.map((d) => (d === null ? null : [...d])),
      );
      const out = await compactPartitions(fs, OUT, entries, rollupOpts(2));
      const expected = spanRollupRows(batchFromRows('spans', [...a, ...b]), DIMS);
      expect(canon(await rowsOfFile(fs, out, 'span_rollups'))).toEqual(canon(expected));
      expect(out.files.span_rollups?.rollup).toEqual(DESCRIPTION);
    }
  });

  test('the guard applies to a compacted rollup: too many rows and it is not written, with a warning', async () => {
    const fs = createMemoryFileSystem();
    const distinct = (from: number): Row[] =>
      Array.from({ length: 2600 }, (_, i) => ({
        ...spanRow(from + i, lcg(from + i)),
        name: `op${from + i}`,
      }));
    const entries = await writeRolled(fs, [{ spans: distinct(0) }, { spans: distinct(3000) }], [], 1000);
    expect(entries[0]?.files.span_rollups).toBeDefined();
    const warned: string[] = [];
    const out = await compactPartitions(fs, OUT, entries, {
      ...rollupOpts(2),
      rowGroupRows: 1000,
      warn: (m) => warned.push(m),
    });
    expect(out.files.spans?.rows).toBe(5200);
    expect(out.files.span_rollups).toBeUndefined();
    expect(warned).toHaveLength(1);
    expect(await fs.exists(`${OUT}/data/partitions/000002/span_rollups.parquet`)).toBe(false);
  });

  test.each([
    ['summed', undefined],
    ['recomputed', null],
  ] as const)(
    'a %s rollup past the guard is dropped with one warning that reports no partial counts',
    async (_how, dims) => {
      const fs = createMemoryFileSystem();
      const distinct = (from: number): Row[] =>
        Array.from({ length: 2600 }, (_, i) => ({
          ...spanRow(from + i, lcg(from + i)),
          name: `op${from + i}`,
        }));
      const entries = await writeRolled(
        fs,
        [{ spans: distinct(0) }, { spans: distinct(3000) }],
        dims === null ? [null, null] : [],
        1000,
      );
      const warned: { msg: string; attrs: unknown }[] = [];
      const out = await compactPartitions(fs, OUT, entries, {
        ...rollupOpts(2),
        rowGroupRows: 1000,
        warn: (msg, attrs) => warned.push({ msg, attrs }),
      });
      expect(out.files.spans?.rows).toBe(5200);
      expect(out.files.span_rollups).toBeUndefined();
      expect(warned).toHaveLength(1);
      expect(warned[0]?.msg).toContain('more groups than 4096');
      expect(warned[0]?.attrs).not.toHaveProperty('rollupRows');
      expect(warned[0]?.attrs).not.toHaveProperty('widestDimension');
    },
  );

  test.each([
    ['summed', undefined],
    ['recomputed', null],
  ] as const)(
    'a %s rollup whose duration_sum leaves int64 is omitted, the spans still compact',
    async (_how, dims) => {
      const fs = createMemoryFileSystem();
      // Two partitions of 600 spans of 8 * 10^15 ns, all of equal dimensions: each sum fits int64, their sum (9.6 * 10^18) does not.
      const heavy = (from: number): Row[] =>
        Array.from({ length: 600 }, (_, i) => ({
          ...spanRow(from + i, lcg(from + i)),
          name: 'heavy',
          scope_name: null,
          service_name: null,
          start_time_unix_nano: BigInt(i),
          end_time_unix_nano: BigInt(i) + 8_000_000_000_000_000n,
          duration_ns: 8_000_000_000_000_000n,
        }));
      const entries = await writeRolled(
        fs,
        [{ spans: heavy(0) }, { spans: heavy(1000) }],
        dims === null ? [null, null] : [],
      );
      if (dims === undefined) expect(entries[0]?.files.span_rollups).toBeDefined();
      const warned: string[] = [];
      const out = await compactPartitions(fs, OUT, entries, {
        ...rollupOpts(2),
        warn: (m) => warned.push(m),
      });
      expect(out.files.spans?.rows).toBe(1200);
      expect(out.files.span_rollups).toBeUndefined();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('int64');
      expect(await fs.exists(`${OUT}/data/partitions/000002/span_rollups.parquet`)).toBe(false);
    },
  );
});

describe('compactPartitions: timeEndMax', () => {
  test('written at cut, the max after compaction, and recomputed for inputs without it', async () => {
    const fs = createMemoryFileSystem();
    const a = spansOf(6, 20, 0);
    const b = spansOf(7, 20, 100);
    const entries = await writeRolled(fs, [{ spans: a }, { spans: b }]);
    const ends = (rows: Row[]) => rows.map((r) => Reflect.get(r, 'end_time_unix_nano') as bigint);
    const maxOf = (xs: bigint[]) => String([...xs].sort((p, q) => (p < q ? 1 : p > q ? -1 : 0))[0]);
    expect(entries[0]?.files.spans?.timeEndMax).toBe(maxOf(ends(a)));
    expect(typeof entries[0]?.files.traces?.timeEndMax).toBe('string');
    const out = await compactPartitions(fs, OUT, entries, rollupOpts(2));
    expect(out.files.spans?.timeEndMax).toBe(maxOf([...ends(a), ...ends(b)]));
    // Inputs of format 4 (no timeEndMax) are read anyway, so the compacted file has it.
    const stripped = entries.map((e) => {
      const files = { ...e.files };
      for (const t of ['spans', 'traces'] as const) {
        const f = files[t];
        if (f !== undefined)
          files[t] = Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'timeEndMax')) as typeof f;
      }
      return { ...e, files };
    });
    const again = await compactPartitions(fs, OUT, stripped, rollupOpts(3));
    expect(again.files.spans?.timeEndMax).toBe(maxOf([...ends(a), ...ends(b)]));
    expect(again.files.traces?.timeEndMax).toBe(out.files.traces?.timeEndMax);
    expect(out.files.logs).toBeUndefined();
  });
});

describe('compactPartitions: rows that end before they start, and given rollups', () => {
  const early = (i: number, start: bigint): Row => ({
    ...spanRow(i, lcg(i)),
    start_time_unix_nano: start,
    end_time_unix_nano: start - 100n,
    duration_ns: 0n,
  });

  test('timeEndMax is never below timeMin, at cut and after compaction, for spans and traces', async () => {
    const fs = createMemoryFileSystem();
    const entries = await writeRolled(fs, [{ spans: [early(1, 500n)] }, { spans: [early(2, 900n)] }]);
    for (const e of entries) {
      expect(e.files.spans?.timeEndMax).toBe(e.files.spans?.timeMin);
      expect(e.files.traces?.timeEndMax).toBe(e.files.traces?.timeMin);
    }
    const out = await compactPartitions(fs, OUT, entries, rollupOpts(2));
    expect(out.files.spans?.timeMin).toBe('500');
    expect(out.files.spans?.timeEndMax).toBe('900');
    expect(out.files.traces?.timeEndMax).toBe('900');
  });

  test('equal descriptions add the rollup files as given; they are not recomputed from the spans', async () => {
    const fs = createMemoryFileSystem();
    const a = spansOf(1, 30, 0);
    const b = spansOf(2, 25, 100);
    const entries = await writeRolled(fs, [{ spans: a }, { spans: b }]);
    // Hand-written rollup for the first input: every count and sum tenfold, which no recompute reproduces.
    const first = entries[0];
    const file = first?.files.span_rollups;
    if (first === undefined || file === undefined) throw new Error('no rollup');
    const given = (await rowsOfFile(fs, first, 'span_rollups')).map((r) => ({
      ...r,
      n: (Reflect.get(r, 'n') as bigint) * 10n,
      duration_sum: (Reflect.get(r, 'duration_sum') as bigint) * 10n,
    }));
    await fs.writeBytes(
      `${OUT}/${file.path}`,
      encodeTable('span_rollups', given, { rowGroupRows: ROW_GROUP }),
    );
    const second = entries[1];
    if (second === undefined) throw new Error('no second');
    const out = await compactPartitions(fs, OUT, entries, rollupOpts(2));
    const expected = addRollupRows(given, await rowsOfFile(fs, second, 'span_rollups'));
    expect(canon(await rowsOfFile(fs, out, 'span_rollups'))).toEqual(canon(expected));
    const recomputed = spanRollupRows(batchFromRows('spans', [...a, ...b]), DIMS);
    expect(canon(expected)).not.toEqual(canon(recomputed));
  });
});

// -- time groups ------------------------------------------------------------------------------------------------------

const HOUR = 3_600_000_000_000n;
const at = (startHour: number, endHour: number) => ({
  timeMin: String(BigInt(startHour) * HOUR),
  timeMax: String(BigInt(endHour) * HOUR),
});
const sizes = (groups: readonly (readonly unknown[])[]) => groups.map((g) => g.length);

describe('timeGroups', () => {
  test('the bound is 24 hours', () => {
    expect(COMPACTION_SPAN_NS).toBe(24n * HOUR);
  });

  test('inputs sorted by timeMin are grouped while the union spans at most 24 h', () => {
    expect(sizes(timeGroups([at(0, 1), at(2, 3), at(30, 31), at(60, 61)]))).toEqual([2, 1, 1]);
    // the input order does not matter, and the union is exactly 24 h: still one group
    expect(sizes(timeGroups([at(60, 61), at(0, 1), at(23, 24)]))).toEqual([2, 1]);
    expect(timeGroups([at(60, 61), at(0, 1)]).map((g) => g[0]?.timeMin)).toEqual([
      at(0, 1).timeMin,
      at(60, 61).timeMin,
    ]);
  });

  test('one input longer than 24 h is a group of its own; inputs with no time share the first group', () => {
    expect(sizes(timeGroups([at(0, 1), at(2, 40), at(41, 42)]))).toEqual([1, 1, 1]);
    const none = { timeMin: null, timeMax: null };
    expect(sizes(timeGroups([at(30, 31), none, at(0, 1), none]))).toEqual([3, 1]);
    expect(sizes(timeGroups([none, none]))).toEqual([2]);
    expect(timeGroups([])).toEqual([]);
  });
});

// -- compaction at close and at merge, bounded in time -----------------------------------------------------------------

const KEY = 'resource:run.id';
const sec = (h: number, extra = 0): string =>
  String(BigInt(EPOCH_NS) + BigInt(h) * HOUR + BigInt(extra) * 1000n);

/** One flush: `count` spans and logs at hour `h` (the last span starts at `lastHour`, so one flush can be long). */
async function flushAt(
  s: Awaited<ReturnType<typeof openSession>>,
  h: number,
  first: number,
  count = 4,
  lastHour = h,
): Promise<void> {
  const spans = Array.from({ length: count }, (_, i) =>
    span({
      traceId: (first + i + 1).toString(16).padStart(32, '0'),
      spanId: (first + i + 1).toString(16).padStart(16, '0'),
      startTimeUnixNano: sec(i === count - 1 ? lastHour : h, i),
      endTimeUnixNano: sec(i === count - 1 ? lastHour : h, i + 1),
    }),
  );
  const resource = [{ key: 'run.id', value: { stringValue: 'run-a' } }];
  await s.add(otlp(traceRequest(spans, resource)), `s-${first}.json`);
  await s.add(
    otlp(
      logsRequest([logRecord({ timeUnixNano: sec(h) }), logRecord({ timeUnixNano: sec(h, 1) })], resource),
    ),
    `l-${first}.json`,
  );
  await s.flush();
}

const reportOf = (w: TestWriter, out: string, hours: readonly number[], close: boolean) =>
  (async () => {
    const s = await openSession(w.deps, {
      out,
      config: testConfig({ writer: { format: 'site', statisticsKeys: [KEY] } }),
      mode: 'replace',
    });
    for (const [i, h] of hours.entries()) await flushAt(s, h, i * 10);
    if (close) await s.close();
    else await s.flush();
  })();

const spanOf = (f: { timeMin: string | null; timeMax: string | null } | undefined): bigint => {
  if (f?.timeMin == null || f.timeMax == null) throw new Error('no time');
  return BigInt(f.timeMax) - BigInt(f.timeMin);
};

describe('compaction at close is bounded in time', () => {
  test('writes one partition per time group and no output spans more than 24 h unless one input does', async () => {
    const w = createTestWriter();
    await reportOf(w, 'r', [0, 2, 30, 60], true);
    const spansFiles = manifestOf(w, 'r').partitions.map((p) => p.files.spans);
    expect(spansFiles).toHaveLength(3);
    for (const f of spansFiles) expect(spanOf(f)).toBeLessThanOrEqual(COMPACTION_SPAN_NS);
    expect(spansFiles.map((f) => f?.rows).sort()).toEqual([4, 4, 8]);
    // a single input longer than 24 h stays one partition
    const w2 = createTestWriter();
    const s = await openSession(w2.deps, {
      out: 'r',
      config: testConfig({ writer: { format: 'site' } }),
      mode: 'replace',
    });
    await flushAt(s, 0, 0);
    await flushAt(s, 2, 10);
    await flushAt(s, 100, 20, 4, 140);
    await s.close();
    const files = manifestOf(w2, 'r').partitions.map((p) => p.files.spans);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f?.rows).sort()).toEqual([4, 8]);
    expect(files.map((f) => String(spanOf(f) > COMPACTION_SPAN_NS)).sort()).toEqual(['false', 'true']);
  });

  test('compactOnMerge still writes per merge input, each split by time group', async () => {
    const w = createTestWriter();
    await reportOf(w, 'a', [0, 1, 30, 31], true);
    await reportOf(w, 'b', [0, 1, 30, 31], true);
    await mergeReports(w.deps, ['a', 'b'], {
      out: 'm',
      config: testConfig({ writer: { format: 'site', statisticsKeys: [KEY], compactOnMerge: true } }),
      mode: 'replace',
    });
    const spansFiles = manifestOf(w, 'm').partitions.map((p) => p.files.spans);
    expect(spansFiles).toHaveLength(4);
    for (const f of spansFiles) expect(spanOf(f)).toBeLessThanOrEqual(COMPACTION_SPAN_NS);
    expect(spansFiles.reduce((n, f) => n + (f?.rows ?? 0), 0)).toBe(32);
  });

  test('rollup rows, statistics and timeEndMax of the outputs equal those of an uncompacted report', async () => {
    const w = createTestWriter();
    await reportOf(w, 'closed', [0, 2, 30, 60], true);
    await reportOf(w, 'open', [0, 2, 30, 60], false);
    const closed = manifestOf(w, 'closed');
    const open = manifestOf(w, 'open');
    expect(closed.partitions.length).toBeLessThan(open.partitions.length);
    const range = (m: typeof closed, table: 'spans' | 'logs' | 'traces') => {
      const files = m.partitions.flatMap((p) => (p.files[table] === undefined ? [] : [p.files[table]]));
      const big = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => x != null).map(BigInt);
      const sorted = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const lo = (xs: bigint[]) => sorted(xs)[0];
      const hi = (xs: bigint[]) => sorted(xs).at(-1);
      return {
        rows: files.reduce((n, f) => n + f.rows, 0),
        min: lo(big(files.map((f) => f.timeMin))),
        max: hi(big(files.map((f) => f.timeMax))),
        end: table === 'logs' ? null : hi(big(files.map((f) => f.timeEndMax))),
        values: [...new Set(files.flatMap((f) => f.values[KEY] ?? []))].sort(),
      };
    };
    for (const t of ['spans', 'logs', 'traces'] as const) expect(range(closed, t), t).toEqual(range(open, t));
    for (const t of ['span_rollups', 'log_rollups'] as const) {
      const sum = (name: string) => {
        const rows = tableRowsOf(w, name, t);
        return canon(addRollupRows(rows, []));
      };
      expect(sum('closed'), t).toEqual(sum('open'));
      expect(sum('open').length, t).toBeGreaterThan(0);
    }
  });
});
