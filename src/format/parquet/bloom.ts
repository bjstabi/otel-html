import type { Table } from './columns.js';
import { field, readStruct, T, type TField, type TList, writeStruct } from './thrift.js';

/**
 * Parquet split-block bloom filters on `trace_id`, added to a file after parquet-wasm wrote it. parquet-wasm 0.9.0
 * links arrow-rs's filter writer but exposes no property to switch it on, so this module appends the filters the
 * Parquet specification describes (xxHash64 of the value's bytes, 32-byte blocks of eight 32-bit words) between the
 * last row group and the footer, and gives each `trace_id` column chunk its `bloom_filter_offset` and
 * `bloom_filter_length`. DuckDB reads them: an `=` on `trace_id` skips a row group whose filter lacks the value
 * without reading any of its pages. A file without filters stays valid and answers as before.
 */

/** The tables whose files carry the filter, and the one column it covers. */
export const BLOOM_TABLES: ReadonlySet<Table> = new Set<Table>(['traces', 'spans', 'logs']);
export const BLOOM_COLUMN = 'trace_id';

/** The false-positive rate each row group's filter is sized for. */
const BLOOM_FPP = 0.01;
/** The specification's bounds on a filter: one block, and 128 MiB. */
export const BLOOM_MIN_BYTES = 32;
export const BLOOM_MAX_BYTES: number = 128 * 1024 * 1024;

// -- xxHash64 (seed 0) --------------------------------------------------------------------------------------------

const MASK = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK;

function word64(b: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k] ?? 0);
  return v;
}

function word32(b: Uint8Array, i: number): bigint {
  return BigInt(
    ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0,
  );
}

