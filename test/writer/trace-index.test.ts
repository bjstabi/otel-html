import { describe, expect, test } from 'vitest';
import { type TraceShard, TraceShardSchema } from '../../src/format/trace-shard.js';
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

/** A deep copy of one shard as the state would hold it. It takes a snapshot, which clears the dirty set, and releases it straight away. */
function payloadOf(idx: TraceIndex, shard: string): TraceShard {
  const snap = idx.snapshot();
  try {
    const out: TraceShard = {};
    for (const [id, e] of snap.entries(shard))
      out[id] = { ...e, chunks: [...e.chunks], logChunks: [...e.logChunks] };
    return out;
  } finally {
    idx.release();
  }
}

const jsonOf = (idx: TraceIndex): Record<string, TraceShard> =>
  Object.fromEntries(idx.shards().map((s) => [s, payloadOf(idx, s)]));

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
    expect(payloadOf(idx, '5b')[TRACE]).toEqual({
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
    const e = payloadOf(idx, '5b')[TRACE];
    expect(e).toMatchObject({ start: 100, end: 200, spans: 1, logs: 2 });
    expect(e?.logChunks).toEqual(['chunks/logs/000000', 'chunks/logs/000001']);
  });

  test('logs widen timing while there are no spans; same-chunk logs are listed once', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog({ time: 50 as RelNanos, observedTime: 50 as RelNanos }), 'chunks/logs/000000');
    idx.addLog(mkLog({ time: 80 as RelNanos, observedTime: 80 as RelNanos }), 'chunks/logs/000000');
    expect(payloadOf(idx, '5b')[TRACE]).toMatchObject({
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
    expect(payloadOf(idx, '5b')[TRACE]?.spans).toBe(0);
  });

  test('round-trips through load with the schema', () => {
    const idx = new TraceIndex();
    idx.addLog(mkLog(), 'chunks/logs/000000');
    const back = TraceIndex.load({ '5b': TraceShardSchema.parse(payloadOf(idx, '5b')) });
    expect(jsonOf(back)).toEqual(jsonOf(idx));
  });
});

