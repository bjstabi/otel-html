import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { parseExemplarFile } from '../../src/format/metric-files.js';
import { SessionStateSchema } from '../../src/format/state.js';
import { TraceShardSchema } from '../../src/format/trace-shard.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseUnixNanos, type RelNanos } from '../../src/model/ids.js';
import { Drain } from '../../src/rollups/drain.js';
import { openSession, type RecordBatch, type WriterSession } from '../../src/writer/session.js';
import {
  gauge,
  logRecord,
  logsRequest,
  metricsRequest,
  realisticSpans,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';
import {
  createProcess,
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import {
  allLogs,
  allPoints,
  allSpans,
  counterRequest,
  cumulativeRequest,
  levelsOf,
  logRollupsOf,
  manifestOf,
  metricCatalogOf,
  metricFilesOnDisk,
  readChunk,
  readDataFile,
  spanIdOf,
  spansRequest,
  traceIdOf,
} from './helpers.js';

const OUT = 'r';
const epoch = parseUnixNanos(EPOCH_NS, 'epoch');

function spanBatch(n: number): RecordBatch {
  const f = realisticSpans(n);
  return { signal: 'spans', rows: f.spans, resources: f.resources, scopes: f.scopes, epoch };
}

async function open(w: TestWriter, config = testConfig()): Promise<WriterSession> {
  return openSession(w.deps, { out: OUT, config, mode: 'create' });
}

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('create -> add -> close', () => {
  test('writes a complete report', async () => {
    const w = createTestWriter();
    const s = await open(w);
    expect(await s.addRecords(spanBatch(2_000))).toEqual({ accepted: 2_000, dropped: 0, duplicates: 0 });
    const summary = await s.close();
    expect(summary.totals).toEqual({ spans: 2_000, logs: 0, metrics: 0 });
    const m = manifestOf(w, OUT);
    expect(m.complete).toBe(true);
    expect(m.epochUnixNano).toBe(EPOCH_NS);
    expect(m.totals.spans).toBe(2_000);
    expect(summary.chunks).toBe(m.chunks.length);
    expect(summary.bytes).toBe(m.chunks.reduce((n, c) => n + c.bytes, 0));
    const files = w.fs.snapshot();
    expect([...files.keys()].filter((p) => p.split('/').some((seg) => seg.startsWith('_')))).toEqual([]);
    expect(files.has('r/.nojekyll')).toBe(true);
    expect(files.has('r/index.html')).toBe(true);
    expect(files.has('r/assets/viewer.abc123.js')).toBe(true);
    expect(files.has('r/data/state/lock.json')).toBe(false);
    // every file the manifest lists exists, and the chunks decode back to every span
    for (const p of [...m.chunks.map((c) => c.path), ...m.rollups, ...m.traceShards]) {
      expect(files.has(`r/${p}`), p).toBe(true);
    }
    expect(allSpans(w, OUT)).toHaveLength(2_000);
    expect(m.range).not.toBeNull();
  });

  test('cuts chunks at chunkTargetBytes and records ranges', async () => {
    const w = createTestWriter();
    const s = await open(w, testConfig({ writer: { chunkTargetBytes: 200_000 } }));
    await s.addRecords(spanBatch(2_000));
    await s.close();
    const m = manifestOf(w, OUT);
    expect(m.chunks.length).toBeGreaterThan(2);
    expect(m.chunks.map((c) => c.n)).toEqual(m.chunks.map((_, i) => i));
    expect(m.chunks.reduce((n, c) => n + c.count, 0)).toBe(2_000);
    for (const c of m.chunks) {
      expect(readChunk(w, OUT, 'spans', c.n)).toHaveLength(c.count);
      expect(c.start).toBeLessThanOrEqual(c.end);
    }
    expect(m.decodedBytes).toBeGreaterThan(0);
  });

  test('index.html escapes the title', async () => {
    const w = createTestWriter();
    const s = await open(w, testConfig({ title: '</title><script>alert(1)</script>' }));
    await s.close();
    const html = w.fs.snapshot().get('r/index.html') ?? '';
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('type="module"');
    expect(html).toContain('<script>window.__OH__={q:[],push(k,p){this.q.push([k,p])}}</script>');
    expect(html.indexOf('window.__OH__')).toBeLessThan(html.indexOf('data/manifest.js'));
    expect(html.indexOf('data/manifest.js')).toBeLessThan(html.indexOf('assets/viewer.abc123.js'));
    expect(manifestOf(w, OUT).title).toBe('</title><script>alert(1)</script>');
  });

  test('empty input is a valid complete report', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const summary = await s.close();
    expect(summary).toEqual({ out: OUT, totals: { spans: 0, logs: 0, metrics: 0 }, chunks: 0, bytes: 0 });
    const m = manifestOf(w, OUT);
    expect(m).toMatchObject({ complete: true, range: null, chunks: [], traceShards: [], epochUnixNano: '0' });
    expect(m.rollups).toHaveLength(3);
    expect(w.fs.snapshot().has('r/index.html')).toBe(true);
  });

  test('logs-only input is valid, with zero spans and no trace shards', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const logs = [
      logRecord({ severityNumber: 9, timeUnixNano: String(BigInt(EPOCH_NS) + 10n) }),
      logRecord({ severityNumber: 17, timeUnixNano: String(BigInt(EPOCH_NS) + 20n) }),
      logRecord({
        severityNumber: 0,
        timeUnixNano: '0',
        observedTimeUnixNano: String(BigInt(EPOCH_NS) + 30n),
      }),
    ];
    expect(await s.add(otlp(logsRequest(logs)), 'l.json')).toEqual({
      accepted: 3,
      dropped: 0,
      duplicates: 0,
    });
    const summary = await s.close();
    expect(summary.totals).toEqual({ spans: 0, logs: 3, metrics: 0 });
    const m = manifestOf(w, OUT);
    expect(m.traceShards).toEqual([]);
    expect(m.epochUnixNano).toBe(String(BigInt(EPOCH_NS) + 10n));
    expect(allLogs(w, OUT).map((l) => l.time)).toEqual([0, 10, null]);
    expect(m.range).toEqual({ start: 0, end: 20 });
  });

  test('log rollups hold severity buckets, facets and patterns in arrival order', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const bodies = ['user 1 logged in', 'user 2 logged in', 'disk full on /dev/sda', 'user 3 logged in'];
    const logs = bodies.map((body, i) =>
      logRecord({
        body: { stringValue: body },
        severityNumber: i === 2 ? 17 : 9,
        timeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i * 10)),
      }),
    );
    await s.add(otlp(logsRequest(logs)), 'l.json');
    await s.close();
    const r = logRollupsOf(w, OUT);
    expect(r.buckets.total('error')).toBe(1);
    expect(r.buckets.total('info')).toBe(3);
    const fresh = new Drain();
    for (const [i, body] of bodies.entries())
      fresh.add(body, i === 2 ? 'error' : 'info', (i * 10) as RelNanos);
    expect(r.patterns.toJSON()).toEqual(fresh.toJSON());
    expect(r.patterns.clusters()).toHaveLength(2);
  });

  test('metrics points are stored and counted', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const pts = [
      { timeUnixNano: String(BigInt(EPOCH_NS) + 5n), asInt: '1' },
      { timeUnixNano: String(BigInt(EPOCH_NS) + 9n), asInt: '2' },
    ];
    await s.add(otlp(metricsRequest([gauge('g', pts)])), 'm.json');
    expect((await s.close()).totals.metrics).toBe(2);
    expect(allPoints(w, OUT).map((p) => p.time)).toEqual([0, 4]);
  });

  test('state checkpoint and trace shards validate against their schemas', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.addRecords(spanBatch(300));
    await s.close();
    const files = w.fs.snapshot();
    const states = [...files].filter(([p]) => /data\/state\/session\.[01]\.json$/.test(p));
    expect(states.length).toBeGreaterThan(0);
    for (const [, text] of states) SessionStateSchema.parse(JSON.parse(text));
    for (const p of manifestOf(w, OUT).traceShards) {
      const shard = p.slice('data/traces/'.length, -'.js'.length);
      const text = files.get(`r/${p}`) ?? '';
      TraceShardSchema.parse(reviveDataJson(unwrapDataFile(text, `traces/${shard}`)));
    }
  });
});

