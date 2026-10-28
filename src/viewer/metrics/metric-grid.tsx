import { ChevronRight } from 'lucide-react';
import { type JSX, useCallback, useMemo, useState } from 'react';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { RelNanos, TraceId } from '../../model/ids.js';
import type { ResourceRecord } from '../../model/records.js';
import { MAX_METRIC_QUERIES, type MetricPageState } from '../../query/metric-query.js';
import type { MetricCatalog, MetricEntry } from '../../rollups/metric-catalog.js';
import { compareNamespaces, metricNamespace } from '../../semconv/metric-namespaces.js';
import { tokenValue } from '../components/attribute-filter.js';
import { ErrorCard, PILL } from '../components/explorer-states.js';
import { type ChartPick, MetricChartCard } from '../components/metric-chart-card.js';
import { METRIC_CHART_HEIGHT, type MetricSize } from '../components/metric-chart-option.js';
import type { DataSource } from '../data/data-source.js';
import { type LoadedMetric, resourceKey } from '../data/metric-load.js';
import {
  defaultShow,
  type MetricQuery,
  type MetricQueryResult,
  runMetricQuery,
} from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { useGoTo } from '../shell/go-to.js';
import { CONTROL } from '../shell/page-chrome.js';
import { formatWindow } from '../state/url-state.js';
import { useKeyedAsync } from '../state/use-keyed-async.js';
import { exemplarTraceLookup, openChartPick } from './chart-pick.js';

/** How far the grid looks on each side of the moment (or span) it was opened from. */
export const GRID_MARGIN_NS = 5 * 60 * 1_000_000_000;

/** The grid's window: `from` widened by `GRID_MARGIN_NS` on each side, clamped to the run's range. */
export function gridWindow(from: TimeWindow, range: TimeWindow | null): TimeWindow {
  const lo = range?.start ?? Number.MIN_SAFE_INTEGER;
  const hi = range?.end ?? Number.MAX_SAFE_INTEGER;
  const start = Math.min(Math.max(lo, from.start - GRID_MARGIN_NS), hi);
  const end = Math.max(Math.min(hi, from.end + GRID_MARGIN_NS), start);
  return { start, end };
}

export interface MetricGridOrigin {
  kind: 'log' | 'span' | 'trace' | 'dashboard';
  resources: readonly ResourceRecord[];
  /** The marker: the log's time, the span's or trace's start. */
  at: RelNanos | null;
  window: TimeWindow;
  /** Exemplars on this trace are highlighted. */
  traceId: TraceId | null;
}

/** What a grid embedded elsewhere adds: a selection window to shade, and "Select this trace" on exemplars. */
export interface MetricGridExtras {
  band?: TimeWindow | null;
  onSelectTrace?: (traceId: TraceId) => void;
}

const SIZES: readonly MetricSize[] = ['S', 'M', 'L'];
/** Charts per row at each size (md and up). */
const GRID_COLUMNS: Readonly<Record<MetricSize, string>> = {
  S: 'md:grid-cols-3',
  M: 'md:grid-cols-2',
  L: 'md:grid-cols-1',
};
/** Buckets per chart at each size: about one per two pixels of a card's width. */
const GRID_MAX_POINTS: Readonly<Record<MetricSize, number>> = { S: 120, M: 240, L: 480 };
/** Resource facts the header shows, in order. */
const HEADER_KEYS = ['service.name', 'host.name'] as const;
/** The legend text of the marker line; a dashboard has no marker. */
const MARKER_LABEL: Readonly<Record<MetricGridOrigin['kind'], string | null>> = {
  log: 'this log',
  span: 'this span',
  trace: 'trace start',
  dashboard: null,
};
const QUERY_IDS = 'abcdefghijklmnopqrstuvwxyz';
export const OTHER_LEFT_OUT =
  'partial: series beyond the cap are folded into "other", which spans resources and is left out here (see the Explorer)';
const SERVICE_PATH = 'resource.attributes["service.name"]';

const resourcePath = (key: string): string => `resource.attributes[${JSON.stringify(key)}]`;

/** OTTL literal for a scalar attribute value; undefined for values a filter cannot express. */
function literal(v: Parameters<typeof tokenValue>[0]): string | undefined {
  const t = tokenValue(v);
  if (t === undefined || t === null) return undefined;
  // An int beyond the safe range comes back as text, which would never equal the int.
  if (v.kind === 'int' && typeof t === 'string') return undefined;
  if (v.kind === 'double' && typeof t === 'string') return undefined;
  return typeof t === 'string' ? JSON.stringify(t) : String(t);
}

