import type { ReadEvent } from './counting-engine.js';
import { REQUESTS_PER_OPEN, TABLES, type Table } from './model.js';

/** What a statement costs in file reads: serial requests, parallel requests (the `prepared` files) and bytes. */
export interface Cost {
  serial: number;
  parallel: number;
  bytes: number;
}

export { REQUESTS_PER_OPEN };

/** Chromium range GETs one modelled range costs (calibration, Task 1: the `k` of decision 3). */
export const REQUESTS_PER_READ = 1;

/**
 * Rows of the row groups a scaling report is written with in place of the writer's 50,000. PROVISIONAL: no size passed
 * the calibration of Task 1 step 5 (see the Calibration section of the plan); 8,192 deviates least (33 % and 75 %).
 */
export const ROW_GROUP_ROWS = 8192;

/** The range sizes of the read-ahead: a stream starts at the first and grows to the next on each sequential miss. */
const READ_AHEAD = [16_384, 65_536, 262_144, 1_048_576, 4_194_304] as const;

interface Stream {
  start: number;
  end: number;
  level: number;
}

/**
 * The range GETs duckdb-wasm's HTTP file makes for the Node read calls, per file (matched, per statement, against the
 * `Range` headers the static server logged: the starts of all ranges agree). The file keeps a few read-ahead streams:
 *
 * - a read inside a stream's current range costs nothing;
 * - a read that starts where a stream's range ends continues that stream: it fetches the next size of `READ_AHEAD`
 *   (16 KiB, 64 KiB, 256 KiB, 1 MiB, then 4 MiB), and the new range replaces the old one;
 * - any other read starts a new stream and fetches 16 KiB (or the read, if larger).
 *
 * A stream survives a jump to somewhere else, so a column chunk read in pieces keeps growing across the dictionary and
 * page-index reads between them. An `open` event forgets the file's streams. The ranges are not clipped at the end of
 * the file (the events do not carry its size), so they are for counting, not for bytes.
 */
export function rangesOf(events: readonly ReadEvent[]): number {
  const streams = new Map<string, Stream[]>();
  let ranges = 0;
  for (const e of events) {
    if (e.kind === 'open') {
      streams.delete(e.path);
      continue;
    }
    const own = streams.get(e.path) ?? [];
    streams.set(e.path, own);
    if (own.some((s) => s.start <= e.offset && e.offset + e.bytes <= s.end)) continue;
    ranges++;
    const next = own.find((s) => s.end === e.offset);
    if (next !== undefined) {
      next.level = Math.min(next.level + 1, READ_AHEAD.length - 1);
      next.start = e.offset;
      next.end = e.offset + Math.max(e.bytes, READ_AHEAD[next.level] ?? 0);
    } else {
      own.push({ start: e.offset, end: e.offset + Math.max(e.bytes, READ_AHEAD[0]), level: 0 });
    }
  }
  return ranges;
}

/**
 * Reads of a path in `prepared` cost one parallel request of the file's size; all other events are serial: an open is
 * `REQUESTS_PER_OPEN` requests and the reads are the ranges `rangesOf` models, `REQUESTS_PER_READ` each. `bytes` sums
 * what the read calls returned.
 */
export function costOf(events: readonly ReadEvent[], prepared: ReadonlyMap<string, number>): Cost {
  const cost: Cost = { serial: 0, parallel: 0, bytes: 0 };
  const counted = new Set<string>();
  const serial: ReadEvent[] = [];
  for (const e of events) {
    const size = prepared.get(e.path);
    if (size !== undefined) {
      if (!counted.has(e.path)) {
        counted.add(e.path);
        cost.parallel += 1;
        cost.bytes += size;
      }
      continue;
    }
    serial.push(e);
    if (e.kind === 'open') cost.serial += REQUESTS_PER_OPEN;
    else cost.bytes += e.bytes;
  }
  cost.serial += rangesOf(serial) * REQUESTS_PER_READ;
  return cost;
}

const TABLE_OF = /\/(spans|logs|points|traces|patterns)\.parquet$/;

/** The table a manifest path belongs to, or null. */
export function tableOf(path: string): Table | null {
  const hit = TABLE_OF.exec(path)?.[1];
  return TABLES.find((t) => t === hit) ?? null;
}

/** One file a statement opened: its table and the modelled ranges of its footer read(s). */
export interface OpenedFile {
  table: Table;
  footer: number;
}

/**
 * The open part of a cold statement's reads, per file: the file's first `open` and the reads right after it that end at
 * the end of the file (the footer; `sizes` holds each file's bytes) cost `REQUESTS_PER_OPEN` plus the ranges
 * `rangesOf` models for them; everything after is the data part (`costOf(events).serial` minus `serial`). Files in
 * `prepared` and files without a known table are not counted.
 */
export function splitOpens(
  events: readonly ReadEvent[],
  sizes: ReadonlyMap<string, number>,
  prepared: ReadonlyMap<string, number> = new Map(),
): { serial: number; files: OpenedFile[] } {
  const byPath = new Map<string, ReadEvent[]>();
  for (const e of events) {
    if (prepared.has(e.path)) continue;
    const own = byPath.get(e.path) ?? [];
    byPath.set(e.path, own);
    own.push(e);
  }
  let serial = 0;
  const files: OpenedFile[] = [];
  for (const [path, own] of byPath) {
    const table = tableOf(path);
    const first = own.findIndex((e) => e.kind === 'open');
    if (table === null || first === -1) continue;
    const size = sizes.get(path) ?? Number.POSITIVE_INFINITY;
    let end = first + 1;
    while (own[end]?.kind === 'read' && (own[end]?.offset ?? 0) + (own[end]?.bytes ?? 0) >= size) end++;
    const footer = rangesOf(own.slice(first, end)) * REQUESTS_PER_READ;
    serial += REQUESTS_PER_OPEN + footer;
    files.push({ table, footer });
  }
  return { serial, files };
}
