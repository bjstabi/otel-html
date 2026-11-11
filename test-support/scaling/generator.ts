import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../../src/format/manifest.js';
import { TABLES } from '../../src/format/parquet/columns.js';
import { MANIFEST_KEY } from '../../src/format/paths.js';
import { type OtlpRequest, parseOtlpObject } from '../../src/model/otlp-json.js';
import type { TimeWindow } from '../../src/viewer/data/time-window.js';
import { openSession } from '../../src/writer/session.js';
import type { Format4Fixture } from '../format4-fixture.js';
import { writeReportDir } from '../report-dir.js';
import { createTestWriter, EPOCH_NS, testConfig } from '../writer-deps.js';
import { ROW_GROUP_ROWS } from './cost.js';

/** The three axes the harness steps: retention (`outside`), window (`inside`) and density (`rowGroups`). */
export type Axis = 'retention' | 'window' | 'density';
const AXIS_FIELD = { retention: 'outside', window: 'inside', density: 'rowGroups' } as const;

export interface Shape {
  /** Partitions before the window (R). */
  outside: number;
  /** Partitions in the window (W). */
  inside: number;
  /** Spans row groups per partition (G). */
  rowGroups: number;
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
  ids: {
    traceId: string;
    spanId: string;
    logRef: string;
    service: string;
    resource: string;
    runId: string;
    route: string;
    text: string;
    metric: string;
  };
  close(): Promise<void>;
}

export const BASE: Shape = { outside: 2, inside: 2, rowGroups: 2, spacing: 'dense' };

/** Retention, window and density at 2, 4 and 8 with the other two axes at `BASE`. */
export function stepsOf(axis: Axis, spacing: Shape['spacing']): readonly Shape[] {
  return [2, 4, 8].map((v) => ({ ...BASE, spacing, [AXIS_FIELD[axis]]: v }));
}

/** Makes the cost model identifiable: no axis at its `BASE` value alone. */
export const CROSS: Shape = { outside: 4, inside: 2, rowGroups: 4, spacing: 'dense' };

const OUT = 'r';
const SERVICES = ['svc-a', 'svc-b'] as const;
const SPAN_NAMES = ['GET', 'POST', 'db', 'cache', 'queue', 'render', 'auth', 'send'];
const SEVERITIES = [5, 9, 13, 17];
const METRICS = ['scaling.load', 'scaling.queue'];
const SPACING_NS = { dense: 20n * 60n * 1_000_000_000n, sparse: 6n * 3600n * 1_000_000_000n } as const;
const SPREAD_NS = 10n * 60n * 1_000_000_000n;
const SPAN_NS = 1_000_000n;
/** Absolute nanosecond of the first partition's first span: an hour after the writer's clock. */
const T0 = BigInt(EPOCH_NS) + 3600n * 1_000_000_000n;
const ID_STRIDE = 1_000_000;

const hex = (k: number, width: number): string => k.toString(16).padStart(width, '0');
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const startOf = (shape: Shape, n: number): bigint => T0 + BigInt(n) * SPACING_NS[shape.spacing];
const spanCount = (shape: Shape): number => shape.rowGroups * ROW_GROUP_ROWS;
const spanStart = (shape: Shape, n: number, k: number): bigint =>
  startOf(shape, n) + (BigInt(k) * SPREAD_NS) / BigInt(spanCount(shape));
const traceIdOf = (n: number, t: number): string => hex(n * ID_STRIDE + t + 1, 32);
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
  const metrics = METRICS.map((name, m) => ({
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
  w.deps.rowGroupRows = ROW_GROUP_ROWS;
  const config = testConfig({
    writer: {
      format: 'site',
      statisticsKeys: ['resource:run.id'],
      // no size-rule checkpoint inside a partition: its flush is the only cut
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
  if (text === undefined) throw new Error('no manifest');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(manifest)) throw new Error('not a v4 manifest');
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
  const entry = manifest.partitions[first];
  if (entry === undefined) throw new Error('no inside partition');
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
      logRef: `${entry.n}.${logFileRow}`,
      service: SERVICES[0],
      resource: `GET ${routeOf(k)}`,
      runId: `run-${first}`,
      route: routeOf(k),
      text: 'needle',
      metric: METRICS[0] ?? 'scaling.load',
    },
    close: written.close,
  };
}

const cache = new Map<string, Promise<ScalingReport>>();

/** The report of `shape`, built once per test run (per worker): `close()` removes its folder and forgets it. */
export function buildScalingReport(shape: Shape): Promise<ScalingReport> {
  const key = `${shape.outside}/${shape.inside}/${shape.rowGroups}/${shape.spacing}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const made = build(shape).then((r) => ({
    ...r,
    close: async (): Promise<void> => {
      cache.delete(key);
      await r.close();
    },
  }));
  cache.set(key, made);
  made.catch(() => cache.delete(key));
  return made;
}
