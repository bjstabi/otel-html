import '../../../src/writer/parquet-wasm-source.js';
import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../../src/format/parquet/batch.js';
import {
  addBloomFilters,
  addBloomFiltersToBlob,
  BLOOM_MAX_BYTES,
  BLOOM_MIN_BYTES,
  BloomCollector,
  filterBytesFor,
  mightContain,
  xxHash64,
} from '../../../src/format/parquet/bloom.js';
import { decodeTable, encodeColumns, encodeColumnsUnfiltered } from '../../../src/format/parquet/codec.js';
import { TABLE_COLUMNS, TABLES, type Table } from '../../../src/format/parquet/columns.js';
import type { Row } from '../../../src/format/parquet/rows.js';
import { readStruct, T, type TField, writeStruct } from '../../../src/format/parquet/thrift.js';
import { openTestDb } from '../../../test-support/duckdb-node.js';
import { chunksOf } from '../../../test-support/parquet-footer.js';

const TRACE = 'trace_id';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (n: bigint): string => n.toString(16).padStart(16, '0');

describe('xxHash64 (published vectors, seed 0)', () => {
  test.each([
    ['', 'ef46db3751d8e999'],
    ['a', 'd24ec4f1a98c6e5b'],
    ['abc', '44bc2cf5ad770999'],
    ['Nobody inspects the spammish repetition', 'fbcea83c8a378bf1'],
  ])('%j', (input, want) => {
    expect(hex(xxHash64(bytes(input)))).toBe(want);
  });

  test('every length class (under 4, 4 to 7, 8 to 31, 32 and over) is deterministic and distinct', () => {
    const seen = new Set<bigint>();
    for (const n of [1, 3, 4, 7, 8, 15, 31, 32, 33, 64, 100]) seen.add(xxHash64(bytes('z'.repeat(n))));
    expect(seen.size).toBe(11);
  });
});

describe('filterBytesFor', () => {
  test('is the specification size at 1 %: a power of two between one block and 128 MiB', () => {
    expect(filterBytesFor(0)).toBe(BLOOM_MIN_BYTES);
    expect(filterBytesFor(1)).toBe(BLOOM_MIN_BYTES);
    expect(filterBytesFor(20_000)).toBe(32_768); // 193 700 bits needed
    expect(filterBytesFor(50_000)).toBe(65_536); // 484 000 bits needed
    expect(filterBytesFor(1e12)).toBe(BLOOM_MAX_BYTES);
    for (const n of [2, 10, 100, 1_000, 33_333, 300_000]) {
      const b = filterBytesFor(n);
      expect(Number.isInteger(Math.log2(b))).toBe(true);
      expect(b * 8).toBeGreaterThanOrEqual((8 * n) / -Math.log(1 - 0.01 ** (1 / 8)));
    }
  });
});

function cellOf(type: string, i: number): unknown {
  switch (type) {
    case 'utf8':
    case 'json':
      return `v${i % 5}`;
    case 'int32':
      return i;
    case 'int64':
      return BigInt(i);
    case 'float64':
      return i / 2;
    case 'bool':
      return i % 2 === 0;
    case 'list_float64':
      return [i / 2];
    default:
      return [BigInt(i)];
  }
}

const traceId = (i: number): string => i.toString(16).padStart(32, '0');

/** `n` rows of `table` with every column filled; `trace_id` is the row's index in `traceId` form unless `pick` says otherwise. */
function rowsOf(table: Table, n: number, pick: (i: number) => string | null = traceId): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const row: Row = {};
    for (const def of TABLE_COLUMNS[table]) row[def.name] = cellOf(def.type, i);
    row[TRACE] = pick(i);
    return row;
  });
}

const ROW_GROUP_ROWS = 40;

