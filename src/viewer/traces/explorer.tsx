import { type JSX, useEffect, useMemo, useState } from 'react';
import type { AnyManifest } from '../../format/manifest.js';
import { parseUnixNanos, type SpanId, type TraceId } from '../../model/ids.js';
import { Chart } from '../components/chart.js';
import { ColumnPicker } from '../components/column-picker.js';
import { ExplorerControls } from '../components/explorer-controls.js';
import { ErrorCard, NoMatch, PILL, parseSort, QueryNote, sortableOf } from '../components/explorer-states.js';
import {
  downloadBlob,
  type ExportFormat,
  exportFileName,
  exportRows,
  isSpanRow,
  type OtlpSpanGroup,
} from '../components/export.js';
import { DURATION_KEY, FacetPanel, useAttributeFacets } from '../components/facet-panel.js';
import { ottlToTokens } from '../components/filter-tokens.js';
import { GroupTable } from '../components/group-table.js';
import { HistogramCard, SPAN_STATUS_SERIES } from '../components/histogram-card.js';
import { ResultsTable, type SortState } from '../components/results-table.js';
import { copyWidgetItem } from '../dashboards/copy-widget.js';
import type { DataSource } from '../data/data-source.js';
import { manifestRange } from '../data/manifest-range.js';
import {
  CORE_SPAN_FACET_KEYS,
  type DurationBin,
  type SpanQuery,
  type SpanRow,
  type TraceRow,
} from '../data/results.js';
import { isLongWindow } from '../data/time-window.js';
import { useGoTo } from '../shell/go-to.js';
import { PageChrome, useWidgetCopy } from '../shell/page-chrome.js';
import { PageOptionNotice } from '../shell/page-option-notice.js';
import {
  PAGE_OPTIONS,
  type PageMode,
  type PageView,
  resolvePageMode,
  resolvePageView,
} from '../state/page-options.js';
import { useSelection } from '../state/selection-context.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { useTheme } from '../theme/theme-provider.js';
import { attributeColumn, SPAN_COLUMNS_UI, TRACE_COLUMNS_UI } from './columns.js';
import { RedStrip } from './red-strip.js';
import { TracePanel } from './trace-panel.js';
import { useSpanQuery } from './use-span-query.js';
import {
  type ChartView,
  cssTokenReader,
  GROUPED_VIEWS,
  type Measure,
  paddedAxis,
  resolveCssVars,
  VIEW_BUILDERS,
} from './views.js';

const TRACES = PAGE_OPTIONS.traces;
const DEFAULT_MODE = TRACES.modes[0];

const VIEW_LABEL: Record<PageView<'traces'>, string> = {
  list: 'List',
  timeseries: 'Timeseries',
  toplist: 'Top list',
  bar: 'Bar',
  table: 'Table',
  pointplot: 'Point plot',
  treemap: 'Treemap',
  pie: 'Pie',
};

const DEFAULT_SORT: SortState = { column: 'start', dir: 'desc' };
const DURATION_BIN_COUNT = 24;

function boundOf(bounds: readonly { op: string; value: unknown }[], op: '>=' | '<='): number | undefined {
  const v = bounds.find((t) => t.op === op)?.value;
  return typeof v === 'number' ? v : undefined;
}

/** Contiguous bins from edges, the shape the data source counts into. */
function binsOf(edges: readonly number[]): { fromNs: number; toNs: number }[] {
  return edges.slice(0, -1).map((from, i) => ({ fromNs: from, toNs: edges[i + 1] ?? from }));
}

/** An equal axis keeps its identity, so the effect that sets it settles. */
function nextAxis(prev: readonly number[] | null, next: readonly number[] | null): readonly number[] | null {
  return prev === next ||
    (prev !== null && next !== null && prev.length === next.length && prev.every((e, i) => e === next[i]))
    ? prev
    : next;
}

function sameEdges(bins: readonly DurationBin[], edges: readonly number[]): boolean {
  const last = bins[bins.length - 1];
  return (
    last !== undefined &&
    edges.length === bins.length + 1 &&
    edges.every((e, i) => e === (i < bins.length ? bins[i]?.fromNs : last.toNs))
  );
}

function OpenLogs(): JSX.Element {
  const goTo = useGoTo();
  return (
    <button
      type="button"
      onClick={() => goTo('logs', '/logs')}
      className={`${PILL} mt-3 bg-ink text-surface`}
    >
      Open the Logs Explorer
    </button>
  );
}

