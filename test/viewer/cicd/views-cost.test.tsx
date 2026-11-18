import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, Widget } from '../../../src/dashboards/schema.js';
import { DashboardSchema } from '../../../src/dashboards/schema.js';
import type { AnyValue } from '../../../src/model/anyvalue.js';
import { RunActionsProvider } from '../../../src/viewer/cicd/run-actions.js';
import { CicdProvider } from '../../../src/viewer/cicd/use-cicd.js';
import { CicdWidget } from '../../../src/viewer/cicd/widget.js';
import type { ChartProps } from '../../../src/viewer/components/chart.js';
import type { CicdRow } from '../../../src/viewer/data/cicd-query.js';
import type { DataSource } from '../../../src/viewer/data/data-source.js';
import type { SpanRow } from '../../../src/viewer/data/results.js';
import { buildTraceTree } from '../../../src/viewer/data/trace-tree.js';
import { type DashboardPageState, EMPTY_DASHBOARD_STATE } from '../../../src/viewer/state/dashboard-state.js';
import { ThemeProvider } from '../../../src/viewer/theme/theme-provider.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const charts: ChartProps[] = [];
vi.mock('../../../src/viewer/components/chart.js', () => ({
  Chart: (props: ChartProps): null => {
    charts.push(props);
    return null;
  },
}));

const SEC = 1_000_000_000;
const DAY = 86_400 * SEC;
const TRACE = (i: number): string => i.toString(16).padStart(32, 'a');

const dashboard = DashboardSchema.parse({
  id: 'ci',
  title: 'CI',
  variables: ['cicd.pipeline.task.name', 'cicd.pipeline.trigger', 'cicd.worker.labels'],
  widgets: [{ type: 'cicd', view: 'stat', stat: 'success-rate', x: 0, y: 0, w: 2, h: 6 }],
}) as Dashboard;

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

function run(i: number, start: number, over: Partial<CicdRow> = {}): CicdRow {
  return {
    ...blank,
    traceId: TRACE(i),
    runId: `r${i}`,
    start,
    end: start + 120 * SEC,
    title: `commit ${i}`,
    ...over,
  };
}
function job(i: number, start: number, name: string, over: Partial<CicdRow> = {}): CicdRow {
  return {
    ...blank,
    kind: 'job',
    traceId: TRACE(i),
    spanId: `${i}-${name}`.padEnd(16, '0').slice(0, 16),
    start: start + 5 * SEC,
    end: start + 65 * SEC,
    task: name,
    trigger: null,
    branch: null,
    revision: null,
    ...over,
  };
}

const widget = (view: string, extra: Record<string, unknown> = {}): Widget =>
  DashboardSchema.parse({
    id: 'ci',
    title: 'CI',
    widgets: [{ id: 'w1', type: 'cicd', view, x: 0, y: 0, w: 4, h: 6, ...extra }],
  }).widgets[0] as Widget;

let root: Root;
let host: HTMLElement;
let state: DashboardPageState;
let subtitles: (string | null)[];
let traceCalls: string[];
let details: Map<string, unknown>;

/** `n` runs in the last 7 days, each with the jobs `names`; run 2 fails `test`. */
function runs(
  n: number,
  names: string[],
  over: (i: number) => Partial<CicdRow> = () => ({}),
  base = 0,
): CicdRow[] {
  return Array.from({ length: n }, (_, k) => k + 1).flatMap((i) => {
    const start = 7 * DAY + Math.round(((i - 0.5) * 7 * DAY) / n);
    const failed = i === 2;
    return [
      run(i + base, start, { result: failed ? 'failure' : 'success', ...over(i) }),
      ...names.map((name) =>
        job(i + base, start, name, {
          result: failed && name === 'test' ? 'failure' : 'success',
          failedStep: failed && name === 'test' ? 'cargo test' : null,
        }),
      ),
    ];
  });
}

