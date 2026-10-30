import type { ExportResult } from '@opentelemetry/core';
import type { Report } from '../api/report.js';

export interface ExporterOptions {
  report: Report;
}

export type ExportCallback = (result: ExportResult) => void;

// ExportResultCode is a value, so it is not imported (exporters import the SDK as types only).
// These are its numeric members: SUCCESS = 0, FAILED = 1.
const SUCCESS = 0 as ExportResult['code'];
const FAILED = 1 as ExportResult['code'];

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Runs `add`, maps success/failure to an ExportResult (code 0 / 1 with `error`), refuses after shutdown. */
export class ReportExporter {
  protected readonly report: Report;
  #stopped = false;

  constructor(options: ExporterOptions) {
    this.report = options.report;
  }

  protected deliver(add: () => Promise<unknown>, callback: ExportCallback): void {
    if (this.#stopped) {
      callback({ code: FAILED, error: new Error('otel-html exporter is shut down') });
      return;
    }
    add().then(
      () => callback({ code: SUCCESS }),
      (e: unknown) => callback({ code: FAILED, error: asError(e) }),
    );
  }

  /** Write a checkpoint so the report is viewable before it is closed. */
  forceFlush(): Promise<void> {
    return this.report.flush();
  }

  /** Stop accepting exports. The report belongs to the caller, so it is flushed but not closed. */
  async shutdown(): Promise<void> {
    this.#stopped = true;
    await this.report.flush();
  }
}
