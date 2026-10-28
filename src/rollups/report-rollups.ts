import type { SerializedRollups } from '../format/state.js';
import { OtelHtmlError } from '../model/errors.js';
import { LogRollups } from './log-rollups.js';
import { MetricCatalog } from './metric-catalog.js';
import { METRIC_KEYS, type MetricKey, SignalCounts } from './signal-counts.js';
import { type SpanRollupOptions, SpanRollups } from './span-rollups.js';

export type MetricRollups = {
  buckets: SignalCounts<MetricKey>;
  catalog: MetricCatalog;
};

export type ReportRollups = {
  spans: SpanRollups;
  logs: LogRollups;
  metrics: MetricRollups;
};

export type RollupOptions = SpanRollupOptions & { readonly metricSeriesCap: number };

export function createRollups(opts: RollupOptions): ReportRollups {
  return {
    spans: new SpanRollups(opts),
    logs: new LogRollups(opts),
    metrics: {
      buckets: new SignalCounts(METRIC_KEYS),
      catalog: new MetricCatalog({ seriesCap: opts.metricSeriesCap }),
    },
  };
}

export function serializeRollups(r: ReportRollups): SerializedRollups {
  return {
    spans: r.spans.toJSON(),
    logs: r.logs.toJSON(),
    metrics: { buckets: r.metrics.buckets.toJSON(), catalog: r.metrics.catalog.toJSON() },
  };
}

/** Rebuild rollups from `serializeRollups` output, failing fast with an `invalid-report` error. */
export function deserializeRollups(s: SerializedRollups, opts: RollupOptions): ReportRollups {
  for (const k of ['spans', 'logs', 'metrics'] as const) {
    if (!Object.hasOwn(s, k)) {
      throw new OtelHtmlError('invalid-report', {
        path: `rollups.${k}`,
        expected: 'rollup object',
        actual: 'missing',
      });
    }
  }
  const { spans, logs, metrics } = s;
  return {
    spans: SpanRollups.from(spans, opts, 'rollups.spans'),
    logs: LogRollups.from(logs, opts, 'rollups.logs'),
    metrics: deserializeMetrics(metrics, opts),
  };
}

function deserializeMetrics(m: unknown, opts: RollupOptions): MetricRollups {
  if (typeof m !== 'object' || m === null || !Object.hasOwn(m, 'buckets') || !Object.hasOwn(m, 'catalog')) {
    throw new OtelHtmlError('invalid-report', {
      path: 'rollups.metrics',
      expected: 'object with buckets and catalog',
      actual: JSON.stringify(m) ?? 'undefined',
    });
  }
  return {
    buckets: SignalCounts.from(Reflect.get(m, 'buckets'), METRIC_KEYS, 'rollups.metrics.buckets'),
    catalog: MetricCatalog.from(
      Reflect.get(m, 'catalog'),
      { seriesCap: opts.metricSeriesCap },
      'rollups.metrics.catalog',
    ),
  };
}
