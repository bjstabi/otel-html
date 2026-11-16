import { describe, expect, test } from 'vitest';
import type { ManifestV4, PartitionFile } from '../../src/format/manifest.js';
import type { Pruned } from '../../src/query/sql/prune.js';
import { afterCursor, readPage } from '../../src/viewer/data/list-pages.js';
import { emptyManifest } from '../../test-support/format4-fixture.js';

interface Row {
  time: bigint;
  file: string;
  row: number;
}
interface Spec {
  rows: bigint[];
  /** traces only: how far past the last start a file's spans end */
  endPad?: bigint;
}
const path = (i: number, table: string): string =>
  `partitions/${String(i).padStart(6, '0')}/${table}.parquet`;

function layout(specs: Spec[], table: 'spans' | 'traces') {
  const m = emptyManifest();
  const data = new Map<string, Row[]>();
  const manifest: ManifestV4 = {
    ...m,
    partitions: specs.map((s, i) => {
      const p = path(i, table);
      data.set(
        p,
        s.rows.map((time, row) => ({ time, file: p, row })),
      );
      const sorted = [...s.rows].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const f: PartitionFile = {
        path: p,
        bytes: 1,
        rows: s.rows.length,
        timeMin: String(sorted[0]),
        timeMax: String(sorted.at(-1)),
        values: {},
        ...(table === 'traces' ? { timeEndMax: String((sorted.at(-1) as bigint) + (s.endPad ?? 0n)) } : {}),
      };
      return { n: i, source: 's', files: { [table]: f } };
    }),
  };
  const files = manifest.partitions.map((p) => p.files[table]?.path as string);
  const pruned: Pruned = { files, all: true, total: files.length };
  return { manifest, data, pruned };
}

/** The statement `main` ran: rows of `files` after the cursor, ordered by time then (file, row) ascending, the first `need`. */
function order(dir: 'asc' | 'desc') {
  return (a: Row, b: Row): number =>
    a.time !== b.time
      ? a.time < b.time === (dir === 'asc')
        ? -1
        : 1
      : a.file < b.file
        ? -1
        : a.file > b.file
          ? 1
          : a.row - b.row;
}
const after = (r: Row, c: Row | null, dir: 'asc' | 'desc'): boolean => c === null || order(dir)(c, r) < 0;

async function pageToEnd(
  l: ReturnType<typeof layout>,
  table: 'spans' | 'traces',
  dir: 'asc' | 'desc',
  limit: number,
): Promise<Row[]> {
  const got: Row[] = [];
  let cursor: Row | null = null;
  for (;;) {
    const pruned: Pruned =
      cursor === null ? l.pruned : afterCursor(l.manifest, table, l.pruned, cursor.time, dir);
    const need = limit + 1;
    const page = await readPage({
      manifest: l.manifest,
      table,
      pruned,
      need,
      dir,
      read: async (files) => {
        const rows = files.files
          .flatMap((p) => l.data.get(p) ?? [])
          .filter((r) => after(r, cursor, dir))
          .sort(order(dir))
          .slice(0, need);
        return {
          rows: rows.length,
          value: rows,
          edge: rows.length >= need ? (rows[need - 1] as Row).time : null,
        };
      },
    });
    got.push(...page.value.slice(0, limit));
    if (page.value.length <= limit) return got;
    cursor = page.value[limit - 1] as Row;
  }
}
const everything = (l: ReturnType<typeof layout>, dir: 'asc' | 'desc'): Row[] =>
  [...l.data.values()].flat().sort(order(dir));
const times = (...t: number[]): bigint[] => t.map(BigInt);

describe('readPage never skips a row an overlapping file left in', () => {
  // A [100,200] holds rows from 100 up, B [50,150] is dense at 80-95, C [80,95] is wholly below A
  const overlapping: Spec[] = [
    { rows: times(100, 200) },
    { rows: times(50, 80, 81, 82, 83, 84, 150) },
    { rows: times(91, 92, 93, 94, 95) },
  ];
  for (const dir of ['desc', 'asc'] as const) {
    for (const limit of [1, 2, 3, 5]) {
      test(`${dir}, ${limit} per page: every row once, in order`, async () => {
        const l = layout(overlapping, 'spans');
        expect(await pageToEnd(l, 'spans', dir, limit)).toEqual(everything(l, dir));
      });
    }
  }

  test('randomized overlapping partitions, spans and traces, both directions', async () => {
    let seed = 11;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor(seed / 7) % n;
    };
    for (let round = 0; round < 300; round++) {
      const specs: Spec[] = Array.from({ length: 2 + rnd(7) }, () => {
        const lo = rnd(60);
        const span = rnd(50);
        const count = 1 + rnd(8);
        return {
          rows: Array.from({ length: count }, () => BigInt(lo + rnd(span + 1))),
          endPad: BigInt(rnd(30)),
        };
      });
      const limit = 1 + rnd(6);
      for (const table of ['spans', 'traces'] as const) {
        const l = layout(specs, table);
        for (const dir of ['desc', 'asc'] as const)
          expect(await pageToEnd(l, table, dir, limit)).toEqual(everything(l, dir));
      }
    }
  });
});
