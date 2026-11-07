import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { convert, convertWith, merge, mergeWith } from '../../src/api/convert.js';
import { startReceiver } from '../../src/api/receiver.js';
import { createReportWith, defaultDeps, depsOf, Report, reportDepsOf } from '../../src/api/report.js';
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
    const r = await createReportWith({ out: 'r', title: 'My run' }, w.deps);
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
    const ra = await createReportWith({ out: 'r' }, a.deps);
    await ra.addSpans(spans);
    await ra.close();

    const b = createTestWriter();
    const rb = await createReportWith({ out: 'r' }, b.deps);
    await rb.addSpans(json);
    await rb.close();

    expect(allSpans(a, 'r')).toHaveLength(2);
    expect(allSpans(a, 'r')).toEqual(allSpans(b, 'r'));
    expect(manifestOf(a, 'r').epochUnixNano).toBe(manifestOf(b, 'r').epochUnixNano);
  });

  test('accepts a protobuf request message and an empty span list', async () => {
    const w = createTestWriter();
    const r = await createReportWith({ out: 'r' }, w.deps);
    expect((await r.addSpans([])).accepted).toBe(0);
    const message = readableSpansToRequest(sdkSpans());
    expect((await r.addSpans(message)).accepted).toBe(2);
    expect((await r.addSpans(create(ExportTraceServiceRequestSchema, {}))).accepted).toBe(0);
    await r.close();
  });

  test('rejects OTLP of the wrong signal with a clear message', async () => {
    const w = createTestWriter();
    const r = await createReportWith({ out: 'r' }, w.deps);
    const e = await failure(r.addSpans(logsRequest([logRecord()])));
    expect(e.code).toBe('invalid-otlp');
    expect(e.message).toContain('addSpans');
    expect(e.message).toContain('resourceLogs');
    await r.close();
  });

  test('append: true reopens a closed report', async () => {
    const w = createTestWriter();
    const r1 = await createReportWith({ out: 'r' }, w.deps);
    await r1.addSpans(spansRequest(2));
    await r1.close();
    const r2 = await createReportWith({ out: 'r', append: true }, w.deps);
    await r2.addSpans(spansRequest(2, 0, 10));
    expect((await r2.close()).totals.spans).toBe(4);
  });

  test('create over an existing report appends', async () => {
    const w = createTestWriter();
    const r1 = await createReportWith({ out: 'r' }, w.deps);
    await r1.addSpans(spansRequest(3));
    await r1.close();
    const r2 = await createReportWith({ out: 'r' }, w.deps);
    await r2.addSpans(spansRequest(2, 0, 10));
    expect((await r2.close()).totals.spans).toBe(5);
  });

  test('abort releases the lock, keeps what was checkpointed and closes the report', async () => {
    const w = createTestWriter();
    const r = await createReportWith({ out: 'r' }, w.deps);
    await r.addSpans(spansRequest(2));
    await r.flush();
    await r.abort();
    await r.abort(); // a second abort resolves
    await expect(r.addSpans(spansRequest(1, 0, 10))).rejects.toThrow(/is closed/);
    await expect(r.close()).rejects.toThrow(/is closed/);
    // the lock is free: the same process can reopen the folder, and the flushed spans are there
    const again = await createReportWith({ out: 'r', append: true }, w.deps);
    expect((await again.close()).totals.spans).toBe(2);
  });

  test('without abort the folder stays locked', async () => {
    const w = createTestWriter();
    await createReportWith({ out: 'r' }, w.deps);
    expect((await failure(createReportWith({ out: 'r' }, w.deps))).code).toBe('report-locked');
  });

  test('abort while an add is pending lets the add settle, then releases the lock', async () => {
    // The session's serial queue runs the pending add first; neither promise may hang.
    const w = createTestWriter();
    const r = await createReportWith({ out: 'r' }, w.deps);
    const pending = r.addSpans(spansRequest(2));
    await r.abort();
    await pending.catch(() => undefined); // settled either way
    // nothing was checkpointed, so there is no report to append to; the lock being free is what matters
    const again = await createReportWith({ out: 'r' }, w.deps);
    await again.close();
  });

  test('abort after close resolves and the summary stands', async () => {
    const w = createTestWriter();
    const r = await createReportWith({ out: 'r' }, w.deps);
    await r.addSpans(spansRequest(1));
    const summary = await r.close();
    await r.abort();
    expect(await r.close()).toEqual(summary);
  });

  test('replace: true starts over', async () => {
    const w = createTestWriter();
    const r1 = await createReportWith({ out: 'r' }, w.deps);
    await r1.addSpans(spansRequest(3));
    await r1.close();
    const r2 = await createReportWith({ out: 'r', replace: true }, w.deps);
    await r2.addSpans(spansRequest(2, 0, 10));
    expect((await r2.close()).totals.spans).toBe(2);
  });

  test('append and replace together is a usage error', async () => {
    const w = createTestWriter();
    const e = await failure(createReportWith({ out: 'r', append: true, replace: true }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toBe('append and replace exclude each other');
  });

  test('append: true on an empty folder fails', async () => {
    const w = createTestWriter();
    const e = await failure(createReportWith({ out: 'r', append: true }, w.deps));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('cannot append');
  });

  test('assetsBase without a local or site format is a config error', async () => {
    const w = createTestWriter();
    await expect(createReportWith({ out: 'r', assetsBase: '../assets/a/' }, w.deps)).rejects.toThrow(
      /writer\.assetsBase.*--format local\|site/,
    );
    await expect(
      createReportWith({ out: 'r', config: { writer: { assetsBase: '../assets/a/' } } }, w.deps),
    ).rejects.toThrow(/writer\.assetsBase/);
  });

  test('format and assetsBase options map into writer config and win over config.writer', async () => {
    const w = createTestWriter();
    const report = await createReportWith(
      {
        out: 'r',
        format: 'local',
        assetsBase: '../assets/a/',
        config: { writer: { format: 'site', rowGroupRows: 60_000 } },
      },
      w.deps,
    );
    await report.close();
    const manifest = w.fs.snapshot().get('r/data/manifest.js') ?? '';
    expect(manifest).toContain('"format":"local"');
    expect(manifest).toContain('"assetsBase":"../assets/a/"');
  });

  test('config as an object and as a file path; the title option wins', async () => {
    const w = createTestWriter();
    await w.fs.writeBytes(
      'cfg/otel-html.yaml',
      new TextEncoder().encode('title: From file\nviewer:\n  theme: dark\n'),
    );
    const r = await createReportWith({ out: 'r', config: 'cfg/otel-html.yaml' }, w.deps);
    await r.close();
    expect(manifestOf(w, 'r').title).toBe('From file');
    expect(manifestOf(w, 'r').config.viewer.theme).toBe('dark');

    const r2 = await createReportWith(
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
      createReportWith({ out: 'r', config: { writer: { chunkTargetBytes: -1 } } }, w.deps),
    );
    expect(e.code).toBe('invalid-config');
    expect(await w.fs.exists('r')).toBe(false);
  });
});

