import { describe, expect, test } from 'vitest';
import type { ManifestV4, PartitionFile } from '../../../src/format/manifest.js';
import type { Table } from '../../../src/format/parquet/columns.js';
import { absWindow, prunePartitions } from '../../../src/query/sql/prune.js';
import { emptyManifest } from '../../../test-support/format4-fixture.js';

const file = (i: number, table = 'spans'): string =>
  `partitions/${String(i).padStart(6, '0')}/${table}.parquet`;

interface Stat {
  timeMin?: string | null;
  timeMax?: string | null;
  timeEndMax?: string | null;
  [key: string]: string[] | string | null | undefined;
}

function manifestWith(
  stats: Stat[],
  opts: { statisticsKeys?: Partial<Record<Table, string[]>>; table?: Table } = {},
): ManifestV4 {
  const table = opts.table ?? 'spans';
  const base = emptyManifest();
  return {
    ...base,
    statisticsKeys: { ...base.statisticsKeys, ...opts.statisticsKeys },
    partitions: stats.map((s, i) => {
      const { timeMin = null, timeMax = null, timeEndMax, ...rest } = s;
      const values: Record<string, string[] | null> = {};
      for (const [k, v] of Object.entries(rest)) values[k] = v as string[] | null;
      const f: PartitionFile = {
        path: `partitions/${String(i).padStart(6, '0')}/${table}.parquet`,
        bytes: 1,
        rows: 1,
        timeMin: timeMin as string | null,
        timeMax: timeMax as string | null,
        ...(timeEndMax === undefined ? {} : { timeEndMax }),
        values,
      };
      return { n: i, source: 's', files: { [table]: f } };
    }),
  };
}
const withoutKey = (m: ManifestV4): ManifestV4 => ({ ...m, statisticsKeys: emptyManifest().statisticsKeys });
const hints = (o: Record<string, string[]>): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));

describe('prunePartitions', () => {
  test('an equality hint drops files whose values exclude it and keeps null statistics', () => {
    const m = manifestWith([{ service_name: ['a'] }, { service_name: ['b'] }, { service_name: null }]);
    expect(prunePartitions(m, 'spans', hints({ service_name: ['a'] }), null)).toEqual({
      files: [file(0), file(2)],
      all: false,
      total: 3,
    });
  });
  test('a listed key a file lacks (absent) is unknown, exactly like null: the file is kept', () => {
    const m = manifestWith(
      [{ 'resource:run': ['1'] }, {}, { 'resource:run': null }, { 'resource:run': ['2'] }],
      {
        statisticsKeys: { spans: ['resource:run'] },
      },
    );
    expect(prunePartitions(m, 'spans', hints({ 'resource:run': ['2'] }), null).files).toEqual([
      file(1),
      file(2),
      file(3),
    ]);
  });
  test('a resource key hint applies only when statisticsKeys lists it', () => {
    const m = manifestWith([{ 'resource:run': ['1'] }], { statisticsKeys: { spans: ['resource:run'] } });
    expect(prunePartitions(m, 'spans', hints({ 'resource:run': ['2'] }), null).files).toEqual([]);
    expect(prunePartitions(withoutKey(m), 'spans', hints({ 'resource:run': ['2'] }), null).all).toBe(true);
  });
  test('spans prune on the upper bound only, logs on both', () => {
    const m = manifestWith([
      { timeMin: '100', timeMax: '200' },
      { timeMin: '500', timeMax: '600' },
    ]);
    const w = { start: 300n, end: 400n };
    expect(prunePartitions(m, 'spans', new Map(), w).files).toEqual([file(0)]);
    const logs = manifestWith(
      [
        { timeMin: '100', timeMax: '200' },
        { timeMin: '500', timeMax: '600' },
      ],
      { table: 'logs' },
    );
    expect(prunePartitions(logs, 'logs', new Map(), w).files).toEqual([]);
  });
  test('a file overlapping the window, or touching its start, is kept (logs)', () => {
    const logs = manifestWith(
      [
        { timeMin: '250', timeMax: '350' },
        { timeMin: '100', timeMax: '300' },
        { timeMin: '100', timeMax: '299' },
      ],
      { table: 'logs' },
    );
    expect(prunePartitions(logs, 'logs', new Map(), { start: 300n, end: 400n }).files).toEqual([
      file(0, 'logs'),
      file(1, 'logs'),
    ]);
  });
  test('points prune on both bounds', () => {
    const points = manifestWith(
      [
        { timeMin: '100', timeMax: '200' },
        { timeMin: '250', timeMax: '350' },
        { timeMin: '500', timeMax: '600' },
      ],
      { table: 'points' },
    );
    expect(prunePartitions(points, 'points', new Map(), { start: 300n, end: 400n }).files).toEqual([
      file(1, 'points'),
    ]);
  });
  test('times compare as bigint beyond 2^53; null times and missing keys keep the file', () => {
    const m = manifestWith([
      { timeMin: '9007199254740993', timeMax: '9007199254740993' },
      { timeMin: null, timeMax: null },
      { timeMin: '1', timeMax: '2' },
    ]);
    const w = { start: 0n, end: 9007199254740992n };
    expect(prunePartitions(m, 'spans', hints({ service_name: ['x'] }), w).files).toEqual([file(1), file(2)]);
  });
  test('no partitions of the table: nothing to read, all true', () => {
    expect(prunePartitions(emptyManifest(), 'logs', new Map(), null)).toEqual({
      files: [],
      all: true,
      total: 0,
    });
  });
  test('resolve maps manifest paths to registered names', () => {
    const m = manifestWith([{}]);
    expect(prunePartitions(m, 'spans', new Map(), null, (p) => `x/${p}`).files).toEqual([`x/${file(0)}`]);
  });
});

