import { type JSX, useCallback, useEffect, useMemo, useState } from 'react';
import type { Manifest } from '../../format/manifest.js';
import { MAX_METRIC_QUERIES, type MetricPageState } from '../../query/metric-query.js';
import type { MetricCatalog, MetricEntry } from '../../rollups/metric-catalog.js';
import { ErrorCard, LoadingNote, PILL } from '../components/explorer-states.js';
import { downloadBlob } from '../components/export.js';
import { type ChartPick, MetricChartCard } from '../components/metric-chart-card.js';
import { copyWidgetItem } from '../dashboards/copy-widget.js';
import type { DataSource } from '../data/data-source.js';
import { defaultShow, kindOf, type MetricQuery, resolveMetric, SHOW_BY_KIND } from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { useGoTo } from '../shell/go-to.js';
import { PageChrome, useClipboardCopy } from '../shell/page-chrome.js';
import { defaultMetricState } from '../state/metric-state.js';
import { useSelection, useSelectionStore } from '../state/selection-context.js';
import { useKeyedAsync } from '../state/use-keyed-async.js';
import { useColorAssigner } from '../theme/colors-context.js';
import { OTHER_INDEX } from '../theme/palette.js';
import { exemplarTraceLookup, openChartPick } from './chart-pick.js';
import { DisplayBar } from './display-bar.js';
import { exportMetricCsv, exportMetricJson } from './export.js';
import { buildPlots, formulaPrefix, layoutCharts, queryPrefix } from './plots.js';
import { FormulaRow, QueryRow, type Resolution } from './query-row.js';
import { useMetricQueries } from './use-metric-query.js';

const QUERY_IDS = 'abcdefghijklmnopqrstuvwxyz'.split('');
/** Card widths are measured in steps of this many px, so a resize re-runs the queries only now and then. */
const WIDTH_STEP_PX = 100;

const loadCatalog = (ds: DataSource): Promise<MetricCatalog> => ds.metricCatalog();

function seriesToken(index: number): string {
  return index >= OTHER_INDEX ? '--oh-series-other' : `--oh-series-${index + 1}`;
}

function ZeroMetrics({ manifest }: { manifest: Manifest }): JSX.Element {
  return (
    <section className="max-w-xl rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-base font-semibold">This report has no metrics</h2>
      <p className="mt-1 text-sm text-ink-2">
        It does hold <span className="font-mono tabular-nums">{manifest.totals.spans}</span> spans and{' '}
        <span className="font-mono tabular-nums">{manifest.totals.logs}</span> logs.
      </p>
    </section>
  );
}

/** Mockup 04, screen 1: query rows, formulas, the display bar and the chart cards. */
export function MetricsExplorer(props: { dataSource: DataSource }): JSX.Element {
  const { manifest } = props.dataSource;
  if (manifest.totals.metrics === 0 || manifest.range === null) {
    return (
      <PageChrome title="Metrics" manifest={manifest}>
        <ZeroMetrics manifest={manifest} />
      </PageChrome>
    );
  }
  return <ExplorerBody dataSource={props.dataSource} range={manifest.range} />;
}