async function show(w: Widget, rows: CicdRow[]): Promise<void> {
  // A fresh data source per call keeps the per-trace cache of the tests view apart between tests.
  const dataSource = {
    cicdRows: () => Promise.resolve(rows),
    manifest: { epochUnixNano: '1700000000000000000' },
    getTrace: (id: string) => {
      traceCalls.push(id);
      const d = details.get(id);
      return d === undefined ? Promise.reject(new Error('no trace')) : Promise.resolve(d);
    },
  } as unknown as DataSource;
  subtitles = [];
  const actions = { selectWindow: () => {}, setSubtitle: (t: string | null) => subtitles.push(t) };
  await act(async () => {
    root.render(
      <ThemeProvider>
        <CicdProvider dataSource={dataSource} extent={{ start: 0, end: 14 * DAY }}>
          <RunActionsProvider
            dashboard={dashboard}
            state={state}
            change={(fn) => {
              state = fn(state);
            }}
            dataSource={dataSource}
          >
            <CicdWidget
              widget={w}
              scope={{ window: { start: 7 * DAY, end: 14 * DAY }, vars: [] } as never}
              dashboard={{} as never}
              height={400}
              dataSource={dataSource}
              actions={actions as never}
              variables={[]}
              state={state}
              controls={null}
            />
          </RunActionsProvider>
        </CicdProvider>
      </ThemeProvider>,
    );
  });
}

const menuLabels = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent ?? '');
const lastChart = (): ChartProps => {
  const c = charts[charts.length - 1];
  if (c === undefined) throw new Error('no chart drawn');
  return c;
};
const q = <T extends Element>(sel: string): T => {
  const e = host.querySelector<T>(sel);
  if (e === null) throw new Error(`nothing matches ${sel}`);
  return e;
};

