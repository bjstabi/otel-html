import { type JSX, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { parseUnixNanos, type TraceId } from '../../model/ids.js';
import { DEFAULT_LOG_FACETS } from '../../rollups/log-rollups.js';
import { Chart } from '../components/chart.js';
import { ColumnPicker } from '../components/column-picker.js';
import { ExplorerControls } from '../components/explorer-controls.js';
import {
  ErrorCard,
  LoadingNote,
  NoMatch,
  PartialNote,
  parseSort,
  sortableOf,
} from '../components/explorer-states.js';
import { downloadBlob, type ExportFormat, exportFileName, exportLogs } from '../components/export.js';
import { FacetPanel } from '../components/facet-panel.js';
import { withToken } from '../components/filter-tokens.js';
import { GroupTable } from '../components/group-table.js';
import { HistogramCard, SEVERITY_SERIES } from '../components/histogram-card.js';
import { LogList } from '../components/log-list.js';
import { ResultsTable, type SortState } from '../components/results-table.js';
import type { DataSource } from '../data/data-source.js';
import type { LogMode, LogQuery, LogRef, LogRow, LogTraceRow, PatternRow } from '../data/log-query.js';
import { PageChrome } from '../shell/page-chrome.js';
import { PageOptionNotice } from '../shell/page-option-notice.js';
import {
  PAGE_OPTIONS,
  type PageMode,
  type PageView,
  resolvePageMode,
  resolvePageView,
} from '../state/page-options.js';
import { useSelection, useSelectionStore } from '../state/selection-context.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { useTheme } from '../theme/theme-provider.js';
import { TracePanel } from '../traces/trace-panel.js';
import { cssTokenReader, GROUPED_VIEWS, resolveCssVars } from '../traces/views.js';
import { LOG_COLUMNS_UI, LOG_TRACE_COLUMNS_UI } from './columns.js';
import { LogPanel } from './log-panel.js';
import { PATTERN_COLUMNS_UI, PatternsTable } from './patterns-table.js';
import { useLogQuery } from './use-log-query.js';
import { LOG_VIEW_BUILDERS, type LogChartView } from './views.js';

const LOGS = PAGE_OPTIONS.logs;
const DEFAULT_MODE = LOGS.modes[0];

/** Per mode: the "Group into" label, the plural noun, the sortable columns and the default sort. */
const MODES: Record<LogMode, { label: string; noun: string; sortable: readonly string[]; sort: SortState }> =
  {
    logs: {
      label: 'Logs',
      noun: 'logs',
      sortable: sortableOf(LOG_COLUMNS_UI),
      // Newest first.
      sort: { column: 'time', dir: 'desc' },
    },
    patterns: {
      label: 'Patterns',
      noun: 'patterns',
      sortable: sortableOf(PATTERN_COLUMNS_UI),
      sort: { column: 'count', dir: 'desc' },
    },
    traces: {
      label: 'Traces',
      noun: 'traces',
      sortable: sortableOf(LOG_TRACE_COLUMNS_UI),
      sort: { column: 'first', dir: 'desc' },
    },
  };

const VIEW_LABEL: Record<PageView<'logs'>, string> = {
  list: 'List',
  timeseries: 'Timeseries',
  toplist: 'Top list',
  bar: 'Bar',
  table: 'Table',
  treemap: 'Treemap',
  pie: 'Pie',
  scatter: 'Scatter',
};

const BODY_PATH = 'log.body.string';
/** Unprefixed, as the trace panel's Logs tab writes it: compiles in span and log_record contexts, so `g t` carries it. */
const TRACE_ID_PATH = 'trace_id.string';
const CORE_FACET_KEYS: ReadonlySet<string> = new Set(DEFAULT_LOG_FACETS.map((f) => f.key));

export function ZeroLogs({ manifest }: { manifest: Manifest }): JSX.Element {
  return (
    <section className="max-w-xl rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-base font-semibold">This report has no logs</h2>
      <p className="mt-1 text-sm text-ink-2">
        It does hold <span className="font-mono tabular-nums">{manifest.totals.spans}</span> spans and{' '}
        <span className="font-mono tabular-nums">{manifest.totals.metrics}</span> metric data points.
      </p>
    </section>
  );
}

/** The notices for a `mode` or `view` in the URL that Logs does not offer; shown with or without logs. */
function OptionNotices(): JSX.Element {
  const sel = useSelection((s) => s);
  const { invalid: invalidMode } = resolvePageMode('logs', sel.mode);
  const { invalid: invalidView } = resolvePageView('logs', sel.view);
  return (
    <>
      <PageOptionNotice message={invalidMode} onReset={() => sel.setMode(null)} />
      <PageOptionNotice message={invalidView} onReset={() => sel.setView('list')} />
    </>
  );
}

/** Mockup 03, screen 1: Group into / View controls, severity histogram, facets left and results right. */
export function LogsExplorer(props: { dataSource: DataSource }): JSX.Element {
  const { manifest } = props.dataSource;
  if (manifest.totals.logs === 0) {
    return (
      <PageChrome title="Logs" signal="log" manifest={manifest}>
        <div className="flex flex-col gap-4">
          <OptionNotices />
          <ZeroLogs manifest={manifest} />
        </div>
      </PageChrome>
    );
  }
  return <ExplorerBody dataSource={props.dataSource} />;
}

function ExplorerBody(props: { dataSource: DataSource }): JSX.Element {
  const { dataSource } = props;
  const manifest = dataSource.manifest;
  const sel = useSelection((s) => s);
  const store = useSelectionStore();
  const { mode } = resolvePageMode('logs', sel.mode);
  const { view } = resolvePageView('logs', sel.view);
  const { resolved } = useTheme();
  const colors = useColorAssigner();
  const epoch = useMemo(() => parseUnixNanos(manifest.epochUnixNano, 'manifest.epochUnixNano'), [manifest]);
  const [extraColumns, setExtraColumns] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);
  const listCap = manifest.config.viewer.listCap;

  const sort = parseSort(sel.sort, MODES[mode].sortable, MODES[mode].sort);
  const query = useMemo<LogQuery>(
    () => ({
      condition: sel.condition,
      text: sel.text,
      window: sel.window,
      mode,
      sort: { column: sort.column, dir: sort.dir },
      limit: listCap,
      scanAll: false,
    }),
    [sel.condition, sel.text, sel.window, mode, sort.column, sort.dir, listCap],
  );
  const { state, scanAll } = useLogQuery(dataSource, query);
  const result = state.status === 'ready' ? state.result : state.status === 'loading' ? state.previous : null;
  const noun = MODES[mode].noun;

  const fail = (title: string, e: unknown): void =>
    setActionError({ title, message: e instanceof Error ? e.message : String(e) });

  const clearFilters = (): void => {
    sel.clear('condition');
    sel.clear('text');
    sel.clear('window');
  };
  const onSort = (s: SortState): void => sel.setSort(`${s.column}:${s.dir}`);

  /** A pattern becomes an editable `IsMatch` token on the body, and the list shows its logs. */
  const onPatternClick = (row: PatternRow): void => {
    try {
      sel.setCondition(withToken(sel.condition, { key: BODY_PATH, op: 'matches', value: row.regex }));
      sel.setMode(null);
      setActionError(null);
    } catch (e) {
      fail('The pattern could not be added to the filter', e);
    }
  };

  /** A trace with spans opens on its Logs tab; one without spans (logs only) filters the list on its id. */
  const onTraceClick = (row: LogTraceRow): void => {
    dataSource.hasTrace(row.traceId).then(
      (spans) => {
        setActionError(null);
        // The filter may have changed while the lookup ran: read the selection as it is now, not as rendered.
        const now = store.getState();
        if (spans) {
          now.selectTrace(row.traceId);
          now.setTab('trace', 'logs');
        } else {
          now.setCondition(withToken(now.condition, { key: TRACE_ID_PATH, op: '==', value: row.traceId }));
          now.setMode(null);
        }
      },
      (e: unknown) => fail('The trace could not be opened', e),
    );
  };

  const runExport = (format: ExportFormat): void => {
    try {
      setActionError(null);
      // Only a finished query is exported; the previous result shown while loading is stale.
      if (state.status !== 'ready') {
        throw new Error(
          state.status === 'loading'
            ? 'Export is unavailable while a query is running. Try again when it finishes.'
            : `Export is unavailable because the last query failed: ${state.message}`,
        );
      }
      const r = state.result;
      if (r.mode !== 'logs') throw new Error('Export lists logs; switch Group into back to Logs.');
      downloadBlob(exportLogs(r.rows, format, epoch), exportFileName('logs', r.rows.length, r.total, format));
    } catch (e) {
      fail('The export failed', e);
    }
  };
  const exportItems =
    mode === 'logs'
      ? [
          { label: 'Export CSV', onSelect: () => runExport('csv') },
          { label: 'Export JSON', onSelect: () => runExport('json') },
          { label: 'Export OTLP JSON', onSelect: () => runExport('otlp-json') },
        ]
      : [];

  const grouped = GROUPED_VIEWS.has(view);
  const attributeKeys = useMemo(
    () =>
      (result?.facets.keys() ?? [])
        .filter((k) => !CORE_FACET_KEYS.has(k) && !extraColumns.includes(k))
        .sort(),
    [result, extraColumns],
  );

  const chartOption = useMemo(() => {
    if (result === null || view === 'list' || view === 'table') return null;
    if (view === 'scatter' && result.mode !== 'logs') return null;
    const chart: LogChartView = view;
    // `resolved` re-reads the theme tokens when light/dark changes.
    void resolved;
    return resolveCssVars(
      LOG_VIEW_BUILDERS[chart](result, { groupBy: sel.groupBy, colors, listCap }),
      cssTokenReader(),
    );
  }, [result, view, sel.groupBy, colors, listCap, resolved]);

  // Distinct traces in result order: what j/k step through while the trace panel is open.
  const traceIds = useMemo<readonly TraceId[]>(() => {
    if (result === null) return [];
    if (result.mode === 'traces') return result.rows.map((r) => r.traceId);
    if (result.mode === 'logs') return [...new Set(result.rows.flatMap((r) => r.log.traceId ?? []))];
    return [];
  }, [result]);

  // The visible rows' refs in order: what j/k step through while the log panel is open.
  const logRefs = useMemo<readonly LogRef[]>(
    () => (result?.mode === 'logs' ? result.rows.map((r) => r.ref) : []),
    [result],
  );

  const results = (): JSX.Element | null => {
    if (result === null) return null;
    if (result.total === 0) return <NoMatch noun={noun} onClear={clearFilters} />;
    if (view === 'scatter' && result.mode !== 'logs')
      return (
        <p className="rounded-card border border-hairline bg-surface p-3 text-sm text-muted">
          Scatter plots individual logs; switch Group into back to Logs.
        </p>
      );
    if (chartOption !== null) {
      return (
        <div className="rounded-card border border-hairline bg-surface p-3">
          <Chart
            option={chartOption}
            height={320}
            ariaLabel={`${VIEW_LABEL[view]} of ${result.matched} logs`}
          />
        </div>
      );
    }
    if (view === 'table')
      return <GroupTable result={result} groupBy={sel.groupBy} colors={colors} noun="Logs" />;
    const moveEnabled = sel.logRef === null && sel.traceId === null;
    switch (result.mode) {
      case 'logs':
        return (
          <div className="flex flex-col gap-2">
            <ColumnPicker keys={attributeKeys} chosen={extraColumns} onChange={setExtraColumns} />
            <LogList
              rows={result.rows}
              sort={sort}
              onSort={onSort}
              onRowClick={(r: LogRow) => sel.selectLog(r.ref)}
              selectedRef={sel.logRef}
              epoch={epoch}
              extraColumns={extraColumns}
              moveEnabled={moveEnabled}
              hasTrace={dataSource.hasTrace}
            />
          </div>
        );
      case 'patterns':
        return (
          <div className="flex flex-col gap-2">
            {result.unclustered > 0 && (
              <p className="text-xs text-muted">
                <span className="font-mono tabular-nums">{result.unclustered}</span> matched logs are in no
                pattern (the cluster limit was reached)
              </p>
            )}
            <PatternsTable
              rows={result.rows}
              sort={sort}
              onSort={onSort}
              onRowClick={onPatternClick}
              epoch={epoch}
              moveEnabled={moveEnabled}
            />
          </div>
        );
      case 'traces':
        return (
          <ResultsTable
            rows={result.rows}
            columns={LOG_TRACE_COLUMNS_UI}
            rowId={(r) => r.traceId}
            sort={sort}
            onSort={onSort}
            onRowClick={onTraceClick}
            moveEnabled={moveEnabled}
            selectedId={sel.traceId}
            epoch={epoch}
            colors={colors}
          />
        );
      default: {
        const never: never = result;
        throw new Error(`unhandled log result ${JSON.stringify(never)}`);
      }
    }
  };

  return (
    <PageChrome title="Logs" signal="log" manifest={manifest} exportItems={exportItems}>
      <div className="flex flex-col gap-4">
        <OptionNotices />
        <ExplorerControls<PageMode<'logs'>, PageView<'logs'>>
          modeLegend="Group into"
          modePrefix="Group into"
          modes={LOGS.modes}
          mode={mode}
          modeLabel={(m) => MODES[m].label}
          onMode={(m) => sel.setMode(m === DEFAULT_MODE ? null : m)}
          views={LOGS.views}
          view={view}
          viewLabel={(v) => VIEW_LABEL[v]}
          onView={sel.setView}
          groupBy={sel.groupBy}
          onGroupBy={(k) => (k === null ? sel.clear('groupBy') : sel.setGroupBy(k))}
          facetKeys={result?.facets.keys() ?? []}
          grouped={grouped}
          groupByTitle={`Not used by the ${VIEW_LABEL[view]} view`}
        >
          {result !== null && (
            <output className="ml-auto font-mono text-xs tabular-nums text-muted">
              {result.total} {noun}
              {result.total > result.rows.length ? ` · showing ${result.rows.length}` : ''}
            </output>
          )}
        </ExplorerControls>
        {result !== null && <PartialNote partial={result.partial} onScanAll={scanAll} />}
        {state.status === 'loading' && <LoadingNote progress={state.progress} />}
        {actionError !== null && <ErrorCard title={actionError.title} message={actionError.message} />}
        {state.status === 'error' && <ErrorCard title="The query could not run" message={state.message} />}
        {result !== null && (
          <div
            aria-busy={state.status === 'loading'}
            className={`flex flex-col gap-4 ${state.status === 'loading' ? 'opacity-60' : ''}`}
          >
            <HistogramCard
              buckets={result.buckets}
              series={SEVERITY_SERIES}
              title={`${result.matched} logs by severity`}
              {...(manifest.range === null ? {} : { rangeEnd: manifest.range.end })}
            />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
              <div className="min-w-0">
                <FacetPanel signal="log" facets={result.facets} />
              </div>
              <div className="min-w-0">{results()}</div>
            </div>
          </div>
        )}
      </div>
      {sel.logRef !== null && (
        <LogPanel
          dataSource={dataSource}
          logRef={sel.logRef}
          logRefs={logRefs}
          onClose={() => sel.clear('logRef')}
        />
      )}
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
