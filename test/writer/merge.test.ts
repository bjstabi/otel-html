import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import {
  gauge,
  type JsonObject,
  logRecord,
  logsRequest,
  metricsRequest,
} from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import {
  allLogs,
  allPoints,
  allSpans,
  cell,
  copyFrozenReport,
  manifestOf,
  spansRequest,
  traceIdOf,
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
    config: testConfig(),
    mode: 'replace',
  });
  for (const [i, r] of requests.entries()) await s.add(otlp(r), `in-${i}.json`);
  await s.close();
}

describe('dashboards', () => {
  const dash = (id: string) => ({
    dashboards: [{ id, title: id, widgets: [{ type: 'traces' as const, x: 0, y: 0, w: 6, h: 6 }] }],
  });
  async function reportWith(w: TestWriter, out: string, id: string, firstIndex = 0): Promise<void> {
    const s = await openSession(w.deps, {
      out,
      config: testConfig({ ...dash(id), viewer: { defaultDashboard: id } }),
      mode: 'replace',
    });
    await s.add(otlp(spansRequest(1, 0, firstIndex)), 'in.json');
    await s.close();
  }
  test('merge into an existing report adds the inputs to it', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, {
      out: 'out',
      config: testConfig({ ...dash('ops'), title: 'A title' }),
      mode: 'replace',
    });
    await s.add(otlp(spansRequest(1)), 'a.json');
    await s.close();
    await reportWith(w, 'b', 'other', 1);
    await reportWith(w, 'c', 'third', 2);
    const summary = await mergeReports(w.deps, ['b', 'c'], {
      out: 'out',
      config: testConfig(),
      mode: 'open',
    });
    expect(summary.totals.spans).toBe(3);
    expect(allSpans(w, 'out')).toHaveLength(3);
    const m = manifestOf(w, 'out');
    expect(m.title).toBe('A title');
    expect(m.config.dashboards.map((d) => d.dashboard.id)).toEqual(['ops']);
  });

  test('merge with replace: true writes a fresh combined report', async () => {
    const w = createTestWriter();
    await reportWith(w, 'out', 'ops');
    await reportWith(w, 'b', 'other', 1);
    await reportWith(w, 'c', 'third', 2);
    const summary = await mergeReports(w.deps, ['b', 'c'], {
      out: 'out',
      config: testConfig(),
      mode: 'replace',
    });
    expect(summary.totals.spans).toBe(2);
    expect(manifestOf(w, 'out').config.dashboards.map((d) => d.dashboard.id)).toEqual(['other']);
  });

  test('merge without config keeps the first report dashboards and default', async () => {
    const w = createTestWriter();
    await reportWith(w, 'a', 'ops');
    await reportWith(w, 'b', 'other');
    await merge(w, ['a', 'b']);
    const m = manifestOf(w, 'out').config;
    expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['ops']);
    expect(m.viewer.defaultDashboard).toBe('ops');
  });
  test('merge without config keeps the first report defaultWindow; a config that sets one replaces it', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, {
      out: 'a',
      config: testConfig({ viewer: { defaultWindow: '7d' } }),
      mode: 'replace',
    });
    await s.add(otlp(spansRequest(1)), 'in.json');
    await s.close();
    await merge(w, ['a']);
    expect(manifestOf(w, 'out').config.viewer).toMatchObject({ defaultWindow: '7d' });
    await mergeReports(w.deps, ['a'], {
      out: 'out2',
      config: testConfig({ viewer: { defaultWindow: '6h' } }),
      mode: 'replace',
    });
    expect(manifestOf(w, 'out2').config.viewer).toMatchObject({ defaultWindow: '6h' });
  });
  test('merge keeps the first input views when the config gives none', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, {
      out: 'a',
      config: testConfig({ views: [{ id: 'v', title: 'V', page: 'traces' }] }),
      mode: 'replace',
    });
    await s.add(otlp(spansRequest(1)), 'in.json');
    await s.close();
    await mergeReports(w.deps, ['a'], { out: 'out', config: testConfig(dash('mine')), mode: 'replace' });
    expect(manifestOf(w, 'out').config.views.map((v) => v.id)).toEqual(['v']);
  });
  test('merge with a config uses its dashboards', async () => {
    const w = createTestWriter();
    await reportWith(w, 'a', 'ops');
    await mergeReports(w.deps, ['a'], { out: 'out', config: testConfig(dash('mine')), mode: 'replace' });
    const m = manifestOf(w, 'out').config;
    expect(m.dashboards.map((d) => d.dashboard.id)).toEqual(['mine']);
    expect(m.viewer.defaultDashboard).toBe('fusion');
  });
});

function merge(w: TestWriter, inputs: string[], out = 'out') {
  return mergeReports(w.deps, inputs, { out, config: testConfig(), mode: 'replace' });
}

/** traceId -> absolute start in unix ns, from a report's own epoch. */
function absoluteStarts(w: TestWriter, out: string): Map<string, bigint> {
  return new Map(
    allSpans(w, out).map((s) => [
      String(cell(s, 'trace_id')),
      BigInt(String(cell(s, 'start_time_unix_nano'))),
    ]),
  );
}

