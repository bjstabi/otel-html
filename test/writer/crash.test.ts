import { describe, expect, test } from 'vitest';
import { reviveDataJson, unwrapDataFile } from '../../src/format/data-file.js';
import { TraceShardSchema } from '../../src/format/trace-shard.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest } from '../../test-support/otlp-builders.js';
import {
  createProcess,
  createTestWriter,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { allLogs, allSpans, manifestOf, spansRequest } from './helpers.js';

const OUT = 'r';
const config = testConfig({ writer: { chunkTargetBytes: 1 } }); // one chunk per span: many chunk files

function assertManifestSelfConsistent(w: TestWriter): void {
  const files = w.fs.snapshot();
  const m = manifestOf(w, OUT);
  for (const c of m.chunks) expect(files.has(`${OUT}/${c.path}`), c.path).toBe(true);
  expect(allSpans(w, OUT)).toHaveLength(m.totals.spans); // every listed chunk decodes
}

async function crashedWriter(failSuffix: string): Promise<{ w: TestWriter; manifestBefore: string }> {
  const w = createTestWriter();
  const a = await openSession(w.deps, { out: OUT, config, mode: 'create' });
  await a.add(otlp(spansRequest(10)), 'first.json');
  await a.flush();
  const manifestBefore = w.fs.snapshot().get('r/data/manifest.js') ?? '';
  await a.add(otlp(spansRequest(5, 0, 10)), 'second.json');
  w.fs.failNextWrite(failSuffix);
  await expect(a.flush()).rejects.toThrow(/injected write failure/);
  // the writer process dies here: its pid is no longer alive, its lock stays behind
  w.process.alive.delete(w.process.pid);
  return { w, manifestBefore };
}

describe.each(['data/manifest.js', 'data/state/session.1.json', 'data/rollups/spans.js'])(
  'writer killed mid-flush (%s fails)',
  (failSuffix) => {
    test('the previous manifest stays valid and every chunk it lists decodes', async () => {
      const { w, manifestBefore } = await crashedWriter(failSuffix);
      expect(w.fs.snapshot().get('r/data/manifest.js')).toBe(manifestBefore);
      assertManifestSelfConsistent(w);
      expect(manifestOf(w, OUT)).toMatchObject({ complete: false, totals: { spans: 10 } });
    });

    test('append resumes cleanly: lost data is re-added, nothing is double counted', async () => {
      const { w } = await crashedWriter(failSuffix);
      const deps = { ...w.deps, process: createProcess(9001, w.process.hostname) };
      const b = await openSession(deps, { out: OUT, config, mode: 'append' });
      expect(w.logs.some((l) => l.level === 'warn' && l.msg.includes('stale'))).toBe(true);
      // The first 10 spans were committed: re-sending them is all duplicates; the 5 lost ones are new again.
      expect(await b.add(otlp(spansRequest(10)), 'first-again.json')).toEqual({
        accepted: 0,
        dropped: 0,
        duplicates: 10,
      });
      expect(await b.add(otlp(spansRequest(5, 0, 10)), 'second-again.json')).toEqual({
        accepted: 5,
        dropped: 0,
        duplicates: 0,
      });
      const summary = await b.close();
      expect(summary.totals.spans).toBe(15);
      const m = manifestOf(w, OUT);
      expect(m).toMatchObject({ complete: true, totals: { spans: 15 } });
      expect(m.chunks.map((c) => c.n)).toEqual(Array.from({ length: 15 }, (_, i) => i));
      const spans = allSpans(w, OUT);
      expect(spans).toHaveLength(15);
      expect(new Set(spans.map((s) => s.spanId)).size).toBe(15);
      // trace index counts each span once, and only references listed chunks
      const listed = new Set(m.chunks.map((c) => c.path.slice('data/'.length, -'.js'.length)));
      let indexed = 0;
      for (const p of m.traceShards) {
        const shard = p.slice('data/traces/'.length, -'.js'.length);
        const text = w.fs.snapshot().get(`r/${p}`) ?? '';
        const entries = TraceShardSchema.parse(reviveDataJson(unwrapDataFile(text, `traces/${shard}`)));
        for (const e of Object.values(entries)) {
          indexed += e.spans;
          for (const c of e.chunks) expect(listed.has(c), c).toBe(true);
        }
      }
      expect(indexed).toBe(15);
    });
  },
);

describe('a chunk write fails during add', () => {
  test('the request is accepted once, the chunk is retried at flush, and nothing is double counted', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: OUT, config, mode: 'create' });
    w.fs.failNextWrite('data/chunks/spans/000001.js');
    await a.add(otlp(spansRequest(1)), 'a.json');
    expect(await a.add(otlp(spansRequest(1, 0, 1)), 'b.json')).toMatchObject({ accepted: 1 });
    expect(w.logs.some((l) => l.level === 'error' && l.msg.includes('chunk write failed'))).toBe(true);
    await a.close();
    const m = manifestOf(w, OUT);
    expect(m.chunks.map((c) => c.n)).toEqual([0, 1]);
    expect(m.totals.spans).toBe(2);
    expect(allSpans(w, OUT)).toHaveLength(2);
  });

  test('after a clean flush, flush still checkpoints state so append works', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: OUT, config, mode: 'create' });
    await a.add(otlp(spansRequest(2)), 'a.json');
    await a.flush(); // clean: nothing pending
    w.fs.failNextWrite('data/chunks/spans/000002.js');
    await a.add(otlp(spansRequest(1, 0, 2)), 'b.json');
    await a.flush();
    expect(manifestOf(w, OUT).totals.spans).toBe(3);
    w.process.alive.delete(w.process.pid);
    const deps = { ...w.deps, process: createProcess(9001, w.process.hostname) };
    const b = await openSession(deps, { out: OUT, config, mode: 'append' });
    expect(await b.add(otlp(spansRequest(3)), 'again.json')).toMatchObject({ accepted: 0, duplicates: 3 });
    expect((await b.close()).totals.spans).toBe(3);
  });

  test('logs and metrics are counted once even when their chunk writes fail', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: OUT, config, mode: 'create' });
    w.fs.failNextWrite('data/chunks/logs/000000.js');
    const logs = Array.from({ length: 3 }, () => logRecord({}));
    expect(await a.add(otlp(logsRequest(logs)), 'l.json')).toMatchObject({ accepted: 3 });
    expect((await a.close()).totals.logs).toBe(3);
    expect(allLogs(w, OUT)).toHaveLength(3);
  });
});

describe('a failed flush on a live session', () => {
  test('retrying the flush succeeds without double counting', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: OUT, config, mode: 'create' });
    await a.add(otlp(spansRequest(4)), 'a.json');
    w.fs.failNextWrite('data/manifest.js');
    await expect(a.flush()).rejects.toThrow(/injected/);
    await a.add(otlp(spansRequest(2, 0, 4)), 'b.json');
    await a.close();
    const m = manifestOf(w, OUT);
    expect(m).toMatchObject({ complete: true, totals: { spans: 6 } });
    expect(m.chunks).toHaveLength(6);
    expect(allSpans(w, OUT)).toHaveLength(6);
  });
});
