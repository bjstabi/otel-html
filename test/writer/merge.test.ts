import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import { parseExemplarFile, parseSeriesFile } from '../../src/format/metric-files.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { parseUnixNanos, toUnixNanos } from '../../src/model/ids.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import {
  gauge,
  type JsonObject,
  logRecord,
  logsRequest,
  metricsRequest,
} from '../../test-support/otlp-builders.js';
import {
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import {
  allLogs,
  allPoints,
  allSpans,
  counterRequest,
  cumulativeRequest,
  levelsOf,
  logRollupsOf,
  manifestOf,
  metricCatalogOf,
  readDataFile,
  spansRequest,
  traceIdOf,
  withExemplars,
} from './helpers.js';

async function failure(p: Promise<unknown>): Promise<OtelHtmlError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

async function writeReport(w: TestWriter, out: string, requests: readonly JsonObject[]): Promise<void> {
  const s = await openSession(w.deps, {
    out,
    config: testConfig({ writer: { chunkTargetBytes: 1 } }),
    mode: 'create',
  });
  for (const [i, r] of requests.entries()) await s.add(otlp(r), `in-${i}.json`);
  await s.close();
}

describe('dashboards', () => {
  const dash = (id: string) => ({
    dashboards: [{ id, title: id, widgets: [{ type: 'traces' as const, x: 0, y: 0, w: 6, h: 6 }] }],
  });
  async function reportWith(w: TestWriter, out: string, id: string): Promise<void> {
    const s = await openSession(w.deps, {
      out,
      config: testConfig({ ...dash(id), viewer: { defaultDashboard: id } }),
      mode: 'create',
    });
    await s.add(otlp(spansRequest(1)), 'in.json');
    await s.close();
  }
  test('merge without config keeps the first report dashboards and default', async () => {
    const w = createTestWriter();
    await reportWith(w, 'a', 'ops');
    await reportWith(w, 'b', 'other');
    await merge(w, ['a', 'b']);
    const m = manifestOf(w, 'out').config;
    expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['ops']);
    expect(m.viewer.defaultDashboard).toBe('ops');
  });
  test('merge with a config uses its dashboards', async () => {
    const w = createTestWriter();
    await reportWith(w, 'a', 'ops');
    await mergeReports(w.deps, ['a'], { out: 'out', config: testConfig(dash('mine')), mode: 'create' });
    const m = manifestOf(w, 'out').config;
    expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['mine']);
    expect(m.viewer.defaultDashboard).toBe('fusion');
  });
});

function merge(w: TestWriter, inputs: string[], out = 'out') {
  return mergeReports(w.deps, inputs, { out, config: testConfig(), mode: 'create' });
}

/** traceId -> absolute start in unix ns, from a report's own epoch. */
function absoluteStarts(w: TestWriter, out: string): Map<string, bigint> {
  const epoch = parseUnixNanos(manifestOf(w, out).epochUnixNano, 'epoch');
  return new Map(allSpans(w, out).map((s) => [s.traceId, toUnixNanos(s.start, epoch)]));
}

