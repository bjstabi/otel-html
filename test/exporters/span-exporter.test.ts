import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, test } from 'vitest';
import { Report } from '../../src/api/report.js';
import { OtelHtmlSpanExporter } from '../../src/exporters/span-exporter.js';
import { readableSpan } from '../../test-support/decode.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { allSpans, manifestOf } from '../writer/helpers.js';

function emitSpans(exporter: OtelHtmlSpanExporter, names: string[]): BasicTracerProvider {
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const tracer = provider.getTracer('t');
  for (const name of names) tracer.startSpan(name).end();
  return provider;
}

function exportOnce(exporter: OtelHtmlSpanExporter): Promise<{ code: number; error?: Error }> {
  const span = readableSpan('s');
  return new Promise((resolve) => {
    exporter.export([span], resolve);
  });
}

describe('OtelHtmlSpanExporter', () => {
  test('a tracer provider delivers its spans into the report', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const provider = emitSpans(new OtelHtmlSpanExporter({ report }), ['a', 'b']);
    await provider.shutdown();
    await report.close();
    expect(
      allSpans(w, 'r')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  test('export after shutdown calls back a failure with an error', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const exporter = new OtelHtmlSpanExporter({ report });
    await exporter.shutdown();
    const result = await exportOnce(exporter);
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
    await report.close();
  });

  test('a report that rejects the spans calls back a failure', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    await report.close();
    const result = await exportOnce(new OtelHtmlSpanExporter({ report }));
    expect(result.code).toBe(1);
    expect(result.error).toBeInstanceOf(Error);
  });

  test('a successful export calls back code 0', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    expect((await exportOnce(new OtelHtmlSpanExporter({ report }))).code).toBe(0);
    await report.close();
  });

  test('forceFlush writes a checkpoint before the report is closed', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const exporter = new OtelHtmlSpanExporter({ report });
    await exportOnce(exporter);
    expect(() => manifestOf(w, 'r')).toThrow('no manifest');
    await exporter.forceFlush();
    expect(manifestOf(w, 'r').chunks.length).toBeGreaterThan(0);
    await report.close();
  });
});
