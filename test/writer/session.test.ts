import { describe, expect, test, vi } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseUnixNanos } from '../../src/model/ids.js';
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
  cell,
  counterRequest,
  manifestOf,
  spanIdOf,
  spansRequest,
} from './helpers.js';

const OUT = 'r';
const epoch = parseUnixNanos(EPOCH_NS, 'epoch');

function spanBatch(n: number): RecordBatch {
  const f = realisticSpans(n);
  return { signal: 'spans', rows: f.spans, resources: f.resources, scopes: f.scopes, epoch };
}

async function open(w: TestWriter, config = testConfig()): Promise<WriterSession> {
  return openSession(w.deps, { out: OUT, config, mode: 'replace' });
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
    expect(summary.chunks).toBe(m.partitions.length);
    expect(summary.bytes).toBe(
      m.partitions.reduce((n, p) => n + Object.values(p.files).reduce((k, f) => k + f.bytes, 0), 0),
    );
    const files = w.fs.snapshot();
    expect([...files.keys()].filter((p) => p.split('/').some((seg) => seg.startsWith('_')))).toEqual([]);
    expect(files.has('r/.nojekyll')).toBe(true);
    expect(files.has('r/index.html')).toBe(true);
    expect(files.has('r/assets/viewer.abc123.js')).toBe(true);
    expect(files.has('r/data/state/lock.json')).toBe(false);
    // every file the manifest lists exists, and the partitions decode back to every span
    for (const p of m.partitions)
      for (const f of Object.values(p.files)) expect(files.has(`r/${f.path}`)).toBe(true);
    expect(allSpans(w, OUT)).toHaveLength(2_000);
    expect(m.range).not.toBeNull();
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

  test('dashboards, views and the viewer keys reach the manifest', async () => {
    const w = createTestWriter();
    const cfg = testConfig({
      dashboards: [{ id: 'ops', title: 'Ops', widgets: [{ type: 'traces', x: 0, y: 0, w: 6, h: 6 }] }],
      viewer: { defaultDashboard: 'ops', home: 'dashboards' },
    });
    const s = await open(w, cfg);
    await s.close();
    const m = manifestOf(w, OUT);
    expect(m.config.dashboards[0]?.source).toBe('config file');
    expect(m.config.dashboards[0]?.dashboard.id).toBe('ops');
    expect(m.config.viewer.defaultDashboard).toBe('ops');
    expect(m.config.viewer.home).toBe('dashboards');
  });

  test('a hostile dashboard title, description and widget title round-trip through manifest.js', async () => {
    const w = createTestWriter();
    const title = '</script><img src=x onerror=alert(1)>';
    const description = 'line\u2028sep';
    const s = await open(
      w,
      testConfig({
        dashboards: [
          { id: 'ops', title, description, widgets: [{ type: 'traces', title, x: 0, y: 0, w: 6, h: 6 }] },
        ],
      }),
    );
    await s.close();
    const raw = w.fs.snapshot().get(`${OUT}/data/manifest.js`) ?? '';
    expect(raw).not.toContain('</script>');
    expect(raw).not.toContain('<img');
    expect(raw).not.toContain('\u2028');
    const d = manifestOf(w, OUT).config.dashboards[0]?.dashboard;
    expect(d?.title).toBe(title);
    expect(d?.description).toBe(description);
    expect(d?.widgets[0]?.title).toBe(title);
  });

  test('empty input is a valid complete report', async () => {
    const w = createTestWriter();
    const s = await open(w);
    const summary = await s.close();
    expect(summary).toEqual({ out: OUT, totals: { spans: 0, logs: 0, metrics: 0 }, chunks: 0, bytes: 0 });
    expect(manifestOf(w, OUT)).toMatchObject({
      complete: true,
      range: null,
      partitions: [],
      epochUnixNano: '0',
    });
    expect(w.fs.snapshot().has('r/index.html')).toBe(true);
  });
  test('logs-only input is valid, with zero spans and no traces file', async () => {
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
    expect(m.partitions.flatMap((p) => Object.keys(p.files))).not.toContain('traces');
    expect(m.epochUnixNano).toBe(String(BigInt(EPOCH_NS) + 10n));
    expect(
      allLogs(w, OUT)
        .map((l) => cell(l, 'time_unix_nano'))
        .sort(),
    ).toEqual([BigInt(EPOCH_NS) + 10n, BigInt(EPOCH_NS) + 20n, null].sort());
    expect(m.range).toEqual({ start: String(BigInt(EPOCH_NS) + 10n), end: String(BigInt(EPOCH_NS) + 30n) });
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
    expect(allPoints(w, OUT).map((p) => cell(p, 'time_unix_nano'))).toEqual([
      BigInt(EPOCH_NS) + 5n,
      BigInt(EPOCH_NS) + 9n,
    ]);
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
    expect(
      allSpans(w, OUT)
        .map((x) => cell(x, 'start_time_unix_nano'))
        .sort(),
    ).toEqual([BigInt(t(100)), BigInt(t(500)), BigInt(t(900))]);
  });

  test('never changes: later records before it get negative offsets', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(1, 1_000, 0)), 'a.json');
    await s.add(otlp(spansRequest(1, 0, 1)), 'b.json');
    await s.close();
    const m = manifestOf(w, OUT);
    expect(m.epochUnixNano).toBe(String(BigInt(EPOCH_NS) + 1_000n));
    expect(
      allSpans(w, OUT)
        .map((x) => cell(x, 'start_time_unix_nano'))
        .sort(),
    ).toEqual([BigInt(EPOCH_NS), BigInt(EPOCH_NS) + 1_000n]);
    expect(m.range?.start).toBe(EPOCH_NS);
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
    const starts = spans.map((x) => cell(x, 'start_time_unix_nano'));
    for (const x of f.spans) expect(starts).toContain(BigInt(EPOCH_NS) + 5_000n + BigInt(x.start));
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

