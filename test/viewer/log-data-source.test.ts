import { beforeAll, describe, expect, test } from 'vitest';
import type { Manifest, ManifestChunk } from '../../src/format/manifest.js';
import { anyValueToDisplay } from '../../src/model/anyvalue.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { TraceId } from '../../src/model/ids.js';
import { createDataSource, type DataSource, signalBudgets } from '../../src/viewer/data/data-source.js';
import { type LogQuery, type LogRef, type LogRow, parseLogRef } from '../../src/viewer/data/log-query.js';
import { SURROUNDING_CHUNKS_PER_SIDE } from '../../src/viewer/data/log-windowed.js';
import { createScriptedLoader, type ScriptedLoader } from '../../test-support/scripted-loader.js';
import {
  buildLogReport,
  type Fixture,
  LOG_CHUNK_COUNT,
  LOG_TRACE,
  LOG_TRACE_ROOT_SPAN,
  ORPHAN_LOG_TRACE,
} from './report-fixture.js';

const SMALL = 10_000_000;
const MB = 1_000_000;
const logChunk = (n: number): string => `data/chunks/logs/${String(n).padStart(6, '0')}.js`;
const bodyOf = (r: LogRow): string => anyValueToDisplay(r.log.body);
const bodies = (rows: readonly LogRow[]): string[] => rows.map(bodyOf);
const asLogs = (r: Awaited<ReturnType<DataSource['queryLogs']>>): readonly LogRow[] => {
  if (r.mode !== 'logs') throw new Error(`expected a logs-mode result, got ${r.mode}`);
  return r.rows;
};

const query = (over: Partial<LogQuery> = {}): LogQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'logs',
  sort: { column: 'time', dir: 'asc' },
  limit: 1000,
  scanAll: false,
  ...over,
});

let rep: Fixture;
beforeAll(async () => {
  rep = await buildLogReport();
});

async function open(budget: number): Promise<{ ds: DataSource; loader: ScriptedLoader }> {
  const loader = createScriptedLoader(rep.files);
  const ds = await createDataSource(loader, rep.manifest, budget);
  return { ds, loader };
}

/** The ref of the one log whose body is `body`, found by an exact (eager) query. */
async function refOf(body: string): Promise<LogRef> {
  const { ds } = await open(SMALL);
  const rows = asLogs(await ds.queryLogs(query({ text: body })));
  const row = rows.find((r) => bodyOf(r) === body);
  if (row === undefined) throw new Error(`no log ${body}`);
  return row.ref;
}

describe('signalBudgets', () => {
  const chunk = (signal: ManifestChunk['signal'], n: number, bytes: number): ManifestChunk => ({
    signal,
    n,
    path: `data/chunks/${signal}/${String(n).padStart(6, '0')}.js`,
    start: 0,
    end: 0,
    count: 1,
    bytes,
  });
  const manifest = (decodedBytes: number, chunks: ManifestChunk[]): Manifest => ({
    ...rep.manifest,
    decodedBytes,
    chunks,
  });

  test('estimates each signal by its share of chunk bytes and compares it with the budget on its own', () => {
    const m = manifest(100 * MB, [
      chunk('spans', 0, 10 * MB),
      chunk('logs', 0, 40 * MB),
      chunk('logs', 1, 50 * MB),
    ]);
    expect(signalBudgets(m, 75 * MB)).toEqual({ spans: 'eager', logs: 'windowed' });
    expect(signalBudgets(m, 100 * MB)).toEqual({ spans: 'eager', logs: 'eager' });
    expect(signalBudgets(m, 1)).toEqual({ spans: 'windowed', logs: 'windowed' });
  });

  test('a signal with no chunks is eager', () => {
    expect(signalBudgets(manifest(100 * MB, [chunk('spans', 0, 100 * MB)]), 1)).toEqual({
      spans: 'windowed',
      logs: 'eager',
    });
    expect(signalBudgets(manifest(0, []), 0)).toEqual({ spans: 'eager', logs: 'eager' });
  });

  test('createDataSource picks each signal on its own', async () => {
    const spanBytes = rep.manifest.chunks
      .filter((c) => c.signal === 'spans')
      .reduce((n, c) => n + c.bytes, 0);
    const allBytes = rep.manifest.chunks.reduce((n, c) => n + c.bytes, 0);
    const budget = Math.ceil((rep.manifest.decodedBytes * spanBytes) / allBytes);
    expect(signalBudgets(rep.manifest, budget)).toEqual({ spans: 'eager', logs: 'windowed' });
    const { ds, loader } = await open(budget);
    expect(ds.strategy).toBe('eager');
    expect(ds.logStrategy).toBe('windowed');
    expect(loader.calls.some((p) => p.includes('/chunks/logs/'))).toBe(false);
    const t = await ds.getTrace(LOG_TRACE as TraceId);
    expect(t.logCount).toBe(3);
  });
});