describe('mergeReports', () => {
  test('unions spans, drops duplicates and keeps absolute times across different epochs', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(5, 0, 0)]);
    // Epoch 1_234_567_891 ns later; spans 3 and 4 overlap with report a.
    await writeReport(w, 'b', [spansRequest(5, 1_234_567_891, 3)]);
    expect(manifestOf(w, 'a').epochUnixNano).not.toBe(manifestOf(w, 'b').epochUnixNano);

    const summary = await merge(w, ['a', 'b']);
    expect(summary.totals.spans).toBe(8);
    const merged = absoluteStarts(w, 'out');
    expect(merged.size).toBe(8);
    const a = absoluteStarts(w, 'a');
    const b = absoluteStarts(w, 'b');
    for (let i = 0; i < 8; i++) {
      const id = traceIdOf(i);
      // The first input wins for duplicates; everything else keeps its original absolute time.
      expect(merged.get(id)).toBe(a.get(id) ?? b.get(id));
    }
    expect(manifestOf(w, 'out').complete).toBe(true);
    expect(manifestOf(w, 'a').totals.spans).toBe(5); // inputs untouched
  });

  test('rebases an input that starts before the first one without precision loss', async () => {
    const w = createTestWriter();
    await writeReport(w, 'late', [spansRequest(2, 9_000_000_000_001, 0)]);
    await writeReport(w, 'early', [spansRequest(2, 0, 10)]);
    await merge(w, ['late', 'early']);
    const merged = absoluteStarts(w, 'out');
    const expected = new Map([...absoluteStarts(w, 'late'), ...absoluteStarts(w, 'early')]);
    expect(merged).toEqual(expected);
  });

  test('preserves logs and metrics', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [
      spansRequest(1),
      logsRequest([logRecord({ body: { stringValue: 'from a' } })]),
      metricsRequest([gauge('g', [{ timeUnixNano: '1700000000000000500', asInt: '7' }])]),
    ]);
    await writeReport(w, 'b', [
      logsRequest([logRecord({ body: { stringValue: 'from b' }, timeUnixNano: '1700000001000000000' })]),
    ]);
    const summary = await merge(w, ['a', 'b']);
    expect(summary.totals).toEqual({ spans: 1, logs: 2, metrics: 1 });
    expect(allLogs(w, 'out')).toHaveLength(2);
    expect(allPoints(w, 'out')).toHaveLength(1);
  });

  test('log rollups equal converting both inputs at once (re-ingest invariant)', async () => {
    const w = createTestWriter();
    const req = (bodies: readonly string[], offset: number): JsonObject =>
      logsRequest(
        bodies.map((body, i) =>
          logRecord({
            body: { stringValue: body },
            severityNumber: body.startsWith('disk') ? 17 : 9,
            timeUnixNano: String(BigInt(EPOCH_NS) + BigInt(offset + i * 1000)),
          }),
        ),
      );
    const first = req(['user 1 logged in', 'disk 5 full', 'user 2 logged in'], 0);
    const second = req(['user 9 logged in', 'cache miss for key 7', 'disk 6 full'], 10_000);
    await writeReport(w, 'a', [first]);
    await writeReport(w, 'b', [second]);
    await merge(w, ['a', 'b']);
    await writeReport(w, 'both', [first, second]);
    expect(logRollupsOf(w, 'out').toJSON()).toEqual(logRollupsOf(w, 'both').toJSON());
  });

  test('metric level files equal converting both inputs at once', async () => {
    const w = createTestWriter();
    const host = (h: string): JsonObject[] => [{ key: 'host', value: { stringValue: h } }];
    const ex = (sec: number, v: number, n: number): JsonObject => ({
      timeUnixNano: String(BigInt(EPOCH_NS) + BigInt(sec) * 1_000_000_000n),
      asDouble: v,
      traceId: traceIdOf(n),
      filteredAttributes: [{ key: 'user', value: { stringValue: `u${n}` } }],
    });
    const points = (xs: [number, number][]): [number, number][] => xs;
    const first = withExemplars(
      counterRequest(
        'requests',
        points([
          [0, 1],
          [10, 3],
          [2500, 9],
        ]),
        host('a'),
      ),
      1,
      [ex(9, 0.5, 1)],
    );
    const second = withExemplars(
      counterRequest(
        'requests',
        points([
          [5, 2],
          [15, 5],
        ]),
        host('b'),
      ),
      0,
      [ex(4, 2.5, 2)],
    );
    await writeReport(w, 'a', [first]);
    await writeReport(w, 'b', [second]);
    await merge(w, ['a', 'b']);
    await writeReport(w, 'both', [first, second]);
    const merged = levelsOf(w, 'out', 0);
    expect(merged.map((l) => l.level)).toEqual([0, 1]);
    expect(merged[0]?.series.map((s) => s.id)).toEqual([0, 1]);
    expect(merged).toEqual(levelsOf(w, 'both', 0));
    for (const file of ['data/metrics/000000/ex.js', 'data/metrics/000000/series.js']) {
      const parse = file.endsWith('ex.js') ? parseExemplarFile : parseSeriesFile;
      const out = parse(readDataFile(w, 'out', file), file);
      expect(out).toEqual(parse(readDataFile(w, 'both', file), file));
    }
    expect(
      parseExemplarFile(readDataFile(w, 'out', 'data/metrics/000000/ex.js'), 'ex').exemplars,
    ).toHaveLength(2);
  });

  test('sequential runs of one cumulative series are separate streams, not resets (spec §5.2)', async () => {
    const w = createTestWriter();
    // Run 1 starts at 0 s; run 2, a later process with the same series identity, starts at 100 s.
    const run1 = cumulativeRequest('c', [
      [10, 4, 0],
      [20, 9, 0],
    ]);
    const run2 = cumulativeRequest('c', [
      [110, 3, 100],
      [120, 7, 100],
    ]);
    await writeReport(w, 'a', [run1]);
    await writeReport(w, 'b', [run2]);
    await merge(w, ['a', 'b']);
    const s = levelsOf(w, 'out', 0)[0]?.series[0];
    const deltas = (s?.t ?? []).map((t, i) => {
      const a = s?.a[i];
      return a?.k === 'counter' ? [t, a.delta, a.resets] : [t, Number.NaN, 0];
    });
    // The numbers are each run's own: run 2's first point counts in full from its start.
    expect(deltas.map(([, d, r]) => [d, r])).toEqual([
      [4, 0],
      [5, 0],
      [3, 0],
      [4, 0],
    ]);
    expect(metricCatalogOf(w, 'out').entries()[0]).toMatchObject({ resets: 0, points: 4 });
    // Within one report, the same data is a process restart and counts as one.
    await writeReport(w, 'one', [run1, run2]);
    expect(metricCatalogOf(w, 'one').entries()[0]).toMatchObject({ resets: 1, points: 4 });
  });

  test('rejects an unsupported formatVersion precisely', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await writeReport(w, 'b', [spansRequest(1, 0, 5)]);
    const text = w.fs.snapshot().get('b/data/manifest.js') ?? '';
    const manifest = unwrapDataFile(text, 'manifest') as Record<string, unknown>;
    await w.fs.writeTextAtomic(
      'b/data/manifest.js',
      wrapDataFile('manifest', { ...manifest, formatVersion: 2 }),
    );
    const e = await failure(merge(w, ['a', 'b']));
    expect(e.code).toBe('version-mismatch');
    expect(e.message).toContain('b');
    expect(e.message).toContain('formatVersion 2');
  });

  test('a manifest without a usable formatVersion is an invalid report', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await w.fs.writeTextAtomic('a/data/manifest.js', wrapDataFile('manifest', { nope: true }));
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('a/data/manifest.js');
  });

  test('a missing chunk listed in the manifest is an invalid report naming the file', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(2)]);
    await w.fs.remove('a/data/chunks/spans/000000.js');
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('a/data/chunks/spans/000000.js');
  });

  test('a truncated chunk is an invalid report naming the file', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(2)]);
    const p = 'a/data/chunks/spans/000000.js';
    const text = w.fs.snapshot().get(p) ?? '';
    await w.fs.writeTextAtomic(p, text.slice(0, text.length - 40));
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain(p);
  });

  test('a chunk whose row count disagrees with the manifest is an invalid report', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(2)]);
    const text = w.fs.snapshot().get('a/data/manifest.js') ?? '';
    const manifest = unwrapDataFile(text, 'manifest') as { chunks: { count: number }[] };
    const [first] = manifest.chunks;
    if (first === undefined) throw new Error('no chunk');
    first.count += 1;
    await w.fs.writeTextAtomic('a/data/manifest.js', wrapDataFile('manifest', manifest));
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('a/data/chunks/spans/000000.js');
  });

  test('reports further apart than 2^53 ns fail fast with time-out-of-range and release the lock', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await writeReport(w, 'b', [spansRequest(1, 10_000_000_000_000_000, 5)]);
    const e = await failure(merge(w, ['a', 'b']));
    expect(e.code).toBe('time-out-of-range');
    // The lock was released, so the folder can be used again.
    await merge(w, ['a']);
    expect(manifestOf(w, 'out').totals.spans).toBe(1);
  });

  test('requires inputs and refuses to merge a report into itself', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    expect((await failure(merge(w, []))).code).toBe('usage');
    const e = await failure(merge(w, ['a'], 'a'));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('also an input');
  });

  test('a missing input folder is a usage error naming it', async () => {
    const w = createTestWriter();
    const e = await failure(merge(w, ['nowhere']));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('nowhere');
  });

  test.each([
    ['./a', 'a'],
    ['a/../a', 'a'],
    ['a//', 'a'],
    [resolve('a'), 'a'],
    ['a', resolve('a')],
    ['a/sub', 'a'],
    ['a/sub/deeper', 'a'],
    ['x', 'x/a'],
    ['.', 'a'],
  ])('output %s with input %s is refused and the input is left untouched', async (out, input) => {
    const w = createTestWriter();
    await writeReport(w, input, [spansRequest(2)]);
    const before = w.fs.snapshot();
    const e = await failure(merge(w, [input], out));
    expect(e.code).toBe('usage');
    expect(e.message).toMatch(/input|inside|contains/);
    expect(w.fs.snapshot()).toEqual(before);
  });

  test('an output that is the same folder as an input under another spelling (case, symlink) is refused', async () => {
    const w = createTestWriter();
    await writeReport(w, 'Job', [spansRequest(2)]);
    const before = w.fs.snapshot();
    // A filesystem where `job` and `Job` are one folder, as on case-insensitive macOS or through a symlink.
    const fs = { ...w.fs, realpath: async (p: string): Promise<string> => p.toLowerCase() };
    const e = await failure(
      mergeReports({ ...w.deps, fs }, ['Job'], { out: 'job', config: testConfig(), mode: 'create' }),
    );
    expect(e.code).toBe('usage');
    expect(e.message).toMatch(/input|inside|contains/);
    expect(w.fs.snapshot()).toEqual(before);
  });

  test('sibling folders with a common name prefix are fine', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await merge(w, ['a'], 'a-merged');
    expect(manifestOf(w, 'a-merged').totals.spans).toBe(1);
  });

  test('a failing abort does not mask the original error', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(2)]);
    await w.fs.remove('a/data/chunks/spans/000000.js');
    const fs = {
      ...w.fs,
      remove: async (): Promise<void> => {
        throw new Error('disk on fire');
      },
    };
    const e = await failure(
      mergeReports({ ...w.deps, fs }, ['a'], { out: 'out', config: testConfig(), mode: 'create' }),
    );
    expect(e.code).toBe('invalid-report');
  });
});
