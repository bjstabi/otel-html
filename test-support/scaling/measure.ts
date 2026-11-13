import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { OtelHtmlError } from '../../src/model/errors.js';
import { type Axis, CATALOGUE, type CatalogueEntry, DECLARED } from '../../src/viewer/data/catalogue.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { bounded, shareOnce } from './bounded.js';
import { classify, type Step } from './classify.js';
import { type Cost, costOf, costWith } from './cost.js';
import {
  type CountingEngine,
  HARNESS_SMALL_FILE_BYTES,
  openCountingEngine,
  type ReadEvent,
} from './counting-engine.js';
import {
  buildScalingReport,
  isMerged,
  PREBUILT_ENV,
  type ScalingReport,
  type Shape,
  shapeKey,
  stepsOf,
} from './generator.js';

export const AXES: readonly Axis[] = ['retention', 'density', 'window'];

interface Live {
  report: ScalingReport;
  counting: CountingEngine;
  sizes: Map<string, number>;
  /** Statements of one engine run one after the other, cold between them. */
  turn: Promise<unknown>;
}

const MeasuredSchema = z.object({
  cost: z.object({ serial: z.number(), parallel: z.number(), bytes: z.number() }),
  /** The serial requests of the files under `HARNESS_SMALL_FILE_BYTES`, and of the others. */
  small: z.number(),
  large: z.number(),
});
type Measured = z.infer<typeof MeasuredSchema>;

const lives = new Map<string, Promise<Live>>();
const measured = new Map<string, Promise<Measured>>();
const coldMs: number[] = [];
const seen = new Map<string, Map<Axis, Step[]>>();

/** The options of a measurement: the threshold below which files load whole (default `HARNESS_SMALL_FILE_BYTES`; 0: every file by range). */
export interface MeasureOptions {
  threshold?: number;
}

const thresholdOf = (opts: MeasureOptions | undefined): number => opts?.threshold ?? HARNESS_SMALL_FILE_BYTES;
/** The key of a (shape, threshold): the default threshold keeps the shape's own key, so its shared files keep their names. */
const keyOf = (shape: Shape, threshold: number): string =>
  threshold === HARNESS_SMALL_FILE_BYTES ? shapeKey(shape) : `${shapeKey(shape)}-t${threshold}`;

function liveOf(shape: Shape, threshold: number): Promise<Live> {
  const key = keyOf(shape, threshold);
  const hit = lives.get(key);
  if (hit !== undefined) return hit;
  const made = (async (): Promise<Live> => {
    const report = await buildScalingReport(shape);
    const counting = await openCountingEngine(report.dir, report.manifest, { threshold });
    const sizes = new Map<string, number>();
    for (const p of report.manifest.partitions)
      for (const f of Object.values(p.files)) sizes.set(f.path, f.bytes);
    return { report, counting, sizes, turn: Promise.resolve() };
  })();
  lives.set(key, made);
  return made;
}

function entryOf(id: string): CatalogueEntry {
  const found = CATALOGUE.find((e) => e.id === id);
  if (found === undefined) throw new OtelHtmlError('usage', { message: `no catalogue entry ${id}` });
  return found;
}

const costOfEvents = (events: readonly ReadEvent[]): Cost => costOf(events, new Map());

/**
 * What `entry` costs cold on the report of `shape`: a fresh `DataSource` over the shape's engine, the engine replaced
 * (`cold()`), the entry run, the file reads since then turned into a `Cost`. Warmed before `cold()`: a metric entry
 * other than `metrics.catalog` loads the source's metric catalog first (the page loads it once, memoised in the
 * source), so the entry's cost is its own request. Nothing else is warmed.
 */
async function measure(entry: CatalogueEntry, shape: Shape, threshold: number): Promise<Measured> {
  const live = await liveOf(shape, threshold);
  const run = live.turn.then(async (): Promise<Measured> => {
    const { counting, report, sizes } = live;
    const ds = createDuckDbDataSource({ engine: counting.engine, manifest: report.manifest });
    if (entry.family === 'metrics' && entry.id !== 'metrics.catalog') await ds.metricCatalog();
    const t0 = performance.now();
    await counting.cold();
    coldMs.push(performance.now() - t0);
    await entry.run(ds, { window: entry.window ? report.window : null, ids: report.ids });
    const events = await counting.take();
    const prepared = counting.prepared();
    const isSmall = (e: ReadEvent): boolean =>
      (sizes.get(e.path) ?? Number.POSITIVE_INFINITY) <= HARNESS_SMALL_FILE_BYTES;
    const small = costOfEvents(events.filter(isSmall)).serial;
    const large = costOfEvents(events.filter((e) => !isSmall(e))).serial;
    return { cost: costWith(events, prepared), small, large };
  });
  live.turn = run.catch(() => undefined);
  return run;
}

/**
 * Under the scaling global setup the workers of a run share what each (entry, shape) cost: the shape at the `BASE`
 * values is a step of all three axes, so three files would each pay for the same cold runs. The first worker to take
 * the `.lock` folder measures and writes the result; the others wait for it.
 */
