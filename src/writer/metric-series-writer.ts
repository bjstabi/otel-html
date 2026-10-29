import { reviveDataJson, unwrapDataFile, wrapDataFile, wrapDataFilePieces } from '../format/data-file.js';
import {
  type BucketSeries,
  bucketIndex,
  bucketRange,
  capExemplars,
  dataFileKey,
  EXEMPLAR_BASE_LEVEL,
  encodeExemplarFile,
  encodeSegmentFile,
  encodeSeriesFile,
  LEVEL0_WIDTH_NS,
  levelCount,
  levelWidthNs,
  METRIC_FILE_PATH,
  metricDir,
  metricExemplarPath,
  metricLevelExemplarPath,
  metricLevelPath,
  metricSegmentPath,
  metricSeriesPath,
  nextLevel,
  parseExemplarFile,
  parseLevelFile,
  parseSegmentFile,
  parseSeriesFile,
  type SeriesGaps,
  type StoredExemplar,
  seriesGaps,
} from '../format/metric-files.js';
import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';
import type { BucketAgg } from '../rollups/metric-agg.js';
import type { MetricCatalog, MetricDef } from '../rollups/metric-catalog.js';
import { at } from './checkpoint.js';
import { MetricBuffer } from './metric-buffer.js';
import type { FileSystem } from './ports.js';

/**
 * What the buckets held in memory across all metrics may cost before the largest buffers are written out as
 * segments ahead of the next flush, down to half of it: in units of one counter or number bucket (columnar, about
 * 40 bytes), so about 40 MB. A histogram, exponential or summary bucket weighs its estimated size in these units
 * (`MetricBuffer.weight`; a 16-bucket histogram weighs 8).
 */
const DEFAULT_BUFFER_BUDGET = 1_000_000;

export interface SeriesWriterOptions {
  /** Exemplars kept per series per EXEMPLAR_WIDTH_NS bucket (`writer.metricExemplars`). */
  exemplars: number;
  /** The buffer budget, in columnar-bucket units (see DEFAULT_BUFFER_BUDGET). */
  bufferBudget?: number;
}

interface MetricPaths {
  series: boolean;
  segments: number[];
  levels: number[];
  exemplars: boolean;
  /** Levels with an `ex<k>.js`. */
  levelExemplars: number[];
}

/**
 * Brings back the series definitions of a reopened report's catalog from the committed `series.js` files
 * (the checkpoint keeps only per-metric entries), validating each file.
 */
export async function restoreCatalogSeries(
  fs: FileSystem,
  out: string,
  catalog: MetricCatalog,
  listed: readonly string[],
): Promise<void> {
  const files = new Set(listed);
  for (const e of catalog.entries()) {
    if (e.series === 0) continue;
    const path = metricSeriesPath(e.id);
    if (!files.has(path)) {
      throw new OtelHtmlError('invalid-report', {
        path: 'manifest.metricFiles',
        expected: `${path} (metric ${e.id} has ${e.series} series)`,
        actual: 'not listed',
      });
    }
    const file = parseSeriesFile(await readDataFile(fs, out, path), path);
    if (file.metric !== e.id) {
      throw new OtelHtmlError('invalid-report', {
        path: `${path}.metric`,
        expected: String(e.id),
        actual: String(file.metric),
      });
    }
    catalog.restoreSeries(e.id, file.series, path);
  }
}

async function readDataFile(fs: FileSystem, out: string, path: string): Promise<unknown> {
  const file = at(out, path);
  let text: string;
  try {
    text = await fs.readText(file);
  } catch (e) {
    throw new OtelHtmlError('invalid-report', {
      message: `${file}: cannot read ${path} listed in the manifest (${e instanceof Error ? e.message : String(e)})`,
    });
  }
  try {
    return reviveDataJson(unwrapDataFile(text, dataFileKey(path)), path);
  } catch (e) {
    if (e instanceof OtelHtmlError && e.code === 'invalid-report') {
      throw new OtelHtmlError('invalid-report', { message: `${path}: ${e.message}` });
    }
    throw e;
  }
}

/**
 * The per-metric series files. Level-0 buckets (and exemplars) accumulate in memory and go out as one segment per
 * metric at each flush (or earlier, when the buffer is full); `compact` turns a metric's segments into its level
 * files and `ex.js` at close. It owns the list of metric files the manifest should name.
 */