beforeEach(() => {
  traceCalls = [];
  details = new Map();
  state = EMPTY_DASHBOARD_STATE;
  charts.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const sv = (value: string): AnyValue => ({ kind: 'string', value });
function testSpan(
  id: string,
  parent: string | null,
  name: string,
  attrs: Record<string, string>,
  ms = 0,
): SpanRow {
  return {
    span: {
      spanId: id,
      parentSpanId: parent,
      name,
      attributes: new Map(Object.entries(attrs).map(([k, v]) => [k, sv(v)])),
      start: 0,
      end: ms * 1e6,
      resource: 0,
    } as never,
    service: '',
    resource: '',
    durationNs: ms * 1e6,
  };
}
/** A trace with the job `check`, its task `test:unit:main` and vitest tests in two files, one skipped. */
function traceWithTests(): unknown {
  const spans = [
    testSpan('j', null, 'check', { 'cicd.pipeline.task.name': 'check' }),
    testSpan('t', 'j', 'test:unit:main', { 'mise.task.name': 'test:unit:main' }),
    testSpan('a1', 't', 'a one', { 'vitest.test.mode': 'run', 'test.suite.name': 'test/a.test.ts' }, 30),
    testSpan('a2', 't', 'a two', { 'vitest.test.mode': 'skip', 'test.suite.name': 'test/a.test.ts' }, 0),
    testSpan('b1', 't', 'b one', { 'vitest.test.mode': 'run', 'test.suite.name': 'test/b.test.ts' }, 90),
  ];
  return { spans, tree: buildTraceTree(spans), resources: () => ({ attributes: new Map() }) };
}

describe('empty', () => {
  it.each(['queue', 'minutes', 'tests'])('%s says so with no run, with no NaN', async (v) => {
    await show(widget(v), []);
    expect(host.textContent).toContain('No run in this range.');
    expect(host.textContent).not.toMatch(/NaN|–%/);
  });
});

describe('queue', () => {
  const rows = (): CicdRow[] =>
    runs(12, ['build'], () => ({}), 0).map((r, k) =>
      r.kind === 'job'
        ? { ...r, queuedNs: (k + 1) * SEC, labels: k < 16 ? 'ubuntu-latest' : k < 20 ? 'windows' : null }
        : r,
    );

  it('shows one row per label with at least 5 jobs, "(no label)" for older runs', async () => {
    await show(widget('queue'), rows());
    const labels = [...host.querySelectorAll('[data-queue-label]')].map((e) =>
      e.getAttribute('data-queue-label'),
    );
    expect(labels).toContain('ubuntu-latest');
    expect(labels).not.toContain('windows');
    await show(
      widget('queue'),
      runs(6, ['build'], () => ({})).map((r) => (r.kind === 'job' ? { ...r, queuedNs: SEC } : r)),
    );
    expect(host.querySelector('[data-queue-label="(no label)"]')).not.toBeNull();
    expect(host.textContent).toContain('n 6');
  });

  it('says so when no label has 5 jobs', async () => {
    await show(
      widget('queue'),
      runs(2, ['build'], () => ({})),
    );
    expect(host.textContent).toContain('No runner label has 5 jobs in this range.');
  });

  it('opens the runner menu from a label', async () => {
    await show(
      widget('queue'),
      runs(6, ['build'], () => ({})).map((r) =>
        r.kind === 'job' ? { ...r, queuedNs: SEC, labels: 'ubuntu' } : r,
      ),
    );
    await act(async () => q<HTMLElement>('[data-queue-label="ubuntu"] button').click());
    expect(menuLabels()).toEqual(['Filter the page by runnerubuntu']);
  });

  it('has no menu for "(no label)"', async () => {
    await show(
      widget('queue'),
      runs(6, ['build'], () => ({})).map((r) => (r.kind === 'job' ? { ...r, queuedNs: SEC } : r)),
    );
    await act(async () => q<HTMLElement>('[data-queue-label="(no label)"] button').click());
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });
});

describe('minutes', () => {
  const names = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7', 'j8', 'j9'];
  const seriesNames = (): string[] =>
    (lastChart().option as unknown as { series: { name: string }[] }).series.map((s) => s.name);

  it('stacks by trigger first, and by job as the top 7 plus Other', async () => {
    await show(widget('minutes'), runs(12, names));
    expect(seriesNames()).toEqual(['push']);
    await act(async () => q<HTMLElement>('[data-by="job"]').click());
    expect(seriesNames()).toHaveLength(8);
    expect(seriesNames().at(-1)).toBe('Other');
    expect([...host.querySelectorAll('[data-legend]')]).toHaveLength(8);
  });

  it('opens the trigger menu from a legend item by trigger, the job menu by job, none for Other', async () => {
    await show(widget('minutes'), runs(12, names));
    await act(async () => q<HTMLElement>('[data-legend="push"]').click());
    expect(menuLabels()).toEqual(['Filter the page by triggerpush']);
    await act(async () => q<HTMLElement>('[data-by="job"]').click());
    await act(async () => q<HTMLElement>('[data-legend="j1"]').click());
    expect(menuLabels()).toEqual(['Filter the page by job']);
    expect(q<HTMLElement>('[data-legend="Other"]').tagName).not.toBe('BUTTON');
  });
});

describe('tests', () => {
  const rows = (): CicdRow[] => runs(3, ['check']);
  const noTests = { spans: [], tree: buildTraceTree([]), resources: () => ({ attributes: new Map() }) };

  it('shows pills per suite, files by test time, expands a file and discloses the skipped', async () => {
    details.set(TRACE(3), traceWithTests());
    await show(widget('tests'), rows());
    expect(host.querySelectorAll('[data-suite]')).toHaveLength(1);
    expect(host.querySelector('[data-suite]')?.textContent).toContain('check › test:unit:main');
    const files = [...host.querySelectorAll('[data-test-file]')].map((e) => e.getAttribute('data-test-file'));
    expect(files).toEqual(['test/b.test.ts', 'test/a.test.ts']);
    expect(host.querySelector('[data-test-name]')).toBeNull();
    await act(async () => q<HTMLElement>('[data-test-file="test/a.test.ts"] button').click());
    expect([...host.querySelectorAll('[data-test-name]')].map((e) => e.textContent)).toContain('a one');
    expect(host.textContent).toContain('1 skipped test in 1 file');
    await act(async () => q<HTMLElement>('[data-skipped] summary').click());
    expect(q('[data-skipped]').textContent).toContain('a two');
  });

  it('asks the latest run first, falls back to older runs and fetches each trace once', async () => {
    details.set(TRACE(1), traceWithTests());
    details.set(TRACE(2), noTests);
    details.set(TRACE(3), noTests);
    await show(widget('tests'), rows());
    expect(traceCalls).toEqual([TRACE(3), TRACE(2), TRACE(1)]);
    expect(host.querySelectorAll('[data-suite]')).toHaveLength(1);
    await act(async () => q<HTMLElement>('[data-test-file] button').click());
    expect(traceCalls).toEqual([TRACE(3), TRACE(2), TRACE(1)]);
  });

  it('says so when no run has test spans', async () => {
    for (const i of [1, 2, 3]) details.set(TRACE(i), noTests);
    await show(widget('tests'), rows());
    expect(host.textContent).toContain('No run in this range has test spans.');
  });
});
