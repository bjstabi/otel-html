import { wrapDataFile } from '../../src/format/data-file.js';
import type { Manifest } from '../../src/format/manifest.js';
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
    mode: 'create',
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
  edit: (entries: Record<string, { chunks: string[] }>) => void,
): Map<string, string> {
  const path = `data/traces/${shard}.js`;
  const text = files.get(path) ?? '';
  const body = text.slice(text.indexOf(',') + 1, -3);
  const entries: Record<string, { chunks: string[] }> = JSON.parse(body);
  edit(entries);
  return new Map(files).set(path, wrapDataFile(`traces/${shard}`, entries));
}

/**
 * Trace `traceIdOf(0)` spread over four chunks: root (web) in chunk 0, filler traces in chunks 1 and 3, a db child in
 * chunk 2 and an erroring db child in chunk 3. Root is [0, 1000] ns, children [100, 400] and [500, 800].
 */
export async function buildSpreadReport(): Promise<Fixture> {
  const w = createTestWriter();
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'create' });
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
  const session = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'create' });
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
