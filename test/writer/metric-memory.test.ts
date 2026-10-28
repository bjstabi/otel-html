import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

/** Spec §7: writer peak RSS. */
const MAX_RSS_BYTES = 512 * 1024 * 1024;
const METRICS = 200;
const SERIES = 1_000;
const POINTS = 360;
const FLUSH_EVERY = 36;
const LOAD_ENV = 'OTEL_HTML_LOAD';
const run = promisify(execFile);

// The real pipeline: the built library converts 200 metrics × 1,000 series × 360 points (half cumulative counters,
// half gauges, 10 s apart) fed as OTLP JSON one metric at a time, flushing every 36 points, in a child process whose
// own high-water resident set size (process.resourceUsage().maxRSS, kilobytes) is the figure, as log-size.test.ts.
// @slow: runs only with OTEL_HTML_LOAD=1 (`mise run test:load`, which builds first).
describe('metric series memory', () => {
  test.skipIf(process.env[LOAD_ENV] !== '1')(
    `${METRICS} metrics × ${SERIES} series × ${POINTS} points keep peak RSS under 512 MB`,
    { timeout: 60 * 60 * 1000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oh-metric-load-'));
      try {
        const lib = pathToFileURL(fileURLToPath(new URL('../../dist/index.js', import.meta.url))).href;
        const script = `import { Report } from ${JSON.stringify(lib)};
const report = await Report.create({
  out: ${JSON.stringify(join(dir, 'report'))},
  config: { writer: { flushIntervalMs: 86400000 } },
});
const epoch = 1700000000000000000n;
const attributes = Array.from({ length: ${SERIES} }, (_, j) => [
  { key: 'host', value: { stringValue: 'host-' + (j % 50) } },
  { key: 'route', value: { stringValue: '/api/v1/route-' + j } },
]);
const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'load' } }] };
const scope = { name: 'load', version: '1' };
for (let i = 0; i < ${POINTS}; i++) {
  const time = String(epoch + BigInt(i) * 10000000000n);
  for (let m = 0; m < ${METRICS}; m++) {
    const gauge = m % 2 === 1;
    const dataPoints = attributes.map((attrs, j) =>
      gauge
        ? { attributes: attrs, timeUnixNano: time, asInt: String((i * 7 + j) % 1000) }
        : { attributes: attrs, startTimeUnixNano: String(epoch), timeUnixNano: time, asInt: String(i * (j + 1)) },
    );
    const metric = gauge
      ? { name: 'load.metric.' + m, unit: 'By', gauge: { dataPoints } }
      : { name: 'load.metric.' + m, unit: '1', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints } };
    await report.addMetrics({ resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [metric] }] }] });
  }
  if ((i + 1) % ${FLUSH_EVERY} === 0) await report.flush();
}
await report.close();
process.stdout.write(String(process.resourceUsage().maxRSS));`;
        const started = Date.now();
        const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
          maxBuffer: 1024 * 1024,
        });
        const peakBytes = Number(stdout.trim()) * 1024;
        process.stdout.write(
          `METRIC RSS peak ${(peakBytes / 1048576).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s\n`,
        );
        expect(peakBytes).toBeGreaterThan(0);
        expect(peakBytes).toBeLessThan(MAX_RSS_BYTES);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
