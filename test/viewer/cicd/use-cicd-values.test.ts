import { describe, expect, test, vi } from 'vitest';
import { DashboardSchema, type Widget } from '../../../src/dashboards/schema.js';
import '../../../src/viewer/cicd/use-cicd.js';
import { PageShared, valuesSourceFor } from '../../../src/viewer/dashboards/scope.js';
import type { CicdRow } from '../../../src/viewer/data/cicd-query.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';

const blank = {
  spanId: null,
  start: 100,
  end: 200,
  name: null,
  result: 'success',
  pipeline: null,
  runId: null,
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
} as const;
const rows: CicdRow[] = [
  { ...blank, kind: 'run', traceId: 'a', branch: 'main', trigger: 'push' },
  { ...blank, kind: 'run', traceId: 'b', branch: 'feat', trigger: 'push', start: 5000 },
  { ...blank, kind: 'job', traceId: 'a', task: 'test', labels: 'big' },
  { ...blank, kind: 'job', traceId: 'a', task: 'build', labels: 'big' },
  { ...blank, kind: 'job', traceId: 'b', task: 'late', labels: 'tiny', start: 5000 },
];
const widgets = DashboardSchema.parse({
  id: 'd',
  title: 'd',
  widgets: [{ type: 'cicd', view: 'stat', stat: 'success-rate', x: 0, y: 0, w: 2, h: 2 }],
}).widgets as Widget[];

describe('the CI values sources', () => {
  test('list the distinct values of the runs and jobs starting in the window, sorted', async () => {
    const cicdRows = vi.fn(() => Promise.resolve(rows));
    const ctx = { widgets, dataSource: { cicdRows } as unknown as DataSource, shared: new PageShared() };
    const win = { start: 0, end: 1000 };
    const get = async (k: string) => (await valuesSourceFor(k, ctx)?.(win))?.values;
    expect(await get('vcs.ref.head.name')).toEqual(['main']);
    expect(await get('cicd.pipeline.trigger')).toEqual(['push']);
    expect(await get('cicd.pipeline.task.name')).toEqual(['build', 'test']);
    expect(await get('cicd.worker.labels')).toEqual(['big']);
    expect(cicdRows).toHaveBeenCalledTimes(1);
  });

  test('have no source for a page without a cicd widget or a key it does not know', () => {
    const ctx = { widgets: [], dataSource: {} as DataSource, shared: new PageShared() };
    expect(valuesSourceFor('vcs.ref.head.name', ctx)).toBeNull();
    expect(valuesSourceFor('service.name', { ...ctx, widgets })).toBeNull();
  });
});
