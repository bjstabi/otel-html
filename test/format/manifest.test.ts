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
  rollups: ['spans', 'logs', 'metrics'],
  traceShards: ['5b'],
  config: { viewer: { eagerBudgetBytes: 75_000_000, listCap: 10_000, theme: 'system' } },
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
    expect(FORMAT_VERSION).toBe(1);
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
  test('rejects wrong format version with a precise path', () => {
    const e = failure(() => parseManifest({ ...manifest(), formatVersion: 2 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('manifest.formatVersion');
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
  };
  test('valid state parses', () => {
    expect(SessionStateSchema.parse(state)).toEqual(state);
    expect(parseSessionState({ ...state, epochUnixNano: '5' }).epochUnixNano).toBe('5');
  });
  test('rejects with precise path', () => {
    expect(failure(() => parseSessionState({ ...state, nextChunk: { spans: 1, logs: 1 } })).path).toBe(
      'state.nextChunk.metrics',
    );
    expect(failure(() => parseSessionState({ ...state, formatVersion: 3 })).code).toBe('invalid-report');
  });
});
