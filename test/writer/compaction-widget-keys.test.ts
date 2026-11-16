import { describe, expect, test } from 'vitest';
import { batchFromRows } from '../../src/format/parquet/batch.js';
import type { Row } from '../../src/format/parquet/rows.js';
import { addRollupRows, spanRollupRows } from '../../src/writer/rollup-rows.js';
import { openSession } from '../../src/writer/session.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, spanIdOf, tableRowsOf, traceIdOf } from './helpers.js';

const WK = 'attr:step.number';
const config = () =>
  testConfig({
    dashboards: [
      {
        id: 'd',
        title: 'D',
        widgets: [
          {
            type: 'toplist',
            signal: 'spans',
            groupBy: 'span.name',
            query: 'attributes["step.number"] != nil',
            x: 0,
            y: 0,
            w: 6,
            h: 6,
          },
        ],
      },
    ],
  });

const spansWith = (from: number, n: number, value: (i: number) => string) =>
  otlp(
    traceRequest(
      Array.from({ length: n }, (_, k) => {
        const i = from + k;
        return span({
          traceId: traceIdOf(i),
          spanId: spanIdOf(i),
          name: `step-${i % 4}`,
          startTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(i)),
          endTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(i) + 10n),
          attributes: [{ key: 'step.number', value: { stringValue: value(i) } }],
        });
      }),
    ),
  );
const small = (i: number): string => String(i % 5);
const unique = (i: number): string =>
  `${(i * 2654435761).toString(16)}-${(i * 40503 + 7).toString(36)}-${'x'.repeat(i % 40)}`;
const canon = (rows: readonly Row[]): string[] =>
  rows.map((r) => JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))).sort();

describe('compacting flushes that disagree on a key only a widget condition tests', () => {
  test('the compacted rollup exists, leaves the key out, and answers as the raw spans do', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: config(), mode: 'replace' });
    await s.add(spansWith(0, 2_000, small), 'a.json');
    await s.flush();
    await s.add(spansWith(10_000, 300, unique), 'b.json');
    await s.flush();
    const flushes = [0, 1].map(
      (n) => manifestOf(w, 'r').partitions[n]?.files.span_rollups?.rollup?.dimensions,
    );
    expect(flushes[0]).toContain(WK);
    expect(flushes[1]).not.toContain(WK);
    await s.close();
    const m = manifestOf(w, 'r');
    expect(m.partitions).toHaveLength(1);
    const file = m.partitions[0]?.files.span_rollups;
    expect(file).toBeDefined();
    const dimensions = file?.rollup?.dimensions ?? [];
    expect(dimensions).not.toContain(WK);
    const raw = tableRowsOf(w, 'r', 'spans');
    expect(raw).toHaveLength(2_300);
    expect(canon(addRollupRows(tableRowsOf(w, 'r', 'span_rollups'), []))).toEqual(
      canon(spanRollupRows(batchFromRows('spans', raw), dimensions)),
    );
  });
});

describe('the warning for a key a rollup leaves out', () => {
  test('is given once per session and key, not on every flush', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: 'r', config: config(), mode: 'replace' });
    for (const [n, from] of [0, 1_000, 2_000].entries()) {
      await s.add(spansWith(from, 300, unique), `u${n}.json`);
      await s.flush();
    }
    await s.close();
    const warned = w.logs.filter((l) => l.level === 'warn' && l.msg.includes(WK));
    expect(warned).toHaveLength(1);
  });
});
