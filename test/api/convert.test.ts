import { readFileSync } from 'node:fs';
import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import {
  DANGLING_SPAN_LOG_TEXT,
  HOSTILE_LOG_TEXT,
  HOSTILE_METRIC_NAME,
  HOSTILE_METRIC_UNIT,
  LINKED_DECLINED_COUNT,
  LINKED_LOG_COUNT,
  LINKED_SEVERITY_COUNTS,
  LINKED_SPAN,
  LINKED_TRACE,
  LINKED_WARN_PLUS_COUNT,
  METRIC_HIST,
  METRICS_COUNT,
  ORPHAN_EXEMPLAR_TRACE,
  ORPHAN_LOG_TRACE,
} from '../../e2e/fixture.js';
import { convertWith, mergeWith } from '../../src/api/convert.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportLogsServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, type TestWriter } from '../../test-support/writer-deps.js';
import {
  allLogs,
  allPoints,
  allSpans,
  cell,
  manifestOf,
  spansRequest,
  tableRowsOf,
} from '../writer/helpers.js';

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

const enc = new TextEncoder();
async function put(w: TestWriter, path: string, text: string | Uint8Array): Promise<void> {
  await w.fs.writeBytes(path, typeof text === 'string' ? enc.encode(text) : text);
}

describe('convert', () => {
  test('no input files is a usage error', async () => {
    const w = createTestWriter();
    const e = await failure(convertWith({ input: [], out: 'r' }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('no input files');
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('a config dashboard reaches the manifest with the library API as its source', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(1)));
    const dashboards = [
      { id: 'ops', title: 'Ops', widgets: [{ type: 'traces' as const, x: 0, y: 0, w: 6, h: 6 }] },
    ];
    await convertWith({ input: 'in/a.json', out: 'r', config: { dashboards } }, w.deps);
    expect(manifestOf(w, 'r').config.dashboards[0]?.source).toBe('library API');
  });

  test('a logs-only file succeeds with no spans', async () => {
    const w = createTestWriter();
    await put(w, 'in/logs.otlp.json', JSON.stringify(logsRequest([logRecord(), logRecord()])));
    const summary = await convertWith({ input: 'in/logs.otlp.json', out: 'r' }, w.deps);
    expect(summary.totals).toEqual({ spans: 0, logs: 2, metrics: 0 });
    expect(manifestOf(w, 'r').complete).toBe(true);
  });

  test('combines JSON, JSON lines and protobuf inputs in order', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(
      w,
      'in/b.jsonl',
      `${JSON.stringify(spansRequest(1, 0, 10))}\n${JSON.stringify(spansRequest(1, 0, 11))}\n`,
    );
    const bin = toBinary(
      ExportLogsServiceRequestSchema,
      create(ExportLogsServiceRequestSchema, {
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: 1700000000000000001n }] }] }],
      }),
    );
    await put(w, 'in/c.pb', bin);
    const summary = await convertWith(
      { input: ['in/a.json', 'in/b.jsonl', 'in/c.pb'], out: 'r', signal: 'logs' },
      w.deps,
    );
    expect(summary.totals).toEqual({ spans: 4, logs: 1, metrics: 0 });
  });

  test('a file system without readChunks is read whole with readBytes', async () => {
    const w = createTestWriter();
    await put(w, 'in/logs.json', JSON.stringify(logsRequest([logRecord(), logRecord()])));
    const { readChunks: _, ...whole } = w.fs;
    const summary = await convertWith({ input: 'in/logs.json', out: 'r' }, { ...w.deps, fs: whole });
    expect(summary.totals.logs).toBe(2);
    const e = await failure(convertWith({ input: 'in/missing.json', out: 'r2' }, { ...w.deps, fs: whole }));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('cannot read input file in/missing.json');
  });

  test('protobuf without a signal hint is a usage error naming the file', async () => {
    const w = createTestWriter();
    await put(w, 'in/c.pb', new Uint8Array([]));
    const e = await failure(convertWith({ input: 'in/c.pb', out: 'r' }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('in/c.pb');
  });

  test('a missing input file is a usage error naming it', async () => {
    const w = createTestWriter();
    const e = await failure(convertWith({ input: ['in/missing.json'], out: 'r' }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('in/missing.json');
  });

  test('invalid OTLP names the file and leaves a lock-free folder', async () => {
    const w = createTestWriter();
    await put(w, 'in/bad.json', '{"resourceSpans": 3}');
    const e = await failure(convertWith({ input: 'in/bad.json', out: 'r' }, w.deps));
    expect(e.code).toBe('invalid-otlp');
    expect(e.message).toContain('in/bad.json');
    await put(w, 'in/ok.json', JSON.stringify(spansRequest(1)));
    await convertWith({ input: 'in/ok.json', out: 'r' }, w.deps);
  });
});

describe('convert streams a file one resource entry at a time', () => {
  /** A resource entry of `n` logs at `time`; `n` 0 gives an entry without records. */
  function entry(n: number, time = '1600000000000000000', extra: Record<string, unknown> = {}): unknown {
    return {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: `svc-${n}` } }] },
      scopeLogs:
        n === 0
          ? []
          : [
              {
                logRecords: Array.from({ length: n }, () =>
                  logRecord({ timeUnixNano: time, observedTimeUnixNano: time, ...extra }),
                ),
              },
            ],
    };
  }

  test('an empty first entry does not fix the epoch: data far from the wall clock still converts', async () => {
    const w = createTestWriter(); // wall clock 1700000000000000000, over three years later
    await put(w, 'in/old.json', JSON.stringify({ resourceLogs: [entry(0), entry(2)] }));
    const summary = await convertWith({ input: 'in/old.json', out: 'r' }, w.deps);
    expect(summary.totals.logs).toBe(2);
    expect(manifestOf(w, 'r').epochUnixNano).toBe('1600000000000000000');
  });

  test('normalize errors name the real resource entry, for JSON and protobuf', async () => {
    const w = createTestWriter();
    const bad = { resource: { attributes: [{ key: 'k', value: { stringValueStrindex: 1 } }] } };
    await put(
      w,
      'in/bad.json',
      JSON.stringify({ resourceLogs: [entry(1), entry(1), { ...bad, scopeLogs: [] }] }),
    );
    const e = await failure(convertWith({ input: 'in/bad.json', out: 'r' }, w.deps));
    expect(e.path).toMatch(/^in\/bad\.json: resourceLogs\[2\]\.resource\./);
    const bin = toBinary(
      ExportLogsServiceRequestSchema,
      create(ExportLogsServiceRequestSchema, {
        resourceLogs: [
          {},
          {
            resource: {
              attributes: [{ key: 'k', value: { value: { case: 'stringValueStrindex', value: 1 } } }],
            },
          },
        ],
      }),
    );
    await put(w, 'in/bad.pb', bin);
    const p = await failure(convertWith({ input: 'in/bad.pb', out: 'r2', signal: 'logs' }, w.deps));
    expect(p.path).toMatch(/^in\/bad\.pb: resourceLogs\[1\]\.resource\./);
  });

  describe('a periodic flush never lands inside a file', () => {
    /** The file system, with the clock moved past the flush interval after the first piece of each read. */
    function clockJumping(w: TestWriter): FileSystem {
      return {
        ...w.fs,
        async *readChunks(p: string) {
          let first = true;
          for await (const piece of w.fs.readChunks?.(p) ?? []) {
            yield piece;
            if (first) w.clock.advance(60_000_000_000n);
            first = false;
          }
        },
      };
    }
    const late = (): string =>
      JSON.stringify({
        resourceLogs: [
          ...Array.from({ length: 20 }, () => entry(5, '1700000000000000000')),
          entry(1, '1700000000000000000', { traceId: 'zz' }),
        ],
      });

    test('create: a bad entry late in a file leaves the report being replaced untouched', async () => {
      const w = createTestWriter();
      await put(w, 'in/good.json', JSON.stringify(spansRequest(3)));
      await convertWith({ input: 'in/good.json', out: 'r' }, w.deps);
      await put(w, 'in/late.json', late());
      const before = w.fs.snapshot();
      await failure(
        convertWith({ input: 'in/late.json', out: 'r', replace: true }, { ...w.deps, fs: clockJumping(w) }),
      );
      const after = w.fs.snapshot();
      for (const [path, text] of before) {
        if (!path.endsWith('.lock')) expect(after.get(path), path).toBe(text);
      }
    });

    test('convert twice into one folder appends', async () => {
      const w = createTestWriter();
      await put(w, 'in/a.json', JSON.stringify(spansRequest(3)));
      await put(w, 'in/b.json', JSON.stringify(spansRequest(2, 0, 10)));
      await convertWith({ input: 'in/a.json', out: 'r' }, w.deps);
      const summary = await convertWith({ input: 'in/b.json', out: 'r' }, w.deps);
      expect(summary.totals.spans).toBe(5);
    });

    test('append: a bad entry late in a file commits none of it', async () => {
      const w = createTestWriter();
      await put(w, 'in/good.json', JSON.stringify(spansRequest(3)));
      await convertWith({ input: 'in/good.json', out: 'r' }, w.deps);
      await put(w, 'in/late.json', late());
      await failure(
        convertWith({ input: 'in/late.json', out: 'r', append: true }, { ...w.deps, fs: clockJumping(w) }),
      );
      expect(manifestOf(w, 'r').totals).toEqual({ spans: 3, logs: 0, metrics: 0 });
    });
  });
});

