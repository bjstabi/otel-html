import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isPartitioned, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseOtlpObject } from '../../src/model/otlp-json.js';
import type { Axis, ScalingIds } from '../../src/viewer/data/catalogue.js';
import { logRef } from '../../src/viewer/data/log-query.js';
import type { TimeWindow } from '../../src/viewer/data/time-window.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import type { Format4Fixture } from '../format4-fixture.js';
import { writeReportDir } from '../report-dir.js';
import { createTestWriter, EPOCH_NS, testConfig } from '../writer-deps.js';
import { bounded, STEP_TIMEOUT_MS, shareOnce } from './bounded.js';
import { ROW_GROUP_ROWS } from './cost.js';
import { PAGE_CROSS_SIZE } from './model.js';

const AXIS_FIELD = { retention: 'outside', window: 'inside', density: 'rowGroups' } as const;

export interface Shape {
  /** Partitions before the window (R). */
  outside: number;
  /** Partitions in the window (W). */
  inside: number;
  /** Spans row groups per partition (G). */
  rowGroups: number;
  /** Row groups of the first partition when it is larger than the others (a real report has one such partition). */
  bigRowGroups?: number;
  /** Rows of a row group; the class steps keep `ROW_GROUP_ROWS`, the page measurements use the writer's 50,000. */
  rowGroupRows?: number;
  /** 20 min or 6 h between partition starts. */
  spacing: 'dense' | 'sparse';
  /**
   * Each partition is written as its own run report, by a writer that lists no statistics key, and the reports are
   * merged the way the deployer merges them (#272): the merge is what has to record the keys.
   */
  merged?: boolean;
}

export interface ScalingReport {
  dir: string;
  manifest: ManifestV4;
  epoch: bigint;
  /** From the first inside partition's first span to the last one's last span, in the viewer's window type. */
  window: TimeWindow;
  /** One existing value of each kind the catalogue's point reads and conditions need. */
  ids: ScalingIds;
  close(): Promise<void>;
}

export const BASE: Shape = { outside: 2, inside: 2, rowGroups: 2, spacing: 'dense' };

/** Retention, window and density at 2, 4 and 8 with the other two axes at `BASE`. */
export function stepsOf(axis: Axis, spacing: Shape['spacing'], merged = false): readonly Shape[] {
  return [2, 4, 8].map((v) => ({ ...BASE, spacing, ...(merged ? { merged } : {}), [AXIS_FIELD[axis]]: v }));
}

/** Whether an entry is measured on merged reports: those whose condition is on a statistics key (#272). */
export const isMerged = (entry: { id: string }): boolean => entry.id.includes('.statkey.');

/** The writer's default row-group size: the page fit measures density on groups this large (Task 6c). */
export const PRODUCTION_ROW_GROUP_ROWS = 50_000;

/**
 * The shapes a page is rendered on for its fit, on production-size row groups: 1 to 4 groups per partition on two
 * partitions, and 2 groups on 3 and 5 partitions (the page's window spans the report, so only the partition count
 * matters; the retention and window steps are the same shapes by another name), and the same two partitions with the
 * first at 8, 14 and 22 groups, so the fit does not extrapolate to a real report's large partition.
 */
export function pageShapes(spacing: Shape['spacing']): Shape[] {
  const at = (outside: number, inside: number, rowGroups: number): Shape => ({
    outside,
    inside,
    rowGroups,
    spacing,
    rowGroupRows: PRODUCTION_ROW_GROUP_ROWS,
  });
  return [
    at(1, 1, 1),
    at(1, 1, 2),
    at(1, 1, 3),
    at(1, 1, 4),
    at(2, 1, 2),
    at(4, 1, 2),
    at(1, 2, 2),
    at(1, 4, 2),
    // one large partition, as a real report has: the first holds 8, 14 or 22 groups, the other stays at 2
    ...[8, 14, 22].map((bigRowGroups): Shape => ({ ...at(1, 1, 2), bigRowGroups })),
  ];
}

