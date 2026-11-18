import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { ChartProps } from '../../src/viewer/components/chart.js';
import { currentD, dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const charts: ChartProps[] = [];
(globalThis as { __chartProps?: unknown[] }).__chartProps = charts;
const bucketAt = vi.hoisted(() => ({ t: 2_000_000_000, end: 3_000_000_000.6 }));
// buckets with fractional bounds, as a pointer-drawn window can leave them
vi.mock('../../src/viewer/cicd/derive.js', async (orig) => ({
  ...(await orig<typeof import('../../src/viewer/cicd/derive.js')>()),
  trendBuckets: () => ({
    step: 1_000_000_000.6,
    buckets: [bucketAt.t].map((t) => ({
      t,
      end: bucketAt.end,
      p50: 1,
      p95: 1,
      passed: 1,
      failed: 0,
      cancelled: 0,
      runs: [],
    })),
  }),
}));

const DASH = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  widgets: [{ type: 'cicd', view: 'runs-trend', x: 0, y: 0, w: 12, h: 8 }],
});
const row = {
  kind: 'run' as const,
  traceId: 'a'.repeat(32),
  spanId: null,
  start: 1_000_000_000,
  end: 2_000_000_000,
  name: null,
  result: 'success',
  pipeline: null,
  runId: '1',
  attempt: 1,
  trigger: 'push',
  branch: 'main',
  revision: null,
  title: 't',
  task: null,
  taskId: null,
  labels: null,
  queuedNs: null,
  needs: null,
  condition: null,
  failedStep: null,
  tasksReplayed: null,
  tasksRun: null,
};

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  window.location.hash = '';
  charts.length = 0;
  bucketAt.t = 2_000_000_000;
  bucketAt.end = 3_000_000_000.6;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const on = (c: ChartProps | undefined, name: string): ((p: unknown) => void) | undefined =>
  Object.entries(c?.onEvents ?? {}).find(([k]) => k === name)?.[1];

describe('the page window from a cicd widget', () => {
  test('the real selectWindow writes whole, ordered nanoseconds into sel.t', async () => {
    const ds = { ...dataSourceOf(manifestWith([DASH])), cicdRows: () => Promise.resolve([row]) };
    renderShell('#/dashboards/ci', ds);
    await waitFor(() => expect(charts.length).toBeGreaterThan(0));
    const chart = charts[charts.length - 1];
    await act(async () =>
      on(chart, 'contextmenu')?.({ dataIndex: 0, event: { event: { clientX: 1, clientY: 1 } } }),
    );
    await act(async () => (await screen.findByText('Zoom the slider to this bucket')).click());
    const t = currentD()?.sel?.t;
    expect(t).toBeDefined();
    expect(t).toMatch(/^[^.]*$/);
    const [a, b] = String(t).split('~').map(Number);
    expect(Number.isInteger(a) && Number.isInteger(b) && (a ?? 0) <= (b ?? 0)).toBe(true);
  });

  test('a bucket that overhangs the span selects only the span', async () => {
    // the page's span starts at 0
    bucketAt.t = -1_000_000_000;
    bucketAt.end = 1e18;
    const ds = { ...dataSourceOf(manifestWith([DASH])), cicdRows: () => Promise.resolve([row]) };
    renderShell('#/dashboards/ci', ds);
    await waitFor(() => expect(charts.length).toBeGreaterThan(0));
    const chart = charts[charts.length - 1];
    await act(async () =>
      on(chart, 'contextmenu')?.({ dataIndex: 0, event: { event: { clientX: 1, clientY: 1 } } }),
    );
    await act(async () => (await screen.findByText('Zoom the slider to this bucket')).click());
    const [a, b] = String(currentD()?.sel?.t).split('~').map(Number);
    expect(a).toBe(0);
    expect(b).toBeLessThan(bucketAt.end);
  });
});
