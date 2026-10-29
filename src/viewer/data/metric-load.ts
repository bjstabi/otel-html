import { reviveDataJson } from '../../format/data-file.js';
import type { Manifest } from '../../format/manifest.js';
import {
  type BucketSeries,
  bucketRange,
  dataFileKey,
  deriveLevels,
  EXEMPLAR_BASE_LEVEL,
  LEVEL0_WIDTH_NS,
  type LevelFile,
  levelCount,
  levelWidthNs,
  MAX_LEVEL,
  mergeBucketSeries,
  metricDir,
  metricExemplarPath,
  metricLevelExemplarPath,
  metricLevelKey,
  metricLevelPath,
  metricSegmentKey,
  metricSegmentPath,
  metricSeriesKey,
  metricSeriesPath,
  parseExemplarFile,
  parseLevelFile,
  parseSegmentFile,
  parseSeriesFile,
  type SeriesGaps,
  type StoredExemplar,
} from '../../format/metric-files.js';
import { rollupKey, rollupPath } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import { canonicalAttributesKey } from '../../model/interner.js';
import type { ResourceRecord, ScopeRecord } from '../../model/records.js';
import type { BucketAgg } from '../../rollups/metric-agg.js';
import { MetricCatalog, type MetricEntry, type SeriesDef } from '../../rollups/metric-catalog.js';
import { METRIC_KEYS } from '../../rollups/signal-counts.js';
import { TimeBuckets } from '../../rollups/time-buckets.js';
import type { ScriptLoader } from './script-loader.js';

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
 * One metric, its levels read on demand: a chart needs one level (`chartWidthNs`), so opening a metric costs the
 * same whatever the run length.
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
  /** True when the levels were derived in memory from segments (the report is unfinished). */
  fromSegments: boolean;
  /** Level `k`, read once and kept with the metric (a failed read is tried again on the next call). */
  level(k: number): Promise<LevelData>;
}

/** A `LoadedMetric` over levels already in memory (an unfinished report's derived levels, or a test's). */
export function metricFromLevels(
  m: Pick<LoadedMetric, 'entry' | 'series' | 'gaps' | 'fromSegments'>,
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

/** Caches `read` per key; a rejected read is dropped, so the next call reads again. */
function once<K, V>(read: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const p = read(key);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
  };
}

function invalid(path: string, expected: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('invalid-report', { path, expected, actual });
}

/** Resources and scopes are only read here, so no series cap applies. */
const READ_ONLY = { seriesCap: Number.MAX_SAFE_INTEGER };

/** The `data/rollups/metrics.js` payload: an object holding the point buckets and the catalog. */
async function loadMetricRollup(
  loader: ScriptLoader,
  manifest: Manifest,
): Promise<{ path: string; payload: object }> {
  const path = rollupPath('metrics');
  if (!manifest.rollups.includes(path)) {
    throw invalid('manifest.rollups', `a listing of ${path}`, JSON.stringify(manifest.rollups));
  }
  const payload = reviveDataJson(await loader.load(path, rollupKey('metrics')));
  if (typeof payload !== 'object' || payload === null || !Object.hasOwn(payload, 'catalog')) {
    throw invalid(path, 'an object with a catalog', typeof payload);
  }
  return { path, payload };
}

/** The catalog from `data/rollups/metrics.js`. Its series definitions stay in each metric's `series.js`. */
export async function loadMetricCatalog(loader: ScriptLoader, manifest: Manifest): Promise<MetricCatalog> {
  const { path, payload } = await loadMetricRollup(loader, manifest);
  return MetricCatalog.from(Reflect.get(payload, 'catalog'), READ_ONLY, `${path}.catalog`);
}

/** Data points over time, from the same file's `buckets`: the unfiltered rollup, every resource. */
export async function loadMetricPoints(
  loader: ScriptLoader,
  manifest: Manifest,
): Promise<TimeBuckets<'points'>> {
  const { path, payload } = await loadMetricRollup(loader, manifest);
  return TimeBuckets.from(Reflect.get(payload, 'buckets'), METRIC_KEYS, `${path}.buckets`);
}

const SEGMENT_NAME = /\/seg-([0-9]{6})\.js$/;