/** The page shape the fit leaves out, to test how it extrapolates across both axes. */
export const PAGE_CROSS = (spacing: Shape['spacing']): Shape => ({
  ...PAGE_CROSS_SIZE,
  spacing,
  rowGroupRows: PRODUCTION_ROW_GROUP_ROWS,
});

/** Makes the cost model identifiable: no axis at its `BASE` value alone. */
export const CROSS: Shape = { outside: 4, inside: 2, rowGroups: 4, spacing: 'dense' };

const OUT = 'r';
const SERVICES = ['svc-a', 'svc-b'] as const;
const SPAN_NAMES = ['GET', 'POST', 'db', 'cache', 'queue', 'render', 'auth', 'send'];
const SEVERITIES = [5, 9, 13, 17];
/** Two gauges and one summary (`SUMMARY`), each of 4 series x 16 points per partition. */
const METRICS = ['scaling.load', 'scaling.queue'];
const SUMMARY = 'scaling.latency';
const SPACING_NS = { dense: 20n * 60n * 1_000_000_000n, sparse: 6n * 3600n * 1_000_000_000n } as const;
const SPREAD_NS = 10n * 60n * 1_000_000_000n;
const SPAN_NS = 1_000_000n;
/** Absolute nanosecond of the first partition's first span: an hour after the writer's clock. */
const T0 = BigInt(EPOCH_NS) + 3600n * 1_000_000_000n;
const ID_STRIDE = 10_000_000;

const hex = (k: number, width: number): string => k.toString(16).padStart(width, '0');
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const startOf = (shape: Shape, n: number): bigint => T0 + BigInt(n) * SPACING_NS[shape.spacing];
const rowsPerGroup = (shape: Shape): number => shape.rowGroupRows ?? ROW_GROUP_ROWS;
const spanCount = (shape: Shape, n: number): number =>
  (n === 0 ? (shape.bigRowGroups ?? shape.rowGroups) : shape.rowGroups) * rowsPerGroup(shape);
const spanStart = (shape: Shape, n: number, k: number): bigint =>
  startOf(shape, n) + (BigInt(k) * SPREAD_NS) / BigInt(spanCount(shape, n));
const MASK64 = (1n << 64n) - 1n;
/** SplitMix64: a seeded, deterministic pseudo-random 64-bit value, so a report's bytes depend on its shape only. */
function splitMix64(seed: bigint): bigint {
  let z = (seed + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return z ^ (z >> 31n);
}
/**
 * Trace `t` of partition `n`: 128 pseudo-random bits, as a real trace id is (so no partition's ids sit in a range of
 * their own and a lookup by id cannot be pruned to one partition by min/max statistics). The spans and the logs of the
 * trace derive it from the same (n, t), so their links agree.
 */
const traceIdOf = (n: number, t: number): string => {
  const seed = BigInt(n * ID_STRIDE + t + 1);
  return hex64(splitMix64(seed * 2n)) + hex64(splitMix64(seed * 2n + 1n));
};
const hex64 = (v: bigint): string => v.toString(16).padStart(16, '0');
const spanIdOf = (n: number, k: number): string => hex(n * ID_STRIDE + k + 1, 16);
const routeOf = (k: number): string => `/route/${k % 16}`;

const spanRecord = (shape: Shape, n: number, k: number): unknown => {
  const start = spanStart(shape, n, k);
  return {
    traceId: traceIdOf(n, Math.floor(k / 8)),
    spanId: spanIdOf(n, k),
    name: SPAN_NAMES[k % 8],
    kind: 2,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + SPAN_NS),
    status: k % 16 === 15 ? { code: 2, message: 'failed' } : { code: 1 },
    attributes: [str('http.request.method', 'GET'), str('http.route', routeOf(k))],
  };
};

const logRecord = (shape: Shape, n: number, k: number, logCount: number): unknown => {
  const time = String(startOf(shape, n) + (BigInt(k) * SPREAD_NS) / BigInt(logCount));
  const withTrace = Math.floor(k / 2) % 2 === 0;
  return {
    timeUnixNano: time,
    observedTimeUnixNano: time,
    severityNumber: SEVERITIES[k % 4],
    body: { stringValue: k % 64 === 0 ? `a needle in log ${k}` : `log line ${k} of partition ${n}` },
    ...(withTrace ? { traceId: traceIdOf(n, Math.floor((4 * k) / 8)), spanId: spanIdOf(n, 4 * k) } : {}),
  };
};

