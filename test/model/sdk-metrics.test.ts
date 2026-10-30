import { fromJson, toJson } from '@bufbuild/protobuf';
import { ValueType } from '@opentelemetry/api';
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  AggregationType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { describe, expect, it } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { ExportMetricsServiceRequestSchema } from '../../src/model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import { resourceMetricsToRequest } from '../../src/model/sdk-metrics.js';

async function collect(temporality: AggregationTemporality): Promise<ResourceMetrics> {
  const memory = new InMemoryMetricExporter(temporality);
  const reader = new PeriodicExportingMetricReader({ exporter: memory, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': 'svc' }),
    readers: [reader],
    views: [{ instrumentName: 'exp.hist', aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM } }],
  });
  const meter = provider.getMeter('scope-a', '1.0.0');
  const attrs = { route: '/x', ok: true, n: 3 };
  meter.createCounter('c.int', { unit: '1', description: 'ints', valueType: ValueType.INT }).add(5, attrs);
  meter.createCounter('c.int', { valueType: ValueType.INT }).add(2, { route: '/y' });
  meter.createUpDownCounter('u.dbl', { valueType: ValueType.DOUBLE }).add(-1.5, attrs);
  meter.createObservableGauge('g.obs', { unit: 'By' }).addCallback((r) => r.observe(7.25, { host: 'h' }));
  const hist = meter.createHistogram('h.explicit', {
    advice: { explicitBucketBoundaries: [1, 10, 100] },
    unit: 'ms',
  });
  for (const v of [0.5, 5, 50, 500]) hist.record(v, attrs);
  const exp = meter.createHistogram('exp.hist');
  for (const v of [0, 1, 2, 4, 8, 0.3]) exp.record(v, attrs);
  await reader.forceFlush();
  const [rm] = memory.getMetrics();
  await provider.shutdown();
  if (!rm) throw new Error('no metrics');
  return rm;
}

function normalize(rm: ResourceMetrics): unknown {
  const oracle: unknown = JSON.parse(new TextDecoder().decode(JsonMetricsSerializer.serializeRequest(rm)));
  return toJson(
    ExportMetricsServiceRequestSchema,
    fromJson(ExportMetricsServiceRequestSchema, oracle as never),
  );
}

describe('resourceMetricsToRequest', () => {
  it.each([
    ['cumulative', AggregationTemporality.CUMULATIVE, 2],
    ['delta', AggregationTemporality.DELTA, 1],
  ])('matches the upstream OTLP JSON serializer (%s)', async (_n, temporality, otlp) => {
    const rm = await collect(temporality);
    const req = resourceMetricsToRequest(rm);
    expect(toJson(ExportMetricsServiceRequestSchema, req)).toEqual(normalize(rm));
    const metrics = req.resourceMetrics.flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const kinds = Object.fromEntries(metrics.map((m) => [m.name, m.data.case]));
    expect(kinds).toEqual({
      'c.int': 'sum',
      'u.dbl': 'sum',
      'g.obs': 'gauge',
      'h.explicit': 'histogram',
      'exp.hist': 'exponentialHistogram',
    });
    const sum = metrics.find((m) => m.name === 'c.int')?.data;
    expect(sum?.case === 'sum' && sum.value.aggregationTemporality).toBe(otlp);
    expect(sum?.case === 'sum' && sum.value.isMonotonic).toBe(true);
  });

  it('uses asInt for INT instruments and asDouble otherwise', async () => {
    const req = resourceMetricsToRequest(await collect(AggregationTemporality.CUMULATIVE));
    const metrics = req.resourceMetrics.flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics));
    const caseOf = (name: string): string | undefined => {
      const d = metrics.find((m) => m.name === name)?.data;
      return d?.case === 'sum' || d?.case === 'gauge' ? d.value.dataPoints[0]?.value.case : undefined;
    };
    expect(caseOf('c.int')).toBe('asInt');
    expect(caseOf('u.dbl')).toBe('asDouble');
    expect(caseOf('g.obs')).toBe('asDouble');
  });

  it('rejects a non-finite point on an INT instrument with a typed error', async () => {
    const rm = await collect(AggregationTemporality.CUMULATIVE);
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === 'c.int') (m.dataPoints[0] as { value: number }).value = Number.NaN;
      }
    }
    let caught: unknown;
    try {
      resourceMetricsToRequest(rm);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OtelHtmlError);
    expect(caught).toMatchObject({ code: 'invalid-otlp', path: 'c.int.dataPoints[0].value', actual: 'NaN' });
  });

  it('rejects an unsupported data point type with an error naming it', async () => {
    const rm = await collect(AggregationTemporality.CUMULATIVE);
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === 'c.int') (m as { dataPointType: number }).dataPointType = 99;
      }
    }
    let caught: unknown;
    try {
      resourceMetricsToRequest(rm);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OtelHtmlError);
    expect(caught).toMatchObject({
      code: 'unsupported-input',
      path: 'metric c.int',
      actual: 'data point type 99',
    });
  });
});
