import { describe, expect, test } from 'vitest';
import type { RelNanos } from '../../src/model/ids.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS, type LogSeverityKey } from '../../src/semconv/severity.js';
import { SEVERITY_SERIES } from '../../src/viewer/components/histogram-card.js';
import { type LogQueryResult, type LogRow, logRef } from '../../src/viewer/data/log-query.js';
import { LOG_VIEW_BUILDERS, scatter, timeseries } from '../../src/viewer/logs/views.js';
import { createColorAssigner } from '../../src/viewer/theme/palette.js';

function row(i: number, sev: number): LogRow {
  return {
    ref: logRef(0, i),
    log: { severityNumber: sev },
    time: (i * 1000) as RelNanos,
  } as unknown as LogRow;
}

function result(rows: LogRow[]): LogQueryResult {
  const buckets = new TimeBuckets<LogSeverityKey>(LOG_SEVERITY_KEYS, 8);
  buckets.add(0 as RelNanos, 'error', 3);
  buckets.add(0 as RelNanos, 'info', 5);
  return {
    mode: 'logs',
    rows,
    total: rows.length,
    matched: rows.length,
    facets: new FacetCounts(10, 10),
    buckets,
    partial: null,
  };
}

const ctx = { groupBy: null, colors: createColorAssigner(), listCap: 100 };

interface Series {
  name: string;
  data: [number, number][];
  itemStyle: { color: string };
  stack?: string;
}

function seriesOf(option: { series?: unknown }): Series[] {
  return option.series as Series[];
}

describe('log views', () => {
  test('scatter: x is the log time, y the severity number, one series per band', () => {
    const rows = [row(0, 17), row(1, 9), row(2, 10), row(3, 21), row(4, 0)];
    const series = seriesOf(scatter(result(rows), ctx));
    const points = series.flatMap((s) => s.data);
    expect(points.map(([, y]) => y).sort((a, b) => a - b)).toEqual([0, 9, 10, 17, 21]);
    for (const [x, y] of points) expect(rows.find((r) => r.time === x)?.log.severityNumber).toBe(y);
    const info = series.find((s) => s.name === 'INFO');
    expect(info?.data).toEqual([
      [1000, 9],
      [2000, 10],
    ]);
    // Every band is its own series, coloured by its severity token.
    for (const s of series) {
      expect(SEVERITY_SERIES.series.find((x) => x.label === s.name)?.color).toBe(s.itemStyle.color);
    }
  });

  test('scatter draws at most listCap points', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, 9));
    const points = seriesOf(scatter(result(rows), { ...ctx, listCap: 4 })).flatMap((s) => s.data);
    expect(points).toHaveLength(4);
  });

  test('scatter has no points outside logs mode', () => {
    const r: LogQueryResult = { ...result([]), mode: 'traces', rows: [] };
    expect(seriesOf(scatter(r, ctx)).flatMap((s) => s.data)).toEqual([]);
  });

  test('timeseries stacks the counts of each severity band in the severity colours', () => {
    const option = timeseries(result([]));
    const series = seriesOf(option);
    const labels = SEVERITY_SERIES.series.map((s) => s.label);
    // The legend reads most severe first; the stack draws fatal on top (ECharts stacks the first series lowest).
    expect((option.legend as { data: string[] }).data).toEqual(labels);
    expect(series.map((s) => s.name)).toEqual([...labels].reverse());
    expect(new Set(series.map((s) => s.stack))).toEqual(new Set(['severity']));
    const error = series.find((s) => s.name === 'ERROR');
    expect(error?.itemStyle.color).toBe('var(--oh-sev-error)');
    expect((error?.data ?? [])[0]).toBe(3);
  });

  test('every chart view has a builder', () => {
    expect(Object.keys(LOG_VIEW_BUILDERS).sort()).toEqual(
      ['bar', 'pie', 'scatter', 'timeseries', 'toplist', 'treemap'].sort(),
    );
  });
});
