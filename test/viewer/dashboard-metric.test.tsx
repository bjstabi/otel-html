import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/viewer/components/chart.js', () => ({
  Chart: (p: { ariaLabel: string }): React.JSX.Element => <div role="img" aria-label={p.ariaLabel} />,
}));

import { DashboardSchema, type Widget } from '../../src/dashboards/schema.js';
import type { TraceId } from '../../src/model/ids.js';
import type { ResourceRecord } from '../../src/model/records.js';
import type { WidgetActions } from '../../src/viewer/dashboards/dashboard-page.js';
import { RunSessionProvider } from '../../src/viewer/dashboards/run-session.js';
import type { VariableBinding, WidgetScope } from '../../src/viewer/dashboards/scope.js';
import { MetricWidget } from '../../src/viewer/dashboards/widgets/metric.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type {
  MetricQueryRequest,
  MetricRunQueryRequest,
  RunQueryResult,
} from '../../src/viewer/data/metric-results.js';
import { GoToContext } from '../../src/viewer/shell/go-to.js';
import { EMPTY_DASHBOARD_STATE } from '../../src/viewer/state/dashboard-state.js';
import { attr, gauge, histogram, metricsRequest, pointsAt, T0 } from '../../test-support/otlp-builders.js';
import { otlp } from '../../test-support/writer-deps.js';
import { metricsSource } from './metrics-fixture.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const str = (v: string) => ({ stringValue: v });
const MIN = 60_000;
const RUN_MINUTES = [0, 90, 110] as const;
const JOBS = ['lint', 'unit'] as const;
const RUN_BY = 'resource.attributes["cicd.pipeline.run.id"]';
const FAILED_WHEN = 'attributes["cicd.pipeline.task.run.result"] == "failure"';
const FAILED = { job: 'unit', run: 2 } as const;

/** One histogram point of `seconds` under its own resource per job per run, the shape `otel-html ci` writes. */
function runRequests() {
  return RUN_MINUTES.flatMap((minutes, run) =>
    JOBS.map((job, jobIndex) => {
      const seconds = 40 + 25 * jobIndex + 7 * run;
      const end = BigInt(T0) + BigInt(minutes * MIN) * 1_000_000n;
      const result = job === FAILED.job && run === FAILED.run ? 'failure' : 'success';
      return otlp(
        metricsRequest(
          [
            histogram(
              'ci.job.duration',
              [
                {
                  startTimeUnixNano: String(end - BigInt(seconds) * 1_000_000_000n),
                  timeUnixNano: String(end),
                  count: '1',
                  sum: seconds,
                  min: seconds,
                  max: seconds,
                  bucketCounts: ['1'],
                  explicitBounds: [],
                  attributes: [
                    attr('cicd.pipeline.task.name', str(job)),
                    attr('cicd.pipeline.task.run.result', str(result)),
                  ],
                },
              ],
              { temporality: 'delta', unit: 's' },
            ),
          ],
          [
            attr('service.name', str('ci')),
            attr('cicd.pipeline.run.id', str(`run-${run + 1}`)),
            attr('vcs.ref.head.revision', str(`abcdef${run}000000`)),
          ],
        ) as never,
      );
    }),
  );
}

const depth = (service: string) =>
  otlp(
    metricsRequest(
      [
        gauge(
          'queue.depth',
          pointsAt([0, 1000, 2000], (i) => ({ asDouble: 1 + i })),
        ),
      ],
      [attr('service.name', str(service))],
    ) as never,
  );

const source = metricsSource([...runRequests(), depth('web'), depth('db')]);

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DASHBOARD = DashboardSchema.parse({
  id: 'd',
  title: 'D',
  variables: ['cicd.pipeline.run.id'],
  widgets: [
    {
      type: 'metric',
      title: 'Job duration',
      x: 0,
      y: 0,
      w: 12,
      h: 20,
      runBy: RUN_BY,
      failedWhen: FAILED_WHEN,
      queries: [
        { id: 'a', metric: 'ci.job.duration', show: 'avg', by: ['attributes["cicd.pipeline.task.name"]'] },
      ],
    },
    {
      type: 'metric',
      title: 'Depth',
      x: 0,
      y: 20,
      w: 12,
      h: 20,
      queries: [{ id: 'q', metric: 'queue.depth', show: 'avg', by: ['resource.attributes["service.name"]'] }],
    },
  ],
});
const [RUN_WIDGET, QUEUE_WIDGET] = DASHBOARD.widgets;
if (RUN_WIDGET === undefined || QUEUE_WIDGET === undefined) throw new Error('widgets');

