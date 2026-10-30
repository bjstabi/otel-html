import { describe, expect, test } from 'vitest';
import { TraceShardSchema } from '../../src/format/trace-shard.js';
import { parseSpanId, parseTraceId, type RelNanos } from '../../src/model/ids.js';
import type { LogRecordRecord, SpanRecord, StatusCode } from '../../src/model/records.js';
import { DedupeSet } from '../../src/writer/dedupe.js';
import { TraceIndex } from '../../src/writer/trace-index.js';
import { realisticSpans } from '../../test-support/otlp-builders.js';

const fixture = realisticSpans(1);
const resource =
  fixture.resources[0] ??
  (() => {
    throw new Error('no resource');
  })();
const base =
  fixture.spans[0] ??
  (() => {
    throw new Error('no span');
  })();

const TRACE = parseTraceId('5b8efff798038103d269b633813fc60c', 't');
const mk = (id: number, over: Partial<SpanRecord> = {}): SpanRecord => ({
  ...base,
  traceId: TRACE,
  spanId: parseSpanId(id.toString(16).padStart(16, '0'), 's'),
  parentSpanId: id === 1 ? null : parseSpanId('0000000000000001', 'p'),
  name: id === 1 ? 'GET /cart' : `child-${id}`,
  attributes: new Map(),
  start: 100 as RelNanos,
  end: 200 as RelNanos,
  status: { code: 0 as StatusCode, message: '' },
  ...over,
});

const baseLog: LogRecordRecord = {
  time: 0 as RelNanos,
  observedTime: 0 as RelNanos,
  severityNumber: 9,
  severityText: 'INFO',
  body: { kind: 'string', value: 'hello' },
  attributes: new Map(),
  droppedAttributesCount: 0,
  flags: 0,
  traceId: null,
  spanId: null,
  eventName: '',
  resource: base.resource,
  scope: base.scope,
};
const mkLog = (over: Partial<LogRecordRecord> = {}): LogRecordRecord => ({
  ...baseLog,
  traceId: TRACE,
  spanId: null,
  time: 300 as RelNanos,
  observedTime: 300 as RelNanos,
  ...over,
});

describe('TraceIndex logs', () => {
  test('a log alone creates a span-less entry', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog(), 'chunks/logs/000000');
    expect(idx.shardPayload('5b')[TRACE]).toEqual({
      chunks: [],
      logChunks: ['chunks/logs/000000'],
      start: 300,
      end: 300,
      spans: 0,
      logs: 1,
      errors: 0,
      root: null,
    });
  });

  test('a span arriving later sets the timing; later logs no longer move it', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog({ time: 5 as RelNanos, observedTime: 5 as RelNanos }), 'chunks/logs/000000');
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.addLog(mkLog({ time: 9999 as RelNanos, observedTime: 9999 as RelNanos }), 'chunks/logs/000001');
    const e = idx.shardPayload('5b')[TRACE];
    expect(e).toMatchObject({ start: 100, end: 200, spans: 1, logs: 2 });
    expect(e?.logChunks).toEqual(['chunks/logs/000000', 'chunks/logs/000001']);
  });

  test('logs widen timing while there are no spans; same-chunk logs are listed once', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog({ time: 50 as RelNanos, observedTime: 50 as RelNanos }), 'chunks/logs/000000');
    idx.addLog(mkLog({ time: 80 as RelNanos, observedTime: 80 as RelNanos }), 'chunks/logs/000000');
    expect(idx.shardPayload('5b')[TRACE]).toMatchObject({
      logChunks: ['chunks/logs/000000'],
      start: 50,
      end: 80,
      logs: 2,
    });
  });

  test('a log without a trace id is not indexed; a span id outside the trace is harmless', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog({ traceId: null, spanId: parseSpanId('00000000000000ff', 's') }), 'chunks/logs/000000');
    expect(idx.shards()).toEqual([]);
    idx.addLog(mkLog({ spanId: parseSpanId('00000000000000ff', 's') }), 'chunks/logs/000000');
    expect(idx.shardPayload('5b')[TRACE]?.spans).toBe(0);
  });

  test('round-trips through load with the schema', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog(), 'chunks/logs/000000');
    const back = TraceIndex.load({ '5b': TraceShardSchema.parse(idx.shardPayload('5b')) });
    expect(back.toJSON()).toEqual(idx.toJSON());
  });
});

