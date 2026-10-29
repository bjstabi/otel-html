import type { EChartsOption } from 'echarts';
import { type JSX, useMemo } from 'react';
import { OtelHtmlError } from '../../../model/errors.js';
import type { TraceId } from '../../../model/ids.js';
import { Chart } from '../../components/chart.js';
import { ErrorCard, LoadingNote, PartialNote } from '../../components/explorer-states.js';
import { type FacetSource, toplist } from '../../components/facet-views.js';
import { GroupTable } from '../../components/group-table.js';
import { mergeEchartsOption } from '../../components/metric-chart-option.js';
import type { DataSource } from '../../data/data-source.js';
import type { LogQuery } from '../../data/log-query.js';
import type { SpanQuery } from '../../data/span-query.js';
import { useLogQuery } from '../../logs/use-log-query.js';
import type { QueryHandle } from '../../state/use-query.js';
import { useColorAssigner } from '../../theme/colors-context.js';
import { useTheme } from '../../theme/theme-provider.js';
import { useSpanQuery } from '../../traces/use-span-query.js';
import { cssTokenReader, resolveCssVars } from '../../traces/views.js';
import type { WidgetRenderer } from '../dashboard-page.js';
import type { WidgetScope } from '../scope.js';
import { FRAME_CHROME_PX } from './layout.js';
import { count, scopedCount, useSubtitle } from './subtitle.js';

/** The partial and loading notes. */
const NOTE_PX = 24;
const MIN_PX = 96;

type Facets = FacetSource & { total: number; partial: { scanned: number; total: number } | null };

const SORT = {
  spans: { column: 'start', dir: 'desc' },
  logs: { column: 'time', dir: 'desc' },
} as const;

function queryOf(condition: string | null, text: string, window: SpanQuery['window']) {
  return { condition, text, window, limit: 1, scanAll: false };
}

interface Shared {
  widgetType: 'toplist' | 'table';
  groupBy: string;
  echarts: Record<string, unknown> | null;
  height: number;
  noun: 'Spans' | 'Logs';
  actions: Parameters<WidgetRenderer>[0]['actions'];
  scope: Pick<WidgetScope, 'narrowed' | 'traceFilter'>;
}

/** Only a finished result: facets of the previous inputs are never shown as if they were current. */
function readyOf<R extends Facets>(h: QueryHandle<R>): R | null {
  return h.state.status === 'ready' ? h.state.result : null;
}

function FacetBody<R extends Facets>(props: Shared & { handle: QueryHandle<R> }): JSX.Element {
  const { handle, groupBy } = props;
  const colors = useColorAssigner();
  const { resolved } = useTheme();
  const result = readyOf(handle);
  const { state } = handle;
  const unit = props.noun === 'Spans' ? 'span' : 'log';
  useSubtitle(props.actions, result === null ? null : scopedCount(result.total, unit, props.scope));
  const empty = result !== null && result.facets.total(groupBy) === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolved re-reads the CSS colour tokens on a theme change
  const option = useMemo(() => {
    if (result === null || empty || props.widgetType !== 'toplist') return null;
    const base = resolveCssVars(toplist(result, { groupBy, colors }), cssTokenReader());
    return props.echarts === null ? base : (mergeEchartsOption(base, props.echarts) as EChartsOption);
  }, [result, empty, props.widgetType, groupBy, colors, props.echarts, resolved]);
  const notes = (result?.partial == null ? 0 : NOTE_PX) + (state.status === 'loading' ? NOTE_PX : 0);
  const chartPx = Math.max(MIN_PX, props.height - FRAME_CHROME_PX - notes);
  return (
    <div className="flex flex-col gap-1">
      {result !== null && <PartialNote partial={result.partial} onScanAll={handle.scanAll} />}
      {state.status === 'loading' && <LoadingNote progress={state.progress} />}
      {state.status === 'error' && <ErrorCard title="The query could not run" message={state.message} />}
      {result !== null &&
        (empty ? (
          <p className="rounded-card border border-hairline bg-surface p-4 text-sm text-ink-2">
            No <span className="font-mono">{groupBy}</span> values in this window
          </p>
        ) : option !== null ? (
          <Chart
            option={option}
            height={chartPx}
            ariaLabel={`Top ${groupBy} of ${count(result.total, unit)}`}
          />
        ) : (
          <div className="overflow-auto" style={{ maxHeight: chartPx }}>
            <GroupTable result={result} groupBy={groupBy} colors={colors} noun={props.noun} />
          </div>
        ))}
    </div>
  );
}

/** What the query reads: the widget's text and the scope's condition, window and trace. */
interface Filter {
  condition: string | null;
  text: string;
  window: SpanQuery['window'];
  traceId: TraceId | null;
}

// Only the facet counts are drawn, so no rows are read.
function SpanFacets(props: Shared & { dataSource: DataSource; filter: Filter }): JSX.Element {
  const { dataSource, filter, ...rest } = props;
  const { condition, text, window } = filter;
  const query = useMemo<SpanQuery>(
    () => ({ ...queryOf(condition, text, window), mode: 'spans', sort: SORT.spans, groupBy: null }),
    [condition, text, window],
  );
  return <FacetBody {...rest} handle={useSpanQuery(dataSource, query)} />;
}

function LogFacets(props: Shared & { dataSource: DataSource; filter: Filter }): JSX.Element {
  const { dataSource, filter, ...rest } = props;
  const { condition, text, window, traceId } = filter;
  const query = useMemo<LogQuery>(
    () => ({ ...queryOf(condition, text, window), mode: 'logs', sort: SORT.logs, traceId }),
    [condition, text, window, traceId],
  );
  return <FacetBody {...rest} handle={useLogQuery(dataSource, query)} />;
}

/** A span or log query's facet counts grouped by the widget's key: the explorers' top-list chart or group table. */
export const FacetChartWidget: WidgetRenderer = ({ widget, scope, height, dataSource, actions }) => {
  if (widget.type !== 'toplist' && widget.type !== 'table') {
    throw new OtelHtmlError('usage', {
      path: 'widget.type',
      expected: 'toplist or table',
      actual: widget.type,
    });
  }
  const { text, signal } = widget;
  const filter: Filter = {
    condition: scope.condition,
    text,
    window: scope.window,
    traceId: scope.traceFilter,
  };
  const shared: Shared = {
    widgetType: widget.type,
    groupBy: widget.groupBy,
    echarts: widget.type === 'toplist' ? widget.echarts : null,
    height,
    noun: signal === 'spans' ? 'Spans' : 'Logs',
    actions,
    scope,
  };
  return signal === 'spans' ? (
    <SpanFacets {...shared} dataSource={dataSource} filter={filter} />
  ) : (
    <LogFacets {...shared} dataSource={dataSource} filter={filter} />
  );
};
