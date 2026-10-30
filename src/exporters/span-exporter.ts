import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { type ExportCallback, ReportExporter } from './base.js';

/** A span exporter that writes the spans into an otel-html Report. */
export class OtelHtmlSpanExporter extends ReportExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    this.deliver(() => this.report.addSpans(spans), resultCallback);
  }
}
