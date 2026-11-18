import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DashboardSchema } from '../../src/dashboards/schema.js';
import type { CicdRow } from '../../src/viewer/data/cicd-query.js';
import { dataSourceOf, manifestWith, renderShell } from './dashboard-shell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS = ['vcs.ref.head.name', 'cicd.pipeline.trigger', 'cicd.pipeline.task.name', 'cicd.worker.labels'];
const CI = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: KEYS,
  widgets: [{ type: 'cicd', view: 'stat', stat: 'success-rate', x: 0, y: 0, w: 4, h: 6 }],
});
const PLAIN = DashboardSchema.parse({
  id: 'plain',
  title: 'Plain',
  variables: KEYS,
  widgets: [{ type: 'timeline', x: 0, y: 0, w: 12, h: 6 }],
});

const blank: CicdRow = {
  kind: 'run',
  traceId: '',
  spanId: null,
  start: 1_000_000_000,
  end: 2_000_000_000,
  name: null,
  result: 'success',
  pipeline: null,
  runId: '1',
  attempt: 1,
  trigger: null,
  branch: null,
  revision: null,
  title: null,
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
const t = (c: string): string => c.repeat(32);
const ROWS: CicdRow[] = [
  { ...blank, traceId: t('a'), branch: 'main', trigger: 'push' },
  { ...blank, traceId: t('b'), branch: 'feat/x', trigger: 'pull_request' },
  { ...blank, traceId: t('c'), branch: 'main', trigger: 'push' },
  { ...blank, kind: 'job', traceId: t('a'), task: 'test', labels: 'big' },
  { ...blank, kind: 'job', traceId: t('b'), task: 'build', labels: 'big' },
  { ...blank, kind: 'job', traceId: t('c'), task: 'test', labels: 'small' },
];

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the variables of a page with a cicd widget', () => {
  test('are listed from the cicd rows: one cicdRows call, no resourceValues', async () => {
    const cicdRows = vi.fn(() => Promise.resolve(ROWS));
    const resourceValues = vi.fn(() =>
      Promise.resolve({ values: [], kind: 'string' as const, capped: false }),
    );
    const ds = { ...dataSourceOf(manifestWith([CI])), cicdRows, resourceValues };
    renderShell('#/dashboards/ci', ds);
    await waitFor(() => expect(cicdRows).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    expect(resourceValues).not.toHaveBeenCalled();
    expect(cicdRows).toHaveBeenCalledTimes(1);
  });

  test('keep a page without a cicd widget on resourceValues and never call cicdRows', async () => {
    const cicdRows = vi.fn(() => Promise.resolve(ROWS));
    const resourceValues = vi.fn(() =>
      Promise.resolve({ values: ['x'], kind: 'string' as const, capped: false }),
    );
    const ds = { ...dataSourceOf(manifestWith([PLAIN])), cicdRows, resourceValues };
    renderShell('#/dashboards/plain', ds);
    await waitFor(() => expect(resourceValues).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));
    expect(cicdRows).not.toHaveBeenCalled();
  });
});
