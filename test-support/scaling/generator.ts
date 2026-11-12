import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { type OtlpRequest, parseOtlpObject } from '../../src/model/otlp-json.js';
import type { Axis, ScalingIds } from '../../src/viewer/data/catalogue.js';
import { logRef } from '../../src/viewer/data/log-query.js';
import type { TimeWindow } from '../../src/viewer/data/time-window.js';
import { openSession } from '../../src/writer/session.js';
import type { Format4Fixture } from '../format4-fixture.js';
import { writeReportDir } from '../report-dir.js';
import { createTestWriter, EPOCH_NS, testConfig } from '../writer-deps.js';
import { bounded, shareOnce } from './bounded.js';
import { ROW_GROUP_ROWS } from './cost.js';

const AXIS_FIELD = { retention: 'outside', window: 'inside', density: 'rowGroups' } as const;

export interface Shape {
  /** Partitions before the window (R). */
  outside: number;
  /** Partitions in the window (W). */
  inside: number;
  /** Spans row groups per partition (G). */
  rowGroups: number;
  /** Rows of a row group; the class steps keep `ROW_GROUP_ROWS`, the page measurements use the writer's 50,000. */
  rowGroupRows?: number;
  /** 20 min or 6 h between partition starts. */
  spacing: 'dense' | 'sparse';
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
export function stepsOf(axis: Axis, spacing: Shape['spacing']): readonly Shape[] {
  return [2, 4, 8].map((v) => ({ ...BASE, spacing, [AXIS_FIELD[axis]]: v }));
}

/** The writer's default row-group size: the page fit measures density on groups this large (Task 6c). */
export const PRODUCTION_ROW_GROUP_ROWS = 50_000;

/**
 * The shapes a page is rendered on for its fit, on production-size row groups: 1 to 4 groups per partition on two
 * partitions, and 2 groups on 3 and 5 partitions (the page's window spans the report, so only the partition count
 * matters; the retention and window steps are the same shapes by another name).
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
  ];
}

/** The page shape the fit leaves out, to test how it extrapolates across both axes. */
export const PAGE_CROSS = (spacing: Shape['spacing']): Shape => ({
  outside: 2,
  inside: 1,
  rowGroups: 3,
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
const ID_STRIDE = 1_000_000;

const hex = (k: number, width: number): string => k.toString(16).padStart(width, '0');
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const startOf = (shape: Shape, n: number): bigint => T0 + BigInt(n) * SPACING_NS[shape.spacing];
const rowsPerGroup = (shape: Shape): number => shape.rowGroupRows ?? ROW_GROUP_ROWS;
const spanCount = (shape: Shape): number => shape.rowGroups * rowsPerGroup(shape);
const spanStart = (shape: Shape, n: number, k: number): bigint =>
  startOf(shape, n) + (BigInt(k) * SPREAD_NS) / BigInt(spanCount(shape));
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

/** Every record of partition `n` as OTLP-JSON objects, one per signal. */
function partitionJson(shape: Shape, n: number): Record<string, unknown>[] {
  const count = spanCount(shape);
  const resourceAttrs = (service: string) => [str('service.name', service), str('run.id', `run-${n}`)];
  const spans = SERVICES.map(() => [] as unknown[]);
  for (let k = 0; k < count; k++) {
    const start = spanStart(shape, n, k);
    spans[k % 2]?.push({
      traceId: traceIdOf(n, Math.floor(k / 8)),
      spanId: spanIdOf(n, k),
      name: SPAN_NAMES[k % 8],
      kind: 2,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + SPAN_NS),
      status: k % 16 === 15 ? { code: 2, message: 'failed' } : { code: 1 },
      attributes: [str('http.request.method', 'GET'), str('http.route', routeOf(k))],
    });
  }
  const logCount = count / 4;
  const logs = SERVICES.map(() => [] as unknown[]);
  for (let k = 0; k < logCount; k++) {
    const time = String(startOf(shape, n) + (BigInt(k) * SPREAD_NS) / BigInt(logCount));
    const withTrace = Math.floor(k / 2) % 2 === 0;
    logs[k % 2]?.push({
      timeUnixNano: time,
      observedTimeUnixNano: time,
      severityNumber: SEVERITIES[k % 4],
      body: { stringValue: k % 64 === 0 ? `a needle in log ${k}` : `log line ${k} of partition ${n}` },
      ...(withTrace ? { traceId: traceIdOf(n, Math.floor((4 * k) / 8)), spanId: spanIdOf(n, 4 * k) } : {}),
    });
  }
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
    {
      resourceMetrics: [
        {
          resource: { attributes: resourceAttrs(SERVICES[0]) },
          scopeMetrics: [{ scope: { name: 'scaling' }, metrics }],
        },
      ],
    },
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
  const session = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
  const partitions = shape.outside + shape.inside;
  for (let n = 0; n < partitions; n++) {
    const requests: OtlpRequest[] = partitionJson(shape, n).flatMap((json) =>
      parseOtlpObject(json, `scaling:${n}`),
    );
    let i = 0;
    for (const request of requests) await session.add(request, `scaling:${n}:${i++}`);
    await session.flush();
  }
  const text = w.fs.snapshot().get(`${OUT}/data/manifest.js`);
  if (text === undefined) throw new OtelHtmlError('usage', { message: 'no manifest' });
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(manifest)) throw new OtelHtmlError('usage', { message: 'not a v4 manifest' });
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
  const lastSpan = spanCount(shape) - 1;
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

const shapeKey = (shape: Shape): string =>
  `${shape.outside}-${shape.inside}-${shape.rowGroups}-${shape.spacing}-${rowsPerGroup(shape)}`;

/** The folder of the reports `prebuildScalingReports` made, set by the scaling global setup for the worker processes. */
export const PREBUILT_ENV = 'OTEL_HTML_SCALING_REPORTS';

interface Meta {
  epoch: string;
  window: TimeWindow;
  ids: ScalingIds;
}

/**
 * Makes `<root>/<shape key>/` (the report folder and a `meta.json`) if no worker has: the first to create the `.lock`
 * folder builds it and moves it into place with one rename, the others wait for it. The reports are deterministic, so
 * the workers of one run share them instead of each building its own.
 */
async function ensurePrebuilt(root: string, shape: Shape): Promise<string> {
  const target = join(root, shapeKey(shape));
  return await shareOnce({
    lock: `${target}.lock`,
    what: `the report ${shapeKey(shape)}`,
    done: async () => (existsSync(join(target, 'meta.json')) ? target : undefined),
    make: async () => {
      const r = await bounded(build(shape), `building the report ${shapeKey(shape)}`);
      const meta: Meta = { epoch: String(r.epoch), window: r.window, ids: r.ids };
      await writeFile(join(r.dir, 'meta.json'), JSON.stringify(meta));
      await rename(r.dir, target);
      return target;
    },
  });
}

async function openPrebuilt(dir: string): Promise<ScalingReport> {
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta;
  const text = await readFile(join(dir, 'data', 'manifest.js'), 'utf8');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(manifest)) throw new OtelHtmlError('usage', { message: 'not a v4 manifest' });
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
  const key = `${shape.outside}/${shape.inside}/${shape.rowGroups}/${shape.spacing}/${rowsPerGroup(shape)}`;
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
