import { beforeAll, describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import type { TraceId } from '../../src/model/ids.js';
import type { ResourceRecord } from '../../src/model/records.js';
import {
  createDataSource,
  type SpanQuery,
  type SpanRow,
  type TraceRow,
} from '../../src/viewer/data/data-source.js';
import { CHUNK_LRU_SIZE } from '../../src/viewer/data/windowed.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';
import {
  buildMetricReports,
  buildReport,
  buildSpreadReport,
  type Fixture,
  STEP_NS,
  traceIdOf,
  withShard,
} from './report-fixture.js';

const query = (over: Partial<SpanQuery> = {}): SpanQuery => ({
  condition: null,
  text: '',
  window: null,
  mode: 'spans',
  sort: { column: 'start', dir: 'asc' },
  limit: 1000,
  groupBy: null,
  scanAll: false,
  ...over,
});

const ERRORS = 'status.code == STATUS_CODE_ERROR';
const asSpans = (rows: readonly (SpanRow | TraceRow)[]): SpanRow[] => rows as SpanRow[];
const asTraces = (rows: readonly (SpanRow | TraceRow)[]): TraceRow[] => rows as TraceRow[];
const chunkPath = (n: number): string => `data/chunks/spans/${String(n).padStart(6, '0')}.js`;
const SMALL = 10_000_000;

let six: Fixture;
beforeAll(async () => {
  six = await buildReport(6, [1, 3]);
});

describe('eager strategy', () => {
  test('is chosen within the budget, loads every chunk once, and answers from memory', async () => {
    const loader = createScriptedLoader(six.files);
    const ds = await createDataSource(loader, six.manifest, SMALL);
    expect(ds.strategy).toBe('eager');
    const loaded = [...loader.calls];
    expect(loaded.filter((p) => p.includes('/chunks/spans/')).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map(chunkPath),
    );
    await ds.querySpans(query({ condition: ERRORS }));
    await ds.getTrace(traceIdOf(2) as TraceId);
    // Spans stay in memory; only the trace's index shard (for its log count) is read.
    expect(loader.calls).toEqual([...loaded, `data/traces/${traceIdOf(2).slice(0, 2)}.js`]);
  });

  test('a trace still opens, with no log count, when its index shard fails to load', async () => {
    const id = traceIdOf(2);
    const files = new Map(six.files);
    files.delete(`data/traces/${id.slice(0, 2)}.js`);
    const ds = await createDataSource(createScriptedLoader(files), six.manifest, SMALL);
    expect(ds.strategy).toBe('eager');
    const t = await ds.getTrace(id as TraceId);
    expect(t.spans).toHaveLength(3);
    expect(t.logCount).toBe(0);
  });

  test('filters to exactly the error spans, with facets over the filtered set and no partial flag', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    const r = await ds.querySpans(query({ condition: ERRORS }));
    expect(asSpans(r.rows).map((s) => s.span.traceId)).toEqual([traceIdOf(1), traceIdOf(3)]);
    expect(r.total).toBe(2);
    expect(r.partial).toBeNull();
    expect(r.facets.top('service.name', 3)).toEqual([{ value: 'db', count: 2 }]);
    expect(r.buckets.total('error')).toBe(2);
    expect(r.red.counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  test('free text, window, sort and limit apply', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    const web = await ds.querySpans(query({ text: 'GET /' }));
    expect(web.total).toBe(6);
    const w = await ds.querySpans(
      query({ window: { start: 2 * Number(STEP_NS), end: 3 * Number(STEP_NS) + 1000 } }),
    );
    expect(w.total).toBe(6);
    const top = await ds.querySpans(query({ sort: { column: 'duration', dir: 'desc' }, limit: 2 }));
    expect(asSpans(top.rows).map((s) => s.durationNs)).toEqual([1000, 1000]);
    expect(top.total).toBe(18);
  });

  test('traces mode returns one row per trace with serviceShare summing to the root duration', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    const r = await ds.querySpans(query({ mode: 'traces' }));
    const rows = asTraces(r.rows);
    expect(rows).toHaveLength(6);
    expect(r.total).toBe(6);
    for (const t of rows) {
      expect(t.spans).toBe(3);
      expect(t.root?.service).toBe('web');
      expect(t.durationNs).toBe(1000);
      expect(t.serviceShare).toEqual([
        { service: 'db', ns: 600 },
        { service: 'web', ns: 400 },
      ]);
      expect(t.serviceShare.reduce((n, s) => n + s.ns, 0)).toBe(t.root?.durationNs);
    }
    expect(rows.filter((t) => t.errors > 0).map((t) => t.traceId)).toEqual([traceIdOf(1), traceIdOf(3)]);
    const onlyErrors = await ds.querySpans(query({ mode: 'traces', condition: ERRORS }));
    expect(asTraces(onlyErrors.rows).map((t) => t.traceId)).toEqual([traceIdOf(1), traceIdOf(3)]);
    expect(asTraces(onlyErrors.rows)[0]?.spans).toBe(3);
  });

  test('landing and percentileOf come from the unfiltered rollup', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    const l = await ds.landing();
    expect(l.facets.total('service.name')).toBe(18);
    expect(l.buckets.total('error')).toBe(2);
    expect(ds.percentileOf('web', 'GET /', 1000)).toBe(100);
    expect(ds.percentileOf('db', 'db.query', 1)).toBeLessThan(5);
    expect(ds.percentileOf('nope', 'x', 1)).toBeNull();
  });

  test('getTrace rebases refs onto one resource table and builds the tree', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    const t = await ds.getTrace(traceIdOf(4) as TraceId);
    expect(t.spans).toHaveLength(3);
    expect(t.tree.roots).toHaveLength(1);
    expect(t.tree.roots[0]?.children).toHaveLength(2);
    expect(t.logCount).toBe(0);
    for (const s of t.spans)
      expect(t.resources(s.span.resource).attributes.get('service.name')).toMatchObject({ value: s.service });
    await expect(ds.getTrace(traceIdOf(99) as TraceId)).rejects.toBeInstanceOf(OtelHtmlError);
  });

  test('hasTrace answers from memory', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    expect(await ds.hasTrace(traceIdOf(4) as TraceId)).toBe(true);
    expect(await ds.hasTrace(traceIdOf(99) as TraceId)).toBe(false);
  });

  test('rejects with AbortError on an aborted signal', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    const ac = new AbortController();
    ac.abort();
    await expect(ds.querySpans(query(), undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect((await ds.querySpans(query())).total).toBe(18);
  });

  test('an unknown sort column fails fast', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    await expect(ds.querySpans(query({ sort: { column: 'nope', dir: 'asc' } }))).rejects.toThrow(
      /query\.sort\.column/,
    );
  });
});

