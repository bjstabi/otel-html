import { ChevronRight } from 'lucide-react';
import { type JSX, useCallback, useMemo, useState } from 'react';
import { anyValueToDisplay } from '../../model/anyvalue.js';
import type { RelNanos, TraceId } from '../../model/ids.js';
import type { ResourceRecord } from '../../model/records.js';
import type { MetricEntry } from '../../rollups/metric-catalog.js';
import { compareNamespaces, metricNamespace } from '../../semconv/metric-namespaces.js';
import { tokenValue } from '../components/attribute-filter.js';
import { ErrorCard, PILL } from '../components/explorer-states.js';
import { type ChartPick, MetricChartCard } from '../components/metric-chart-card.js';
import { METRIC_CHART_HEIGHT, type MetricSize } from '../components/metric-chart-option.js';
import type { DataSource } from '../data/data-source.js';
import { resourceKey } from '../data/metric-load.js';
import {
  defaultShow,
  type MetricQuery,
  type MetricQueryResult,
  runMetricQuery,
} from '../data/metric-query.js';
import type { TimeWindow } from '../data/span-query.js';
import { useGoTo } from '../shell/go-to.js';
import { CONTROL } from '../shell/page-chrome.js';
import { MAX_METRIC_QUERIES, type MetricPageState } from '../state/metric-state.js';
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
  kind: 'log' | 'span' | 'trace';
  resources: readonly ResourceRecord[];
  /** The marker: the log's time, the span's or trace's start. */
  at: RelNanos | null;
  window: TimeWindow;
  /** Exemplars on this trace are highlighted. */
  traceId: TraceId | null;
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
const MARKER_LABEL: Readonly<Record<MetricGridOrigin['kind'], string>> = {
  log: 'this log',
  span: 'this span',
  trace: 'trace start',
};
const QUERY_IDS = 'abcdefghijklmnopqrstuvwxyz';
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

function resourceClause(r: ResourceRecord): string {
  const parts: string[] = [];
  for (const [k, v] of r.attributes) {
    const lit = literal(v);
    if (lit !== undefined) parts.push(`${resourcePath(k)} == ${lit}`);
  }
  // A resource with no filterable attribute: match series whose resource has no service either.
  return parts.length === 0 ? `${SERVICE_PATH} == nil` : parts.join(' and ');
}

/**
 * The series filter of the grid: a `where` with one clause per resource attribute (several resources are `or`ed), and
 * with several resources, `by` the service plus every attribute whose value differs between them, so each resource
 * draws its own line (colored by its service).
 */
export function resourceFilter(resources: readonly ResourceRecord[]): Pick<MetricQuery, 'where' | 'by'> {
  const [only] = resources;
  if (only === undefined) return { where: null, by: [] };
  if (resources.length === 1) return { where: resourceClause(only), by: [] };
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
  return {
    where: resources.map((r) => `(${resourceClause(r)})`).join(' or '),
    by: [SERVICE_PATH, ...differing.map(resourcePath)],
  };
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

/** The grid's query on one metric: `show` is filled in once the metric is loaded (`defaultShow`). */
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
  filter: Pick<MetricQuery, 'where' | 'by'>;
  window: TimeWindow;
  size: MetricSize;
  origin: MetricGridOrigin;
  hasTrace: (traceId: string) => Promise<boolean>;
  onPick(pick: ChartPick, query: MetricQuery): void;
  onZoom(w: TimeWindow): void;
}): JSX.Element {
  const { dataSource, entry, filter, window, size } = props;
  const [ref, inView] = useInView();
  const maxPoints = GRID_MAX_POINTS[size];
  const key = useMemo<ChartKey | null>(
    () => (inView ? { entry, query: gridQuery(entry, filter, 'a'), window, maxPoints } : null),
    [inView, entry, filter, window, maxPoints],
  );
  const load = useCallback(
    async (k: ChartKey, signal: AbortSignal): Promise<ChartRun> => {
      const m = await dataSource.metric(k.entry.id);
      signal.throwIfAborted();
      const query = { ...k.query, show: defaultShow(m) };
      return { query, result: runMetricQuery(m, query, k.window, k.maxPoints, signal) };
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
        hasTrace={props.hasTrace}
        onPick={(p) => props.onPick(p, query)}
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

/**
 * Mockup 04, screen 3: every metric of the origin's resources as Explorer chart cards, grouped by semconv namespace
 * (only the first group starts expanded; charts render as they scroll into view), over the origin's moment ± 5 min.
 */
export function MetricGrid(props: { dataSource: DataSource; origin: MetricGridOrigin }): JSX.Element {
  const { dataSource, origin } = props;
  const goTo = useGoTo();
  const resources = useMemo(() => distinctResources(origin.resources), [origin.resources]);
  const filter = useMemo(() => resourceFilter(resources), [resources]);
  const loadEntries = useCallback(
    (rs: readonly ResourceRecord[]) => dataSource.metricsForResources(rs),
    [dataSource],
  );
  const listed = useKeyedAsync(resources, loadEntries);
  const groups = useMemo(() => (listed.status === 'ready' ? groupByNamespace(listed.value) : []), [listed]);
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

  const openInExplorer = (): void => {
    const group = groups.find((g) => expanded.has(g.namespace)) ?? groups[0];
    if (group === undefined) return;
    const entries = group.entries.slice(0, MAX_METRIC_QUERIES);
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
        <span className="text-xs text-muted">± 5 min</span>
        {origin.at !== null && (
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
        <button type="button" className={CONTROL} disabled={groups.length === 0} onClick={openInExplorer}>
          Open in Explorer →
        </button>
      </div>
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
              {g.namespace === 'other' ? 'other' : `${g.namespace}.*`}
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
                    filter={filter}
                    window={shown}
                    size={size}
                    origin={origin}
                    hasTrace={hasTrace}
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
