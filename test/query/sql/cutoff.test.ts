import { sql } from '@uwdata/mosaic-sql';
import { describe, expect, test } from 'vitest';
import type { ManifestV4, PartitionFile } from '../../../src/format/manifest.js';
import { ROLLUP_GRAIN_NS } from '../../../src/format/manifest.js';
import { countsFromRows, newestFiles, rollupCounts } from '../../../src/query/sql/cutoff.js';
import type { SqlFilter } from '../../../src/query/sql/filter.js';
import type { Pruned } from '../../../src/query/sql/prune.js';
import { emptyManifest } from '../../../test-support/format4-fixture.js';

interface Spec {
  min: string | null;
  max: string | null;
  rows?: number;
  end?: string | null;
  rollup?: string[] | null;
}
const base = (i: number, t = 'spans'): string => `partitions/${String(i).padStart(6, '0')}/${t}.parquet`;

function manifestOf(specs: Spec[], table: 'spans' | 'logs' | 'traces' = 'spans'): ManifestV4 {
  const m = emptyManifest();
  return {
    ...m,
    partitions: specs.map((s, i) => {
      const f: PartitionFile = {
        path: base(i, table),
        bytes: 1,
        rows: s.rows ?? 100,
        timeMin: s.min,
        timeMax: s.max,
        values: {},
        ...(s.end === undefined ? {} : { timeEndMax: s.end }),
      };
      const files: ManifestV4['partitions'][number]['files'] = { [table]: f };
      if (s.rollup != null && table !== 'traces') {
        files[table === 'spans' ? 'span_rollups' : 'log_rollups'] = {
          path: `partitions/${String(i).padStart(6, '0')}/rollup.parquet`,
          bytes: 1,
          rows: 1,
          timeMin: s.min,
          timeMax: s.max,
          values: {},
          rollup: { grainNs: ROLLUP_GRAIN_NS, dimensions: s.rollup },
        };
      }
      return { n: i, source: 's', files };
    }),
  };
}
const all = (m: ManifestV4, t: 'spans' | 'logs' | 'traces' = 'spans'): Pruned => {
  const files = m.partitions.flatMap((p) => p.files[t]?.path ?? []);
  return { files, all: true, total: files.length };
};
// ten partitions, 100 rows each, disjoint, oldest first
const ten = (): Spec[] =>
  Array.from({ length: 10 }, (_, i) => ({ min: String(i * 10 + 1), max: String(i * 10 + 9) }));
const idx = (files: readonly string[]): number[] =>
  files.map((f) => Number(f.split('/')[1])).sort((a, b) => a - b);

