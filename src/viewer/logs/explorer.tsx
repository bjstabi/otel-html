import { type JSX, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { parseUnixNanos, type TraceId } from '../../model/ids.js';
import { DEFAULT_LOG_FACETS } from '../../rollups/log-rollups.js';
import { Chart } from '../components/chart.js';
import { ColumnPicker } from '../components/column-picker.js';
import {
  ErrorCard,
  LoadingNote,
  NoMatch,
  PartialNote,
  PILL,
  parseSort,
  sortableOf,
} from '../components/explorer-states.js';
import { downloadBlob, type ExportFormat, exportFileName, exportLogs } from '../components/export.js';
import { FacetPanel } from '../components/facet-panel.js';
import { type FilterToken, ottlToTokens, tokensToOttl } from '../components/filter-tokens.js';
import { GroupTable } from '../components/group-table.js';
import { HistogramCard, SEVERITY_SERIES } from '../components/histogram-card.js';
import { LogList } from '../components/log-list.js';
import { ResultsTable, type SortState } from '../components/results-table.js';
import type { DataSource } from '../data/data-source.js';
import type { LogMode, LogQuery, LogRow, LogTraceRow, PatternRow } from '../data/log-query.js';
import { PageChrome } from '../shell/page-chrome.js';
import { PageOptionNotice } from '../shell/page-option-notice.js';
import { PAGE_OPTIONS, type PageView, resolvePageMode, resolvePageView } from '../state/page-options.js';
import { useSelection } from '../state/selection-context.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { useTheme } from '../theme/theme-provider.js';
import { TracePanel } from '../traces/trace-panel.js';
import { cssTokenReader, GROUPED_VIEWS, resolveCssVars } from '../traces/views.js';
import { LOG_COLUMNS_UI, LOG_TRACE_COLUMNS_UI } from './columns.js';
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

const FIELD = 'rounded-full border border-hairline bg-surface px-3 py-1 text-sm';
const BODY_PATH = 'log.body.string';
const TRACE_ID_PATH = 'log.trace_id.string';
const CORE_FACET_KEYS: ReadonlySet<string> = new Set(DEFAULT_LOG_FACETS.map((f) => f.key));

/** `token` added to `condition`, replacing a token on the same key with the same operator. */
function withToken(condition: string | null, token: FilterToken): string | null {
  const tokens = condition === null ? [] : ottlToTokens(condition);
  // A condition the token model cannot hold (raw OTTL) is kept whole and and-ed with the token.
  if (tokens === null) return `(${condition}) and ${tokensToOttl([token])}`;
  return tokensToOttl([...tokens.filter((t) => !(t.key === token.key && t.op === token.op)), token]);
}

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

/** Mockup 03, screen 1: Group into / View controls, severity histogram, facets left and results right. */
export function LogsExplorer(props: { dataSource: DataSource }): JSX.Element {
  const { manifest } = props.dataSource;
  if (manifest.totals.logs === 0) {
    return (
      <PageChrome title="Logs" signal="log" manifest={manifest}>
        <ZeroLogs manifest={manifest} />
      </PageChrome>
    );
  }
  return <ExplorerBody dataSource={props.dataSource} />;
}

function ExplorerBody(props: { dataSource: DataSource }): JSX.Element {
  const { dataSource } = props;
  const manifest = dataSource.manifest;
  const sel = useSelection((s) => s);
  const { mode, invalid: invalidMode } = resolvePageMode('logs', sel.mode);
  const { view, invalid: invalidView } = resolvePageView('logs', sel.view);
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
        if (spans) {
          sel.selectTrace(row.traceId);
          sel.setTab('trace', 'logs');
        } else {
          sel.setCondition(withToken(sel.condition, { key: TRACE_ID_PATH, op: '==', value: row.traceId }));
          sel.setMode(null);
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
  const groupKeys = useMemo(() => {
    const keys = result?.facets.keys().sort() ?? [];
    return sel.groupBy !== null && !keys.includes(sel.groupBy) ? [sel.groupBy, ...keys] : keys;
  }, [result, sel.groupBy]);
  const attributeKeys = useMemo(
    () =>
      (result?.facets.keys() ?? [])
        .filter((k) => !CORE_FACET_KEYS.has(k) && !extraColumns.includes(k))
        .sort(),
    [result, extraColumns],
  );

  const chartOption = useMemo(() => {
    if (result === null || view === 'list' || view === 'table') return null;
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

  const results = (): JSX.Element | null => {
    if (result === null) return null;
    if (result.total === 0) return <NoMatch noun={noun} onClear={clearFilters} />;
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
    const moveEnabled = sel.traceId === null;
    switch (result.mode) {
      case 'logs':
        return (
          <div className="flex flex-col gap-2">
            <ColumnPicker
              keys={attributeKeys}
              chosen={extraColumns}
              onAdd={(k) => setExtraColumns([...extraColumns, k])}
              onRemove={(k) => setExtraColumns(extraColumns.filter((c) => c !== k))}
            />
            <LogList
              rows={result.rows}
              sort={sort}
              onSort={onSort}
              onRowClick={(r: LogRow) => sel.selectLog(r.ref)}
              selectedRef={sel.logRef}
              epoch={epoch}
              extraColumns={extraColumns}
              moveEnabled={moveEnabled}
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
        <PageOptionNotice message={invalidMode} onReset={() => sel.setMode(null)} />
        <PageOptionNotice message={invalidView} onReset={() => sel.setView('list')} />
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex items-center gap-1 rounded-full border border-hairline bg-surface p-0.5">
            <legend className="sr-only">Group into</legend>
            <span aria-hidden className="px-2 text-sm text-ink-2">
              Group into
            </span>
            {LOGS.modes.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                data-selected={mode === m ? 'true' : undefined}
                onClick={() => sel.setMode(m === DEFAULT_MODE ? null : m)}
                className={`${PILL} ${mode === m ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'}`}
              >
                {MODES[m].label}
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
              title={grouped ? undefined : `Not used by the ${VIEW_LABEL[view]} view`}
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
          <label className="flex items-center gap-2 text-sm text-ink-2">
            View
            <select
              aria-label="View"
              className={FIELD}
              value={view}
              onChange={(e) => {
                const next = LOGS.views.find((x) => x === e.target.value);
                if (next !== undefined) sel.setView(next);
              }}
            >
              {LOGS.views.map((v) => (
                <option key={v} value={v}>
                  {VIEW_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          {result !== null && (
            <output className="ml-auto font-mono text-xs tabular-nums text-muted">
              {result.total} {noun}
              {result.total > result.rows.length ? ` · showing ${result.rows.length}` : ''}
            </output>
          )}
        </div>
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
