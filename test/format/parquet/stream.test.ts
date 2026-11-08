import '../../../src/writer/parquet-wasm-source.js';
import { Field, Float64, List, Schema } from 'apache-arrow';
import { describe, expect, test } from 'vitest';
import { batchFromRows, type ColumnBatch } from '../../../src/format/parquet/batch.js';
import { decodeTable, encodeTable } from '../../../src/format/parquet/codec.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { arrowSchema } from '../../../src/format/parquet/schema.js';
import { checkSchema, encodeBatches, readColumns } from '../../../src/format/parquet/stream.js';
import { OtelHtmlError } from '../../../src/model/errors.js';

const log = (i: number): Row => ({
  time_unix_nano: BigInt(i),
  body: `"b${i}"`,
  scope_name: 's',
  service_name: 'x',
});
const batch = (from: number, n: number): ColumnBatch =>
  batchFromRows(
    'logs',
    Array.from({ length: n }, (_, i) => log(from + i)),
  );

async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

describe('encodeBatches', () => {
  test('writes the batches as one file', async () => {
    async function* gen() {
      yield batch(0, 3);
      yield batch(3, 2);
    }
    const bytes = await collectBytes(encodeBatches('logs', gen(), { rowGroupRows: 4 }));
    expect(decodeTable('logs', bytes)).toHaveLength(5);
  });

  test('yields the file in chunks that join to the bytes encodeTable writes', async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => log(i));
    async function* gen() {
      yield batchFromRows('logs', rows);
    }
    const chunks: Uint8Array[] = [];
    for await (const c of encodeBatches('logs', gen(), { rowGroupRows: 1_000 })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(encodeTable('logs', rows, { rowGroupRows: 1_000 }));
  });

  test('a source that fails after its first batch rejects with its error, never a truncated file', async () => {
    const boom = new Error('boom');
    async function* gen() {
      yield batch(0, 3);
      throw boom;
    }
    await expect(collectBytes(encodeBatches('logs', gen(), { rowGroupRows: 4 }))).rejects.toBe(boom);
  });

  test('a source that fails before its first batch rejects with its error', async () => {
    const boom = new Error('early');
    // biome-ignore lint/correctness/useYield: it fails before it yields
    async function* gen(): AsyncGenerator<ColumnBatch> {
      throw boom;
    }
    await expect(collectBytes(encodeBatches('logs', gen(), { rowGroupRows: 4 }))).rejects.toBe(boom);
  });
});

describe('readColumns', () => {
  const rows = Array.from({ length: 50 }, (_, i) => log(i));

  test('yields every row, in column arrays', async () => {
    const bytes = encodeTable('logs', rows, { rowGroupRows: 20 });
    let n = 0;
    for await (const cols of readColumns('logs', new Blob([bytes]), 'p', 16)) n += cols[0]?.length ?? 0;
    expect(n).toBe(50);
  });

  test('a file of another table fails invalid-report', async () => {
    const bytes = encodeTable('traces', [{ trace_id: 't', span_count: 1, error_count: 0 }], {
      rowGroupRows: 5,
    });
    const read = async () => {
      for await (const _ of readColumns('logs', new Blob([bytes]), 'p')) void _;
    };
    await expect(read()).rejects.toBeInstanceOf(OtelHtmlError);
  });

  test('checkSchema compares a list item and nullability, not just the type name', () => {
    const want = arrowSchema('points');
    expect(() => checkSchema('points', want, 'p')).not.toThrow();
    const swap = (f: Field): Field =>
      f.name === 'explicit_bounds'
        ? new Field(f.name, new List(new Field('item', new Float64(), false)), f.nullable)
        : f;
    expect(() => checkSchema('points', new Schema(want.fields.map(swap)), 'p')).toThrow(/explicit_bounds/);
    const flip = (f: Field): Field => (f.name === 'metric_name' ? new Field(f.name, f.type, !f.nullable) : f);
    expect(() => checkSchema('points', new Schema(want.fields.map(flip)), 'p')).toThrow(/metric_name/);
  });
});