function listedFiles(manifest: Manifest, id: number): { levels: number[]; segments: number[] } {
  const listed = new Set(manifest.metricFiles);
  const levels: number[] = [];
  for (let k = 0; k <= MAX_LEVEL; k++) if (listed.has(metricLevelPath(id, k))) levels.push(k);
  const dir = `${metricDir(id)}/`;
  const segments = manifest.metricFiles
    .filter((p) => p.startsWith(dir))
    .flatMap((p) => {
      const n = SEGMENT_NAME.exec(p)?.[1];
      return n === undefined ? [] : [Number(n)];
    })
    .sort((a, b) => a - b);
  return { levels, segments };
}

/**
 * The exemplar file charted at level `k`: its own `ex<k>.js` above EXEMPLAR_BASE_LEVEL, else `ex.js` (all a format-1
 * report has); null when the metric has none.
 */
function exemplarFileOf(manifest: Manifest, id: number, k: number): string | null {
  const own = k > EXEMPLAR_BASE_LEVEL ? metricLevelExemplarPath(id, k) : null;
  if (own !== null && manifest.metricFiles.includes(own)) return own;
  const base = metricExemplarPath(id);
  return manifest.metricFiles.includes(base) ? base : null;
}

function expectMetric(actual: number, id: number, path: string): void {
  if (actual !== id) throw invalid(`${path}.metric`, String(id), String(actual));
}

function toLevelData(
  level: number,
  series: readonly BucketSeries[],
  exemplars: readonly StoredExemplar[],
): LevelData {
  return {
    level,
    widthNs: levelWidthNs(level),
    series: new Map(series.map((s) => [s.id, { t: s.t, a: s.a }])),
    exemplars,
  };
}

async function loadSeriesDefs(
  loader: ScriptLoader,
  manifest: Manifest,
  entry: MetricEntry,
): Promise<{ defs: readonly SeriesDef[]; gaps: readonly SeriesGaps[] | null }> {
  const path = metricSeriesPath(entry.id);
  if (!manifest.metricFiles.includes(path)) {
    if (entry.series === 0) return { defs: [], gaps: null };
    throw invalid('manifest.metricFiles', `a listing of ${path}`, 'not listed');
  }
  const file = parseSeriesFile(reviveDataJson(await loader.load(path, metricSeriesKey(entry.id))), path);
  expectMetric(file.metric, entry.id, path);
  // A flush that never committed may have added series past the catalog's count; they are not part of the report.
  if (file.series.length < entry.series) {
    throw invalid(`${path}.series`, `at least ${entry.series} series`, String(file.series.length));
  }
  return {
    defs: file.series.slice(0, entry.series),
    gaps: file.gaps === undefined ? null : file.gaps.slice(0, entry.series),
  };
}

async function loadExemplars(loader: ScriptLoader, id: number, path: string): Promise<StoredExemplar[]> {
  const f = parseExemplarFile(reviveDataJson(await loader.load(path, dataFileKey(path))), path);
  expectMetric(f.metric, id, path);
  return f.exemplars;
}

async function loadLevelFile(loader: ScriptLoader, id: number, k: number): Promise<LevelFile> {
  const path = metricLevelPath(id, k);
  const f = parseLevelFile(reviveDataJson(await loader.load(path, metricLevelKey(id, k))), path);
  expectMetric(f.metric, id, path);
  if (f.level !== k) throw invalid(`${path}.level`, String(k), String(f.level));
  return f;
}

/**
 * One metric: its series definitions and its resolution ladder. A finished report has level and exemplar files, and
 * each level is read when a chart first needs it (`LoadedMetric.level`). An unfinished one lists segments: they all
 * merge into level 0 and levels 0…K (the compaction rule, `levelCount`) are derived in memory, so its cost still
 * grows with the run until the writer compacts it at close.
 */
