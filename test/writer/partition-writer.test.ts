import { describe, expect, test } from 'vitest';
import { decodeTable } from '../../src/format/parquet/codec.js';
import type { Row } from '../../src/format/parquet/rows.js';
import type { Table } from '../../src/format/parquet/schema.js';
import { PartitionWriter, type PartitionWriterOptions } from '../../src/writer/partition-writer.js';
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

function make(nextPartition = 0, derive?: PartitionWriterOptions['derive']) {
  const fs = createMemoryFileSystem();
  const w = new PartitionWriter(fs, {
    out: '/out',
    rowGroupRows: 50_000,
    statisticsKeys: keys(),
    facetValueCap: 100,
    nextPartition,
    ...(derive === undefined ? {} : { derive }),
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

  test('pendingBytes counts 8 bytes per list element on top of the strings and the row overhead', () => {
    const { w } = make();
    w.add('points', { metric_name: 'm', explicit_bounds: [1, 2, 3], bucket_counts: [1n, 2n, 3n, 4n] });
    expect(w.pendingBytes).toBe(1 + 64 + 8 * 7);
  });

  test('a failed encode keeps the rows held and the partition number', async () => {
    const { fs, w } = make(0, () => ({ rows: { traces: [{ trace_id: 5 }] } }));
    w.add('spans', span(1, 'a', 100n));
    w.add('logs', log(1, 'a'));
    await expect(w.cut('flush:1')).rejects.toThrow();
    expect(w.pendingRows).toBe(2);
    expect(w.nextPartition).toBe(0);
    expect(await fs.exists('/out/data/partitions/000000/spans.parquet')).toBe(false);
  });

  test('rows added while a cut is writing land in the next partition', async () => {
    const { fs, w } = make();
    w.add('spans', span(1, 'a', 100n));
    const gate = fs.holdNextWrite('000000/spans.parquet');
    const cut = w.cut('flush:1');
    await gate.reached;
    expect(w.pendingRows).toBe(0);
    w.add('spans', span(2, 'a', 200n));
    expect(w.pendingRows).toBe(1);
    gate.release();
    const first = await cut;
    expect(first?.files.spans?.rows).toBe(1);
    expect(w.pendingRows).toBe(1);
    const second = await w.cut('flush:2');
    expect(second?.n).toBe(1);
    const rows = decodeTable('spans', await fs.readBytes('/out/data/partitions/000001/spans.parquet'));
    expect(rows.map((r) => Reflect.get(r, 'span_id'))).toEqual(['s2']);
  });

  test('a write failure puts the taken rows back in front and a retry numbers the partition the same', async () => {
    const { fs, w } = make();
    // Equal sort keys, so the output order is the order the rows were held in.
    w.add('spans', span(1, 'a', 100n));
    w.add('logs', log(1, 'a'));
    fs.failNextWrite('000000/logs.parquet');
    const gate = fs.holdNextWrite('000000/spans.parquet');
    const cut = w.cut('flush:1');
    const failed = cut.catch((e: unknown) => e);
    await gate.reached;
    w.add('spans', span(2, 'a', 100n));
    gate.release();
    expect(await failed).toBeInstanceOf(Error);
    expect(w.pendingRows).toBe(3);
    expect(w.nextPartition).toBe(0);
    const e = await w.cut('flush:1');
    expect(e?.n).toBe(0);
    expect(e?.files.spans?.rows).toBe(2);
    const rows = decodeTable('spans', await fs.readBytes('/out/data/partitions/000000/spans.parquet'));
    expect(rows.map((r) => Reflect.get(r, 'span_id'))).toEqual(['s1', 's2']);
  });

  describe('the derive hook', () => {
    const trace = (id: string): Row => ({
      trace_id: id,
      start_time_unix_nano: 7n,
      end_time_unix_nano: 9n,
      span_count: 1,
      error_count: 0,
      log_count: 0,
    });

    test('derived rows are written with their own file statistics', async () => {
      const { fs, w } = make(0, () => ({ rows: { traces: [trace('a'), trace('b')] } }));
      w.add('spans', span(1, 'a', 100n));
      const e = await w.cut('flush:1');
      expect(e?.files.traces).toMatchObject({ rows: 2, timeMin: '7', timeMax: '7' });
      expect(await fs.exists('/out/data/partitions/000000/traces.parquet')).toBe(true);
    });

    test('commit runs once after the writes, and not when a write fails', async () => {
      let commits = 0;
      const { fs, w } = make(0, () => ({ rows: { traces: [trace('a')] }, commit: () => void commits++ }));
      w.add('spans', span(1, 'a', 100n));
      fs.failNextWrite('000000/traces.parquet');
      await expect(w.cut('flush:1')).rejects.toThrow();
      expect(commits).toBe(0);
      expect(w.pendingRows).toBe(1);
      await w.cut('flush:1');
      expect(commits).toBe(1);
    });

    test('a throw from derive restores the taken rows and writes nothing', async () => {
      let fail = true;
      const { fs, w } = make(0, () => {
        if (fail) throw new Error('derive failed');
        return { rows: {} };
      });
      w.add('spans', span(1, 'a', 100n));
      await expect(w.cut('flush:1')).rejects.toThrow('derive failed');
      expect(w.pendingRows).toBe(1);
      expect(w.nextPartition).toBe(0);
      expect(await fs.exists('/out/data/partitions/000000/spans.parquet')).toBe(false);
      fail = false;
      expect((await w.cut('flush:1'))?.files.spans?.rows).toBe(1);
    });

    test('a throwing commit leaves nextPartition unchanged and the rows held', async () => {
      const { w } = make(0, () => ({
        rows: {},
        commit: () => {
          throw new Error('commit failed');
        },
      }));
      w.add('spans', span(1, 'a', 100n));
      await expect(w.cut('flush:1')).rejects.toThrow('commit failed');
      expect(w.nextPartition).toBe(0);
      expect(w.pendingRows).toBe(1);
    });

    test('a derived row the codec cannot store fails the cut; the held rows come back in order', async () => {
      let bad = true;
      const { fs, w } = make(0, () => ({
        rows: { traces: [bad ? { ...trace('a'), span_count: 'x' } : trace('a')] },
      }));
      w.add('spans', span(2, 'a', 100n)); // equal sort keys: the output order is the held order
      await expect(w.cut('flush:1')).rejects.toThrow();
      w.add('spans', span(1, 'a', 100n));
      expect(w.pendingRows).toBe(2);
      bad = false;
      const e = await w.cut('flush:1');
      expect(e?.files.spans?.rows).toBe(2);
      const rows = decodeTable('spans', await fs.readBytes('/out/data/partitions/000000/spans.parquet'));
      expect(rows.map((r) => Reflect.get(r, 'trace_id'))).toEqual(['t2', 't1']);
    });

    test('a derived row with a column outside the table fails the cut instead of dropping the cell', async () => {
      const { fs, w } = make(0, () => ({ rows: { traces: [{ ...trace('a'), span_cuont: 1 }] } }));
      w.add('spans', span(1, 'a', 100n));
      await expect(w.cut('flush:1')).rejects.toThrow(/unknown column/);
      expect(w.pendingRows).toBe(1);
      expect(w.nextPartition).toBe(0);
      expect(await fs.exists('/out/data/partitions/000000/traces.parquet')).toBe(false);
    });
  });
});

describe('PartitionWriter overlapping cuts', () => {
  test('a cut while another is writing throws, and neither the first nor the next cut is harmed', async () => {
    const { fs, w } = make();
    w.add('spans', span(1, 'a', 100n));
    const gate = fs.holdNextWrite('000000/spans.parquet');
    const first = w.cut('flush:1');
    await gate.reached;
    w.add('spans', span(2, 'a', 200n));
    await expect(w.cut('flush:2')).rejects.toThrow(/in progress/);
    expect(w.pendingRows).toBe(1);
    gate.release();
    expect((await first)?.n).toBe(0);
    expect((await w.cut('flush:2'))?.n).toBe(1);
  });
});
