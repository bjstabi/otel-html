import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ResourceRecord } from '../../src/model/records.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { MetricGrid, type MetricGridOrigin, useHasMetrics } from '../../src/viewer/metrics/metric-grid.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { attr, gauge, metricsRequest, pointsAt } from '../../test-support/otlp-builders.js';
import { otlp } from '../../test-support/writer-deps.js';
import { metricsSource } from './metrics-fixture.js';

// jsdom cannot lay out ECharts; the stand-in keeps the label the card gives the chart (its series count).
vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }) => <div role="img" aria-label={p.ariaLabel} />,
}));

const str = (v: string) => ({ stringValue: v });
const on = (service: string, metrics: ReturnType<typeof gauge>[]) =>
  otlp(metricsRequest(metrics, [attr('service.name', str(service))]) as never);
const at = [0, 1000, 2000];
const g = (name: string, base: number) =>
  gauge(
    name,
    pointsAt(at, (i) => ({ asDouble: base + i })),
  );

const source = metricsSource([
  on('a', [g('app.only_a', 1), g('app.shared', 1)]),
  on('b', [g('app.only_b', 5), g('app.shared', 7)]),
]);

afterEach(cleanup);

async function resourceOf(ds: DataSource, service: string): Promise<ResourceRecord> {
  const found = (await ds.metricCatalog()).resources.find((r) => {
    const v = r.attributes.get('service.name');
    return v?.kind === 'string' && v.value === service;
  });
  if (found === undefined) throw new Error(`no resource ${service}`);
  return found;
}

const noop = (): void => undefined;
const origin = (resources: ResourceRecord[], kind: MetricGridOrigin['kind']): MetricGridOrigin => ({
  kind,
  resources,
  at: null,
  window: { start: 0, end: 10_000_000_000 },
  traceId: null,
});

async function draw(service: readonly string[], kind: MetricGridOrigin['kind']): Promise<void> {
  const ds = source();
  const resources = await Promise.all(service.map((s) => resourceOf(ds, s)));
  render(
    <GoToContext.Provider value={noop as never}>
      <MetricGrid dataSource={ds} origin={origin(resources, kind)} />
    </GoToContext.Provider>,
  );
}

describe('the metric grid over format 4', () => {
  test("a log's resource gets one chart per metric of that resource and none of the other's", async () => {
    await draw(['a'], 'log');
    expect(await screen.findByRole('img', { name: /^app\.only_a: 1 series/ })).toBeTruthy();
    expect(await screen.findByRole('img', { name: /^app\.shared: 1 series/ })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /app\.only_b/ })).toBeNull();
  });

  test('the trace origin with two resources draws one line per resource', async () => {
    await draw(['a', 'b'], 'trace');
    await waitFor(() => expect(screen.getAllByRole('img').length).toBe(3));
    expect(await screen.findByRole('img', { name: /^app\.shared: 2 series/ })).toBeTruthy();
    expect(await screen.findByRole('img', { name: /^app\.only_a: 1 series/ })).toBeTruthy();
    expect(await screen.findByRole('img', { name: /^app\.only_b: 1 series/ })).toBeTruthy();
  });

  test('useHasMetrics is false for a resource without points and true with', async () => {
    const ds = source();
    const withPoints = await resourceOf(ds, 'a');
    const without: ResourceRecord = {
      attributes: new Map([['service.name', { kind: 'string', value: 'c' }]]),
      droppedAttributesCount: 0,
      schemaUrl: '',
    };
    // The hook keys its lookup on the array's identity, so the arrays are fixed across renders.
    const [hasList, noneList] = [[withPoints], [without]];
    const yes = renderHook(() => useHasMetrics(ds, hasList));
    const no = renderHook(() => useHasMetrics(ds, noneList));
    await waitFor(() => expect(yes.result.current).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(no.result.current).toBe(false);
  });
});
