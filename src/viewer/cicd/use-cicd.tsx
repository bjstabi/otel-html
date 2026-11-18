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
import { honours, type WidgetScope } from '../dashboards/scope.js';
import type { CicdQuery, CicdRow } from '../data/cicd-query.js';
import type { DataSource } from '../data/data-source.js';
import type { TimeWindow } from '../data/time-window.js';
import { narrowJobs, splitPeriods } from './derive.js';
import type { CiRun } from './runs.js';

const JOB_KEY = 'cicd.pipeline.task.name';
const RUNNER_KEY = 'cicd.worker.labels';
/** The run-level keys the fetch itself is narrowed by; every other binding is applied to the jobs after it. */
const FETCH_KEYS = new Set(['vcs.ref.head.name', 'cicd.pipeline.trigger']);

type Entry =
  | { status: 'loading' }
  | { status: 'ready'; rows: readonly CicdRow[] }
  | { status: 'error'; error: Error };

const LOADING: Entry = { status: 'loading' };

/** The page's `cicd` fetches, one per distinct window, run-level bindings and pipeline; started only when a widget asks. */
class CicdStore {
  private readonly entries = new Map<string, Entry>();
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
    if (this.entries.has(key)) return;
    this.set(key, LOADING);
    this.dataSource.cicdRows(q).then(
      (rows) => this.set(key, { status: 'ready', rows }),
      (e: unknown) =>
        this.set(key, { status: 'error', error: e instanceof Error ? e : new Error(String(e)) }),
    );
  }

  private set(key: string, e: Entry): void {
    this.entries.set(key, e);
    for (const fn of this.listeners) fn();
  }
}

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
  children: ReactNode;
}): JSX.Element {
  const { dataSource, extent } = props;
  const store = useMemo(() => new CicdStore(dataSource), [dataSource]);
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
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useCicd needs a CicdProvider');
  const { store, extent } = ctx;
  const pipeline = widget.type === 'cicd' ? widget.pipeline : null;
  const fetchBindings = scope.vars
    .filter((v) => FETCH_KEYS.has(v.key))
    .map((v) => ({ key: v.key, value: v.value }));
  const fetchWin = extent === null ? null : fetchWindow(extent);
  const key = JSON.stringify([fetchWin, fetchBindings, pipeline]);
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
  const job = honoured(widget, scope, JOB_KEY);
  const runner = honoured(widget, scope, RUNNER_KEY);
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
