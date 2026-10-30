import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { type ExportCallback, ReportExporter } from './base.js';

/** A log record exporter that writes the records into an otel-html Report. */
export class OtelHtmlLogRecordExporter extends ReportExporter implements LogRecordExporter {
  export(logs: ReadableLogRecord[], resultCallback: ExportCallback): void {
    this.deliver(() => this.report.addLogs(logs), resultCallback);
  }
}
