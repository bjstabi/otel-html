import { type Span, SpanStatusCode } from '@opentelemetry/api';
import type { TestTracing } from '../test-support/otel/sdk.js';

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
  const message = error?.message ?? status;
  span.setAttribute('test.case.result.status', 'fail');
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.addEvent('exception', {
    'exception.message': message,
    ...(error?.stack === undefined ? {} : { 'exception.stacktrace': error.stack }),
  });
  span.end();
}

/** Whether the in-page recorder runs for this test: not for timing-sensitive or load specs. */
export function recordsViewer(info: TestSpanInfo): boolean {
  if (info.tags.includes('@perf')) return false;
  return info.file !== 'e2e/scale.spec.ts' && info.file !== 'e2e/load.spec.ts';
}