function ExplorerBody(props: { dataSource: DataSource; range: TimeWindow }): JSX.Element {
  const { dataSource } = props;
  const manifest = dataSource.manifest;
  const sel = useSelection((s) => s);
  const store = useSelectionStore();
  const goTo = useGoTo();
  const colors = useColorAssigner();
  const timeWindow = sel.window ?? props.range;
  const state = useMemo(() => sel.metrics ?? defaultMetricState(null), [sel.metrics]);
  const catalogState = useKeyedAsync(dataSource, loadCatalog);
  const catalog = catalogState.status === 'ready' ? catalogState.value : null;
  const entries = useMemo(() => catalog?.entries() ?? [], [catalog]);
  const [widthPx, setWidthPx] = useState<number | null>(null);
  const run = useMetricQueries(dataSource, state, timeWindow, widthPx);
  const [actionError, setActionError] = useState<{ title: string; message: string } | null>(null);

  const fail = useCallback(
    (title: string, e: unknown): void =>
      setActionError({ title, message: e instanceof Error ? e.message : String(e) }),
    [],
  );
  // Edits read the state as it is now, not as rendered: an async metric load may have landed in between.
  const update = useCallback(
    (fn: (s: MetricPageState) => MetricPageState): void => {
      const now = store.getState();
      now.setMetrics(fn(now.metrics ?? defaultMetricState(null)));
    },
    [store],
  );

  /** Points the matching queries at `entry` with its default show (a summary's highest quantile, from its data). */
  const applyEntry = useCallback(
    (match: (q: MetricQuery) => boolean, entry: MetricEntry): void => {
      dataSource.metric(entry.id).then(
        (m) => {
          const show = defaultShow(m);
          // Only a name with several definitions needs the kind and unit to pick one.
          const kind = entry.conflicting ? entry.type : null;
          const unit = entry.conflicting ? entry.unit : null;
          update((s) => ({
            ...s,
            queries: s.queries.map((q) => (match(q) ? { ...q, metric: entry.name, kind, unit, show } : q)),
          }));
          setActionError(null);
        },
        (e: unknown) => fail('The metric could not be loaded', e),
      );
    },
    [dataSource, update, fail],
  );

  // A pending query (empty URL, `+ Query`, a carried `where`) gets the first catalog metric.
  const first = entries[0];
  const hasPending = state.queries.some((q) => q.metric === '');
  useEffect(() => {
    if (first !== undefined && hasPending) applyEntry((q) => q.metric === '', first);
  }, [first, hasPending, applyEntry]);

  const resourceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of catalog?.resources() ?? []) for (const k of r.attributes.keys()) keys.add(k);
    return [...keys].sort();
  }, [catalog]);

  const { results, entries: resolved } = run;
  const plots = useMemo(() => buildPlots(state, { results, entries: resolved }), [state, results, resolved]);
  const { display, histogramDisplay, mixedUnits, histogramVisible, cards } = layoutCharts(plots, state);

  const queryLabels = useMemo(
    () =>
      Object.fromEntries([
        ...state.queries.map((q) => [q.id, q.alias ?? q.id]),
        ...state.formulas.map((f) => [f.id, f.alias ?? f.id]),
      ]),
    [state],
  );

  const hasTrace = useMemo(() => exemplarTraceLookup(dataSource), [dataSource]);

  const onPick = (pick: ChartPick): void => {
    try {
      setActionError(null);
      openChartPick(pick, {
        goTo,
        queryOf: (id) => state.queries.find((x) => x.id === id),
        zoom: (w) => sel.setWindow(w),
      });
    } catch (e) {
      fail('The link could not be opened', e);
    }
  };

  const runExport = (format: 'csv' | 'json'): void => {
    try {
      setActionError(null);
      if (run.loading)
        throw new Error('Export is unavailable while a query is running. Try again when it finishes.');
      const results = plots.map((p) => p.result);
      const blob =
        format === 'csv'
          ? new Blob([exportMetricCsv(results)], { type: 'text/csv;charset=utf-8' })
          : new Blob([exportMetricJson(results)], { type: 'application/json' });
      downloadBlob(blob, `metrics.${format}`);
    } catch (e) {
      fail('The export failed', e);
    }
  };
  const widgetCopy = useClipboardCopy({ title: 'Copy as dashboard widget', label: 'Widget YAML' });
  const exportItems = [
    { label: 'Export CSV', onSelect: () => runExport('csv') },
    { label: 'Export JSON', onSelect: () => runExport('json') },
    copyWidgetItem('metrics', { ...sel, metrics: state }, widgetCopy.copy),
  ];

  const ids = new Set(state.queries.map((q) => q.id));
  const nextId = QUERY_IDS.find((c) => !ids.has(c));
  const canAddQuery = nextId !== undefined && state.queries.length < MAX_METRIC_QUERIES;
  const addQuery = (): void => {
    if (nextId === undefined) return;
    const pending = defaultMetricState(null).queries.map((q) => ({ ...q, id: nextId }));
    update((s) => ({ ...s, queries: [...s.queries, ...pending] }));
  };
  const addFormula = (): void =>
    update((s) => {
      const n = Math.max(0, ...s.formulas.map((f) => Number(f.id.slice(1)))) + 1;
      const expr = s.queries[0]?.id ?? 'a';
      return { ...s, formulas: [...s.formulas, { id: `f${n}`, expr, alias: null, hidden: false }] };
    });

  const measure = useCallback((el: HTMLDivElement | null): (() => void) | undefined => {
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => {
      if (e !== undefined)
        setWidthPx(Math.max(WIDTH_STEP_PX, Math.round(e.contentRect.width / WIDTH_STEP_PX) * WIDTH_STEP_PX));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resolution = (q: MetricQuery): Resolution =>
    catalog === null || q.metric === '' ? null : resolveMetric(catalog, q);
  const byOptions = (q: MetricQuery): string[] => {
    const e = run.entries.get(q.id);
    if (e === undefined) return [];
    return [
      ...e.attributeKeys.map((k) => `attributes[${JSON.stringify(k)}]`),
      ...resourceKeys.map((k) => `resource.attributes[${JSON.stringify(k)}]`),
    ];
  };
  const showOptionsOf = (q: MetricQuery): readonly string[] => {
    const known = run.showOptions.get(q.id);
    if (known !== undefined) return known;
    const r = resolution(q);
    return r !== null && 'entry' in r ? SHOW_BY_KIND[kindOf(r.entry)] : [];
  };
  const tokenOf = (label: string): string => seriesToken(colors.colorFor(label));
  const noData = !run.loading && plots.length > 0 && plots.every((p) => p.result.series.length === 0);

  return (
    <PageChrome title="Metrics" manifest={manifest} page="metrics" exportItems={exportItems}>
      <div className="flex flex-col gap-4">
        <section aria-label="Queries" className="rounded-card border border-hairline bg-surface px-3 py-2">
          <ul className="flex flex-col divide-y divide-dashed divide-hairline">
            {state.queries.map((q) => (
              <QueryRow
                key={q.id}
                query={q}
                colorToken={tokenOf(queryPrefix(q))}
                resolution={resolution(q)}
                entries={entries}
                showOptions={showOptionsOf(q)}
                byOptions={byOptions(q)}
                error={run.errors.get(q.id) ?? null}
                canRemove={state.queries.length > 1}
                onChange={(next) =>
                  update((s) => ({ ...s, queries: s.queries.map((x) => (x.id === q.id ? next : x)) }))
                }
                onPickMetric={(entry) => applyEntry((x) => x.id === q.id, entry)}
                onRemove={() => update((s) => ({ ...s, queries: s.queries.filter((x) => x.id !== q.id) }))}
              />
            ))}
            {state.formulas.map((f) => (
              <FormulaRow
                key={f.id}
                formula={f}
                colorToken={tokenOf(formulaPrefix(f))}
                error={run.errors.get(f.id) ?? null}
                onChange={(next) =>
                  update((s) => ({ ...s, formulas: s.formulas.map((x) => (x.id === f.id ? next : x)) }))
                }
                onRemove={() => update((s) => ({ ...s, formulas: s.formulas.filter((x) => x.id !== f.id) }))}
              />
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <button
              type="button"
              disabled={!canAddQuery}
              title={canAddQuery ? undefined : `at most ${MAX_METRIC_QUERIES} queries`}
              onClick={addQuery}
              className={`${PILL} border border-hairline text-accent disabled:opacity-40`}
            >
              + Query
            </button>
            <button
              type="button"
              onClick={addFormula}
              className={`${PILL} border border-hairline text-accent`}
            >
              + Formula
            </button>
            <span className="text-xs text-muted">
              e.g. <span className="font-mono">a / b</span>
            </span>
          </div>
        </section>
        <DisplayBar
          display={display}
          scale={state.scale}
          exemplars={state.exemplars}
          split={state.split}
          mixedUnits={mixedUnits}
          histogramVisible={histogramVisible}
          onDisplay={(d) => update((s) => ({ ...s, display: d }))}
          onScale={(scale) => update((s) => ({ ...s, scale }))}
          onExemplars={(exemplars) => update((s) => ({ ...s, exemplars }))}
          onSplit={(v) => update((s) => ({ ...s, split: v }))}
        />
        {(run.loading || catalogState.status === 'loading') && <LoadingNote progress={null} />}
        {actionError !== null && <ErrorCard title={actionError.title} message={actionError.message} />}
        {catalogState.status === 'error' && (
          <ErrorCard title="The metric catalog could not be loaded" message={catalogState.message} />
        )}
        {run.failure !== null && <ErrorCard title="The queries could not run" message={run.failure} />}
        {noData && (
          <section className="rounded-card border border-hairline bg-surface p-6">
            <h2 className="text-base font-semibold">No data points in this window</h2>
            <p className="mt-1 text-sm text-ink-2">The queries match no data points between these times.</p>
            {sel.window !== null && (
              <button
                type="button"
                onClick={() => sel.clear('window')}
                className={`${PILL} mt-3 bg-ink text-surface`}
              >
                Show the entire run
              </button>
            )}
          </section>
        )}
        <div
          ref={measure}
          aria-busy={run.loading}
          className={`flex flex-col gap-4 ${run.loading ? 'opacity-60' : ''}`}
        >
          {cards.map((card) => (
            <MetricChartCard
              key={card.map((p) => p.id).join('+')}
              title={card.map((p) => p.title).join(' / ')}
              subtitle={[...new Set(card.flatMap((p) => p.result.series.map((s) => s.unit)))].join(', ')}
              results={card.map((p) => p.result)}
              display={histogramDisplay && card[0]?.histogram !== true ? 'lines' : display}
              scale={state.scale}
              size="L"
              exemplars={state.exemplars}
              notes={[...new Set(card.flatMap((p) => p.result.notes))]}
              window={timeWindow}
              queryLabels={queryLabels}
              hasTrace={hasTrace}
              onPick={onPick}
              onZoom={(w) => sel.setWindow(w)}
            />
          ))}
        </div>
      </div>
      {widgetCopy.dialog}
    </PageChrome>
  );
}
