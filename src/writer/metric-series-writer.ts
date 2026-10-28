import { reviveDataJson, unwrapDataFile, wrapDataFile } from '../format/data-file.js';
import {
  type BucketSeries,
  bucketIndex,
  bucketRange,
  capExemplars,
  deriveLevels,
  EXEMPLAR_WIDTH_NS,
  encodeExemplarFile,
  encodeLevelFile,
  encodeSegmentFile,
  encodeSeriesFile,
  LEVEL0_WIDTH_NS,
  levelCount,
  levelWidthNs,
  mergeBucketSeries,
  metricDir,
  metricExemplarPath,
  metricLevelPath,
  metricSegmentPath,
  metricSeriesPath,
  parseExemplarFile,
  parseLevelFile,
  parseSegmentFile,
  type StoredExemplar,
  selectExemplars,
} from '../format/metric-files.js';
import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';
import { type BucketAgg, mergeAgg } from '../rollups/metric-agg.js';
import type { MetricCatalog, MetricDef, SeriesDef } from '../rollups/metric-catalog.js';
import { at } from './checkpoint.js';
import type { FileSystem } from './ports.js';

/**
 * Buckets held in memory across all metrics before they are written out as segments ahead of the next flush.
 * Keeps memory bounded when a flush interval covers many series × points.
 */
const DEFAULT_MAX_BUFFERED_BUCKETS = 100_000;

export interface SeriesWriterOptions {
  /** Exemplars kept per series per EXEMPLAR_WIDTH_NS bucket (`writer.metricExemplars`). */
  exemplars: number;
  maxBufferedBuckets?: number;
}

interface SeriesBuffer {
  t: number[];
  a: BucketAgg[];
}

interface MetricPaths {
  series: boolean;
  segments: number[];
  levels: number[];
  exemplars: boolean;
}

const LISTED = /^data\/metrics\/([0-9]{6})\/(series|ex|l([0-6])|seg-([0-9]{6}))\.js$/;

