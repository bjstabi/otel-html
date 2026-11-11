import type { EChartsOption } from 'echarts';
import { type JSX, useMemo } from 'react';
import type { Measure } from '../../../dashboards/schema.js';
import { OtelHtmlError } from '../../../model/errors.js';
import type { TraceId } from '../../../model/ids.js';
import type { FacetCounts } from '../../../rollups/facets.js';
import { Chart } from '../../components/chart.js';
import { ErrorCard, LoadingNote } from '../../components/explorer-states.js';
import { type FacetSource, toplist } from '../../components/facet-views.js';
import { GroupTable } from '../../components/group-table.js';
import { mergeEchartsOption } from '../../components/metric-chart-option.js';
import type { DataSource } from '../../data/data-source.js';
import type { LogQuery, SpanQuery, SpanQueryResult } from '../../data/results.js';
import { useLogQuery } from '../../logs/use-log-query.js';
import { useKeyedAsync } from '../../state/use-keyed-async.js';
import type { QueryHandle } from '../../state/use-query.js';
import { useColorAssigner } from '../../theme/colors-context.js';
import { useTheme } from '../../theme/theme-provider.js';
import { useSpanQuery } from '../../traces/use-span-query.js';
import { cssTokenReader, resolveCssVars } from '../../traces/views.js';
import type { WidgetRenderer } from '../dashboard-page.js';
import type { WidgetScope } from '../scope.js';
import { FRAME_CHROME_PX } from './layout.js';
import { count, scopedCount, useSubtitle } from './subtitle.js';

/** The cap and loading notes. */
const NOTE_PX = 24;
const MIN_PX = 96;

type Facets = FacetSource & { total: number; groups?: SpanQueryResult['groups'] };

const SORT = {
  spans: { column: 'start', dir: 'desc' },
  logs: { column: 'time', dir: 'desc' },
} as const;

/**
 * The statements a facet widget runs: the facet counts of its key (and, for a duration measure, the groups), plus one
 * row so the result carries the match count the subtitle shows.
 */
function queryOf(condition: string | null, text: string, window: SpanQuery['window'], groupBy: string) {
  return { condition, text, window, limit: 1, facetKeys: [groupBy] as readonly string[] };
}

