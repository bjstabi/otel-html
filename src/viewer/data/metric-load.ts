import { reviveDataJson } from '../../format/data-file.js';
import type { Manifest } from '../../format/manifest.js';
import {
  type BucketSeries,
  bucketRange,
  deriveLevels,
  LEVEL0_WIDTH_NS,
  levelCount,
  levelWidthNs,
  MAX_LEVEL,
  mergeBucketSeries,
  metricDir,
  metricExemplarKey,
  metricExemplarPath,
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
  type StoredExemplar,
} from '../../format/metric-files.js';
import { rollupKey, rollupPath } from '../../format/paths.js';
import { OtelHtmlError } from '../../model/errors.js';
import { canonicalAttributesKey } from '../../model/interner.js';
import type { ResourceRecord, ScopeRecord } from '../../model/records.js';
import type { BucketAgg } from '../../rollups/metric-agg.js';
import { MetricCatalog, type MetricEntry, type SeriesDef } from '../../rollups/metric-catalog.js';
import type { ScriptLoader } from './script-loader.js';

export interface LoadedSeries {
  def: SeriesDef;
  /** Null for the `other` series, which belongs to no single resource. */
  resource: ResourceRecord | null;
  scope: ScopeRecord | null;
}

export interface LevelData {
  level: number;
  widthNs: number;
  series: Map<number, { t: number[]; a: BucketAgg[] }>;
}

export interface LoadedMetric {
  entry: MetricEntry;
  series: readonly LoadedSeries[];
  levels: readonly LevelData[];
  exemplars: readonly StoredExemplar[];
  /** True when the levels were derived in memory from segments (the report is unfinished). */
  fromSegments: boolean;
}

function invalid(path: string, expected: string, actual: string): OtelHtmlError {
  return new OtelHtmlError('invalid-report', { path, expected, actual });
}

/** Resources and scopes are only read here, so no series cap applies. */
const READ_ONLY = { seriesCap: Number.MAX_SAFE_INTEGER };

/** The catalog from `data/rollups/metrics.js`. Its series definitions stay in each metric's `series.js`. */
export async function loadMetricCatalog(loader: ScriptLoader, manifest: Manifest): Promise<MetricCatalog> {
  const path = rollupPath('metrics');
  if (!manifest.rollups.includes(path)) {
    throw invalid('manifest.rollups', `a listing of ${path}`, JSON.stringify(manifest.rollups));
  }
  const payload = reviveDataJson(await loader.load(path, rollupKey('metrics')));
  if (typeof payload !== 'object' || payload === null || !Object.hasOwn(payload, 'catalog')) {
    throw invalid(path, 'an object with a catalog', typeof payload);
  }
  return MetricCatalog.from(Reflect.get(payload, 'catalog'), READ_ONLY, `${path}.catalog`);
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

function expectMetric(actual: number, id: number, path: string): void {
  if (actual !== id) throw invalid(`${path}.metric`, String(id), String(actual));
}

function toLevelData(level: number, series: readonly BucketSeries[]): LevelData {
  return {
    level,
    widthNs: levelWidthNs(level),
    series: new Map(series.map((s) => [s.id, { t: s.t, a: s.a }])),
  };
}

async function loadSeriesDefs(
  loader: ScriptLoader,
  manifest: Manifest,
  entry: MetricEntry,
): Promise<readonly SeriesDef[]> {
  const path = metricSeriesPath(entry.id);
  if (!manifest.metricFiles.includes(path)) {
    if (entry.series === 0) return [];
    throw invalid('manifest.metricFiles', `a listing of ${path}`, 'not listed');
  }
  const file = parseSeriesFile(reviveDataJson(await loader.load(path, metricSeriesKey(entry.id))), path);
  expectMetric(file.metric, entry.id, path);
  // A flush that never committed may have added series past the catalog's count; they are not part of the report.
  if (file.series.length < entry.series) {
    throw invalid(`${path}.series`, `at least ${entry.series} series`, String(file.series.length));
  }
  return file.series.slice(0, entry.series);
}

/**
 * One metric: its series definitions, its resolution levels and its exemplars. A finished report has level and
 * exemplar files. An unfinished one lists segments: they merge into level 0 and levels 0…K (the compaction rule,
 * `levelCount`) are derived in memory.
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
  const exPath = metricExemplarPath(id);
  const [defs, levelFiles, segFiles, exFile] = await Promise.all([
    loadSeriesDefs(loader, manifest, entry),
    Promise.all(
      files.levels.map(async (k) => {
        const path = metricLevelPath(id, k);
        const f = parseLevelFile(reviveDataJson(await loader.load(path, metricLevelKey(id, k))), path);
        expectMetric(f.metric, id, path);
        if (f.level !== k) throw invalid(`${path}.level`, String(k), String(f.level));
        return f;
      }),
    ),
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
    manifest.metricFiles.includes(exPath)
      ? loader.load(exPath, metricExemplarKey(id)).then((raw) => {
          const f = parseExemplarFile(reviveDataJson(raw), exPath);
          expectMetric(f.metric, id, exPath);
          return f;
        })
      : Promise.resolve(null),
  ]);
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
  const exemplars = [...(exFile?.exemplars ?? [])];
  if (segFiles.length === 0) {
    const levels = levelFiles.map((f) => toLevelData(f.level, f.series));
    return { entry, series, levels, exemplars, fromSegments: false };
  }
  const l0 = levelFiles.find((f) => f.level === 0);
  const merged = mergeBucketSeries(
    [...(l0 === undefined ? [] : [l0.series]), ...segFiles.map((f) => f.series)],
    metricDir(id),
  );
  for (const f of segFiles) exemplars.push(...f.exemplars);
  const range = bucketRange(merged);
  const count = range === null ? 0 : levelCount(range.min * LEVEL0_WIDTH_NS, range.max * LEVEL0_WIDTH_NS);
  const levels = count === 0 ? [] : deriveLevels(merged, count).map((s, k) => toLevelData(k, s));
  return { entry, series, levels, exemplars, fromSegments: true };
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
