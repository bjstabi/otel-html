import { describe, expect, test } from 'vitest';
import type { PartitionEntry } from '../../src/format/manifest.js';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import { decodeTable, encodeTable } from '../../src/format/parquet/codec.js';
import type { Row } from '../../src/format/parquet/rows.js';
import type { Table } from '../../src/format/parquet/schema.js';
import { fileStatistics } from '../../src/format/parquet/stats.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { compactPartitions } from '../../src/writer/compaction.js';
import { PartitionWriter } from '../../src/writer/partition-writer.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const OUT = '/out';
const ROW_GROUP = 5;
const KEYS: Record<Table, string[]> = {
  spans: ['scope_name', 'service_name'],
  logs: ['scope_name', 'service_name', 'attr:k'],
  points: ['metric_name'],
  traces: [],
  patterns: [],
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
  fs: ReturnType<typeof createMemoryFileSystem>,
  parts: readonly Partial<Record<Table, Row[]>>[],
  rowGroupRows = ROW_GROUP,
): Promise<PartitionEntry[]> {
  const w = new PartitionWriter(fs, {
    out: OUT,
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

const opts = (nextPartition: number, rowGroupRows = ROW_GROUP) => ({
  nextPartition,
  rowGroupRows,
  statisticsKeys: KEYS,
  facetValueCap: 100,
  source: `compact:0..${nextPartition - 1}`,
});

async function bytesOf(fs: ReturnType<typeof createMemoryFileSystem>, entry: PartitionEntry, t: Table) {
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
      expect(Object.keys(out.files)).toEqual([table]);
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
        'logs.parquet',
      ]);
      const { path, bytes, ...stats } = out.files.logs ?? { path: '', bytes: 0 };
      expect(stats).toEqual(fileStatistics('logs', batchFromRows('logs', rowsPer.flat()), KEYS.logs, 100));
    },
  );

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

  test('a key unknown (null) in any input stays unknown', async () => {
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
    first.values = { ...first.values, 'attr:k': null };
    const out = await compactPartitions(fs, OUT, entries, opts(2));
    expect(out.files.logs?.values['attr:k']).toBeNull();
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
    expect(Object.keys(out.files).sort()).toEqual(['logs', 'spans']);
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
    expect(await fs.list(`${OUT}/data/partitions/000002`)).toEqual(['logs.parquet', 'spans.parquet']);
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
