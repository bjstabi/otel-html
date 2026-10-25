import { describe, expect, test } from 'vitest';
import { unwrapDataFile, wrapDataFile } from '../../src/format/data-file.js';
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
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { allLogs, allPoints, allSpans, manifestOf, spansRequest, traceIdOf } from './helpers.js';

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
});
