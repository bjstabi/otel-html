import { basename } from 'node:path';
import { trace } from '@opentelemetry/api';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import pkg from '../../package.json' with { type: 'json' };
import { loadConfigFile } from '../config/load.js';
import { resolveConfig } from '../config/resolve.js';
import type { ConfigInput, ResolvedConfig } from '../config/schema.js';
import { OtelHtmlError } from '../model/errors.js';
import type { ExportLogsServiceRequest } from '../model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import { ExportLogsServiceRequestSchema } from '../model/gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import type { ExportMetricsServiceRequest } from '../model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import { ExportMetricsServiceRequestSchema } from '../model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import type { ExportTraceServiceRequest } from '../model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { ExportTraceServiceRequestSchema } from '../model/gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';
import { type OtlpRequest, parseOtlpObject } from '../model/otlp-json.js';
import { readableLogRecordsToRequest } from '../model/sdk-logs.js';
import { readableSpansToRequest } from '../model/sdk-spans.js';
import { createNodeFileSystem } from '../writer/node-fs.js';
import {
  type AddResult,
  openSession,
  type ReportSummary,
  type WriterDeps,
  type WriterSession,
} from '../writer/session.js';
import { assertAssetPath } from '../writer/viewer-assets.js';
import { createConsoleLogger, createProcessInfo, createSystemClock } from './system.js';
import { createOtelTracer } from './telemetry.js';
import { packageDirViewerAssets } from './viewer-dir.js';

export type { AddResult };

/** The writer session behind a report: for the receiver and commands in this package, not part of the public API. */
export let sessionOf: (report: Report) => WriterSession;
/** The resolved configuration a report was created with. */
export let configOf: (report: Report) => ResolvedConfig;

/** The composition root: every real dependency is wired here and nowhere else. */
export function defaultDeps(): WriterDeps {
  return {
    fs: createNodeFileSystem(),
    clock: createSystemClock(),
    logger: createConsoleLogger(),
    tracer: createOtelTracer(trace.getTracer('otel-html', pkg.version)),
    process: createProcessInfo(),
    viewerAssets: packageDirViewerAssets([
      new URL('./viewer/', import.meta.url), // published: dist/index.js next to dist/viewer/
      new URL('../../dist/viewer/', import.meta.url), // development: src/api/report.ts
    ]),
    version: pkg.version,
  };
}

/**
 * Defaults plus overrides, with the viewer assets checked up front: a missing or malformed viewer build
 * fails here with a `usage` error, before any data is read or written.
 */
export async function resolveDeps(overrides: Partial<WriterDeps> | undefined): Promise<WriterDeps> {
  const deps = { ...defaultDeps(), ...overrides };
  for (const f of await deps.viewerAssets.files()) assertAssetPath(f.path);
  deps.viewerAssets.entry();
  return deps;
}

/**
 * Library configuration: an object (highest precedence) or the path of a YAML/JSON file. Environment
 * variables are deliberately not read (`env: {}`); mapping them onto config is the CLI's job.
 */
export async function resolveApiConfig(
  deps: WriterDeps,
  config: ConfigInput | string | undefined,
  title: string | undefined,
): Promise<ResolvedConfig> {
  const file = typeof config === 'string' ? await loadConfigFile(deps.fs, config) : undefined;
  const object = typeof config === 'string' ? undefined : config;
  const flags: ConfigInput | undefined = title === undefined ? object : { ...object, title };
  return resolveConfig({
    ...(file === undefined || typeof config !== 'string' ? {} : { file, fileLabel: basename(config) }),
    env: {},
    ...(flags === undefined ? {} : { flags }),
  }).config;
}

export interface ReportOptions {
  /** The report folder. */
  out: string;
  title?: string;
  /** A config object, or the path of an `otel-html.yaml`. Environment variables are not read. */
  config?: ConfigInput | string;
  /** Reopen an existing report (same otel-html version) instead of replacing it. */
  append?: boolean;
}

function isMessage(input: object, typeName: string): boolean {
  return '$typeName' in input && input.$typeName === typeName;
}

/** Requests from an OTLP-JSON object, refusing input that carries any signal but `signal`. */
function requestsOf(method: string, signal: OtlpRequest['signal'], input: object): OtlpRequest[] {
  const found = parseOtlpObject(input, method);
  for (const r of found) {
    if (r.signal !== signal) {
      throw new OtelHtmlError('invalid-otlp', {
        message: `${method}: input carries ${r.signal} (${SIGNAL_KEY[r.signal]}); ${method} takes ${signal} only`,
        hint: `use ${METHOD_FOR[r.signal]} for ${r.signal}`,
      });
    }
  }
  return found;
}

