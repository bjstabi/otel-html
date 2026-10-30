import { wrapDataFile } from '../../src/format/data-file.js';
import type { Manifest } from '../../src/format/manifest.js';
import type { TraceEntry } from '../../src/format/trace-shard.js';
import { openSession } from '../../src/writer/session.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { attr, logRecord, span } from '../../test-support/otlp-builders.js';
import { reportFilesFromSnapshot } from '../../test-support/scripted-loader.js';
import { createTestWriter, EPOCH_NS, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf } from '../writer/helpers.js';

const OUT = 'rep';
/** Trace `i` starts `i` ms after the epoch; its spans fit in 1000 ns. */
export const STEP_NS = 1_000_000n;

export const traceIdOf = (i: number): string => (i + 1).toString(16).padStart(32, '0');
const spanId = (i: number, k: number): string => (i * 16 + k + 1).toString(16).padStart(16, '0');

/**
 * Trace `i`: a `web` root over [0, 1000] ns with two sequential `db` children, [100, 400] and [500, 800].
 * Traces in `errorTraces` have an erroring first child.
 */
function traceRequest(i: number, errorTraces: ReadonlySet<number>): JsonObject {
  const t = BigInt(EPOCH_NS) + BigInt(i) * STEP_NS;
  const at = (ns: number): string => String(t + BigInt(ns));
  const resource = (service: string, spans: JsonObject[]): JsonObject => ({
    resource: { attributes: [attr('service.name', { stringValue: service })] },
    scopeSpans: [{ scope: { name: 'test-scope' }, spans }],
  });
  return {
    resourceSpans: [
      resource('web', [
        span({
          traceId: traceIdOf(i),
          spanId: spanId(i, 0),
          name: 'GET /',
          startTimeUnixNano: at(0),
          endTimeUnixNano: at(1000),
        }),
      ]),
      resource('db', [
        span({
          traceId: traceIdOf(i),
          spanId: spanId(i, 1),
          parentSpanId: spanId(i, 0),
          name: 'db.query',
          startTimeUnixNano: at(100),
          endTimeUnixNano: at(400),
          ...(errorTraces.has(i) ? { status: { code: 2, message: 'boom' } } : {}),
        }),
        span({
          traceId: traceIdOf(i),
          spanId: spanId(i, 2),
          parentSpanId: spanId(i, 0),
          name: 'db.query',
          startTimeUnixNano: at(500),
          endTimeUnixNano: at(800),
        }),
      ]),
    ],
  };
}

export interface Fixture {
  files: Map<string, string>;
  manifest: Manifest;
}

/** A report of `traces` traces, one span chunk per trace (flushed after each), written by the real session. */
export async function buildReport(traces: number, errorTraces: readonly number[] = []): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, {
    out: OUT,
    config: testConfig(),
    mode: 'replace',
  });
  const errors = new Set(errorTraces);
  for (let i = 0; i < traces; i++) {
    await session.add(otlp(traceRequest(i, errors)), `t${i}`);
    await session.flush(); // cuts the buffered spans into a chunk of their own
  }
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/** Same files with one trace shard rewritten by `edit`. */
export function withShard(
  files: ReadonlyMap<string, string>,
  shard: string,
  edit: (entries: Record<string, TraceEntry>) => void,
): Map<string, string> {
  const path = `data/traces/${shard}.js`;
  const text = files.get(path) ?? '';
  const body = text.slice(text.indexOf(',') + 1, -3);
  const entries: Record<string, TraceEntry> = JSON.parse(body);
  edit(entries);
  return new Map(files).set(path, wrapDataFile(`traces/${shard}`, entries));
}

/**
 * Trace `traceIdOf(0)` spread over four chunks: root (web) in chunk 0, filler traces in chunks 1 and 3, a db child in
 * chunk 2 and an erroring db child in chunk 3. Root is [0, 1000] ns, children [100, 400] and [500, 800].
 */
