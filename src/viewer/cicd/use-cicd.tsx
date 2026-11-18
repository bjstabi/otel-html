import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { Widget } from '../../dashboards/schema.js';
import { honours, PageShared, registerValuesSource, type WidgetScope } from '../dashboards/scope.js';
import type { CicdQuery, CicdRow } from '../data/cicd-query.js';
import type { DataSource } from '../data/data-source.js';
import type { TimeWindow } from '../data/time-window.js';
import { STATUS } from '../theme/palette.js';
import { narrowJobs, splitPeriods } from './derive.js';
import { CICD_BRANCH, CICD_JOB, CICD_RUNNER, CICD_TRIGGER } from './registrations.js';
import type { CiRun } from './runs.js';

const JOB_KEY = CICD_JOB;
const RUNNER_KEY = CICD_RUNNER;
/** The run-level keys the fetch itself is narrowed by; every other binding is applied to the jobs after it. */
const FETCH_KEYS = new Set([CICD_BRANCH, CICD_TRIGGER]);

type Entry =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly CicdRow[] }
  | { status: 'error'; error: Error };

const LOADING: Entry = { status: 'loading' };

/** The page's `cicd` fetches, one per distinct window, run-level bindings and pipeline; started only when a widget asks. */
class CicdStore {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<readonly CicdRow[]>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly dataSource: DataSource) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  get(key: string): Entry {
    return this.entries.get(key) ?? LOADING;
  }

  /** Starts the fetch for `key` unless it is under way or done. */
  request(key: string, q: CicdQuery): void {
    this.load(key, q).catch(() => undefined);
  }

  /** The rows of the fetch for `key`, started if nothing has; the one fetch every asker of `key` shares. */
  load(key: string, q: CicdQuery): Promise<readonly CicdRow[]> {
    let p = this.pending.get(key);
    if (p === undefined) {
      this.set(key, LOADING);
      p = this.dataSource.cicdRows(q).then(
        (rows) => {
          this.set(key, { status: 'ready', rows });
          return rows;
        },
        (e: unknown) => {
          const error = e instanceof Error ? e : new Error(String(e));
          this.set(key, { status: 'error', error });
          // forgotten, so a later render asks again
          this.pending.delete(key);
          throw error;
        },
      );
      this.pending.set(key, p);
    }
    return p;
  }

  private set(key: string, e: Entry): void {
    this.entries.set(key, e);
    for (const fn of this.listeners) fn();
  }
}

/** The page's store: made on first use in `shared` (one per data source), so the values sources and the provider hold the same one. */
function storeOf(shared: PageShared, dataSource: DataSource): CicdStore {
  return shared.get(dataSource, () => new CicdStore(dataSource));
}

/** The store's key for a fetch: the fetch window, the run-level bindings, the pipeline. */
const fetchKey = (
  window: TimeWindow | null,
  bindings: CicdQuery['bindings'],
  pipeline: string | null,
): string => JSON.stringify([window, bindings, pipeline]);

interface CicdContext {
  store: CicdStore;
  /** The page window, else the report's range; null for a report with no time range. */
  extent: TimeWindow | null;
}

const Ctx = createContext<CicdContext | null>(null);

/**
 * Mount once per dashboard page. It makes no request itself: the first `cicd` widget to subscribe starts the fetch,
 * so a page without one never calls `cicdRows`.
 */
