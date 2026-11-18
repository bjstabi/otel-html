import { formatDuration } from '../../semconv/formatters.js';
import type { CicdRow } from '../data/cicd-query.js';
import { type CiJob, type CiRun, combineRuns } from './runs.js';

const MIN = 60_000_000_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The trend's bucket steps, smallest first (spec §6). */
const STEPS = [
  5 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
];

type CiStatus = 'success' | 'failure' | 'cancelled';

// ---------------------------------------------------------------------------------------------------------------
// Basics

const finite = (xs: readonly number[]): number[] => xs.filter((x) => Number.isFinite(x));

/** The `q` quantile (0..1) of `xs` by linear interpolation; null when there is none. */
function quantile(xs: readonly number[], q: number): number | null {
  const s = finite(xs).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] ?? 0;
  const b = s[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

const median = (xs: readonly number[]): number | null => quantile(xs, 0.5);

/** A job's status; null when it did not run (skipped). */
function jobStatus(j: CiJob): CiStatus | null {
  const r = j.result.toLowerCase();
  if (r === 'success') return 'success';
  if (r === 'cancellation' || r === 'cancelled' || r === 'canceled') return 'cancelled';
  if (r.startsWith('skip')) return null;
  return 'failure';
}

/** The jobs that ran (skipped ones did not). */
const ranJobs = (r: CiRun): CiJob[] => r.jobs.filter((j) => jobStatus(j) !== null);
/** CI minutes of the jobs that ran. */
const minutesOf = (jobs: readonly CiJob[]): number =>
  jobs.reduce((s, j) => s + (jobStatus(j) === null ? 0 : jobDuration(j)), 0) / MIN;
const jobDuration = (j: CiJob): number => Math.max(0, j.end - j.start);
const notCancelled = (runs: readonly CiRun[]): CiRun[] => runs.filter((r) => r.result !== 'cancelled');

// ---------------------------------------------------------------------------------------------------------------
// Periods and job narrowing

/**
 * Splits `rows` by the start of their trace's run row into the current span (start..end, both inclusive) and the
 * span of the same length just before it, and joins each part into runs on its own, so each period keeps its own
 * latest attempt. Traces with no run row are dropped.
 */
export function splitPeriods(
  rows: readonly CicdRow[],
  span: readonly [number, number],
): { runs: CiRun[]; previous: CiRun[] } {
  const [start, end] = span;
  const prevStart = start - (end - start);
  const startOf = new Map<string, number>();
  for (const r of rows) if (r.kind === 'run') startOf.set(r.traceId, r.start);
  const current: CicdRow[] = [];
  const before: CicdRow[] = [];
  for (const r of rows) {
    const s = startOf.get(r.traceId);
    if (s === undefined) continue;
    if (s >= start && s <= end) current.push(r);
    else if (s >= prevStart && s < start) before.push(r);
  }
  return { runs: combineRuns(current), previous: combineRuns(before) };
}

/** Drops the jobs that are not `job` (a job name) or whose labels are not `runner`, and the runs left with no job. */
export function narrowJobs(runs: readonly CiRun[], job: string | null, runner: string | null): CiRun[] {
  if (job === null && runner === null) return [...runs];
  const out: CiRun[] = [];
  for (const r of runs) {
    const jobs = r.jobs.filter(
      (j) => (job === null || j.name === job) && (runner === null || j.labels === runner),
    );
    if (jobs.length > 0) out.push({ ...r, jobs, minutes: minutesOf(jobs) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Stat tiles

export type StatKind = 'success-rate' | 'median-run' | 'cache' | 'minutes' | 'queue-p95' | 'reruns';

export interface StatResult {
  value: string;
  delta: { text: string; better: boolean | null } | null;
  spark: number[] | null;
  note: string | null;
}

const EMPTY_STAT: StatResult = { value: '–', delta: null, spark: null, note: null };

/** Runs whose latest attempt is above 1. */
const rerunsOf = (runs: readonly CiRun[]): number => runs.filter((r) => r.attempt > 1).length;

function jobQueues(runs: readonly CiRun[]): number[] {
  return runs.flatMap((r) => ranJobs(r).flatMap((j) => (j.queuedNs === null ? [] : [j.queuedNs])));
}

function cacheRatio(runs: readonly CiRun[]): number | null {
  const ok = notCancelled(runs);
  const cold = median(ok.filter((r) => r.cached === false).map((r) => r.duration));
  const warm = median(ok.filter((r) => r.cached === true).map((r) => r.duration));
  return cold === null || warm === null || warm <= 0 ? null : cold / warm;
}

/** The scalar a tile shows for `runs`; null when there is nothing to show. */
function scalar(kind: StatKind, runs: readonly CiRun[]): number | null {
  switch (kind) {
    case 'success-rate': {
      const ok = notCancelled(runs);
      return ok.length === 0 ? null : (ok.filter((r) => r.result === 'success').length / ok.length) * 100;
    }
    case 'median-run':
      return median(notCancelled(runs).map((r) => r.duration));
    case 'cache':
      return cacheRatio(runs);
    case 'minutes':
      return runs.length === 0 ? null : runs.reduce((s, r) => s + minutesOf(r.jobs), 0);
    case 'queue-p95':
      return quantile(jobQueues(runs), 0.95);
    case 'reruns':
      return runs.length === 0 ? null : rerunsOf(runs);
  }
}

const rounded = (n: number, digits = 1): string => String(Number(n.toFixed(digits)));

function minutesText(m: number): string {
  return `${Math.round(m).toLocaleString('en-US')} min`;
}

function valueText(kind: StatKind, v: number): string {
  switch (kind) {
    case 'success-rate':
      return `${rounded(v)}%`;
    case 'median-run':
    case 'queue-p95':
      return formatDuration(v);
    case 'cache':
      return `${rounded(v)}×`;
    case 'minutes':
      return minutesText(v);
    case 'reruns':
      return String(v);
  }
}

/** Whether a rise in the tile is good (true), bad (false). */
const HIGHER_IS_BETTER: Record<StatKind, boolean> = {
  'success-rate': true,
  'median-run': false,
  cache: true,
  minutes: false,
  'queue-p95': false,
  reruns: false,
};

function deltaOf(kind: StatKind, now: number, before: number | null): StatResult['delta'] {
  if (before === null) return null;
  const diff = now - before;
  if (!Number.isFinite(diff)) return null;
  const better = diff === 0 ? null : diff > 0 === HIGHER_IS_BETTER[kind];
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  const abs = Math.abs(diff);
  if (kind === 'success-rate') return { text: `${sign}${rounded(abs)} pts`, better };
  if (kind === 'cache') return { text: `${sign}${rounded(abs)}×`, better };
  if (kind === 'reruns') return { text: `${sign}${abs}`, better };
  if (before <= 0) return null;
  return { text: `${sign}${rounded((abs / before) * 100, 0)}%`, better };
}

const SPARK_POINTS = 12;

/** The tile's value over up to 12 equal slices of the runs' start range; null under two points. */
function sparkOf(kind: StatKind, runs: readonly CiRun[]): number[] | null {
  if (runs.length < 2) return null;
  const first = runs[0]?.start ?? 0;
  const last = runs[runs.length - 1]?.start ?? 0;
  const width = (last - first) / SPARK_POINTS;
  if (!(width > 0)) return null;
  const slices: CiRun[][] = Array.from({ length: SPARK_POINTS }, () => []);
  for (const r of runs) slices[Math.min(SPARK_POINTS - 1, Math.floor((r.start - first) / width))]?.push(r);
  // an empty slice repeats the value before it (the time spacing stays); a slice before any value stays out
  const points: number[] = [];
  for (const sl of slices) {
    const v = sl.length === 0 ? null : scalar(kind, sl);
    if (v !== null && Number.isFinite(v)) points.push(v);
    else if (points.length > 0) points.push(points[points.length - 1] ?? 0);
  }
  return points.length < 2 ? null : points;
}

const SPARKED = new Set<StatKind>(['median-run', 'minutes', 'queue-p95']);

function noteOf(kind: StatKind, runs: readonly CiRun[]): string | null {
  if (kind === 'success-rate') {
    const ok = notCancelled(runs);
    const passed = ok.filter((r) => r.result === 'success').length;
    const dropped = runs.length - ok.length;
    return `${passed} of ${ok.length} runs${dropped > 0 ? `, ${dropped} cancelled left out` : ''}`;
  }
  if (kind === 'reruns') return `${runs.filter((r) => r.result === 'cancelled').length} cancelled`;
  return null;
}

/** One stat tile over the current runs, with its delta against `previous`. */
export function stat(kind: StatKind, runs: readonly CiRun[], previous: readonly CiRun[]): StatResult {
  const now = scalar(kind, runs);
  if (now === null || !Number.isFinite(now)) return EMPTY_STAT;
  return {
    value: valueText(kind, now),
    delta: deltaOf(kind, now, scalar(kind, previous)),
    spark: SPARKED.has(kind) ? sparkOf(kind, runs) : null,
    note: noteOf(kind, runs),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Runs over time

export interface TrendBucket {
  t: number;
  p50: number | null;
  p95: number | null;
  passed: number;
  failed: number;
  cancelled: number;
  runs: CiRun[];
}

/** The smallest step that gives at most `min(48, max(6, floor(runs/3)))` buckets over `span`. */
function bucketStep(runCount: number, span: readonly [number, number]): number {
  const most = Math.min(48, Math.max(6, Math.floor(runCount / 3)));
  const length = Math.max(0, span[1] - span[0]);
  return STEPS.find((s) => Math.ceil(length / s) <= most) ?? STEPS[STEPS.length - 1] ?? DAY;
}

export function trendBuckets(
  runs: readonly CiRun[],
  span: readonly [number, number],
): { step: number; buckets: TrendBucket[] } {
  const step = bucketStep(runs.length, span);
  if (runs.length === 0) return { step, buckets: [] };
  const count = Math.max(1, Math.ceil((span[1] - span[0]) / step));
  const buckets: TrendBucket[] = Array.from({ length: count }, (_, i) => ({
    t: span[0] + i * step,
    p50: null,
    p95: null,
    passed: 0,
    failed: 0,
    cancelled: 0,
    runs: [],
  }));
  for (const r of runs) {
    const b = buckets[Math.min(count - 1, Math.floor((r.start - span[0]) / step))];
    if (b === undefined || r.start < span[0] || r.start > span[1]) continue;
    b.runs.push(r);
    if (r.result === 'success') b.passed++;
    else if (r.result === 'failure') b.failed++;
    else b.cancelled++;
  }
  for (const b of buckets) {
    const d = notCancelled(b.runs).map((r) => r.duration);
    b.p50 = quantile(d, 0.5);
    b.p95 = quantile(d, 0.95);
  }
  return { step, buckets };
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

interface JobPoint {
  run: CiRun;
  duration: number;
  status: CiStatus;
}

export interface JobRow {
  name: string;
  points: JobPoint[];
  latest: number;
  median: number;
  p25: number;
  p75: number;
  /** The median of the last 10 successful runs minus the median of the 20 before; null under 3 on either side. */
  delta: number | null;
  /** The 20-run baseline median, and the last-10 median (the two ends of the Δ bar). */
  deltaA: number | null;
  deltaB: number | null;
  failed: [number, number];
}

function jobHistory(runs: readonly CiRun[]): Map<string, JobPoint[]> {
  const byName = new Map<string, JobPoint[]>();
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    for (const j of r.jobs) {
      const status = jobStatus(j);
      if (status === null) continue;
      const list = byName.get(j.name) ?? [];
      list.push({ run: r, duration: jobDuration(j), status });
      byName.set(j.name, list);
    }
  }
  return byName;
}

/**
 * One row per job of `runs` with at least 3 points, ordered by the median start offset in the run. The Δ baseline
 * reads `all` (the runs of the fetched span, the previous period included), the rest reads `runs`.
 */
export function jobsTable(runs: readonly CiRun[], all: readonly CiRun[]): JobRow[] {
  const history = jobHistory(all);
  const rows: { row: JobRow; offset: number }[] = [];
  for (const [name, points] of jobHistory(runs)) {
    if (points.length < 3) continue;
    const durations = points.filter((p) => p.status !== 'cancelled').map((p) => p.duration);
    const med = median(durations);
    const p25 = quantile(durations, 0.25);
    const p75 = quantile(durations, 0.75);
    const latest = points[points.length - 1];
    if (med === null || p25 === null || p75 === null || latest === undefined) continue;
    const good = (history.get(name) ?? []).filter((p) => p.status === 'success').map((p) => p.duration);
    const recent = good.slice(-10);
    const base = good.slice(-30, -10);
    const deltaB = recent.length >= 3 && base.length >= 3 ? median(recent) : null;
    const deltaA = recent.length >= 3 && base.length >= 3 ? median(base) : null;
    const offsets = points.map((p) => {
      const j = p.run.jobs.find((x) => x.name === name);
      return j === undefined ? 0 : j.start - p.run.start;
    });
    rows.push({
      offset: median(offsets) ?? 0,
      row: {
        name,
        points,
        latest: latest.duration,
        median: med,
        p25,
        p75,
        delta: deltaA === null || deltaB === null ? null : deltaB - deltaA,
        deltaA,
        deltaB,
        failed: [points.filter((p) => p.status === 'failure').length, points.length],
      },
    });
  }
  return rows.sort((a, b) => a.offset - b.offset || (a.row.name < b.row.name ? -1 : 1)).map((x) => x.row);
}

// ---------------------------------------------------------------------------------------------------------------
// Status grid

export interface GridRow {
  job: string;
  cells: (CiStatus | null)[];
  failed: number;
  ran: number;
}

const SEVERITY: Record<CiStatus, number> = { success: 0, cancelled: 1, failure: 2 };

/** Jobs × the last `last` runs (oldest first); a cell is null when the job did not run in that run. */
export function statusGrid(runs: readonly CiRun[], last: number): { runs: CiRun[]; rows: GridRow[] } {
  const shown = [...runs].sort((a, b) => a.start - b.start).slice(-last);
  const order = jobsOrder(shown);
  const rows: GridRow[] = order.map((job) => {
    const cells = shown.map((r) => {
      let worst: CiStatus | null = null;
      for (const j of r.jobs) {
        if (j.name !== job) continue;
        const s = jobStatus(j);
        if (s !== null && (worst === null || SEVERITY[s] > SEVERITY[worst])) worst = s;
      }
      return worst;
    });
    return {
      job,
      cells,
      failed: cells.filter((c) => c === 'failure').length,
      ran: cells.filter((c) => c !== null).length,
    };
  });
  return { runs: shown, rows };
}

/** Job names by median start offset. */
function jobsOrder(runs: readonly CiRun[]): string[] {
  const offsets = new Map<string, number[]>();
  for (const r of runs)
    for (const j of ranJobs(r)) {
      const list = offsets.get(j.name) ?? [];
      offsets.set(j.name, list);
      list.push(j.start - r.start);
    }
  return [...offsets]
    .map(([name, o]) => ({ name, at: median(o) ?? 0 }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1))
    .map((x) => x.name);
}

// ---------------------------------------------------------------------------------------------------------------
// Failures

export interface FailureEntry {
  run: CiRun;
  failed: CiJob[];
}

/** The latest `limit` failed runs, newest first, with their failed jobs. */
export function failures(runs: readonly CiRun[], limit: number): FailureEntry[] {
  return [...runs]
    .filter((r) => r.result === 'failure')
    .sort((a, b) => b.start - a.start)
    .slice(0, limit)
    .map((run) => ({ run, failed: run.jobs.filter((j) => jobStatus(j) === 'failure') }));
}

// ---------------------------------------------------------------------------------------------------------------
// Triggers

export interface TriggerRow {
  trigger: string;
  runs: number;
  passedShare: number;
  jobs: number;
  always: number;
  chips: { names: string[]; share: number; count: number }[];
}

export function triggers(runs: readonly CiRun[]): TriggerRow[] {
  const groups = new Map<string, CiRun[]>();
  for (const r of runs) {
    const k = r.trigger ?? '(none)';
    const list = groups.get(k) ?? [];
    groups.set(k, list);
    list.push(r);
  }
  const rows: TriggerRow[] = [];
  for (const [trigger, rs] of groups) {
    const ran = new Map<string, number>();
    for (const r of rs)
      for (const n of new Set(ranJobs(r).map((j) => j.name))) ran.set(n, (ran.get(n) ?? 0) + 1);
    const ok = notCancelled(rs);
    const byCount = new Map<number, string[]>();
    let always = 0;
    for (const [name, n] of [...ran].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (n === rs.length) always++;
      else byCount.set(n, [...(byCount.get(n) ?? []), name]);
    }
    rows.push({
      trigger,
      runs: rs.length,
      passedShare: ok.length === 0 ? 0 : ok.filter((r) => r.result === 'success').length / ok.length,
      jobs: ran.size,
      always,
      chips: [...byCount]
        .sort((a, b) => b[0] - a[0])
        .map(([count, names]) => ({ names, share: count / rs.length, count })),
    });
  }
  return rows.sort((a, b) => b.runs - a.runs || (a.trigger < b.trigger ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Queue

export interface QueueRow {
  label: string;
  p50: number;
  p95: number;
  max: number;
  n: number;
}

/** Queue wait per runner label (null is "(no label)"); labels with fewer than 5 jobs are left out. */
export function queue(runs: readonly CiRun[]): QueueRow[] {
  const byLabel = new Map<string, number[]>();
  for (const r of runs) {
    for (const j of ranJobs(r)) {
      if (j.queuedNs === null || !Number.isFinite(j.queuedNs)) continue;
      const k = j.labels ?? '(no label)';
      const list = byLabel.get(k) ?? [];
      byLabel.set(k, list);
      list.push(j.queuedNs);
    }
  }
  const rows: QueueRow[] = [];
  for (const [label, waits] of byLabel) {
    const p50 = quantile(waits, 0.5);
    const p95 = quantile(waits, 0.95);
    if (waits.length < 5 || p50 === null || p95 === null) continue;
    rows.push({ label, p50, p95, max: Math.max(...waits), n: waits.length });
  }
  return rows.sort((a, b) => b.p95 - a.p95 || (a.label < b.label ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Minutes per day

export interface MinutesDay {
  /** Local midnight, in ms since the Unix epoch. */
  day: number;
  total: number;
  parts: { key: string; minutes: number }[];
}

const TOP_JOBS = 7;

/**
 * CI minutes per local day of the run's start, split by trigger or by job (the top 7 by minutes, then "Other").
 * `epochNs` is the report epoch (Unix ns), which turns run-relative starts into days. Days with no run are kept
 * between the first and the last.
 */
export function minutesPerDay(
  runs: readonly CiRun[],
  by: 'trigger' | 'job',
  epochNs: bigint,
): { keys: string[]; days: MinutesDay[] } {
  if (runs.length === 0) return { keys: [], days: [] };
  const dayOf = (r: CiRun): number => {
    const d = new Date(Number(epochNs / 1_000_000n) + r.start / 1e6);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const parts = (r: CiRun): [string, number][] =>
    by === 'trigger'
      ? [[r.trigger ?? '(none)', minutesOf(r.jobs)]]
      : ranJobs(r).map((j): [string, number] => [j.name, jobDuration(j) / MIN]);
  const totals = new Map<string, number>();
  for (const r of runs) for (const [k, m] of parts(r)) totals.set(k, (totals.get(k) ?? 0) + m);
  let keys = [...totals].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k]) => k);
  const top = new Set(by === 'job' ? keys.slice(0, TOP_JOBS) : keys);
  if (by === 'job' && keys.length > TOP_JOBS) keys = [...keys.slice(0, TOP_JOBS), 'Other'];
  const perDay = new Map<number, Map<string, number>>();
  for (const r of runs) {
    const m = perDay.get(dayOf(r)) ?? new Map<string, number>();
    perDay.set(dayOf(r), m);
    for (const [k, v] of parts(r))
      m.set(top.has(k) ? k : 'Other', (m.get(top.has(k) ? k : 'Other') ?? 0) + v);
  }
  const stamps = [...perDay.keys()].sort((a, b) => a - b);
  const days: MinutesDay[] = [];
  const last = stamps[stamps.length - 1] ?? 0;
  for (
    let d = new Date(stamps[0] ?? 0);
    d.getTime() <= last;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    const m = perDay.get(d.getTime()) ?? new Map<string, number>();
    const ps = keys.map((key) => ({ key, minutes: m.get(key) ?? 0 }));
    days.push({ day: d.getTime(), total: ps.reduce((s, p) => s + p.minutes, 0), parts: ps });
  }
  return { keys, days };
}

// ---------------------------------------------------------------------------------------------------------------
// Reruns and cancelled

export function rerunsAndCancelled(runs: readonly CiRun[]): {
  reruns: number;
  rerunRuns: CiRun[];
  cancelled: number;
  cancelledRuns: CiRun[];
} {
  const rerunRuns = runs.filter((r) => r.attempts > 1);
  const cancelledRuns = runs.filter((r) => r.result === 'cancelled');
  return { reruns: rerunsOf(runs), rerunRuns, cancelled: cancelledRuns.length, cancelledRuns };
}