describe('convert of an empty request', () => {
  test('{"resourceSpans":[]} produces a valid, empty report', async () => {
    const w = createTestWriter();
    await put(w, 'in/empty.json', '{"resourceSpans":[]}');
    const summary = await convertWith({ input: 'in/empty.json', out: 'r' }, w.deps);
    expect(summary.totals).toEqual({ spans: 0, logs: 0, metrics: 0 });
    const m = manifestOf(w, 'r');
    expect(m.complete).toBe(true);
    expect(m.partitions).toEqual([]);
    expect(await w.fs.exists('r/index.html')).toBe(true);
  });
});

describe('merge (public)', () => {
  test('merges converted reports', async () => {
    const w = createTestWriter();
    await put(w, 'in/a.json', JSON.stringify(spansRequest(2)));
    await put(w, 'in/b.json', JSON.stringify(spansRequest(2, 1000, 5)));
    await convertWith({ input: 'in/a.json', out: 'a' }, w.deps);
    await convertWith({ input: 'in/b.json', out: 'b' }, w.deps);
    const summary = await mergeWith({ inputs: ['a', 'b'], out: 'm', config: { title: 'merged' } }, w.deps);
    expect(summary.totals.spans).toBe(4);
    expect(manifestOf(w, 'm').title).toBe('merged');
  });

  describe('a failed convert leaves the existing report in place', () => {
    async function existing(w: TestWriter): Promise<void> {
      await put(w, 'in/good.json', JSON.stringify(spansRequest(3)));
      await convertWith({ input: 'in/good.json', out: 'r' }, w.deps);
    }

    test('a missing input file', async () => {
      const w = createTestWriter();
      await existing(w);
      const before = w.fs.snapshot();
      const e = await failure(convertWith({ input: 'in/typo.json', out: 'r' }, w.deps));
      expect(e.code).toBe('usage');
      expect(manifestOf(w, 'r').totals.spans).toBe(3);
      expect(allSpans(w, 'r')).toHaveLength(3);
      // Only the writer's lock file may differ.
      const after = w.fs.snapshot();
      for (const [path, text] of before) {
        if (!path.endsWith('.lock')) expect(after.get(path), path).toBe(text);
      }
    });

    test('a malformed input file after a readable one', async () => {
      const w = createTestWriter();
      await existing(w);
      await put(w, 'in/other.json', JSON.stringify(spansRequest(2, 0, 50)));
      await put(w, 'in/bad.json', '{ not json');
      await failure(convertWith({ input: ['in/other.json', 'in/bad.json'], out: 'r' }, w.deps));
      expect(manifestOf(w, 'r').totals.spans).toBe(3);
      expect(allSpans(w, 'r')).toHaveLength(3);
    });
  });
});

