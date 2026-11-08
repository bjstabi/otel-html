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
import { TABLE_COLUMNS, type Table } from './columns.js';
import { arrowSchema } from './schema.js';
import { ensureParquetWasm } from './wasm.js';

/**
 * Rows per record batch a reader takes from a file. A merge holds one batch per input file, so this times the merge's
 * fan-out is the reader memory (3.6 M `points` rows, 16 files merged at once: peak 315 MB at 2 048 rows, 373 MB at
 * 8 192). Each batch carries its columns' whole dictionaries through Arrow IPC, so smaller costs a little time.
 */
const READ_BATCH_ROWS = 2_048;

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
export type PanicGuard = <T>(wait: Promise<T>, what?: string) => Promise<T>;

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
      const { done, value } = await guard(reader.read(), path);
      if (done) return;
      const batch: ArrowRecordBatch | undefined = tableFromIPC(value.intoIPCStream()).batches[0];
      if (batch !== undefined && batch.numRows > 0) yield columnsOfBatch(batch, width);
    }
  } finally {
    // Not awaited: after a panic the stream never settles. A free that fails then is not worth hiding the cause.
    try {
      void reader?.cancel().catch(() => undefined);
    } catch {
      // as above
    }
    try {
      file.free();
    } catch {
      // the instance is in an unknown state after a panic
    }
  }
}

/**
 * Writes the batches, in the order given and already sorted, as one ZSTD Parquet file with row groups of
 * `opts.rowGroupRows`, taking them one at a time: the Parquet writer closes a row group when it is full, so the
 * batches need not match the row group size. The file comes out in chunks as the encoder yields them (their
 * concatenation equals `encodeColumns` of the rows in one batch); a failure of `batches` is thrown instead of the
 * last chunk, so a caller that stops at the error never holds a truncated file as complete.
 */
export async function* encodeBatches(
  table: Table,
  batches: AsyncIterable<ColumnBatch>,
  opts: EncodeOptions,
  guard: PanicGuard = unguarded,
): AsyncGenerator<Uint8Array> {
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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = (
      await guard(transformParquetStream(source, writerProperties(opts)))
    ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      const { done, value } = await guard(reader.read());
      if (done) {
        // The writer finishes a valid file from the batches it got when the source fails: that file is truncated.
        if (failure !== undefined) throw failure.error;
        return;
      }
      yield value;
    }
  } catch (error) {
    throw failure === undefined ? error : failure.error;
  } finally {
    // Stopping early (a `return`, or an error) releases the writer and the source. Not awaited: after a panic the
    // stream never settles.
    try {
      void reader?.cancel().catch(() => undefined);
    } catch {
      // as above
    }
  }
}