/** Spans of a partition above this many are handed to the writer in requests of this size (a million-span partition does not fit in one JSON tree). */
const CHUNK_SPANS = 65_536;

/**
 * The requests of a partition larger than `CHUNK_SPANS`: each service's spans, then its logs, in pieces, in the order the
 * one-request form arrives (all of the first service, then all of the second), then the metrics.
 */
function* chunkedPartitionJson(shape: Shape, n: number): Generator<Record<string, unknown>> {
  const count = spanCount(shape, n);
  const logCount = count / 8;
  const resource = (service: string) => ({
    attributes: [str('service.name', service), str('run.id', `run-${n}`)],
  });
  for (const [i, service] of SERVICES.entries()) {
    for (let lo = 0; lo < count; lo += CHUNK_SPANS) {
      const spans: unknown[] = [];
      for (let k = lo + i; k < Math.min(count, lo + CHUNK_SPANS); k += 2) spans.push(spanRecord(shape, n, k));
      yield {
        resourceSpans: [{ resource: resource(service), scopeSpans: [{ scope: { name: 'scaling' }, spans }] }],
      };
    }
  }
  for (const [i, service] of SERVICES.entries()) {
    for (let lo = 0; lo < logCount; lo += CHUNK_SPANS) {
      const logs: unknown[] = [];
      for (let k = lo + i; k < Math.min(logCount, lo + CHUNK_SPANS); k += 2)
        logs.push(logRecord(shape, n, k, logCount));
      yield {
        resourceLogs: [
          { resource: resource(service), scopeLogs: [{ scope: { name: 'scaling' }, logRecords: logs }] },
        ],
      };
    }
  }
  yield metricsJson(shape, n);
}

/** The metrics request of partition `n`: two gauges and a summary. */
function metricsJson(shape: Shape, n: number): Record<string, unknown> {
  const resourceAttrs = (service: string) => [str('service.name', service), str('run.id', `run-${n}`)];
  const metrics: Record<string, unknown>[] = METRICS.map((name, m) => ({
    name,
    unit: '1',
    gauge: {
      dataPoints: Array.from({ length: 4 * 16 }, (_, j) => {
        const series = j % 4;
        const point = Math.floor(j / 4);
        return {
          timeUnixNano: String(startOf(shape, n) + (BigInt(point) * SPREAD_NS) / 16n),
          asDouble: (n + 1) * (m + 1) + series + point / 16,
          attributes: [str('series', `s${series}`)],
        };
      }),
    },
  }));
  // a summary, so the show options of a summary metric have a request to run; quantile values derive from the row index
  metrics.push({
    name: SUMMARY,
    unit: '1',
    summary: {
      dataPoints: Array.from({ length: 4 * 16 }, (_, j) => {
        const point = Math.floor(j / 4);
        return {
          timeUnixNano: String(startOf(shape, n) + (BigInt(point) * SPREAD_NS) / 16n),
          count: String(j + 1),
          sum: j + 1,
          quantileValues: [
            { quantile: 0.5, value: j },
            { quantile: 0.99, value: 2 * j },
          ],
          attributes: [str('series', `s${j % 4}`)],
        };
      }),
    },
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs(SERVICES[0]) },
        scopeMetrics: [{ scope: { name: 'scaling' }, metrics }],
      },
    ],
  };
}