const noop = (): void => undefined;
const ACTIONS: WidgetActions = {
  selectWindow: noop,
  selectTrace: noop,
  openIn: noop,
  setLogView: noop,
  setSubtitle: noop,
  setVariable: noop,
  setControls: noop,
};
const WINDOW = { start: 0, end: 3 * 3_600_000_000_000 };
const scopeOf = (highlightTrace: TraceId | null = null): WidgetScope => ({
  window: WINDOW,
  narrowed: false,
  band: null,
  traceFilter: null,
  highlightTrace,
  condition: null,
  outside: false,
});

interface Recorded {
  runs: MetricRunQueryRequest[];
  queries: MetricQueryRequest[];
  results: RunQueryResult[];
}

/** The real source, recording what the widget asks and what it is told; a selected trace has the `web` resource. */
async function recording(base: DataSource): Promise<{ ds: DataSource; rec: Recorded }> {
  const rec: Recorded = { runs: [], queries: [], results: [] };
  const web = (await base.metricCatalog()).resources.find((r) => {
    const v = r.attributes.get('service.name');
    return v?.kind === 'string' && v.value === 'web';
  });
  if (web === undefined) throw new Error('no web resource');
  const ds: DataSource = {
    ...base,
    metricRunQuery: async (req, signal) => {
      rec.runs.push(req);
      const r = await base.metricRunQuery(req, signal);
      rec.results.push(r);
      return r;
    },
    metricQuery: (req, signal) => {
      rec.queries.push(req);
      return base.metricQuery(req, signal);
    },
    getTrace: () => selectedTrace(web),
  };
  return { ds, rec };
}

function selectedTrace(resource: ResourceRecord): Promise<never> {
  return Promise.resolve({ spans: [{ span: { resource: 0 } }], resources: () => resource } as never);
}

async function draw(
  widget: Widget,
  opts: { trace?: TraceId; variables?: readonly VariableBinding[] } = {},
): Promise<Recorded> {
  const { ds, rec } = await recording(source());
  render(
    <GoToContext.Provider value={noop as never}>
      <RunSessionProvider>
        <MetricWidget
          widget={widget}
          scope={scopeOf(opts.trace ?? null)}
          dashboard={{ dashboard: DASHBOARD, source: 'test', isDefault: false }}
          height={400}
          dataSource={ds}
          actions={ACTIONS}
          variables={opts.variables ?? []}
          state={EMPTY_DASHBOARD_STATE as never}
          controls={null}
        />
      </RunSessionProvider>
    </GoToContext.Provider>,
  );
  return rec;
}

describe('the dashboard metric widgets over format 4', () => {
  test('a run chart shows one dot per run per line, and marks the failed one', async () => {
    const rec = await draw(RUN_WIDGET);
    expect(
      await screen.findByRole('img', { name: /^ci\.job\.duration.*: 2 lines over 3 runs/ }),
    ).toBeTruthy();
    const result = rec.results[0];
    if (result === undefined) throw new Error('no result');
    expect(result.runs.map((r) => r.id)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(result.leftOut).toBe(0);
    const unit = result.lines.find((l) => l.label.includes('unit'));
    const lint = result.lines.find((l) => l.label.includes('lint'));
    expect(lint?.points.map((p) => p?.value)).toEqual([40, 47, 54]);
    expect(lint?.points.map((p) => p?.failed)).toEqual([false, false, false]);
    expect(unit?.points.map((p) => p?.value)).toEqual([65, 72, 79]);
    expect(unit?.points.map((p) => p?.failed)).toEqual([false, false, true]);
  });

  test("the variables' condition reaches the run query's where, except one bound on the run key", async () => {
    const variables: VariableBinding[] = [
      { key: 'service.name', value: 'ci', kind: 'string' },
      { key: 'cicd.pipeline.run.id', value: 'run-2', kind: 'string' },
    ];
    const rec = await draw(RUN_WIDGET, { variables });
    await screen.findByRole('img', { name: /lines over/ });
    const where = rec.runs[0]?.query.where ?? '';
    expect(where).toContain('resource.attributes["service.name"] == "ci"');
    expect(where).not.toContain('cicd.pipeline.run.id');
    expect(rec.runs[0]?.runBy).toBe(RUN_BY);
    expect(rec.runs[0]?.failedWhen).toBe(FAILED_WHEN);
  });

  test("a queries widget narrowed to a selected trace's resources charts only those", async () => {
    await draw(QUEUE_WIDGET);
    expect(await screen.findByRole('img', { name: /^queue\.depth.*2 series/ })).toBeTruthy();
    cleanup();
    const rec = await draw(QUEUE_WIDGET, { trace: 'a'.repeat(32) as TraceId });
    expect(await screen.findByRole('img', { name: /^queue\.depth.*1 series/ })).toBeTruthy();
    await waitFor(() => expect(rec.queries.length).toBeGreaterThan(0));
    expect(rec.queries.at(-1)?.query.where).toContain('"web"');
  });
});
