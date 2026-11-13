import { describe, expect, test } from 'vitest';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import { logRecord, logsRequest, span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, spanIdOf, traceIdOf } from './helpers.js';

const KEY = 'resource:run.id';
const resource = [{ key: 'run.id', value: { stringValue: 'run-a' } }];

async function runReport(w: TestWriter, out: string, recorded: boolean): Promise<void> {
  const s = await openSession(w.deps, {
    out,
    config: testConfig(recorded ? { writer: { statisticsKeys: [KEY] } } : {}),
    mode: 'replace',
  });
  const start = 1_700_000_000_000_000_000n;
  const spans = [1, 2, 3].map((n) =>
    span({
      traceId: traceIdOf(n),
      spanId: spanIdOf(n),
      startTimeUnixNano: String(start + BigInt(n) * 1_000_000n),
      endTimeUnixNano: String(start + BigInt(n) * 2_000_000n),
    }),
  );
  await s.add(otlp(traceRequest(spans, resource)), 'in-0.json');
  await s.add(otlp(logsRequest([logRecord({ timeUnixNano: String(start) })], resource)), 'in-1.json');
  await s.close();
}

const merge = (w: TestWriter, inputs: string[], keys: string[]) =>
  mergeReports(w.deps, inputs, {
    out: 'm',
    config: testConfig({ writer: { statisticsKeys: keys } }),
    mode: 'replace',
  });

describe('a merge and the rollups of the partitions it copies', () => {
  test('a rollup lacking a key the target has is computed again, equal to the rollup written with the key', async () => {
    const w = createTestWriter();
    await runReport(w, 'plain', false);
    await runReport(w, 'keyed', true);
    await merge(w, ['plain'], [KEY]);
    const m = manifestOf(w, 'm');
    for (const t of ['span_rollups', 'log_rollups'] as const) {
      const file = m.partitions[0]?.files[t];
      expect(file?.rollup?.dimensions, t).toContain(KEY);
      expect(file?.values[KEY], t).toEqual(['run-a']);
    }
    const keyed = manifestOf(w, 'keyed').partitions[0]?.files.span_rollups;
    expect(keyed?.rollup?.dimensions).toContain(KEY);
    const a = await w.fs.readBytes(`m/${m.partitions[0]?.files.span_rollups?.path}`);
    const b = await w.fs.readBytes(`keyed/${keyed?.path}`);
    expect(Array.from(a)).toEqual(Array.from(b));
    const plain = manifestOf(w, 'plain').partitions[0]?.files.span_rollups;
    expect(plain?.rollup?.dimensions).not.toContain(KEY);
  });

  test('a rollup with the target description is copied byte for byte', async () => {
    const w = createTestWriter();
    await runReport(w, 'keyed', true);
    await merge(w, ['keyed'], [KEY]);
    const from = manifestOf(w, 'keyed').partitions[0];
    const to = manifestOf(w, 'm').partitions[0];
    for (const t of ['span_rollups', 'log_rollups'] as const) {
      expect(to?.files[t]?.rollup).toEqual(from?.files[t]?.rollup);
      const x = await w.fs.readBytes(`keyed/${from?.files[t]?.path}`);
      const y = await w.fs.readBytes(`m/${to?.files[t]?.path}`);
      expect(Array.from(y)).toEqual(Array.from(x));
    }
  });
});
