import {
  type RecordBatch as ArrowRecordBatch,
  type Schema as ArrowSchema,
  tableFromIPC,
  tableToIPC,
} from 'apache-arrow';
import {
  ParquetFile,
  transformParquetStream,
  type RecordBatch as WasmRecordBatch,
  Table as WasmTable,
} from 'parquet-wasm/esm';
import { OtelHtmlError } from '../../model/errors.js';
import type { ColumnBatch } from './batch.js';
import { columnsOfBatch, columnsToArrow, type EncodeOptions, writerProperties } from './codec.js';
import { arrowSchema, TABLE_COLUMNS, type Table } from './schema.js';
import { ensureParquetWasm } from './wasm.js';

/** Rows per record batch a reader takes from a file. Larger is better: each batch carries its columns' whole dictionaries through Arrow IPC, and many small batches of a big row group made garbage that raised the peak (measured). */
const READ_BATCH_ROWS = 32_768;

interface FieldLike {
  name: string;
  type: { toString(): string; children?: readonly FieldLike[] };
  nullable: boolean;
}

/** A field as text: name, type with the names, types and nullability of its children (a list's item), nullability. */
function show(f: FieldLike | undefined): string {
  if (f === undefined) return 'no column';
  const kids = f.type.children ?? [];
  const inner = kids.length === 0 ? '' : `[${kids.map(show).join(',')}]`;
  return `${f.name}:${f.type.toString()}${inner}${f.nullable ? '?' : ''}`;
}

/**
 * Wraps a wasm-backed wait so a panic inside parquet-wasm (which it does not report through the stream, see
 * `src/writer/wasm-panic.ts`) rejects it. The default waits for the promise as it is.
 */
export type PanicGuard = <T>(wait: Promise<T>) => Promise<T>;

const unguarded: PanicGuard = (wait) => wait;

/** Throws `invalid-report` unless `actual` has exactly the columns, types and nullability `arrowSchema(table)` has. */
export function checkSchema(table: Table, actual: ArrowSchema, path: string): void {
  const want = arrowSchema(table).fields;
  const got = actual.fields;
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    const w = want[i];
    const g = got[i];
    if (w === undefined || g === undefined || show(w) !== show(g)) {
      throw new OtelHtmlError('invalid-report', {
        path,
        expected: `the ${table} columns (column ${i}: ${show(w)})`,
        actual: `column ${i}: ${show(g)}`,
      });
    }
  }
}

/**
 * The rows of a Parquet file as column arrays, one array set per record batch of `batchRows` rows, read from `blob`
 * as it goes: only the row group being read is fetched, and only one batch is decoded at a time. The file's schema is
 * checked against `arrowSchema(table)` before the first batch, so a foreign or old file fails `invalid-report`.
 * `path` names the file in errors. Stopping early (a `return`) releases the file.
 */
export async function* readColumns(
  table: Table,
  blob: Blob,
  path: string,
  batchRows: number = READ_BATCH_ROWS,
  guard: PanicGuard = unguarded,
): AsyncGenerator<unknown[][]> {
  ensureParquetWasm();
  const width = TABLE_COLUMNS[table].length;
  let file: ParquetFile;
  try {
    file = await ParquetFile.fromFile(blob);
  } catch (e) {
    throw new OtelHtmlError('invalid-report', {
      path,
      expected: 'a Parquet file',
      actual: e instanceof Error ? e.message : String(e),
    });
  }
  let reader: ReadableStreamDefaultReader<WasmRecordBatch> | undefined;
  try {
    checkSchema(table, tableFromIPC(file.schema().intoIPCStream()).schema, path);
    reader = (
      await file.stream({ batchSize: batchRows })
    ).getReader() as ReadableStreamDefaultReader<WasmRecordBatch>;
    for (;;) {
      const { done, value } = await guard(reader.read());
      if (done) return;
      const batch: ArrowRecordBatch | undefined = tableFromIPC(value.intoIPCStream()).batches[0];
      if (batch !== undefined && batch.numRows > 0) yield columnsOfBatch(batch, width);
    }
  } finally {
    // Not awaited: after a panic the stream never settles. A free that fails then is not worth hiding the cause.
    void reader?.cancel().catch(() => undefined);
    try {
      file.free();
    } catch {
      // the instance is in an unknown state after a panic
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Writes the batches, in the order given and already sorted, as one ZSTD Parquet file with row groups of
 * `opts.rowGroupRows`, taking them one at a time: the Parquet writer closes a row group when it is full, so the
 * batches need not match the row group size. The bytes equal `encodeColumns` of the rows in one batch.
 */
export async function encodeBatches(
  table: Table,
  batches: AsyncIterable<ColumnBatch>,
  opts: EncodeOptions,
  guard: PanicGuard = unguarded,
): Promise<Uint8Array> {
  ensureParquetWasm();
  const it = batches[Symbol.asyncIterator]();
  // An error from `batches` reaches the writer as a stream error, which parquet-wasm reports as "Dyn casting error".
  let failure: { error: unknown } | undefined;
  const source = new ReadableStream<WasmRecordBatch>({
    async pull(controller) {
      try {
        const next = await it.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        const identity = Array.from({ length: next.value.length }, (_, i) => i);
        const wasm = WasmTable.fromIPCStream(
          tableToIPC(columnsToArrow(table, next.value, identity), 'stream'),
        );
        try {
          for (const b of wasm.recordBatches()) controller.enqueue(b);
        } finally {
          wasm.free(); // wasm memory is not garbage collected promptly: free what we are done with
        }
      } catch (error) {
        failure = { error };
        throw error;
      }
    },
    async cancel() {
      await it.return?.();
    },
  });
  const parts: Uint8Array[] = [];
  try {
    const reader = (
      await guard(transformParquetStream(source, writerProperties(opts)))
    ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      const { done, value } = await guard(reader.read());
      if (done) {
        // The writer finishes a valid file from the batches it got when the source fails: that file is truncated.
        if (failure !== undefined) throw failure.error;
        return concat(parts);
      }
      parts.push(value);
    }
  } catch (error) {
    throw failure === undefined ? error : failure.error;
  }
}
