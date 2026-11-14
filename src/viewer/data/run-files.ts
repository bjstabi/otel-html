import type { Table } from '@uwdata/flechette';
import { parseCondition } from '../../ottl/parse.js';
import { canonical } from '../../query/metric-paths.js';
import type { ByExpr } from '../../query/sql/points.js';
import type { SeriesRow } from './metric-results.js';
import { cell, rowsOf, toNumber } from './span-results.js';

// The pure parts of a metric run query's file selection (spec 5.2): which statistics key names a run, and which runs
// and series the catalogue's rows answer without reading a points file.

/** `resource.attributes["K"]` is the statistics key `resource:K` of the points files; any other expression has none. */
export function runStatisticsKey(runBy: string): string | null {
  let e: ReturnType<typeof parseCondition>;
  try {
    e = parseCondition(runBy);
  } catch {
    return null;
  }
  if (e.type !== 'value' || e.value.type !== 'path') return null;
  const [key, ...more] = e.value.keys;
  if (canonical(e.value).join('.') !== 'resource.attributes' || typeof key !== 'string' || more.length > 0)
    return null;
  return `resource:${key}`;
}

/** Keys a JSON pointer reads differently from OTTL (array indices, `$` maps): their run value is left to SQL. */
const PLAIN_KEY = /^(?!\d+$|-$|\$|__proto__$)/;

/**
 * The number of distinct series ids among `series` that pass `test` and have no run value (the key is missing, null or
 * an empty string), as `seriesQuery` and the `runsQuery`'s left row count them. Null when `runBy` is not
 * `resource.attributes["K"]` with a plain key: the run value is then SQL's to evaluate.
 */
export function leftOutOf(
  series: readonly SeriesRow[],
  test: (row: SeriesRow) => boolean,
  runBy: ByExpr,
): number | null {
  const stat = runStatisticsKey(runBy.src);
  if (stat === null) return null;
  const key = stat.slice('resource:'.length);
  if (!PLAIN_KEY.test(key)) return null;
  const ids = new Set<string>();
  for (const row of series) {
    const v = row.resource.attributes.get(key);
    const none = v === undefined || v.kind === 'empty' || (v.kind === 'string' && v.value === '');
    if (none && test(row)) ids.add(row.seriesId);
  }
  return ids.size;
}

/** The run texts (`g0`) of a `runsQuery` result whose latest point lies in `window`: the rule `runsFrom` applies. */
export function runsInWindow(runs: Table, window: { start: number; end: number }): string[] {
  const out: string[] = [];
  for (const row of rowsOf(runs)) {
    const text = cell(row, 'run');
    if (typeof text !== 'string') continue;
    const time = toNumber(cell(row, 't'), 't');
    if (time < window.start || time > window.end) continue;
    out.push(text);
  }
  return out;
}

/**
 * The statistics values naming `runs` (JSON texts of the run expression). Null when a run is not a string: a number's
 * statistic text need not equal its JSON text, so nothing is pruned on it.
 */
export function runValues(runs: readonly string[]): ReadonlySet<string> | null {
  const out = new Set<string>();
  for (const text of runs) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof v !== 'string') return null;
    out.add(v);
  }
  return out;
}
