import { describe, expect, test } from 'vitest';
import { parseAnySessionState, type SessionStateV2 } from '../../src/format/state.js';
import { OtelHtmlError } from '../../src/model/errors.js';

const v2 = (): SessionStateV2 => ({
  formatVersion: 2,
  otelHtmlVersion: '0.3.0',
  epochUnixNano: '1700000000000000000',
  nextPartition: 5,
  flushPartitions: [1, 3, 4],
  dedupe: ['a'],
  metricStreams: null,
  drain: { pending: [1, 2] },
  statisticsKeys: { spans: ['name'], logs: [], points: [], traces: [], patterns: [] },
});

const v1 = (): unknown => ({
  formatVersion: 1,
  otelHtmlVersion: '0.1.0',
  epochUnixNano: null,
  nextChunk: { spans: 0, logs: 0, metrics: 0 },
  rollups: {},
  dedupe: [],
  traceIndex: {},
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

describe('writer state v2', () => {
  test('parses, and a v1 state still parses through parseAnySessionState', () => {
    expect(parseAnySessionState(v2())).toEqual(v2());
    expect(parseAnySessionState(v1())).toMatchObject({ formatVersion: 1, nextChunk: { spans: 0 } });
  });

  test('flushPartitions must be strictly increasing and below nextPartition', () => {
    expect(failure(() => parseAnySessionState({ ...v2(), flushPartitions: [1, 1] })).path).toBe(
      'state.flushPartitions[1]',
    );
    expect(failure(() => parseAnySessionState({ ...v2(), flushPartitions: [3, 2] })).path).toBe(
      'state.flushPartitions[1]',
    );
    expect(failure(() => parseAnySessionState({ ...v2(), flushPartitions: [1, 5] })).path).toBe(
      'state.flushPartitions[1]',
    );
  });

  test('an unknown key, a missing drain and an unknown formatVersion are invalid-report at their path', () => {
    expect(failure(() => parseAnySessionState({ ...v2(), extra: 1 })).path).toBe('state');
    const { drain: _drain, ...noDrain } = v2();
    expect(failure(() => parseAnySessionState(noDrain)).path).toBe('state.drain');
    const e = failure(() => parseAnySessionState({ ...v2(), formatVersion: 3 }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('state.formatVersion');
    expect(failure(() => parseAnySessionState(null)).path).toBe('state.formatVersion');
  });

  test('statisticsKeys is strict over the five tables', () => {
    const s = { ...v2(), statisticsKeys: { spans: [], logs: [], points: [], traces: [] } };
    expect(failure(() => parseAnySessionState(s)).path).toBe('state.statisticsKeys.patterns');
  });

  test('a bigint formatVersion is invalid-report, and non-objects are described, not "missing"', () => {
    const e = failure(() => parseAnySessionState({ ...v2(), formatVersion: 2n }));
    expect(e.code).toBe('invalid-report');
    expect(e.path).toBe('state.formatVersion');
    expect(failure(() => parseAnySessionState(null)).actual).toBe('null');
    expect(failure(() => parseAnySessionState(7)).actual).toBe('7');
    expect(failure(() => parseAnySessionState({})).actual).toBe('nothing (missing)');
  });
});