export function ZeroSpans({ manifest }: { manifest: AnyManifest }): JSX.Element {
  return (
    <section className="max-w-xl rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-base font-semibold">This report has no spans</h2>
      <p className="mt-1 text-sm text-ink-2">
        It does hold <span className="font-mono tabular-nums">{manifest.totals.logs}</span> log records and{' '}
        <span className="font-mono tabular-nums">{manifest.totals.metrics}</span> metric data points.
      </p>
      {manifest.totals.logs > 0 && <OpenLogs />}
    </section>
  );
}

/** Mockup 01: query bar, mode / group-by / view controls, RED strip, histogram, facets left and results right. */
export function TracesExplorer(props: { dataSource: DataSource }): JSX.Element {
  const { manifest } = props.dataSource;
  if (manifest.totals.spans === 0) {
    return (
      <PageChrome title="Traces Explorer" signal="span" manifest={manifest} page="traces">
        <ZeroSpans manifest={manifest} />
      </PageChrome>
    );
  }
  return <ExplorerBody dataSource={props.dataSource} />;
}

function ExplorerBody(props: { dataSource: DataSource }): JSX.Element {
  const { dataSource } = props;
  const manifest = dataSource.manifest;
  const sel = useSelection((s) => s);
  const { mode, invalid: invalidMode } = resolvePageMode('traces', sel.mode);
  const { view, invalid: invalidView } = resolvePageView('traces', sel.view);
  const { resolved } = useTheme();
  const colors = useColorAssigner();
  const range = useMemo(() => manifestRange(manifest), [manifest]);
  const epoch = useMemo(() => parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano'), [manifest]);
  const [measure, setMeasure] = useState<Measure>('requests');
  const [extraColumns, setExtraColumns] = useState<readonly string[]>([]);
  const [exportError, setExportError] = useState<string | null>(null);

  const spanColumns = useMemo(
    () => [...SPAN_COLUMNS_UI, ...extraColumns.map(attributeColumn)],
    [extraColumns],
  );
  const sortable = mode === 'spans' ? sortableOf(SPAN_COLUMNS_UI) : sortableOf(TRACE_COLUMNS_UI);
  const sort = parseSort(sel.sort, sortable, DEFAULT_SORT);

  const [axis, setAxis] = useState<readonly number[] | null>(null);
  const bounds = useMemo(() => {
    const tokens = sel.condition === null ? null : ottlToTokens(sel.condition);
    return (tokens ?? []).filter((t) => t.key === DURATION_KEY && typeof t.value === 'number');
  }, [sel.condition]);
  const long = isLongWindow(sel.window, range);
  const query = useMemo<SpanQuery>(
    () => ({
      condition: sel.condition,
      text: sel.text,
      window: sel.window,
      mode,
      sort: { column: sort.column, dir: sort.dir },
      limit: manifest.config.viewer.listCap,
      // Grouping is a presentation concern in M1: group-by views are built from the result's facets.
      groupBy: null,
      measureBy: null,
      // The overall RED quantiles need both the timeline and the durations.
      needs: ['rows', 'facets', 'timeline', 'durations'],
      facetKeys: long ? CORE_SPAN_FACET_KEYS : null,
      ...(bounds.length > 0 && axis !== null ? { durationAxis: binsOf(axis) } : {}),
    }),
    [
      sel.condition,
      sel.text,
      sel.window,
      long,
      mode,
      sort.column,
      sort.dir,
      manifest.config.viewer.listCap,
      bounds.length,
      axis,
    ],
  );
  const { state } = useSpanQuery(dataSource, query);
  const shown = state.status === 'ready' ? state.result : state.status === 'loading' ? state.previous : null;
  const { facets: loadedFacets, notice: facetsNotice } = useAttributeFacets(
    long,
    JSON.stringify([sel.condition, sel.text, sel.window, mode]),
    dataSource,
    async () =>
      (
        await dataSource.querySpans(
          { ...query, needs: ['facets'], facetKeys: null },
          new AbortController().signal,
        )
      ).facets,
    shown?.facets ?? null,
  );
  const result = useMemo(
    () => (shown === null || loadedFacets === null ? shown : { ...shown, facets: loadedFacets }),
    [shown, loadedFacets],
  );

  const clearFilters = (): void => {
    sel.clear('condition');
    sel.clear('text');
    sel.clear('window');
  };

  const spanRows: SpanRow[] = result?.rows.filter(isSpanRow) ?? [];
  const traceRows: TraceRow[] = result?.rows.filter((r): r is TraceRow => !isSpanRow(r)) ?? [];

  const runExport = async (format: ExportFormat): Promise<void> => {
    try {
      setExportError(null);
      // Only a finished query is exported; the previous result shown while loading is stale.
      if (state.status !== 'ready') {
        throw new Error(
          state.status === 'loading'
            ? 'Export is unavailable while a query is running. Try again when it finishes.'
            : `Export is unavailable because the last query failed: ${state.message}`,
        );
      }
      const all = state.result.rows;
      const exportedSpans = all.filter(isSpanRow);
      let ctx: Parameters<typeof exportRows>[2];
      if (format === 'otlp-json') {
        const ids = new Set(all.map((r) => (isSpanRow(r) ? r.span.traceId : r.traceId)));
        const spanIds = new Set<SpanId>(exportedSpans.map((r) => r.span.spanId));
        const groups: OtlpSpanGroup[] = [];
        for (const id of ids) {
          const detail = await dataSource.getTrace(id as TraceId);
          groups.push({
            spans: detail.spans.map((r) => r.span).filter((s) => mode === 'traces' || spanIds.has(s.spanId)),
            resources: detail.resources,
            scopes: detail.scopes,
          });
        }
        ctx = { epoch, groups };
      }
      downloadBlob(
        exportRows(all, format, ctx),
        exportFileName(mode, all.length, state.result.total, format),
      );
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  const widgetCopy = useWidgetCopy();
  const exportItems = [
    { label: 'Export CSV', onSelect: () => void runExport('csv') },
    { label: 'Export JSON', onSelect: () => void runExport('json') },
    ...(mode === 'spans' ? [{ label: 'Export OTLP JSON', onSelect: () => void runExport('otlp-json') }] : []),
    copyWidgetItem('traces', sel, widgetCopy.copy),
  ];

  const grouped = GROUPED_VIEWS.has(view);
  const attributeKeys = useMemo(
    () => (result?.facets.keys() ?? []).filter((k) => k.includes('.') && !extraColumns.includes(k)).sort(),
    [result, extraColumns],
  );

  const chartOption = useMemo(() => {
    if (result === null || view === 'list' || view === 'table') return null;
    const chart: ChartView = view;
    // `resolved` re-reads the theme tokens when light/dark changes.
    void resolved;
    return resolveCssVars(
      VIEW_BUILDERS[chart](result, { groupBy: sel.groupBy, colors, measure }),
      cssTokenReader(),
    );
  }, [result, view, sel.groupBy, colors, measure, resolved]);

  const onSpanClick = (row: SpanRow): void => {
    sel.selectTrace(row.span.traceId);
    sel.selectSpan(row.span.spanId);
  };
  const onTraceClick = (row: TraceRow): void => sel.selectTrace(row.traceId);

  // Distinct traces in result order: what j/k step through while the panel is open.
  const traceIds = useMemo<readonly TraceId[]>(() => {
    if (result === null) return [];
    const ids = result.rows.map((r) => (isSpanRow(r) ? r.span.traceId : r.traceId));
    return [...new Set(ids)];
  }, [result]);

  // The Duration facet's bins: while no duration filter is set they are the engine's own (min to max of the matching
  // spans) and their edges are remembered. While a filter is set the query is asked to count into the remembered axis,
  // so the committed range stays addressable and every bin is exact; a page opened with a filter has no remembered
  // axis, so it takes one from the first result's range plus the padded bounds, and asks again.
  const bins = useMemo(() => {
    const exact = result?.durations.bins ?? [];
    return bounds.length === 0 || (axis !== null && sameEdges(exact, axis)) ? exact : [];
  }, [result, bounds.length, axis]);
  useEffect(() => {
    if (result === null) return;
    const summary = result.durations.summary;
    if (bounds.length === 0) {
      const first = result.durations.bins[0];
      const last = result.durations.bins[result.durations.bins.length - 1];
      setAxis((prev) =>
        nextAxis(
          prev,
          first === undefined || last === undefined
            ? null
            : [...result.durations.bins.map((b) => b.fromNs), last.toNs],
        ),
      );
    } else if (axis === null && summary !== null) {
      const lo = boundOf(bounds, '>=');
      const hi = boundOf(bounds, '<=');
      // The distribution's extremes as two stand-in rows: the axis depends on the min and the max alone.
      setAxis(
        paddedAxis([{ durationNs: summary.min }, { durationNs: summary.max }], DURATION_BIN_COUNT, {
          ...(lo === undefined ? {} : { lo }),
          ...(hi === undefined || (lo !== undefined && hi < lo) ? {} : { hi }),
        }),
      );
    }
  }, [result, bounds, axis]);

  return (
    <PageChrome
      title="Traces Explorer"
      signal="span"
      manifest={manifest}
      page="traces"
      exportItems={exportItems}
    >
      <div className="flex flex-col gap-4">
        <PageOptionNotice message={invalidMode} onReset={() => sel.setMode(null)} />
        <PageOptionNotice message={invalidView} onReset={() => sel.setView('list')} />
        <ExplorerControls<PageMode<'traces'>, PageView<'traces'>>
          modeLegend="Show"
          modes={TRACES.modes}
          mode={mode}
          modeLabel={(m) => (m === 'spans' ? 'Spans' : 'Traces')}
          onMode={(m) => sel.setMode(m === DEFAULT_MODE ? null : m)}
          views={TRACES.views}
          view={view}
          viewLabel={(v) => VIEW_LABEL[v]}
          onView={sel.setView}
          groupBy={sel.groupBy}
          onGroupBy={(k) => (k === null ? sel.clear('groupBy') : sel.setGroupBy(k))}
          facetKeys={result?.facets.keys() ?? []}
          grouped={grouped}
          groupByTitle={`Not used by the ${VIEW_LABEL[view]} view in this release`}
          groupByNoteId="group-by-note"
          groupByNote={
            <span id="group-by-note" className="text-xs text-muted">
              Group by applies to Top list, Bar, Pie, Treemap and Table; it is not used by the current view
            </span>
          }
        >
          {result !== null && (
            <output className="ml-auto font-mono text-xs tabular-nums text-muted">
              {result.total} {mode === 'spans' ? 'spans' : 'traces'}
              {result.total > result.rows.length ? ` · showing ${result.rows.length}` : ''}
            </output>
          )}
        </ExplorerControls>
        <QueryNote loading={state.status === 'loading'} residual={result?.residual ?? null} />
        {exportError !== null && <ErrorCard title="The export failed" message={exportError} />}
        {state.status === 'error' && (
          <ErrorCard title="The query could not run" message={state.message} gone={state.gone} />
        )}
        {result !== null && (
          <div
            aria-busy={state.status === 'loading'}
            className={state.status === 'loading' ? 'opacity-60' : ''}
          >
            <div className="flex flex-col gap-4">
              {result.red !== null && (
                <RedStrip
                  red={result.red}
                  durations={result.durations.summary}
                  onAnalyze={(m) => {
                    setMeasure(m);
                    sel.setView('timeseries');
                  }}
                />
              )}
              <HistogramCard
                buckets={result.buckets}
                series={SPAN_STATUS_SERIES}
                {...(range === null ? {} : { rangeEnd: range.end })}
              />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-2">
                  {facetsNotice}
                  <FacetPanel signal="span" facets={result.facets} durationBins={bins} />
                </div>
                <div className="min-w-0">
                  {result.total === 0 ? (
                    <NoMatch noun={mode === 'spans' ? 'spans' : 'traces'} onClear={clearFilters} />
                  ) : chartOption !== null ? (
                    <div className="rounded-card border border-hairline bg-surface p-3">
                      <Chart
                        option={chartOption}
                        height={320}
                        ariaLabel={`${VIEW_LABEL[view]} of ${result.total} ${mode}`}
                      />
                    </div>
                  ) : view === 'table' ? (
                    <GroupTable
                      result={result}
                      groupBy={sel.groupBy}
                      colors={colors}
                      noun="Spans"
                      measure="count"
                    />
                  ) : (
                    <div className="flex flex-col gap-2">
                      {mode === 'spans' && (
                        <ColumnPicker keys={attributeKeys} chosen={extraColumns} onChange={setExtraColumns} />
                      )}
                      {mode === 'spans' ? (
                        <ResultsTable
                          rows={spanRows}
                          columns={spanColumns}
                          rowId={(r) => r.span.spanId}
                          sort={sort}
                          onSort={(s) => sel.setSort(`${s.column}:${s.dir}`)}
                          onRowClick={onSpanClick}
                          moveEnabled={sel.traceId === null}
                          selectedId={sel.spanId}
                          epoch={epoch}
                          colors={colors}
                        />
                      ) : (
                        <ResultsTable
                          rows={traceRows}
                          columns={TRACE_COLUMNS_UI}
                          rowId={(r) => r.traceId}
                          sort={sort}
                          onSort={(s) => sel.setSort(`${s.column}:${s.dir}`)}
                          onRowClick={onTraceClick}
                          moveEnabled={sel.traceId === null}
                          selectedId={sel.traceId}
                          epoch={epoch}
                          colors={colors}
                          serviceShare={dataSource.serviceShare}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      {sel.traceId !== null && (
        <TracePanel
          dataSource={dataSource}
          traceId={sel.traceId}
          layout="overlay"
          traceIds={traceIds}
          onClose={() => sel.clear('traceId')}
        />
      )}
      {widgetCopy.dialog}
    </PageChrome>
  );
}
