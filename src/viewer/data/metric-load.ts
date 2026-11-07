import type { SeriesGaps, StoredExemplar } from '../../format/metric-files.js';
import { OtelHtmlError } from '../../model/errors.js';
import { canonicalAttributesKey } from '../../model/interner.js';
import type { ResourceRecord, ScopeRecord } from '../../model/records.js';
import type { BucketAgg } from '../../rollups/metric-agg.js';
import type { MetricEntry, SeriesDef } from '../../rollups/metric-catalog.js';
import type { TimeWindow } from './time-window.js';

export interface LoadedSeries {
  def: SeriesDef;
  /** Null for the `other` series, which belongs to no single resource. */
  resource: ResourceRecord | null;
  scope: ScopeRecord | null;
}

/** One rung of a metric's resolution ladder, known from the manifest before its file is read. */
export interface LevelInfo {
  level: number;
  widthNs: number;
}

/** A level's buckets per series and the exemplars charted at it. */
export interface LevelData extends LevelInfo {
  series: Map<number, { t: number[]; a: BucketAgg[] }>;
  exemplars: readonly StoredExemplar[];
}

/**
 * One metric, its levels read on demand: a chart needs one level (`chartWidthNs`) over its window, so opening a
 * metric costs the same whatever the run length, and a chart's reads are bounded by the window it draws (#38).
 */
export interface LoadedMetric {
  entry: MetricEntry;
  series: readonly LoadedSeries[];
  /** The ladder, finest first. */
  levels: readonly LevelInfo[];
  /**
   * Per series (by id), its point gaps from `series.js`; null when the report has none (unfinished, or format 1),
   * and the bucket width measures them on the finest level instead.
   */
  gaps: readonly SeriesGaps[] | null;
  /**
   * A summary metric's quantiles from `series.js` (every one any series sent); null when the report has none
   * (unfinished, or written before they were recorded), and the show options come from a level instead.
   */
  quantiles: readonly number[] | null;
  /** True when the levels were derived in memory from segments (the report is unfinished). */
  fromSegments: boolean;
  /**
   * Level `k` over `window`: every bucket and exemplar in the window, and whatever else the files holding them
   * carry (a level in one file comes whole; one in pages, format 3, comes as the pages the window touches, so the
   * buckets around the window, up to a page each side). Without a window, the whole level. Files are read once and
   * kept with the metric (a failed read is tried again on the next call).
   */
  level(k: number, window?: TimeWindow): Promise<LevelData>;
}

/** A `LoadedMetric` over levels already in memory (an unfinished report's derived levels, or a test's). */
export function metricFromLevels(
  m: Pick<LoadedMetric, 'entry' | 'series' | 'gaps' | 'quantiles' | 'fromSegments'>,
  levels: readonly LevelData[],
): LoadedMetric {
  const byLevel = new Map(levels.map((l) => [l.level, l]));
  return {
    ...m,
    levels: [...levels]
      .sort((a, b) => a.widthNs - b.widthNs)
      .map(({ level, widthNs }) => ({ level, widthNs })),
    level: (k) => {
      const l = byLevel.get(k);
      return l === undefined ? Promise.reject(notInLadder(m.entry.id, k)) : Promise.resolve(l);
    },
  };
}

function notInLadder(id: number, k: number): OtelHtmlError {
  return new OtelHtmlError('usage', {
    path: `metric ${id} level`,
    expected: 'a level of the metric',
    actual: String(k),
  });
}

/** Canonical identity of a resource: what resource matching uses. */
export const resourceKey = (r: ResourceRecord): string =>
  JSON.stringify([r.schemaUrl, r.droppedAttributesCount, canonicalAttributesKey(r.attributes)]);
