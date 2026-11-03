import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type Context,
  defaultTextMapGetter,
  propagation,
  ROOT_CONTEXT,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import { type Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { hasEndpoint } from './enabled.ts';

/**
 * The test-side OpenTelemetry SDK, shared by vitest's workers and Playwright's. `NodeSDK` registers the global
 * provider, W3C propagator and context manager; this module configures it for traces only, from the environment.
 */
export type TestFramework = 'vitest' | 'playwright';
type Env = Readonly<Record<string, string | undefined>>;

export interface TestTracing {
  readonly tracer: Tracer;
  /** The context TRACEPARENT names (the W3C propagator), or ROOT_CONTEXT. */
  parentFrom(env: Env): Context;
  /** Queue an already-finished span (from the browser) on the SDK's span processor. */
  record(span: ReadableSpan): void;
  /** Flush, capped at SHUTDOWN_CAP_MS; never rejects. */
  shutdown(): Promise<void>;
}

const TRACER_NAME = 'otel-html-tests';
const SHUTDOWN_CAP_MS = 5_000;

function packageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
    const { version } = parsed;
    if (typeof version === 'string') return version;
  }
  return 'unknown';
}

export const VIEWER_RESOURCE: Resource = resourceFromAttributes({
  'service.name': 'otel-html-viewer',
  'service.version': packageVersion(),
});

/** A writer of `otel-html tests: <message>` lines to stderr that writes only the first message. */
export function stderrOnce(): (message: string) => void {
  let written = false;
  return (message) => {
    if (written) return;
    written = true;
    process.stderr.write(`otel-html tests: ${message}\n`);
  };
}

type ExporterModule = { OTLPTraceExporter: new () => SpanExporter };

function otlpExporter(
  env: Env,
  warn: (message: string) => void,
  load: (name: string) => ExporterModule = createRequire(import.meta.url),
): SpanExporter | undefined {
  const { OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, OTEL_EXPORTER_OTLP_PROTOCOL } = env;
  const protocol = OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || OTEL_EXPORTER_OTLP_PROTOCOL || 'http/protobuf';
  const packages: Readonly<Record<string, string>> = {
    'http/protobuf': '@opentelemetry/exporter-trace-otlp-proto',
    'http/json': '@opentelemetry/exporter-trace-otlp-http',
    grpc: '@opentelemetry/exporter-trace-otlp-grpc',
  };
  const name = packages[protocol];
  if (name === undefined) {
    warn(`unknown OTLP protocol "${protocol}"; tracing is off`);
    return undefined;
  }
  try {
    const loaded: ExporterModule = load(name);
    return new loaded.OTLPTraceExporter();
  } catch (e) {
    warn(`cannot load ${name}: ${e instanceof Error ? e.message : String(e)}; tracing is off`);
    return undefined;
  }
}

/** One stderr line per process when an export fails; the result still reaches the processor. */
export function reporting(inner: SpanExporter, warn: (message: string) => void): SpanExporter {
  return {
    export(spans, done) {
      try {
        inner.export(spans, (result) => {
          if (result.code !== ExportResultCode.SUCCESS) {
            warn(`span export failed${`: ${result.error?.message || 'no detail'}`}`);
          }
          done(result);
        });
      } catch (e) {
        warn(`span export failed: ${e instanceof Error ? e.message : String(e)}`);
        done({ code: ExportResultCode.FAILED });
      }
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

function capped(work: () => Promise<void>, capMs: number = SHUTDOWN_CAP_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, capMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    try {
      work().then(done, done);
    } catch {
      done();
    }
  });
}

function traceparentContext(propagator: Pick<W3CTraceContextPropagator, 'extract'>, env: Env): Context {
  const { TRACEPARENT: traceparent } = env;
  if (!traceparent) return ROOT_CONTEXT;
  try {
    return propagator.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
  } catch {
    return ROOT_CONTEXT;
  }
}

/**
 * Starts the global SDK, or returns undefined when there is no endpoint (and no injected exporter) or
 * OTEL_SDK_DISABLED=true. An injected exporter bypasses the endpoint check; otherwise the OTLP exporter is built from
 * the environment (protocol, endpoint, headers).
 */
export function startTestSdk(
  env: Env,
  framework: TestFramework,
  options: {
    exporter?: SpanExporter;
    processor?: 'batch' | 'simple';
    shutdownCapMs?: number;
    loadExporter?: (name: string) => ExporterModule;
  } = {},
): TestTracing | undefined {
  const { OTEL_SDK_DISABLED, OTEL_HTML_TEST_SERVICE_NAME } = env;
  if (OTEL_SDK_DISABLED === 'true') return undefined;
  const warn = stderrOnce();
  let exporter = options.exporter;
  if (exporter === undefined) {
    if (!hasEndpoint(env)) return undefined;
    const built = otlpExporter(env, warn, options.loadExporter);
    if (built === undefined) return undefined;
    exporter = reporting(built, warn);
  }
  const processor: SpanProcessor =
    options.processor === 'simple'
      ? new SimpleSpanProcessor({ exporter })
      : new BatchSpanProcessor({ exporter });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': OTEL_HTML_TEST_SERVICE_NAME || TRACER_NAME,
      'service.version': packageVersion(),
      'test.framework': framework,
    }),
    resourceDetectors: [],
    spanProcessors: [processor],
    // Empty arrays keep NodeSDK from building the env-default OTLP metric and log exporters (it still registers a
    // processor-less global LoggerProvider, which is harmless).
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations: [],
  });
  sdk.start();
  return {
    tracer: trace.getTracer(TRACER_NAME),
    parentFrom: (e) => traceparentContext({ extract: (c, ...r) => propagation.extract(c, ...r) }, e),
    record: (span) => processor.onEnd(span),
    shutdown: () => capped(() => sdk.shutdown(), options.shutdownCapMs),
  };
}

/** A non-global TestTracing over an in-memory exporter (simple processor); registers nothing globally. */
export function inMemoryTracing(): { tracing: TestTracing; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor({ exporter });
  const provider = new TracerProvider({ spanProcessors: [processor] });
  const propagator = new W3CTraceContextPropagator();
  return {
    exporter,
    tracing: {
      tracer: provider.getTracer(TRACER_NAME),
      parentFrom: (env) => traceparentContext(propagator, env),
      record: (span) => processor.onEnd(span),
      shutdown: () => capped(() => provider.shutdown()),
    },
  };
}