export async function loadMetric(
  loader: ScriptLoader,
  manifest: Manifest,
  id: number,
  /** The already loaded catalog (`loadMetricCatalog`), to avoid reading it again. */
  loaded?: MetricCatalog,
): Promise<LoadedMetric> {
  const catalog = loaded ?? (await loadMetricCatalog(loader, manifest));
  const entry = catalog.entries()[id];
  if (entry === undefined) {
    throw new OtelHtmlError('usage', {
      path: `metric ${id}`,
      expected: 'a metric in the report',
      actual: 'not found',
    });
  }
  const files = listedFiles(manifest, id);
  const resources = catalog.resources();
  const scopes = catalog.scopes();
  const { defs, gaps } = await loadSeriesDefs(loader, manifest, entry);
  const series = defs.map((def): LoadedSeries => {
    const path = metricSeriesPath(id);
    const resource = def.other ? null : resources[def.resource];
    const scope = def.other ? null : scopes[def.scope];
    if (resource === undefined)
      throw invalid(`${path}.series[${def.id}].resource`, 'a catalog resource', String(def.resource));
    if (scope === undefined)
      throw invalid(`${path}.series[${def.id}].scope`, 'a catalog scope', String(def.scope));
    return { def, resource, scope };
  });
  if (files.segments.length > 0) return loadFromSegments(loader, manifest, entry, series, files);
  // Levels sharing `ex.js` share its read.
  const exemplarsOf = once((path: string) => loadExemplars(loader, id, path));
  const levelOf = once(async (k: number): Promise<LevelData> => {
    if (!files.levels.includes(k)) throw notInLadder(id, k);
    const ex = exemplarFileOf(manifest, id, k);
    const [f, exemplars] = await Promise.all([
      loadLevelFile(loader, id, k),
      ex === null ? Promise.resolve([]) : exemplarsOf(ex),
    ]);
    return toLevelData(k, f.series, exemplars);
  });
  return {
    entry,
    series,
    levels: files.levels.map((k) => ({ level: k, widthNs: levelWidthNs(k) })),
    gaps,
    fromSegments: false,
    level: levelOf,
  };
}

/** An unfinished report's metric: every segment (and a level 0 left listed beside them) merged, levels derived. */
async function loadFromSegments(
  loader: ScriptLoader,
  manifest: Manifest,
  entry: MetricEntry,
  series: readonly LoadedSeries[],
  files: { levels: number[]; segments: number[] },
): Promise<LoadedMetric> {
  const id = entry.id;
  const ex = exemplarFileOf(manifest, id, 0);
  const [l0, segFiles, exemplars] = await Promise.all([
    files.levels.includes(0) ? loadLevelFile(loader, id, 0) : Promise.resolve(null),
    Promise.all(
      files.segments.map(async (n) => {
        const path = metricSegmentPath(id, n);
        const f = parseSegmentFile(reviveDataJson(await loader.load(path, metricSegmentKey(id, n))), path);
        expectMetric(f.metric, id, path);
        if (f.widthNs !== LEVEL0_WIDTH_NS)
          throw invalid(`${path}.widthNs`, String(LEVEL0_WIDTH_NS), String(f.widthNs));
        return f;
      }),
    ),
    ex === null ? Promise.resolve([]) : loadExemplars(loader, id, ex),
  ]);
  const merged = mergeBucketSeries(
    [...(l0 === null ? [] : [l0.series]), ...segFiles.map((f) => f.series)],
    metricDir(id),
  );
  // Exemplars are not thinned per level here: like the buckets, they grow with the run until compaction.
  const all = [...exemplars, ...segFiles.flatMap((f) => f.exemplars)];
  const range = bucketRange(merged);
  const count = range === null ? 0 : levelCount(range.min * LEVEL0_WIDTH_NS, range.max * LEVEL0_WIDTH_NS);
  const levels = count === 0 ? [] : deriveLevels(merged, count).map((s, k) => toLevelData(k, s, all));
  return metricFromLevels({ entry, series, gaps: null, fromSegments: true }, levels);
}

/** Canonical identity of a resource: what `metricsOnResources` matches on. */
export const resourceKey = (r: ResourceRecord): string =>
  JSON.stringify([r.schemaUrl, r.droppedAttributesCount, canonicalAttributesKey(r.attributes)]);

/** Catalog entries with a series on one of `resources`, matched by canonical resource equality. */
export function metricsOnResources(
  catalog: MetricCatalog,
  resources: readonly ResourceRecord[],
): readonly MetricEntry[] {
  const wanted = new Set(resources.map(resourceKey));
  const refs = new Set(catalog.resources().flatMap((r, i) => (wanted.has(resourceKey(r)) ? [i] : [])));
  return catalog.entries().filter((e) => e.resources.some((r) => refs.has(r)));
}