describe('epoch', () => {
  test('is the minimum first-batch timestamp, not the first one seen', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const t = (ns: number): string => String(BigInt(EPOCH_NS) + BigInt(ns));
    await s.add(
      otlp(
        traceRequest([
          span({ spanId: spanIdOf(1), startTimeUnixNano: t(900), endTimeUnixNano: t(950) }),
          span({ spanId: spanIdOf(2), startTimeUnixNano: t(100), endTimeUnixNano: t(150) }),
          span({ spanId: spanIdOf(3), startTimeUnixNano: t(500), endTimeUnixNano: t(550) }),
        ]),
      ),
      'a.json',
    );
    await s.close();
    expect(manifestOf(w, OUT).epochUnixNano).toBe(t(100));
    expect(allSpans(w, OUT).map((x) => x.start)).toEqual([800, 0, 400]);
  });

  test('never changes: later records before it get negative offsets', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(1, 1_000, 0)), 'a.json');
    await s.add(otlp(spansRequest(1, 0, 1)), 'b.json');
    await s.close();
    const m = manifestOf(w, OUT);
    expect(m.epochUnixNano).toBe(String(BigInt(EPOCH_NS) + 1_000n));
    expect(allSpans(w, OUT).map((x) => x.start)).toEqual([0, -1000]);
    expect(m.range?.start).toBe(-1000);
  });

  test('a record beyond +/-2^53 ns fails fast and stores nothing', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(1)), 'a.json');
    const far = 2n ** 54n;
    await expect(s.add(otlp(spansRequest(1, Number(far), 5)), 'far.json')).rejects.toMatchObject({
      code: 'time-out-of-range',
    });
    expect(await s.close().then((x) => x.totals.spans)).toBe(1);
  });

  test('falls back to the clock when the first data carries no timestamps', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(logsRequest([logRecord({ timeUnixNano: '0', observedTimeUnixNano: '0' })])), 'l.json');
    await s.close();
    expect(manifestOf(w, OUT).epochUnixNano).toBe(EPOCH_NS);
  });

  test('addRecords rebases a batch recorded against another epoch', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(1)), 'a.json');
    const f = realisticSpans(3);
    const later = parseUnixNanos(BigInt(EPOCH_NS) + 5_000n, 'e');
    await s.addRecords({
      signal: 'spans',
      rows: f.spans,
      resources: f.resources,
      scopes: f.scopes,
      epoch: later,
    });
    await s.close();
    const spans = allSpans(w, OUT);
    expect(spans).toHaveLength(4);
    expect(spans.slice(1).map((x) => x.start)).toEqual(f.spans.map((x) => x.start + 5_000));
  });
});