describe('public deps', () => {
  test('only logger and tracer get through, whatever the object carries', () => {
    const w = createTestWriter({ version: '0.0.0-forged' });
    const picked = reportDepsOf(w.deps); // a WriterDeps is assignable: the extra keys must be dropped at runtime
    expect(Object.keys(picked).sort()).toEqual(['logger', 'tracer']);
    expect(picked.logger).toBe(w.deps.logger);
    expect(reportDepsOf(undefined)).toEqual({});
    expect(Object.keys(reportDepsOf({ logger: w.deps.logger }))).toEqual(['logger']);
  });
});

describe('public entry points drop everything but logger and tracer', () => {
  // A variable, so the extra keys type-check as Partial<ReportDeps>; used here as a caller who bypasses the types.
  function forgedDeps(w: ReturnType<typeof createTestWriter>) {
    return {
      logger: w.deps.logger,
      version: '0.0.0-forged',
      viewerAssets: {
        files(): never {
          throw new Error('FORGED');
        },
        entry(): never {
          throw new Error('FORGED');
        },
      },
    };
  }

  // With the forged keys dropped the real viewer assets apply: the call succeeds, or (no viewer build) fails with a
  // usage error about them. Either way the forged assets are never consulted.
  async function outcome(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async function scratch(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'otel-html-forged-'));
  }

  test('Report.create', async () => {
    const w = createTestWriter();
    const dir = await scratch();
    try {
      const forged = forgedDeps(w);
      let report: Report | undefined;
      const result = await outcome(async () => {
        report = await Report.create({ out: join(dir, 'r') }, forged);
      });
      expect(result).not.toContain('FORGED');
      await report?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('convert', async () => {
    const w = createTestWriter();
    const dir = await scratch();
    try {
      const input = join(dir, 'in.json');
      await writeFile(input, JSON.stringify(spansRequest(1)));
      const forged = forgedDeps(w);
      expect(await outcome(() => convert({ input, out: join(dir, 'r') }, forged))).not.toContain('FORGED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('merge', async () => {
    const w = createTestWriter();
    const dir = await scratch();
    try {
      const forged = forgedDeps(w);
      const result = await outcome(() =>
        merge({ inputs: [join(dir, 'a'), join(dir, 'b')], out: join(dir, 'r') }, forged),
      );
      expect(result).not.toContain('FORGED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('startReceiver', async () => {
    const w = createTestWriter();
    const report = await createReportWith({ out: 'r' }, w.deps);
    // The receiver reads only logger and tracer from its deps, so the forged keys cannot surface here; the
    // observable guarantee is that the two allowed ones are honoured and the call starts despite the rest.
    const names: string[] = [];
    const tracer = {
      startSpan(name: string) {
        names.push(name);
        return w.deps.tracer.startSpan(name);
      },
    };
    const rx = await startReceiver(report, { http: { port: 0 }, grpc: false }, { ...forgedDeps(w), tracer });
    expect(names).toContain('otel-html.receive');
    await rx.close();
    await report.close();
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
    const r = await createReportWith({ out: 'r' }, { fs: w.fs, viewerAssets: w.deps.viewerAssets });
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
    const e = await failure(createReportWith({ out: 'r' }, { ...w.deps, viewerAssets: broken }));
    expect(e.code).toBe('usage');
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('convert and merge fail the same way, before reading inputs', async () => {
    const w = createTestWriter();
    const deps = { ...w.deps, viewerAssets: broken };
    expect((await failure(convertWith({ input: 'missing.json', out: 'r' }, deps))).message).toContain(
      'viewer assets',
    );
    expect((await failure(mergeWith({ inputs: ['a'], out: 'm' }, deps))).message).toContain('viewer assets');
    expect(await w.fs.exists('r')).toBe(false);
    expect(await w.fs.exists('m')).toBe(false);
  });

  test('assets with an unsafe path are rejected up front', async () => {
    const w = createTestWriter();
    const evil = {
      files: async () => [{ path: '../evil.js', contents: new Uint8Array() }],
      entry: () => ({ script: 'assets/viewer.js', style: null }),
    };
    const e = await failure(createReportWith({ out: 'r' }, { ...w.deps, viewerAssets: evil }));
    expect(e.code).toBe('invalid-report');
    expect(await w.fs.exists('r')).toBe(false);
  });

  test('depsOf returns the deps the report was created with', async () => {
    const w = createTestWriter();
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const report = await createReportWith({ out: 'r' }, { ...w.deps, logger });
    expect(depsOf(report).logger).toBe(logger);
    await report.close();
  });

  test('a startReceiver over a good report never re-validates the viewer assets', async () => {
    const w = createTestWriter();
    const files = vi.spyOn(w.deps.viewerAssets, 'files');
    const report = await createReportWith({ out: 'r' }, w.deps);
    expect(files).toHaveBeenCalledTimes(1);
    const rx = await startReceiver(report, { http: { port: 0 }, grpc: false });
    await rx.close();
    expect(files).toHaveBeenCalledTimes(1);
    await report.close();
  });
});
