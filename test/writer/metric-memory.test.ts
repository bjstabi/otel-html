import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

/** Spec §7: writer peak RSS. */
const MAX_RSS_BYTES = 512 * 1024 * 1024;
const METRICS = 200;
const SERIES = 1_000;
const POINTS = 360;
/** Points per series in each input file; the CLI checkpoints after each file (flushIntervalMs 1). */
const POINTS_PER_FILE = 36;
const LOAD_ENV = 'OTEL_HTML_LOAD';
const run = promisify(execFile);

// Writes the workload as OTLP JSON lines into the named pipes given as arguments, one after the other: 200 metrics ×
// 1,000 series × 36 points per file (half cumulative counters, half gauges, 10 s apart), one metric per line. Pipes
// keep the ~12 GB of text off the disk; to the CLI they are ordinary input files.
const GENERATOR = `import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
const files = process.argv.slice(1);
const epoch = 1700000000000000000n;
const attributes = Array.from({ length: ${SERIES} }, (_, j) => [
  { key: 'host', value: { stringValue: 'host-' + (j % 50) } },
  { key: 'route', value: { stringValue: '/api/v1/route-' + j } },
]);
const resource = { attributes: [{ key: 'service.name', value: { stringValue: 'load' } }] };
const scope = { name: 'load', version: '1' };
for (const [f, file] of files.entries()) {
  const out = createWriteStream(file);
  for (let i = f * ${POINTS_PER_FILE}; i < (f + 1) * ${POINTS_PER_FILE}; i++) {
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
      const line = JSON.stringify({ resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: [metric] }] }] });
      if (!out.write(line + '\\n')) await once(out, 'drain');
    }
  }
  out.end();
  await once(out, 'close');
}`;

// Loaded into the CLI process before its entrypoint: reports that process's own high-water resident set size
// (process.resourceUsage().maxRSS, kilobytes) on stderr as it exits.
const REPORT_RSS = `process.on('exit', () => process.stderr.write('MAXRSS ' + process.resourceUsage().maxRSS + '\\n'));`;

/** Runs `node args` to completion; rejects with its stderr when it fails. */
function node(args: readonly string[]): { done: Promise<string>; kill: () => void } {
  const child = spawn(process.execPath, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (s: string) => {
    stderr += s;
  });
  const done = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0 ? resolve(stderr) : reject(new Error(`exit ${code ?? signal}: ${stderr}`)),
    );
  });
  return { done, kill: () => child.kill() };
}

// The workload as users run it: the built CLI (`otel-html convert`) on OTLP JSON files, in its own process. The
// library API sets no V8 flags; README.md notes its memory on this workload.
// @slow: runs only with OTEL_HTML_LOAD=1 (`mise run test:load`, which builds first).
describe('metric series memory', () => {
  test.skipIf(process.env[LOAD_ENV] !== '1')(
    `otel-html convert of ${METRICS} metrics × ${SERIES} series × ${POINTS} points keeps peak RSS under 512 MB`,
    { timeout: 60 * 60 * 1000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oh-metric-load-'));
      try {
        const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
        const files = Array.from({ length: POINTS / POINTS_PER_FILE }, (_, i) =>
          join(dir, `metrics-${String(i).padStart(2, '0')}.jsonl`),
        );
        await run('mkfifo', files);
        const config = join(dir, 'otel-html.json');
        await writeFile(config, JSON.stringify({ writer: { flushIntervalMs: 1 } }));
        const started = Date.now();
        const generator = node(['--input-type=module', '-e', GENERATOR, ...files]);
        const convert = node([
          '--import',
          `data:text/javascript,${encodeURIComponent(REPORT_RSS)}`,
          cli,
          'convert',
          ...files,
          '-o',
          join(dir, 'report'),
          '--config',
          config,
        ]);
        // A failed convert stops reading its pipes, which would leave the generator blocked on them.
        const stderr = await convert.done.catch((e: unknown) => {
          generator.kill();
          throw e;
        });
        await generator.done;
        const kb = /MAXRSS (\d+)/.exec(stderr)?.[1];
        const peakBytes = Number(kb) * 1024;
        process.stdout.write(
          `METRIC RSS peak ${(peakBytes / 1048576).toFixed(0)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s (otel-html convert)\n`,
        );
        expect(peakBytes).toBeGreaterThan(0);
        expect(peakBytes).toBeLessThan(MAX_RSS_BYTES);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