describe('dedupe and drop', () => {
  test('duplicates on (trace_id, span_id) are counted, not stored', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const first = await s.addRecords(spanBatch(2_000));
    const again = await s.addRecords(spanBatch(2_000));
    expect(first.accepted).toBe(2_000);
    expect(again).toEqual({ accepted: 0, dropped: 0, duplicates: 2_000 });
    expect((await s.close()).totals.spans).toBe(2_000);
    expect(allSpans(w, OUT)).toHaveLength(2_000);
  });

  test('drop conditions apply to every signal and are not deduped', async () => {
    const w = createTestWriter();
    const config = testConfig({
      writer: {
        drop: {
          traces: { span: ['name == "noisy"'] },
          logs: { log_record: ['severity_number < 9'] },
          metrics: { datapoint: ['metric.name == "skip"'] },
        },
      },
    });
    const s = await open(w, config);
    const spans = await s.add(
      otlp(
        traceRequest([
          span({ spanId: spanIdOf(1), name: 'noisy' }),
          span({ spanId: spanIdOf(2), name: 'ok' }),
        ]),
      ),
      'a.json',
    );
    expect(spans).toEqual({ accepted: 1, dropped: 1, duplicates: 0 });
    const logs = await s.add(
      otlp(logsRequest([logRecord({ severityNumber: 5 }), logRecord({ severityNumber: 9 })])),
      'l.json',
    );
    expect(logs).toEqual({ accepted: 1, dropped: 1, duplicates: 0 });
    const m = await s.add(
      otlp(
        metricsRequest([
          gauge('skip', [{ timeUnixNano: EPOCH_NS, asInt: '1' }]),
          gauge('keep', [{ timeUnixNano: EPOCH_NS, asInt: '1' }]),
        ]),
      ),
      'm.json',
    );
    expect(m).toEqual({ accepted: 1, dropped: 1, duplicates: 0 });
    // a dropped span's id is not remembered
    expect(
      (await s.add(otlp(traceRequest([span({ spanId: spanIdOf(1), name: 'noisy' })])), 'b.json')).dropped,
    ).toBe(1);
    expect((await s.close()).totals).toEqual({ spans: 1, logs: 1, metrics: 1 });
  });

  test('bad OTTL fails at open before anything is written', async () => {
    const w = createTestWriter();
    const config = testConfig({ writer: { drop: { traces: { span: ['span.nmae == "x"'] } } } });
    const e = await failure(open(w, config));
    expect(e.code).toBe('invalid-ottl');
    expect(w.fs.snapshot().size).toBe(0);
    expect(await w.fs.exists(OUT)).toBe(false);
  });
});