/** Every record of partition `n` as OTLP-JSON objects, one per signal. */
function partitionJson(shape: Shape, n: number): Record<string, unknown>[] {
  const count = spanCount(shape, n);
  const resourceAttrs = (service: string) => [str('service.name', service), str('run.id', `run-${n}`)];
  const spans = SERVICES.map(() => [] as unknown[]);
  for (let k = 0; k < count; k++) spans[k % 2]?.push(spanRecord(shape, n, k));
  const logCount = count / 8;
  const logs = SERVICES.map(() => [] as unknown[]);
  for (let k = 0; k < logCount; k++) logs[k % 2]?.push(logRecord(shape, n, k, logCount));
  return [
    {
      resourceSpans: SERVICES.map((service, i) => ({
        resource: { attributes: resourceAttrs(service) },
        scopeSpans: [{ scope: { name: 'scaling' }, spans: spans[i] }],
      })),
    },
    {
      resourceLogs: SERVICES.map((service, i) => ({
        resource: { attributes: resourceAttrs(service) },
        scopeLogs: [{ scope: { name: 'scaling' }, logRecords: logs[i] }],
      })),
    },
    metricsJson(shape, n),
  ];
}

async function build(shape: Shape): Promise<ScalingReport> {
  const w = createTestWriter();
  w.deps.rowGroupRows = rowsPerGroup(shape);
  const config = testConfig({
    writer: {
      format: 'site',
      statisticsKeys: ['resource:run.id'],
      // keeps one flush = one file per table, so a partition is one flush; deviates from production's 4 MB default cut
      chunkTargetBytes: 2_000_000_000,
    },
  });
  const partitions = shape.outside + shape.inside;
  const addPartition = async (session: Awaited<ReturnType<typeof openSession>>, n: number) => {
    const jsons =
      spanCount(shape, n) > CHUNK_SPANS ? chunkedPartitionJson(shape, n) : partitionJson(shape, n);
    let i = 0;
    for (const json of jsons)
      for (const request of parseOtlpObject(json, `scaling:${n}`))
        await session.add(request, `scaling:${n}:${i++}`);
  };
  if (shape.merged === true) {
    const runConfig = testConfig({ writer: { format: 'site', chunkTargetBytes: 2_000_000_000 } });
    const runs: string[] = [];
    for (let n = 0; n < partitions; n++) {
      const run = `${OUT}-run-${n}`;
      const session = await openSession(w.deps, { out: run, config: runConfig, mode: 'replace' });
      await addPartition(session, n);
      await session.close();
      runs.push(run);
    }
    await mergeReports(w.deps, runs, { out: OUT, config, mode: 'replace' });
  } else {
    const session = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    for (let n = 0; n < partitions; n++) {
      await addPartition(session, n);
      await session.flush();
    }
  }
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new OtelHtmlError('usage', { message: 'no manifest' });
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new OtelHtmlError('usage', { message: 'not a partition manifest' });
  const files = new Map<string, Uint8Array>();
  for (const partition of manifest.partitions) {
    for (const table of TABLES) {
      const file = partition.files[table];
      if (file !== undefined) files.set(file.path, await w.fs.readBytes(`${OUT}/${file.path}`));
    }
  }
  const epoch = BigInt(manifest.epochUnixNano);
  const fixture: Format4Fixture = { manifest, files, epoch };
  const written = await writeReportDir(fixture);

  const first = shape.outside;
  const last = partitions - 1;
  const lastSpan = spanCount(shape, last) - 1;
  const window: TimeWindow = {
    start: Number(spanStart(shape, first, 0) - epoch),
    end: Number(spanStart(shape, last, lastSpan) + SPAN_NS - epoch),
  };
  const entry = manifest.partitions.find((p) => p.n === first);
  if (entry === undefined)
    throw new OtelHtmlError('usage', { message: `no partition ${first} in the manifest` });
  // a span and a log of the first inside partition: span index 8 (second trace, first service), log row 0
  const k = 8;
  const logFileRow = 0;
  return {
    dir: written.dir,
    manifest,
    epoch,
    window,
    ids: {
      traceId: traceIdOf(first, Math.floor(k / 8)),
      spanId: spanIdOf(first, k),
      logRef: logRef(entry.n, logFileRow),
      service: SERVICES[0],
      // the writer's `resource_name`: "<http.request.method> <http.route>" (see partitionJson, method GET)
      resource: `GET ${routeOf(k)}`,
      runId: `run-${first}`,
      route: routeOf(k),
      text: 'needle',
      metric: METRICS[0] ?? 'scaling.load',
    },
    close: written.close,
  };
}

