import { type ChildProcess, spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRun,
  parseLoadArgs,
  parseManifestJs,
  parseMaxRssKb,
  parseReceived,
  planWorkload,
} from './load-receiver-plan.js';

/**
 * The receiver load test: `otel-html serve` takes spans over OTLP/gRPC and logs over OTLP/HTTP from telemetrygen
 * (in Docker, on the host network, so Linux only), and the finished report must hold every record, reject none and
 * peak under 512 MB of resident memory.
 *
 *   bun scripts/load-receiver.ts --out <dir> [--spans 1000000] [--logs 10000000] [--workers 8] [--image <ref>]
 *
 * Run `mise run build` first: it serves the built CLI. Exits 1 when any assertion fails.
 */
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
// Loaded into the serve process before its entrypoint: reports its own high-water resident set size (kilobytes) on exit.
const REPORT_RSS = `process.on('exit', () => process.stderr.write('MAXRSS ' + process.resourceUsage().maxRSS + '\\n'));`;
// Named, not a literal, so knip does not read the first argument after `node` as an import.
const NODE = 'node';
const HTTP_PORT = 4318;
const GRPC_PORT = 4317;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10 * 60_000;

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
      `data:text/javascript,${encodeURIComponent(REPORT_RSS)}`,
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
    // --rate 0 is unthrottled (the default is 1 per second per worker). A trace is a root plus one child span.
    process.stdout.write(
      `traces: ${args.spans} spans over gRPC (${plan.tracesPerWorker} traces × ${args.workers} workers)\n`,
    );
    await docker([
      args.image,
      'traces',
      '--otlp-insecure',
      '--otlp-endpoint',
      `127.0.0.1:${GRPC_PORT}`,
      '--workers',
      String(args.workers),
      '--traces',
      String(plan.tracesPerWorker),
      '--rate',
      '0',
    ]);
    process.stdout.write(`logs: ${args.logs} over HTTP (${plan.logsPerWorker} × ${args.workers} workers)\n`);
    await docker([
      args.image,
      'logs',
      '--otlp-http',
      '--otlp-insecure',
      '--otlp-endpoint',
      `127.0.0.1:${HTTP_PORT}`,
      '--workers',
      String(args.workers),
      '--logs',
      String(plan.logsPerWorker),
      '--rate',
      '0',
    ]);
  } catch (e) {
    serve.child.kill('SIGKILL');
    throw e;
  }
  const stopTimer = setTimeout(() => serve.child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  serve.child.kill('SIGINT');
  const code = await serve.exited;
  clearTimeout(stopTimer);
  const seconds = (Date.now() - started) / 1000;
  if (code !== 0) throw new Error(`serve exited ${code} after SIGINT: ${serve.stdout()}${serve.stderr()}`);

  const manifest = parseManifestJs(await readFile(join(out, 'data', 'manifest.js'), 'utf8'));
  const rssKb = parseMaxRssKb(serve.stderr());
  const failures = checkRun({
    manifest,
    want: { spans: args.spans, logs: args.logs },
    received: parseReceived(serve.stdout()),
    rssKb,
  });
  const rssMb = rssKb === null ? Number.NaN : rssKb / 1024;
  process.stdout.write(
    `LOAD receiver: spans ${manifest.totals.spans} logs ${manifest.totals.logs} in ${seconds.toFixed(0)} s, peak RSS ${rssMb.toFixed(0)} MB\n`,
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
