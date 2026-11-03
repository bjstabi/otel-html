import type { Span } from '@opentelemetry/api';
import { test as playwrightTest, type TestInfo } from '@playwright/test';
import { startTestSdk, type TestTracing } from '../test-support/otel/sdk.js';
import { baseUrlFor, type ReportName, type UrlKind } from './fixture.js';
import { endTestSpan, startTestSpan, type TestSpanInfo } from './otel.js';

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
  { otelTestSpan: Span | undefined },
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
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    await use(baseUrlFor(kindOf(testInfo.project.name)));
  },
  reportUrl: async ({ baseURL: _unused }, use, testInfo) => {
    await use((name) => baseUrlFor(kindOf(testInfo.project.name), name));
  },
});
export { expect } from '@playwright/test';

/** Test options for a spec that also runs over HTTP: `test('title', HTTP, async ...)`. Untagged tests run over file:// only. */
export const HTTP = { tag: '@http' } as const;

/** Same as `test`, but `baseURL` points at the hostile-content report. */
export const hostileTest = base.extend({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    await use(baseUrlFor(kindOf(testInfo.project.name), 'hostile'));
  },
});
