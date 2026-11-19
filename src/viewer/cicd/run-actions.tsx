import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Dashboard, QuickFilter, Variable } from '../../dashboards/schema.js';
import { parseTraceId } from '../../model/ids.js';
import { type MenuItem, useContextMenu } from '../components/context-menu.js';
import { withVariable } from '../dashboards/variables-bar.js';
import type { DataSource } from '../data/data-source.js';
import type { TimeWindow } from '../data/time-window.js';
import type { DashboardPageState } from '../state/dashboard-state.js';
import { jobStatus } from './derive.js';
import type { CiRun } from './runs.js';

const BRANCH = 'vcs.ref.head.name';
const TRIGGER = 'cicd.pipeline.trigger';
const JOB = 'cicd.pipeline.task.name';
const RUNNER = 'cicd.worker.labels';
const REPOSITORY = 'vcs.repository.url.full';
const URL_ATTR = 'cicd.pipeline.run.url.full';
const PULL_REQUEST = 'pull_request';
const MAX_JOB_ITEMS = 2;
const NOTICE_MS = 4000;

type At = { x: number; y: number };

/** Where the open run's mark is, as fractions (0..1) of the source widget's box. */
type RunPoint = { x: number; y: number };

/** The point of a click: the pointer, or the centre of the focused mark when a key made the click (no pointer). */
export function pointFromClick(e: {
  clientX: number;
  clientY: number;
  detail: number;
  currentTarget: Element;
}): At {
  return e.detail === 0 && e.clientX === 0 && e.clientY === 0
    ? centreOf(e.currentTarget)
    : { x: e.clientX, y: e.clientY };
}