async function sharedMeasure(
  root: string,
  entry: CatalogueEntry,
  shape: Shape,
  threshold: number,
): Promise<Measured> {
  const file = join(root, `measured-${entry.id}-${keyOf(shape, threshold)}.json`);
  const what = `${entry.id} on ${keyOf(shape, threshold)}`;
  return await shareOnce({
    lock: `${file}.lock`,
    what,
    done: async () =>
      existsSync(file) ? MeasuredSchema.parse(JSON.parse(await readFile(file, 'utf8'))) : undefined,
    make: async () => {
      const m = await bounded(measure(entry, shape, threshold), `measuring ${what}`);
      await writeFile(`${file}.tmp`, JSON.stringify(m));
      await rename(`${file}.tmp`, file);
      return m;
    },
  });
}

function measuredOf(entry: CatalogueEntry, shape: Shape, opts?: MeasureOptions): Promise<Measured> {
  const threshold = thresholdOf(opts);
  const key = `${entry.id}|${keyOf(shape, threshold)}`;
  const hit = measured.get(key);
  if (hit !== undefined) return hit;
  const shared = process.env[PREBUILT_ENV];
  const made =
    shared === undefined ? measure(entry, shape, threshold) : sharedMeasure(shared, entry, shape, threshold);
  measured.set(key, made);
  return made;
}

/** The report of that shape, cold, run, `costOf`. */
export async function measureEntry(
  entry: CatalogueEntry,
  shape: Shape,
  opts?: MeasureOptions,
): Promise<Cost> {
  return (await measuredOf(entry, shape, opts)).cost;
}

/** The serial requests `entry` made to files of at most `HARNESS_SMALL_FILE_BYTES` on `shape` (zero when every small file was prepared). */
export async function smallSerialOf(
  entry: CatalogueEntry,
  shape: Shape,
  opts?: MeasureOptions,
): Promise<number> {
  return (await measuredOf(entry, shape, opts)).small;
}

/** The three steps of `axis` for `entry`, with what the classifier needs; the window axis does not apply to `window: false`. */
export async function stepsFor(entry: CatalogueEntry, axis: Axis): Promise<Step[]> {
  if (axis === 'window' && !entry.window)
    throw new OtelHtmlError('usage', {
      message: `${entry.id} carries no window: the window axis does not apply`,
    });
  const declared = DECLARED[entry.id];
  const reference = declared?.scanOf === undefined ? entry : entryOf(declared.scanOf);
  const steps: Step[] = [];
  for (const shape of stepsOf(axis, entry.spacing, isMerged(entry))) {
    const own = await measuredOf(entry, shape);
    const ref = reference === entry ? own : await measuredOf(reference, shape);
    const selectedGroups = (entry.window ? shape.inside : shape.outside + shape.inside) * shape.rowGroups;
    steps.push({
      partitions: shape.outside + shape.inside,
      selectedGroups,
      neededGroups: declared?.needed?.(shape) ?? selectedGroups,
      reference: ref.cost.serial,
      cost: own.cost,
    });
    const byAxis = seen.get(entry.id) ?? new Map<Axis, Step[]>();
    seen.set(entry.id, byAxis);
    byAxis.set(axis, steps);
  }
  return steps;
}

/** What `entry` cost cold on one generated shape: serial and parallel requests, bytes. */
export interface ModelPoint extends Cost {
  shape: Shape;
}

/** The extra density step the model is fitted with (`mise run predict:queries`): 16 row groups per partition. */
export const DENSE_16 = 16;

/**
 * Whether the extra density step is measured for `entry`: not for a request with a residual condition, which gives up
 * past 200,000 candidate rows (a partition of 16 row groups holds 131,072).
 */
export const hasDensity16 = (entry: CatalogueEntry): boolean => !entry.id.includes('.residual.');

/** The cost of `entry` on each of `shapes`: the points the prediction fits its model on (`mise run predict:queries`). */
export async function pointsOf(entry: CatalogueEntry, shapes: readonly Shape[]): Promise<ModelPoint[]> {
  const points: ModelPoint[] = [];
  for (const shape of shapes) points.push({ shape, ...(await measuredOf(entry, shape)).cost });
  return points;
}

/** Prints the entry x axis x measured class table, with the serial reads split by file size; never asserts. */
export async function printTable(): Promise<void> {
  const lines: string[] = [];
  for (const entry of CATALOGUE) {
    if (!seen.has(entry.id)) continue;
    const cells: string[] = [];
    for (const axis of AXES) {
      const steps = seen.get(entry.id)?.get(axis);
      if (steps === undefined) {
        cells.push(`${axis}: -`);
        continue;
      }
      const parts: string[] = [];
      for (const shape of stepsOf(axis, entry.spacing, isMerged(entry))) {
        const m = await measuredOf(entry, shape);
        parts.push(`${m.small}+${m.large}`);
      }
      cells.push(`${axis}: ${classify(steps)} (small+large serial ${parts.join(' ')})`);
    }
    lines.push(`${entry.id.padEnd(30)} ${cells.join('  ')}`);
  }
  if (lines.length === 0) return;
  const cold = coldMs.length === 0 ? 0 : coldMs.reduce((a, b) => a + b, 0) / coldMs.length;
  // stderr: the unit setup swallows console output
  process.stderr.write(
    `${lines.join('\n')}\ncold() took ${cold.toFixed(0)} ms on average over ${coldMs.length} calls\n`,
  );
}

/** Closes every engine opened here, then the reports (the generator's cache owns them). */
export async function closeMeasured(): Promise<void> {
  const all = await Promise.all([...lives.values()]);
  lives.clear();
  measured.clear();
  for (const live of all) await live.counting.close();
  for (const live of all) await live.report.close();
}
