import { csvCell } from '../components/export.js';
import type { MetricQueryResult } from '../data/metric-query.js';

const HEADER = ['time', 'query', 'series', 'value'] as const;

/** The label of histogram bucket `i` of `bounds`: `≤b` up to the last bound, then `>b`. */
function bucketLabel(bounds: readonly number[], i: number): string {
  const b = bounds[i];
  return b === undefined ? `>${bounds[bounds.length - 1] ?? ''}` : `≤${b}`;
}

/**
 * The charted series as CSV: one row per point, `time` being the bucket start in nanoseconds relative to the run's
 * epoch (like the span and log exports). A gap has an empty value. A histogram query's heatmap follows as one row
 * per cell (`series` is `heat ≤bound`), and its distribution as one row per bucket with no time.
 */
export function exportMetricCsv(results: readonly MetricQueryResult[]): string {
  const rows: string[] = [HEADER.join(',')];
  const row = (t: number | null, query: string, series: string, v: number | null): void => {
    rows.push(
      [t === null ? '' : csvCell(t), csvCell(query), csvCell(series), v === null ? '' : csvCell(v)].join(','),
    );
  };
  for (const r of results) {
    for (const s of r.series) for (const [t, v] of s.points) row(t, r.queryId, s.label, v);
    if (r.heat !== null)
      for (const [t, i, n] of r.heat.cells) row(t, r.queryId, `heat ${bucketLabel(r.heat.bounds, i)}`, n);
    if (r.distribution !== null) {
      const { bounds, counts } = r.distribution;
      for (const [i, n] of counts.entries())
        row(null, r.queryId, `distribution ${bucketLabel(bounds, i)}`, n);
    }
  }
  return rows.join('\r\n');
}

/**
 * The charted series as JSON: per query its bucket width, notes, series and, for a histogram, its heatmap cells
 * (`[time, bucket index, count]`) and distribution (no OTLP export for derived series).
 */
export function exportMetricJson(results: readonly MetricQueryResult[]): string {
  return JSON.stringify(
    results.map((r) => ({
      query: r.queryId,
      widthNs: r.widthNs,
      notes: r.notes,
      series: r.series.map((s) => ({
        key: s.key,
        label: s.label,
        group: s.group,
        unit: s.unit,
        points: s.points,
      })),
      ...(r.heat === null ? {} : { heat: r.heat }),
      ...(r.distribution === null ? {} : { distribution: r.distribution }),
    })),
  );
}
