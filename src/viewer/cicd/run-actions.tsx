import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { Dashboard, QuickFilter, Variable } from '../../dashboards/schema.js';
import { parseTraceId } from '../../model/ids.js';
import { type MenuItem, useContextMenu } from '../components/context-menu.js';
import { withVariable } from '../dashboards/variables-bar.js';
import type { DataSource } from '../data/data-source.js';
import type { DashboardPageState } from '../state/dashboard-state.js';
import { jobStatus } from './derive.js';
import type { CiRun } from './runs.js';

const BRANCH = 'vcs.ref.head.name';
const TRIGGER = 'cicd.pipeline.trigger';
const JOB = 'cicd.pipeline.task.name';
const RUNNER = 'cicd.worker.labels';
const URL_ATTR = 'cicd.pipeline.run.url.full';
const PULL_REQUEST = 'pull_request';
const MAX_JOB_ITEMS = 2;
const NOTICE_MS = 4000;

type At = { x: number; y: number };

interface RunActionsContext {
  dashboard: Dashboard;
  state: DashboardPageState;
  change(fn: (s: DashboardPageState) => DashboardPageState): void;
  dataSource: DataSource;
}

interface Shared extends RunActionsContext {
  /** The pane mode last used on this page; it outlives `d.run`, which a trace change clears. */
  mode: { current: 'attached' | 'panel' };
}

const Ctx = createContext<Shared | null>(null);

/** Mount once per dashboard page, inside the page's state: the run actions read and write `d` through it. */
export function RunActionsProvider(props: RunActionsContext & { children: ReactNode }): JSX.Element {
  const { children, ...value } = props;
  const mode = useRef<'attached' | 'panel'>('attached');
  return <Ctx.Provider value={{ ...value, mode }}>{children}</Ctx.Provider>;
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
  openRun(run: CiRun): void;
  /** Sets the pane mode for the open run and for the runs opened after it. */
  setMode(mode: 'attached' | 'panel'): void;
  runMenu(run: CiRun, at: At): void;
  /** `openTrend` adds the "Open its trend" item (the jobs table passes it). */
  jobMenu(job: string, at: At, openTrend?: () => void): void;
  triggerMenu(trigger: string, at: At): void;
  runnerMenu(label: string, at: At): void;
  /** The open run's trace, whichever widget opened it. */
  selectedTraceId: string | null;
  /** True when this widget is the one the open run was opened from. */
  isSource: boolean;
  /** The menu and the notice; render it once in the view. */
  element: JSX.Element;
}

export function useRunActions(widgetId: string): RunActions {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useRunActions needs a RunActionsProvider');
  const { dashboard, state, change, dataSource, mode } = ctx;
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
  const has = (key: string): boolean => dashboard.variables.some((v) => v.key === key);
  const current = (key: string): string | null => {
    if (Object.hasOwn(state.vars, key)) return state.vars[key] ?? null;
    return dashboard.variables.find((v) => v.key === key)?.default ?? null;
  };

  const openRun = useCallback(
    (run: CiRun): void =>
      change((s) => ({
        ...s,
        sel: { ...s.sel, trace: parseTraceId(run.traceId, 'trace') },
        run: { from: widgetId, mode: mode.current },
      })),
    [change, widgetId, mode],
  );
  const setMode = useCallback(
    (m: 'attached' | 'panel'): void => {
      mode.current = m;
      change((s) => (s.run === null ? s : { ...s, run: { ...s.run, mode: m } }));
    },
    [change, mode],
  );

  const openOnGithub = (run: CiRun): void => {
    const none = (): void => setNotice('This run has no GitHub link.');
    runUrl(dataSource, run.traceId).then((url) => {
      if (url === null || !/^https?:\/\//.test(url)) none();
      else window.open(url, '_blank', 'noopener');
    }, none);
  };

  const filterItem = (label: string, key: string, value: string): MenuItem[] =>
    has(key) ? [{ label, code: value, run: () => setVar(key, value) }] : [];

  const runMenu = (run: CiRun, at: At): void => {
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
              run: () => change((s) => ({ ...s, vars: withQuick(s.vars, dashboard.variables, quick.quick) })),
            },
          ]),
      ...failed.flatMap((j) => filterItem('Filter the page by job', JOB, j.name)),
    ]);
  };

  const jobMenu = (job: string, at: At, openTrend?: () => void): void => {
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
  };

  return {
    openRun,
    setMode,
    runMenu,
    jobMenu,
    triggerMenu: (trigger, at) =>
      menu.open(at, trigger, filterItem('Filter the page by trigger', TRIGGER, trigger)),
    runnerMenu: (label, at) => menu.open(at, label, filterItem('Filter the page by runner', RUNNER, label)),
    selectedTraceId: state.sel.trace,
    isSource: state.run?.from === widgetId,
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