describe('TraceIndex', () => {
  test('a root-less (orphan) trace has root null and grows as spans arrive', () => {
    const idx = new TraceIndex();
    idx.add(mk(2, { start: 50 as RelNanos }), 'chunks/spans/000000', resource);
    expect(payloadOf(idx, '5b')[TRACE]).toEqual({
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
    const e = payloadOf(idx, '5b')[TRACE];
    expect(e?.chunks).toEqual(['chunks/spans/000000', 'chunks/spans/000007', 'chunks/spans/000009']);
    expect(e).toMatchObject({ spans: 4, errors: 1, start: 100, end: 900 });
    expect(e?.root).toEqual({ service: 'frontend', name: 'GET /cart', resource: 'GET /cart' });
  });

  test('dirty tracking, shard listing and a validated JSON round-trip', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    expect(idx.dirtyShards()).toEqual(['5b']);
    idx.snapshot();
    idx.release();
    expect(idx.dirtyShards()).toEqual([]);
    const json = jsonOf(idx);
    expect(TraceShardSchema.parse(json['5b'])).toEqual(json['5b']);
    const loaded = TraceIndex.load(json);
    expect(loaded.shards()).toEqual(['5b']);
    expect(loaded.dirtyShards()).toEqual(['5b']);
    expect(jsonOf(loaded)).toEqual(json);
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
  const entryOf = (idx: TraceIndex, id: string) => Object.values(payloadOf(idx, id.slice(0, 2)))[0];

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
    const json = JSON.parse(JSON.stringify(jsonOf(idx)));
    const loaded = TraceIndex.load(json);
    expect(jsonOf(loaded)).toEqual(jsonOf(idx));
    loaded.addLog(mkLog({ traceId: T2 }), 'chunks/logs/000000');
    expect(entryOf(loaded, T2)?.logChunks).toEqual(['chunks/logs/000000']);
    expect(entryOf(loaded, TRACE)?.logChunks).toEqual([]);
  });
});

describe('TraceIndex shared roots and chunk lists', () => {
  const T2 = parseTraceId('aa8efff798038103d269b633813fc60c', 't2');
  const T3 = parseTraceId('cc8efff798038103d269b633813fc60c', 't3');
  const live = (idx: TraceIndex, id: string) => {
    const snap = idx.snapshot();
    const e = snap.entries(id.slice(0, 2)).get(id);
    idx.release();
    return e;
  };

  test('traces with equal roots share one frozen root; a different root is its own', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2 }), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T3, name: 'other' }), 'chunks/spans/000000', resource);
    const a = live(idx, TRACE)?.root;
    expect(live(idx, T2)?.root).toBe(a);
    expect(live(idx, T3)?.root).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as { name: string }).name = 'x';
    }).toThrow();
  });

  test('triples that differ only around a NUL keep their own roots', () => {
    const entry = (service: string, name: string) => ({
      chunks: ['chunks/spans/000000'],
      logChunks: [],
      start: 1,
      end: 2,
      spans: 1,
      logs: 0,
      errors: 0,
      root: { service, name, resource: 'r' },
    });
    const idx = TraceIndex.load({
      '5b': { [TRACE]: entry('a\u0000b', 'c') },
      aa: { [T2]: entry('a', 'b\u0000c') },
    });
    const a = live(idx, TRACE)?.root;
    const b = live(idx, T2)?.root;
    expect(a).toEqual({ service: 'a\u0000b', name: 'c', resource: 'r' });
    expect(b).toEqual({ service: 'a', name: 'b\u0000c', resource: 'r' });
  });

  test('past the intern cap a root is still frozen and correct', () => {
    const idx = new TraceIndex({ internCap: 1 });
    idx.add(mk(1, { name: 'first' }), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2, name: 'second' }), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T3, name: 'second' }), 'chunks/spans/000000', resource);
    expect(Object.isFrozen(live(idx, T3)?.root)).toBe(true);
    expect(live(idx, T3)?.root?.name).toBe('second');
  });

  test('entries with the same first chunk share a frozen list; a second chunk gives that entry its own', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2 }), 'chunks/spans/000000', resource);
    idx.addLog(mkLog(), 'chunks/logs/000000');
    idx.addLog(mkLog({ traceId: T2 }), 'chunks/logs/000000');
    const first = live(idx, TRACE);
    const second = live(idx, T2);
    expect(first?.chunks).toBe(second?.chunks);
    expect(first?.logChunks).toBe(second?.logChunks);
    expect(Object.isFrozen(first?.chunks)).toBe(true);
    const shared = first?.chunks;
    idx.add(mk(2), 'chunks/spans/000001', resource);
    idx.addLog(mkLog(), 'chunks/logs/000001');
    expect(live(idx, TRACE)?.chunks).toEqual(['chunks/spans/000000', 'chunks/spans/000001']);
    expect(live(idx, TRACE)?.logChunks).toEqual(['chunks/logs/000000', 'chunks/logs/000001']);
    expect(live(idx, T2)?.chunks).toBe(shared);
    expect(shared).toEqual(['chunks/spans/000000']);
    expect(live(idx, T2)?.logChunks).toEqual(['chunks/logs/000000']);
  });

  test('a new chunk after a cut gets a new shared list', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2 }), 'chunks/spans/000001', resource);
    expect(live(idx, T2)?.chunks).toEqual(['chunks/spans/000001']);
    expect(live(idx, TRACE)?.chunks).toEqual(['chunks/spans/000000']);
  });

  test('load shares roots and one-element lists, and serializes as before', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    idx.add(mk(1, { traceId: T2 }), 'chunks/spans/000000', resource);
    idx.add(mk(2, { traceId: T2 }), 'chunks/spans/000001', resource);
    const json = JSON.parse(JSON.stringify(jsonOf(idx)));
    const loaded = TraceIndex.load(json);
    expect(JSON.stringify(jsonOf(loaded))).toBe(JSON.stringify(jsonOf(idx)));
    const fresh = TraceIndex.load({ ...json, cc: { [T3]: { ...json['5b'][TRACE] } } });
    expect(live(fresh, T3)?.root).toBe(live(fresh, TRACE)?.root);
    expect(live(fresh, T3)?.chunks).toBe(live(fresh, TRACE)?.chunks);
    expect(Object.isFrozen(live(fresh, TRACE)?.root)).toBe(true);
    fresh.add(mk(3), 'chunks/spans/000002', resource);
    expect(live(fresh, T3)?.chunks).toEqual(['chunks/spans/000000']);
  });
});