const SIGNAL_KEY: Record<OtlpRequest['signal'], string> = {
  traces: 'resourceSpans',
  logs: 'resourceLogs',
  metrics: 'resourceMetrics',
};
const METHOD_FOR: Record<OtlpRequest['signal'], string> = {
  traces: 'addSpans',
  logs: 'addLogs',
  metrics: 'addMetrics',
};

function sum(a: AddResult, b: AddResult): AddResult {
  return {
    accepted: a.accepted + b.accepted,
    dropped: a.dropped + b.dropped,
    duplicates: a.duplicates + b.duplicates,
  };
}

const NOTHING: AddResult = { accepted: 0, dropped: 0, duplicates: 0 };

/** A streaming report writer. Feed it telemetry, then `close()` to finish the report. */
export class Report {
  readonly #session: WriterSession;
  readonly #config: ResolvedConfig;

  static {
    sessionOf = (report) => report.#session;
    configOf = (report) => report.#config;
  }

  private constructor(session: WriterSession, config: ResolvedConfig) {
    this.#session = session;
    this.#config = config;
  }

  static async create(options: ReportOptions, deps?: Partial<WriterDeps>): Promise<Report> {
    const full = await resolveDeps(deps);
    return Report.createResolved(options, await resolveApiConfig(full, options.config, options.title), full);
  }

  /** Internal (the CLI): like `create`, with config already resolved so dashboard sources are kept. */
  static async createResolved(
    options: Pick<ReportOptions, 'out' | 'append'>,
    config: ResolvedConfig,
    full: WriterDeps,
  ): Promise<Report> {
    const session = await openSession(full, {
      out: options.out,
      config,
      mode: options.append === true ? 'append' : 'create',
    });
    return new Report(session, config);
  }

  /** SDK spans, a protobuf `ExportTraceServiceRequest`, or an OTLP-JSON object. */
  async addSpans(input: readonly ReadableSpan[] | ExportTraceServiceRequest | object): Promise<AddResult> {
    if (Array.isArray(input)) {
      if (input.length === 0) return NOTHING;
      return this.#session.add({ signal: 'traces', request: readableSpansToRequest(input) }, 'addSpans');
    }
    if (isMessage(input, ExportTraceServiceRequestSchema.typeName)) {
      return this.#session.add({ signal: 'traces', request: input as ExportTraceServiceRequest }, 'addSpans');
    }
    return this.#addAll(requestsOf('addSpans', 'traces', input), 'addSpans');
  }

  /** SDK log records, a protobuf `ExportLogsServiceRequest`, or an OTLP-JSON object. */
  async addLogs(input: readonly ReadableLogRecord[] | ExportLogsServiceRequest | object): Promise<AddResult> {
    if (Array.isArray(input)) {
      if (input.length === 0) return NOTHING;
      return this.#session.add({ signal: 'logs', request: readableLogRecordsToRequest(input) }, 'addLogs');
    }
    if (isMessage(input, ExportLogsServiceRequestSchema.typeName)) {
      return this.#session.add({ signal: 'logs', request: input as ExportLogsServiceRequest }, 'addLogs');
    }
    return this.#addAll(requestsOf('addLogs', 'logs', input), 'addLogs');
  }

  /**
   * A protobuf-es `ExportMetricsServiceRequest` or an OTLP-JSON object. OTLP JSON is read in place, not copied:
   * leave it unchanged until the returned promise settles.
   */
  async addMetrics(input: ExportMetricsServiceRequest | object): Promise<AddResult> {
    if (isMessage(input, ExportMetricsServiceRequestSchema.typeName)) {
      return this.#session.add(
        { signal: 'metrics', request: input as ExportMetricsServiceRequest },
        'addMetrics',
      );
    }
    return this.#addAll(requestsOf('addMetrics', 'metrics', input), 'addMetrics');
  }

  async #addAll(requests: readonly OtlpRequest[], source: string): Promise<AddResult> {
    let total = NOTHING;
    for (const request of requests) total = sum(total, await this.#session.add(request, source));
    return total;
  }

  /** Write everything received so far to disk (the report is viewable and resumable afterwards). */
  flush(): Promise<void> {
    return this.#session.flush();
  }

  /** Finish the report and release the folder. */
  close(): Promise<ReportSummary> {
    return this.#session.close();
  }
}