export class MetricSeriesWriter {
  readonly #fs: FileSystem;
  readonly #out: string;
  readonly #exemplars: number;
  readonly #maxBuffered: number;
  readonly #nextSegment: Map<number, number>;
  readonly #listed: Set<string>;
  /** Metrics whose compacted files were listed when the writer opened; the first flush turns them into a segment. */
  readonly #toDemote: Set<number>;
  readonly #buffers = new Map<number, MetricBuffer>();
  readonly #dirs = new Set<number>();
  /** Paths written since `flush` last returned. */
  #written: string[] = [];
  #buffered = 0;

  constructor(
    fs: FileSystem,
    out: string,
    opts: SeriesWriterOptions,
    nextSegment: Map<number, number>,
    listed: readonly string[] = [],
  ) {
    this.#fs = fs;
    this.#out = out;
    this.#exemplars = opts.exemplars;
    this.#maxBuffered = opts.bufferBudget ?? DEFAULT_BUFFER_BUDGET;
    this.#nextSegment = nextSegment;
    this.#listed = new Set(listed);
    this.#toDemote = new Set([...byMetric(listed)].filter(([, p]) => p.levels.length > 0).map(([id]) => id));
  }

  /** The metric files the next manifest lists, sorted. */
  listed(): string[] {
    return [...this.#listed].sort();
  }

  /** Next segment number per metric id, for the session checkpoint. */
  nextSegments(): ReadonlyMap<number, number> {
    return this.#nextSegment;
  }

  /** Whether the buffer has reached its budget and should be written out. */
  full(): boolean {
    return this.#buffered >= this.#maxBuffered;
  }

  /** Merges `agg` into its level-0 bucket and keeps the exemplars allowed for it. */
  add(
    def: MetricDef,
    series: { readonly id: number },
    time: RelNanos,
    agg: BucketAgg,
    exemplars: readonly StoredExemplar[],
  ): void {
    let buf = this.#buffers.get(def.id);
    if (buf === undefined) {
      buf = new MetricBuffer(this.#exemplars);
      this.#buffers.set(def.id, buf);
    }
    const before = buf.weight;
    buf.add(series.id, bucketIndex(time, LEVEL0_WIDTH_NS), agg, `metric ${def.id}`);
    this.#buffered += buf.weight - before;
    if (exemplars.length > 0) buf.addExemplars(exemplars);
  }

  /**
   * Writes `series.js` for metrics with new series and one segment per metric holding buckets, and returns the
   * paths written since the last successful call (a failed call's writes are returned by the next one). All of
   * them are listed from now on.
   */
  async flush(catalog: MetricCatalog): Promise<string[]> {
    await this.#writeSeriesFiles(catalog);
    for (const id of [...this.#buffers.keys()].sort((a, b) => a - b)) await this.#writeBuffer(id);
    return this.#written.splice(0);
  }

  /**
   * Writes out the largest buffers until at most half the budget is held (fewer, fuller segments than writing
   * every metric). Paths are listed now and returned by the next `flush`.
   */
  async spill(catalog: MetricCatalog): Promise<void> {
    await this.#writeSeriesFiles(catalog);
    const bySize = [...this.#buffers].sort(([a, x], [b, y]) => y.weight - x.weight || a - b);
    for (const [id] of bySize) {
      if (this.#buffered <= this.#maxBuffered / 2) break;
      await this.#writeBuffer(id);
    }
  }

  /** `series.js` of metrics with new series (segments refer to them), then pending demotions. */
  async #writeSeriesFiles(catalog: MetricCatalog): Promise<void> {
    for (const id of catalog.dirtyMetrics()) {
      await this.#write(
        metricSeriesPath(id),
        encodeSeriesFile({ metric: id, series: [...catalog.seriesDefs(id)] }),
      );
    }
    catalog.clearDirty();
    for (const id of [...this.#toDemote].sort((a, b) => a - b)) await this.#demote(id);
  }

  async #writeBuffer(id: number): Promise<void> {
    const buf = this.#buffers.get(id);
    if (buf === undefined) return;
    if (!buf.empty) await this.#writeSegment(id, buf.series(metricDir(id)), buf.exemplars());
    this.#buffered -= buf.weight;
    this.#buffers.delete(id);
  }

  async #writeSegment(id: number, series: BucketSeries[], exemplars: StoredExemplar[]): Promise<void> {
    const n = this.#nextSegment.get(id) ?? 0;
    await this.#write(
      metricSegmentPath(id, n),
      encodeSegmentFile({ metric: id, widthNs: LEVEL0_WIDTH_NS, series, exemplars }),
    );
    this.#nextSegment.set(id, n + 1);
  }

  /**
   * A reopened report's compacted files are about to be rewritten by the next compaction, so they first move
   * into a segment: the committed manifest never names a file that is being overwritten.
   */
  async #demote(id: number): Promise<void> {
    const paths = byMetric([...this.#listed]).get(id);
    if (paths !== undefined && paths.levels.length > 0) {
      const l0 = await this.#readLevel(id, 0);
      const exemplars = paths.exemplars ? await this.#readExemplars(id) : [];
      await this.#writeSegment(id, l0, exemplars);
      for (const k of paths.levels) this.#listed.delete(metricLevelPath(id, k));
      this.#listed.delete(metricExemplarPath(id));
      for (const k of paths.levelExemplars) this.#listed.delete(metricLevelExemplarPath(id, k));
    }
    this.#toDemote.delete(id);
  }

  /**
   * Turns every metric's segments into its level files 0…K and `ex.js`, one metric at a time, and returns the new
   * list of metric files (segments no longer in it; `prune` deletes them once a manifest without them is
   * committed).
   */
  async compact(catalog: MetricCatalog): Promise<string[]> {
    await this.flush(catalog); // also demotes: no metric has both levels and segments listed after it
    for (const [id, paths] of [...byMetric([...this.#listed])].sort(([a], [b]) => a - b)) {
      if (paths.segments.length === 0) continue;
      const merged = await this.#mergeSegments(id, paths.segments);
      const exemplars = merged.exemplars;
      let level: BucketSeries[] = merged.l0;
      merged.l0 = [];
      const gaps = gapsOf(catalog.seriesDefs(id).length, level);
      const range = bucketRange(level);
      const count = range === null ? 0 : levelCount(range.min * LEVEL0_WIDTH_NS, range.max * LEVEL0_WIDTH_NS);
      // Written unlisted, then swapped in at once: a failure part way leaves the segments the only listed data.
      // Levels are derived and written one at a time, so at most two are in memory.
      const written: string[] = [];
      for (let k = 0; k < count; k++) {
        const path = metricLevelPath(id, k);
        const series = level;
        // in pieces, one per series: a long run's level files are tens of megabytes
        const head = { metric: id, level: k, widthNs: levelWidthNs(k) };
        await this.#writePieces(path, wrapDataFilePieces(dataFileKey(path), head, 'series', series));
        written.push(path);
        level = k + 1 < count ? nextLevel(series, k + 1) : [];
      }
      let capped = capExemplars(exemplars, this.#exemplars);
      const ex = metricExemplarPath(id);
      await this.#writeFile(ex, encodeExemplarFile({ metric: id, exemplars: capped }));
      written.push(ex);
      // Each level coarser than `ex.js`'s keeps fewer, so the exemplars a chart loads are bounded like its buckets.
      for (let k = EXEMPLAR_BASE_LEVEL + 1; k < count; k++) {
        capped = capExemplars(capped, this.#exemplars, levelWidthNs(k));
        const path = metricLevelExemplarPath(id, k);
        await this.#writeFile(path, encodeExemplarFile({ metric: id, exemplars: capped }));
        written.push(path);
      }
      // The series' point gaps, so a chart picks its bucket width without loading level 0. Every series of the
      // metric is in the catalog and in this file already: only `gaps` is new, and it is valid with the segments too.
      await this.#writeFile(
        metricSeriesPath(id),
        encodeSeriesFile({ metric: id, series: [...catalog.seriesDefs(id)], gaps }),
      );
      for (const n of paths.segments) this.#listed.delete(metricSegmentPath(id, n));
      for (const k of paths.levels) this.#listed.delete(metricLevelPath(id, k));
      for (const k of paths.levelExemplars) this.#listed.delete(metricLevelExemplarPath(id, k));
      for (const path of written) this.#listed.add(path);
    }
    return this.listed();
  }

  /** A metric's segments merged into level 0, one segment at a time into a columnar buffer. */
  async #mergeSegments(
    id: number,
    segments: readonly number[],
  ): Promise<{ l0: BucketSeries[]; exemplars: StoredExemplar[] }> {
    const merged = new MetricBuffer(this.#exemplars);
    let exemplars: StoredExemplar[] = [];
    for (const n of [...segments].sort((a, b) => a - b)) {
      const path = metricSegmentPath(id, n);
      const seg = parseSegmentFile(await this.#read(path), path);
      for (const x of seg.series) {
        for (let i = 0; i < x.t.length; i++) {
          const agg = x.a[i];
          if (agg !== undefined) merged.add(x.id, x.t[i] ?? 0, agg, path);
        }
      }
      exemplars = exemplars.concat(seg.exemplars);
    }
    return { l0: merged.series(metricDir(id)), exemplars };
  }

  /** Deletes files under `data/metrics/` that are not listed: compacted segments, or an interrupted flush's leftovers. */
  async prune(): Promise<void> {
    const root = at(this.#out, 'data/metrics');
    if (!(await this.#fs.exists(root))) return;
    for (const dir of await this.#fs.list(root)) {
      if (!/^[0-9]{6}$/.test(dir)) continue;
      for (const name of await this.#fs.list(`${root}/${dir}`)) {
        const rel = `data/metrics/${dir}/${name}`;
        if (!this.#listed.has(rel)) await this.#fs.remove(at(this.#out, rel));
      }
    }
  }

  /** Writes and lists a file. */
  async #write(path: string, payload: unknown): Promise<void> {
    await this.#writeFile(path, payload);
    this.#listed.add(path);
    this.#written.push(path);
  }

  async #writeFile(path: string, payload: unknown): Promise<void> {
    await this.#mkdir(path);
    await this.#fs.writeTextAtomic(at(this.#out, path), wrapDataFile(dataFileKey(path), payload));
  }

  async #writePieces(path: string, pieces: Iterable<string>): Promise<void> {
    await this.#mkdir(path);
    const fs = this.#fs;
    if (fs.writePiecesAtomic !== undefined) await fs.writePiecesAtomic(at(this.#out, path), pieces);
    else await fs.writeTextAtomic(at(this.#out, path), [...pieces].join(''));
  }

  async #mkdir(path: string): Promise<void> {
    const id = Number(path.slice('data/metrics/'.length, 'data/metrics/'.length + 6));
    if (!this.#dirs.has(id)) {
      await this.#fs.mkdirp(at(this.#out, metricDir(id)));
      this.#dirs.add(id);
    }
  }

  #read(path: string): Promise<unknown> {
    return readDataFile(this.#fs, this.#out, path);
  }

  async #readLevel(id: number, k: number): Promise<BucketSeries[]> {
    const path = metricLevelPath(id, k);
    return parseLevelFile(await this.#read(path), path).series;
  }

  async #readExemplars(id: number): Promise<StoredExemplar[]> {
    const path = metricExemplarPath(id);
    return parseExemplarFile(await this.#read(path), path).exemplars;
  }
}

/** Listed metric files grouped by metric id. */
function byMetric(listed: readonly string[]): Map<number, MetricPaths> {
  const out = new Map<number, MetricPaths>();
  for (const p of listed) {
    const m = METRIC_FILE_PATH.exec(p);
    if (m === null) continue;
    const id = Number(m[1]);
    let e = out.get(id);
    if (e === undefined) {
      e = { series: false, segments: [], levels: [], exemplars: false, levelExemplars: [] };
      out.set(id, e);
    }
    if (m[2] === 'series') e.series = true;
    else if (m[2] === 'ex') e.exemplars = true;
    else if (m[3] !== undefined) e.levels.push(Number(m[3]));
    else if (m[4] !== undefined) e.segments.push(Number(m[4]));
    else if (m[5] !== undefined) e.levelExemplars.push(Number(m[5]));
  }
  return out;
}

/** `SeriesGaps` of each of a metric's `count` series (by id) from its merged level 0; a series with no buckets has none. */
function gapsOf(count: number, l0: readonly BucketSeries[]): SeriesGaps[] {
  const gaps: SeriesGaps[] = Array.from({ length: count }, () => ({ n: 0, median: 0 }));
  for (const s of l0) if (s.id < count) gaps[s.id] = seriesGaps(s.t);
  return gaps;
}