export async function buildSpreadReport(): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const base = BigInt(EPOCH_NS);
  const one = (
    service: string,
    trace: number,
    id: number,
    parent: number | null,
    at: bigint,
    len: bigint,
    error = false,
  ): JsonObject => ({
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', { stringValue: service })] },
        scopeSpans: [
          {
            scope: { name: 'test-scope' },
            spans: [
              span({
                traceId: traceIdOf(trace),
                spanId: spanId(trace, id),
                ...(parent === null ? {} : { parentSpanId: spanId(trace, parent) }),
                name: parent === null ? 'GET /' : 'db.query',
                startTimeUnixNano: String(base + at),
                endTimeUnixNano: String(base + at + len),
                ...(error ? { status: { code: 2, message: 'boom' } } : {}),
              }),
            ],
          },
        ],
      },
    ],
  });
  const chunks: JsonObject[][] = [
    [one('web', 0, 0, null, 0n, 1000n)],
    [one('web', 1, 0, null, STEP_NS, 1000n)],
    [one('db', 0, 1, 0, 100n, 300n)],
    [one('db', 0, 2, 0, 500n, 300n, true), one('web', 2, 0, null, 3n * STEP_NS, 1000n)],
  ];
  for (const requests of chunks) {
    for (const r of requests) await session.add(otlp(r), 'spread');
    await session.flush();
  }
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/** Log chunks in `buildLogReport`, one per flush. */
export const LOG_CHUNK_COUNT = 10;
/** A trace with spans (span chunk 0) whose logs all sit in log chunk 2. */
export const LOG_TRACE = traceIdOf(0);
/** The root span of `LOG_TRACE`. */
export const LOG_TRACE_ROOT_SPAN = spanId(0, 0);
/** A trace that only has logs (log chunk 3); its one log carries `LOG_TRACE_ROOT_SPAN`, a span not in its trace. */
export const ORPHAN_LOG_TRACE = traceIdOf(5);
/** Body of the log with a span id and no trace id. */
export const SPAN_WITHOUT_TRACE_TEXT = 'span without trace';
/** Log stream (service `api`, host `h1`) bodies: `tick <chunk>.<j>`, `j` in 0..1. */
const TICKS_PER_CHUNK = 2;

/**
 * Spans of `traceRequest(0)` in span chunk 0, then `LOG_CHUNK_COUNT` log chunks. Log chunk `k` starts `k` steps
 * after the epoch and holds the `api`/`h1` ticks at +0 and +100 ns and an ERROR `noise <k>` log from `web`/`h2` at
 * +50 ns. Chunk 2 adds two `LOG_TRACE` logs on its root span and one on span `deadbeefdeadbeef` (not in the trace);
 * chunk 2 also has a log carrying `LOG_TRACE_ROOT_SPAN` but no trace id; chunk 3 adds the `ORPHAN_LOG_TRACE` log.
 */