/** The OTTL equality per scalar attribute of `r`, keyed by attribute. */
function literalAttributes(r: ResourceRecord): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of r.attributes) {
    const lit = literal(v);
    if (lit !== undefined) out.set(k, lit);
  }
  return out;
}

/**
 * With several resources, one line per resource: `by` the service plus every attribute whose value differs between
 * them, so two resources of one service still draw apart (lines take the service color).
 */
export function resourceLines(resources: readonly ResourceRecord[]): string[] {
  if (resources.length < 2) return [];
  const keys = new Set(resources.flatMap((r) => [...r.attributes.keys()]));
  keys.delete('service.name');
  const differing = [...keys]
    .filter((k) => {
      const shown = resources.map((r) => {
        const v = r.attributes.get(k);
        return v === undefined ? null : anyValueToDisplay(v);
      });
      return new Set(shown).size > 1;
    })
    .sort();
  return [SERVICE_PATH, ...differing.map(resourcePath)];
}

/** `m` with only the series on one of `keys` (canonical `resourceKey`s): the grid charts exactly the origin's resources. */
export function seriesOnResources(m: LoadedMetric, keys: ReadonlySet<string>): LoadedMetric {
  return { ...m, series: m.series.filter((s) => s.resource !== null && keys.has(resourceKey(s.resource))) };
}

export interface ExplorerFilter extends Pick<MetricQuery, 'where' | 'by'> {
  /** Other resources the `where` also matches and cannot exclude (they differ only in non-literal attributes). */
  unexcluded: number;
}

/**
 * The Explorer link's filter, which has only OTTL to name resources: per origin resource, one equality per scalar
 * attribute, and for every other resource in `others` that those equalities also match, `== nil` on one of its extra
 * attributes. Several origin resources are `or`ed and drawn one line each (`resourceLines`).
 */
export function explorerFilter(
  resources: readonly ResourceRecord[],
  others: readonly ResourceRecord[],
): ExplorerFilter {
  const origin = new Set(resources.map(resourceKey));
  const rest = others.filter((o) => !origin.has(resourceKey(o)));
  let unexcluded = 0;
  const clauses = resources.map((r) => {
    const lits = literalAttributes(r);
    const parts = [...lits].map(([k, lit]) => `${resourcePath(k)} == ${lit}`);
    for (const o of rest) {
      const ol = literalAttributes(o);
      const matched = [...lits].every(([k, lit]) => ol.get(k) === lit);
      if (!matched) continue;
      const extra = [...o.attributes.keys()].filter((k) => !r.attributes.has(k)).sort()[0];
      if (extra === undefined) unexcluded++;
      else parts.push(`${resourcePath(extra)} == nil`);
    }
    return parts;
  });
  // A clause with no parts matches every resource, so the whole filter does.
  const where = clauses.some((c) => c.length === 0)
    ? null
    : clauses.length === 1
      ? (clauses[0] ?? []).join(' and ')
      : clauses.map((c) => `(${c.join(' and ')})`).join(' or ');
  return { where, by: resourceLines(resources), unexcluded };
}

function distinctResources(resources: readonly ResourceRecord[]): ResourceRecord[] {
  const seen = new Map<string, ResourceRecord>();
  for (const r of resources) {
    const k = resourceKey(r);
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

/** Whether any of `resources` has metric series; false while the lookup runs or after it failed. */
export function useHasMetrics(dataSource: DataSource, resources: readonly ResourceRecord[] | null): boolean {
  const load = useCallback(
    (rs: readonly ResourceRecord[]) => dataSource.metricsForResources(rs),
    [dataSource],
  );
  const state = useKeyedAsync(resources, load);
  return state.status === 'ready' && state.value.length > 0;
}

interface Group {
  namespace: string;
  entries: MetricEntry[];
}

const groupLabel = (g: Group): string => (g.namespace === 'other' ? 'other' : `${g.namespace}.*`);

function groupByNamespace(entries: readonly MetricEntry[]): Group[] {
  const by = new Map<string, MetricEntry[]>();
  for (const e of entries) {
    const ns = metricNamespace(e.name);
    by.set(ns, [...(by.get(ns) ?? []), e]);
  }
  return [...by]
    .sort(([a], [b]) => compareNamespaces(a, b))
    .map(([namespace, es]) => ({
      namespace,
      entries: [...es].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id)),
    }));
}

