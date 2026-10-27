import { type JSX, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { parseUnixNanos, type SpanId, type TraceId } from '../../model/ids.js';
import { Chart } from '../components/chart.js';
import {
  downloadBlob,
  type ExportFormat,
  exportRows,
  isSpanRow,
  type OtlpSpanGroup,
} from '../components/export.js';
import { FacetPanel } from '../components/facet-panel.js';
import { HistogramCard } from '../components/histogram-card.js';
import { ResultsTable, type SortState } from '../components/results-table.js';
import type { DataSource, SpanQuery, SpanQueryResult, SpanRow, TraceRow } from '../data/data-source.js';
import { PageChrome } from '../shell/page-chrome.js';
import { PageOptionNotice } from '../shell/page-option-notice.js';
import { PAGE_OPTIONS, type PageView, resolvePageMode, resolvePageView } from '../state/page-options.js';
import { useSelection } from '../state/selection-context.js';
import { useColorAssigner } from '../theme/colors-context.js';
import type { ColorAssigner } from '../theme/palette.js';
import { useTheme } from '../theme/theme-provider.js';
import { attributeColumn, type ColumnUi, SPAN_COLUMNS_UI, TRACE_COLUMNS_UI } from './columns.js';
import { RedStrip } from './red-strip.js';
import { TracePanel } from './trace-panel.js';
import { useSpanQuery } from './use-span-query.js';
import {
  type ChartView,
  DEFAULT_GROUP_KEY,
  durationBins,
  GROUPED_VIEWS,
  groupSlices,
  type Measure,
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
const PILL = 'rounded-full px-3 py-1 text-sm';
const FIELD = 'rounded-full border border-hairline bg-surface px-3 py-1 text-sm';

/** `column:dir`, as stored in the selection; anything that is not a sortable column of this mode is the default. */
export function parseSort(raw: string | null, sortable: readonly string[]): SortState {
  if (raw === null) return DEFAULT_SORT;
  const at = raw.lastIndexOf(':');
  const column = raw.slice(0, at);
  const dir = raw.slice(at + 1);
  if (at <= 0 || (dir !== 'asc' && dir !== 'desc') || !sortable.includes(column)) return DEFAULT_SORT;
  return { column, dir };
}

function sortableOf(columns: readonly ColumnUi<never>[]): string[] {
  return columns.flatMap((c) => (c.sort === undefined ? [] : [c.sort]));
}

function ErrorCard(props: { title: string; message: string }): JSX.Element {
  return (
    <div role="alert" className="rounded-card border border-hairline bg-surface p-4">
      <p className="font-semibold text-critical">{props.title}</p>
      <p className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{props.message}</p>
    </div>
  );
}

export function ZeroSpans({ manifest }: { manifest: Manifest }): JSX.Element {
  return (
    <section className="max-w-xl rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-base font-semibold">This report has no spans</h2>
      <p className="mt-1 text-sm text-ink-2">
        It does hold <span className="font-mono tabular-nums">{manifest.totals.logs}</span> log records and{' '}
        <span className="font-mono tabular-nums">{manifest.totals.metrics}</span> metric data points.
      </p>
    </section>
  );
}

export function PartialNote(props: {
  partial: SpanQueryResult['partial'];
  onScanAll(): void;
}): JSX.Element | null {
  const { partial } = props;
  if (partial === null) return null;
  return (
    <p role="status" aria-label="Partial results" className="text-sm text-ink-2">
      <span className="font-mono tabular-nums">
        from {partial.scanned} of {partial.total} chunks
      </span>{' '}
      <span aria-hidden>·</span>{' '}
      <button
        type="button"
        onClick={props.onScanAll}
        className="rounded-full px-2 py-0.5 text-accent underline"
      >
        Scan entire run
      </button>
    </p>
  );
}

function GroupTable(props: {
  result: SpanQueryResult;
  groupBy: string | null;
  colors: ColorAssigner;
}): JSX.Element {
  const key = props.groupBy ?? DEFAULT_GROUP_KEY;
  const slices = groupSlices(props.result.facets, key, props.colors);
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <table className="w-full rounded-card border border-hairline bg-surface text-sm">
      <caption className="sr-only">Spans grouped by {key}</caption>
      <thead>
        <tr className="border-b border-hairline text-left text-xs text-ink-2">
          <th scope="col" className="p-2">
            {key}
          </th>
          <th scope="col" className="p-2 text-right">
            Spans
          </th>
          <th scope="col" className="p-2 text-right">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {slices.map((s) => (
          <tr
            key={`${s.other ? 'rest' : 'value'}:${s.key}`}
            className="border-b border-hairline last:border-0"
          >
            <td className="p-2 font-mono text-xs">{s.name}</td>
            <td className="p-2 text-right font-mono tabular-nums">{s.value}</td>
            <td className="p-2 text-right font-mono tabular-nums">
              {total === 0 ? '0' : Math.round((s.value / total) * 100)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function tokenReader(): (name: string) => string {
  const style = getComputedStyle(document.documentElement);
  return (name) => style.getPropertyValue(name).trim();
}

/** Mockup 01: query bar, mode / group-by / view controls, RED strip, histogram, facets left and results right. */
export function TracesExplorer(props: { dataSource: DataSource }): JSX.Element {
  const { manifest } = props.dataSource;
  if (manifest.totals.spans === 0) {
    return (
      <PageChrome title="Traces Explorer" manifest={manifest}>
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
  const epoch = useMemo(() => parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano'), [manifest]);
  const [measure, setMeasure] = useState<Measure>('requests');
  const [extraColumns, setExtraColumns] = useState<readonly string[]>([]);
  const [exportError, setExportError] = useState<string | null>(null);

  const spanColumns = useMemo(
    () => [...SPAN_COLUMNS_UI, ...extraColumns.map(attributeColumn)],
    [extraColumns],
  );
  const sortable = mode === 'spans' ? sortableOf(SPAN_COLUMNS_UI) : sortableOf(TRACE_COLUMNS_UI);
  const sort = parseSort(sel.sort, sortable);

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
      scanAll: false,
    }),
    [sel.condition, sel.text, sel.window, mode, sort.column, sort.dir, manifest.config.viewer.listCap],
  );
  const { state, scanAll } = useSpanQuery(dataSource, query);
  const result = state.status === 'ready' ? state.result : state.status === 'loading' ? state.previous : null;

  function setView(v: string): void {
    const next = TRACES.views.find((x) => x === v);
    if (next !== undefined) sel.setView(next);
  }

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
      const ext = format === 'csv' ? 'csv' : 'json';
      const { total } = state.result;
      // A truncated export says so in its file name: the file holds the first N of M.
      const scope = total > all.length ? `first-${all.length}-of-${total}` : `${total}`;
      downloadBlob(
        exportRows(all, format, ctx),
        `${mode}-${scope}.${format === 'otlp-json' ? 'otlp.' : ''}${ext}`,
      );
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  const exportItems = [
    { label: 'Export CSV', onSelect: () => void runExport('csv') },
    { label: 'Export JSON', onSelect: () => void runExport('json') },
    ...(mode === 'spans' ? [{ label: 'Export OTLP JSON', onSelect: () => void runExport('otlp-json') }] : []),
  ];

  const grouped = GROUPED_VIEWS.has(view);
  const groupKeys = useMemo(() => {
    const keys = result?.facets.keys().sort() ?? [];
    return sel.groupBy !== null && !keys.includes(sel.groupBy) ? [sel.groupBy, ...keys] : keys;
  }, [result, sel.groupBy]);
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
      tokenReader(),
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

  const truncated = result !== null && result.total > result.rows.length;
  const bins = useMemo(() => durationBins(result?.rows ?? [], DURATION_BIN_COUNT), [result]);

  return (
    <PageChrome title="Traces Explorer" manifest={manifest} exportItems={exportItems}>
      <div className="flex flex-col gap-4">
        <PageOptionNotice message={invalidMode} onReset={() => sel.setMode(null)} />
        <PageOptionNotice message={invalidView} onReset={() => sel.setView('list')} />
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex gap-1 rounded-full border border-hairline bg-surface p-0.5">
            <legend className="sr-only">Show</legend>
            {TRACES.modes.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                data-selected={mode === m ? 'true' : undefined}
                onClick={() => sel.setMode(m === DEFAULT_MODE ? null : m)}
                className={`${PILL} ${mode === m ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'}`}
              >
                {m === 'spans' ? 'Spans' : 'Traces'}
              </button>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            Group by
            <select
              aria-label="Group by"
              className={FIELD}
              value={sel.groupBy ?? ''}
              disabled={!grouped}
              title={grouped ? undefined : `Not used by the ${VIEW_LABEL[view]} view in this release`}
              aria-describedby={grouped ? undefined : 'group-by-note'}
              onChange={(e) =>
                e.target.value === '' ? sel.clear('groupBy') : sel.setGroupBy(e.target.value)
              }
            >
              <option value="">Service (default)</option>
              {groupKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          {!grouped && (
            <span id="group-by-note" className="text-xs text-muted">
              Group by applies to Top list, Bar, Pie, Treemap and Table; it is not used by the current view
            </span>
          )}
          <label className="flex items-center gap-2 text-sm text-ink-2">
            View
            <select
              aria-label="View"
              className={FIELD}
              value={view}
              onChange={(e) => setView(e.target.value)}
            >
              {TRACES.views.map((v) => (
                <option key={v} value={v}>
                  {VIEW_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          {result !== null && (
            <output className="ml-auto font-mono text-xs tabular-nums text-muted">
              {result.total} {mode === 'spans' ? 'spans' : 'traces'}
              {result.total > result.rows.length ? ` · showing ${result.rows.length}` : ''}
            </output>
          )}
        </div>
        {result !== null && <PartialNote partial={result.partial} onScanAll={scanAll} />}
        {state.status === 'loading' && (
          <p role="status" className="text-sm text-muted">
            {state.progress === null
              ? 'Loading'
              : `Scanning ${state.progress.scanned} of ${state.progress.total} chunks`}
          </p>
        )}
        {exportError !== null && <ErrorCard title="The export failed" message={exportError} />}
        {state.status === 'error' && <ErrorCard title="The query could not run" message={state.message} />}
        {result !== null && (
          <div
            aria-busy={state.status === 'loading'}
            className={state.status === 'loading' ? 'opacity-60' : ''}
          >
            <div className="flex flex-col gap-4">
              <RedStrip
                red={result.red}
                onAnalyze={(m) => {
                  setMeasure(m);
                  sel.setView('timeseries');
                }}
              />
              <HistogramCard
                buckets={result.buckets}
                {...(manifest.range === null ? {} : { rangeEnd: manifest.range.end })}
              />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
                <div className="flex min-w-0 flex-col gap-2">
                  {truncated && (
                    <p
                      data-testid="duration-bins-note"
                      className="rounded-md bg-page px-2 py-1 text-xs text-muted"
                    >
                      Duration distribution is from the first{' '}
                      <span className="font-mono tabular-nums">{result.rows.length}</span> of{' '}
                      <span className="font-mono tabular-nums">{result.total}</span>{' '}
                      {mode === 'spans' ? 'spans' : 'traces'}
                    </p>
                  )}
                  <FacetPanel facets={result.facets} durationBins={bins} />
                </div>
                <div className="min-w-0">
                  {result.total === 0 ? (
                    <section className="rounded-card border border-hairline bg-surface p-6">
                      <h2 className="text-base font-semibold">
                        No {mode === 'spans' ? 'spans' : 'traces'} match
                      </h2>
                      <p className="mt-1 text-sm text-ink-2">
                        Nothing in this run matches the current filters.
                      </p>
                      <button
                        type="button"
                        onClick={clearFilters}
                        className={`${PILL} mt-3 bg-ink text-surface`}
                      >
                        Clear filters
                      </button>
                    </section>
                  ) : chartOption !== null ? (
                    <div className="rounded-card border border-hairline bg-surface p-3">
                      <Chart
                        option={chartOption}
                        height={320}
                        ariaLabel={`${VIEW_LABEL[view]} of ${result.total} ${mode}`}
                      />
                    </div>
                  ) : view === 'table' ? (
                    <GroupTable result={result} groupBy={sel.groupBy} colors={colors} />
                  ) : (
                    <div className="flex flex-col gap-2">
                      {mode === 'spans' && (
                        <ColumnPicker
                          keys={attributeKeys}
                          chosen={extraColumns}
                          onAdd={(k) => setExtraColumns([...extraColumns, k])}
                          onRemove={(k) => setExtraColumns(extraColumns.filter((c) => c !== k))}
                        />
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
    </PageChrome>
  );
}

function ColumnPicker(props: {
  keys: readonly string[];
  chosen: readonly string[];
  onAdd(k: string): void;
  onRemove(k: string): void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-2 text-ink-2">
        Columns
        <select
          className={FIELD}
          value=""
          aria-label="Add column"
          onChange={(e) => e.target.value !== '' && props.onAdd(e.target.value)}
        >
          <option value="">Add attribute column</option>
          {props.keys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {props.chosen.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => props.onRemove(k)}
          aria-label={`Remove column ${k}`}
          className="rounded-full border border-hairline px-2 py-0.5 font-mono text-xs hover:bg-hairline"
        >
          {k} <span aria-hidden>×</span>
        </button>
      ))}
    </div>
  );
}