describe('newestFiles', () => {
  test('keeps the fewest newest files whose rows reach need', () => {
    const m = manifestOf(ten());
    const r = newestFiles(m, 'spans', all(m), 200);
    expect(idx(r.files.files)).toEqual([8, 9]);
    expect(r.complete).toBe(false);
    expect(r.files.all).toBe(false);
    expect(r.files.total).toBe(10);
  });

  test('bound is where the left-out files end: the largest timeMax desc, the smallest timeMin asc, null when none', () => {
    const m = manifestOf(ten());
    expect(newestFiles(m, 'spans', all(m), 200).bound).toBe(79n);
    expect(newestFiles(m, 'spans', all(m), 200, { dir: 'asc' }).bound).toBe(21n);
    expect(newestFiles(m, 'spans', all(m), 5000).bound).toBeNull();
  });

  test('is complete when every file is needed', () => {
    const m = manifestOf(ten());
    const r = newestFiles(m, 'spans', all(m), 5000);
    expect(r.complete).toBe(true);
    expect(r.files.all).toBe(true);
    expect(r.files.files).toHaveLength(10);
  });

  test('counts replace the file rows: zero matches in the newest three keeps 4 to 6', () => {
    const m = manifestOf(ten());
    const counts = new Map<string, number>();
    for (let i = 0; i < 10; i++) counts.set(base(i), i >= 7 ? 0 : 100);
    const r = newestFiles(m, 'spans', all(m), 300, { counts });
    expect(idx(r.files.files)).toEqual([4, 5, 6]);
    expect(r.complete).toBe(false);
    expect(newestFiles(m, 'spans', all(m), 900, { counts }).complete).toBe(true);
  });

  test('a file with no count is unknown, not zero: it stays eligible at its rows', () => {
    const m = manifestOf(ten());
    const counts = new Map<string, number>([
      [base(9), 0],
      [base(8), 0],
    ]);
    const r = newestFiles(m, 'spans', all(m), 100, { counts });
    expect(idx(r.files.files)).toEqual([7]);
  });

  test('partitions overlapping the kept set in time join it', () => {
    const specs = ten();
    specs[5] = { min: '55', max: '95' }; // reaches into the newest file's span
    const m = manifestOf(specs);
    const r = newestFiles(m, 'spans', all(m), 100);
    // partition 5 has the greatest timeMax below 99? no: 9 is newest (max 99); 5 (max 95) overlaps 9's min 91
    expect(idx(r.files.files)).toEqual([5, 9]);
  });

  test('asc keeps the oldest and the files overlapping them', () => {
    const specs = ten();
    specs[4] = { min: '5', max: '49' }; // starts inside the oldest file
    const m = manifestOf(specs);
    const r = newestFiles(m, 'spans', all(m), 100, { dir: 'asc' });
    expect(idx(r.files.files)).toEqual([0, 4]);
  });

  test('a trace whose end reaches into an older partition pulls that partition in', () => {
    const specs = ten().map((s) => ({ ...s, end: s.max }));
    specs[3] = { min: '31', max: '39', end: '95' };
    const m = manifestOf(specs, 'traces');
    const r = newestFiles(m, 'traces', all(m, 'traces'), 100);
    expect(idx(r.files.files)).toEqual([3, 9]);
  });

  test('a span file with a late end is not pulled in (spans order by start)', () => {
    const specs = ten().map((s) => ({ ...s, end: s.max }));
    specs[3] = { min: '31', max: '39', end: '95' };
    const m = manifestOf(specs);
    expect(idx(newestFiles(m, 'spans', all(m), 100).files.files)).toEqual([9]);
  });

  test('a file without time statistics is never left out and counts nothing', () => {
    const specs = ten();
    specs[2] = { min: null, max: null };
    const m = manifestOf(specs);
    const r = newestFiles(m, 'spans', all(m), 200);
    expect(idx(r.files.files)).toEqual([2, 8, 9]);
    expect(idx(newestFiles(m, 'spans', all(m), 200, { dir: 'asc' }).files.files)).toEqual([0, 1, 2]);
  });

  test('a file with no rows is skipped unless it overlaps', () => {
    const specs = ten();
    specs[9] = { min: '91', max: '99', rows: 0 };
    const m = manifestOf(specs);
    expect(idx(newestFiles(m, 'spans', all(m), 100).files.files)).toEqual([8, 9]);
  });

  test('after is kept and the result extends it by at least one file', () => {
    const m = manifestOf(ten());
    const first = newestFiles(m, 'spans', all(m), 200);
    const next = newestFiles(m, 'spans', all(m), 200, { after: first.files });
    expect(idx(next.files.files)).toEqual([7, 8, 9]);
  });

  test('works over a pruned subset and keeps its total', () => {
    const m = manifestOf(ten());
    const some: Pruned = { files: [base(0), base(1), base(2)], all: false, total: 10 };
    const r = newestFiles(m, 'spans', some, 100);
    expect(idx(r.files.files)).toEqual([2]);
    expect(r.files.total).toBe(10);
    expect(r.complete).toBe(false);
  });

  test('top need rows of the kept set are the top need rows overall (desc, random layouts)', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const specs: Spec[] = Array.from({ length: 8 }, () => {
        const lo = rnd(100);
        return { min: String(lo), max: String(lo + rnd(40)), rows: 1 + rnd(5) };
      });
      const m = manifestOf(specs);
      const need = 1 + rnd(12);
      const r = newestFiles(m, 'spans', all(m), need);
      const kept = new Set(r.files.files);
      // some kept files, newest by timeMin, hold need rows and all lie at or above every left-out file's timeMax
      if (r.complete) continue;
      const byMin = specs
        .map((s, i) => ({ s, i }))
        .filter(({ i }) => kept.has(base(i)))
        .sort((x, y) => Number(y.s.min) - Number(x.s.min));
      let rows = 0;
      let floor = Number.NEGATIVE_INFINITY;
      for (const { s } of byMin) {
        rows += s.rows ?? 0;
        floor = Number(s.min);
        if (rows >= need) break;
      }
      expect(rows).toBeGreaterThanOrEqual(need);
      for (let i = 0; i < specs.length; i++) {
        if (!kept.has(base(i))) expect(Number(specs[i]?.max)).toBeLessThan(floor);
      }
    }
  });
});

