import { describe, expect, test } from 'vitest';
import { type Manifest, ManifestSchema, parseManifest } from '../../src/format/manifest.js';
import {
  chunkPath,
  LOCK_PATH,
  MANIFEST_PATH,
  rollupPath,
  STATE_DIR,
  shardOf,
  traceShardPath,
} from '../../src/format/paths.js';
import { parseSessionState, SessionStateSchema } from '../../src/format/state.js';
import { FORMAT_VERSION, REGISTRATION_GLOBAL } from '../../src/format/version.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseTraceId } from '../../src/model/ids.js';
import { TRACE_ID } from '../../test-support/otlp-builders.js';

const manifest = (): Manifest => ({
  formatVersion: 1,
  otelHtmlVersion: '0.1.0',
  title: 't',
  epochUnixNano: '1700000000000000000',
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:01.000Z',
  complete: false,
  range: { start: -5, end: 10 },
  totals: { spans: 3, logs: 0, metrics: 0 },
  decodedBytes: 1234,
  chunks: [{ signal: 'spans', n: 1, path: chunkPath('spans', 1), start: -5, end: 10, count: 3, bytes: 900 }],
  rollups: ['data/rollups/spans.js', 'data/rollups/logs.js', 'data/rollups/metrics.js'],
  traceShards: ['data/traces/5b.js'],
  metricFiles: ['data/metrics/000000/series.js', 'data/metrics/000000/seg-000003.js'],
  config: {
    viewer: {
      eagerBudgetBytes: 75_000_000,
      listCap: 10_000,
      theme: 'system',
      defaultDashboard: 'fusion',
      home: 'traces',
    },
    dashboards: [],
    views: [],
  },
});