export async function buildLogReport(): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  await session.add(otlp(traceRequest(0, new Set())), 'spans');
  await session.flush();
  const base = BigInt(EPOCH_NS);
  const at = (k: number, ns: number): string => String(base + BigInt(k) * STEP_NS + BigInt(ns));
  const resourceLogs = (service: string, host: string, logRecords: JsonObject[]): JsonObject => ({
    resource: {
      attributes: [attr('service.name', { stringValue: service }), attr('host.name', { stringValue: host })],
    },
    scopeLogs: [{ scope: { name: 'test-scope' }, logRecords }],
  });
  for (let k = 0; k < LOG_CHUNK_COUNT; k++) {
    const ticks = Array.from({ length: TICKS_PER_CHUNK }, (_, j) =>
      logRecord({ timeUnixNano: at(k, j * 100), body: { stringValue: `tick ${k}.${j}` } }),
    );
    const web = [
      logRecord({
        timeUnixNano: at(k, 50),
        severityNumber: 17,
        severityText: 'ERROR',
        body: { stringValue: `noise ${k}` },
      }),
    ];
    if (k === 2) {
      const inTrace = (ns: number, span: string, body: string): JsonObject =>
        logRecord({ timeUnixNano: at(k, ns), traceId: LOG_TRACE, spanId: span, body: { stringValue: body } });
      web.push(
        inTrace(20, LOG_TRACE_ROOT_SPAN, 'trace log b'),
        inTrace(10, LOG_TRACE_ROOT_SPAN, 'trace log a'),
        inTrace(30, 'deadbeefdeadbeef', 'trace log on a missing span'),
        logRecord({
          timeUnixNano: at(k, 40),
          spanId: LOG_TRACE_ROOT_SPAN,
          body: { stringValue: SPAN_WITHOUT_TRACE_TEXT },
        }),
      );
    }
    if (k === 3) {
      web.push(
        logRecord({
          timeUnixNano: at(k, 60),
          traceId: ORPHAN_LOG_TRACE,
          spanId: LOG_TRACE_ROOT_SPAN,
          body: { stringValue: 'orphan log' },
        }),
      );
    }
    await session.add(
      otlp({ resourceLogs: [resourceLogs('api', 'h1', ticks), resourceLogs('web', 'h2', web)] }),
      `logs${k}`,
    );
    await session.flush();
  }
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/** One log chunk per entry of `chunks`, all of one `api`/`h1` stream: each log is `[ns after the epoch, body]`. */
export async function buildLogChunksReport(
  chunks: readonly (readonly [number, string])[][],
): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const base = BigInt(EPOCH_NS);
  for (const [k, bodies] of chunks.entries()) {
    await session.add(
      otlp({
        resourceLogs: [
          {
            resource: {
              attributes: [
                attr('service.name', { stringValue: 'api' }),
                attr('host.name', { stringValue: 'h1' }),
              ],
            },
            scopeLogs: [
              {
                scope: { name: 'test-scope' },
                logRecords: bodies.map(([ns, body]) =>
                  logRecord({ timeUnixNano: String(base + BigInt(ns)), body: { stringValue: body } }),
                ),
              },
            ],
          },
        ],
      }),
      `chunk${k}`,
    );
    await session.flush();
  }
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/**
 * Two log chunks whose time ranges overlap: chunk 0 holds `wide 0`, `wide 100` and `wide 1000` (ns after the
 * epoch), chunk 1 holds `inner 50`, which sits between the first two.
 */
export function buildOverlappingLogReport(): Promise<Fixture> {
  return buildLogChunksReport([
    [
      [0, 'wide 0'],
      [100, 'wide 100'],
      [1000, 'wide 1000'],
    ],
    [[50, 'inner 50']],
  ]);
}

/** Seconds after the epoch of the metric points: level-0 buckets 0, 976 and 4882, so there are levels 0 and 1. */
const METRIC_POINT_SECONDS = [0, 1000, 5000] as const;

/**
 * Metrics (ids in first-seen order):
 * - 0 `http.server.requests` (delta sum): `checkout` series `/a` (1, 2, 3) and `/b` (10, 20, 30), `payments` series `/a` (5, 5, 5);
 * - 1 `checkout.queue.depth` (gauge): `checkout` only, 4, 8, 6;
 * - 2 `payments.balance` (gauge): `payments` only, 100, 90, 80.
 * Every point has a one-second window, at `METRIC_POINT_SECONDS`.
 */
function metricRequest(extras = false): JsonObject[] {
  const base = BigInt(EPOCH_NS);
  const at = (s: number): string => String(base + BigInt(s) * 1_000_000_000n);
  const points = (values: readonly number[], attrs: JsonObject[] = []): JsonObject[] =>
    values.map((v, i) => ({
      startTimeUnixNano: at((METRIC_POINT_SECONDS[i] ?? 0) - 1),
      timeUnixNano: at(METRIC_POINT_SECONDS[i] ?? 0),
      asInt: String(v),
      attributes: attrs,
    }));
  const route = (r: string): JsonObject[] => [attr('http.route', { stringValue: r })];
  const sum = (dataPoints: JsonObject[]): JsonObject => ({
    name: 'http.server.requests',
    unit: '1',
    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints },
  });
  const gaugeOf = (name: string, values: readonly number[]): JsonObject => ({
    name,
    unit: '1',
    gauge: { dataPoints: points(values) },
  });
  const resource = (service: string, metrics: JsonObject[]): JsonObject => ({
    resource: { attributes: [attr('service.name', { stringValue: service })] },
    scopeMetrics: [{ scope: { name: 'test-scope' }, metrics }],
  });
  return [
    {
      resourceMetrics: [
        resource('checkout', [
          sum([...points([1, 2, 3], route('/a')), ...points([10, 20, 30], route('/b'))]),
          gaugeOf('checkout.queue.depth', [4, 8, 6]),
        ]),
        resource('payments', [
          sum(points([5, 5, 5], route('/a'))),
          gaugeOf('payments.balance', [100, 90, 80]),
        ]),
      ],
    },
    ...(extras ? [explorerExtras(points)] : []),
  ];
}

