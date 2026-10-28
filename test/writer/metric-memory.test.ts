import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { parseUnixNanos, type RelNanos } from '../../src/model/ids.js';
import type {
  MetricPointRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import { createNodeFileSystem } from '../../src/writer/node-fs.js';
import type { FileSystem } from '../../src/writer/ports.js';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter, EPOCH_NS, testConfig } from '../../test-support/writer-deps.js';

const METRICS = 200;
const SERIES = 1_000;
const POINTS = 360;
const FLUSH_EVERY = 36;
const INTERVAL_NS = 10_000_000_000;
const MB = 1024 * 1024;
const LOAD_ENV = 'OTEL_HTML_LOAD';

const str = (value: string): AnyValue => ({ kind: 'string', value });

/** Node file system that drops chunk bytes: chunk memory is bounded by `chunkTargetBytes` and not under test. */
function withoutChunks(fs: FileSystem): FileSystem {
  return {
    ...fs,
    writeBytes: (p, bytes) => (p.includes('/data/chunks/') ? Promise.resolve() : fs.writeBytes(p, bytes)),
  };
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// @slow: runs only with OTEL_HTML_LOAD=1 (`mise run test:load`), like the 1M-log RSS test in log-size.test.ts.
describe('metric series memory', () => {
  test.skipIf(process.env[LOAD_ENV] !== '1')(
    '200 metrics × 1,000 series × 360 points keep RSS growth under 512 MB',
    async () => {
      const out = await mkdtemp(join(tmpdir(), 'otel-html-metric-memory-'));
      dirs.push(out);
      const w = createTestWriter();
      const deps = { ...w.deps, fs: withoutChunks(createNodeFileSystem()) };
      const session = await openSession(deps, { out, config: testConfig(), mode: 'create' });
      const epoch = parseUnixNanos(EPOCH_NS, 'epoch');
      const resources: ResourceRecord[] = [
        { attributes: new Map([['service.name', str('load')]]), droppedAttributesCount: 0, schemaUrl: '' },
      ];
      const scopes: ScopeRecord[] = [
        { name: 'load', version: '1', attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' },
      ];
      const attributes = Array.from(
        { length: SERIES },
        (_, j) =>
          new Map<string, AnyValue>([
            ['host', str(`host-${j % 50}`)],
            ['route', str(`/api/v1/route-${j}`)],
          ]),
      );
      globalThis.gc?.();
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const sample = (): void => {
        peak = Math.max(peak, process.memoryUsage().rss);
      };
      for (let i = 0; i < POINTS; i++) {
        const time = (i * INTERVAL_NS) as RelNanos;
        for (let m = 0; m < METRICS; m++) {
          const gauge = m % 2 === 1;
          const rows: MetricPointRecord[] = attributes.map((attrs, j) => ({
            name: `load.metric.${m}`,
            description: '',
            unit: gauge ? 'By' : '1',
            type: gauge ? 'gauge' : 'sum',
            temporality: gauge ? 'unspecified' : 'cumulative',
            monotonic: !gauge,
            start: gauge ? null : (0 as RelNanos),
            time,
            attributes: attrs,
            flags: 0,
            point: { asInt: String(gauge ? (i * 7 + j) % 1000 : i * (j + 1)) },
            resource: 0 as ResourceRef,
            scope: 0 as ScopeRef,
          }));
          await session.addRecords({ signal: 'metrics', rows, resources, scopes, epoch });
        }
        sample();
        if ((i + 1) % FLUSH_EVERY === 0) {
          sample();
          await session.flush();
          sample();
        }
      }
      sample();
      await session.close();
      sample();
      const growthMb = (peak - baseline) / MB;
      process.stdout.write(`metric-memory: peak RSS growth ${growthMb.toFixed(0)} MB\n`);
      expect(growthMb).toBeLessThan(512);
    },
    60 * 60 * 1000,
  );
});
