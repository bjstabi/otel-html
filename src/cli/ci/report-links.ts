import type { ResolvedConfig } from '../../config/schema.js';
import type { SiteRun } from './site.js';

/** Links into the one CI report: the viewer's URL (`#/dashboards/<id>?t=…&d=…`) for a branch and a window. */

/** The semantic-convention key a run's branch is recorded under. */
export const BRANCH_KEY = 'vcs.ref.head.name';

/** A time window in unix nanoseconds. */
export type Window = { start: bigint; end: bigint };

/** `<start>~<end>`, the viewer's `t` parameter. */
export const windowText = (w: Window): string => `${w.start}~${w.end}`;

/** `base` + the dashboard `dashboard` with `branch` selected, over `window` when given. */
export function branchLink(base: string, dashboard: string, branch: string, window: Window | null): string {
  const q = new URLSearchParams();
  if (window !== null) q.set('t', windowText(window));
  q.set('d', JSON.stringify({ vars: { [BRANCH_KEY]: branch } }));
  return `${base}#/dashboards/${dashboard}?${q.toString().replaceAll('%7E', '~')}`;
}

const HOUR_NS = 3_600_000_000_000n;
const ns = (iso: string): bigint => BigInt(Date.parse(iso)) * 1_000_000n;

/** From an hour before the earliest run's start to an hour after the latest completion; `null` for no runs. */
export function runsWindow(runs: readonly SiteRun[]): Window | null {
  let start: bigint | undefined;
  let end: bigint | undefined;
  for (const r of runs) {
    const s = ns(r.startedAt ?? r.completedAt);
    const e = ns(r.completedAt);
    if (start === undefined || s < start) start = s;
    if (end === undefined || e > end) end = e;
  }
  return start === undefined || end === undefined ? null : { start: start - HOUR_NS, end: end + HOUR_NS };
}

/**
 * The default dashboard, and the id of its first `cicd` widget of view `runs` (the one that opens a run). With
 * `workflow`, only a widget that lists that workflow's runs (no `pipeline` filter, or the filter equals it).
 */
export function dashboardIds(
  config: ResolvedConfig,
  workflow?: string,
): { dashboard: string; runsWidget: string | undefined } {
  const dashboard = config.viewer.defaultDashboard;
  const widgets = config.dashboards.find((d) => d.dashboard.id === dashboard)?.dashboard.widgets ?? [];
  const runs = widgets.find(
    (w) =>
      w.type === 'cicd' &&
      w.view === 'runs' &&
      (workflow === undefined || w.pipeline === undefined || w.pipeline === null || w.pipeline === workflow),
  );
  return { dashboard, runsWidget: runs?.id };
}

/** `config` with the `BRANCH_KEY` variable of every dashboard defaulting to `branch`. */
export function withBranchDefault(config: ResolvedConfig, branch: string): ResolvedConfig {
  return {
    ...config,
    dashboards: config.dashboards.map((d) => ({
      ...d,
      dashboard: {
        ...d.dashboard,
        variables: d.dashboard.variables.map((v) => (v.key === BRANCH_KEY ? { ...v, default: branch } : v)),
      },
    })),
  };
}

const DAY_NS = 86_400_000_000_000n;

/** The run opened in `dashboard` (with the variables `vars` set, so the default does not hide it): its trace selected, the run pane open from `runsWidget`, a week before to an hour after it. */
export function runLink(
  base: string,
  ids: { dashboard: string; runsWidget: string | undefined },
  run: { traceId: string; range: Window },
  vars?: Record<string, string>,
): string {
  const q = new URLSearchParams();
  q.set('t', windowText({ start: run.range.start - 7n * DAY_NS, end: run.range.end + HOUR_NS }));
  q.set(
    'd',
    JSON.stringify({
      ...(vars === undefined ? {} : { vars }),
      sel: { trace: run.traceId },
      ...(ids.runsWidget === undefined ? {} : { run: { from: ids.runsWidget, mode: 'panel' } }),
    }),
  );
  return `${base}#/dashboards/${ids.dashboard}?${q.toString().replaceAll('%7E', '~')}`;
}

/** The `<id>` of `#/dashboards/<id>` in `url`. */
export const dashboardIdOf = (url: string): string | undefined => /#\/dashboards\/([^?#/]+)/.exec(url)?.[1];