/**
 * `buildMetricExplorerReport` adds, after the three metrics above (so their ids stay 0-2):
 * - 3 `http.server.request.duration` (delta histogram, unit `s`, bounds [0.1, 1]) on `checkout`;
 * - 4 and 5 `jobs.active`: a gauge (unit `1`) on `checkout` and a delta sum (unit `{job}`) on `payments`, so the
 *   name has conflicting definitions.
 */
function explorerExtras(points: (values: readonly number[]) => JsonObject[]): JsonObject {
  const resource = (service: string, metrics: JsonObject[]): JsonObject => ({
    resource: { attributes: [attr('service.name', { stringValue: service })] },
    scopeMetrics: [{ scope: { name: 'test-scope' }, metrics }],
  });
  const histPoints = points([0, 0, 0]).map((p, i) => {
    const { asInt: _, ...rest } = p;
    return {
      ...rest,
      count: '3',
      sum: 0.5 * (i + 1),
      bucketCounts: ['1', '1', '1'],
      explicitBounds: [0.1, 1],
    };
  });
  return {
    resourceMetrics: [
      resource('checkout', [
        {
          name: 'http.server.request.duration',
          unit: 's',
          histogram: { aggregationTemporality: 1, dataPoints: histPoints },
        },
        { name: 'jobs.active', unit: '1', gauge: { dataPoints: points([1, 2, 3]) } },
      ]),
      resource('payments', [
        {
          name: 'jobs.active',
          unit: '{job}',
          sum: { aggregationTemporality: 1, isMonotonic: false, dataPoints: points([4, 5, 6]) },
        },
      ]),
    ],
  };
}

/**
 * The same metrics as a finished report (compacted into level and exemplar files) and as an unfinished one (one
 * flush, so only series and segment files), each written by its own session. See `metricRequest` for the data.
 */
export async function buildMetricReports(): Promise<{ compacted: Fixture; segments: Fixture }> {
  return { compacted: await buildMetrics(true, false), segments: await buildMetrics(false, false) };
}

/** A finished report with `buildMetricReports`' metrics plus a histogram and a conflicting name (`explorerExtras`). */
export function buildMetricExplorerReport(): Promise<Fixture> {
  return buildMetrics(true, true);
}

async function buildMetrics(finish: boolean, extras: boolean): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  for (const r of metricRequest(extras)) await session.add(otlp(r), 'metrics');
  if (finish) await session.close();
  else await session.flush();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/** The trace of `buildEmbeddedMetricsReport`: a `checkout` root over a `payments` child. */
export const LINKED_TRACE = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
/** The `payments` span of `LINKED_TRACE` (the child). */
export const LINKED_PAYMENTS_SPAN = 'b2b2b2b2b2b2b2b2';
/** A log on `payments`, on `LINKED_PAYMENTS_SPAN`. */
export const PAYMENTS_LOG = '0.0';
/** A log on `web`, a resource with no metrics. */
export const NO_METRICS_LOG = '1.0';
/** `process.cpu.utilization` of the resource that is `payments` plus `process.pid`. */
export const SUPERSET_CPU = 1000;
/** `rpc.*` gauges on `payments`: more than the Explorer's query limit. */
export const RPC_METRICS = 11;

