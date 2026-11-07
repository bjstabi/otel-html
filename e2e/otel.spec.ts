import { existsSync } from 'node:fs';
import type { Span } from '@opentelemetry/api';
import type { BrowserContext } from '@playwright/test';
import { inMemoryTracing } from '../test-support/otel/sdk.js';
import { instrumentContext } from './otel.js';
import { RECORDER_PATH } from './otel-page/span-json.js';
import { expect, guardContext, HTTP, test } from './test.js';

/**
 * The in-page recorder end to end: a real browser context, the real viewer, an in-memory worker-side tracing. It
 * never starts a second global SDK (the worker already has one when an endpoint is set).
 */
test.beforeAll(() => {
  if (!existsSync(new URL(`../${RECORDER_PATH}`, import.meta.url))) {
    throw new Error(
      `${RECORDER_PATH} is missing: run \`mise run e2e:otel-recorder\` (CI: \`mise run --skip-deps e2e:otel-recorder\`)`,
    );
  }
});

async function setup(context: BrowserContext, limit?: number) {
  const { tracing, exporter } = inMemoryTracing();
  const parent: Span = tracing.tracer.startSpan('parent');
  const recorder = await instrumentContext(context, tracing, parent, limit);
  return { exporter, parent, recorder, assertOwnOrigin: guardContext(context) };
}

const finished = (exporter: ReturnType<typeof inMemoryTracing>['exporter'], name: string) =>
  exporter.getFinishedSpans().filter((s) => s.name === name);

test('browser spans join the test span', HTTP, async ({ browser, reportUrl }) => {
  const context = await browser.newContext();
  const { exporter, parent, recorder, assertOwnOrigin } = await setup(context);
  const page = await context.newPage();
  await page.goto(`${reportUrl('small')}/index.html#/traces`);
  await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
  await recorder.settle();

  await expect.poll(() => finished(exporter, 'viewer.load')).toHaveLength(1);
  const [load] = finished(exporter, 'viewer.load');
  expect(load?.spanContext().traceId).toBe(parent.spanContext().traceId);
  expect(load?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  expect(load?.resource.attributes['service.name']).toBe('otel-html-viewer');
  const [engine] = finished(exporter, 'viewer.engine.start');
  expect(engine?.parentSpanContext?.spanId).toBe(load?.spanContext().spanId);
  await expect.poll(() => finished(exporter, 'viewer.query').length).toBeGreaterThan(0);
  const [first] = finished(exporter, 'viewer.query');
  expect(first?.attributes['otel_html.query.kind']).toBeDefined();
  if (engine !== undefined)
    test.info().annotations.push({
      type: 'engine start ms',
      description: (
        (engine.endTime[0] - engine.startTime[0]) * 1e3 +
        (engine.endTime[1] - engine.startTime[1]) / 1e6
      ).toFixed(0),
    });
  await context.close();
  assertOwnOrigin();
});

test('a reload keeps recording', HTTP, async ({ browser, reportUrl }) => {
  const context = await browser.newContext();
  const { exporter, recorder, assertOwnOrigin } = await setup(context);
  const page = await context.newPage();
  const grid = page.getByRole('grid', { name: 'Results' });
  await page.goto(`${reportUrl('small')}/index.html#/traces`);
  await expect(grid).toBeVisible();
  await page.reload();
  await expect(grid).toBeVisible();
  await recorder.settle();

  await expect.poll(() => finished(exporter, 'viewer.load')).toHaveLength(2);
  await context.close();
  assertOwnOrigin();
});

test('the cap drops and counts', HTTP, async ({ browser, reportUrl }) => {
  const context = await browser.newContext();
  const { exporter, recorder, assertOwnOrigin } = await setup(context, 1);
  const page = await context.newPage();
  await page.goto(`${reportUrl('small')}/index.html#/traces`);
  await expect(page.getByRole('grid', { name: 'Results' })).toBeVisible();
  const { dropped } = await recorder.settle();

  await expect.poll(() => exporter.getFinishedSpans().length).toBe(1);
  expect(dropped).toBeGreaterThanOrEqual(1);
  await context.close();
  assertOwnOrigin();
});