describe('TraceIndex snapshot', () => {
  const shard = TRACE.slice(0, 2);

  test('entries in a held snapshot are not changed by further adds or logs; new entries stay out of it', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    const snap = idx.snapshot();
    expect(snap.dirty).toEqual([shard]);
    idx.add(mk(2), 'chunks/spans/000001', resource);
    idx.addLog(mkLog(), 'chunks/logs/000000');
    const other = parseTraceId('ffffffffffffffffffffffffffffffff', 't');
    idx.add(mk(3, { traceId: other }), 'chunks/spans/000002', resource);
    const held = snap.entries(shard).get(TRACE);
    expect(held).toMatchObject({ spans: 1, logs: 0, chunks: ['chunks/spans/000000'], logChunks: [] });
    expect(snap.entries('ff').size).toBe(0);
    idx.release();
    expect(payloadOf(idx, shard)[TRACE]).toMatchObject({ spans: 2, logs: 1 });
    idx.add(mk(4), 'chunks/spans/000003', resource);
    expect(payloadOf(idx, shard)[TRACE]).toMatchObject({ spans: 3 });
    expect(held?.spans).toBe(1);
  });

  test('a new trace in an existing shard, and one in a new shard, stay out of the snapshot', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    const snap = idx.snapshot();
    const sameShard = parseTraceId(`${shard}${'0'.repeat(30)}`, 't');
    const newShard = parseTraceId('ee'.repeat(16), 't');
    idx.add(mk(2, { traceId: sameShard }), 'chunks/spans/000001', resource);
    idx.add(mk(3, { traceId: newShard }), 'chunks/spans/000002', resource);
    expect([...snap.entries(shard).keys()]).toEqual([TRACE]);
    expect(snap.entries('ee').size).toBe(0);
    idx.release();
    expect(Object.keys(payloadOf(idx, shard)).sort()).toEqual([TRACE, sameShard].sort());
    expect(Object.keys(payloadOf(idx, 'ee'))).toEqual([newShard]);
    expect(Object.keys(jsonOf(idx))).toContain('ee');
    const next = idx.snapshot();
    expect([...next.entries(shard).keys()].sort()).toEqual([TRACE, sameShard].sort());
    expect([...next.entries('ee').keys()]).toEqual([newShard]);
  });

  test('a shard untouched while a snapshot is held is not copied', () => {
    const idA = parseTraceId(`aa${'0'.repeat(30)}`, 't');
    const idB = parseTraceId(`bb${'0'.repeat(30)}`, 't');
    const idx = new TraceIndex();
    idx.add(mk(1, { traceId: idA }), 'chunks/spans/000000', resource);
    idx.add(mk(2, { traceId: idB }), 'chunks/spans/000000', resource);
    const snap1 = idx.snapshot();
    const a1 = snap1.entries('aa').get(idA);
    const b1 = snap1.entries('bb').get(idB);
    idx.add(mk(3, { traceId: idB }), 'chunks/spans/000000', resource);
    idx.release();
    const snap2 = idx.snapshot();
    expect(snap2.entries('aa').get(idA)).toBe(a1);
    expect(snap2.entries('bb').get(idB)).not.toBe(b1);
    idx.release();
  });

  test('restoreDirty marks shards dirty again', () => {
    const idx = new TraceIndex();
    idx.add(mk(1), 'chunks/spans/000000', resource);
    const snap = idx.snapshot();
    idx.release();
    idx.restoreDirty(snap.dirty);
    expect(idx.dirtyShards()).toEqual([shard]);
  });
});
