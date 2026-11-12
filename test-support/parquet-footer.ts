import { field, readStruct, type TField, type TList } from '../src/format/parquet/thrift.js';

export interface Chunk {
  path: string;
  offset: bigint | undefined;
  length: bigint | undefined;
  rows: number;
}

function fieldValue<T>(fields: readonly TField[], id: number): T {
  const f = field(fields, id);
  if (f === undefined) throw new Error(`no field ${id}`);
  return f.value as T;
}

/** The column chunks of a file, by row group, read from its footer. */
export function chunksOf(file: Uint8Array): Chunk[][] {
  const n = file.length;
  const size = new DataView(file.buffer, file.byteOffset + n - 8, 4).getUint32(0, true);
  const meta = readStruct(file.subarray(n - 8 - size, n - 8));
  const groups = fieldValue<TList>(meta, 4).items as TField[][];
  return groups.map((g) =>
    (fieldValue<TList>(g, 1).items as TField[][]).map((c) => {
      const m = fieldValue<TField[]>(c, 3);
      const path = (fieldValue<TList>(m, 3).items as Uint8Array[]).map((p) => new TextDecoder().decode(p));
      return {
        path: path.join('.'),
        offset: field(m, 14)?.value as bigint | undefined,
        length: field(m, 15)?.value as bigint | undefined,
        rows: Number(field(g, 3)?.value),
      };
    }),
  );
}