/** The centre of an element's box (for Enter on a focused mark, or a menu's target). */
export function centreOf(el: Element): At {
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/** `at` (client coordinates) as fractions of the widget's box; null when there is no box to measure. */
function fractionsIn(widgetId: string, at: At): RunPoint | null {
  const box = document.querySelector(`[data-widget="${CSS.escape(widgetId)}"]`)?.getBoundingClientRect();
  if (box === undefined || box.width <= 0 || box.height <= 0) return null;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return { x: clamp((at.x - box.left) / box.width), y: clamp((at.y - box.top) / box.height) };
}

interface RunActionsContext {
  dashboard: Dashboard;
  state: DashboardPageState;
  change(fn: (s: DashboardPageState) => DashboardPageState): void;
  dataSource: DataSource;
  /** The page window; the repository lookup uses it once (a report's repository does not change with it). */
  window: TimeWindow | null;
}

interface Shared extends Omit<RunActionsContext, 'window'> {
  /** The pane mode last used on this page; it outlives `d.run`, which a trace change clears. */
  mode: { current: 'attached' | 'panel' };
  /** Where the last run was opened (page-session state like the mode; never in the URL). */
  point: RunPoint | null;
  setPoint(p: RunPoint | null): void;
  /** The report's only repository url, read once per page; null when there are several, none or the read failed. */
  repository(): Promise<string | null>;
  /** The settled `repository()`, synchronously; undefined until it settles. */
  repositoryValue(): string | null | undefined;
}

const Ctx = createContext<Shared | null>(null);

/** Mount once per dashboard page, inside the page's state: the run actions read and write `d` through it. */
export function RunActionsProvider(props: RunActionsContext & { children: ReactNode }): JSX.Element {
  const { children, ...value } = props;
  const mode = useRef<'attached' | 'panel'>('attached');
  const [point, setPoint] = useState<RunPoint | null>(null);
  const { dashboard, state, change, dataSource, window: pageWindow } = value;
  const lookup = useRef<{ promise: Promise<string | null>; value: string | null | undefined } | null>(null);
  const repository = useCallback((): Promise<string | null> => {
    if (lookup.current === null) {
      const entry: { promise: Promise<string | null>; value: string | null | undefined } = {
        promise: Promise.resolve(null),
        value: undefined,
      };
      entry.promise = dataSource.resourceValues(REPOSITORY, { window: pageWindow }).then(
        ({ values }) => {
          const only = values.length === 1 ? values[0]?.replace(/\/+$/, '') : undefined;
          entry.value = only !== undefined && /^https?:\/\//.test(only) ? only : null;
          return entry.value;
        },
        () => {
          entry.value = null;
          return null;
        },
      );
      lookup.current = entry;
    }
    return lookup.current.promise;
  }, [dataSource, pageWindow]);
  const repositoryValue = useCallback(() => lookup.current?.value, []);
  const shared = useMemo(
    () => ({ dashboard, state, change, dataSource, mode, point, setPoint, repository, repositoryValue }),
    [dashboard, state, change, dataSource, point, repository, repositoryValue],
  );
  return <Ctx.Provider value={shared}>{children}</Ctx.Provider>;
}

/** The quick filter that moves away from the run's own kind: main for a pull request, else pull requests. */
function quickFor(dashboard: Dashboard, run: CiRun): { quick: QuickFilter; label: string } | null {
  const toMain = run.trigger === PULL_REQUEST;
  const quick = dashboard.quick.find((q) =>
    toMain ? q.set[BRANCH] === 'main' : q.set[TRIGGER] === PULL_REQUEST,
  );
  return quick === undefined ? null : { quick, label: toMain ? 'Show main only' : 'Show pull requests only' };
}

function withQuick(
  vars: DashboardPageState['vars'],
  variables: readonly Variable[],
  quick: QuickFilter,
): DashboardPageState['vars'] {
  let next = vars;
  for (const [key, value] of Object.entries(quick.set)) {
    const variable = variables.find((v) => v.key === key);
    if (variable !== undefined) next = withVariable(next, variable, value);
  }
  return next;
}

/** The run's GitHub URL, read from its trace's root span resource (the cicd table carries none); null when absent. */
async function runUrl(dataSource: DataSource, traceId: CiRun['traceId']): Promise<string | null> {
  const detail = await dataSource.getTrace(parseTraceId(traceId, 'trace'));
  const root = detail.tree.roots[0];
  if (root === undefined) return null;
  const v = detail.resources(root.row.span.resource).attributes.get(URL_ATTR);
  return v?.kind === 'string' && v.value !== '' ? v.value : null;
}

export interface RunActions {
  /** `at` is the mark's point in client coordinates; the caret and connector use it. */
  openRun(run: CiRun, at?: At): void;
  /** Sets the pane mode for the open run and for the runs opened after it. */
  setMode(mode: 'attached' | 'panel'): void;
  runMenu(run: CiRun, at: At): void;
  /** Opens the run's GitHub page in a tab (http(s) only), or says it has none; the run menu's item does the same. */
  openOnGithub(run: CiRun): void;
  /** `openTrend` adds the "Open its trend" item (the jobs table passes it). */
  jobMenu(job: string, at: At, openTrend?: () => void): void;
  triggerMenu(trigger: string, at: At): void;
  runnerMenu(label: string, at: At): void;
  /** The open run's trace, whichever widget opened it. */
  selectedTraceId: string | null;
  /** True when this widget is the one the open run was opened from. */
  isSource: boolean;
  /** Where the open run's mark was, relative to its source widget; null when unknown (after a reload). */
  runPoint: RunPoint | null;
  /** The menu and the notice; render it once in the view. */
  element: JSX.Element;
}

export function useRunActions(widgetId: string): RunActions {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useRunActions needs a RunActionsProvider');
  const { dashboard, state, change, dataSource, mode, point, setPoint, repository, repositoryValue } = ctx;
  const menu = useContextMenu();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const setVar = useCallback(
    (key: string, value: string | null): void => {
      const variable = dashboard.variables.find((v) => v.key === key);
      if (variable !== undefined) change((s) => ({ ...s, vars: withVariable(s.vars, variable, value) }));
    },
    [dashboard, change],
  );
  const has = useCallback((key: string) => dashboard.variables.some((v) => v.key === key), [dashboard]);
  const current = useCallback(
    (key: string): string | null => {
      if (Object.hasOwn(state.vars, key)) return state.vars[key] ?? null;
      return dashboard.variables.find((v) => v.key === key)?.default ?? null;
    },
    [dashboard, state.vars],
  );

  const openRun = useCallback(
    (run: CiRun, at?: At): void => {
      setPoint(at === undefined ? null : fractionsIn(widgetId, at));
      change((s) => ({
        ...s,
        sel: { ...s.sel, trace: parseTraceId(run.traceId, 'trace') },
        run: { from: widgetId, mode: mode.current },
      }));
    },
    [change, widgetId, mode, setPoint],
  );
  const setMode = useCallback(
    (m: 'attached' | 'panel'): void => {
      mode.current = m;
      change((s) => (s.run === null ? s : { ...s, run: { ...s.run, mode: m } }));
    },
    [change, mode],
  );

  // With the repository known the url is built and opened in the click. Otherwise the tab opens inside the click (a
  // popup blocker drops a `window.open` made after an await) and goes to the url once it is known; with none (or a
  // blocked tab) the url is opened afterwards, or the notice is shown.
  const openOnGithub = useCallback(
    (run: CiRun): void => {
      const numeric = /^\d+$/.test(run.runId);
      const known = repositoryValue();
      if (numeric && typeof known === 'string') {
        window.open(`${known}/actions/runs/${run.runId}`, '_blank', 'noopener');
        return;
      }
      const tab = window.open('', '_blank') ?? null;
      if (tab !== null) tab.opener = null;
      const none = (): void => {
        tab?.close();
        setNotice('This run has no GitHub link.');
      };
      const urlOf = async (): Promise<string | null> => {
        const repo = numeric ? await repository() : null;
        return repo === null ? runUrl(dataSource, run.traceId) : `${repo}/actions/runs/${run.runId}`;
      };
      urlOf().then((url) => {
        if (url === null || !/^https?:\/\//.test(url)) none();
        else if (tab === null) window.open(url, '_blank', 'noopener');
        else tab.location.href = url;
      }, none);
    },
    [dataSource, repository, repositoryValue],
  );

  const filterItem = useCallback(
    (label: string, key: string, value: string): MenuItem[] =>
      has(key) ? [{ label, code: value, run: () => setVar(key, value) }] : [],
    [has, setVar],
  );

  const runMenu = useCallback(
    (run: CiRun, at: At): void => {
      repository();
      const quick = quickFor(dashboard, run);
      const failed = run.jobs.filter((j) => jobStatus(j) === 'failure').slice(0, MAX_JOB_ITEMS);
      menu.open(at, run.title ?? `Run ${run.runId}`, [
        { label: 'Open the run here', run: () => openRun(run) },
        { label: 'Open on GitHub ↗', run: () => openOnGithub(run) },
        'separator',
        ...(run.trigger === null ? [] : filterItem('Filter the page by trigger', TRIGGER, run.trigger)),
        ...(quick === null
          ? []
          : [
              {
                label: quick.label,
                run: () =>
                  change((s) => ({ ...s, vars: withQuick(s.vars, dashboard.variables, quick.quick) })),
              },
            ]),
        ...failed.flatMap((j) => filterItem('Filter the page by job', JOB, j.name)),
      ]);
    },
    [dashboard, change, menu.open, openRun, openOnGithub, filterItem, repository],
  );

  const jobMenu = useCallback(
    (job: string, at: At, openTrend?: () => void): void => {
      const on = current(JOB) === job;
      menu.open(at, job, [
        ...(has(JOB)
          ? [
              on
                ? { label: 'Clear the job filter', run: () => setVar(JOB, null) }
                : { label: 'Filter the page by job', run: () => setVar(JOB, job) },
            ]
          : []),
        ...(openTrend === undefined ? [] : [{ label: 'Open its trend', run: openTrend }]),
      ]);
    },
    [has, current, setVar, menu.open],
  );
  const triggerMenu = useCallback(
    (trigger: string, at: At) =>
      menu.open(at, trigger, filterItem('Filter the page by trigger', TRIGGER, trigger)),
    [menu.open, filterItem],
  );
  const runnerMenu = useCallback(
    (label: string, at: At) => menu.open(at, label, filterItem('Filter the page by runner', RUNNER, label)),
    [menu.open, filterItem],
  );

  return {
    openRun,
    setMode,
    runMenu,
    openOnGithub,
    jobMenu,
    triggerMenu,
    runnerMenu,
    selectedTraceId: state.sel.trace,
    isSource: state.run?.from === widgetId,
    runPoint: point,
    element: (
      <>
        {menu.element}
        {notice !== null &&
          createPortal(
            <div
              role="status"
              className="fixed right-4 bottom-4 z-50 rounded-card border border-hairline bg-surface px-3 py-2 text-sm text-ink shadow-lg"
            >
              {notice}
            </div>,
            document.body,
          )}
      </>
    ),
  };
}

/**
 * The ring round the open run's mark: faint in every view, full with a dotted connector (down to `connectorTo`,
 * where the pane's caret is) in the view the run was opened from. Draw it inside the view's SVG.
 */
export function RunRing(props: {
  cx: number;
  cy: number;
  r: number;
  source: boolean;
  connectorTo?: number;
}): JSX.Element {
  const { cx, cy, r, source, connectorTo } = props;
  return (
    <g data-run-ring={source ? 'full' : 'faint'} pointerEvents="none" fill="none" stroke="currentColor">
      <circle cx={cx} cy={cy} r={r + 2} strokeWidth={source ? 2 : 1.5} opacity={source ? 1 : 0.35} />
      {source && connectorTo !== undefined && (
        <line x1={cx} y1={cy + r + 2} x2={cx} y2={connectorTo} strokeWidth={1.5} strokeDasharray="1 3" />
      )}
    </g>
  );
}
