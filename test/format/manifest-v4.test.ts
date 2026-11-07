import { describe, expect, test } from 'vitest';
import { isV4, type ManifestV4, parseAnyManifest, parseManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { PARTITION_FILE_RE, partitionFilePath } from '../../src/format/paths.js';
import { OtelHtmlError } from '../../src/model/errors.js';

const config = {
  viewer: {
    eagerBudgetBytes: 75_000_000,
    listCap: 10_000,
    theme: 'system',
    defaultDashboard: 'fusion',
    home: 'traces',
  },
  dashboards: [],
  views: [],
} as const;

const v4 = (): ManifestV4 => ({
  formatVersion: 4,
  otelHtmlVersion: '0.3.0',
  title: 't',
  epochUnixNano: '1700000000000000000',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:01.000Z',
  complete: true,
  range: { start: '-5', end: '10' },
  totals: { spans: 3, logs: 0, metrics: 0 },
  partitions: [
    {
      n: 0,
      source: 'flush:1',
      files: {
        spans: {
          path: partitionFilePath(0, 'spans'),
          bytes: 900,
          rows: 3,
          timeMin: '-5',
          timeMax: '10',
          values: { service_name: ['a'], name: null, severity_number: [] },
        },
      },
    },
    { n: 1, source: 'ci:run#12', files: {} },
  ],
  statisticsKeys: { spans: ['name'], logs: [], points: [], traces: [], patterns: [] },
  engine: { version: '1.4.1', format: 'local', assetsBase: 'assets/' },
  config: { ...config, viewer: { ...config.viewer }, dashboards: [], views: [] },
});

function failure(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('manifest v4', () => {
  test('parses, keeping null and empty statistics values distinct', () => {
    const m = parseAnyManifest(v4());
    expect(m).toEqual(v4());
    expect(isV4(m)).toBe(true);
  });

  test('a v3 manifest still parses through parseAnyManifest', () => {
    const v3 = {
      formatVersion: 3,
      otelHtmlVersion: '0.1.0',
      title: 't',
      epochUnixNano: '1',
      createdAt: 'a',
      updatedAt: 'b',
      complete: true,
      range: null,
      totals: { spans: 0, logs: 0, metrics: 0 },
      decodedBytes: 0,
      chunks: [],
      rollups: [],
      traceShards: [],
      metricFiles: [],
      config,
    };
    const m = parseAnyManifest(v3);
    expect(isV4(m)).toBe(false);
    expect(m).toEqual(parseManifest(v3));
  });

  test('an unknown formatVersion is invalid-report at formatVersion', () => {
    const e = failure(() => parseAnyManifest({ ...v4(), formatVersion: 5 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
  });

  test('a v4 manifest is not a v3 manifest', () => {
    expect(() => parseManifest(v4())).toThrow();
  });

  test('a wrong file path names the path', () => {
    const m = v4();
    const f = m.partitions[0]?.files.spans;
    if (f) f.path = 'data/partitions/000001/spans.parquet';
    const e = failure(() => parseAnyManifest(m));
    expect(e.path).toBe('manifest.partitions[0].files.spans.path');
  });

  test('a duplicate or decreasing n names the path', () => {
    for (const n of [2, 1]) {
      const m = v4();
      const [p0, p1] = m.partitions;
      if (p0 && p1) {
        p0.n = 2;
        p0.files = {};
        p1.n = n;
      }
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[1].n');
    }
  });

  test('assetsBase: relative forms valid, absolute and scheme forms not', () => {
    for (const ok of ['assets/', '../../assets/0.3.0/']) {
      const m = v4();
      m.engine.assetsBase = ok;
      expect(parseAnyManifest(m)).toEqual(m);
    }
    for (const bad of ['/assets/', 'https://cdn.example/assets/', 'assets', '../assets/_x/', 'x/assets/']) {
      const m = v4();
      m.engine.assetsBase = bad;
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.engine.assetsBase');
    }
  });

  test('a bad source names the path', () => {
    for (const bad of ['', 'flush:', 'other:1', 'flush:a b']) {
      const m = v4();
      const p = m.partitions[0];
      if (p) p.source = bad;
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[0].source');
    }
  });

  test('timeMin must be int64 text; unknown table keys are rejected', () => {
    const m = v4();
    const f = m.partitions[0]?.files.spans;
    if (f) f.timeMin = '1.5';
    expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[0].files.spans.timeMin');
    const extra = { ...v4(), statisticsKeys: { ...v4().statisticsKeys, metrics: [] } };
    expect(failure(() => parseAnyManifest(extra)).path).toBe('manifest.statisticsKeys');
  });

  test('PARTITION_FILE_RE matches every table path, narrow and wide', () => {
    for (const t of TABLES) {
      for (const n of [7, 1234567]) expect(PARTITION_FILE_RE.test(partitionFilePath(n, t))).toBe(true);
    }
  });

  test('engine.version is a path-safe version', () => {
    for (const bad of ['x/../../', '1/2', '', '.1', '_1']) {
      const m = v4();
      m.engine.version = bad;
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.engine.version');
    }
  });

  test('range is absolute int64 text, ordered, and parses far beyond 2^53', () => {
    const m = v4();
    m.range = { start: '1793923200000000000', end: '1793923201000000000' };
    expect(parseAnyManifest(m)).toEqual(m);
    const bad = (range: unknown, path: string): void => {
      expect(failure(() => parseAnyManifest({ ...v4(), range })).path).toBe(path);
    };
    bad({ start: '10', end: '5' }, 'manifest.range.end');
    bad({ start: '007', end: '9' }, 'manifest.range.start');
    bad({ start: '-0', end: '9' }, 'manifest.range.start');
    bad({ start: '1', end: '9223372036854775808' }, 'manifest.range.end');
    bad({ start: -5, end: 10 }, 'manifest.range.start');
  });

  test('timeMin <= timeMax and int64 bounds are enforced per file', () => {
    const m = v4();
    const f = m.partitions[0]?.files.spans;
    if (f) {
      f.timeMin = '9223372036854775807';
      f.timeMax = '-9223372036854775808';
    }
    expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[0].files.spans.timeMax');
    if (f) f.timeMax = '9223372036854775808';
    expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[0].files.spans.timeMax');
  });

  test('a bigint formatVersion is invalid-report, not a TypeError', () => {
    const e = failure(() => parseAnyManifest({ ...v4(), formatVersion: 4n }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
  });
});
