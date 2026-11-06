import { describe, expect, test } from 'vitest';
import { batchFromRows, type ColumnBatch, concatBatches } from '../../../src/format/parquet/batch.js';

const col = (b: ColumnBatch, name: string): readonly unknown[] | undefined => b.cells[name];

describe('ColumnBatch', () => {
  test('rows become one array per column, null for a missing cell, in table column order', () => {
    const b = batchFromRows('logs', [{ body: 'a', time_unix_nano: 5n }, { body: 'b' }]);
    expect(b.length).toBe(2);
    expect(col(b, 'body')).toEqual(['a', 'b']);
    expect(col(b, 'time_unix_nano')).toEqual([5n, null]);
    expect(col(b, 'severity_number')).toEqual([null, null]);
  });

  test('unknown keys are not copied', () => {
    const b = batchFromRows('logs', [{ body: 'a', bogus: 1 }]);
    expect(Object.keys(b.cells)).not.toContain('bogus');
  });

  test('concat puts the first batch before the second and leaves both untouched', () => {
    const a = batchFromRows('logs', [{ body: 'a' }]);
    const b = batchFromRows('logs', [{ body: 'b' }, { body: 'c' }]);
    const c = concatBatches('logs', a, b);
    expect(c.length).toBe(3);
    expect(col(c, 'body')).toEqual(['a', 'b', 'c']);
    expect(col(a, 'body')).toEqual(['a']);
    expect(col(b, 'body')).toEqual(['b', 'c']);
  });

  test('concatenating with an empty batch is the identity', () => {
    const a = batchFromRows('logs', [{ body: 'a', time_unix_nano: 1n }]);
    const empty = batchFromRows('logs', []);
    expect(col(concatBatches('logs', empty, a), 'body')).toEqual(['a']);
    expect(col(concatBatches('logs', a, empty), 'time_unix_nano')).toEqual([1n]);
  });
});
