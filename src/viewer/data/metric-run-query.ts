import type { LevelData, LoadedMetric, LoadedSeries } from './metric-load.js';
import { coarsenedTo, type MetricQuery, runAtLevel } from './metric-query.js';
import { checkShow, kindOf } from './metric-tables.js';
import { compileSelector, targetOf } from './metric-where.js';
import type { TimeWindow } from './span-query.js';

// One value per line per run of a metric (spec §6): the data of a run chart.

export interface RunInfo {
  id: string;
  /** RelNanos: the start of the bucket holding the run's last point at the finest level. */
  time: number;
  revision: string | null;
}

export interface RunPoint {
  value: number;
  failed: boolean;
}

export interface RunLine {
  key: string;
  label: string;
  unit: string;
  /** Aligned with `runs`; null where the line has no point in that run. */
  points: (RunPoint | null)[];
}

export interface RunQueryResult {
  queryId: string;
  runs: RunInfo[];
  lines: RunLine[];
  /** Series with data that no run could be read for: no run id, or folded into `other`. */
  leftOut: number;
  /** The window the query covered, echoed so a chart can tell when it changed. */
  window: TimeWindow;
  notes: string[];
}

const leftOutNote = (n: number, runBy: string): string =>
  `${n} series ${n === 1 ? 'has' : 'have'} no value for ${runBy} and ${n === 1 ? 'is' : 'are'} left out`;

/** One run's series, in the finest level's own ids. */
interface Run {
  id: string;
  members: LoadedSeries[];
  time: number;
}

/**
 * Runs `q` once per CI run: the series are grouped by `opts.runBy` (a series' run is known from its definition),
 * and each run's points merge into one bucket per line through `runAtLevel`, so `where`, `by` and `show` act as
 * in a time chart. A run's time is its latest point; it is in the window if that time is. Reads the finest level
 * whole, so a window edge never cuts the points of a run whose time is inside it.
 */
export async function runMetricRunQuery(
  m: LoadedMetric,
  q: MetricQuery,
  opts: { window: TimeWindow; runBy: string; failedWhen: string | null },
  signal?: AbortSignal,
): Promise<RunQueryResult> {
  checkShow(kindOf(m.entry), q.show);
  const finest = m.levels[0];
  const level = finest === undefined ? null : await m.level(finest.level);
  signal?.throwIfAborted();

  const empty = (notes: string[] = []): RunQueryResult => ({
    queryId: q.id,
    runs: [],
    lines: [],
    leftOut: 0,
    window: opts.window,
    notes,
  });
  if (level === null) return empty();

  const where = compileSelector(q.where, []).test;
  const runOf = compileSelector(null, [opts.runBy]);
  const failed = compileSelector(opts.failedWhen, []).test;

  const byRun = new Map<string, Run>();
  let leftOut = 0;
  for (const s of m.series) {
    const t = level.series.get(s.def.id)?.t.at(-1);
    if (t === undefined) continue;
    const target = targetOf(m.entry, s);
    if (where !== null && !s.def.other && !where(target)) continue;
    const g = s.def.other ? null : runOf.groupOf(target);
    // An empty string is as little of a run id as a missing value.
    const id = g === null || g.missing ? '' : (g.shown[0] ?? '');
    if (id === '') {
      leftOut++;
      continue;
    }
    const run = byRun.get(id) ?? { id, members: [], time: 0 };
    run.members.push(s);
    run.time = Math.max(run.time, t * level.widthNs);
    byRun.set(id, run);
  }

  const runs = [...byRun.values()]
    .filter((r) => r.time >= opts.window.start && r.time <= opts.window.end)
    .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const notes: string[] = [];
  const lines = new Map<string, RunLine>();
  for (const [i, run] of runs.entries()) {
    signal?.throwIfAborted();
    const ids = run.members.map((s) => s.def.id);
    const one = (only: readonly number[]): ReturnType<typeof runAtLevel> =>
      runAtLevel(m, { ...q, fn: [] }, ...oneBucket(level, only), null, signal);
    const result = one(ids);
    for (const n of result.notes) if (!notes.includes(n)) notes.push(n);
    // A line failed in this run when a failing series of the run feeds it: the run again over those series alone.
    const failing =
      failed === null ? [] : run.members.filter((s) => failed(targetOf(m.entry, s))).map((s) => s.def.id);
    const failedKeys = new Set(failing.length === 0 ? [] : one(failing).series.map((s) => s.key));
    for (const s of result.series) {
      const value = s.points.find(([, v]) => v !== null)?.[1];
      if (value === null || value === undefined) continue;
      let line = lines.get(s.key);
      if (line === undefined) {
        line = { key: s.key, label: s.label, unit: s.unit, points: runs.map(() => null) };
        lines.set(s.key, line);
      }
      line.points[i] = { value, failed: failedKeys.has(s.key) };
    }
  }
  if (leftOut > 0) notes.push(leftOutNote(leftOut, opts.runBy));

  return {
    ...empty(notes),
    runs: runs.map((r) => ({
      id: r.id,
      time: r.time,
      revision: revisionOf(r.members),
    })),
    lines: [...lines.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
    leftOut,
  };
}

/**
 * `runAtLevel`'s window and level for the series `only` of `level` merged into a single bucket: a width past the
 * last point puts every point in bucket 0, and the window covers that bucket.
 */
function oneBucket(level: LevelData, only: readonly number[]): [TimeWindow, LevelData] {
  const keep = new Set(only);
  const series = new Map([...level.series].filter(([id]) => keep.has(id)));
  const last = Math.max(0, ...[...series.values()].map((s) => s.t.at(-1) ?? 0));
  const widthNs = (last + 1) * level.widthNs;
  return [{ start: 0, end: widthNs - 1 }, coarsenedTo({ ...level, series }, widthNs)];
}

function revisionOf(members: readonly LoadedSeries[]): string | null {
  for (const s of members) {
    const v = s.resource?.attributes.get('vcs.ref.head.revision');
    if (v?.kind === 'string') return v.value;
  }
  return null;
}
