import { describe, expect, test } from 'vitest';
import type { Table } from '../../src/format/parquet/columns.js';
import { prunePartitions } from '../../src/query/sql/prune.js';
import { mergeReports } from '../../src/writer/merge.js';
import { openSession } from '../../src/writer/session.js';
import {
  gauge,
  type JsonObject,
  logRecord,
  logsRequest,
  metricsRequest,
  span,
  traceRequest,
} from '../../test-support/otlp-builders.js';
import { createTestWriter, otlp, type TestWriter, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf, spanIdOf, traceIdOf } from './helpers.js';

const KEY = 'resource:run.id';
const resource = (id: string) => [{ key: 'run.id', value: { stringValue: id } }];

async function runReport(w: TestWriter, out: string, id: string, n: number, recorded = true): Promise<void> {
  const s = await openSession(w.deps, {
    out,
    config: testConfig(recorded ? { writer: { statisticsKeys: [KEY] } } : {}),
    mode: 'replace',
  });
  const start = String(1_700_000_000_000_000_000n + BigInt(n) * 1_000_000n);
  const reqs: JsonObject[] = [
    traceRequest(
      [
        span({
          traceId: traceIdOf(n),
          spanId: spanIdOf(n),
          startTimeUnixNano: start,
          endTimeUnixNano: start,
        }),
      ],
      resource(id),
    ),
    logsRequest([logRecord({ timeUnixNano: start, body: { stringValue: id } })], resource(id)),
    metricsRequest([gauge('g', [{ timeUnixNano: start, asDouble: n }])], resource(id)),
  ];
  for (const [i, r] of reqs.entries()) await s.add(otlp(r), `in-${i}.json`);
  await s.close();
}

describe.each([false, true])('#272 merged run reports (compactOnMerge %s)', (compact) => {
  test.each([true, false])(
    '(run writer recorded the key: %s) a run selection keeps only that run’s files',
    async (recorded) => {
      const w = createTestWriter();
      await runReport(w, 'a', 'run-a', 1, recorded);
      await runReport(w, 'b', 'run-b', 2, recorded);
      await mergeReports(w.deps, ['a', 'b'], {
        out: 'm',
        config: testConfig({ writer: { statisticsKeys: [KEY], compactOnMerge: compact } }),
        mode: 'replace',
      });
      const m = manifestOf(w, 'm');
      // every table whose statisticsKeysFor keeps the key; `traces` has no resource column and is not one
      for (const t of ['spans', 'logs', 'points'] as Table[]) {
        const values = (id: string) =>
          m.partitions.filter((p) => p.files[t]?.values[KEY]?.includes(id)).length;
        expect({ t, run: values('run-a'), other: values('run-b') }).toEqual({ t, run: 1, other: 1 });
        const pruned = prunePartitions(m, t, new Map([[KEY, new Set(['run-a'])]]), null);
        expect({ t, kept: pruned.files.length, total: pruned.total }).toEqual({ t, kept: 1, total: 2 });
      }
    },
  );
});