interface Shared {
  widgetType: 'toplist' | 'table';
  groupBy: string;
  measure: Measure;
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

/** Keys that end with `.typed` first, then keys containing it (case-insensitive); each once, at most `max`. */
export function suggestKeys(known: readonly string[], typed: string, max = 3): string[] {
  const t = typed.toLowerCase();
  const suffix = known.filter((k) => k.toLowerCase().endsWith(`.${t}`));
  const inside = known.filter((k) => k.toLowerCase().includes(t));
  return [...new Set([...suffix, ...inside])].slice(0, max);
}

/** Every facet key of the report, unfiltered (the keys behind "did you mean"); read only when a widget shows no values. */
const ALL_KEYS = {
  limit: 1,
  condition: null,
  text: '',
  window: null,
  facetKeys: null,
} as const;
const spanKeys = async (d: DataSource): Promise<string[]> =>
  knownKeys(
    (
      await d.querySpans({
        ...ALL_KEYS,
        mode: 'spans',
        sort: SORT.spans,
        groupBy: null,
        measureBy: null,
        needs: ['facets'],
      })
    ).facets,
  );
const logKeys = async (d: DataSource): Promise<string[]> =>
  knownKeys((await d.queryLogs({ ...ALL_KEYS, mode: 'logs', sort: SORT.logs, needs: ['facets'] })).facets);
// Module-level so they are stable: `useKeyedAsync` reloads on a new `load`.
// A pinned key is known before its first observation, so a report without it still says "no values".
const knownKeys = (f: FacetCounts): string[] => [...new Set([...f.keys(), ...f.pinned])];

/**
 * A duration measure keeps a bounded number of groups; the query cannot count past the cap, so this says only that
 * spans with other values are left out. One truncated line, so the chart's `NOTE_PX` budget holds in a narrow widget;
 * the full sentence is the title and the accessible name.
 */
function CapNote(props: { groupBy: string; cap: number }): JSX.Element {
  const cap = props.cap.toLocaleString('en-US');
  const full = `Measured over the first ${cap} ${props.groupBy} values; spans with other values are left out`;
  return (
    <p role="status" title={full} aria-label={full} className="truncate text-sm text-ink-2">
      {`Spans past the first ${cap} values left out`}
    </p>
  );
}

function UnknownKey(props: { groupBy: string; known: readonly string[] }): JSX.Element {
  const hints = suggestKeys(props.known, props.groupBy);
  return (
    <p className="rounded-card border border-hairline bg-surface p-4 text-sm text-ink-2">
      <span className="font-mono">{props.groupBy}</span> is not a facet of this report
      {hints.length > 0 && (
        <>
          {' \u2014 did you mean '}
          {hints.map((h, i) => (
            <span key={h}>
              {i > 0 && ', '}
              <span className="font-mono">{h}</span>
            </span>
          ))}
          ?
        </>
      )}
    </p>
  );
}

/** Why a widget has no values: the key is not a facet of the report (with near misses), or the window holds none. */
function EmptyFacet(props: {
  dataSource: DataSource;
  noun: 'Spans' | 'Logs';
  groupBy: string;
}): JSX.Element | null {
  const keys = useKeyedAsync(props.dataSource, props.noun === 'Spans' ? spanKeys : logKeys);
  if (keys.status === 'loading') return null;
  if (keys.status === 'ready' && !keys.value.includes(props.groupBy)) {
    return <UnknownKey groupBy={props.groupBy} known={keys.value} />;
  }
  return (
    <p className="rounded-card border border-hairline bg-surface p-4 text-sm text-ink-2">
      No <span className="font-mono">{props.groupBy}</span> values in this window
    </p>
  );
}

function FacetBody<R extends Facets>(
  props: Shared & { handle: QueryHandle<R>; dataSource: DataSource },
): JSX.Element {
  const { handle, groupBy, measure } = props;
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
    const base = resolveCssVars(toplist(result, { groupBy, colors, measure }), cssTokenReader());
    return props.echarts === null ? base : (mergeEchartsOption(base, props.echarts) as EChartsOption);
  }, [result, empty, props.widgetType, groupBy, measure, colors, props.echarts, resolved]);
  const groups = measure === 'count' ? null : (result?.groups ?? null);
  const dropped = groups?.dropped ?? 0;
  const notes = (dropped > 0 ? NOTE_PX : 0) + (state.status === 'loading' ? NOTE_PX : 0);
  const chartPx = Math.max(MIN_PX, props.height - FRAME_CHROME_PX - notes);
  return (
    <div className="flex flex-col gap-1">
      {groups !== null && dropped > 0 && <CapNote groupBy={groupBy} cap={groups.cap} />}
      {state.status === 'loading' && <LoadingNote />}
      {state.status === 'error' && (
        <ErrorCard title="The query could not run" message={state.message} gone={state.gone} />
      )}
      {result !== null &&
        (empty ? (
          <EmptyFacet dataSource={props.dataSource} noun={props.noun} groupBy={groupBy} />
        ) : option !== null ? (
          <Chart
            option={option}
            height={chartPx}
            ariaLabel={`Top ${groupBy} of ${count(result.total, unit)}`}
          />
        ) : (
          <div className="overflow-auto" style={{ maxHeight: chartPx }}>
            <GroupTable
              result={result}
              groupBy={groupBy}
              colors={colors}
              noun={props.noun}
              measure={measure}
            />
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

// Only the facet counts are drawn; the `total` need gives the match count the subtitle shows without reading a row.
function SpanFacets(props: Shared & { dataSource: DataSource; filter: Filter }): JSX.Element {
  const { dataSource, filter, ...rest } = props;
  const { condition, text, window } = filter;
  const { measure, groupBy } = rest;
  const query = useMemo<SpanQuery>(
    () => ({
      ...queryOf(condition, text, window, groupBy),
      mode: 'spans',
      sort: SORT.spans,
      groupBy: null,
      measureBy: measure === 'count' ? null : groupBy,
      needs: measure === 'count' ? ['total', 'facets'] : ['total', 'facets', 'groups'],
    }),
    [condition, text, window, measure, groupBy],
  );
  return <FacetBody {...rest} dataSource={dataSource} handle={useSpanQuery(dataSource, query)} />;
}

function LogFacets(props: Shared & { dataSource: DataSource; filter: Filter }): JSX.Element {
  const { dataSource, filter, ...rest } = props;
  const { condition, text, window, traceId } = filter;
  const { groupBy } = rest;
  const query = useMemo<LogQuery>(
    () => ({
      ...queryOf(condition, text, window, groupBy),
      mode: 'logs',
      sort: SORT.logs,
      traceId,
      needs: ['rows', 'facets'],
    }),
    [condition, text, window, traceId, groupBy],
  );
  return <FacetBody {...rest} dataSource={dataSource} handle={useLogQuery(dataSource, query)} />;
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
    measure: widget.measure,
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