describe('trace index', () => {
  test('orphans and split traces are indexed across chunks', async () => {
    const w = createTestWriter();
    const s = await open(w, testConfig({ writer: { chunkTargetBytes: 1 } })); // every span is its own chunk
    const mkSpan = (i: number, parent: number | null, trace = 1): ReturnType<typeof span> =>
      span({
        traceId: traceIdOf(trace),
        spanId: spanIdOf(i),
        ...(parent === null ? {} : { parentSpanId: spanIdOf(parent) }),
        name: `s${i}`,
        startTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i)),
        endTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i) + 10n),
      });
    // child whose parent (id 1) never arrives, then a sibling in a later chunk; plus a complete trace
    await s.add(otlp(traceRequest([mkSpan(2, 1)])), 'a.json');
    await s.add(otlp(traceRequest([mkSpan(3, 1)])), 'b.json');
    await s.add(otlp(traceRequest([mkSpan(10, null, 2), mkSpan(11, 10, 2)])), 'c.json');
    await s.flush();
    const shard = async (trace: number): Promise<Record<string, unknown>> => {
      const id = traceIdOf(trace);
      const text = w.fs.snapshot().get(`r/data/traces/${id.slice(0, 2)}.js`) ?? '';
      return TraceShardSchema.parse(
        reviveDataJson(unwrapDataFile(text, `traces/${id.slice(0, 2)}`)),
      ) as never;
    };
    const orphan = (await shard(1))[traceIdOf(1)];
    expect(orphan).toMatchObject({
      chunks: ['chunks/spans/000000', 'chunks/spans/000001'],
      spans: 2,
      errors: 0,
      root: null,
    });
    const whole = (await shard(2))[traceIdOf(2)];
    expect(whole).toMatchObject({ spans: 2, root: { service: 'unknown_service', name: 's10' } });
    // the missing root arrives later: the same entry is updated, not replaced
    await s.add(otlp(traceRequest([mkSpan(1, null)])), 'd.json');
    await s.close();
    const healed = (await shard(1))[traceIdOf(1)];
    expect(healed).toMatchObject({ spans: 3, root: { name: 's1' } });
    expect(manifestOf(w, OUT).traceShards).toContain(`data/traces/${traceIdOf(1).slice(0, 2)}.js`);
  });
});