describe('TraceIndex', () => {
  test('a root-less (orphan) trace has root null and grows as spans arrive', () => {
    const idx = new TraceIndex();
    idx.add(mk(2, { start: 50 as RelNanos }), 'chunks/spans/000000', resource);
    expect(idx.shardPayload('5b')[TRACE]).toEqual({
      chunks: ['chunks/spans/000000'],
      logChunks: [],
      start: 50,
      end: 200,
      spans: 1,
      logs: 0,
      errors: 0,
      root: null,
    });
  });

  test('a split trace lists every chunk once; the root fills in when it arrives', () => {
    const idx = new TraceIndex();
    idx.add(mk(2), 'chunks/spans/000000', resource);
    idx.add(mk(3), 'chunks/spans/000000', resource);
    idx.add(
      mk(4, { status: { code: 2 as StatusCode, message: 'x' }, end: 900 as RelNanos }),
      'chunks/spans/000007',
      resource,
    );
    idx.add(mk(1), 'chunks/spans/000009', resource);
    const e = idx.shardPayload('5b')[TRACE];
    expect(e?.chunks).toEqual(['chunks/spans/000000', 'chunks/spans/000007', 'chunks/spans/000009']);
    expect(e).toMatchObject({ spans: 4, errors: 1, start: 100, end: 900 });
    expect(e?.root).toEqual({ service: 'frontend', name: 'GET /cart', resource: 'GET /cart' });
  });

  test('dirty tracking, shard listing and a validated JSON round-trip', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    expect(idx.dirtyShards()).toEqual(['5b']);
    idx.clearDirty();
    expect(idx.dirtyShards()).toEqual([]);
    const json = idx.toJSON();
    expect(TraceShardSchema.parse(json['5b'])).toEqual(json['5b']);
    const loaded = TraceIndex.load(json);
    expect(loaded.shards()).toEqual(['5b']);
    expect(loaded.dirtyShards()).toEqual(['5b']);
    expect(loaded.toJSON()).toEqual(json);
  });
});

describe('DedupeSet', () => {
  test('records and reports prior presence', () => {
    const d = new DedupeSet(10);
    expect(d.seen('a', 'b')).toBe(false);
    expect(d.seen('a', 'b')).toBe(true);
    expect(d.seen('a', 'c')).toBe(false);
  });
  test('evicts first-in-first-out at capacity', () => {
    const d = new DedupeSet(2);
    d.seen('t', '1');
    d.seen('t', '2');
    d.seen('t', '1'); // seeing again does not refresh
    d.seen('t', '3'); // evicts 1
    expect(d.size).toBe(2);
    expect(d.seen('t', '1')).toBe(false);
  });
  test('round-trips in eviction order and trims to capacity', () => {
    const d = new DedupeSet(3);
    for (const s of ['1', '2', '3']) d.seen('t', s);
    expect(DedupeSet.from(d.toJSON(), 3).toJSON()).toEqual(d.toJSON());
    expect(DedupeSet.from(d.toJSON(), 2).toJSON()).toEqual(['t2', 't3']);
  });
  test('rejects a non-positive capacity', () => {
    expect(() => new DedupeSet(0)).toThrow(/dedupeCapacity/);
  });
});

describe('TraceIndex memory shape', () => {
  const T2 = parseTraceId('aa8efff798038103d269b633813fc60c', 't2');
  const entryOf = (idx: TraceIndex, id: string) => Object.values(idx.shardPayload(id.slice(0, 2)))[0];

  test('traces do not share chunk arrays once one grows', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2 }), 'chunks/spans/000000', resource);
    idx.add(mk(2), 'chunks/spans/000001', resource);
    expect(entryOf(idx, TRACE)?.chunks).toEqual(['chunks/spans/000000', 'chunks/spans/000001']);
    expect(entryOf(idx, T2)?.chunks).toEqual(['chunks/spans/000000']);
    idx.addLog(mkLog({ traceId: T2 }), 'chunks/logs/000000');
    expect(entryOf(idx, TRACE)?.logChunks).toEqual([]);
    expect(entryOf(idx, T2)?.logChunks).toEqual(['chunks/logs/000000']);
  });

  // Interning and the shared empty list are not observable in JS (strings compare by value); the load test
  // measures them. These check the values stay right on those paths.
  test('equal root strings of different traces keep their values', () => {
    const idx = new TraceIndex();
    idx.add(mk(1, { name: 'GET /a' }), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2, name: 'GET /a' }), 'chunks/spans/000000', resource);
    expect(entryOf(idx, TRACE)?.root).toEqual(entryOf(idx, T2)?.root);
    expect(entryOf(idx, T2)?.root?.name).toBe('GET /a');
  });

  test('past the intern cap new strings are still stored correctly', () => {
    const idx = new TraceIndex({ internCap: 1 });
    idx.add(mk(1, { name: 'first' }), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2, name: 'second' }), 'chunks/spans/000000', resource);
    expect(entryOf(idx, TRACE)?.root?.name).toBe('first');
    expect(entryOf(idx, T2)?.root?.name).toBe('second');
  });

  test('load round-trips, and a loaded entry without logs can take a log chunk', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2 }), 'chunks/spans/000000', resource);
    const json = JSON.parse(JSON.stringify(idx.toJSON()));
    const loaded = TraceIndex.load(json);
    expect(loaded.toJSON()).toEqual(idx.toJSON());
    loaded.addLog(mkLog({ traceId: T2 }), 'chunks/logs/000000');
    expect(entryOf(loaded, T2)?.logChunks).toEqual(['chunks/logs/000000']);
    expect(entryOf(loaded, TRACE)?.logChunks).toEqual([]);
  });
});
