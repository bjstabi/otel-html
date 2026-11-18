import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardSchema, type Widget } from '../../../src/dashboards/schema.js';
import { CicdProvider, useCicd, useCicdPage } from '../../../src/viewer/cicd/use-cicd.js';
import { PageShared } from '../../../src/viewer/dashboards/scope.js';
import type { CicdRow } from '../../../src/viewer/data/cicd-query.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEC = 1_000_000_000;
const DAY = 86_400 * SEC;
const JOB = 'cicd.pipeline.task.name';
const blank: CicdRow = {
  kind: 'run',
  traceId: '',
  spanId: null,
  start: 0,
  end: 0,
  name: null,
  result: 'success',
  pipeline: null,
  runId: null,
  attempt: 1,
  trigger: 'push',
  branch: 'main',
  revision: 'abc',
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
const rows: CicdRow[] = [
  { ...blank, traceId: t('a'), runId: '1', start: 8 * DAY, end: 8 * DAY + SEC },
  { ...blank, traceId: t('b'), runId: '2', start: 9 * DAY, end: 9 * DAY + SEC },
  {
    ...blank,
    kind: 'job',
    traceId: t('a'),
    task: 'build',
    trigger: null,
    branch: null,
    start: 8 * DAY,
    end: 8 * DAY + SEC,
  },
  {
    ...blank,
    kind: 'job',
    traceId: t('b'),
    task: 'test',
    trigger: null,
    branch: null,
    start: 9 * DAY,
    end: 9 * DAY + SEC,
  },
];
const widgets = DashboardSchema.parse({
  id: 'd',
  title: 'd',
  widgets: [{ type: 'cicd', view: 'jobs', x: 0, y: 0, w: 4, h: 4 }],
}).widgets as Widget[];

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const extent = { start: 0, end: 14 * DAY };

const out: { count: number | null; runs: number; statuses: string[] } = {
  count: null,
  runs: -1,
  statuses: [],
};
const win = { start: 7 * DAY, end: 14 * DAY };
const jobVar = [{ key: JOB, value: 'build', kind: 'string' as const }];

function PageProbe(): null {
  out.count = useCicdPage(widgets, jobVar, null).count;
  return null;
}
function WidgetProbe(): null {
  out.runs = useCicd(widgets[0] as Widget, { window: win, vars: jobVar }).runs.length;
  return null;
}
function StatusProbe(): null {
  out.statuses.push(useCicd(widgets[0] as Widget, { window: win, vars: [] }).status);
  return null;
}

describe('useCicdPage', () => {
  it('counts every run even when the first cicd widget narrows to a bound job', async () => {
    const dataSource = { cicdRows: () => Promise.resolve(rows) } as unknown as DataSource;
    await act(async () => {
      root.render(
        <CicdProvider dataSource={dataSource} extent={extent}>
          <PageProbe />
        </CicdProvider>,
      );
    });
    expect(out.count).toBe(2);
  });

  it('while the widget itself narrows to the job', async () => {
    const dataSource = { cicdRows: () => Promise.resolve(rows) } as unknown as DataSource;
    await act(async () => {
      root.render(
        <CicdProvider dataSource={dataSource} extent={extent}>
          <WidgetProbe />
        </CicdProvider>,
      );
    });
    expect(out.runs).toBe(1);
  });
});

describe('the cicd store', () => {
  it('asks again after a failed fetch when the widget is mounted again', async () => {
    out.statuses = [];
    const cicdRows = vi
      .fn<() => Promise<CicdRow[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(rows);
    const dataSource = { cicdRows } as unknown as DataSource;
    const shared = new PageShared();
    const tree = (show: boolean) => (
      <CicdProvider dataSource={dataSource} extent={extent} shared={shared}>
        {show && <StatusProbe />}
      </CicdProvider>
    );
    await act(async () => root.render(tree(true)));
    expect(out.statuses.at(-1)).toBe('error');
    await act(async () => root.render(tree(false)));
    await act(async () => root.render(tree(true)));
    expect(cicdRows).toHaveBeenCalledTimes(2);
    expect(out.statuses.at(-1)).toBe('ready');
  });
});
