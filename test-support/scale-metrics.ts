import { create } from '@bufbuild/protobuf';
import {
  type ExportMetricsServiceRequest,
  ExportMetricsServiceRequestSchema,
} from '../src/model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import {
  AnyValueSchema,
  type KeyValue,
  KeyValueSchema,
} from '../src/model/gen/opentelemetry/proto/common/v1/common_pb.js';
import {
  AggregationTemporality,
  type Metric,
  MetricSchema,
  NumberDataPointSchema,
} from '../src/model/gen/opentelemetry/proto/metrics/v1/metrics_pb.js';

/**
 * Deterministic metrics for the metrics scale report: `metrics` metrics × `series` series, one collection every
 * `SCALE_METRIC_STEP_NS` (10 s) from `SCALE_METRIC_EPOCH_NS`. Even metrics are cumulative monotonic counters (unit
 * `1`), odd ones gauges (unit `By`). Series `j` carries `host` = `host-<j % 50>` and `route` = `/api/v1/route-<j>`, on
 * one of `SCALE_METRIC_SERVICES` by metric. Every value is a pure function of (metric, series, collection).
 */
export const SCALE_METRIC_EPOCH_NS = 1_700_000_000_000_000_000n;
export const SCALE_METRIC_STEP_NS = 10_000_000_000n;
export const SCALE_METRIC_SERVICES = ['edge', 'api', 'auth', 'db'] as const;
const HOSTS = 50;

export function scaleMetricName(m: number): string {
  return `scale.metric.${String(m).padStart(3, '0')}`;
}

const str = (key: string, value: string): KeyValue =>
  create(KeyValueSchema, { key, value: create(AnyValueSchema, { value: { case: 'stringValue', value } }) });

/**
 * One request per collection: collections `firstPoint` … `firstPoint + points - 1`. A large run is generated a few
 * collections at a time, so only those are in memory at once.
 */
export function scaleMetrics(
  metrics: number,
  series: number,
  points: number,
  firstPoint = 0,
): ExportMetricsServiceRequest[] {
  const attributes = Array.from({ length: series }, (_, j) => [
    str('host', `host-${j % HOSTS}`),
    str('route', `/api/v1/route-${j}`),
  ]);
  const resources = SCALE_METRIC_SERVICES.map((s) => ({ attributes: [str('service.name', s)] }));
  const scope = { name: 'e2e-scale-metrics', version: '1' };
  const out: ExportMetricsServiceRequest[] = [];
  for (let i = firstPoint; i < firstPoint + points; i++) {
    const time = SCALE_METRIC_EPOCH_NS + BigInt(i) * SCALE_METRIC_STEP_NS;
    const byService: Metric[][] = SCALE_METRIC_SERVICES.map(() => []);
    for (let m = 0; m < metrics; m++) {
      const gauge = m % 2 === 1;
      const dataPoints = attributes.map((attrs, j) =>
        create(NumberDataPointSchema, {
          attributes: attrs,
          ...(gauge ? {} : { startTimeUnixNano: SCALE_METRIC_EPOCH_NS }),
          timeUnixNano: time,
          value: { case: 'asInt', value: BigInt(gauge ? (i * 7 + j * 13 + m) % 1000 : i * ((j % 17) + 1)) },
        }),
      );
      const metric = create(MetricSchema, {
        name: scaleMetricName(m),
        unit: gauge ? 'By' : '1',
        data: gauge
          ? { case: 'gauge', value: { dataPoints } }
          : {
              case: 'sum',
              value: {
                aggregationTemporality: AggregationTemporality.CUMULATIVE,
                isMonotonic: true,
                dataPoints,
              },
            },
      });
      byService[m % SCALE_METRIC_SERVICES.length]?.push(metric);
    }
    out.push(
      create(ExportMetricsServiceRequestSchema, {
        resourceMetrics: resources.map((resource, k) => ({
          resource,
          scopeMetrics: [{ scope, metrics: byService[k] ?? [] }],
        })),
      }),
    );
  }
  return out;
}
