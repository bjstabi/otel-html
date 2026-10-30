import type { AggregationTemporality, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { type ExportCallback, type ExporterOptions, ReportExporter } from './base.js';

export interface MetricExporterOptions extends ExporterOptions {
  /** Aggregation temporality the SDK should collect with. Default `cumulative`. */
  temporality?: 'cumulative' | 'delta';
}

// AggregationTemporality is a value, so it is not imported (exporters import the SDK as types only).
// These are its numeric members: DELTA = 0, CUMULATIVE = 1.
const TEMPORALITY: Record<'cumulative' | 'delta', AggregationTemporality> = {
  cumulative: 1 as AggregationTemporality,
  delta: 0 as AggregationTemporality,
};

/** A push metric exporter that writes collected metrics into an otel-html Report. */
export class OtelHtmlMetricExporter extends ReportExporter implements PushMetricExporter {
  readonly #temporality: AggregationTemporality;

  constructor(options: MetricExporterOptions) {
    super(options);
    this.#temporality = TEMPORALITY[options.temporality ?? 'cumulative'];
  }

  export(metrics: ResourceMetrics, resultCallback: ExportCallback): void {
    this.deliver(() => this.report.addMetrics(metrics), resultCallback);
  }

  selectAggregationTemporality(): AggregationTemporality {
    return this.#temporality;
  }
}