/**
 * Spans, logs and metrics on shared resources (`service.name` + `host.name`): `checkout`/`runner-1`,
 * `payments`/`runner-7` and `web`/`runner-2`. `LINKED_TRACE` runs at 60 s: root `GET /checkout` on `checkout`
 * (60.0-60.5 s) over `charge` on `payments` (60.1-60.3 s). Logs: `PAYMENTS_LOG` (60.2 s, on the `charge` span) and
 * `NO_METRICS_LOG` (61 s, `web`). Metrics (written first, so the epoch is 0 s) on `checkout` and `payments`, points
 * every 30 s from 0 to 120 s (the histogram's cover [s, s + 1]):
 * `process.cpu.utilization` and `process.memory.usage` (gauges), `http.server.active_requests` (gauge) and
 * `http.server.request.duration` (delta histogram, unit `s`) whose 60 s point on `payments` carries an exemplar on
 * `LINKED_TRACE`; `checkout`'s carries one on another trace. `payments` also has `RPC_METRICS` gauges `rpc.m01`…,
 * and a resource that is `payments` plus `process.pid` = 7 reports `process.cpu.utilization` = `SUPERSET_CPU`.
 */
export async function buildEmbeddedMetricsReport(): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const base = BigInt(EPOCH_NS);
  const sec = (s: number): string => String(base + BigInt(Math.round(s * 1000)) * 1_000_000n);
  const res = (service: string, host: string): JsonObject => ({
    attributes: [attr('service.name', { stringValue: service }), attr('host.name', { stringValue: host })],
  });
  const RES = {
    checkout: res('checkout', 'runner-1'),
    payments: res('payments', 'runner-7'),
    web: res('web', 'runner-2'),
  };
  const scope = { name: 'test-scope' };
  const times = [0, 30, 60, 90, 120];
  const gauge = (name: string, unit: string, v: (s: number) => number): JsonObject => ({
    name,
    unit,
    gauge: {
      dataPoints: times.map((s) => ({ timeUnixNano: sec(s), asDouble: v(s) })),
    },
  });
  const duration = (exemplarTrace: string, exemplarSpan: string): JsonObject => ({
    name: 'http.server.request.duration',
    unit: 's',
    histogram: {
      aggregationTemporality: 1,
      dataPoints: times.map((s) => ({
        startTimeUnixNano: sec(s),
        timeUnixNano: sec(s + 1),
        count: '3',
        sum: 0.9,
        bucketCounts: ['1', '1', '1'],
        explicitBounds: [0.1, 1],
        ...(s === 60
          ? {
              exemplars: [
                { timeUnixNano: sec(s + 0.5), asDouble: 0.5, traceId: exemplarTrace, spanId: exemplarSpan },
              ],
            }
          : {}),
      })),
    },
  });
  const metricsOf = (resource: JsonObject, k: number, exemplar: [string, string]): JsonObject => ({
    resource,
    scopeMetrics: [
      {
        scope,
        metrics: [
          gauge('process.cpu.utilization', '1', (s) => 0.1 * k + s / 1000),
          gauge('process.memory.usage', 'By', (s) => 1e6 * k + s),
          gauge('http.server.active_requests', '{request}', (s) => k + s / 30),
          duration(...exemplar),
        ],
      },
    ],
  });
  // A superset of `payments` (one more attribute): it must stay out of payments' charts and Explorer link.
  const paymentsWorker: JsonObject = {
    attributes: [
      attr('service.name', { stringValue: 'payments' }),
      attr('host.name', { stringValue: 'runner-7' }),
      attr('process.pid', { intValue: '7' }),
    ],
  };
  await session.add(
    otlp({
      resourceMetrics: [
        metricsOf(RES.checkout, 1, ['d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', 'e5e5e5e5e5e5e5e5']),
        metricsOf(RES.payments, 2, [LINKED_TRACE, LINKED_PAYMENTS_SPAN]),
        {
          resource: paymentsWorker,
          scopeMetrics: [{ scope, metrics: [gauge('process.cpu.utilization', '1', () => SUPERSET_CPU)] }],
        },
        {
          resource: RES.payments,
          scopeMetrics: [
            {
              scope,
              metrics: Array.from({ length: RPC_METRICS }, (_, i) =>
                gauge(`rpc.m${String(i + 1).padStart(2, '0')}`, '1', () => i),
              ),
            },
          ],
        },
      ],
    }),
    'metrics',
  );
  await session.flush();
  await session.add(
    otlp({
      resourceSpans: [
        {
          resource: RES.checkout,
          scopeSpans: [
            {
              scope,
              spans: [
                span({
                  traceId: LINKED_TRACE,
                  spanId: 'c3c3c3c3c3c3c3c3',
                  name: 'GET /checkout',
                  startTimeUnixNano: sec(60),
                  endTimeUnixNano: sec(60.5),
                }),
              ],
            },
          ],
        },
        {
          resource: RES.payments,
          scopeSpans: [
            {
              scope,
              spans: [
                span({
                  traceId: LINKED_TRACE,
                  spanId: LINKED_PAYMENTS_SPAN,
                  parentSpanId: 'c3c3c3c3c3c3c3c3',
                  name: 'charge',
                  startTimeUnixNano: sec(60.1),
                  endTimeUnixNano: sec(60.3),
                }),
              ],
            },
          ],
        },
      ],
    }),
    'spans',
  );
  await session.flush();
  const logOn = (resource: JsonObject, record: JsonObject): JsonObject => ({
    resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: [record] }] }],
  });
  await session.add(
    otlp(
      logOn(
        RES.payments,
        logRecord({
          timeUnixNano: sec(60.2),
          traceId: LINKED_TRACE,
          spanId: LINKED_PAYMENTS_SPAN,
          body: { stringValue: 'charge declined' },
        }),
      ),
    ),
    'logs0',
  );
  await session.flush();
  await session.add(
    otlp(logOn(RES.web, logRecord({ timeUnixNano: sec(61), body: { stringValue: 'web log' } }))),
    'logs1',
  );
  await session.flush();
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/**
 * A span on `api` with a span attribute `region` = `span-side`, and a gauge on a resource `api` + `region` = `eu`:
 * `region` is a resource attribute only on the metric's resource.
 */
