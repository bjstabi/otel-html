import { create } from '@bufbuild/protobuf';
import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, test, vi } from 'vitest';
import { convert, merge } from '../../src/api/convert.js';
import { startReceiver } from '../../src/api/receiver.js';
import { defaultDeps, depsOf, Report } from '../../src/api/report.js';
import { createOtelTracer } from '../../src/api/telemetry.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportTraceServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { readableSpansToRequest } from '../../src/model/sdk-spans.js';
import { gauge, logRecord, logsRequest, metricsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { allSpans, manifestOf, spansRequest } from '../writer/helpers.js';

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

function sdkSpans(): ReadableSpan[] {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'svc' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('scope', '1.0.0');
  const parent = tracer.startSpan('parent', { kind: SpanKind.SERVER, attributes: { k: 'v', n: 3 } });
  const child = tracer.startSpan('child', {}, trace.setSpan(ROOT_CONTEXT, parent));
  child.addEvent('evt', { a: 1 });
  child.end();
  parent.end();
  return exporter.getFinishedSpans();
}

describe('Report', () => {
  test('create, add all three signals, close', async () => {
    const w = createTestWriter();
    const r = await Report.create({ out: 'r', title: 'My run' }, w.deps);
    expect(await r.addSpans(spansRequest(3))).toEqual({ accepted: 3, dropped: 0, duplicates: 0 });
    expect((await r.addLogs(logsRequest([logRecord()]))).accepted).toBe(1);
    expect(
      (
        await r.addMetrics(
          metricsRequest([gauge('g', [{ timeUnixNano: '1700000000000000000', asInt: '1' }])]),
        )
      ).accepted,
    ).toBe(1);
    await r.flush();
    const summary = await r.close();
    expect(summary.totals).toEqual({ spans: 3, logs: 1, metrics: 1 });
    expect(manifestOf(w, 'r').title).toBe('My run');
  });

  test('ReadableSpan input stores the same records as the equivalent OTLP JSON', async () => {
    const spans = sdkSpans();
    const json: unknown = JSON.parse(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans)));
    if (typeof json !== 'object' || json === null) throw new Error('bad oracle');

    const a = createTestWriter();
    const ra = await Report.create({ out: 'r' }, a.deps);
    await ra.addSpans(spans);
    await ra.close();

    const b = createTestWriter();
    const rb = await Report.create({ out: 'r' }, b.deps);
    await rb.addSpans(json);
    await rb.close();

    expect(allSpans(a, 'r')).toHaveLength(2);
    expect(allSpans(a, 'r')).toEqual(allSpans(b, 'r'));
    expect(manifestOf(a, 'r').epochUnixNano).toBe(manifestOf(b, 'r').epochUnixNano);
  });

  test('accepts a protobuf request message and an empty span list', async () => {
    const w = createTestWriter();
    const r = await Report.create({ out: 'r' }, w.deps);
    expect((await r.addSpans([])).accepted).toBe(0);
    const message = readableSpansToRequest(sdkSpans());
    expect((await r.addSpans(message)).accepted).toBe(2);
    expect((await r.addSpans(create(ExportTraceServiceRequestSchema, {}))).accepted).toBe(0);
    await r.close();
  });

  test('rejects OTLP of the wrong signal with a clear message', async () => {
    const w = createTestWriter();
    const r = await Report.create({ out: 'r' }, w.deps);
    const e = await failure(r.addSpans(logsRequest([logRecord()])));
    expect(e.code).toBe('invalid-otlp');
    expect(e.message).toContain('addSpans');
    expect(e.message).toContain('resourceLogs');
    await r.close();
  });

  test('append: true reopens a closed report', async () => {
    const w = createTestWriter();
    const r1 = await Report.create({ out: 'r' }, w.deps);
    await r1.addSpans(spansRequest(2));
    await r1.close();
    const r2 = await Report.create({ out: 'r', append: true }, w.deps);
    await r2.addSpans(spansRequest(2, 0, 10));
    expect((await r2.close()).totals.spans).toBe(4);
  });

  test('create over an existing report appends', async () => {
    const w = createTestWriter();
    const r1 = await Report.create({ out: 'r' }, w.deps);
    await r1.addSpans(spansRequest(3));
    await r1.close();
    const r2 = await Report.create({ out: 'r' }, w.deps);
    await r2.addSpans(spansRequest(2, 0, 10));
    expect((await r2.close()).totals.spans).toBe(5);
  });

  test('replace: true starts over', async () => {
    const w = createTestWriter();
    const r1 = await Report.create({ out: 'r' }, w.deps);
    await r1.addSpans(spansRequest(3));
    await r1.close();
    const r2 = await Report.create({ out: 'r', replace: true }, w.deps);
    await r2.addSpans(spansRequest(2, 0, 10));
    expect((await r2.close()).totals.spans).toBe(2);
  });

  test('append and replace together is a usage error', async () => {
    const w = createTestWriter();
    const e = await failure(Report.create({ out: 'r', append: true, replace: true }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toBe('append and replace exclude each other');
  });

  test('append: true on an empty folder fails', async () => {
    const w = createTestWriter();
    const e = await failure(Report.create({ out: 'r', append: true }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('cannot append');
  });

  test('config as an object and as a file path; the title option wins', async () => {
    const w = createTestWriter();
    await w.fs.writeBytes(
      'cfg/otel-html.yaml',
      new TextEncoder().encode('title: From file\nviewer:\n  theme: dark\n'),
    );
    const r = await Report.create({ out: 'r', config: 'cfg/otel-html.yaml' }, w.deps);
    await r.close();
    expect(manifestOf(w, 'r').title).toBe('From file');
    expect(manifestOf(w, 'r').config.viewer.theme).toBe('dark');

    const r2 = await Report.create(
      { out: 'r2', config: { viewer: { theme: 'light' }, title: 'obj' }, title: 'explicit' },
      w.deps,
    );
    await r2.close();
    expect(manifestOf(w, 'r2').title).toBe('explicit');
    expect(manifestOf(w, 'r2').config.viewer.theme).toBe('light');
  });

  test('an invalid config fails before anything is written', async () => {
    const w = createTestWriter();
    const e = await failure(
      Report.create({ out: 'r', config: { writer: { chunkTargetBytes: -1 } } }, w.deps),
    );
    expect(e.code).toBe('invalid-config');
    expect(await w.fs.exists('r')).toBe(false);
  });
});

describe('defaultDeps', () => {
  test('is the composition root wired to node and the no-op OTel API', async () => {
    const deps = defaultDeps();
    expect(deps.process.pid).toBe(process.pid);
    expect(deps.process.isAlive(process.pid)).toBe(true);
    const t0 = deps.clock.monotonicMs();
    expect(deps.clock.monotonicMs()).toBeGreaterThanOrEqual(t0);
    expect(deps.clock.nowUnixNano()).toBeGreaterThan(1_700_000_000_000_000_000n);
    expect(deps.version).toMatch(/^\d+\.\d+\.\d+/);
    const span = deps.tracer.startSpan('x', { a: 1 });
    span.setAttributes({ b: true });
    span.recordError(new Error('boom'));
    span.end();
    expect(await deps.fs.exists('/')).toBe(true);
  });

  test('overrides replace individual dependencies', async () => {
    const w = createTestWriter();
    const r = await Report.create({ out: 'r' }, { fs: w.fs, viewerAssets: w.deps.viewerAssets });
    await r.close();
    expect(await w.fs.exists('r/data/manifest.js')).toBe(true);
  });
});

describe('createOtelTracer', () => {
  test('maps the port onto an OTel tracer, recording errors', () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const tracer = createOtelTracer(provider.getTracer('otel-html', '1.0.0'));
    const s = tracer.startSpan('op', { a: 'x' });
    s.setAttributes({ n: 2 });
    s.recordError(new Error('boom'));
    s.end();
    const [done] = exporter.getFinishedSpans();
    expect(done?.name).toBe('op');
    expect(done?.attributes).toEqual({ a: 'x', n: 2 });
    expect(done?.status.code).toBe(2);
    expect(done?.events[0]?.name).toBe('exception');
  });
});

describe('viewer assets are validated before any data is processed', () => {
  const broken = {
    async files(): Promise<never> {
      throw new OtelHtmlError('usage', { message: 'viewer assets not found' });
    },
    entry(): never {
      throw new OtelHtmlError('usage', { message: 'viewer assets not found' });
    },
  };

  test('Report.create fails with usage and writes nothing', async () => {
    const w = createTestWriter();
    const e = await failure(Report.create({ out: 'r' }, { ...w.deps, viewerAssets: broken }));
    expect(e.code).toBe('usage');
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('convert and merge fail the same way, before reading inputs', async () => {
    const w = createTestWriter();
    const deps = { ...w.deps, viewerAssets: broken };
    expect((await failure(convert({ input: 'missing.json', out: 'r' }, deps))).message).toContain(
      'viewer assets',
    );
    expect((await failure(merge({ inputs: ['a'], out: 'm' }, deps))).message).toContain('viewer assets');
    expect(await w.fs.exists('r')).toBe(false);
    expect(await w.fs.exists('m')).toBe(false);
  });

  test('assets with an unsafe path are rejected up front', async () => {
    const w = createTestWriter();
    const evil = {
      files: async () => [{ path: '../evil.js', contents: new Uint8Array() }],
      entry: () => ({ script: 'assets/viewer.js', style: null }),
    };
    const e = await failure(Report.create({ out: 'r' }, { ...w.deps, viewerAssets: evil }));
    expect(e.code).toBe('invalid-report');
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('depsOf returns the deps the report was created with', async () => {
    const w = createTestWriter();
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const report = await Report.create({ out: 'r' }, { ...w.deps, logger });
    expect(depsOf(report).logger).toBe(logger);
    await report.close();
  });

  test('a startReceiver over a good report never re-validates the viewer assets', async () => {
    const w = createTestWriter();
    const files = vi.spyOn(w.deps.viewerAssets, 'files');
    const report = await Report.create({ out: 'r' }, w.deps);
    expect(files).toHaveBeenCalledTimes(1);
    const rx = await startReceiver(report, { http: { port: 0 }, grpc: false });
    await rx.close();
    expect(files).toHaveBeenCalledTimes(1);
    await report.close();
  });
});