describe('encodeColumns writes a filter on trace_id', () => {
  for (const table of TABLES) {
    const has = table === 'traces' || table === 'logs';
    test(`${table}: ${has ? 'every row group has one, on trace_id only' : 'no column has one'}`, () => {
      const batch = batchFromRows(table, rowsOf(table, 130));
      const groups = chunksOf(encodeColumns(table, batch, { rowGroupRows: ROW_GROUP_ROWS }));
      expect(groups).toHaveLength(4);
      for (const group of groups) {
        for (const c of group) {
          const want = has && c.path === 'trace_id';
          expect(c.offset !== undefined, `${table}.${c.path}`).toBe(want);
          expect(c.length !== undefined, `${table}.${c.path}`).toBe(want);
        }
      }
    });
  }

  test('each filter answers for its own row group: every id of the group is in it, most others are not', () => {
    const file = encodeColumns('logs', batchFromRows('logs', rowsOf('logs', 130)), {
      rowGroupRows: ROW_GROUP_ROWS,
    });
    const groups = chunksOf(file);
    let falsePositives = 0;
    let probes = 0;
    for (const [g, group] of groups.entries()) {
      const c = group.find((x) => x.path === 'trace_id');
      if (c?.offset === undefined || c.length === undefined) throw new Error('no filter');
      const filter = file.subarray(Number(c.offset), Number(c.offset) + Number(c.length));
      // The rows are sorted by the table's key, so read the ids the group holds back from the file.
      const ids = new Set(
        decodeTable('logs', file)
          .slice(g * ROW_GROUP_ROWS, (g + 1) * ROW_GROUP_ROWS)
          .map((r) => r[TRACE] as string),
      );
      for (const id of ids) expect(mightContain(filter, id), id).toBe(true);
      for (let i = 1000; i < 1200; i++) {
        probes++;
        if (mightContain(filter, traceId(i))) falsePositives++;
      }
    }
    expect(falsePositives / probes).toBeLessThan(0.05);
  });

  test('filters sit between the last row group and the footer; the rows read back unchanged', () => {
    const batch = batchFromRows(
      'logs',
      rowsOf('logs', 130, (i) => (i % 7 === 0 ? null : traceId(i))),
    );
    const plain = encodeColumnsUnfiltered('logs', batch, { rowGroupRows: ROW_GROUP_ROWS });
    const filtered = encodeColumns('logs', batch, { rowGroupRows: ROW_GROUP_ROWS });
    expect(filtered.length).toBeGreaterThan(plain.length);
    expect(decodeTable('logs', filtered)).toEqual(decodeTable('logs', plain));
    const first = chunksOf(filtered)[0]?.find((c) => c.path === 'trace_id');
    expect(Number(first?.offset)).toBeGreaterThan(0);
    expect(Number(first?.offset) + Number(first?.length)).toBeLessThanOrEqual(filtered.length);
    // The original file's row group bytes are untouched: the filtered file starts with them.
    const plainFooter = new DataView(plain.buffer, plain.byteOffset + plain.length - 8, 4).getUint32(0, true);
    const dataEnd = plain.length - 8 - plainFooter;
    expect(filtered.subarray(0, dataEnd)).toEqual(plain.subarray(0, dataEnd));
  });

  test('a file with no rows stays valid and has no filter', () => {
    const file = encodeColumns('logs', batchFromRows('logs', []), { rowGroupRows: ROW_GROUP_ROWS });
    expect(chunksOf(file)).toEqual([]);
    expect(decodeTable('logs', file)).toEqual([]);
  });

  test('a spans file carries no filter', () => {
    const file = encodeColumns('spans', batchFromRows('spans', rowsOf('spans', 130)), {
      rowGroupRows: ROW_GROUP_ROWS,
    });
    const chunks = chunksOf(file).flat();
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.offset === undefined && c.length === undefined)).toBe(true);
  });
});

describe('the footer round trip', () => {
  test.each(['traces', 'logs', 'points'] as const)(
    '%s: parquet-wasm footers read and write back byte for byte',
    (table) => {
      const file = encodeColumnsUnfiltered(table, batchFromRows(table, rowsOf(table, 130)), {
        rowGroupRows: ROW_GROUP_ROWS,
      });
      const n = file.length;
      const size = new DataView(file.buffer, file.byteOffset + n - 8, 4).getUint32(0, true);
      const footer = file.subarray(n - 8 - size, n - 8);
      expect(writeStruct(readStruct(footer))).toEqual(footer);
    },
  );

  test('integers beyond 32 bits and a field id gap above 15 survive', () => {
    const fields: TField[] = [
      { id: 1, type: T.I64, value: 2n ** 62n },
      { id: 40, type: T.I32, value: -7n },
      { id: 41, type: T.Binary, value: bytes('x') },
      {
        id: 42,
        type: T.List,
        value: { elem: T.Struct, items: [[{ id: 1, type: T.True, value: true }], []] },
      },
    ];
    expect(readStruct(writeStruct(fields))).toEqual(fields);
  });
});