describe('mergeReports', () => {
  test('unions spans and keeps absolute times across different epochs', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(5, 0, 0)]);
    // Epoch 1_234_567_891 ns later. Format-4 inputs are copied, not deduplicated, so none overlaps.
    await writeReport(w, 'b', [spansRequest(5, 1_234_567_891, 5)]);
    expect(manifestOf(w, 'a').epochUnixNano).not.toBe(manifestOf(w, 'b').epochUnixNano);

    const summary = await merge(w, ['a', 'b']);
    expect(summary.totals.spans).toBe(10);
    const merged = absoluteStarts(w, 'out');
    expect(merged.size).toBe(10);
    const a = absoluteStarts(w, 'a');
    const b = absoluteStarts(w, 'b');
    for (let i = 0; i < 10; i++) {
      const id = traceIdOf(i);
      // Every span keeps its original absolute time.
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

  test('rejects an unsupported formatVersion precisely', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await writeReport(w, 'b', [spansRequest(1, 0, 5)]);
    const text = w.fs.snapshot().get('b/data/manifest.js') ?? '';
    const manifest = unwrapDataFile(text, 'manifest') as Record<string, unknown>;
    await w.fs.writeTextAtomic(
      'b/data/manifest.js',
      wrapDataFile('manifest', { ...manifest, formatVersion: 6 }),
    );
    const e = await failure(merge(w, ['a', 'b']));
    expect(e.code).toBe('version-mismatch');
    expect(e.message).toContain('b');
    expect(e.message).toContain('formatVersion 6');
  });

  test('merges a format-1 report: merge replays chunks, laid out alike in every readable version', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await copyFrozenReport(w, 'b', 'format-1');
    await merge(w, ['a', 'b']);
    expect(manifestOf(w, 'out').formatVersion).toBe(5);
  });

  test('a manifest without a usable formatVersion is an invalid report', async () => {
    const w = createTestWriter();
    await writeReport(w, 'a', [spansRequest(1)]);
    await w.fs.writeTextAtomic('a/data/manifest.js', wrapDataFile('manifest', { nope: true }));
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain('a/data/manifest.js');
  });

  const CHUNK = 'a/data/chunks/spans/000000.js';

  test('a missing chunk listed in the manifest is an invalid report naming the file', async () => {
    const w = createTestWriter();
    await copyFrozenReport(w, 'a');
    await w.fs.remove(CHUNK);
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain(CHUNK);
  });

  test('a truncated chunk is an invalid report naming the file', async () => {
    const w = createTestWriter();
    await copyFrozenReport(w, 'a');
    const text = w.fs.snapshot().get(CHUNK) ?? '';
    await w.fs.writeTextAtomic(CHUNK, text.slice(0, text.length - 40));
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain(CHUNK);
  });

  test('a chunk whose row count disagrees with the manifest is an invalid report', async () => {
    const w = createTestWriter();
    await copyFrozenReport(w, 'a');
    const text = w.fs.snapshot().get('a/data/manifest.js') ?? '';
    const manifest = unwrapDataFile(text, 'manifest') as { chunks: { count: number }[] };
    const [first] = manifest.chunks;
    if (first === undefined) throw new Error('no chunk');
    first.count += 1;
    await w.fs.writeTextAtomic('a/data/manifest.js', wrapDataFile('manifest', manifest));
    const e = await failure(merge(w, ['a']));
    expect(e.code).toBe('invalid-report');
    expect(e.message).toContain(CHUNK);
  });

  test('reports further apart than 2^53 ns fail fast with time-out-of-range and release the lock', async () => {
    const w = createTestWriter();
    await copyFrozenReport(w, 'a');
    await copyFrozenReport(w, 'b');
    const text = w.fs.snapshot().get('b/data/manifest.js') ?? '';
    const epoch = /"epochUnixNano":"(\d+)"/.exec(text)?.[1] ?? '';
    const far = (BigInt(epoch) + 10_000_000_000_000_000n).toString();
    await w.fs.writeTextAtomic('b/data/manifest.js', text.replace(epoch, far));
    const e = await failure(merge(w, ['a', 'b']));
    expect(e.code).toBe('time-out-of-range');
    // The lock was released, so the folder can be used again.
    await merge(w, ['a']);
    expect(manifestOf(w, 'out').totals.spans).toBeGreaterThan(0);
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
      mergeReports({ ...w.deps, fs }, ['Job'], { out: 'job', config: testConfig(), mode: 'replace' }),
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
    await copyFrozenReport(w, 'a');
    await w.fs.remove(CHUNK);
    const fs = {
      ...w.fs,
      remove: async (): Promise<void> => {
        throw new Error('disk on fire');
      },
    };
    const e = await failure(
      mergeReports({ ...w.deps, fs }, ['a'], { out: 'out', config: testConfig(), mode: 'replace' }),
    );
    expect(e.code).toBe('invalid-report');
  });
});