describe('the linked fixture', () => {
  async function convertLinked(): Promise<TestWriter> {
    const w = createTestWriter();
    const files = ['linked-traces', 'linked-logs', 'metrics'].map((name) => `in/${name}.otlp.json`);
    for (const f of files) {
      await put(w, f, readFileSync(new URL(`../../fixtures/${f.slice('in/'.length)}`, import.meta.url)));
    }
    await convertWith({ input: files, out: 'r' }, w.deps);
    return w;
  }

  test('converts to 40 logs, and the traces table counts its linked trace logs', async () => {
    const w = await convertLinked();
    expect(manifestOf(w, 'r').totals.logs).toBe(LINKED_LOG_COUNT);
    expect(allLogs(w, 'r')).toHaveLength(LINKED_LOG_COUNT);
    const entry = tableRowsOf(w, 'r', 'traces').find((t) => cell(t, 'trace_id') === LINKED_TRACE);
    expect(Number(cell(entry, 'log_count'))).toBeGreaterThan(0);
  });

  test('the e2e constants describe the fixture', async () => {
    const w = await convertLinked();
    const logs = allLogs(w, 'r');
    const spans = allSpans(w, 'r');
    const text = (l: (typeof logs)[number]): string => String(cell(l, 'body'));
    const severity = (l: (typeof logs)[number]): number => Number(cell(l, 'severity_number'));
    const bySeverity: Record<number, number> = {};
    for (const l of logs) bySeverity[severity(l)] = (bySeverity[severity(l)] ?? 0) + 1;
    expect(bySeverity).toEqual(LINKED_SEVERITY_COUNTS);
    expect(logs.filter((l) => severity(l) >= 13)).toHaveLength(LINKED_WARN_PLUS_COUNT);
    expect(logs.filter((l) => text(l).toLowerCase().includes('declined'))).toHaveLength(
      LINKED_DECLINED_COUNT,
    );
    expect(new Set(spans.map((sp) => cell(sp, 'trace_id'))).size).toBe(3);
    expect(
      spans.some((sp) => cell(sp, 'trace_id') === LINKED_TRACE && cell(sp, 'span_id') === LINKED_SPAN),
    ).toBe(true);
    expect(logs.filter((l) => cell(l, 'span_id') === LINKED_SPAN).length).toBeGreaterThanOrEqual(3);
    // 1 orphan trace id, 5 without context, 1 span_id outside its trace.
    expect(logs.filter((l) => cell(l, 'trace_id') === ORPHAN_LOG_TRACE)).toHaveLength(1);
    expect(spans.some((sp) => cell(sp, 'trace_id') === ORPHAN_LOG_TRACE)).toBe(false);
    expect(logs.filter((l) => cell(l, 'trace_id') === null)).toHaveLength(5);
    const dangling = logs.filter((l) => text(l).includes(DANGLING_SPAN_LOG_TEXT));
    expect(dangling).toHaveLength(1);
    expect(cell(dangling[0], 'trace_id')).toBe(LINKED_TRACE);
    expect(spans.some((sp) => cell(sp, 'span_id') === cell(dangling[0], 'span_id'))).toBe(false);
    expect(logs.filter((l) => text(l).includes(JSON.stringify(HOSTILE_LOG_TEXT).slice(1, -1)))).toHaveLength(
      1,
    );
    expect(logs.filter((l) => cell(l, 'event_name') !== null && cell(l, 'event_name') !== '')).toHaveLength(
      2,
    );
    expect(
      logs.filter((l) => cell(l, 'time_unix_nano') === null && cell(l, 'observed_time_unix_nano') !== null),
    ).toHaveLength(1);
    expect(logs.filter((l) => cell(l, 'span_id') !== null && cell(l, 'trace_id') !== null)).toHaveLength(35);
  });

  test('converts the metrics fixture: its histogram and every kind of point are in the points table', async () => {
    const w = await convertLinked();
    expect(manifestOf(w, 'r').totals.metrics).toBeGreaterThan(0);
    const points = allPoints(w, 'r');
    expect(new Set(points.map((p) => cell(p, 'metric_name'))).size).toBe(METRICS_COUNT);
    // 2 resources x 3 routes.
    const histSeries = new Set(
      points.filter((p) => cell(p, 'metric_name') === METRIC_HIST).map((p) => cell(p, 'series_id')),
    );
    expect(histSeries.size).toBe(6);
    expect(new Set(points.map((p) => cell(p, 'point_type')))).toEqual(
      new Set(['sum', 'gauge', 'histogram', 'exp_histogram', 'summary']),
    );
    expect(
      points.some(
        (p) =>
          cell(p, 'metric_name') === HOSTILE_METRIC_NAME && cell(p, 'metric_unit') === HOSTILE_METRIC_UNIT,
      ),
    ).toBe(true);
    // The histogram's exemplars keep their trace ids (one into the linked trace, one into a trace the report lacks).
    const exemplarText = points
      .filter((p) => cell(p, 'metric_name') === METRIC_HIST)
      .map((p) => String(cell(p, 'exemplars') ?? ''))
      .join('');
    expect(exemplarText).toContain(LINKED_TRACE);
    expect(exemplarText).toContain(ORPHAN_EXEMPLAR_TRACE);
  });
});
