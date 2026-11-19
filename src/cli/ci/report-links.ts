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
