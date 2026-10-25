import { wrapDataFile } from '../../src/format/data-file.js';
import type { Manifest } from '../../src/format/manifest.js';
import { openSession } from '../../src/writer/session.js';
import type { JsonObject } from '../../test-support/otlp-builders.js';
import { attr, span } from '../../test-support/otlp-builders.js';
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