export function CicdProvider(props: {
  dataSource: DataSource;
  extent: TimeWindow | null;
  /** The page's shared state, when something else (the variables' values) uses the same store. */
  shared?: PageShared;
  children: ReactNode;
}): JSX.Element {
  const { dataSource, extent, shared } = props;
  const store = useMemo(() => storeOf(shared ?? new PageShared(), dataSource), [shared, dataSource]);
  const value = useMemo(() => ({ store, extent }), [store, extent]);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

interface CicdResult {
  status: 'loading' | 'ready' | 'error';
  runs: CiRun[];
  previous: CiRun[];
  /** The span the runs were taken from (the previous period has the same length); null without a time range. */
  span: readonly [number, number] | null;
  error?: Error;
}

const NONE: CiRun[] = [];

/** The fetch window is the page window extended backwards by its own length. */
function fetchWindow(extent: TimeWindow): TimeWindow {
  return { start: extent.start - (extent.end - extent.start), end: extent.end };
}

/**
 * The widget's runs: the current span (`scope.window`, the page narrowed by a followed selection) and the same length
 * before it, joined per period. A view that honours the `job` and `runner` bindings (`honours`) has its jobs narrowed.
 */
export function useCicd(widget: Widget, scope: Pick<WidgetScope, 'window' | 'vars'>): CicdResult {
  return useCicdRuns(widget, scope, true, true);
}

/** What the page's slider shows of the CI runs: a tick per run in the page window, and the runs inside the zoom. */
export interface CicdPage {
  ticks: { t: number; color: string }[];
  /** The runs inside `zoom` (all of them unzoomed); null while there is nothing to count (no `cicd` widget, loading). */
  count: number | null;
}

const TICK_COLOR: Record<CiRun['result'], string> = {
  success: STATUS.good,
  failure: STATUS.critical,
  cancelled: STATUS.warning,
};

/**
 * The page's ticks and run count, from the same shared fetch as the widgets: the first `cicd` widget's pipeline and
 * the page's bindings (the run-level ones decide the fetch; job and runner narrowing is that widget's own, so the
 * page counts every run). Without a `cicd` widget it makes no request.
 */
export function useCicdPage(
  widgets: readonly Widget[],
  vars: WidgetScope['vars'] | null,
  zoom: readonly [number, number] | null,
): CicdPage {
  const first = widgets.find((w) => w.type === 'cicd');
  const result = useCicdRuns(
    first ?? widgets[0],
    { window: null, vars: vars ?? [] },
    first !== undefined && vars !== null,
    false,
  );
  return useMemo((): CicdPage => {
    if (first === undefined || vars === null || result.status !== 'ready' || result.span === null)
      return { ticks: [], count: null };
    const ticks = result.runs.map((r) => ({ t: r.start, color: TICK_COLOR[r.result] }));
    const count =
      zoom === null
        ? ticks.length
        : result.runs.filter((r) => r.start >= zoom[0] && r.start <= zoom[1]).length;
    return { ticks, count };
  }, [first, vars, result, zoom]);
}

function useCicdRuns(
  widget: Widget | undefined,
  scope: Pick<WidgetScope, 'window' | 'vars'>,
  enabled: boolean,
  narrow: boolean,
): CicdResult {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useCicd needs a CicdProvider');
  const { store, extent } = ctx;
  const pipeline = widget?.type === 'cicd' ? widget.pipeline : null;
  const fetchBindings = scope.vars
    .filter((v) => FETCH_KEYS.has(v.key))
    .map((v) => ({ key: v.key, value: v.value }));
  const fetchWin = extent === null || !enabled ? null : fetchWindow(extent);
  const key = fetchKey(fetchWin, fetchBindings, pipeline);
  useEffect(() => {
    const [window, bindings, pipe] = JSON.parse(key) as [
      TimeWindow | null,
      CicdQuery['bindings'],
      string | null,
    ];
    if (window !== null) store.request(key, { window, bindings, pipeline: pipe });
  }, [store, key]);
  const entry = useSyncExternalStore(store.subscribe, () =>
    fetchWin === null ? READY_EMPTY : store.get(key),
  );
  const span = scope.window ?? extent;
  const spanStart = span?.start ?? null;
  const spanEnd = span?.end ?? null;
  const job = widget === undefined || !narrow ? null : honoured(widget, scope, JOB_KEY);
  const runner = widget === undefined || !narrow ? null : honoured(widget, scope, RUNNER_KEY);
  return useMemo((): CicdResult => {
    if (entry.status === 'error')
      return { status: 'error', runs: NONE, previous: NONE, span: null, error: entry.error };
    if (entry.status === 'loading') return { status: 'loading', runs: NONE, previous: NONE, span: null };
    if (spanStart === null || spanEnd === null)
      return { status: 'ready', runs: NONE, previous: NONE, span: null };
    const split = splitPeriods(entry.rows, [spanStart, spanEnd]);
    return {
      status: 'ready',
      span: [spanStart, spanEnd],
      runs: narrowJobs(split.runs, job, runner),
      previous: narrowJobs(split.previous, job, runner),
    };
  }, [entry, spanStart, spanEnd, job, runner]);
}

const READY_EMPTY: Entry = { status: 'ready', rows: [] };

/** The binding's value when the widget's view honours the variable (R22: `honours` is the only list of that). */
function honoured(widget: Widget, scope: Pick<WidgetScope, 'vars'>, key: string): string | null {
  const b = scope.vars.find((v) => v.key === key);
  if (b === undefined || !honours(widget, { key, label: key, default: null })) return null;
  return b.value;
}

/** Which rows and which field each CI variable key lists (the distinct values over the page window's runs). */
const VALUE_FIELDS: Readonly<Record<string, { kind: CicdRow['kind']; pick: (r: CicdRow) => string | null }>> =
  {
    [CICD_BRANCH]: { kind: 'run', pick: (r) => r.branch },
    [CICD_TRIGGER]: { kind: 'run', pick: (r) => r.trigger },
    [JOB_KEY]: { kind: 'job', pick: (r) => r.task ?? r.name },
    [RUNNER_KEY]: { kind: 'job', pick: (r) => r.labels },
  };

/**
 * The values of the CI keys come from the same shared fetch as the widgets (window only, no bindings, the first `cicd`
 * widget's pipeline, as `useCicdPage` takes it), so in the default state the lists cost no request of their own.
 * A page without a `cicd` widget has no source and reads `resourceValues`.
 */
const LAST_ROWS = {};

/** The values of `kind` in `rows` (`inWindow` limits them to the runs that started in it), sorted. */
function valuesOf(
  rows: readonly CicdRow[],
  kind: CicdRow['kind'],
  pick: (r: CicdRow) => string | null,
  window: TimeWindow | null,
): string[] {
  const inWindow = new Set<string>();
  for (const r of rows)
    if (r.kind === 'run' && (window === null || (r.start >= window.start && r.start <= window.end)))
      inWindow.add(r.traceId);
  const values = new Set<string>();
  for (const r of rows) {
    if (r.kind !== kind || !inWindow.has(r.traceId)) continue;
    const v = pick(r);
    if (v !== null) values.add(v);
  }
  return [...values].sort();
}

/**
 * A read without a window (the page's "whole report" read for a selection outside the window, R43) never fetches:
 * it lists the values of the last window read's fetch, which reaches one period further back, so a selection from the
 * previous period stays known and a window with no runs still tells the key apart from one the report lacks.
 */
for (const [key, { kind, pick }] of Object.entries(VALUE_FIELDS)) {
  registerValuesSource(key, ({ widgets, dataSource, shared }) => {
    const first = widgets.find((w) => w.type === 'cicd');
    if (first === undefined) return null;
    const pipeline = first.type === 'cicd' ? first.pipeline : null;
    const store = storeOf(shared, dataSource);
    const last = shared.get(LAST_ROWS, () => new Map<string | null, readonly CicdRow[]>());
    return async (window) => {
      if (window === null)
        return {
          values: valuesOf(last.get(pipeline) ?? [], kind, pick, null),
          kind: 'string',
          capped: false,
        };
      const fetchWin = fetchWindow(window);
      const rows = await store.load(fetchKey(fetchWin, [], pipeline), {
        window: fetchWin,
        bindings: [],
        pipeline,
      });
      last.set(pipeline, rows);
      return { values: valuesOf(rows, kind, pick, window), kind: 'string', capped: false };
    };
  });
}
