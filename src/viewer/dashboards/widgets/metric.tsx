import { type JSX, useCallback, useMemo, useState } from 'react';
import { andConditions } from '../../../dashboards/conditions.js';
import { OtelHtmlError } from '../../../model/errors.js';
import type { TraceId } from '../../../model/ids.js';
import type { ResourceRecord } from '../../../model/records.js';
import type { MetricPageState } from '../../../query/metric-query.js';
import { ErrorCard, LoadingNote } from '../../components/explorer-states.js';
import { type ChartPick, MetricChartCard } from '../../components/metric-chart-card.js';
import { METRIC_CHART_HEIGHT, type MetricSize } from '../../components/metric-chart-option.js';
import { catalogOf, type DataSource } from '../../data/data-source.js';
import { type MetricQuery, resolveMetric } from '../../data/metric-query.js';
import type { TimeWindow } from '../../data/span-query.js';
import { exemplarTraceLookup, openChartPick } from '../../metrics/chart-pick.js';
import { explorerFilter, MetricGrid, type MetricGridOrigin } from '../../metrics/metric-grid.js';
import { buildPlots, layoutCharts } from '../../metrics/plots.js';
import { useMetricQueries } from '../../metrics/use-metric-query.js';
import { useGoTo } from '../../shell/go-to.js';
import { useKeyedAsync } from '../../state/use-keyed-async.js';
import { traceResources } from '../../traces/trace-tabs.js';
import type { WidgetRenderer } from '../dashboard-page.js';
import { resourcesMatching, variableCondition } from '../scope.js';
import { FRAME_CHROME_PX } from './layout.js';
import { useSubtitle } from './subtitle.js';

/** A chart card's own title, subtitle and padding, around its chart. */
const CARD_CHROME_PX = 60;
const FALLBACK_WINDOW: TimeWindow = { start: 0, end: 1 };

/** What the selected trace does to a metric widget: its resources narrow every query (spec §6.2). */
export type Narrowing =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      resources: readonly ResourceRecord[];
      where: string | null;
      /** Other resources the `where` also matches (they differ only in attributes a filter cannot compare). */
      unexcluded: number;
    };

const OFF: Narrowing = { status: 'off' };

/**
 * The trace's resources and the `where` that names them (`explorerFilter` against every catalog resource).
 * `null` is no trace: nothing loads. A change of trace is `loading` until its own resources arrive.
 */
export function useNarrowing(dataSource: DataSource, traceId: TraceId | null): Narrowing {
  const load = useCallback(
    async (
      id: TraceId,
    ): Promise<{ resources: readonly ResourceRecord[]; where: string | null; unexcluded: number }> => {
      const [detail, catalog] = await Promise.all([dataSource.getTrace(id), dataSource.metricCatalog()]);
      const resources = traceResources(detail);
      const { where, unexcluded } = explorerFilter(resources, catalog.resources());
      return { resources, where, unexcluded };
    },
    [dataSource],
  );
  const state = useKeyedAsync(traceId, load);
  if (traceId === null) return OFF;
  return state.status === 'ready' ? { status: 'ready', ...state.value } : state;
}

/**
 * A query's effective `where`: its own, the variables on the data point's resource, and the selected trace's
 * resources, joined with `and`. The one place that builds it: the widget runs it and Open in Metrics links it.
 */
export function effectiveWhere(
  q: Pick<MetricQuery, 'where'>,
  variables: Parameters<typeof variableCondition>[0],
  resourceFilter: string | null,
): string | null {
  return andConditions(q.where, variableCondition(variables, 'datapoint'), resourceFilter);
}

/** The widget's queries with their effective `where`. */
export function effectiveQueries(
  queries: readonly MetricQuery[],
  variables: Parameters<typeof variableCondition>[0],
  resourceFilter: string | null,
): MetricQuery[] {
  return queries.map((q) => ({ ...q, where: effectiveWhere(q, variables, resourceFilter) }));
}

function sizeFor(heightPx: number): MetricSize {
  const room = heightPx - FRAME_CHROME_PX;
  if (room >= METRIC_CHART_HEIGHT.L + CARD_CHROME_PX) return 'L';
  return room >= METRIC_CHART_HEIGHT.M + CARD_CHROME_PX ? 'M' : 'S';
}