describe('flush policy and telemetry', () => {
  test('flush() lists a partition in a manifest that is not yet complete', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(10)), 'a.json');
    expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(false);
    await s.flush();
    const m = manifestOf(w, OUT);
    expect(m).toMatchObject({ complete: false, totals: { spans: 10 } });
    expect(m.partitions).toHaveLength(1);
    await s.close();
  });

  test('the flush interval is measured on the injected clock', async () => {
    const w = createTestWriter();
    const s = await open(w, testConfig({ writer: { flushIntervalMs: 5_000 } }));
    await s.add(otlp(spansRequest(1)), 'a.json');
    expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(false);
    w.clock.advance(5_000n * 1_000_000n);
    await s.add(otlp(spansRequest(1, 0, 1)), 'b.json');
    // the interval checkpoint is written in the background: wait for it, without a flush of our own
    await vi.waitFor(() => expect(manifestOf(w, OUT).totals.spans).toBe(2));
    await s.close();
  });

  test('every flush is one otel-html.flush span with counts', async () => {
    const w = createTestWriter();
    const s = await open(w);
    await s.add(otlp(spansRequest(5)), 'a.json');
    await s.flush();
    const flushes = w.spans.filter((x) => x.name === 'otel-html.flush');
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({ ended: true, attrs: { partitions: 1, records: 5 } });
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
  test('replace refuses a non-empty folder that is not a report', async () => {
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
      openSession({ ...w.deps, process: other }, { out: OUT, config: testConfig(), mode: 'replace' }),
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
      { out: OUT, config: testConfig(), mode: 'replace' },
    );
    expect(w.logs.some((l) => l.level === 'warn' && l.msg.includes('stale'))).toBe(true);
    await s.close();
  });

  test('replace replaces an existing unlocked report completely', async () => {
    const w = createTestWriter();
    const a = await open(w);
    await a.add(otlp(spansRequest(5)), 'a.json');
    await a.flush();
    await a.add(otlp(spansRequest(5, 0, 50)), 'a2.json');
    await a.close();
    expect(manifestOf(w, OUT).totals.spans).toBe(10);
    const b = await open(w);
    await b.add(otlp(spansRequest(2, 0, 100)), 'b.json');
    await b.close();
    const m = manifestOf(w, OUT);
    expect(m.totals.spans).toBe(2);
    expect(m.partitions).toHaveLength(1);
    const files = [...w.fs.snapshot().keys()].filter((p) => p.startsWith('r/data/partitions/'));
    expect(
      files.every((p) => p.startsWith(`r/${m.partitions[0]?.files.spans?.path.replace(/\/[^/]*$/, '')}/`)),
    ).toBe(true);
  });

  test('replace wipes the old report when the first partial input ends, so a second partial input is not held', async () => {
    const w = createTestWriter();
    const a = await open(w);
    await a.add(otlp(spansRequest(3)), 'old.json');
    await a.close();
    const partitionFiles = (): string[] =>
      [...w.fs.snapshot().keys()].filter(
        (p) => p.startsWith('r/data/partitions/') && p.endsWith('spans.parquet'),
      );
    const oldTotals = manifestOf(w, OUT).totals.spans;
    expect(oldTotals).toBe(3);

    // a first input below the partition target and the flush interval: nothing of it is cut or written by itself
    const b = await open(w, testConfig({ writer: { flushIntervalMs: 60_000 } }));
    await b.add(otlp(spansRequest(1, 0, 100)), 'small.json', { partial: true });
    expect(manifestOf(w, OUT).totals.spans).toBe(3);
    await b.endInput();
    // the first input has been read without error: the old report is gone
    await b.flush();
    expect(manifestOf(w, OUT).totals.spans).toBe(1);

    // a later partial input is cut into partitions as it arrives, not held until its end
    const before = partitionFiles().length;
    await b.add(otlp(spansRequest(300, 0, 200)), 'big.json', { partial: true });
    await b.endInput();
    await b.close();
    expect(partitionFiles().length).toBeGreaterThanOrEqual(before);
    expect(manifestOf(w, OUT).totals.spans).toBe(301);
  });
  test('replace replaces a report whose data/metrics holds a stray file (e.g. .DS_Store)', async () => {
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

  test('open appends when a report is there', async () => {
    const w = createTestWriter();
    const config = testConfig();
    const a = await openSession(w.deps, { out: OUT, config, mode: 'open' });
    await a.add(otlp(spansRequest(3)), 'a.json');
    await a.close();
    const b = await openSession(w.deps, { out: OUT, config, mode: 'open' });
    await b.add(otlp(spansRequest(2, 0, 100)), 'b.json');
    await b.close();
    const m = manifestOf(w, OUT);
    expect(m.totals.spans).toBe(5);
    expect(allSpans(w, OUT)).toHaveLength(5);
  });

  test('open creates in a new or empty folder', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'open' });
    await a.add(otlp(spansRequest(2)), 'a.json');
    await a.close();
    expect(manifestOf(w, OUT).totals.spans).toBe(2);
    const w2 = createTestWriter();
    await w2.fs.mkdirp('r');
    const b = await openSession(w2.deps, { out: OUT, config: testConfig(), mode: 'open' });
    await b.add(otlp(spansRequest(3)), 'b.json');
    await b.close();
    expect(manifestOf(w2, OUT).totals.spans).toBe(3);
  });

  test('open refuses a non-empty folder that is not a report', async () => {
    const w = createTestWriter();
    await w.fs.writeBytes('r/notes.txt', new Uint8Array([1]));
    const e = await failure(openSession(w.deps, { out: OUT, config: testConfig(), mode: 'open' }));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('not an otel-html report');
    expect(w.fs.snapshot().get('r/notes.txt')).toBeDefined();
    expect(w.fs.snapshot().has('r/data/state/lock.json')).toBe(false);
  });

  test("open replaces a folder holding only a failed session's state dir", async () => {
    const w = createTestWriter();
    await w.fs.writeBytes('r/data/state/session.0.json', new Uint8Array([1]));
    const s = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'open' });
    await s.add(otlp(spansRequest(2)), 'a.json');
    await s.close();
    expect(manifestOf(w, OUT).totals.spans).toBe(2);
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
  test('beforeMetrics runs once, when the first metric points arrive, and never for spans or logs', async () => {
    const w = createTestWriter();
    let calls = 0;
    const s = await openSession(
      { ...w.deps, beforeMetrics: () => calls++ },
      { out: OUT, config: testConfig(), mode: 'replace' },
    );
    await s.add(otlp(spansRequest(3)), 'spans.json');
    expect(calls).toBe(0);
    await s.add(otlp(counterRequest('requests', [[0, 1]])), 'a.json');
    await s.add(otlp(counterRequest('requests', [[10, 3]])), 'b.json');
    expect(calls).toBe(1);
    await s.close();
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
    const points = allPoints(w, OUT);
    expect(points.map((p) => cell(p, 'delta_value'))).toEqual([1, 2]);
    expect(manifestOf(w, OUT).totals.metrics).toBe(2);
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
    expect(manifestOf(w, OUT).totals.metrics).toBe(300);
    expect(allPoints(w, OUT)).toHaveLength(300);
  });
});