/** A query on one metric: `show` is filled in once the metric is loaded (`defaultShow`). */
function gridQuery(e: MetricEntry, filter: Pick<MetricQuery, 'where' | 'by'>, id: string): MetricQuery {
  return {
    id,
    metric: e.name,
    // Only a name with several definitions needs the kind and unit to pick one.
    kind: e.conflicting ? e.type : null,
    unit: e.conflicting ? e.unit : null,
    show: '',
    by: filter.by,
    where: filter.where,
    fn: [],
    alias: null,
    hidden: false,
  };
}

/** True once the element has scrolled into view; at once when `IntersectionObserver` is missing. */
function useInView(): [(el: HTMLElement | null) => (() => void) | undefined, boolean] {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const ref = useCallback(
    (el: HTMLElement | null): (() => void) | undefined => {
      if (el === null || seen) return undefined;
      const io = new IntersectionObserver((items) => {
        if (items.some((i) => i.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      });
      io.observe(el);
      return () => io.disconnect();
    },
    [seen],
  );
  return [ref, seen];
}

interface ChartKey {
  entry: MetricEntry;
  query: MetricQuery;
  resourceKeys: ReadonlySet<string>;
  window: TimeWindow;
  maxPoints: number;
}

interface ChartRun {
  query: MetricQuery;
  result: MetricQueryResult;
}

function GridChart(props: {
  dataSource: DataSource;
  entry: MetricEntry;
  /** The origin's resources (canonical keys): only their series are charted. */
  resourceKeys: ReadonlySet<string>;
  /** One line per resource (`resourceLines`). */
  by: string[];
  /** The filter the click menu's Traces/Logs links carry (`explorerFilter`). */
  linkWhere: string | null;
  window: TimeWindow;
  size: MetricSize;
  origin: MetricGridOrigin;
  hasTrace: (traceId: string) => Promise<boolean>;
  band: TimeWindow | null;
  onSelectTrace: ((traceId: TraceId) => void) | undefined;
  onPick(pick: ChartPick, query: MetricQuery): void;
  onZoom(w: TimeWindow): void;
}): JSX.Element {
  const { dataSource, entry, resourceKeys, by, window, size } = props;
  const [ref, inView] = useInView();
  const maxPoints = GRID_MAX_POINTS[size];
  const key = useMemo<ChartKey | null>(
    () =>
      inView
        ? { entry, query: gridQuery(entry, { where: null, by }, 'a'), resourceKeys, window, maxPoints }
        : null,
    [inView, entry, by, resourceKeys, window, maxPoints],
  );
  const load = useCallback(
    async (k: ChartKey, signal: AbortSignal): Promise<ChartRun> => {
      const m = await dataSource.metric(k.entry.id);
      signal.throwIfAborted();
      const query = { ...k.query, show: defaultShow(m) };
      const result = runMetricQuery(
        seriesOnResources(m, k.resourceKeys),
        query,
        k.window,
        k.maxPoints,
        signal,
      );
      // The cap-folded `other` series belongs to no single resource, so it cannot be charted here.
      if (m.series.some((x) => x.def.other)) result.notes.push(OTHER_LEFT_OUT);
      return { query, result };
    },
    [dataSource],
  );
  const run = useKeyedAsync(key, load);
  const height = METRIC_CHART_HEIGHT[size];
  if (run.status === 'ready') {
    const { query, result } = run.value;
    return (
      <MetricChartCard
        title={entry.name}
        subtitle={`${query.show} · ${entry.unit === '' ? '1' : entry.unit}`}
        results={[result]}
        display="lines"
        scale="linear"
        size={size}
        marker={props.origin.at}
        highlightTrace={props.origin.traceId}
        exemplars
        notes={result.notes}
        window={window}
        band={props.band}
        {...(props.onSelectTrace === undefined ? {} : { onSelectTrace: props.onSelectTrace })}
        hasTrace={props.hasTrace}
        onPick={(p) => props.onPick(p, { ...query, where: props.linkWhere })}
        onZoom={props.onZoom}
      />
    );
  }
  return (
    <section
      ref={ref}
      aria-label={entry.name}
      aria-busy={run.status === 'loading'}
      className="rounded-card border border-hairline bg-surface p-3"
    >
      <h3 className="truncate text-sm font-medium">{entry.name}</h3>
      {run.status === 'error' ? (
        <p role="alert" className="mt-1 font-mono text-xs break-words whitespace-pre-wrap text-critical">
          {run.message}
        </p>
      ) : (
        <div style={{ height }} className="mt-1 animate-pulse rounded-md bg-hairline/50" />
      )}
    </section>
  );
}

function ResourceFacts(props: { resources: readonly ResourceRecord[] }): JSX.Element {
  return (
    <>
      {HEADER_KEYS.map((k) => {
        const values = [
          ...new Set(
            props.resources.flatMap((r) => {
              const v = r.attributes.get(k);
              return v === undefined ? [] : [anyValueToDisplay(v)];
            }),
          ),
        ];
        if (values.length === 0) return null;
        return (
          <span
            key={k}
            className="inline-flex items-baseline gap-1 rounded-full border border-hairline px-2 py-0.5"
          >
            <span className="font-mono text-xs text-ink-2">{k}</span>
            <span aria-hidden className="text-muted">
              =
            </span>
            <span className="font-mono text-xs">{values.join(', ')}</span>
          </span>
        );
      })}
    </>
  );
}

const SEG = 'rounded-full px-2 py-0.5 text-xs';

const loadCatalog = (ds: DataSource): Promise<MetricCatalog> => ds.metricCatalog();

/**
 * Mockup 04, screen 3: every metric of the origin's resources as Explorer chart cards, grouped by semconv namespace
 * (only the first group starts expanded; charts render as they scroll into view), over the origin's moment ± 5 min.
 */
export function MetricGrid(
  props: { dataSource: DataSource; origin: MetricGridOrigin } & MetricGridExtras,
): JSX.Element {
  const { dataSource, origin } = props;
  const goTo = useGoTo();
  const resources = useMemo(() => distinctResources(origin.resources), [origin.resources]);
  const resourceKeys = useMemo(() => new Set(resources.map(resourceKey)), [resources]);
  const by = useMemo(() => resourceLines(resources), [resources]);
  const catalogState = useKeyedAsync(dataSource, loadCatalog);
  const loadEntries = useCallback(
    (rs: readonly ResourceRecord[]) => dataSource.metricsForResources(rs),
    [dataSource],
  );
  const listed = useKeyedAsync(resources, loadEntries);
  const groups = useMemo(() => (listed.status === 'ready' ? groupByNamespace(listed.value) : []), [listed]);
  // Every resource that reports one of the grid's metrics: the link's `where` must not match the others.
  const linkFilter = useMemo((): ExplorerFilter | null => {
    if (catalogState.status !== 'ready' || listed.status !== 'ready') return null;
    const all = catalogState.value.resources();
    const refs = new Set(listed.value.flatMap((e) => e.resources));
    return explorerFilter(
      resources,
      [...refs].flatMap((r) => (all[r] === undefined ? [] : [all[r]])),
    );
  }, [catalogState, listed, resources]);
  const [size, setSize] = useState<MetricSize>('S');
  const [expandedState, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasTrace = useMemo(() => exemplarTraceLookup(dataSource), [dataSource]);
  const shown = zoom ?? origin.window;

  const firstNamespace = groups[0]?.namespace;
  const expanded = expandedState ?? new Set(firstNamespace === undefined ? [] : [firstNamespace]);
  const toggle = (ns: string): void => {
    const next = new Set(expanded);
    if (next.has(ns)) next.delete(ns);
    else next.add(ns);
    setExpanded(next);
  };

  const fail = (e: unknown): void => setActionError(e instanceof Error ? e.message : String(e));

  const onPick = (pick: ChartPick, query: MetricQuery): void => {
    try {
      setActionError(null);
      openChartPick(pick, { goTo, queryOf: () => query, zoom: setZoom });
    } catch (e) {
      fail(e);
    }
  };

  const linkGroup = groups.find((g) => expanded.has(g.namespace)) ?? groups[0];
  const linkCount = linkGroup?.entries.length ?? 0;

  const openInExplorer = (): void => {
    if (linkGroup === undefined || linkFilter === null) return;
    const filter = linkFilter;
    const entries = linkGroup.entries.slice(0, MAX_METRIC_QUERIES);
    setActionError(null);
    Promise.all(entries.map((e) => dataSource.metric(e.id))).then(
      (loaded) => {
        try {
          const queries = entries.map((e, i) => ({
            ...gridQuery(e, filter, QUERY_IDS.charAt(i)),
            show: loaded[i] === undefined ? '' : defaultShow(loaded[i]),
          }));
          const m: MetricPageState = {
            queries,
            formulas: [],
            display: 'lines',
            scale: 'linear',
            split: true,
            exemplars: true,
          };
          // A URL window cannot start before the epoch (`t` is unsigned).
          const t = formatWindow({ start: Math.max(0, shown.start), end: Math.max(0, shown.end) });
          goTo('metrics', '/metrics', { m, t, q: null });
        } catch (e) {
          fail(e);
        }
      },
      (e: unknown) => fail(e),
    );
  };

  return (
    <div data-testid="metric-grid" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-sm font-semibold">
          Metrics from the same {resources.length > 1 ? 'resources' : 'resource'}
        </h3>
        <ResourceFacts resources={resources} />
        {origin.kind !== 'dashboard' && <span className="text-xs text-muted">± 5 min</span>}
        {origin.at !== null && MARKER_LABEL[origin.kind] !== null && (
          <span className="text-xs text-muted">
            <span aria-hidden>┆ </span>
            {MARKER_LABEL[origin.kind]}
          </span>
        )}
        {zoom !== null && (
          <button type="button" className={`${PILL} text-xs hover:bg-hairline`} onClick={() => setZoom(null)}>
            Reset zoom
          </button>
        )}
        <span className="ml-auto text-xs text-muted">Size</span>
        <fieldset className="flex items-center gap-1 rounded-full border border-hairline p-0.5">
          <legend className="sr-only">Chart size</legend>
          {SIZES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={size === s}
              onClick={() => setSize(s)}
              className={`${SEG} ${size === s ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hairline'}`}
            >
              {s}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className={CONTROL}
          disabled={linkGroup === undefined || linkFilter === null}
          onClick={openInExplorer}
        >
          Open in Explorer →
        </button>
      </div>
      {linkGroup !== undefined && linkCount > MAX_METRIC_QUERIES && (
        <p role="note" className="text-xs text-muted">
          Open in Explorer takes the first {MAX_METRIC_QUERIES} of the {linkCount} {groupLabel(linkGroup)}{' '}
          metrics (the Explorer holds at most {MAX_METRIC_QUERIES} queries).
        </p>
      )}
      {linkFilter !== null && linkFilter.unexcluded > 0 && (
        <p role="note" className="text-xs text-muted">
          In the Explorer the filter also matches {linkFilter.unexcluded} other{' '}
          {linkFilter.unexcluded === 1 ? 'resource' : 'resources'} that differ from this one only in
          attributes a filter cannot compare; the charts here show only{' '}
          {resources.length > 1 ? 'these resources' : 'this resource'}.
        </p>
      )}
      {actionError !== null && <ErrorCard title="The link could not be opened" message={actionError} />}
      {listed.status === 'loading' && (
        <p role="status" className="text-sm text-muted">
          Loading metrics…
        </p>
      )}
      {listed.status === 'error' && (
        <ErrorCard title="The metrics could not be listed" message={listed.message} />
      )}
      {groups.map((g) => {
        const open = expanded.has(g.namespace);
        return (
          <section key={g.namespace} aria-label={`${g.namespace} metrics`} className="flex flex-col gap-2">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(g.namespace)}
              className="flex items-center gap-2 self-start rounded-full px-2 py-0.5 text-sm font-semibold hover:bg-hairline"
            >
              <ChevronRight size={14} aria-hidden className={open ? 'rotate-90' : ''} />
              {groupLabel(g)}
              <span className="font-mono text-xs font-normal text-muted">
                {g.entries.length} {g.entries.length === 1 ? 'chart' : 'charts'}
              </span>
            </button>
            {open && (
              <div className={`grid grid-cols-1 gap-3 ${GRID_COLUMNS[size]}`}>
                {g.entries.map((e) => (
                  <GridChart
                    key={e.id}
                    dataSource={dataSource}
                    entry={e}
                    resourceKeys={resourceKeys}
                    by={by}
                    linkWhere={linkFilter?.where ?? null}
                    window={shown}
                    size={size}
                    origin={origin}
                    hasTrace={hasTrace}
                    band={props.band ?? null}
                    onSelectTrace={props.onSelectTrace}
                    onPick={onPick}
                    onZoom={setZoom}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