describe('windowed strategy', () => {
  async function windowed(files = six.files): Promise<{
    ds: Awaited<ReturnType<typeof createDataSource>>;
    loader: ReturnType<typeof createScriptedLoader>;
  }> {
    const loader = createScriptedLoader(files);
    const ds = await createDataSource(loader, six.manifest, 1);
    loader.reset();
    return { ds, loader };
  }

  test('is chosen above the budget; the landing page needs no chunks', async () => {
    const loader = createScriptedLoader(six.files);
    const ds = await createDataSource(loader, six.manifest, 1);
    expect(ds.strategy).toBe('windowed');
    expect(loader.calls).toEqual(['data/rollups/spans.js']);
    expect((await ds.landing()).facets.total('service.name')).toBe(18);
  });

  test('a filtered query over a window loads exactly the overlapping chunks and reports partial', async () => {
    const { ds, loader } = await windowed();
    const m = six.manifest.chunks;
    const progress: [number, number][] = [];
    const r = await ds.querySpans(
      query({
        condition: 'name == "db.query"',
        window: { start: m[2]?.start ?? 0, end: m[3]?.end ?? 0 },
      }),
      (s, t) => progress.push([s, t]),
    );
    expect(loader.calls).toEqual([chunkPath(2), chunkPath(3)]);
    expect(r.partial).toEqual({ scanned: 2, total: 6 });
    expect(r.total).toBe(4);
    expect(progress).toEqual([
      [1, 6],
      [2, 6],
    ]);
  });

  test('scanAll ignores the window and an exhaustive scan is exact', async () => {
    const { ds, loader } = await windowed();
    const r = await ds.querySpans(query({ condition: ERRORS, window: { start: 0, end: 1 }, scanAll: true }));
    expect(loader.calls).toEqual([0, 1, 2, 3, 4, 5].map(chunkPath));
    expect(r.total).toBe(2);
    expect(r.partial).toBeNull();
  });

  test('without condition, text or window it returns the head of the run and trusts the manifest total', async () => {
    const small: Fixture = {
      files: six.files,
      manifest: {
        ...six.manifest,
        config: { ...six.manifest.config, viewer: { ...six.manifest.config.viewer, listCap: 4 } },
      },
    };
    const loader = createScriptedLoader(small.files);
    const ds = await createDataSource(loader, small.manifest, 1);
    loader.reset();
    const r = await ds.querySpans(query());
    expect(r.rows).toHaveLength(4);
    expect(r.total).toBe(six.manifest.totals.spans);
    expect(r.partial).toEqual({ scanned: 2, total: 6 });
    expect(loader.calls).toEqual([chunkPath(0), chunkPath(1)]);
    // aggregates are the run's own, consistent with the manifest total, not the scanned head
    expect(r.facets.total('service.name')).toBe(six.manifest.totals.spans);
    expect(r.buckets.total('error')).toBe(2);
  });

  test('keeps at most 8 chunks decoded, least recently used first', async () => {
    const big = await buildReport(CHUNK_LRU_SIZE + 2);
    const loader = createScriptedLoader(big.files);
    const ds = await createDataSource(loader, big.manifest, 1);
    await ds.querySpans(query({ condition: ERRORS, scanAll: true }));
    loader.reset();
    const last = big.manifest.chunks[CHUNK_LRU_SIZE + 1];
    const first = big.manifest.chunks[0];
    await ds.querySpans(
      query({ condition: ERRORS, window: { start: last?.start ?? 0, end: last?.end ?? 0 } }),
    );
    expect(loader.calls).toEqual([]);
    await ds.querySpans(
      query({ condition: ERRORS, window: { start: first?.start ?? 0, end: first?.end ?? 0 } }),
    );
    expect(loader.calls).toEqual([chunkPath(0)]);
  });

  test('an abort mid-scan rejects with AbortError and leaves the cache usable', async () => {
    const { ds, loader } = await windowed();
    const ac = new AbortController();
    await expect(
      ds.querySpans(query({ condition: ERRORS, scanAll: true }), () => ac.abort(), ac.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader.calls).toEqual([chunkPath(0)]);
    loader.reset();
    const r = await ds.querySpans(query({ condition: ERRORS, scanAll: true }));
    expect(r.total).toBe(2);
    expect(loader.calls).toEqual([1, 2, 3, 4, 5].map(chunkPath));
  });

  test('getTrace loads one shard file and only the chunks listed for that trace', async () => {
    const { ds, loader } = await windowed();
    const id = traceIdOf(3);
    const t = await ds.getTrace(id as TraceId);
    expect(t.spans).toHaveLength(3);
    expect(t.logCount).toBe(0);
    expect(loader.calls).toEqual([`data/traces/${id.slice(0, 2)}.js`, chunkPath(3)]);
  });

  test('hasTrace reads only the shard file, never a span chunk', async () => {
    const { ds, loader } = await windowed();
    const id = traceIdOf(3);
    expect(await ds.hasTrace(id as TraceId)).toBe(true);
    expect(await ds.hasTrace(traceIdOf(77) as TraceId)).toBe(false);
    expect(loader.calls.every((c) => c.startsWith('data/traces/'))).toBe(true);
  });

  test('ignores shard chunk refs the manifest does not list (shard ahead of the manifest)', async () => {
    const id = traceIdOf(3);
    const ahead = withShard(six.files, id.slice(0, 2), (e) => {
      e[id]?.chunks.push('chunks/spans/000099');
    });
    const { ds, loader } = await windowed(ahead);
    const t = await ds.getTrace(id as TraceId);
    expect(t.spans).toHaveLength(3);
    expect(loader.calls).toEqual([`data/traces/${id.slice(0, 2)}.js`, chunkPath(3)]);
  });

  test('a trace with logs but no spans is not a trace: hasTrace is false and getTrace rejects', async () => {
    const id = traceIdOf(77);
    const files = withShard(six.files, id.slice(0, 2), (e) => {
      e[id] = {
        chunks: [],
        logChunks: ['chunks/logs/000000'],
        start: 5,
        end: 5,
        spans: 0,
        logs: 1,
        errors: 0,
        root: null,
      } as never;
    });
    const { ds } = await windowed(files);
    expect(await ds.hasTrace(id as TraceId)).toBe(false);
    await expect(ds.getTrace(id as TraceId)).rejects.toThrow(/not found/);
  });

  test('a trace the shard does not know is reported precisely', async () => {
    const { ds } = await windowed();
    await expect(ds.getTrace(traceIdOf(77) as TraceId)).rejects.toThrow(/not found/);
  });
});

describe('windowed traces mode', () => {
  const traceQuery = (over: Partial<SpanQuery>): SpanQuery => query({ mode: 'traces', ...over });

  test('rows of a trace spread over chunks carry whole-trace figures and say when the share is incomplete', async () => {
    const spread = await buildSpreadReport();
    const loader = createScriptedLoader(spread.files);
    const ds = await createDataSource(loader, spread.manifest, 1);
    const c2 = spread.manifest.chunks[2];
    const partialRun = await ds.querySpans(
      traceQuery({ condition: 'name == "db.query"', window: { start: c2?.start ?? 0, end: c2?.end ?? 0 } }),
    );
    const [row] = asTraces(partialRun.rows);
    // chunk 0 (the root) overlaps the window too; chunk 3 (the erroring child) does not
    expect(partialRun.partial).toEqual({ scanned: 2, total: 4 });
    expect(row).toMatchObject({
      traceId: traceIdOf(0),
      spans: 3,
      errors: 1,
      start: 0,
      durationNs: 1000,
      rootSummary: { service: 'web', name: 'GET /', resource: 'GET /' },
      shareComplete: false,
      serviceShare: [],
    });

    expect(row?.root?.service).toBe('web');

    const whole = await ds.querySpans(traceQuery({ condition: 'name == "db.query"', scanAll: true }));
    const [full] = asTraces(whole.rows);
    expect(whole.partial).toBeNull();
    expect(full).toMatchObject({ spans: 3, errors: 1, start: 0, durationNs: 1000, shareComplete: true });
    expect(full?.root?.service).toBe('web');
    expect(full?.serviceShare).toEqual([
      { service: 'db', ns: 600 },
      { service: 'web', ns: 400 },
    ]);
  });

  test('the list cap counts traces, not matched spans, and limit counts traces', async () => {
    const capped = {
      ...six.manifest,
      config: { ...six.manifest.config, viewer: { ...six.manifest.config.viewer, listCap: 2 } },
    };
    const loader = createScriptedLoader(six.files);
    const ds = await createDataSource(loader, capped, 1);
    loader.reset();
    const r = await ds.querySpans(traceQuery({ condition: 'name == "db.query"' }));
    expect(asTraces(r.rows).map((t) => t.traceId)).toEqual([traceIdOf(0), traceIdOf(1)]);
    expect(r.total).toBe(2);
    expect(r.partial).toEqual({ scanned: 2, total: 6 });
    expect(asTraces(r.rows).every((t) => t.shareComplete && t.spans === 3)).toBe(true);
    const limited = await ds.querySpans(traceQuery({ condition: 'name == "db.query"', limit: 1 }));
    expect(limited.rows).toHaveLength(1);
  });
});

describe('groupBy', () => {
  test('fails fast until it is implemented', async () => {
    const ds = await createDataSource(createScriptedLoader(six.files), six.manifest, SMALL);
    await expect(ds.querySpans(query({ groupBy: 'service.name' }))).rejects.toThrow(
      /query\.groupBy.*not implemented/,
    );
  });
});

describe('metrics', () => {
  let metrics: Fixture;
  beforeAll(async () => {
    metrics = (await buildMetricReports()).compacted;
  });
  const resourceOf = (service: string): ResourceRecord => ({
    attributes: new Map([['service.name', { kind: 'string', value: service }]]),
    droppedAttributesCount: 0,
    schemaUrl: '',
  });

  test('metricsForResources lists only metrics with series on those resources', async () => {
    const ds = await createDataSource(createScriptedLoader(metrics.files), metrics.manifest, SMALL);
    const names = async (...services: string[]) =>
      (await ds.metricsForResources(services.map(resourceOf))).map((e) => e.name);
    expect(await names('checkout')).toEqual(['http.server.requests', 'checkout.queue.depth']);
    expect(await names('payments')).toEqual(['http.server.requests', 'payments.balance']);
    expect(await names('checkout', 'payments')).toHaveLength(3);
    expect(await names('web')).toEqual([]);
  });

  test('a metric loads once for repeated and concurrent calls; the catalog loads once', async () => {
    const loader = createScriptedLoader(metrics.files);
    const ds = await createDataSource(loader, metrics.manifest, SMALL);
    const [a, b] = await Promise.all([ds.metric(0), ds.metric(0)]);
    expect(await ds.metric(0)).toBe(a);
    expect(b).toBe(a);
    await ds.metricsForResources([resourceOf('checkout')]);
    const count = (path: string): number => loader.calls.filter((p) => p === path).length;
    expect(count('data/metrics/000000/series.js')).toBe(1);
    expect(count('data/rollups/metrics.js')).toBe(1);
  });
});