describe('flush policy and telemetry', () => {
  test('flush() lists chunks in a manifest that is not yet complete', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(10)), 'a.json');
    expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(false);
    await s.flush();
    const m = manifestOf(w, OUT);
    expect(m).toMatchObject({ complete: false, totals: { spans: 10 } });
    expect(m.chunks).toHaveLength(1);
    await s.close();
  });

  test('the flush interval is measured on the injected clock', async () => {
    const w = createTestWriter();
    const s = await open(w, testConfig({ writer: { flushIntervalMs: 5_000 } }));
    await s.add(otlp(spansRequest(1)), 'a.json');
    expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(false);
    w.clock.advance(5_000n * 1_000_000n);
    await s.add(otlp(spansRequest(1, 0, 1)), 'b.json');
    expect(manifestOf(w, OUT).totals.spans).toBe(2);
    await s.close();
  });

  test('every flush is one otel-html.flush span with counts', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(5)), 'a.json');
    await s.flush();
    const flushes = w.spans.filter((x) => x.name === 'otel-html.flush');
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ ended: true, attrs: { chunks: 1, records: 5 } });
    await s.close();
    expect(w.spans.every((x) => x.ended)).toBe(true);
  });

  test('a closed session rejects writes, and close is idempotent', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const a = await s.close();
    expect(await s.close()).toBe(a);
    await expect(s.add(otlp(spansRequest(1)), 'x.json')).rejects.toThrow(/closed/);
    await expect(s.flush()).rejects.toThrow(/closed/);
  });

  test('rejects an out-of-range severity number without storing anything', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await expect(
      s.add(
        otlp(logsRequest([logRecord({ severityNumber: 9 }), logRecord({ severityNumber: 99 })])),
        'l.json',
      ),
    ).rejects.toThrow(/severityNumber/);
    expect((await s.close()).totals.logs).toBe(0);
  });
});

describe('folders and locking', () => {
  test('create refuses a non-empty folder that is not a report', async () => {
    const w = createTestWriter();
    await w.fs.writeBytes('r/notes.txt', new Uint8Array([1]));
    const e = await failure(open(w));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('not an otel-html report');
    expect(w.fs.snapshot().get('r/notes.txt')).toBeDefined();
    expect(w.fs.snapshot().has('r/data/state/lock.json')).toBe(false);
  });

  test('second writer is refused while the first holds the lock', async () => {
    const w = createTestWriter();
    const first = await open(w);
    const other = createProcess(555);
    other.alive.add(4242);
    const e = await failure(
      openSession({ ...w.deps, process: other }, { out: OUT, config: testConfig(), mode: 'create' }),
    );
    expect(e.code).toBe('report-locked');
    expect(e.hint).toContain('otel-html serve');
    expect(e.hint).toContain('otel-html merge');
    await first.close();
  });

  test('stale lock from a dead pid is reclaimed with a warning', async () => {
    const w = createTestWriter();
    await open(w); // never closed: its process "died"
    const successor = createProcess(555);
    const s = await openSession(
      { ...w.deps, process: successor },
      { out: OUT, config: testConfig(), mode: 'create' },
    );
    expect(w.logs.some((l) => l.level === 'warn' && l.msg.includes('stale'))).toBe(true);
    await s.close();
  });

  test('create replaces an existing unlocked report completely', async () => {
    const w = createTestWriter();
    const a = await open(w, testConfig({ writer: { chunkTargetBytes: 1 } }));
    await a.add(otlp(spansRequest(5)), 'a.json');
    await a.close();
    expect(manifestOf(w, OUT).chunks).toHaveLength(5);
    const b = await open(w);
    await b.add(otlp(spansRequest(2, 0, 100)), 'b.json');
    await b.close();
    const m = manifestOf(w, OUT);
    expect(m.totals.spans).toBe(2);
    expect(m.chunks).toHaveLength(1);
    const chunkFiles = [...w.fs.snapshot().keys()].filter((p) => p.startsWith('r/data/chunks/spans/'));
    expect(chunkFiles).toEqual(['r/data/chunks/spans/000000.js']);
  });

  test('create replaces a report whose data/metrics holds a stray file (e.g. .DS_Store)', async () => {
    const w = createTestWriter();
    await (await open(w)).close();
    await w.fs.mkdirp('r/data/metrics');
    await w.fs.writeTextAtomic('r/data/metrics/.DS_Store', 'finder');
    const b = await open(w);
    await b.add(otlp(spansRequest(2)), 'b.json');
    await b.close();
    expect(manifestOf(w, OUT).totals.spans).toBe(2);
    // Not a metric directory: left alone, like any other file the writer does not own.
    expect(w.fs.snapshot().has('r/data/metrics/.DS_Store')).toBe(true);
  });

  test('append refuses a folder without a report', async () => {
    const w = createTestWriter();
    const e = await failure(openSession(w.deps, { out: OUT, config: testConfig(), mode: 'append' }));
    expect(e.code).toBe('usage');
    expect(w.fs.snapshot().size).toBe(0);
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('append continues a closed report', async () => {
    const w = createTestWriter();
    const a = await open(w);
    await a.add(otlp(spansRequest(3)), 'a.json');
    await a.close();
    const b = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'append' });
    expect((await b.add(otlp(spansRequest(3)), 'dup.json')).duplicates).toBe(3);
    await b.add(otlp(spansRequest(2, 0, 50)), 'more.json');
    const summary = await b.close();
    expect(summary.totals.spans).toBe(5);
    const m = manifestOf(w, OUT);
    expect(m.complete).toBe(true);
    expect(m.chunks.map((c) => c.n)).toEqual([0, 1]);
    expect(allSpans(w, OUT)).toHaveLength(5);
  });

  test('append from another otel-html version is refused', async () => {
    const w = createTestWriter();
    await (await open(w)).close();
    const e = await failure(
      openSession({ ...w.deps, version: '9.9.9' }, { out: OUT, config: testConfig(), mode: 'append' }),
    );
    expect(e.code).toBe('version-mismatch');
    expect(e.hint).toContain('merge');
  });
});