export async function buildResourceValuesReport(): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const t = BigInt(EPOCH_NS);
  await session.add(
    otlp({
      resourceSpans: [
        {
          resource: { attributes: [attr('service.name', { stringValue: 'api' })] },
          scopeSpans: [
            {
              scope: { name: 'test-scope' },
              spans: [
                span({
                  traceId: traceIdOf(0),
                  spanId: spanId(0, 0),
                  name: 'GET /',
                  startTimeUnixNano: String(t),
                  endTimeUnixNano: String(t + 1000n),
                  attributes: [attr('region', { stringValue: 'span-side' })],
                }),
              ],
            },
          ],
        },
      ],
    }),
    'spans',
  );
  await session.add(
    otlp({
      resourceMetrics: [
        {
          resource: {
            attributes: [attr('service.name', { stringValue: 'api' }), attr('region', { stringValue: 'eu' })],
          },
          scopeMetrics: [
            {
              scope: { name: 'test-scope' },
              metrics: [
                { name: 'up', unit: '1', gauge: { dataPoints: [{ timeUnixNano: String(t), asDouble: 1 }] } },
              ],
            },
          ],
        },
      ],
    }),
    'metrics',
  );
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/**
 * A finished report of one delta counter `run.requests` (metric 0) with `series` series (`route` = `/r<j>`), a point
 * every `stepS` seconds over `durationS` seconds from the epoch, each point 1, written by the real session (as
 * `Report` does) with a flush every `FLUSH_POINTS` collections. With `exemplars`, every point carries one exemplar
 * (value `j`, on a trace).
 */
export async function buildCounterRun(run: {
  durationS: number;
  stepS: number;
  series: number;
  exemplars?: boolean;
}): Promise<Fixture> {
  const FLUSH_POINTS = 500;
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const base = BigInt(EPOCH_NS);
  const at = (s: number): string => String(base + BigInt(s) * 1_000_000_000n);
  const points = Math.floor(run.durationS / run.stepS) + 1;
  for (let from = 0; from < points; from += FLUSH_POINTS) {
    const dataPoints: JsonObject[] = [];
    for (let i = from; i < Math.min(points, from + FLUSH_POINTS); i++) {
      const s = i * run.stepS;
      for (let j = 0; j < run.series; j++)
        dataPoints.push({
          startTimeUnixNano: at(Math.max(0, s - run.stepS)),
          timeUnixNano: at(s),
          asInt: '1',
          attributes: [attr('route', { stringValue: `/r${j}` })],
          ...(run.exemplars === true
            ? {
                exemplars: [
                  {
                    timeUnixNano: at(s),
                    asDouble: j,
                    traceId: (i + 1).toString(16).padStart(32, '0'),
                    spanId: (j + 1).toString(16).padStart(16, '0'),
                  },
                ],
              }
            : {}),
        });
    }
    await session.add(
      otlp({
        resourceMetrics: [
          {
            resource: { attributes: [attr('service.name', { stringValue: 'api' })] },
            scopeMetrics: [
              {
                scope: { name: 'test-scope' },
                metrics: [
                  {
                    name: 'run.requests',
                    unit: '1',
                    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints },
                  },
                ],
              },
            ],
          },
        ],
      }),
      'metrics',
    );
    await session.flush();
  }
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/**
 * A summary metric over `durationS` at `stepS` (one series, no attributes), compacted. Points before `dropAfterS`
 * carry quantiles 0.5 and 0.99, later ones only 0.5: a long run's coarser levels keep one point per bucket, so
 * q0.99 is only in level 0 and in `series.js` (#39).
 */