function Empty(props: { title: string; message: string }): JSX.Element {
  return (
    <section className="rounded-card border border-hairline bg-surface p-4">
      <h3 className="text-sm font-semibold">{props.title}</h3>
      <p className="mt-1 text-sm text-ink-2">{props.message}</p>
    </section>
  );
}

type Body = (props: Parameters<WidgetRenderer>[0]) => JSX.Element;

/** The M3 chart card over the widget's queries, narrowed by the variables and the selected trace's resources. */
const QueriesBody: Body = ({ widget, scope, height, dataSource, actions, variables }) => {
  if (widget.type !== 'metric' || widget.queries === null) {
    throw new OtelHtmlError('usage', { path: 'widget.queries', expected: 'queries', actual: 'none' });
  }
  const { queries: own, formulas, display, scale, exemplars, echarts } = widget;
  const goTo = useGoTo();
  const narrowing = useNarrowing(dataSource, scope.highlightTrace);
  const catalog = useKeyedAsync(dataSource, catalogOf);
  const run = dataSource.manifest.range;
  const win = scope.window ?? run ?? FALLBACK_WINDOW;
  const [actionError, setActionError] = useState<string | null>(null);
  const hasTrace = useMemo(() => exemplarTraceLookup(dataSource), [dataSource]);

  const ready = narrowing.status === 'off' || narrowing.status === 'ready';
  const filter = narrowing.status === 'ready' ? narrowing.where : null;
  const queries = useMemo(() => effectiveQueries(own, variables, filter), [own, variables, filter]);
  // Until the trace's resources are known nothing runs: a run on the wider set would flash as the answer.
  const state = useMemo<MetricPageState>(
    () => ({
      queries: ready ? queries : [],
      formulas: ready ? formulas : [],
      display,
      scale,
      split: false,
      exemplars,
    }),
    [ready, queries, formulas, display, scale, exemplars],
  );
  const result = useMetricQueries(dataSource, state, win);

  const missing = useMemo(
    () =>
      catalog.status === 'ready'
        ? new Set(queries.filter((q) => 'missing' in resolveMetric(catalog.value, q)).map((q) => q.id))
        : new Set<string>(),
    [catalog, queries],
  );
  const missingNames = [...new Set(queries.filter((q) => missing.has(q.id)).map((q) => q.metric))];
  const plots = useMemo(() => buildPlots(state, result), [state, result]);
  const layout = layoutCharts(plots, state);
  const labels = useMemo(
    () =>
      Object.fromEntries([
        ...queries.map((q) => [q.id, q.alias ?? q.id]),
        ...formulas.map((f) => [f.id, f.alias ?? f.id]),
      ]),
    [queries, formulas],
  );

  if (run === null) return <Empty title="This report has no metrics" message="There is nothing to chart." />;
  if (narrowing.status === 'error')
    return <ErrorCard title="The selected trace could not be read" message={narrowing.message} />;
  if (catalog.status === 'error')
    return <ErrorCard title="The metric catalog could not be loaded" message={catalog.message} />;
  if (result.failure !== null)
    return <ErrorCard title="The queries could not run" message={result.failure} />;
  if (catalog.status === 'loading' || narrowing.status === 'loading' || result.loading) {
    return <LoadingNote progress={null} />;
  }
  if (missingNames.length === queries.length) {
    return <Empty title="Not in this report" message={`${missingNames.join(', ')} is not in this report`} />;
  }
  const failures = [...result.errors].filter(([id]) => !missing.has(id));
  const noData = plots.length > 0 && plots.every((p) => p.result.series.length === 0);
  const size = sizeFor(height);

  const onPick = (pick: ChartPick): void => {
    try {
      setActionError(null);
      openChartPick(pick, {
        goTo,
        queryOf: (id) => queries.find((x) => x.id === id),
        zoom: actions.selectWindow,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col gap-2" style={{ maxHeight: height - FRAME_CHROME_PX, overflowY: 'auto' }}>
      {narrowing.status === 'ready' && <NarrowingNote narrowing={narrowing} />}
      {missingNames.map((name) => (
        <p key={name} role="note" className="text-xs text-muted">
          {name} is not in this report
        </p>
      ))}
      {failures.map(([id, message]) => (
        <ErrorCard key={id} title={`Query ${id} could not run`} message={message} />
      ))}
      {actionError !== null && <ErrorCard title="The link could not be opened" message={actionError} />}
      {noData && <Empty title="No data points in this window" message="The queries match no data points." />}
      {layout.cards.map((card) => (
        <MetricChartCard
          key={card.map((p) => p.id).join('+')}
          title={card.map((p) => p.title).join(' / ')}
          subtitle={[...new Set(card.flatMap((p) => p.result.series.map((s) => s.unit)))].join(', ')}
          results={card.map((p) => p.result)}
          display={layout.histogramDisplay && card[0]?.histogram !== true ? 'lines' : layout.display}
          scale={scale}
          size={size}
          exemplars={exemplars}
          highlightTrace={scope.highlightTrace}
          band={scope.band}
          echarts={echarts}
          notes={[...new Set(card.flatMap((p) => p.result.notes))]}
          window={win}
          queryLabels={labels}
          hasTrace={hasTrace}
          onPick={onPick}
          onZoom={actions.selectWindow}
          onSelectTrace={actions.selectTrace}
        />
      ))}
    </div>
  );
};

/** What the trace's resources could not narrow: never a silently wider answer (spec §6.2). */
function NarrowingNote(props: { narrowing: Extract<Narrowing, { status: 'ready' }> }): JSX.Element | null {
  const { resources, where, unexcluded } = props.narrowing;
  if (resources.length > 0 && where === null) {
    return (
      <p role="note" className="text-xs text-muted">
        The selected trace's resources have no attribute a filter can compare, so the charts show every
        resource.
      </p>
    );
  }
  if (unexcluded === 0) return null;
  return (
    <p role="note" className="text-xs text-muted">
      The charts also include {unexcluded} other {unexcluded === 1 ? 'resource' : 'resources'} that differ
      from the trace's only in attributes a filter cannot compare.
    </p>
  );
}

/** Fusion's Metrics widget: the metric grid of the selected trace's resources, else of every resource. */
const GridBody: Body = ({ scope, height, dataSource, actions, variables }) => {
  const narrowing = useNarrowing(dataSource, scope.highlightTrace);
  const catalog = useKeyedAsync(dataSource, catalogOf);
  const run = dataSource.manifest.range;
  const start = scope.window?.start ?? run?.start;
  const end = scope.window?.end ?? run?.end;
  const resources = narrowing.status === 'ready' ? narrowing.resources : null;
  const all = catalog.status === 'ready' ? catalog.value.resources() : null;
  const origin = useMemo((): MetricGridOrigin | null => {
    const wide = resources ?? (narrowing.status === 'off' ? all : null);
    const rs = wide === null ? null : resourcesMatching(wide, variables);
    if (rs === null || start === undefined || end === undefined) return null;
    return {
      kind: 'dashboard',
      resources: rs,
      at: null,
      window: { start, end },
      traceId: scope.highlightTrace,
    };
  }, [resources, all, narrowing.status, variables, start, end, scope.highlightTrace]);
  const base = scope.highlightTrace === null ? 'all resources' : "from the selected trace's resources";
  useSubtitle(
    actions,
    variables.length === 0
      ? base
      : `${base}, where ${variables.map((v) => `${v.key} = ${v.value}`).join(' and ')}`,
  );

  if (run === null) return <Empty title="This report has no metrics" message="There is nothing to chart." />;
  if (narrowing.status === 'error')
    return <ErrorCard title="The selected trace could not be read" message={narrowing.message} />;
  if (catalog.status === 'error')
    return <ErrorCard title="The metric catalog could not be loaded" message={catalog.message} />;
  if (origin === null) return <LoadingNote progress={null} />;
  if (origin.resources.length === 0) {
    return <Empty title="No matching resources" message="No resource matches the chosen variables." />;
  }
  return (
    <div style={{ height: height - FRAME_CHROME_PX }} className="overflow-auto">
      <MetricGrid
        dataSource={dataSource}
        origin={origin}
        band={scope.band}
        onSelectTrace={actions.selectTrace}
      />
    </div>
  );
};

/** The Metrics widget: chart cards over its `queries`, or (without them) the resource Metric grid. */
export const MetricWidget: WidgetRenderer = (props) => {
  const { widget } = props;
  if (widget.type !== 'metric') {
    throw new OtelHtmlError('usage', { path: 'widget.type', expected: 'metric', actual: widget.type });
  }
  return widget.queries === null ? <GridBody {...props} /> : <QueriesBody {...props} />;
};