describe('addBloomFilters', () => {
  const batch = batchFromRows('logs', rowsOf('logs', 130));
  const plain = encodeColumnsUnfiltered('logs', batch, { rowGroupRows: ROW_GROUP_ROWS });
  const collect = (): ReturnType<BloomCollector['finish']> => {
    const c = new BloomCollector(ROW_GROUP_ROWS);
    // encodeColumns writes the rows in the table's sort order; the ids here sort the same way as the rows.
    c.add(decodeTable('logs', plain).map((r) => r[TRACE]));
    return c.finish();
  };

  test('the Blob form yields the same bytes as the in-memory form', async () => {
    const groups = collect();
    const parts: Uint8Array[] = [];
    for await (const p of addBloomFiltersToBlob(new Blob([plain as Uint8Array<ArrayBuffer>]), groups))
      parts.push(p);
    expect(new Uint8Array(Buffer.concat(parts))).toEqual(addBloomFilters(plain, groups));
  });

  test('a group count or row count that does not match the file throws', () => {
    const groups = collect();
    expect(() => addBloomFilters(plain, groups.slice(1))).toThrow(/row groups/);
    const first = groups[0];
    if (first === undefined) throw new Error('no group');
    expect(() => addBloomFilters(plain, [{ ...first, rows: first.rows + 1 }, ...groups.slice(1)])).toThrow(
      /rows/,
    );
  });

  test('a collector that saw no rows has no groups; null-only rows give a filter that matches nothing', () => {
    expect(new BloomCollector(ROW_GROUP_ROWS).finish()).toEqual([]);
    const c = new BloomCollector(ROW_GROUP_ROWS);
    c.add([null, null, undefined]);
    const [only, ...rest] = c.finish();
    expect(rest).toEqual([]);
    expect(only?.rows).toBe(3);
    expect(mightContain(only?.filter ?? new Uint8Array(), traceId(1))).toBe(false);
  });

  test('a single distinct id repeated across the group gets a minimum-size filter that contains it', () => {
    const c = new BloomCollector(ROW_GROUP_ROWS);
    c.add(Array.from({ length: ROW_GROUP_ROWS }, () => traceId(7)));
    const filter = c.finish()[0]?.filter ?? new Uint8Array();
    expect(mightContain(filter, traceId(7))).toBe(true);
    expect(mightContain(filter, traceId(8))).toBe(false);
    // A header under 32 bytes plus one 32-byte block.
    expect(filter.length).toBeGreaterThan(BLOOM_MIN_BYTES);
    expect(filter.length).toBeLessThan(2 * BLOOM_MIN_BYTES);
  });

  test('the size steps up at the capacity of a size and stops at the maximum', () => {
    let n = 1;
    while (filterBytesFor(n) === BLOOM_MIN_BYTES) n++;
    expect(filterBytesFor(n - 1)).toBe(BLOOM_MIN_BYTES);
    expect(filterBytesFor(n)).toBe(BLOOM_MIN_BYTES * 2);
    expect(filterBytesFor(Number.MAX_SAFE_INTEGER)).toBe(BLOOM_MAX_BYTES);
    expect(filterBytesFor(Number.POSITIVE_INFINITY)).toBe(BLOOM_MAX_BYTES);
  });

  test('a footer without key-value metadata still gets its filters', () => {
    const n = plain.length;
    const size = new DataView(plain.buffer, plain.byteOffset + n - 8, 4).getUint32(0, true);
    const meta = readStruct(plain.subarray(n - 8 - size, n - 8)).filter((f) => f.id !== 5);
    const body = writeStruct(meta);
    const stripped = new Uint8Array(n - 8 - size + body.length + 8);
    stripped.set(plain.subarray(0, n - 8 - size));
    stripped.set(body, n - 8 - size);
    new DataView(stripped.buffer).setUint32(stripped.length - 8, body.length, true);
    stripped.set(bytes('PAR1'), stripped.length - 4);
    expect(readStruct(body).some((f) => f.id === 5)).toBe(false);
    const done = addBloomFilters(stripped, collect());
    expect(
      chunksOf(done)
        .flat()
        .filter((c) => c.path === TRACE)
        .every((c) => c.offset !== undefined),
    ).toBe(true);
    expect(decodeTable('logs', done)).toEqual(decodeTable('logs', plain));
  });

  test('the collector cuts groups at the row group size and counts null cells as rows', () => {
    const c = new BloomCollector(3);
    c.add(['a', null, 'b', 'c', 'c', undefined, 'd']);
    expect(c.finish().map((g) => g.rows)).toEqual([3, 3, 1]);
  });
});

