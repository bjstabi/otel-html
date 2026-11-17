import { describe, expect, test } from 'vitest';
import {
  isPartitioned,
  type ManifestV4,
  ManifestV5Schema,
  manifestAnchor,
  manifestForWrite,
  parseAnyManifest,
  parseManifest,
  ROLLUP_GRAIN_NS,
  type RollupDescription,
} from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { PARTITION_FILE_RE, partitionFilePath } from '../../src/format/paths.js';
import { oldFormatMessage } from '../../src/format/version.js';
import { OtelHtmlError } from '../../src/model/errors.js';

const config = {
  viewer: {
    listCap: 10_000,
    theme: 'system',
    defaultDashboard: 'fusion',
    home: 'traces',
  },
  dashboards: [],
  views: [],
} as const;

const v5 = (): ManifestV4 => ({
  formatVersion: 5,
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

describe('manifest format 5 (partitions)', () => {
  test('parses, keeping null and empty statistics values distinct', () => {
    const m = parseAnyManifest(v5());
    expect(m).toEqual(v5());
    expect(isPartitioned(m)).toBe(true);
  });

  test('the facet caps round-trip, and are optional', () => {
    const m = v5();
    const capped: ManifestV4 = {
      ...m,
      config: { ...m.config, viewer: { ...m.config.viewer, facetValueCap: 7, facetKeyCap: 3 } },
    };
    const parsed = parseAnyManifest(capped);
    expect(isPartitioned(parsed) && parsed.config.viewer).toMatchObject({ facetValueCap: 7, facetKeyCap: 3 });
    expect(parseAnyManifest(v5())).toEqual(v5());
  });

  test('a format-3 manifest still parses through parseAnyManifest', () => {
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
      config: { ...config, viewer: { ...config.viewer, eagerBudgetBytes: 75_000_000 } },
    };
    const m = parseAnyManifest(v3);
    expect(isPartitioned(m)).toBe(false);
    expect(m).toEqual(parseManifest(v3));
  });

  test('viewer.eagerBudgetBytes is an unknown key in a partition manifest', () => {
    const m = v5();
    const e = failure(() =>
      parseAnyManifest({
        ...m,
        config: { ...m.config, viewer: { ...m.config.viewer, eagerBudgetBytes: 1 } },
      }),
    );
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.config.viewer');
    expect(e.actual).toContain('eagerBudgetBytes');
  });

  test('an unknown formatVersion is invalid-report at formatVersion', () => {
    const e = failure(() => parseAnyManifest({ ...v5(), formatVersion: 8 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
  });

  test('a partition manifest is not a chunk manifest', () => {
    expect(() => parseManifest(v5())).toThrow();
  });

  test('a wrong file path names the path', () => {
    const m = v5();
    const f = m.partitions[0]?.files.spans;
    if (f) f.path = 'data/partitions/000001/spans.parquet';
    const e = failure(() => parseAnyManifest(m));
    expect(e.path).toBe('manifest.partitions[0].files.spans.path');
  });

  test('a duplicate or decreasing n names the path', () => {
    for (const n of [2, 1]) {
      const m = v5();
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
      const m = v5();
      m.engine.assetsBase = ok;
      expect(parseAnyManifest(m)).toEqual(m);
    }
    for (const bad of ['/assets/', 'https://cdn.example/assets/', 'assets', '../assets/_x/', 'x/assets/']) {
      const m = v5();
      m.engine.assetsBase = bad;
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.engine.assetsBase');
    }
  });

  test('a bad source names the path', () => {
    for (const bad of ['', 'flush:', 'other:1', 'flush:a b']) {
      const m = v5();
      const p = m.partitions[0];
      if (p) p.source = bad;
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[0].source');
    }
  });

  test('timeMin must be int64 text; unknown table keys are rejected', () => {
    const m = v5();
    const f = m.partitions[0]?.files.spans;
    if (f) f.timeMin = '1.5';
    expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.partitions[0].files.spans.timeMin');
    const extra = { ...v5(), statisticsKeys: { ...v5().statisticsKeys, metrics: [] } };
    expect(failure(() => parseAnyManifest(extra)).path).toBe('manifest.statisticsKeys');
  });

  test('PARTITION_FILE_RE matches every table path, narrow and wide', () => {
    for (const t of TABLES) {
      for (const n of [7, 1234567]) expect(PARTITION_FILE_RE.test(partitionFilePath(n, t))).toBe(true);
    }
  });

  test('engine.version is a path-safe version', () => {
    for (const bad of ['x/../../', '1/2', '', '.1', '_1']) {
      const m = v5();
      m.engine.version = bad;
      expect(failure(() => parseAnyManifest(m)).path).toBe('manifest.engine.version');
    }
  });

  test('range is absolute int64 text, ordered, and parses far beyond 2^53', () => {
    const m = v5();
    m.range = { start: '1793923200000000000', end: '1793923201000000000' };
    expect(parseAnyManifest(m)).toEqual(m);
    const bad = (range: unknown, path: string): void => {
      expect(failure(() => parseAnyManifest({ ...v5(), range })).path).toBe(path);
    };
    bad({ start: '10', end: '5' }, 'manifest.range.end');
    bad({ start: '007', end: '9' }, 'manifest.range.start');
    bad({ start: '-0', end: '9' }, 'manifest.range.start');
    bad({ start: '1', end: '9223372036854775808' }, 'manifest.range.end');
    bad({ start: -5, end: 10 }, 'manifest.range.start');
  });

  test('timeMin <= timeMax and int64 bounds are enforced per file', () => {
    const m = v5();
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
    const e = failure(() => parseAnyManifest({ ...v5(), formatVersion: 4n }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
  });
});

describe('manifest format 5 additions', () => {
  const rollup: RollupDescription = {
    grainNs: ROLLUP_GRAIN_NS,
    dimensions: ['service_name'],
    durationBuckets: 'log2x8',
  } as const;
  const withFile = (m: ManifestV4, files: object): ManifestV4 => ({
    ...m,
    partitions: m.partitions.map((p, i) => (i === 0 ? { ...p, files: { ...p.files, ...files } } : p)),
  });
  const spansWith = (extra: object) => ({
    spans: { ...(v5().partitions[0]?.files.spans as object), ...extra },
  });
  const rollupFile = (extra: object = { rollup }) => ({
    span_rollups: {
      path: partitionFilePath(0, 'span_rollups'),
      bytes: 10,
      rows: 1,
      timeMin: '0',
      timeMax: '1',
      values: {},
      ...extra,
    },
  });
  const additions = (base: ManifestV4): ManifestV4[] => [
    withFile(base, spansWith({ timeEndMax: '20' })),
    withFile(base, rollupFile()),
    { ...base, config: { ...base.config, viewer: { ...base.config.viewer, defaultWindow: '7d' } } },
  ];

  test('the format-5 schema accepts them, and a body without any of them', () => {
    expect(parseAnyManifest(v5())).toEqual(v5());
    expect(ManifestV5Schema.safeParse(v5()).success).toBe(true);
    for (const m of additions(v5())) expect(parseAnyManifest(m)).toEqual(m);
    const keyed = {
      ...v5(),
      statisticsKeys: { ...v5().statisticsKeys, span_rollups: ['name'], log_rollups: [] },
    };
    expect(parseAnyManifest(keyed)).toEqual(keyed);
    const nullEnd = withFile(v5(), spansWith({ timeEndMax: null }));
    expect(parseAnyManifest(nullEnd)).toEqual(nullEnd);
  });

  test('format 5 rejects: timeEndMax before timeMin; a rollup file without a description; a description on spans; grainNs 60000000000', () => {
    const base = v5();
    expect(() => parseAnyManifest(withFile(base, spansWith({ timeEndMax: '-6' })))).toThrow(OtelHtmlError);
    expect(() => parseAnyManifest(withFile(base, rollupFile({})))).toThrow(OtelHtmlError);
    expect(() => parseAnyManifest(withFile(base, spansWith({ rollup })))).toThrow(OtelHtmlError);
    const minute = { rollup: { ...rollup, grainNs: 60_000_000_000 } };
    expect(() => parseAnyManifest(withFile(base, rollupFile(minute)))).toThrow(OtelHtmlError);
    const logsEnd = { logs: { ...(v5().partitions[0]?.files.spans as object), timeEndMax: '20' } };
    expect(() => parseAnyManifest(withFile(base, logsEnd))).toThrow(OtelHtmlError);
  });

  test('parseAnyManifest: 5 parses, 4 fails with the old-format message, 8 with the newer-format error naming 8', () => {
    expect(parseAnyManifest(v5()).formatVersion).toBe(5);
    const old = failure(() => parseAnyManifest({ ...v5(), formatVersion: 4 }));
    expect(old.code).toBe('invalid-report');
    expect(old.message).toBe(oldFormatMessage(4));
    expect(old.message).toContain('format 4');
    const e = failure(() => parseAnyManifest({ ...v5(), formatVersion: 8 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
    expect(e.message).toContain('8');
  });

  test('rollup paths are partition files', () => {
    expect(PARTITION_FILE_RE.test('data/partitions/000012/span_rollups.parquet')).toBe(true);
    expect(PARTITION_FILE_RE.test('data/partitions/000012/log_rollups.parquet')).toBe(true);
    expect(PARTITION_FILE_RE.test('data/partitions/000012/other_rollups.parquet')).toBe(false);
  });
});

describe('manifest format 7', () => {
  type Raw = Record<string, unknown> & {
    partitions: { files: { widget_traces?: unknown; span_rollups?: unknown } & Record<string, unknown> }[];
  };
  const v7Raw = (extra: Record<string, unknown> = {}): Raw => {
    const { epochUnixNano: _e, ...rest } = v5();
    const m = { ...rest, formatVersion: 7 } as unknown as Raw;
    const entry = (path: string, more: Record<string, unknown>) => ({
      path,
      bytes: 10,
      rows: 1,
      timeMin: null,
      timeMax: null,
      values: {},
      ...more,
    });
    const files = {
      ...m.partitions[0]?.files,
      widget_traces: entry(partitionFilePath(0, 'widget_traces'), {
        widgetIndex: { conditions: ['0123456789abcdef'], variables: ['job'] },
      }),
      span_rollups: entry(partitionFilePath(0, 'span_rollups'), {
        rollup: { grainNs: 65_536_000_000, dimensions: ['name'], refused: ['attr:k'] },
        ...extra,
      }),
    };
    return { ...m, partitions: [{ ...m.partitions[0], files }, ...m.partitions.slice(1)] };
  };
  const without = (m: Raw, table: string, drop: string): Raw => {
    const first = m.partitions[0];
    const file = { ...(first?.files[table] as Record<string, unknown>) };
    delete file[drop];
    return { ...m, partitions: [{ ...first, files: { ...first?.files, [table]: file } }] };
  };

  test('parses a widget_traces file with widgetIndex and a rollup that lists refused keys', () => {
    const m = parseAnyManifest(v7Raw()) as ManifestV4;
    expect(m.formatVersion).toBe(7);
    expect(m.partitions[0]?.files.widget_traces?.widgetIndex).toEqual({
      conditions: ['0123456789abcdef'],
      variables: ['job'],
    });
    expect(m.partitions[0]?.files.span_rollups?.rollup?.refused).toEqual(['attr:k']);
    expect(manifestAnchor(m)).toBe(-5n);
  });

  test('formats 5 and 6 reject a widget_traces entry and, separately, a refused field', () => {
    const raw = v7Raw();
    const first = raw.partitions[0];
    const { widget_traces: _w, ...noIndex } = first?.files ?? {};
    const rollup = noIndex.span_rollups as Record<string, unknown>;
    const noRefused = {
      ...noIndex,
      span_rollups: { ...rollup, rollup: { grainNs: 65_536_000_000, dimensions: ['name'] } },
    };
    for (const formatVersion of [5, 6]) {
      const older = { ...raw, formatVersion, ...(formatVersion === 5 ? { epochUnixNano: '1' } : {}) };
      const at = (files: Record<string, unknown>) => ({ ...older, partitions: [{ ...first, files }] });
      expect(() => parseAnyManifest(at({ ...noRefused, widget_traces: first?.files.widget_traces }))).toThrow(
        OtelHtmlError,
      );
      expect(() => parseAnyManifest(at(noIndex))).toThrow(OtelHtmlError);
      expect(parseAnyManifest(at(noRefused)).formatVersion).toBe(formatVersion);
    }
  });

  test('a format-7 widget_traces entry without widgetIndex is invalid-report', () => {
    const e = failure(() => parseAnyManifest(without(v7Raw(), 'widget_traces', 'widgetIndex')));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toContain('widgetIndex');
  });

  test('serializes without epochUnixNano and parses back equal', () => {
    const m = parseAnyManifest(v7Raw());
    const stored = manifestForWrite(m) as Record<string, unknown>;
    expect('epochUnixNano' in stored).toBe(false);
    expect(parseAnyManifest(JSON.parse(JSON.stringify(stored)))).toEqual(m);
  });
});

describe('manifest format 6', () => {
  type Raw = Record<string, unknown> & {
    partitions: { files: { spans?: Record<string, unknown>; traces?: Record<string, unknown> } }[];
  };
  const v6Raw = (): Raw => {
    const { epochUnixNano: _e, ...rest } = v5();
    const m = { ...rest, formatVersion: 6 } as unknown as Raw;
    return m;
  };
  const withTraces = (extra: Record<string, unknown>): Raw => {
    const m = v6Raw();
    const traces = {
      path: partitionFilePath(0, 'traces'),
      bytes: 10,
      rows: 1,
      timeMin: '-5',
      timeMax: '10',
      values: {},
      ...extra,
    };
    const parts = m.partitions;
    return { ...m, partitions: parts.map((p, i) => (i === 0 ? { ...p, files: { ...p.files, traces } } : p)) };
  };

  test('accepts format 5 without epochUnixNano, and serviceShare on traces', () => {
    expect(parseAnyManifest(v6Raw()).formatVersion).toBe(6);
    const m = parseAnyManifest(withTraces({ serviceShare: true })) as ManifestV4;
    expect(m.partitions[0]?.files.traces?.serviceShare).toBe(true);
  });

  test('rejects epochUnixNano, serviceShare on spans or false, and serviceShare under 5', () => {
    expect(() => parseAnyManifest({ ...v6Raw(), epochUnixNano: '1' })).toThrow(OtelHtmlError);
    expect(() => parseAnyManifest(withTraces({ serviceShare: false }))).toThrow(OtelHtmlError);
    const m = v6Raw();
    const parts = m.partitions;
    const onSpans = {
      ...m,
      partitions: [{ ...parts[0], files: { spans: { ...parts[0]?.files.spans, serviceShare: true } } }],
    };
    expect(() => parseAnyManifest(onSpans)).toThrow(OtelHtmlError);
    expect(() =>
      parseAnyManifest({ ...withTraces({ serviceShare: true }), formatVersion: 5, epochUnixNano: '1' }),
    ).toThrow(OtelHtmlError);
  });

  test('the parsed anchor is range.start, or createdAt in ns when range is null', () => {
    const m = parseAnyManifest(v6Raw()) as ManifestV4;
    expect(manifestAnchor(m)).toBe(-5n);
    const empty = parseAnyManifest({ ...v6Raw(), range: null }) as ManifestV4;
    expect(manifestAnchor(empty)).toBe(BigInt(Date.parse('2026-11-06T00:00:00.000Z')) * 1_000_000n);
    expect(manifestAnchor(v5())).toBe(1_700_000_000_000_000_000n);
  });

  test('serializes without epochUnixNano and parses back equal', () => {
    const m = parseAnyManifest(withTraces({ serviceShare: true }));
    const stored = manifestForWrite(m) as Record<string, unknown>;
    expect('epochUnixNano' in stored).toBe(false);
    expect(parseAnyManifest(JSON.parse(JSON.stringify(stored)))).toEqual(m);
    expect(manifestForWrite(v5())).toEqual(v5());
  });
});