const widgetAt = (x: number, w: number): unknown => ({ type: 'traces', x, y: 0, w, h: 6 });
const dashboardOf = (widgets: unknown[]): unknown => ({
  source: 'library API',
  dashboard: { id: 'ops', title: 'Ops', widgets },
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

describe('paths', () => {
  test('constants and helpers', () => {
    expect(FORMAT_VERSION).toBe(3);
    expect(REGISTRATION_GLOBAL).toBe('__OH__');
    expect(chunkPath('spans', 12)).toBe('data/chunks/spans/000012.js');
    expect(chunkPath('metrics', 1234567)).toBe('data/chunks/metrics/1234567.js');
    expect(traceShardPath('5b')).toBe('data/traces/5b.js');
    expect(rollupPath('logs')).toBe('data/rollups/logs.js');
    expect(MANIFEST_PATH).toBe('data/manifest.js');
    expect(STATE_DIR).toBe('data/state');
    expect(LOCK_PATH).toBe('data/state/lock.json');
    expect(shardOf(parseTraceId(TRACE_ID, 't'))).toBe('5b');
  });
  test('chunkPath rejects a bad chunk number', () => {
    expect(() => chunkPath('spans', -1)).toThrowError(/chunk number/);
    expect(() => chunkPath('spans', 1.5)).toThrowError(/chunk number/);
  });
});

describe('manifest', () => {
  test('valid manifest parses', () => {
    expect(ManifestSchema.parse(manifest())).toEqual(manifest());
    expect(parseManifest(manifest())).toEqual(manifest());
    expect(parseManifest({ ...manifest(), range: null })).toEqual({ ...manifest(), range: null });
  });
  test('a manifest written by M3 (no dashboards, views or new viewer keys) parses with defaults', () => {
    const m = manifest();
    const old = {
      ...m,
      config: { viewer: { eagerBudgetBytes: 75_000_000, listCap: 10_000, theme: 'system' } },
    };
    expect(parseManifest(old)).toEqual(m);
  });
  test('a widget outside the 12-column grid is invalid-report at its path', () => {
    const m = manifest();
    const e = failure(() =>
      parseManifest({ ...m, config: { ...m.config, dashboards: [dashboardOf([widgetAt(11, 4)])] } }),
    );
    expect(e.code).toBe('invalid-report');
    expect(e.path).toContain('manifest.config.dashboards[0]');
  });
  test('a default dashboard that names no dashboard is invalid-report', () => {
    const m = manifest();
    const viewer = { ...m.config.viewer, defaultDashboard: 'nope' };
    const e = failure(() => parseManifest({ ...m, config: { ...m.config, viewer } }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.config.viewer.defaultDashboard');
  });
  test('repeated or reserved dashboard ids are invalid-report at the id', () => {
    const m = manifest();
    const ops = dashboardOf([widgetAt(0, 6)]) as { source: string; dashboard: object };
    const fusion = { ...ops, dashboard: { ...ops.dashboard, id: 'fusion' } };
    for (const [dashboards, path] of [
      [[ops, ops], 'manifest.config.dashboards[1].dashboard.id'],
      [[fusion], 'manifest.config.dashboards[0].dashboard.id'],
    ] as const) {
      const e = failure(() => parseManifest({ ...m, config: { ...m.config, dashboards } }));
      expect(e.code).toBe('invalid-report');
      expect(e.path).toBe(path);
    }
  });
  test('repeated view ids are invalid-report at the id', () => {
    const m = manifest();
    const view = { id: 'v', title: 'V', page: 'traces' };
    const e = failure(() => parseManifest({ ...m, config: { ...m.config, views: [view, view] } }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.config.views[1].id');
  });
  test('a valid dashboard round-trips and can be the default', () => {
    const m = manifest();
    const viewer = { ...m.config.viewer, defaultDashboard: 'ops' };
    const parsed = parseManifest({
      ...m,
      config: { ...m.config, viewer, dashboards: [dashboardOf([widgetAt(0, 6)])] },
    });
    expect(parsed.config.dashboards[0]?.dashboard.id).toBe('ops');
    expect(parseManifest(parsed)).toEqual(parsed);
  });
  test('a manifest written before metric files (M2) parses with none', () => {
    const { metricFiles: _, ...old } = manifest();
    expect(parseManifest(old).metricFiles).toEqual([]);
  });
  test('a format-1 manifest still parses (the viewer falls back on its metric files)', () => {
    expect(parseManifest({ ...manifest(), formatVersion: 1 }).formatVersion).toBe(1);
  });
  test('rejects wrong format version with a precise path', () => {
    const e = failure(() => parseManifest({ ...manifest(), formatVersion: 4 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
  });
  test.each([
    [
      'chunk path with ..',
      { chunks: [{ ...manifest().chunks[0], path: 'data/chunks/../x.js' }] },
      'chunks[0].path',
    ],
    [
      'chunk path with scheme',
      { chunks: [{ ...manifest().chunks[0], path: 'https://evil.test/a.js' }] },
      'chunks[0].path',
    ],
    [
      'chunk path with leading _',
      { chunks: [{ ...manifest().chunks[0], path: '_data/chunks/spans/000001.js' }] },
      'chunks[0].path',
    ],
    [
      'chunk path absolute',
      { chunks: [{ ...manifest().chunks[0], path: '/data/chunks/spans/000001.js' }] },
      'chunks[0].path',
    ],
    [
      'chunk path not matching signal/n',
      { chunks: [{ ...manifest().chunks[0], path: 'data/chunks/logs/000001.js' }] },
      'chunks[0].path',
    ],
    ['rollup bare name', { rollups: ['spans'] }, 'rollups[0]'],
    ['rollup traversal', { rollups: ['data/rollups/../../x.js'] }, 'rollups[0]'],
    ['rollup scheme', { rollups: ['javascript:alert(1)'] }, 'rollups[0]'],
    ['shard bare id', { traceShards: ['5b'] }, 'traceShards[0]'],
    ['shard other dir', { traceShards: ['data/rollups/5b.js'] }, 'traceShards[0]'],
    ['shard uppercase', { traceShards: ['data/traces/5B.js'] }, 'traceShards[0]'],
    ['metric file by name', { metricFiles: ['data/metrics/requests/l0.js'] }, 'metricFiles[0]'],
    ['metric file traversal', { metricFiles: ['data/metrics/000000/../../x.js'] }, 'metricFiles[0]'],
    ['metric level beyond 6', { metricFiles: ['data/metrics/000000/l7.js'] }, 'metricFiles[0]'],
  ])('rejects %s', (_name, patch, path) => {
    expect(failure(() => parseManifest({ ...manifest(), ...patch })).path).toBe(`manifest.${path}`);
  });
  test('rejects a bad chunk entry with an indexed path', () => {
    const m = manifest();
    const e = failure(() => parseManifest({ ...m, chunks: [{ ...m.chunks[0], signal: 'traces' }] }));
    expect(e.path).toBe('manifest.chunks[0].signal');
  });
  test('rejects unknown keys and bad epoch', () => {
    expect(failure(() => parseManifest({ ...manifest(), extra: 1 })).path).toBe('manifest');
    expect(failure(() => parseManifest({ ...manifest(), epochUnixNano: '12x' })).path).toBe(
      'manifest.epochUnixNano',
    );
  });
});

describe('session state', () => {
  const state = {
    formatVersion: 1,
    otelHtmlVersion: '0.1.0',
    epochUnixNano: null,
    nextChunk: { spans: 1, logs: 1, metrics: 1 },
    rollups: { spans: { a: [1, 2] }, logs: {}, metrics: null },
    dedupe: ['abc'],
    traceIndex: {
      '5b': {
        [TRACE_ID]: {
          chunks: ['chunks/spans/000000'],
          logChunks: [],
          start: 0,
          end: 5,
          spans: 2,
          logs: 0,
          errors: 0,
          root: null,
        },
      },
    },
    metricStreams: { streams: [] },
    nextSegment: { '0': 2 },
  };
  test('valid state parses', () => {
    expect(SessionStateSchema.parse(state)).toEqual(state);
    const { metricStreams: _, nextSegment: __, ...old } = state;
    expect(parseSessionState(old)).toMatchObject({
      metricStreams: { keys: [], times: [], lasts: [], seriesKeys: [], seriesTimes: [] },
      nextSegment: {},
    });
    expect(failure(() => parseSessionState({ ...state, nextSegment: { x: 1 } })).code).toBe('invalid-report');
    expect(parseSessionState({ ...state, epochUnixNano: '5' }).epochUnixNano).toBe('5');
  });
  test('rejects a trace index entry with a bad chunk key', () => {
    const bad = {
      '5b': {
        [TRACE_ID]: {
          chunks: ['../x'],
          logChunks: [],
          start: 0,
          end: 1,
          spans: 1,
          logs: 0,
          errors: 0,
          root: null,
        },
      },
    };
    expect(failure(() => parseSessionState({ ...state, traceIndex: bad })).path).toBe(
      `state.traceIndex.5b.${TRACE_ID}.chunks[0]`,
    );
  });
  test('rejects a trace index entry with a bad log chunk key', () => {
    const bad = {
      '5b': {
        [TRACE_ID]: {
          chunks: [],
          logChunks: ['chunks/logs/000000', 'chunks/spans/000000'],
          start: 0,
          end: 1,
          spans: 0,
          logs: 1,
          errors: 0,
          root: null,
        },
      },
    };
    expect(failure(() => parseSessionState({ ...state, traceIndex: bad })).path).toBe(
      `state.traceIndex.5b.${TRACE_ID}.logChunks[1]`,
    );
  });
  test('rejects with precise path', () => {
    expect(failure(() => parseSessionState({ ...state, nextChunk: { spans: 1, logs: 1 } })).path).toBe(
      'state.nextChunk.metrics',
    );
    expect(failure(() => parseSessionState({ ...state, formatVersion: 3 })).code).toBe('invalid-report');
  });
});
