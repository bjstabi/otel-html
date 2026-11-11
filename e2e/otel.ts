import { readFileSync } from 'node:fs';
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { stderrOnce, type TestTracing, VIEWER_RESOURCE } from '../test-support/otel/sdk.js';
import { fromSpanJson, RECORDER_BINDING, RECORDER_PATH, type SpanJson } from './otel-page/span-json.js';

export interface TestSpanInfo {
  /** testInfo.titlePath without the file. */
  titlePath: readonly string[];
  /** Repo-relative spec path. */
  file: string;
  project: string;
  retry: number;
  tags: readonly string[];
}

export type TestOutcome = {
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  error?: { message?: string; stack?: string };
};

const startedAt = new WeakMap<Span, Date>();

export function startTestSpan(tracing: TestTracing, info: TestSpanInfo): Span {
  const start = new Date();
  const span = tracing.tracer.startSpan(
    info.titlePath.at(-1) ?? info.file,
    {
      startTime: start,
      attributes: {
        'test.suite.name': info.file,
        'test.case.name': info.titlePath.join(' > '),
        'playwright.project': info.project,
        'otel_html.test.retry': info.retry,
        'otel_html.test.tags': [...info.tags],
      },
    },
    tracing.parentFrom(process.env),
  );
  startedAt.set(span, start);
  return span;
}

/** Playwright colours its messages; the colour codes are noise in a trace backend. */
const plain = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

export function endTestSpan(span: Span, outcome: TestOutcome): void {
  const { status, error } = outcome;
  if (status === 'skipped') {
    span.setAttribute('test.case.result.status', 'skipped');
    span.end(startedAt.get(span));
    return;
  }
  if (status === 'passed') {
    span.setAttribute('test.case.result.status', 'pass');
    span.end();
    return;
  }
  const message = plain(error?.message ?? status);
  span.setAttribute('test.case.result.status', 'fail');
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.addEvent('exception', {
    'exception.message': message,
    ...(error?.stack === undefined ? {} : { 'exception.stacktrace': plain(error.stack) }),
  });
  span.end();
}

/**
 * Runs `fn` inside a span `name` under the job's trace (TRACEPARENT), so what `fn` starts through the worker SDK's
 * context manager is parented to it. Without `tracing` it is `fn()`. A rejection is recorded on the span (status
 * ERROR) and rethrown; the span ends either way.
 */
export async function withSpan<T>(
  tracing: TestTracing | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (tracing === undefined) return fn();
  const parent = tracing.parentFrom(process.env);
  const span = tracing.tracer.startSpan(name, {}, parent);
  try {
    return await context.with(trace.setSpan(parent, span), fn);
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error) span.recordException(error);
    throw error;
  } finally {
    span.end();
  }
}

/** Whether the in-page recorder runs for this test: not for timing-sensitive or load specs. */
export function recordsViewer(info: TestSpanInfo): boolean {
  if (info.tags.includes('@perf')) return false;
  return info.file !== 'e2e/scale.spec.ts' && info.file !== 'e2e/load.spec.ts';
}

/** The part of Playwright's BrowserContext this needs (a structural type keeps Playwright's DOM-typed API out of the node project). */
export interface RecordableContext {
  exposeFunction(name: string, callback: (json: SpanJson) => void): Promise<unknown>;
  addInitScript(script: { content: string }): Promise<unknown>;
  pages(): { evaluate(fn: () => number): Promise<number> }[];
}

const VIEWER_SPAN_LIMIT = 2_000;
const warnNoRecorder = stderrOnce();

function recorderBundle(): string | undefined {
  try {
    return readFileSync(new URL(`../${RECORDER_PATH}`, import.meta.url), 'utf8');
  } catch {
    warnNoRecorder(`${RECORDER_PATH} is missing (run mise run e2e:otel-recorder); no browser spans`);
    return undefined;
  }
}

/**
 * Records the viewer's spans in every page of `context` (popups included) as children of `parent`, via the bundled
 * in-page recorder. Without the bundle it warns once per worker and records nothing. Spans past `limit` are dropped
 * and counted; `settle()` waits for what the pages have already sent and returns the dropped count.
 */
export async function instrumentContext(
  context: RecordableContext,
  tracing: TestTracing,
  parent: Span,
  limit?: number,
): Promise<{ settle(): Promise<{ dropped: number }> }> {
  const bundle = recorderBundle();
  const cap = limit ?? VIEWER_SPAN_LIMIT;
  let recorded = 0;
  let dropped = 0;
  const inFlight = new Set<Promise<void>>();
  if (bundle !== undefined) {
    await context.exposeFunction(RECORDER_BINDING, (json: SpanJson): void => {
      if (recorded >= cap) {
        dropped += 1;
        return;
      }
      recorded += 1;
      const work = Promise.resolve().then(() => tracing.record(fromSpanJson(json, VIEWER_RESOURCE)));
      const tracked = work.catch(() => undefined).finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
    });
    const { traceId, spanId, traceFlags } = parent.spanContext();
    await context.addInitScript({
      content: `globalThis.__otelHtmlParent = ${JSON.stringify({ traceId, spanId, traceFlags })};\n${bundle}`,
    });
  }
  return {
    async settle() {
      // Messages on a page's connection arrive in order, so a round trip after the page's binding calls means the
      // worker has received them all.
      await Promise.all(context.pages().map((page) => page.evaluate(() => 0).catch(() => undefined)));
      await Promise.all(inFlight);
      return { dropped };
    },
  };
}
