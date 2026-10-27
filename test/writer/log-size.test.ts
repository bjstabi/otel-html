import { describe, expect, test } from 'vitest';
import { openSession } from '../../src/writer/session.js';
import { scaleLogsRequest, TEST_SCALE_IDS } from '../../test-support/scale-logs.js';
import { createTestWriter, otlp, testConfig } from '../../test-support/writer-deps.js';
import { manifestOf } from './helpers.js';

/** Spec §16: at most this many bytes of chunk files per log record. */
const MAX_BYTES_PER_LOG = 200;
/** Spec §16: writer peak memory for a 1M-log stream. */
const MAX_HEAP_GROWTH_BYTES = 512 * 1024 * 1024;
const OUT = 'r';
const LOAD_ENV = 'OTEL_HTML_LOAD';

describe('log chunk size', () => {
  test(`20k realistic logs take at most ${MAX_BYTES_PER_LOG} bytes each on disk`, async () => {
    const count = 20_000;
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'create' });
    for (let first = 0; first < count; first += 5000)
      await s.add(otlp(scaleLogsRequest(first, 5000, TEST_SCALE_IDS)), 'l.json');
    await s.close();
    const chunks = manifestOf(w, OUT).chunks.filter((c) => c.signal === 'logs');
    const bytes = chunks.reduce((n, c) => n + c.bytes, 0);
    const perLog = bytes / count;
    process.stdout.write(`LOG SIZE ${perLog.toFixed(1)} bytes/log over ${chunks.length} chunks\n`);
    expect(perLog).toBeLessThanOrEqual(MAX_BYTES_PER_LOG);
  });

  // Streams 1M logs through the writer into a sink that keeps no output; run with OTEL_HTML_LOAD=1.
  test.skipIf(process.env[LOAD_ENV] !== '1')(
    'a 1M-log stream keeps writer heap growth under 512 MB',
    { timeout: 600_000 },
    async () => {
      const total = 1_000_000;
      const w = createTestWriter();
      const { writeBytes, writeTextAtomic } = w.fs;
      let sunk = 0;
      w.fs.writeBytes = async (p, b) => {
        if (p.includes('/chunks/')) sunk += b.byteLength;
        else await writeBytes(p, b);
      };
      w.fs.writeTextAtomic = async (p, t) => {
        if (p.includes('/chunks/')) sunk += t.length;
        else await writeTextAtomic(p, t);
      };
      const heap = (): number => {
        globalThis.gc?.();
        return process.memoryUsage().heapUsed;
      };
      const base = heap();
      let peak = base;
      let retained = base;
      const s = await openSession(w.deps, { out: OUT, config: testConfig(), mode: 'create' });
      for (let first = 0; first < total; first += 20_000) {
        await s.add(otlp(scaleLogsRequest(first, 20_000, TEST_SCALE_IDS)), 'l.json');
        peak = Math.max(peak, process.memoryUsage().heapUsed);
        retained = Math.max(retained, heap());
      }
      await s.close();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
      retained = Math.max(retained, heap());
      const mb = (n: number): string => (n / 1048576).toFixed(0);
      process.stdout.write(
        `LOG HEAP growth after GC ${mb(retained - base)} MB, raw peak incl. garbage ${mb(peak - base)} MB, for ${total} logs (${mb(sunk)} MB of chunks)\n`,
      );
      // Retained growth is the writer's own state; the raw peak also holds each 20k-log request being parsed.
      expect(retained - base).toBeLessThan(MAX_HEAP_GROWTH_BYTES);
    },
  );
});
