import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { endTestSpan, recordsViewer, startTestSpan, type TestSpanInfo } from '../../e2e/otel.js';
import { inMemoryTracing } from '../../test-support/otel/sdk.js';

const info: TestSpanInfo = {
  titlePath: ['group', 'does a thing'],
  file: 'e2e/x.spec.ts',
  project: 'chromium-file',
  retry: 1,
  tags: ['@http'],
};

describe('test spans', () => {
  let setup: ReturnType<typeof inMemoryTracing>;
  beforeEach(() => {
    setup = inMemoryTracing();
  });

  async function finished() {
    await vi.waitFor(() => expect(setup.exporter.getFinishedSpans()).toHaveLength(1));
    return setup.exporter.getFinishedSpans();
  }

  it('names the span after the test and carries the Playwright attributes', async () => {
    endTestSpan(startTestSpan(setup.tracing, info), { status: 'passed' });
    const [span] = await finished();
    expect(span?.name).toBe('does a thing');
    expect(span?.attributes).toMatchObject({
      'test.suite.name': 'e2e/x.spec.ts',
      'test.case.name': 'group > does a thing',
      'test.case.result.status': 'pass',
      'playwright.project': 'chromium-file',
      'otel_html.test.retry': 1,
      'otel_html.test.tags': ['@http'],
    });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it.each(['failed', 'timedOut', 'interrupted'] as const)(
    '%s is an error with the message',
    async (status) => {
      endTestSpan(startTestSpan(setup.tracing, info), { status, error: { message: 'boom', stack: 'at x' } });
      const [span] = await finished();
      expect(span?.attributes['test.case.result.status']).toBe('fail');
      expect(span?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'boom' });
      expect(span?.events.map((e) => e.name)).toContain('exception');
    },
  );

  it('a skipped test has zero duration', async () => {
    endTestSpan(startTestSpan(setup.tracing, info), { status: 'skipped' });
    const [span] = await finished();
    expect(span?.attributes['test.case.result.status']).toBe('skipped');
    expect(span?.duration).toEqual([0, 0]);
  });
});

describe('endTestSpan colours', () => {
  it('strips ANSI colour codes from the message and stack', async () => {
    const setup = inMemoryTracing();
    const red = (t: string): string => `\u001b[31m${t}\u001b[39m`;
    endTestSpan(startTestSpan(setup.tracing, info), {
      status: 'failed',
      error: { message: `Expected ${red('1')}`, stack: `Error: ${red('boom')}\n  at x` },
    });
    await vi.waitFor(() => expect(setup.exporter.getFinishedSpans()).toHaveLength(1));
    const [span] = setup.exporter.getFinishedSpans();
    expect(span?.status.message).toBe('Expected 1');
    expect(span?.events[0]?.attributes).toEqual({
      'exception.message': 'Expected 1',
      'exception.stacktrace': 'Error: boom\n  at x',
    });
  });
});

describe('recordsViewer', () => {
  it('is off for perf-tagged tests, scale.spec.ts and load.spec.ts', () => {
    // Built by concatenation so vitest.config.ts' perf-file detection (a literal substring match on the tag) leaves this file in the default pass.
    expect(recordsViewer({ ...info, tags: [`@${'perf'}`] })).toBe(false);
    expect(recordsViewer({ ...info, file: 'e2e/scale.spec.ts' })).toBe(false);
    expect(recordsViewer({ ...info, file: 'e2e/load.spec.ts' })).toBe(false);
  });
  it('is on otherwise', () => {
    expect(recordsViewer(info)).toBe(true);
  });
});
