import { describe, expect, test, vi } from 'vitest';
import { DashboardSchema, type Widget } from '../../../src/dashboards/schema.js';
import '../../../src/viewer/cicd/use-cicd.js';
import { PageShared, valuesSourceFor, variableValues } from '../../../src/viewer/dashboards/scope.js';
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

  test('never fetch the whole report for a selection outside the window (R43)', async () => {
    const cicdRows = vi.fn((_q: { window: unknown }) => Promise.resolve(rows));
    const ctx = { widgets, dataSource: { cicdRows } as unknown as DataSource, shared: new PageShared() };
    const read = async (key: string, window: { start: number; end: number } | null) => {
      const source = valuesSourceFor(key, ctx);
      if (source === null) throw new Error('no source');
      return source(window);
    };
    const win = { start: 0, end: 1000 };
    const got = await variableValues('vcs.ref.head.name', win, read, 'release/9');
    expect(got.values).toEqual(['main']);
    expect(got.kind).toBe('string');
    expect(cicdRows).toHaveBeenCalledTimes(1);
    expect(cicdRows.mock.calls.every(([q]) => q.window !== null)).toBe(true);
  });

  test('a window and the period before it with no runs keep the variable (emptyInWindow), with no whole-report fetch', async () => {
    const cicdRows = vi.fn((q: { window: { start: number; end: number } | null }) =>
      Promise.resolve(
        rows.filter((r) => q.window === null || (r.start >= q.window.start && r.start <= q.window.end)),
      ),
    );
    const ctx = { widgets, dataSource: { cicdRows } as unknown as DataSource, shared: new PageShared() };
    const read = async (key: string, window: { start: number; end: number } | null) => {
      const source = valuesSourceFor(key, ctx);
      if (source === null) throw new Error('no source');
      return source(window);
    };
    const got = await variableValues('vcs.ref.head.name', { start: 9000, end: 9100 }, read, 'main');
    expect(got.values).toEqual([]);
    expect(got.kind).toBe('string');
    expect(got.emptyInWindow).toBe(true);
    expect(cicdRows).toHaveBeenCalledTimes(1);
  });

  test('tell a window with no runs from a report without the key, without a second fetch', async () => {
    const cicdRows = vi.fn((q: { window: { start: number; end: number } | null }) =>
      Promise.resolve(
        rows.filter((r) => q.window === null || (r.start >= q.window.start && r.start <= q.window.end)),
      ),
    );
    const ctx = { widgets, dataSource: { cicdRows } as unknown as DataSource, shared: new PageShared() };
    const read = async (key: string, window: { start: number; end: number } | null) => {
      const source = valuesSourceFor(key, ctx);
      if (source === null) throw new Error('no source');
      return source(window);
    };
    // the fetch reaches one period back (the window's own length), so runs before the window are known
    const got = await variableValues('vcs.ref.head.name', { start: 5100, end: 5200 }, read, null);
    expect(got.values).toEqual([]);
    expect(got.emptyInWindow).toBe(true);
    expect(cicdRows).toHaveBeenCalledTimes(1);
  });
});
