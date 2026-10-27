import type { SerializedRollups } from '../format/state.js';
import { OtelHtmlError } from '../model/errors.js';
import { LogRollups } from './log-rollups.js';
import { METRIC_KEYS, type MetricKey, SignalCounts } from './signal-counts.js';
import { type SpanRollupOptions, SpanRollups } from './span-rollups.js';

export type ReportRollups = {
  spans: SpanRollups;
  logs: LogRollups;
  metrics: SignalCounts<MetricKey>;
};

export function createRollups(opts: SpanRollupOptions): ReportRollups {
  return {
    spans: new SpanRollups(opts),
    logs: new LogRollups(opts),
    metrics: new SignalCounts(METRIC_KEYS),
  };
}

export function serializeRollups(r: ReportRollups): SerializedRollups {
  return { spans: r.spans.toJSON(), logs: r.logs.toJSON(), metrics: r.metrics.toJSON() };
}

/** Rebuild rollups from `serializeRollups` output, failing fast with an `invalid-report` error. */
export function deserializeRollups(s: SerializedRollups, opts: SpanRollupOptions): ReportRollups {
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
    metrics: SignalCounts.from(metrics, METRIC_KEYS, 'rollups.metrics'),
  };
}
