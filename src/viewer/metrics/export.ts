import { csvCell } from '../components/export.js';
import type { MetricQueryResult } from '../data/metric-query.js';

const HEADER = ['time', 'query', 'series', 'value'] as const;

/**
 * The charted series as CSV: one row per point, `time` being the bucket start in nanoseconds relative to the run's
 * epoch (like the span and log exports). A gap has an empty value.
 */
export function exportMetricCsv(results: readonly MetricQueryResult[]): string {
  const rows: string[] = [HEADER.join(',')];
  for (const r of results)
    for (const s of r.series)
      for (const [t, v] of s.points)
        rows.push([csvCell(t), csvCell(r.queryId), csvCell(s.label), v === null ? '' : csvCell(v)].join(','));
  return rows.join('\r\n');
}

/** The charted series as JSON: per query its bucket width, notes and series (no OTLP export for derived series). */
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
    })),
  );
}
