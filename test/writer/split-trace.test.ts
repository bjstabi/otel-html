import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { type TraceEntry, TraceShardSchema } from '../../src/format/trace-shard.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, span, TRACE_ID, traceRequest } from '../../test-support/otlp-builders.js';
import {
  createProcess,
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { allSpans, manifestOf, readChunk, spanIdOf } from './helpers.js';

const config = testConfig({ writer: { chunkTargetBytes: 1 } });

/** One span of the shared trace; span 1 is the root, the rest are its children. */
function part(n: number, offsetNs: number): ReturnType<typeof traceRequest> {
  const start = BigInt(EPOCH_NS) + BigInt(offsetNs);
  return traceRequest([
    span({
      traceId: TRACE_ID,
      spanId: spanIdOf(n),
      ...(n === 1 ? {} : { parentSpanId: spanIdOf(1) }),
      name: `s${n}`,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + 100n),
    }),
  ]);
}

function entryOf(w: TestWriter, out: string): TraceEntry {
  const shard = TRACE_ID.slice(0, 2);
  const text = w.fs.snapshot().get(`${out}/data/traces/${shard}.js`) ?? '';
  const entry = TraceShardSchema.parse(reviveDataJson(unwrapDataFile(text, `traces/${shard}`)))[TRACE_ID];
  if (entry === undefined) throw new Error('trace missing from the index');
  return entry;
}

/** The trace is complete: the index counts every span and its chunks hold exactly those spans. */
function expectComplete(w: TestWriter, out: string, spanCount: number): void {
  const entry = entryOf(w, out);
  expect(entry.spans).toBe(spanCount);
  expect(entry.root).toMatchObject({ name: 's1' });
  const fromIndex = entry.chunks.flatMap((key) =>
    readChunk<{ traceId: string; name: string }>(
      w,
      out,
      'spans',
      Number(key.slice('chunks/spans/'.length)),
    ).filter((s) => s.traceId === TRACE_ID),
  );
  expect(fromIndex.map((s) => s.name).sort()).toEqual(
    Array.from({ length: spanCount }, (_, i) => `s${i + 1}`),
  );
  expect(allSpans(w, out).filter((s) => s.traceId === TRACE_ID)).toHaveLength(spanCount);
}

describe('a trace split across sessions', () => {
  test('append keeps the index and contents complete', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    await a.add(otlp(part(2, 200)), 'a.json');
    await a.close();
    const b = await openSession(w.deps, { out: 'r', config, mode: 'append' });
    await b.add(otlp(part(1, 0)), 'b.json');
    await b.add(otlp(part(3, 400)), 'c.json');
    await b.close();
    expect(manifestOf(w, 'r').totals.spans).toBe(3);
    expectComplete(w, 'r', 3);
  });

  test('merge keeps the index and contents complete', async () => {
    const w = createTestWriter();
    for (const [out, parts] of [
      ['a', [part(2, 200), part(4, 600)]],
      ['b', [part(1, 0), part(3, 400)]],
    ] as const) {
      const s = await openSession(w.deps, { out, config, mode: 'replace' });
      for (const [i, p] of parts.entries()) await s.add(otlp(p), `${out}${i}.json`);
      await s.close();
    }
    await mergeReports(w.deps, ['a', 'b'], { out: 'm', config, mode: 'replace' });
    expectComplete(w, 'm', 4);
  });
});

describe('kill mid-flush, then append', () => {
  test('a session flushed but never closed (stale lock) is continued cleanly', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    await a.add(otlp(part(1, 0)), 'a.json');
    await a.add(otlp(part(2, 200)), 'b.json');
    await a.flush(); // then the process dies: no close, the lock stays behind
    expect(manifestOf(w, 'r').complete).toBe(false);
    w.process.alive.delete(w.process.pid);

    const deps = { ...w.deps, process: createProcess(9001, w.process.hostname) };
    const b = await openSession(deps, { out: 'r', config, mode: 'append' });
    expect(w.logs.some((l) => l.level === 'warn' && l.msg.includes('stale'))).toBe(true);
    expect((await b.add(otlp(part(2, 200)), 'again.json')).duplicates).toBe(1);
    await b.add(otlp(part(3, 400)), 'c.json');
    const summary = await b.close();
    expect(summary.totals.spans).toBe(3);
    expect(manifestOf(w, 'r').complete).toBe(true);
    expectComplete(w, 'r', 3);
  });
});

describe('a trace with logs in several log chunks', () => {
  test('the index lists each log chunk, and a span-less trace still gets an entry', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config, mode: 'replace' });
    const log = (traceId: string, spanId?: string): ReturnType<typeof logRecord> =>
      logRecord({ traceId, ...(spanId === undefined ? {} : { spanId }) });
    await s.add(otlp(logsRequest([log(TRACE_ID), logRecord()])), 'l1.json');
    await s.add(otlp(logsRequest([log(TRACE_ID, spanIdOf(9))])), 'l2.json');
    await s.close();
    const entry = entryOf(w, 'r');
    expect(entry).toMatchObject({ chunks: [], spans: 0, logs: 2, root: null });
    expect(entry.logChunks).toHaveLength(2);
    expect(new Set(entry.logChunks).size).toBe(2);
    for (const key of entry.logChunks) expect(key).toMatch(/^chunks\/logs\/[0-9]{6}$/);
  });
});