describe('rollupCounts', () => {
  const filter = (files: Pruned): SqlFilter => ({
    predicate: null,
    text: null,
    files,
    window: null,
    epoch: 0n,
    long: false,
  });

  test('one grouped statement over the usable rollup files; others are unknown', () => {
    const specs: Spec[] = [
      { min: '1', max: '9', rollup: ['service_name'] },
      { min: '11', max: '19', rollup: [] }, // lacks the dimension
      { min: '21', max: '29' }, // no rollup
    ];
    const m = manifestOf(specs);
    const c = rollupCounts(m, 'spans', all(m), filter(all(m)), new Set(['service_name']));
    const text = String(c.query);
    expect(text).toContain('FROM "span_rollups"');
    expect(text).toContain('GROUP BY "filename"');
    expect(text).toContain('partitions/000000/rollup.parquet');
    expect(text).not.toContain('partitions/000001/rollup.parquet');
    expect([...c.baseOf]).toEqual([['partitions/000000/rollup.parquet', base(0)]]);
  });

  test('a text search, a short window or an unaligned window gives no counts; an aligned long one does', () => {
    const m = manifestOf([{ min: '1', max: '9', rollup: [] }]);
    const p = all(m);
    const G = BigInt(ROLLUP_GRAIN_NS);
    const none = (f: SqlFilter): unknown => rollupCounts(m, 'spans', p, f, new Set()).query;
    expect(none({ ...filter(p), text: sql`true` })).toBeNull();
    expect(none({ ...filter(p), window: { start: 0n, end: G } })).toBeNull();
    expect(none({ ...filter(p), long: true, window: { start: 1n, end: G } })).toBeNull();
    expect(none({ ...filter(p), long: true, window: { start: 0n, end: G } })).not.toBeNull();
  });

  test('a traces file without timeEndMax is kept as possibly overlapping', () => {
    const specs = ten().map((s) => ({ ...s, end: s.max }));
    specs[3] = { min: '31', max: '39', end: null };
    const m = manifestOf(specs, 'traces');
    expect(idx(newestFiles(m, 'traces', all(m, 'traces'), 100).files.files)).toEqual([3, 9]);
  });

  test('no usable rollup means no query', () => {
    const m = manifestOf([{ min: '1', max: '9' }]);
    expect(rollupCounts(m, 'spans', all(m), filter(all(m)), new Set()).query).toBeNull();
  });

  test('rows map back to base files; a rollup file with no row counts zero', () => {
    const m = manifestOf([
      { min: '1', max: '9', rollup: [] },
      { min: '11', max: '19', rollup: [] },
      { min: '21', max: '29' },
    ]);
    const c = rollupCounts(m, 'spans', all(m), filter(all(m)), new Set());
    const counts = countsFromRows(c, [{ filename: 'partitions/000001/rollup.parquet', n: 42 }]);
    expect([...counts].sort()).toEqual([
      [base(0), 0],
      [base(1), 42],
    ]);
  });
});