function keyOf(path: string): string {
  return path.slice('data/'.length, -'.js'.length);
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
  readonly #buckets = new Map<number, Map<number, SeriesBuffer>>();
  readonly #exemplarBuf = new Map<number, Map<string, StoredExemplar[]>>();
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
    this.#maxBuffered = opts.maxBufferedBuckets ?? DEFAULT_MAX_BUFFERED_BUCKETS;
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
    series: SeriesDef,
    time: RelNanos,
    agg: BucketAgg,
    exemplars: readonly StoredExemplar[],
  ): void {
    let metric = this.#buckets.get(def.id);
    if (metric === undefined) {
      metric = new Map();
      this.#buckets.set(def.id, metric);
    }
    let buf = metric.get(series.id);
    if (buf === undefined) {
      buf = { t: [], a: [] };
      metric.set(series.id, buf);
    }
    this.#merge(buf, bucketIndex(time, LEVEL0_WIDTH_NS), agg, def);
    if (exemplars.length > 0) this.#keepExemplars(def.id, exemplars);
  }

  #merge(buf: SeriesBuffer, idx: number, agg: BucketAgg, def: MetricDef): void {
    const path = `metric ${def.id}`;
    let i = buf.t.length;
    while (i > 0 && (buf.t[i - 1] ?? 0) > idx) i--; // points arrive mostly in time order: scan from the end
    const j = i - 1;
    const prev = buf.a[j];
    if (j >= 0 && buf.t[j] === idx && prev !== undefined) {
      buf.a[j] = mergeAgg(prev, agg, path);
      return;
    }
    if (i === buf.t.length) {
      buf.t.push(idx);
      buf.a.push(agg);
    } else {
      buf.t.splice(i, 0, idx);
      buf.a.splice(i, 0, agg);
    }
    this.#buffered++;
  }

  #keepExemplars(metricId: number, exemplars: readonly StoredExemplar[]): void {
    let groups = this.#exemplarBuf.get(metricId);
    if (groups === undefined) {
      groups = new Map();
      this.#exemplarBuf.set(metricId, groups);
    }
    for (const e of exemplars) {
      const key = `${e.series}:${bucketIndex(e.time, EXEMPLAR_WIDTH_NS)}`;
      const kept = groups.get(key);
      if (kept === undefined) groups.set(key, [e]);
      else {
        kept.push(e);
        if (kept.length > this.#exemplars) groups.set(key, selectExemplars(kept, this.#exemplars));
      }
    }
  }

  /**
   * Writes `series.js` for metrics with new series and one segment per metric holding buckets, and returns the
   * paths written since the last successful call (a failed call's writes are returned by the next one). All of
   * them are listed from now on.
   */
  async flush(catalog: MetricCatalog): Promise<string[]> {
    for (const id of catalog.dirtyMetrics()) {
      await this.#write(
        metricSeriesPath(id),
        encodeSeriesFile({ metric: id, series: [...catalog.seriesDefs(id)] }),
      );
    }
    catalog.clearDirty();
    for (const id of [...this.#toDemote].sort((a, b) => a - b)) await this.#demote(id);
    const ids = new Set([...this.#buckets.keys(), ...this.#exemplarBuf.keys()]);
    for (const id of [...ids].sort((a, b) => a - b)) {
      const series = [...(this.#buckets.get(id) ?? new Map<number, SeriesBuffer>())]
        .sort(([x], [y]) => x - y)
        .map(([sid, b]) => ({ id: sid, t: b.t, a: b.a }));
      const exemplars = [...(this.#exemplarBuf.get(id)?.values() ?? [])].flat().sort(byTimeThenSeries);
      await this.#writeSegment(id, series, exemplars);
      this.#buffered -= series.reduce((n, s) => n + s.t.length, 0);
      this.#buckets.delete(id);
      this.#exemplarBuf.delete(id);
    }
    return this.#written.splice(0);
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
    }
    this.#toDemote.delete(id);
  }

  /**
   * Turns every metric's segments into its level files 0…K and `ex.js`, one metric at a time, and returns the new
   * list of metric files (segments no longer in it; `prune` deletes them once a manifest without them is
   * committed).
   */
  async compact(catalog: MetricCatalog): Promise<string[]> {
    await this.flush(catalog);
    for (const [id, paths] of [...byMetric([...this.#listed])].sort(([a], [b]) => a - b)) {
      if (paths.segments.length === 0) continue;
      const parts: BucketSeries[][] = [];
      let exemplars: StoredExemplar[] = paths.exemplars ? await this.#readExemplars(id) : [];
      if (paths.levels.includes(0)) parts.push(await this.#readLevel(id, 0));
      for (const n of [...paths.segments].sort((a, b) => a - b)) {
        const path = metricSegmentPath(id, n);
        const seg = parseSegmentFile(await this.#read(path), path);
        parts.push(seg.series);
        exemplars = exemplars.concat(seg.exemplars);
      }
      const l0 = mergeBucketSeries(parts, metricDir(id));
      const range = bucketRange(l0);
      const levels =
        range === null
          ? []
          : deriveLevels(l0, levelCount(range.min * LEVEL0_WIDTH_NS, range.max * LEVEL0_WIDTH_NS));
      for (const k of paths.levels) this.#listed.delete(metricLevelPath(id, k));
      for (const [k, series] of levels.entries()) {
        await this.#write(
          metricLevelPath(id, k),
          encodeLevelFile({ metric: id, level: k, widthNs: levelWidthNs(k), series }),
        );
      }
      await this.#write(
        metricExemplarPath(id),
        encodeExemplarFile({ metric: id, exemplars: capExemplars(exemplars, this.#exemplars) }),
      );
      for (const n of paths.segments) this.#listed.delete(metricSegmentPath(id, n));
    }
    this.#written = [];
    return this.listed();
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

  async #write(path: string, payload: unknown): Promise<void> {
    const id = Number(path.slice('data/metrics/'.length, 'data/metrics/'.length + 6));
    if (!this.#dirs.has(id)) {
      await this.#fs.mkdirp(at(this.#out, metricDir(id)));
      this.#dirs.add(id);
    }
    await this.#fs.writeTextAtomic(at(this.#out, path), wrapDataFile(keyOf(path), payload));
    this.#listed.add(path);
    this.#written.push(path);
  }

  async #read(path: string): Promise<unknown> {
    const file = at(this.#out, path);
    let text: string;
    try {
      text = await this.#fs.readText(file);
    } catch (e) {
      throw new OtelHtmlError('invalid-report', {
        message: `${file}: cannot read ${path} listed in the manifest (${e instanceof Error ? e.message : String(e)})`,
      });
    }
    return reviveDataJson(unwrapDataFile(text, keyOf(path)), path);
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

function byTimeThenSeries(a: StoredExemplar, b: StoredExemplar): number {
  return a.time - b.time || a.series - b.series;
}

/** Listed metric files grouped by metric id. */
function byMetric(listed: readonly string[]): Map<number, MetricPaths> {
  const out = new Map<number, MetricPaths>();
  for (const p of listed) {
    const m = LISTED.exec(p);
    if (m === null) continue;
    const id = Number(m[1]);
    let e = out.get(id);
    if (e === undefined) {
      e = { series: false, segments: [], levels: [], exemplars: false };
      out.set(id, e);
    }
    if (m[2] === 'series') e.series = true;
    else if (m[2] === 'ex') e.exemplars = true;
    else if (m[3] !== undefined) e.levels.push(Number(m[3]));
    else if (m[4] !== undefined) e.segments.push(Number(m[4]));
  }
  return out;
}