describe('a format-4 file without filters', () => {
  test('still decodes', () => {
    const plain = encodeColumnsUnfiltered('traces', batchFromRows('traces', rowsOf('traces', 50)), {
      rowGroupRows: ROW_GROUP_ROWS,
    });
    expect(decodeTable('traces', plain)).toHaveLength(50);
    expect(
      chunksOf(plain)
        .flat()
        .every((c) => c.offset === undefined),
    ).toBe(true);
  });
});

// The unit tests above use this module's own `mightContain`. DuckDB applies the filter on an equality lookup, so a
// wrong hash, salt or offset makes it skip the row group that holds the id and lose rows: an independent reader.
describe('DuckDB-WASM honours the filters', () => {
  const ROWS = 6_000;
  const GROUP = 1_000;
  /** Well mixed 32-hex ids, so every group's min/max statistics overlap and only the filter can tell them apart. */
  const mixed = (i: number): string =>
    [1, 2, 3, 4]
      .map((k) => (Math.imul(i + 1, 0x9e3779b1 + k * 2) >>> 0).toString(16).padStart(8, '0'))
      .join('');

  const counts = (rows: Record<string, unknown>[]): number => (rows as { n: number }[])[0]?.n ?? -1;

  test.each(['traces', 'logs'] as const)(
    '%s: every sampled stored id is found, across all row groups; parquet-wasm reads the same rows',
    async (table) => {
      const rows = rowsOf(table, ROWS, mixed);
      const batch = batchFromRows(table, rows);
      const file = encodeColumns(table, batch, { rowGroupRows: GROUP });
      const groups = chunksOf(file);
      expect(groups).toHaveLength(ROWS / GROUP);
      expect(groups.every((g) => g.some((c) => c.path === TRACE && c.offset !== undefined))).toBe(true);
      // The second reader: parquet-wasm's own decode of the filtered file equals that of the plain one.
      const plain = encodeColumnsUnfiltered(table, batch, { rowGroupRows: GROUP });
      expect(decodeTable(table, file)).toEqual(decodeTable(table, plain));

      const stored = decodeTable(table, file).map((r) => r[TRACE] as string);
      expect(new Set(stored).size).toBe(ROWS);
      const sample = stored.filter((_, i) => i % 12 === 0); // 500 ids, spread over every row group
      expect(sample).toHaveLength(ROWS / 12);
      const db = await openTestDb();
      try {
        db.registerFile(`${table}.parquet`, file);
        for (const id of sample) {
          const got = counts(
            db.rows(
              `SELECT count(*)::INT AS n FROM read_parquet('${table}.parquet') WHERE trace_id = '${id}'`,
            ),
          );
          expect(got, id).toBe(1);
        }
        const absent = counts(
          db.rows(
            `SELECT count(*)::INT AS n FROM read_parquet('${table}.parquet') WHERE trace_id = '${'0'.repeat(32)}'`,
          ),
        );
        expect(absent).toBe(0);
      } finally {
        db.close();
      }
    },
    120_000,
  );
});
