import { create } from '@bufbuild/protobuf';
import { ValueType } from '@opentelemetry/api';
import type {
  DataPoint,
  ExponentialHistogram,
  Histogram,
  MetricData,
  ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import { OtelHtmlError } from './errors.js';
import {
  type ExportMetricsServiceRequest,
  ExportMetricsServiceRequestSchema,
} from './gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import { InstrumentationScopeSchema } from './gen/opentelemetry/proto/common/v1/common_pb.js';
import {
  type ExponentialHistogramDataPoint_Buckets,
  ExponentialHistogramDataPoint_BucketsSchema,
  ExponentialHistogramDataPointSchema,
  ExponentialHistogramSchema,
  GaugeSchema,
  HistogramDataPointSchema,
  HistogramSchema,
  type Metric,
  MetricSchema,
  NumberDataPointSchema,
  AggregationTemporality as OtlpTemporality,
  ResourceMetricsSchema,
  type ScopeMetrics,
  ScopeMetricsSchema,
  SumSchema,
} from './gen/opentelemetry/proto/metrics/v1/metrics_pb.js';
import { ResourceSchema } from './gen/opentelemetry/proto/resource/v1/resource_pb.js';
import { attributesToKeyValues, hrToNanos } from './sdk-spans.js';

// The SDK enums are values, so they are not imported (SDK mappers import @opentelemetry/sdk-* as types only).
// DataPointType: HISTOGRAM = 0, EXPONENTIAL_HISTOGRAM = 1, GAUGE = 2, SUM = 3.
// AggregationTemporality: DELTA = 0, CUMULATIVE = 1.
const POINT_TYPE = { HISTOGRAM: 0, EXPONENTIAL_HISTOGRAM: 1, GAUGE: 2, SUM: 3 } as const;
const SDK_DELTA = 0;

function temporalityOf(sdk: number): OtlpTemporality {
  return sdk === SDK_DELTA ? OtlpTemporality.DELTA : OtlpTemporality.CUMULATIVE;
}

function common<T>(p: DataPoint<T>) {
  return {
    attributes: attributesToKeyValues(p.attributes),
    startTimeUnixNano: hrToNanos(p.startTime),
    timeUnixNano: hrToNanos(p.endTime),
  };
}

function buckets(b: { offset: number; bucketCounts: number[] }): ExponentialHistogramDataPoint_Buckets {
  return create(ExponentialHistogramDataPoint_BucketsSchema, {
    offset: b.offset,
    bucketCounts: b.bucketCounts.map(BigInt),
  });
}

function toMetric(m: MetricData): Metric {
  const { name, description, unit, valueType } = m.descriptor;
  const head = { name, description, unit };
  const isInt = valueType === ValueType.INT;
  const numberPoints = (points: DataPoint<number>[]) =>
    points.map((p, i) => {
      if (isInt && !Number.isFinite(p.value)) {
        throw new OtelHtmlError('invalid-otlp', {
          path: `${name}.dataPoints[${i}].value`,
          expected: 'a finite integer',
          actual: String(p.value),
        });
      }
      return create(NumberDataPointSchema, {
        ...common(p),
        value: isInt
          ? { case: 'asInt', value: BigInt(Math.trunc(p.value)) }
          : { case: 'asDouble', value: p.value },
      });
    });
  const temporality = temporalityOf(m.aggregationTemporality);

  switch (m.dataPointType as number) {
    case POINT_TYPE.GAUGE:
      return create(MetricSchema, {
        ...head,
        data: {
          case: 'gauge',
          value: create(GaugeSchema, { dataPoints: numberPoints(m.dataPoints as DataPoint<number>[]) }),
        },
      });
    case POINT_TYPE.SUM:
      return create(MetricSchema, {
        ...head,
        data: {
          case: 'sum',
          value: create(SumSchema, {
            dataPoints: numberPoints(m.dataPoints as DataPoint<number>[]),
            aggregationTemporality: temporality,
            isMonotonic: 'isMonotonic' in m && m.isMonotonic,
          }),
        },
      });
    case POINT_TYPE.HISTOGRAM:
      return create(MetricSchema, {
        ...head,
        data: {
          case: 'histogram',
          value: create(HistogramSchema, {
            aggregationTemporality: temporality,
            dataPoints: (m.dataPoints as DataPoint<Histogram>[]).map((p) =>
              create(HistogramDataPointSchema, {
                ...common(p),
                count: BigInt(p.value.count),
                sum: p.value.sum,
                bucketCounts: p.value.buckets.counts.map(BigInt),
                explicitBounds: p.value.buckets.boundaries,
                min: p.value.min,
                max: p.value.max,
              }),
            ),
          }),
        },
      });
    case POINT_TYPE.EXPONENTIAL_HISTOGRAM:
      return create(MetricSchema, {
        ...head,
        data: {
          case: 'exponentialHistogram',
          value: create(ExponentialHistogramSchema, {
            aggregationTemporality: temporality,
            dataPoints: (m.dataPoints as DataPoint<ExponentialHistogram>[]).map((p) =>
              create(ExponentialHistogramDataPointSchema, {
                ...common(p),
                count: BigInt(p.value.count),
                sum: p.value.sum,
                scale: p.value.scale,
                zeroCount: BigInt(p.value.zeroCount),
                positive: buckets(p.value.positive),
                negative: buckets(p.value.negative),
                min: p.value.min,
                max: p.value.max,
              }),
            ),
          }),
        },
      });
    default:
      throw new OtelHtmlError('unsupported-input', {
        path: `metric ${name}`,
        expected: 'gauge, sum, histogram or exponential histogram',
        actual: `data point type ${String(m.dataPointType)}`,
      });
  }
}

function toScopeMetrics(sm: ResourceMetrics['scopeMetrics'][number]): ScopeMetrics {
  const sc = sm.scope;
  return create(ScopeMetricsSchema, {
    scope: create(InstrumentationScopeSchema, {
      name: sc.name,
      version: sc.version ?? '',
    }),
    metrics: sm.metrics.map(toMetric),
    schemaUrl: sc.schemaUrl ?? '',
  });
}

/** One collected SDK `ResourceMetrics` as an OTLP `ExportMetricsServiceRequest`. */
export function resourceMetricsToRequest(rm: ResourceMetrics): ExportMetricsServiceRequest {
  return create(ExportMetricsServiceRequestSchema, {
    resourceMetrics: [
      create(ResourceMetricsSchema, {
        resource: create(ResourceSchema, { attributes: attributesToKeyValues(rm.resource.attributes) }),
        scopeMetrics: rm.scopeMetrics.map(toScopeMetrics),
        schemaUrl: rm.resource.schemaUrl ?? '',
      }),
    ],
  });
}