const round = (acc: bigint, input: bigint): bigint => (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK;
const mergeRound = (acc: bigint, v: bigint): bigint => ((acc ^ round(0n, v)) * P1 + P4) & MASK;

/** XXH64 of `b` with seed 0, as the Parquet bloom filter specification requires. */
export function xxHash64(b: Uint8Array): bigint {
  const n = b.length;
  let i = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = (P1 + P2) & MASK;
    let v2 = P2;
    let v3 = 0n;
    let v4 = -P1 & MASK;
    for (; i <= n - 32; i += 32) {
      v1 = round(v1, word64(b, i));
      v2 = round(v2, word64(b, i + 8));
      v3 = round(v3, word64(b, i + 16));
      v4 = round(v4, word64(b, i + 24));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    h = mergeRound(mergeRound(mergeRound(mergeRound(h, v1), v2), v3), v4);
  } else h = P5;
  h = (h + BigInt(n)) & MASK;
  for (; i + 8 <= n; i += 8) h = (rotl(h ^ round(0n, word64(b, i)), 27n) * P1 + P4) & MASK;
  if (i + 4 <= n) {
    h = (rotl(h ^ ((word32(b, i) * P1) & MASK), 23n) * P2 + P3) & MASK;
    i += 4;
  }
  for (; i < n; i++) h = (rotl(h ^ ((BigInt(b[i] ?? 0) * P5) & MASK), 11n) * P1) & MASK;
  h ^= h >> 33n;
  h = (h * P2) & MASK;
  h ^= h >> 29n;
  h = (h * P3) & MASK;
  return h ^ (h >> 32n);
}

// -- split-block filter -------------------------------------------------------------------------------------------

const SALT = [0x47b6137b, 0x44974d91, 0x8824ad5b, 0xa2b7289d, 0x705495c7, 0x2df1424b, 0x9efc4947, 0x5c6bfb31];
const encoder = new TextEncoder();

/**
 * Bytes of the filter for `distinct` values at `BLOOM_FPP`: the specification's `-8n / ln(1 - fpp^(1/8))` bits, rounded
 * up to a power of two bytes, within [`BLOOM_MIN_BYTES`, `BLOOM_MAX_BYTES`].
 */
export function filterBytesFor(distinct: number): number {
  const bits = distinct <= 0 ? 0 : (-8 * distinct) / Math.log(1 - BLOOM_FPP ** (1 / 8));
  let bytes = BLOOM_MIN_BYTES;
  while (bytes * 8 < bits && bytes < BLOOM_MAX_BYTES) bytes *= 2;
  return bytes;
}

function positions(hash: bigint, blocks: number): { block: number; key: number } {
  return { block: Number(((hash >> 32n) * BigInt(blocks)) >> 32n), key: Number(hash & 0xffffffffn) };
}

/** The bitset of a filter of `numBytes` over the hashes. */
function bitset(hashes: Iterable<bigint>, numBytes: number): Uint8Array {
  const words = new Uint32Array(numBytes / 4);
  for (const hash of hashes) {
    const { block, key } = positions(hash, numBytes / 32);
    for (const [i, salt] of SALT.entries()) {
      const at = block * 8 + i;
      words[at] = (words[at] ?? 0) | (1 << (Math.imul(key, salt) >>> 27));
    }
  }
  return new Uint8Array(words.buffer, words.byteOffset, numBytes);
}

/** `BloomFilterHeader`: numBytes, algorithm BLOCK, hash XXHASH, compression UNCOMPRESSED. */
function header(numBytes: number): Uint8Array {
  const choice = (): TField => ({ id: 1, type: T.Struct, value: [] });
  return writeStruct([
    { id: 1, type: T.I32, value: BigInt(numBytes) },
    { id: 2, type: T.Struct, value: [choice()] },
    { id: 3, type: T.Struct, value: [choice()] },
    { id: 4, type: T.Struct, value: [choice()] },
  ]);
}

/** A complete filter (header and bitset) over the distinct values, sized for them. */
function buildFilter(values: ReadonlySet<string>): Uint8Array {
  const numBytes = filterBytesFor(values.size);
  const hashes = function* () {
    for (const v of values) yield xxHash64(encoder.encode(v));
  };
  const head = header(numBytes);
  const out = new Uint8Array(head.length + numBytes);
  out.set(head);
  out.set(bitset(hashes(), numBytes), head.length);
  return out;
}

/**
 * Whether a filter built by this module (header and bitset, as `BloomGroup.filter` holds it) may contain `value`; false
 * means it does not. The bitset is the filter's last `numBytes`, the power of two a header of under 32 bytes leaves.
 */
export function mightContain(filter: Uint8Array, value: string): boolean {
  const numBytes = 2 ** Math.floor(Math.log2(filter.length));
  const words = new Uint32Array(filter.slice(filter.length - numBytes).buffer);
  const { block, key } = positions(xxHash64(encoder.encode(value)), numBytes / 32);
  return SALT.every((salt, i) => (((words[block * 8 + i] ?? 0) >>> (Math.imul(key, salt) >>> 27)) & 1) === 1);
}

// -- collecting the filters of a file -----------------------------------------------------------------------------

/** One row group's filter (header and bitset) and the rows it covers. */
export interface BloomGroup {
  readonly rows: number;
  readonly filter: Uint8Array;
}

/**
 * Takes the `trace_id` cells of a file's rows in file order and cuts them into row groups of `rowGroupRows` (the
 * writer closes a row group at exactly that many rows), building each group's filter when it closes. Null cells are
 * not in the filter: no `=` matches them.
 */
export class BloomCollector {
  readonly #groups: BloomGroup[] = [];
  #open = new Set<string>();
  #rows = 0;

  constructor(readonly rowGroupRows: number) {}

  add(cells: Iterable<unknown>): void {
    for (const cell of cells) {
      if (typeof cell === 'string') this.#open.add(cell);
      this.#rows++;
      if (this.#rows === this.rowGroupRows) this.#close();
    }
  }

  #close(): void {
    this.#groups.push({ rows: this.#rows, filter: buildFilter(this.#open) });
    this.#open = new Set();
    this.#rows = 0;
  }

  /** The groups, the last one partial. Closes the collector's open group, so call it once, at the end. */
  finish(): BloomGroup[] {
    if (this.#rows > 0) this.#close();
    return this.#groups;
  }
}

// -- rewriting the footer -----------------------------------------------------------------------------------------

const MAGIC = new TextEncoder().encode('PAR1');
const TRAILER = 8; // the footer's length (4 bytes, little endian) and the magic

const FILE_ROW_GROUPS = 4;
const GROUP_COLUMNS = 1;
const GROUP_ROWS = 3;
const CHUNK_META = 3;
const META_PATH = 3;
const META_BLOOM_OFFSET = 14;
const META_BLOOM_LENGTH = 15;

function list(value: unknown): TList {
  if (typeof value !== 'object' || value === null || !('items' in value))
    throw new Error('malformed Parquet footer');
  return value as TList;
}

function struct(value: unknown): TField[] {
  if (!Array.isArray(value)) throw new Error('malformed Parquet footer');
  return value as TField[];
}

function setField(fields: TField[], id: number, type: number, value: bigint): void {
  const at = fields.findIndex((f) => f.id >= id);
  if (fields[at]?.id === id) fields[at] = { id, type, value };
  else fields.splice(at < 0 ? fields.length : at, 0, { id, type, value });
}

/** The footer a file of `length` bytes ends with: where it starts, and its bytes without the trailer. */
function footerSpan(tail: Uint8Array, length: number): { start: number; size: number } {
  const n = tail.length;
  const magic = tail.subarray(n - 4);
  if (n < TRAILER || MAGIC.some((b, i) => magic[i] !== b)) throw new Error('not a Parquet file');
  const size = new DataView(tail.buffer, tail.byteOffset + n - TRAILER, 4).getUint32(0, true);
  if (size + TRAILER > length) throw new Error('malformed Parquet footer');
  return { start: length - TRAILER - size, size };
}

/**
 * The footer of a file whose filters will be placed from `filtersAt` on (where the old footer began), with each
 * `trace_id` column chunk pointing at its group's filter, and the filters joined in order. Null when the file has no
 * `trace_id` column chunk (an empty file). It throws when the groups do not match the file's row groups in count and
 * rows: the filters would answer for other rows.
 */
function withFilters(
  footer: Uint8Array,
  filtersAt: number,
  groups: readonly BloomGroup[],
): { filters: Uint8Array; footer: Uint8Array } | null {
  const meta = readStruct(footer);
  const rowGroups = list(field(meta, FILE_ROW_GROUPS)?.value).items.map(struct);
  if (rowGroups.length !== groups.length)
    throw new Error(`bloom filters for ${groups.length} row groups, the file has ${rowGroups.length}`);
  const pieces: Uint8Array[] = [];
  let at = filtersAt;
  let any = false;
  for (const [r, rowGroup] of rowGroups.entries()) {
    const group = groups[r];
    if (group === undefined || Number(field(rowGroup, GROUP_ROWS)?.value) !== group.rows)
      throw new Error(
        `bloom filters for row group ${r} cover ${group?.rows} rows, the file has ${String(field(rowGroup, GROUP_ROWS)?.value)}`,
      );
    for (const chunk of list(field(rowGroup, GROUP_COLUMNS)?.value).items.map(struct)) {
      const chunkMeta = struct(field(chunk, CHUNK_META)?.value);
      const path = list(field(chunkMeta, META_PATH)?.value).items;
      const [name] = path;
      if (
        path.length !== 1 ||
        !(name instanceof Uint8Array) ||
        new TextDecoder().decode(name) !== BLOOM_COLUMN
      )
        continue;
      setField(chunkMeta, META_BLOOM_OFFSET, T.I64, BigInt(at));
      setField(chunkMeta, META_BLOOM_LENGTH, T.I32, BigInt(group.filter.length));
      pieces.push(group.filter);
      at += group.filter.length;
      any = true;
    }
  }
  if (!any) return null;
  const body = writeStruct(meta);
  const out = new Uint8Array(body.length + TRAILER);
  out.set(body);
  new DataView(out.buffer).setUint32(body.length, body.length, true);
  out.set(MAGIC, body.length + 4);
  const filters = new Uint8Array(at - filtersAt);
  let offset = 0;
  for (const piece of pieces) {
    filters.set(piece, offset);
    offset += piece.length;
  }
  return { filters, footer: out };
}

/** `file` with one filter per row group of `trace_id` (see `withFilters`); `file` itself when it has no such column. */
export function addBloomFilters(file: Uint8Array, groups: readonly BloomGroup[]): Uint8Array {
  const { start, size } = footerSpan(file.subarray(Math.max(0, file.length - TRAILER)), file.length);
  const done = withFilters(file.subarray(start, start + size), start, groups);
  if (done === null) return file;
  const out = new Uint8Array(start + done.filters.length + done.footer.length);
  out.set(file.subarray(0, start));
  out.set(done.filters, start);
  out.set(done.footer, start + done.filters.length);
  return out;
}

const COPY_PIECE = 1 << 20;

/**
 * The bytes of `addBloomFilters(file, groups)` for a file held as a `Blob`, in pieces: the row groups are copied a
 * piece at a time, so a merge's output is never held whole.
 */
export async function* addBloomFiltersToBlob(
  blob: Blob,
  groups: readonly BloomGroup[],
): AsyncGenerator<Uint8Array> {
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - TRAILER)).arrayBuffer());
  const { start, size } = footerSpan(tail, blob.size);
  const footer = new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
  const done = withFilters(footer, start, groups);
  for (let at = 0; at < start; at += COPY_PIECE) {
    yield new Uint8Array(await blob.slice(at, Math.min(start, at + COPY_PIECE)).arrayBuffer());
  }
  if (done === null) {
    yield footer;
    yield tail;
    return;
  }
  yield done.filters;
  yield done.footer;
}