describe.each([
  ['eager', SMALL],
  ['windowed', 1],
] as const)('%s logs', (strategy, budget) => {
  test('the strategy follows the budget', async () => {
    const { ds } = await open(budget);
    expect(ds.logStrategy).toBe(strategy);
  });

  test('logLanding comes from the unfiltered log rollup', async () => {
    const { ds } = await open(budget);
    const l = await ds.logLanding();
    expect(l.facets.total('service.name')).toBe(rep.manifest.totals.logs);
    expect(l.buckets.total('error')).toBe(LOG_CHUNK_COUNT);
    expect(l.patterns.length).toBeGreaterThan(0);
    expect(l.patterns.reduce((n, p) => n + p.count, 0)).toBe(rep.manifest.totals.logs);
  });

  test('getLog finds a log by ref and rejects an unknown ref with the not-found message', async () => {
    const ref = await refOf('tick 4.1');
    const { ds } = await open(budget);
    expect(bodyOf(await ds.getLog(ref))).toBe('tick 4.1');
    const missing = parseLogRef('99.0', 'test');
    await expect(ds.getLog(missing)).rejects.toThrow(
      'log 99.0: expected a log listed in the report, got not found',
    );
    await expect(ds.getLog(missing)).rejects.toMatchObject({ code: 'usage', path: 'log 99.0' });
    await expect(ds.getLog(parseLogRef('0.999', 'test'))).rejects.toBeInstanceOf(OtelHtmlError);
  });

  test('traceLogs returns the trace logs time-ascending, and [] for a trace without logs', async () => {
    const { ds } = await open(budget);
    expect(bodies(await ds.traceLogs(LOG_TRACE as TraceId))).toEqual([
      'trace log a',
      'trace log b',
      'trace log on a missing span',
    ]);
    expect(await ds.traceLogs('f'.repeat(32) as TraceId)).toEqual([]);
  });

  test('a log whose trace has no spans: traceLogs returns it and hasTrace is false', async () => {
    const { ds } = await open(budget);
    expect(bodies(await ds.traceLogs(ORPHAN_LOG_TRACE as TraceId))).toEqual(['orphan log']);
    expect(await ds.hasTrace(ORPHAN_LOG_TRACE as TraceId)).toBe(false);
  });

  test('span logs: filtering traceLogs by span_id never includes logs of another trace', async () => {
    const { ds } = await open(budget);
    const onRoot = (await ds.traceLogs(LOG_TRACE as TraceId)).filter(
      (r) => r.log.spanId === LOG_TRACE_ROOT_SPAN,
    );
    // the orphan log carries the same span_id under another trace id
    expect(bodies(onRoot)).toEqual(['trace log a', 'trace log b']);
    expect(onRoot.every((r) => r.log.traceId === LOG_TRACE)).toBe(true);
  });

  test('getTrace carries the trace log count', async () => {
    const { ds } = await open(budget);
    expect((await ds.getTrace(LOG_TRACE as TraceId)).logCount).toBe(3);
  });

  test('surroundingLogs keeps to the same service and host and crosses a chunk boundary', async () => {
    const ref = await refOf('tick 5.0');
    const { ds } = await open(budget);
    const s = await ds.surroundingLogs(ref, 2);
    expect(bodyOf(s.log)).toBe('tick 5.0');
    expect(bodies(s.before)).toEqual(['tick 4.0', 'tick 4.1']);
    expect(bodies(s.after)).toEqual(['tick 5.1', 'tick 6.0']);
    expect(s.partial).toBe(false);
  });

  test('surroundingLogs is not partial when it reaches the start of the report', async () => {
    const ref = await refOf('tick 1.0');
    const { ds } = await open(budget);
    const s = await ds.surroundingLogs(ref, 5);
    expect(bodies(s.before)).toEqual(['tick 0.0', 'tick 0.1']);
    expect(s.after).toHaveLength(5);
    expect(s.partial).toBe(false);
  });

  test('queryLogs filters, sorts and limits', async () => {
    const { ds } = await open(budget);
    const errors = await ds.queryLogs(query({ condition: 'log.severity_number >= SEVERITY_NUMBER_ERROR' }));
    expect(bodies(asLogs(errors))).toEqual(Array.from({ length: LOG_CHUNK_COUNT }, (_, k) => `noise ${k}`));
    expect(errors.total).toBe(LOG_CHUNK_COUNT);
    const last = await ds.queryLogs(query({ sort: { column: 'time', dir: 'desc' }, limit: 1 }));
    expect(bodies(asLogs(last))).toEqual(['tick 9.1']);
    expect(last.total).toBe(rep.manifest.totals.logs);
  });

  test('rejects with AbortError on an aborted signal', async () => {
    const { ds } = await open(budget);
    const ac = new AbortController();
    ac.abort();
    await expect(ds.queryLogs(query({ text: 'tick' }), undefined, ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('windowed logs', () => {
  async function windowed(): Promise<{ ds: DataSource; loader: ScriptedLoader }> {
    const o = await open(1);
    await o.ds.logLanding();
    o.loader.reset();
    return o;
  }

  test('opening and the landing load no log chunk', async () => {
    const { ds, loader } = await open(1);
    await ds.logLanding();
    expect(loader.calls).toEqual(['data/rollups/spans.js', 'data/rollups/logs.js']);
  });

  test('traceLogs loads the trace shard and exactly the trace log chunks', async () => {
    const { ds, loader } = await windowed();
    await ds.traceLogs(LOG_TRACE as TraceId);
    expect(loader.calls).toEqual([`data/traces/${LOG_TRACE.slice(0, 2)}.js`, logChunk(2)]);
  });

  test('getTrace reads the trace shard once for spans and the log count', async () => {
    const { ds, loader } = await windowed();
    expect((await ds.getTrace(LOG_TRACE as TraceId)).logCount).toBe(3);
    expect(loader.calls).toEqual([`data/traces/${LOG_TRACE.slice(0, 2)}.js`, 'data/chunks/spans/000000.js']);
  });

  test('getLog loads only the chunk named by the ref', async () => {
    const ref = await refOf('tick 7.0');
    const { ds, loader } = await windowed();
    await ds.getLog(ref);
    expect(loader.calls).toEqual([logChunk(7)]);
    loader.reset();
    await expect(ds.getLog(parseLogRef('99.0', 'test'))).rejects.toThrow(/not found/);
    expect(loader.calls).toEqual([]);
  });

  test('surroundingLogs stops after 4 neighbor chunks per side and says partial', async () => {
    expect(SURROUNDING_CHUNKS_PER_SIDE).toBe(4);
    const ref = await refOf('tick 5.0');
    const { ds, loader } = await windowed();
    const s = await ds.surroundingLogs(ref, 20);
    expect(bodies(s.before)).toEqual([1, 2, 3, 4].flatMap((k) => [`tick ${k}.0`, `tick ${k}.1`]));
    // after side reaches the end of the report: chunks 6..9 hold the rest
    expect(bodies(s.after)).toEqual([
      'tick 5.1',
      ...[6, 7, 8, 9].flatMap((k) => [`tick ${k}.0`, `tick ${k}.1`]),
    ]);
    expect(s.partial).toBe(true);
    expect([...loader.calls].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(logChunk));
  });

  test('a filtered query over a window loads only the overlapping chunks and reports partial', async () => {
    const { ds, loader } = await windowed();
    const c = rep.manifest.chunks.filter((x) => x.signal === 'logs');
    const r = await ds.queryLogs(
      query({ text: 'tick', window: { start: c[3]?.start ?? 0, end: c[4]?.end ?? 0 } }),
    );
    expect(loader.calls).toEqual([logChunk(3), logChunk(4)]);
    expect(r.partial).toEqual({ scanned: 2, total: LOG_CHUNK_COUNT });
    expect(r.total).toBe(4);
  });

  test('an unfiltered query returns the head of the run with the rollup aggregates and the manifest total', async () => {
    const capped: Manifest = {
      ...rep.manifest,
      config: { viewer: { ...rep.manifest.config.viewer, listCap: 4 } },
    };
    const loader = createScriptedLoader(rep.files);
    const ds = await createDataSource(loader, capped, 1);
    loader.reset();
    const r = await ds.queryLogs(query());
    expect(asLogs(r)).toHaveLength(4);
    expect(r.total).toBe(rep.manifest.totals.logs);
    expect(r.matched).toBe(rep.manifest.totals.logs);
    expect(r.partial).toEqual({ scanned: 2, total: LOG_CHUNK_COUNT });
    expect(r.facets.total('service.name')).toBe(rep.manifest.totals.logs);
    expect(loader.calls).toEqual(['data/rollups/logs.js', logChunk(0), logChunk(1)]);
  });

  test('unfiltered patterns are the writer patterns from the rollup, with no chunk scanned', async () => {
    const { ds, loader } = await windowed();
    const r = await ds.queryLogs(query({ mode: 'patterns', sort: { column: 'count', dir: 'desc' } }));
    const landing = await ds.logLanding();
    expect(r.mode).toBe('patterns');
    expect(r.rows).toEqual([...landing.patterns].sort((a, b) => b.count - a.count || a.id - b.id));
    expect(r.partial).toBeNull();
    expect(r.matched).toBe(rep.manifest.totals.logs);
    expect(loader.calls).toEqual([]);
  });

  test('keeps its own LRU of decoded log chunks', async () => {
    const { ds, loader } = await windowed();
    await ds.queryLogs(query({ text: 'tick', scanAll: true }));
    loader.reset();
    const c9 = rep.manifest.chunks.find((x) => x.signal === 'logs' && x.n === 9);
    await ds.queryLogs(query({ text: 'tick', window: { start: c9?.start ?? 0, end: c9?.end ?? 0 } }));
    expect(loader.calls).toEqual([]);
    await ds.queryLogs(query({ text: 'tick', window: { start: 0, end: 0 } }));
    expect(loader.calls).toEqual([logChunk(0)]);
  });
});

describe('eager and windowed agree', () => {
  test.each([
    ['unfiltered', query({ scanAll: true })],
    ['filtered', query({ condition: 'log.severity_number >= SEVERITY_NUMBER_ERROR', scanAll: true })],
    ['free text', query({ text: 'tick', scanAll: true, sort: { column: 'service', dir: 'desc' } })],
  ])('%s queryLogs rows', async (_, q) => {
    const eager = (await open(SMALL)).ds;
    const windowed = (await open(1)).ds;
    const e = await eager.queryLogs(q);
    const w = await windowed.queryLogs(q);
    expect(w.partial).toBeNull();
    expect(asLogs(w).map((r) => r.ref)).toEqual(asLogs(e).map((r) => r.ref));
    expect(w.total).toBe(e.total);
  });
});