/** The one key of a shape: reports and measurements of one key are one thing (`{}` and `{rowGroupRows: 8192}` are one). */
export const shapeKey = (shape: Shape): string =>
  `${shape.outside}-${shape.inside}-${shape.rowGroups}-${shape.spacing}-${rowsPerGroup(shape)}-${shape.bigRowGroups ?? 0}${shape.merged === true ? '-merged' : ''}`;

/** The folder of the reports `prebuildScalingReports` made, set by the scaling global setup for the worker processes. */
export const PREBUILT_ENV = 'OTEL_HTML_SCALING_REPORTS';

const MetaSchema = z.object({
  epoch: z.string(),
  window: z.object({ start: z.number(), end: z.number() }),
  ids: z.object({
    traceId: z.string(),
    spanId: z.string(),
    logRef: z.string(),
    service: z.string(),
    resource: z.string(),
    runId: z.string(),
    route: z.string(),
    text: z.string(),
    metric: z.string(),
  }),
});
type Meta = z.infer<typeof MetaSchema>;

/**
 * Makes `<root>/<shape key>/` (the report folder and a `meta.json`) if no worker has: the first to create the `.lock`
 * folder builds it and moves it into place with one rename, the others wait for it. The reports are deterministic, so
 * the workers of one run share them instead of each building its own.
 */
const buildBound = (shape: Shape): number =>
  shape.rowGroupRows === undefined ? STEP_TIMEOUT_MS : 10 * STEP_TIMEOUT_MS;

async function ensurePrebuilt(root: string, shape: Shape): Promise<string> {
  const target = join(root, shapeKey(shape));
  return await shareOnce({
    lock: `${target}.lock`,
    what: `the report ${shapeKey(shape)}`,
    // the holder may build for its whole bound: its waiters outlast it
    waitMs: 2 * buildBound(shape),
    done: async () => (existsSync(join(target, 'meta.json')) ? target : undefined),
    make: async () => {
      // a report of production-size row groups holds up to a million spans: building it takes minutes, not a step's bound
      const ms = buildBound(shape);
      const building = build(shape);
      const r = await bounded(building, `building the report ${shapeKey(shape)}`, ms).catch(
        async (e: unknown) => {
          // the abandoned build goes on: when it ends it closes its report, which removes its temp folder
          building.then((late) => late.close()).catch(() => {});
          throw e;
        },
      );
      const meta: Meta = { epoch: String(r.epoch), window: r.window, ids: r.ids };
      await writeFile(join(r.dir, 'meta.json'), JSON.stringify(meta));
      await rename(r.dir, target);
      return target;
    },
  });
}

async function openPrebuilt(dir: string): Promise<ScalingReport> {
  const meta = MetaSchema.parse(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')));
  const text = await readFile(join(dir, 'data', 'manifest.js'), 'utf8');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new OtelHtmlError('usage', { message: 'not a partition manifest' });
  // The folder is shared by every worker and removed by the global setup's teardown: close() leaves it.
  return {
    dir,
    manifest,
    epoch: BigInt(meta.epoch),
    window: meta.window,
    ids: meta.ids,
    close: async () => {},
  };
}

const cache = new Map<string, Promise<ScalingReport>>();

/**
 * The report of `shape`, built once per test run (per worker): `close()` removes its folder and forgets it. Under the
 * scaling global setup (`OTEL_HTML_SCALING_REPORTS`) the report is taken from that folder, built there by the first worker that needs it.
 */
export function buildScalingReport(shape: Shape): Promise<ScalingReport> {
  const key = shapeKey(shape);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const prebuilt = process.env[PREBUILT_ENV];
  const made =
    prebuilt === undefined
      ? build(shape).then((r) => ({
          ...r,
          close: async (): Promise<void> => {
            cache.delete(key);
            await r.close();
          },
        }))
      : ensurePrebuilt(prebuilt, shape).then(openPrebuilt);
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  return made;
}
