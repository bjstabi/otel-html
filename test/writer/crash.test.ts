import { describe, expect, test } from 'vitest';
import { openSession } from '../../src/writer/session.js';
import {
  createProcess,
  createTestWriter,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { allSpans, cell, manifestOf, spansRequest } from './helpers.js';

const OUT = 'r';
const config = testConfig();

function assertManifestSelfConsistent(w: TestWriter): void {
  const files = w.fs.snapshot();
  const m = manifestOf(w, OUT);
  for (const p of m.partitions)
    for (const f of Object.values(p.files)) expect(files.has(`${OUT}/${f.path}`), f.path).toBe(true);
  expect(allSpans(w, OUT)).toHaveLength(m.totals.spans); // every listed partition decodes
}

async function crashedWriter(failSuffix: string): Promise<{ w: TestWriter; manifestBefore: string }> {
  const w = createTestWriter();
  const a = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
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

describe.each(['data/manifest.js', 'data/state/session.1.json', 'data/partitions/000001/spans.parquet'])(
  'writer killed mid-flush (%s fails)',
  (failSuffix) => {
    test('the previous manifest stays valid and every partition it lists decodes', async () => {
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
      expect(manifestOf(w, OUT)).toMatchObject({ complete: true, totals: { spans: 15 } });
      const spans = allSpans(w, OUT);
      expect(spans).toHaveLength(15);
      expect(new Set(spans.map((s) => cell(s, 'span_id'))).size).toBe(15);
      assertManifestSelfConsistent(w);
    });
  },
);

describe('a failed flush on a live session', () => {
  test('retrying the flush succeeds without double counting', async () => {
    const w = createTestWriter();
    const a = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await a.add(otlp(spansRequest(4)), 'a.json');
    w.fs.failNextWrite('data/manifest.js');
    await expect(a.flush()).rejects.toThrow(/injected/);
    await a.add(otlp(spansRequest(2, 0, 4)), 'b.json');
    await a.close();
    const m = manifestOf(w, OUT);
    expect(m).toMatchObject({ complete: true, totals: { spans: 6 } });
    expect(allSpans(w, OUT)).toHaveLength(6);
  });
});
