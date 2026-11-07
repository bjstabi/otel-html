import type { Span } from '@opentelemetry/api';
import { type BrowserContext, expect, test as playwrightTest, type TestInfo } from '@playwright/test';
import { startTestSdk, type TestTracing } from '../test-support/otel/sdk.js';
import { baseUrlFor, type ReportName, type UrlKind } from './fixture.js';
import { endTestSpan, instrumentContext, recordsViewer, startTestSpan, type TestSpanInfo } from './otel.js';

/** True for an http(s) or ws(s) URL whose host is not loopback. */
export function isOffMachine(url: string): boolean {
  const u = new URL(url);
  if (!/^(?:https?|wss?):$/.test(u.protocol)) return false;
  return !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

/**
 * Watches every request of `context`; the returned function fails the test if one went off this machine. The
 * fixture applies it to the test's own context; a test that opens a context of its own calls it on that one.
 */
export function guardContext(context: BrowserContext): () => void {
  const outside: string[] = [];
  context.on('request', (request) => {
    if (isOffMachine(request.url())) outside.push(request.url());
  });
  return () => expect(outside, 'a report must not request anything outside its own origin').toEqual([]);
}

function kindOf(projectName: string): UrlKind {
  const kind = projectName.split('-').at(-1);
  if (kind !== 'file' && kind !== 'http') throw new Error(`project ${projectName} has no url kind`);
  return kind;
}

function spanInfo(testInfo: TestInfo): TestSpanInfo {
  return {
    titlePath: testInfo.titlePath.slice(1),
    file: testInfo.titlePath[0] ? `e2e/${testInfo.titlePath[0]}` : testInfo.file,
    project: testInfo.project.name,
    retry: testInfo.retry,
    tags: testInfo.tags,
  };
}

/** The base `test` plus the OpenTelemetry fixtures: a worker SDK and a span per test (both undefined without an endpoint). */
const base = playwrightTest.extend<
  { otelTestSpan: Span | undefined; ownOriginOnly: undefined },
  { otelTracing: TestTracing | undefined }
>({
  otelTracing: [
    async ({ playwright: _unused }, use) => {
      const tracing = startTestSdk(process.env, 'playwright');
      await use(tracing);
      await tracing?.shutdown();
    },
    { scope: 'worker', auto: true },
  ],
  // A report never touches the network: it fails any test whose pages (or their workers) request an http(s) or
  // ws(s) origin that is not this machine (the static server). file:, data: and blob: are the report's own.
  ownOriginOnly: [
    async ({ context }, use) => {
      const check = guardContext(context);
      await use(undefined);
      check();
    },
    { auto: true },
  ],
  otelTestSpan: [
    async ({ otelTracing }, use, testInfo) => {
      const span = otelTracing && startTestSpan(otelTracing, spanInfo(testInfo));
      await use(span);
      if (span === undefined) return;
      const { status = 'interrupted', error } = testInfo;
      endTestSpan(span, error === undefined ? { status } : { status, error });
    },
    { auto: true },
  ],
});

export const test = base.extend<{ reportUrl: (name: ReportName) => string }>({
  // The viewer's spans are recorded in every page of the test's context, as children of the test span. The recorder
  // settles before the base `context` closes it, which is before the test span ends (fixtures tear down in reverse).
  context: async ({ context, otelTracing, otelTestSpan }, use, testInfo) => {
    const info = spanInfo(testInfo);
    if (otelTracing === undefined || otelTestSpan === undefined || !recordsViewer(info)) {
      await use(context);
      return;
    }
    const recorder = await instrumentContext(context, otelTracing, otelTestSpan);
    await use(context);
    const { dropped } = await recorder.settle();
    if (dropped > 0) otelTestSpan.setAttribute('otel_html.viewer.spans.dropped', dropped);
  },
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    await use(baseUrlFor(kindOf(testInfo.project.name)));
  },
  reportUrl: async ({ baseURL: _unused }, use, testInfo) => {
    await use((name) => baseUrlFor(kindOf(testInfo.project.name), name));
  },
});
export { expect };

/** Test options for a spec that also runs over HTTP: `test('title', HTTP, async ...)`. Untagged tests run over file:// only. */
export const HTTP = { tag: '@http' } as const;

/**
 * Same as `test` (test spans included), but `baseURL` points at the hostile-content report. It deliberately lacks the
 * recorder `context` override: the in-page binding would take input from hostile content, so no viewer spans here.
 */
export const hostileTest = base.extend({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    await use(baseUrlFor(kindOf(testInfo.project.name), 'hostile'));
  },
});
