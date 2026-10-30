import { reviveDataJson } from '../../format/data-file.js';
import type { Manifest } from '../../format/manifest.js';
import {
  type BucketSeries,
  bucketRange,
  dataFileKey,
  deriveLevels,
  EXEMPLAR_BASE_LEVEL,
  groupMetricFiles,
  LEVEL0_WIDTH_NS,
  type LevelFile,
  levelCount,
  levelWidthNs,
  type MetricFiles,
  mergeBucketSeries,
  metricDir,
  metricExemplarFilePath,
  metricLevelFilePath,
  metricSegmentKey,
  metricSegmentPath,
  metricSeriesKey,
  metricSeriesPath,
  pagesIn,
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
import type { TimeWindow } from './span-query.js';

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

/** Caches `read` per `keyOf(...args)`; a rejected read is dropped, so the next call reads again. */
function once<A extends unknown[], V>(
  read: (args: A) => Promise<V>,
  keyOf: (...args: A) => string,
): (args: A) => Promise<V> {
  const cache = new Map<string, Promise<V>>();
  return (args) => {
    const key = keyOf(...args);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const p = read(args);
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

const NO_FILES: MetricFiles = { series: false, segments: [], levels: new Map(), exemplars: new Map() };

/**
 * The exemplar level charted at level `k`: its own (`ex<k>.js`) above EXEMPLAR_BASE_LEVEL when the metric has it,
 * else EXEMPLAR_BASE_LEVEL (`ex.js`, all a format-1 report has); null when the metric has no exemplar file.
 */
function exemplarLevelOf(files: MetricFiles, k: number): number | null {
  if (k > EXEMPLAR_BASE_LEVEL && files.exemplars.has(k)) return k;
  return files.exemplars.has(EXEMPLAR_BASE_LEVEL) ? EXEMPLAR_BASE_LEVEL : null;
}

function expectMetric(actual: number, id: number, path: string): void {
  if (actual !== id) throw invalid(`${path}.metric`, String(id), String(actual));
}

/**
 * `pages` of one level (in page order, or one whole file) as `LevelData`: a series' buckets follow page order. A
 * series id at or past `seriesCount` (the catalog's committed count) is left out, like the definitions past it in
 * `series.js`: a flush that never committed may have written it.
 */
function toLevelData(
  level: number,
  pages: readonly (readonly BucketSeries[])[],
  exemplars: readonly StoredExemplar[],
  seriesCount: number,
): LevelData {
  const series = new Map<number, { t: number[]; a: BucketAgg[] }>();
  for (const page of pages) {
    for (const s of page) {
      if (s.id >= seriesCount) continue;
      const cur = series.get(s.id);
      if (cur === undefined) series.set(s.id, { t: [...s.t], a: [...s.a] });
      else {
        cur.t.push(...s.t);
        cur.a.push(...s.a);
      }
    }
  }
  return { level, widthNs: levelWidthNs(level), series, exemplars };
}

async function loadSeriesDefs(
  loader: ScriptLoader,
  manifest: Manifest,
  entry: MetricEntry,
): Promise<{
  defs: readonly SeriesDef[];
  gaps: readonly SeriesGaps[] | null;
  quantiles: readonly number[] | null;
}> {
  const path = metricSeriesPath(entry.id);
  if (!manifest.metricFiles.includes(path)) {
    if (entry.series === 0) return { defs: [], gaps: null, quantiles: null };
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
    quantiles: file.quantiles ?? null,
  };
}

function expectPage(actual: number | undefined, page: number | null, path: string): void {
  if ((actual ?? null) !== page) invalidPage(path, page, actual);
}
function invalidPage(path: string, page: number | null, actual: number | undefined): never {
  throw invalid(`${path}.page`, page === null ? 'no page (a whole file)' : String(page), String(actual));
}

/** The exemplar file of level `k` (whole, or page `page`). */
async function loadExemplars(
  loader: ScriptLoader,
  id: number,
  k: number,
  page: number | null,
): Promise<StoredExemplar[]> {
  const path = metricExemplarFilePath(id, k, page);
  const f = parseExemplarFile(reviveDataJson(await loader.load(path, dataFileKey(path))), path);
  expectMetric(f.metric, id, path);
  expectPage(f.page, page, path);
  return f.exemplars;
}

/** The level file of level `k` (whole, or page `page`). */
async function loadLevelFile(
  loader: ScriptLoader,
  id: number,
  k: number,
  page: number | null,
): Promise<LevelFile> {
  const path = metricLevelFilePath(id, k, page);
  const f = parseLevelFile(reviveDataJson(await loader.load(path, dataFileKey(path))), path);
  expectMetric(f.metric, id, path);
  if (f.level !== k) throw invalid(`${path}.level`, String(k), String(f.level));
  expectPage(f.page, page, path);
  return f;
}

/** `pages` (or the one whole file) of level `k`, through a per-file cache. */
const levelFiles = (
  file: (k: number, page: number | null) => Promise<LevelFile>,
  k: number,
  pages: readonly number[] | null,
): Promise<LevelFile[]> => Promise.all((pages ?? [null]).map((p) => file(k, p)));

const exemplarFiles = async (
  file: (k: number, page: number | null) => Promise<StoredExemplar[]>,
  k: number | null,
  pages: readonly number[] | null,
): Promise<StoredExemplar[]> =>
  k === null ? [] : (await Promise.all((pages ?? [null]).map((p) => file(k, p)))).flat();

/**
 * One metric: its series definitions and its resolution ladder. A finished report has level and exemplar files, and
 * each level is read when a chart first needs it (`LoadedMetric.level`), page by page when it has pages. An
 * unfinished one lists segments: they all merge into level 0 and levels 0…K (the compaction rule, `levelCount`) are
 * derived in memory, so its cost still grows with the run until the writer compacts it at close.
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
  const files = groupMetricFiles(manifest.metricFiles).get(id) ?? NO_FILES;
  const resources = catalog.resources();
  const scopes = catalog.scopes();
  const { defs, gaps, quantiles } = await loadSeriesDefs(loader, manifest, entry);
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
  // Every file is read once: levels 0-2 share `ex.js`, and windows share the pages they touch.
  const cachedLevelFile = once(
    ([k, page]: [number, number | null]) => loadLevelFile(loader, id, k, page),
    (k, page) => `${k}:${page}`,
  );
  const cachedExemplarFile = once(
    ([k, page]: [number, number | null]) => loadExemplars(loader, id, k, page),
    (k, page) => `${k}:${page}`,
  );
  const levelFile = (k: number, page: number | null): Promise<LevelFile> => cachedLevelFile([k, page]);
  const exemplarFile = (k: number, page: number | null): Promise<StoredExemplar[]> =>
    cachedExemplarFile([k, page]);
  if (files.segments.length > 0) {
    return loadFromSegments(
      loader,
      entry,
      series,
      files,
      (k, pages) => levelFiles(levelFile, k, pages),
      exemplarFile,
    );
  }
  const levelOf = once(
    async ([k, window]: [number, TimeWindow | undefined]): Promise<LevelData> => {
      const spec = files.levels.get(k);
      if (spec === undefined) throw notInLadder(id, k);
      const exLevel = exemplarLevelOf(files, k);
      const exPages =
        exLevel === null
          ? null
          : pagesIn(files.exemplars.get(exLevel) ?? null, window, levelWidthNs(exLevel));
      const [parts, exemplars] = await Promise.all([
        levelFiles(levelFile, k, pagesIn(spec, window, levelWidthNs(k))),
        exemplarFiles(exemplarFile, exLevel, exPages),
      ]);
      return toLevelData(
        k,
        parts.map((f) => f.series),
        exemplars,
        entry.series,
      );
    },
    // Keyed on the pages read, so equal windows share one LevelData and a whole level is built once.
    (k, window) => {
      const spec = files.levels.get(k) ?? null;
      const exLevel = exemplarLevelOf(files, k);
      const pages = pagesIn(spec, window, levelWidthNs(k));
      const exPages =
        exLevel === null
          ? null
          : pagesIn(files.exemplars.get(exLevel) ?? null, window, levelWidthNs(exLevel));
      return `${k}:${pages?.join(',') ?? '*'}:${exPages?.join(',') ?? '*'}`;
    },
  );
  return {
    entry,
    series,
    levels: [...files.levels.keys()]
      .sort((a, b) => a - b)
      .map((k) => ({ level: k, widthNs: levelWidthNs(k) })),
    gaps,
    quantiles,
    fromSegments: false,
    level: (k, window) => levelOf([k, window]),
  };
}

/** An unfinished report's metric: every segment (and a level 0 left listed beside them) merged, levels derived. */
async function loadFromSegments(
  loader: ScriptLoader,
  entry: MetricEntry,
  series: readonly LoadedSeries[],
  files: MetricFiles,
  level: (k: number, pages: readonly number[] | null) => Promise<LevelFile[]>,
  exemplarFile: (k: number, page: number | null) => Promise<StoredExemplar[]>,
): Promise<LoadedMetric> {
  const id = entry.id;
  const l0Pages = files.levels.get(0);
  const exLevel = exemplarLevelOf(files, 0);
  const [l0, segFiles, exemplars] = await Promise.all([
    l0Pages === undefined ? Promise.resolve([]) : level(0, l0Pages),
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
    exemplarFiles(exemplarFile, exLevel, exLevel === null ? null : (files.exemplars.get(exLevel) ?? null)),
  ]);
  const merged = mergeBucketSeries(
    [...l0.map((f) => f.series), ...segFiles.map((f) => f.series)],
    metricDir(id),
  );
  // Exemplars are not thinned per level here: like the buckets, they grow with the run until compaction.
  const all = [...exemplars, ...segFiles.flatMap((f) => f.exemplars)];
  const range = bucketRange(merged);
  const count = range === null ? 0 : levelCount(range.min * LEVEL0_WIDTH_NS, range.max * LEVEL0_WIDTH_NS);
  const levels =
    count === 0 ? [] : deriveLevels(merged, count).map((s, k) => toLevelData(k, [s], all, entry.series));
  return metricFromLevels({ entry, series, gaps: null, quantiles: null, fromSegments: true }, levels);
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
