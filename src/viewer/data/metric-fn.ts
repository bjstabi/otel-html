import { OtelHtmlError } from '../../model/errors.js';
import type { MetricFn, SeriesPoints } from './metric-query.js';

type Point = [number, number | null];

function usage(path: string, expected: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('usage', { path, expected, actual });
}

/** Each value minus the previous bucket's; null when either is a gap. */
function differences(points: readonly Point[], scale: number): Point[] {
  return points.map(([t, v], i) => {
    const prev = points[i - 1]?.[1];
    return [t, v === null || prev === undefined || prev === null ? null : (v - prev) * scale];
  });
}

const ROLLUP: Record<Extract<MetricFn, { op: 'rollup' }>['agg'], (xs: readonly number[]) => number> = {
  avg: (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  min: (xs) => xs.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY),
  max: (xs) => xs.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY),
};

/** Re-buckets onto `intervalNs`: each new bucket aggregates the non-null values falling in it. */
function rollup(
  points: readonly Point[],
  intervalNs: number,
  agg: (xs: readonly number[]) => number,
): Point[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return [];
  const b0 = Math.floor(first[0] / intervalNs);
  const bins: number[][] = Array.from({ length: Math.floor(last[0] / intervalNs) - b0 + 1 }, () => []);
  for (const [t, v] of points) if (v !== null) bins[Math.floor(t / intervalNs) - b0]?.push(v);
  return bins.map((xs, i) => [(b0 + i) * intervalNs, xs.length === 0 ? null : agg(xs)]);
}

const SCORE: Record<Extract<MetricFn, { n: number }>['by'], (xs: readonly number[]) => number> = {
  avg: (xs) => xs.reduce((a, b) => a + b, 0) / xs.length,
  max: (xs) => xs.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY),
  last: (xs) => xs[xs.length - 1] ?? Number.NaN,
};

function ranked(series: readonly SeriesPoints[], fn: Extract<MetricFn, { n: number }>): SeriesPoints[] {
  if (!Number.isInteger(fn.n) || fn.n < 1) throw usage(`fn ${fn.op}.n`, 'a whole number ≥ 1', String(fn.n));
  const score = SCORE[fn.by];
  const sign = fn.op === 'top' ? -1 : 1;
  return series
    .map((s) => {
      const xs = s.points.flatMap(([, v]) => (v === null ? [] : [v]));
      return { s, score: xs.length === 0 ? Number.NaN : score(xs) };
    })
    .sort((a, b) => {
      // Series without values rank last either way.
      if (Number.isNaN(a.score)) return Number.isNaN(b.score) ? 0 : 1;
      if (Number.isNaN(b.score)) return -1;
      return sign * (a.score - b.score);
    })
    .slice(0, fn.n)
    .map((x) => x.s);
}

const perSecond = (unit: string): string => `${unit === '' ? '1' : unit}/s`;

/** Applies the query's ƒ list in order. `widthNs` is the bucket width the points sit on. */
export function applyFns(
  input: readonly SeriesPoints[],
  inputWidthNs: number,
  fns: readonly MetricFn[],
): { series: SeriesPoints[]; widthNs: number } {
  let series = [...input];
  let widthNs = inputWidthNs;
  for (const fn of fns) {
    switch (fn.op) {
      case 'increase':
        series = series.map((s) => ({ ...s, points: differences(s.points, 1) }));
        break;
      case 'rate': {
        const scale = 1e9 / widthNs;
        series = series.map((s) => ({ ...s, unit: perSecond(s.unit), points: differences(s.points, scale) }));
        break;
      }
      case 'rollup': {
        if (!Number.isFinite(fn.intervalMs) || fn.intervalMs <= 0)
          throw usage('fn rollup.intervalMs', 'a positive interval', String(fn.intervalMs));
        const intervalNs = fn.intervalMs * 1e6;
        // Rolling up can only coarsen; a finer interval leaves the buckets as they are.
        if (intervalNs <= widthNs) break;
        const agg = ROLLUP[fn.agg];
        series = series.map((s) => ({ ...s, points: rollup(s.points, intervalNs, agg) }));
        widthNs = intervalNs;
        break;
      }
      case 'top':
      case 'bottom':
        series = ranked(series, fn);
        break;
      default: {
        const never: never = fn;
        throw usage('fn', 'a known function', JSON.stringify(never));
      }
    }
  }
  return { series, widthNs };
}
