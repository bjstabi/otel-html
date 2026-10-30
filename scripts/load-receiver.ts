import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRun,
  formatServeFigures,
  logsArgs,
  parseLoadArgs,
  parseManifestJs,
  parseMaxRssKb,
  parseReceived,
  planWorkload,
  tracesArgs,
} from './load-receiver-plan.js';

/**
 * The receiver load test: `otel-html serve` takes spans over OTLP/gRPC and logs over OTLP/HTTP from telemetrygen
 * (in Docker, on the host network, so Linux only), and the finished report must hold every record, reject none and
 * peak under 512 MB of resident memory.
 *
 *   bun scripts/load-receiver.ts --out <dir> [--spans 1000000] [--logs 1000000] [--workers 8] [--image <ref>]
 *
 * Run `mise run build` first: it serves the built CLI. Exits 1 when any assertion fails.
 */
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
// Loaded into the serve process before its entrypoint. On exit it writes to stderr, synchronously: the high-water
// resident set size (kilobytes), the event-loop delay (p99 and max, ms) and the GC pause count, total and max (ms).
const PRELOAD = `
import { writeSync } from 'node:fs';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
let gcCount = 0, gcTotal = 0, gcMax = 0;
const tally = (entries) => {
  for (const e of entries) { gcCount++; gcTotal += e.duration; if (e.duration > gcMax) gcMax = e.duration; }
};
const obs = new PerformanceObserver((list) => tally(list.getEntries()));
obs.observe({ entryTypes: ['gc'] });
process.on('exit', () => {
  tally(obs.takeRecords());
  h.disable();
  const ms = (ns) => (ns / 1e6).toFixed(1);
  writeSync(2, 'MAXRSS ' + process.resourceUsage().maxRSS + '\\n'
    + 'LOOP p99 ' + ms(h.percentile(99)) + ' max ' + ms(h.max) + '\\n'
    + 'GC count ' + gcCount + ' total ' + gcTotal.toFixed(1) + ' max ' + gcMax.toFixed(1) + '\\n');
});
`;
// Named, not a literal, so knip does not read the first argument after `node` as an import.
const NODE = 'node';
const HTTP_PORT = 4318;
const GRPC_PORT = 4317;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10 * 60_000;
// After a generator failure the receiver only has to exit and print its figures, not finish a report, so wait less.
const FAILED_STOP_TIMEOUT_MS = 60_000;

interface Serve {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function startServe(out: string): Promise<Serve> {
  const child = spawn(
    NODE,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(PRELOAD)}`,
      CLI,
      'serve',
      '-o',
      out,
      '--http',
      String(HTTP_PORT),
      '--grpc',
      String(GRPC_PORT),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  const exited = new Promise<number | null>((done) => child.on('close', (code) => done(code)));
  const serve: Serve = { child, stdout: () => stdout, stderr: () => stderr, exited };
  child.stderr.setEncoding('utf8').on('data', (s: string) => {
    stderr += s;
  });
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`serve printed no listening line in ${START_TIMEOUT_MS} ms: ${stdout}${stderr}`));
    }, START_TIMEOUT_MS);
    child.on('error', fail);
    exited.then((code) => fail(new Error(`serve exited early (${code}): ${stdout}${stderr}`)));
    child.stdout.setEncoding('utf8').on('data', (s: string) => {
      stdout += s;
      if (stdout.includes('press Ctrl-C to finish')) {
        clearTimeout(timer);
        ok(serve);
      }
    });
  });
}

/** SIGINT, then SIGKILL if serve has not exited within `timeoutMs`; resolves with its exit code. */
async function stopServe(serve: Serve, timeoutMs: number): Promise<number | null> {
  const timer = setTimeout(() => serve.child.kill('SIGKILL'), timeoutMs);
  serve.child.kill('SIGINT');
  const code = await serve.exited;
  clearTimeout(timer);
  return code;
}

function docker(args: readonly string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn('docker', ['run', '--rm', '--network', 'host', ...args], { stdio: 'inherit' });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0 ? ok() : fail(new Error(`docker ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function main(): Promise<number> {
  const args = parseLoadArgs(process.argv.slice(2));
  const plan = planWorkload(args);
  const out = resolve(args.out);
  await rm(out, { recursive: true, force: true });
  const started = Date.now();
  const serve = await startServe(out);
  try {
    // Traces are paced (see SPANS_PER_SECOND_PER_WORKER); a trace is a root plus one child span.
    process.stdout.write(
      `traces: ${args.spans} spans over gRPC (${plan.tracesPerWorker} traces × ${args.workers} workers)\n`,
    );
    let phase = Date.now();
    await docker(tracesArgs(args.image, GRPC_PORT, args.workers, plan.tracesPerWorker));
    process.stdout.write(`traces: generator finished in ${((Date.now() - phase) / 1000).toFixed(0)} s\n`);
    process.stdout.write(`logs: ${args.logs} over HTTP (${plan.logsPerWorker} × ${args.workers} workers)\n`);
    phase = Date.now();
    await docker(logsArgs(args.image, HTTP_PORT, args.workers, plan.logsPerWorker));
    process.stdout.write(`logs: generator finished in ${((Date.now() - phase) / 1000).toFixed(0)} s\n`);
  } catch (e) {
    // Stop it gracefully so the preload's exit handler still prints the figures; SIGKILL would skip it.
    await stopServe(serve, FAILED_STOP_TIMEOUT_MS);
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${reason}\nreceiver at failure: ${formatServeFigures(serve.stderr())}\n${serve.stderr()}`,
    );
  }
  const code = await stopServe(serve, STOP_TIMEOUT_MS);
  const seconds = (Date.now() - started) / 1000;
  if (code !== 0) throw new Error(`serve exited ${code} after SIGINT: ${serve.stdout()}${serve.stderr()}`);

  const receivedLine = /^.*received \d+ requests.*$/m.exec(serve.stdout());
  if (receivedLine !== null) process.stdout.write(`${receivedLine[0]}\n`);
  const manifest = parseManifestJs(await readFile(join(out, 'data', 'manifest.js'), 'utf8'));
  const rssKb = parseMaxRssKb(serve.stderr());
  const failures = checkRun({
    manifest,
    want: { spans: args.spans, logs: args.logs },
    received: parseReceived(serve.stdout()),
    rssKb,
  });
  process.stdout.write(
    `LOAD receiver: spans ${manifest.totals.spans} logs ${manifest.totals.logs} in ${seconds.toFixed(0)} s, ${formatServeFigures(serve.stderr())}\n`,
  );
  for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
  return failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