describe('absWindow', () => {
  test('adds the epoch; null stays null', () => {
    expect(absWindow(null, 5n)).toBeNull();
    expect(absWindow({ start: 10, end: 20 }, 5n)).toEqual({ start: 15n, end: 25n });
  });
  test('fractional bounds widen to whole nanoseconds', () => {
    expect(absWindow({ start: 10.5, end: 20.2 }, 5n)).toEqual({ start: 15n, end: 26n });
    expect(absWindow({ start: -0.5, end: 1e3 + 0.5 }, 0n)).toEqual({ start: -1n, end: 1001n });
  });

  describe('end time', () => {
    const w = { start: 1000n, end: 2000n };
    test('a spans file that ends before the window starts is not read', () => {
      const m = manifestWith([
        { timeMin: '10', timeMax: '20', timeEndMax: '999' },
        { timeMin: '10', timeMax: '20', timeEndMax: '1500' },
      ]);
      expect(prunePartitions(m, 'spans', hints({}), w).files).toEqual([file(1)]);
      const t = manifestWith([{ timeMin: '10', timeMax: '20', timeEndMax: '999' }], { table: 'traces' });
      expect(prunePartitions(t, 'traces', hints({}), w).files).toEqual([]);
    });
    test('a file whose timeEndMax equals the window’s start is read', () => {
      const m = manifestWith([{ timeMin: '10', timeMax: '20', timeEndMax: '1000' }]);
      expect(prunePartitions(m, 'spans', hints({}), w).files).toEqual([file(0)]);
    });
    test('a format-4 file (no timeEndMax) is read whenever it is today', () => {
      const m = manifestWith([
        { timeMin: '10', timeMax: '20' },
        { timeMin: '10', timeMax: '20', timeEndMax: null },
      ]);
      expect(prunePartitions(m, 'spans', hints({}), w).files).toEqual([file(0), file(1)]);
    });
    test('a logs file is unaffected', () => {
      const m = manifestWith([{ timeMin: '10', timeMax: '1500', timeEndMax: '5' }], { table: 'logs' });
      expect(prunePartitions(m, 'logs', hints({}), w).files).toEqual([file(0, 'logs')]);
    });
  });
});