export async function buildSummaryRun(run: {
  durationS: number;
  stepS: number;
  dropAfterS: number;
}): Promise<Fixture> {
  const FLUSH_POINTS = 500;
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const base = BigInt(EPOCH_NS);
  const at = (s: number): string => String(base + BigInt(s) * 1_000_000_000n);
  const points = Math.floor(run.durationS / run.stepS) + 1;
  for (let from = 0; from < points; from += FLUSH_POINTS) {
    const dataPoints: JsonObject[] = [];
    for (let i = from; i < Math.min(points, from + FLUSH_POINTS); i++) {
      const s = i * run.stepS;
      const quantileValues = [{ quantile: 0.5, value: i }];
      if (s < run.dropAfterS) quantileValues.push({ quantile: 0.99, value: 2 * i });
      dataPoints.push({
        startTimeUnixNano: at(0),
        timeUnixNano: at(s),
        count: String(i + 1),
        sum: i,
        quantileValues,
      });
    }
    await session.add(
      otlp({
        resourceMetrics: [
          {
            resource: { attributes: [attr('service.name', { stringValue: 'api' })] },
            scopeMetrics: [
              {
                scope: { name: 'test-scope' },
                metrics: [{ name: 'run.latency', unit: 'ms', summary: { dataPoints } }],
              },
            ],
          },
        ],
      }),
      'metrics',
    );
    await session.flush();
  }
  await session.close();
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}

/**
 * A counter with an exemplar per point, flushed after every `pointsPerFlush` points and never closed: `flushes`
 * segments listed, no level file. Series `j` has attribute `route=/r<j>`.
 */
export async function buildUnfinishedRun(run: {
  flushes: number;
  pointsPerFlush: number;
  series: number;
}): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'replace' });
  const base = BigInt(EPOCH_NS);
  const at = (s: number): string => String(base + BigInt(s) * 1_000_000_000n);
  for (let f = 0; f < run.flushes; f++) {
    const dataPoints: JsonObject[] = [];
    for (let p = 0; p < run.pointsPerFlush; p++) {
      const i = f * run.pointsPerFlush + p;
      const s = i * 10;
      for (let j = 0; j < run.series; j++)
        dataPoints.push({
          startTimeUnixNano: at(Math.max(0, s - 10)),
          timeUnixNano: at(s),
          asInt: '1',
          attributes: [attr('route', { stringValue: `/r${j}` })],
          exemplars: [
            {
              timeUnixNano: at(s),
              asDouble: i,
              traceId: (i + 1).toString(16).padStart(32, '0'),
              spanId: (j + 1).toString(16).padStart(16, '0'),
            },
          ],
        });
    }
    await session.add(
      otlp({
        resourceMetrics: [
          {
            resource: { attributes: [attr('service.name', { stringValue: 'api' })] },
            scopeMetrics: [
              {
                scope: { name: 'test-scope' },
                metrics: [
                  {
                    name: 'run.requests',
                    unit: '1',
                    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints },
                  },
                ],
              },
            ],
          },
        ],
      }),
      'metrics',
    );
    await session.flush();
  }
  return { files: reportFilesFromSnapshot(w.fs.snapshot(), OUT), manifest: manifestOf(w, OUT) };
}
