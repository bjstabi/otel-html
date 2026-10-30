import { ValueType } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { describe, expect, test } from 'vitest';
import { Report } from '../../src/api/report.js';
import { OtelHtmlMetricExporter } from '../../src/exporters/metric-exporter.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { allPoints } from '../writer/helpers.js';

describe('OtelHtmlMetricExporter', () => {
  test('a periodic reader delivers its points into the report', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const exporter = new OtelHtmlMetricExporter({ report });
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const provider = new MeterProvider({ readers: [reader] });
    const meter = provider.getMeter('t');
    meter.createCounter('c', { valueType: ValueType.INT }).add(3, { a: 'b' });
    meter.createHistogram('h').record(2);
    await reader.forceFlush();
    await provider.shutdown();
    await report.close();
    const points = allPoints(w, 'r');
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  test('temporality defaults to cumulative (1) and delta selects 0', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    expect(new OtelHtmlMetricExporter({ report }).selectAggregationTemporality()).toBe(1);
    expect(
      new OtelHtmlMetricExporter({ report, temporality: 'cumulative' }).selectAggregationTemporality(),
    ).toBe(1);
    expect(new OtelHtmlMetricExporter({ report, temporality: 'delta' }).selectAggregationTemporality()).toBe(
      0,
    );
    await report.close();
  });

  test('export after shutdown calls back a failure', async () => {
    const w = createTestWriter();
    const report = await Report.create({ out: 'r' }, w.deps);
    const exporter = new OtelHtmlMetricExporter({ report });
    await exporter.shutdown();
    const result = await new Promise<{ code: number; error?: Error }>((resolve) =>
      exporter.export(
        { resource: { attributes: {}, asyncAttributesPending: false } as never, scopeMetrics: [] },
        resolve,
      ),
    );
    expect(result.code).toBe(1);
    await report.close();
  });
});