describe('metric series files', () => {
  const files = ['data/metrics/000000/ex.js', 'data/metrics/000000/l0.js', 'data/metrics/000000/series.js'];

  test('a cumulative counter becomes level-0 deltas and ex.js at close, with no segments left', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(
      otlp(
        counterRequest('requests', [
          [0, 1],
          [10, 3],
          [20, 6],
        ]),
      ),
      'm.json',
    );
    await s.close();
    expect(metricFilesOnDisk(w, OUT)).toEqual(files);
    expect(manifestOf(w, OUT).metricFiles).toEqual(files);
    const [l0, ...rest] = levelsOf(w, OUT, 0);
    expect(rest).toEqual([]);
    expect(l0?.series).toEqual([
      {
        id: 0,
        t: [0, 9, 19],
        a: [1, 2, 3].map((delta) => ({ k: 'counter', delta, resets: 0 })),
      },
    ]);
    expect(parseExemplarFile(readDataFile(w, OUT, files[0] ?? ''), 'ex')).toEqual({
      metric: 0,
      exemplars: [],
    });
    const catalog = metricCatalogOf(w, OUT);
    expect(catalog.entries()).toHaveLength(1);
    expect(catalog.entries()[0]).toMatchObject({ name: 'requests', series: 1, points: 3 });
  });

  test('each flush lists a new segment; state carries stream state and segment numbers', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(counterRequest('requests', [[0, 1]])), 'a.json');
    await s.flush();
    await s.add(otlp(counterRequest('requests', [[10, 3]])), 'b.json');
    await s.flush();
    expect(manifestOf(w, OUT).metricFiles).toEqual([
      'data/metrics/000000/seg-000000.js',
      'data/metrics/000000/seg-000001.js',
      'data/metrics/000000/series.js',
    ]);
    const state = SessionStateSchema.parse(
      JSON.parse(w.fs.snapshot().get('r/data/state/session.1.json') ?? ''),
    );
    expect(state.nextSegment).toEqual({ '0': 2 });
    expect(state.metricStreams).toMatchObject({ keys: ['0/0:0'], times: [10_000_000_000] });
    await s.close();
  });

  test('exemplars on points are kept with their trace ids', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const json = JSON.parse(JSON.stringify(counterRequest('requests', [[5, 2]])));
    json.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].exemplars = [
      {
        timeUnixNano: String(BigInt(EPOCH_NS) + 4_000_000_000n),
        asDouble: 0.25,
        traceId: traceIdOf(1),
        spanId: spanIdOf(1),
        filteredAttributes: [{ key: 'user', value: { stringValue: 'u1' } }],
      },
    ];
    await s.add(otlp(json), 'ex.json');
    await s.close();
    const ex = parseExemplarFile(readDataFile(w, OUT, 'data/metrics/000000/ex.js'), 'ex');
    expect(ex.exemplars).toEqual([
      {
        series: 0,
        time: -1_000_000_000, // the epoch is the point's time, 1 s after the exemplar
        value: 0.25,
        traceId: traceIdOf(1),
        spanId: spanIdOf(1),
        attributes: new Map([['user', { kind: 'string', value: 'u1' }]]),
      },
    ]);
  });

  test('a hostile metric name never reaches a path and its files read back', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const name = '</script><img src=x onerror=alert(1)>';
    await s.add(otlp(counterRequest(name, [[0, 1]], [{ key: 'k', value: { stringValue: name } }])), 'h.json');
    await s.close();
    const listed = manifestOf(w, OUT).metricFiles;
    expect(listed.length).toBeGreaterThan(0);
    for (const p of listed) {
      expect(p.startsWith('data/metrics/000000/'), p).toBe(true);
      expect(() => readDataFile(w, OUT, p)).not.toThrow();
      expect(w.fs.snapshot().get(`r/${p}`)).not.toContain('</script>');
    }
    expect(metricCatalogOf(w, OUT).entries()[0]?.name).toBe(name);
  });

  test('a malformed point rejects the whole request and leaves metric state untouched', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const bad = JSON.parse(
      JSON.stringify(
        counterRequest('requests', [
          [0, 1],
          [10, 3],
        ]),
      ),
    );
    bad.resourceMetrics[0].scopeMetrics[0].metrics.push({
      name: 'h',
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [{ timeUnixNano: EPOCH_NS, count: '2', bucketCounts: ['1'] }],
      },
    });
    await expect(s.add(otlp(bad), 'bad.json')).rejects.toThrow(OtelHtmlError);
    await s.add(
      otlp(
        counterRequest('requests', [
          [0, 1],
          [10, 3],
        ]),
      ),
      'good.json',
    );
    await s.close();
    expect(levelsOf(w, OUT, 0)[0]?.series[0]?.a).toEqual(
      [1, 2].map((delta) => ({ k: 'counter', delta, resets: 0 })),
    );
    expect(metricCatalogOf(w, OUT).entries()[0]).toMatchObject({ points: 2, series: 1 });
  });

  test('a request longer than one apply slice is still all or nothing', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const points = Array.from({ length: 300 }, (_, i): [number, number] => [i * 2, i]);
    const bad = JSON.parse(JSON.stringify(counterRequest('requests', points)));
    // the malformed point comes after two full slices of good ones
    bad.resourceMetrics[0].scopeMetrics[0].metrics.push({
      name: 'h',
      histogram: {
        aggregationTemporality: 1,
        dataPoints: [{ timeUnixNano: EPOCH_NS, count: '2', bucketCounts: ['1'] }],
      },
    });
    await expect(s.add(otlp(bad), 'bad.json')).rejects.toThrow(OtelHtmlError);
    expect(await s.add(otlp(counterRequest('requests', points)), 'good.json')).toMatchObject({
      accepted: 300,
    });
    await s.close();
    expect(metricCatalogOf(w, OUT).entries()[0]).toMatchObject({ points: 300, series: 1 });
    expect(levelsOf(w, OUT, 0)[0]?.series[0]?.t).toHaveLength(300);
  });

  const deltas = (w: TestWriter, id = 0, series = 0): [number, number, number][] => {
    const s = levelsOf(w, OUT, id)[0]?.series.find((x) => x.id === series);
    return (s?.t ?? []).map((t, i) => {
      const a = s?.a[i];
      return a?.k === 'counter' ? [t, a.delta, a.resets] : [t, Number.NaN, 0];
    });
  };

  test('a restart and a second producer sharing the series: no negative or double-counted deltas', async () => {
    const w = createTestWriter();
    const s = await open(w);
    // producer 1 starts at 0 s; producer 2 (same series identity) at 5 s; producer 1 restarts at 30 s
    await s.add(
      otlp(
        cumulativeRequest('c', [
          [0, 1, 0],
          [10, 3, 0],
          [15, 100, 5],
        ]),
      ),
      'a.json',
    );
    await s.flush();
    await s.add(
      otlp(
        cumulativeRequest('c', [
          [20, 6, 0],
          [25, 150, 5],
          [40, 2, 30],
        ]),
      ),
      'b.json',
    );
    await s.close();
    const b = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'append' });
    await b.add(
      otlp(
        cumulativeRequest('c', [
          [35, 160, 5],
          [50, 5, 30],
        ]),
      ),
      'c.json',
    );
    await b.close();
    expect(deltas(w)).toEqual([
      [0, 1, 0],
      [9, 2, 0],
      [14, 100, 0],
      [19, 3, 0],
      [24, 50, 0],
      [34, 10, 0],
      [39, 2, 1],
      [48, 3, 0],
    ]);
    expect(metricCatalogOf(w, OUT).entries()[0]).toMatchObject({ resets: 1, series: 1, points: 8 });
  });

  test('cumulative series folded into other keep their own streams', async () => {
    const w = createTestWriter();
    const s = await open(w, testConfig({ writer: { metricSeriesCap: 1 } }));
    const host = (h: string) => [{ key: 'host', value: { stringValue: h } }];
    for (const [t, i] of [
      [0, 0],
      [10, 1],
      [20, 2],
    ] as const) {
      await s.add(otlp(cumulativeRequest('c', [[t, 1 + i, 0]], host('h1'))), 'h1.json');
      await s.add(otlp(cumulativeRequest('c', [[t, 10 * (i + 1), 0]], host('h2'))), 'h2.json');
      await s.add(otlp(cumulativeRequest('c', [[t, 100 + 10 * i, 0]], host('h3'))), 'h3.json');
    }
    await s.close();
    expect(deltas(w, 0, 0)).toEqual([
      [0, 1, 0],
      [9, 1, 0],
      [19, 1, 0],
    ]);
    expect(deltas(w, 0, 1)).toEqual([
      [0, 110, 0],
      [9, 20, 0],
      [19, 20, 0],
    ]); // `other`: h2 + h3
    expect(metricCatalogOf(w, OUT).entries()[0]).toMatchObject({ resets: 0, series: 2 });
  });

  test.each(['data/metrics/000000/l1.js', 'data/metrics/000000/ex.js'])(
    'a close that fails writing %s is retried without double counting',
    async (failing) => {
      const w = createTestWriter();
      const s = await open(w);
      await s.add(
        otlp(
          counterRequest('requests', [
            [0, 1],
            [3000, 5],
          ]),
        ),
        'm.json',
      );
      w.fs.failNextWrite(failing);
      await expect(s.close()).rejects.toThrow(/injected/);
      expect(manifestOf(w, OUT).metricFiles.filter((p) => /\/l\d\.js$/.test(p))).toEqual([]);
      await s.close();
      expect(levelsOf(w, OUT, 0).map((l) => l.level)).toEqual([0, 1]);
      expect(deltas(w)).toEqual([
        [0, 1, 0],
        [2929, 4, 0],
      ]);
      expect(metricFilesOnDisk(w, OUT)).toEqual(manifestOf(w, OUT).metricFiles);
    },
  );
});
