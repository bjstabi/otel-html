import { describe, expect, test } from 'vitest';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { TABLES, type Table } from '../../src/format/parquet/schema.js';
import { PartitionWriter } from '../../src/writer/partition-writer.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const keys = (): Record<Table, string[]> => ({
  spans: ['scope_name'],
  logs: ['scope_name'],
  points: [],
  traces: [],
  patterns: [],
});

function span(i: number, scope: string, start: bigint): Row {
  return {
    trace_id: `t${i}`,
    span_id: `s${i}`,
    name: 'op',
    start_time_unix_nano: start,
    end_time_unix_nano: start + 10n,
    duration_ns: 10n,
    attributes: '{"a":1}',
    scope_name: scope,
    service_name: 'svc',
  };
}

function log(i: number, scope: string): Row {
  return { time_unix_nano: BigInt(i), body: `b${i}`, scope_name: scope, service_name: 'svc' };
}

function make(nextPartition = 0) {
  const fs = createMemoryFileSystem();
  const w = new PartitionWriter(fs, {
    out: '/out',
    rowGroupRows: 50_000,
    statisticsKeys: keys(),
    facetValueCap: 100,
    nextPartition,
  });
  return { fs, w };
}

describe('PartitionWriter', () => {
  test('cut writes one file per held table and returns the entry', async () => {
    const { fs, w } = make();
    w.add('spans', span(2, 'zeta', 200n));
    w.add('spans', span(1, 'alpha', 100n));
    w.add('logs', log(5, 'alpha'));
    expect(w.pendingRows).toBe(3);
    const e = await w.cut('flush:1');
    expect(e?.n).toBe(0);
    expect(e?.source).toBe('flush:1');
    expect(Object.keys(e?.files ?? {}).sort()).toEqual(['logs', 'spans']);
    expect(e?.files.spans?.rows).toBe(2);
    expect(e?.files.spans?.path).toBe('data/partitions/000000/spans.parquet');
    expect(Reflect.get(e?.files.spans?.values ?? {}, 'scope_name')).toEqual(['alpha', 'zeta']);
    expect(e?.files.spans?.bytes).toBe(
      (await fs.readBytes('/out/data/partitions/000000/spans.parquet')).length,
    );
    expect(await fs.exists('/out/data/partitions/000000/logs.parquet')).toBe(true);
    expect(await fs.exists('/out/data/partitions/000000/points.parquet')).toBe(false);
    const rows = decodeTable('spans', await fs.readBytes('/out/data/partitions/000000/spans.parquet'));
    expect(rows.map((r) => Reflect.get(r, 'span_id'))).toEqual(['s1', 's2']);
    expect(w.pendingRows).toBe(0);
    expect(w.pendingBytes).toBe(0);
    expect(w.nextPartition).toBe(1);
  });

  test('a second cut is numbered 000001; an empty cut returns null and writes nothing', async () => {
    const { fs, w } = make(0);
    w.add('logs', log(1, 'a'));
    await w.cut('flush:1');
    expect(await w.cut('flush:2')).toBeNull();
    expect(w.nextPartition).toBe(1);
    w.add('logs', log(2, 'a'));
    const e = await w.cut('flush:3');
    expect(e?.n).toBe(1);
    expect(await fs.exists('/out/data/partitions/000001/logs.parquet')).toBe(true);
    expect(await fs.exists('/out/data/partitions/000002')).toBe(false);
  });

  test('pendingBytes is the string cell lengths plus 64 per row', () => {
    const { w } = make();
    w.add('logs', { time_unix_nano: 1n, body: 'abcd', scope_name: 'xy', service_name: 'svc' });
    expect(w.pendingBytes).toBe(4 + 2 + 3 + 64);
  });

  test('a failed encode keeps the rows held and the partition number', async () => {
    const { fs, w } = make();
    w.add('spans', span(1, 'a', 100n));
    w.add('logs', { time_unix_nano: 'not a bigint', body: 'b', scope_name: 'a', service_name: 'svc' });
    await expect(w.cut('flush:1')).rejects.toThrow();
    expect(w.pendingRows).toBe(2);
    expect(w.nextPartition).toBe(0);
    expect(TABLES.length).toBe(5);
    expect(await fs.exists('/out/data/partitions/000000/spans.parquet')).toBe(false);
  });
});
