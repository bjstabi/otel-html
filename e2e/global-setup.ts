import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Report } from '../src/api/index.js';
import { scaleLogsRequest } from '../test-support/scale-logs.js';
import {
  FIXTURE_REPORTS,
  fixtureFiles,
  HOSTILE_REPORT_DIR,
  HOSTILE_SPAN_NAME,
  HUGE_EAGER_BUDGET_BYTES,
  httpSubpath,
  LARGE_REPORT_DIR,
  LARGE_SPAN_COUNT,
  LARGE_TRACE_ID,
  PORT_ENV,
  REPORT_DIR,
  REPORTS_DIR,
  type ReportName,
  RUN_TITLE,
  reportDir,
  SCALE_LOG_FILES,
  SCALE_LOG_IDS,
  SCALE_LOGS,
  SCALE_SERVICES,
  SCALE_SPANS_PER_TRACE,
  SCALE_TRACES,
  SERVICE_A,
  SERVICE_B,
  scaleTraceId,
  TRACE_1,
  TRACE_2,
} from './fixture.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const str = (key: string, value: string): { key: string; value: { stringValue: string } } => ({
  key,
  value: { stringValue: value },
});

/** A tiny OTLP/JSON input: two traces over two services, 6 spans of which 2 error, a hostile span name, one log, one metric. */
function otlpInputs(): Record<string, unknown> {
  const t0 = 1_700_000_000_000_000_000n;
  const span = (
    traceId: string,
    spanId: string,
    name: string,
    offsetMs: number,
    parent?: string,
    error = false,
  ) => ({
    traceId,
    spanId,
    ...(parent === undefined ? {} : { parentSpanId: parent }),
    name,
    kind: 2,
    startTimeUnixNano: String(t0 + BigInt(offsetMs) * 1_000_000n),
    endTimeUnixNano: String(t0 + BigInt(offsetMs + 40) * 1_000_000n),
    ...(error ? { status: { code: 2, message: 'boom' } } : {}),
  });
  const resource = { attributes: [str('service.name', SERVICE_A)] };
  const dbResource = { attributes: [str('service.name', SERVICE_B)] };
  const scope = { name: 'e2e' };
  const trace1 = TRACE_1;
  const trace2 = TRACE_2;
  return {
    'traces.json': {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                span(trace1, '0102030405060708', 'GET /root', 0),
                span(trace2, '0302030405060708', HOSTILE_SPAN_NAME, 100),
                span(trace2, '0602030405060708', 'GET /health', 200),
              ],
            },
          ],
        },
        {
          resource: dbResource,
          scopeSpans: [
            {
              scope,
              spans: [
                span(trace1, '0202030405060708', 'db.query', 5, '0102030405060708', true),
                span(trace1, '0402030405060708', 'db.commit', 20, '0102030405060708'),
                span(trace2, '0502030405060708', 'db.timeout', 110, '0302030405060708', true),
              ],
            },
          ],
        },
      ],
    },
    'logs.json': {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: String(t0 + 10_000_000n),
                  severityNumber: 9,
                  body: { stringValue: 'hello' },
                  traceId: trace1,
                  spanId: '0102030405060708',
                },
              ],
            },
          ],
        },
      ],
    },
    'metrics.json': {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope,
              metrics: [
                {
                  name: 'requests',
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [{ timeUnixNano: String(t0 + 20_000_000n), asInt: '3' }],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** `otel-html <args>` with the built CLI. */
async function cli(args: string[], env?: Record<string, string>): Promise<void> {
  await run(process.execPath, [CLI, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
}

async function convertTo(
  out: URL,
  inputs: readonly string[],
  title: string,
  env?: Record<string, string>,
): Promise<void> {
  await cli(['convert', ...inputs, '--out', fileURLToPath(out), '--title', title], env);
}

async function buildReport(): Promise<void> {
  const inputs = new URL('inputs/', REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const files: string[] = [];
  for (const [name, body] of Object.entries(otlpInputs())) {
    const path = fileURLToPath(new URL(name, inputs));
    await writeFile(path, JSON.stringify(body));
    files.push(path);
  }
  await convertTo(REPORT_DIR, files, RUN_TITLE);
  // A copy of the main report whose manifest is really gone: request interception does not reach
  // file:// loads in every browser, so the load-failure spec needs the file absent on disk.
  const noManifest = reportDir('no-manifest');
  await cp(REPORT_DIR, noManifest, { recursive: true });
  await rm(new URL('data/manifest.js', noManifest));
}

/** One trace of `LARGE_SPAN_COUNT` spans: a 4-ary tree over 5 services, children inside their parent's start. */
function largeTraceInput(): unknown {
  const t0 = 1_700_000_000_000_000_000n;
  const hex = (n: number, width: number): string => (n + 1).toString(16).padStart(width, '0');
  const services = ['edge', 'api', 'auth', 'db', 'cache'];
  const buckets: Record<string, unknown[]> = Object.fromEntries(services.map((s) => [s, []]));
  for (let i = 0; i < LARGE_SPAN_COUNT; i++) {
    const start = t0 + BigInt(i) * 20_000n;
    const service = services[i % services.length] ?? 'edge';
    buckets[service]?.push({
      traceId: LARGE_TRACE_ID,
      spanId: hex(i, 16),
      ...(i === 0 ? {} : { parentSpanId: hex(Math.floor((i - 1) / 4), 16) }),
      name: `op-${i % 97}`,
      kind: 1,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + 1_000_000n + BigInt((i % 7) * 100_000)),
      ...(i % 211 === 0 ? { status: { code: 2, message: 'boom' } } : {}),
    });
  }
  return {
    resourceSpans: services.map((service) => ({
      resource: { attributes: [str('service.name', service)] },
      scopeSpans: [{ scope: { name: 'e2e-large' }, spans: buckets[service] }],
    })),
  };
}

async function buildLargeReport(): Promise<void> {
  const inputs = new URL('large-inputs/', REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const file = fileURLToPath(new URL('traces.json', inputs));
  await writeFile(file, JSON.stringify(largeTraceInput()));
  await convertTo(LARGE_REPORT_DIR, [file], 'large trace');
}

/** `SCALE_TRACES` traces of `SCALE_SPANS_PER_TRACE` spans each (4-ary trees over 8 services), time-ordered, ~2% errors. */
function scaleInput(): unknown {
  const t0 = 1_700_000_000_000_000_000n;
  const hex = (n: number, width: number): string => (n + 1).toString(16).padStart(width, '0');
  const buckets: Record<string, unknown[]> = Object.fromEntries(SCALE_SERVICES.map((s) => [s, []]));
  for (let t = 0; t < SCALE_TRACES; t++) {
    const traceStart = t0 + BigInt(t) * 5_000_000n;
    for (let j = 0; j < SCALE_SPANS_PER_TRACE; j++) {
      const service = SCALE_SERVICES[j % SCALE_SERVICES.length] ?? 'edge';
      const start = traceStart + BigInt(j) * 40_000n;
      buckets[service]?.push({
        traceId: scaleTraceId(t),
        spanId: hex(t * SCALE_SPANS_PER_TRACE + j, 16),
        ...(j === 0 ? {} : { parentSpanId: hex(t * SCALE_SPANS_PER_TRACE + Math.floor((j - 1) / 4), 16) }),
        name: `op-${j % 23}`,
        kind: 1 + (j % 3),
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(start + 300_000n + BigInt(((t + j) % 11) * 50_000)),
        attributes: [
          str('http.request.method', j % 5 === 0 ? 'POST' : 'GET'),
          str('http.route', `/r/${j % 9}`),
        ],
        ...((t * SCALE_SPANS_PER_TRACE + j) % 47 === 0 ? { status: { code: 2, message: 'boom' } } : {}),
      });
    }
  }
  return {
    resourceSpans: SCALE_SERVICES.map((service) => ({
      resource: { attributes: [str('service.name', service)] },
      scopeSpans: [{ scope: { name: 'e2e-scale' }, spans: buckets[service] }],
    })),
  };
}

/** The scale logs as `SCALE_LOG_FILES` files, each generated and written on its own so memory stays at one file. */
async function writeScaleLogFiles(dir: URL): Promise<string[]> {
  const per = SCALE_LOGS / SCALE_LOG_FILES;
  const files: string[] = [];
  for (let f = 0; f < SCALE_LOG_FILES; f++) {
    const file = fileURLToPath(new URL(`logs-${f}.json`, dir));
    await writeFile(file, JSON.stringify(scaleLogsRequest(f * per, per, SCALE_LOG_IDS)));
    files.push(file);
  }
  return files;
}

/**
 * One input of 100k spans and 1M logs (10 files), converted twice: `scale` with default settings (spans eager, logs
 * windowed) and `huge` over a 5 MB eager budget (both windowed).
 */
async function buildScaleReports(): Promise<void> {
  const inputs = new URL('scale-inputs/', REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const file = fileURLToPath(new URL('traces.json', inputs));
  await writeFile(file, JSON.stringify(scaleInput()));
  const all = [file, ...(await writeScaleLogFiles(inputs))];
  await Promise.all([
    convertTo(reportDir('scale'), all, 'scale run'),
    convertTo(reportDir('huge'), all, 'huge run', {
      OTEL_HTML_EAGER_BUDGET_BYTES: String(HUGE_EAGER_BUDGET_BYTES),
    }),
  ]);
}

async function buildFixtureReports(): Promise<void> {
  await Promise.all([
    convertTo(
      HOSTILE_REPORT_DIR,
      fixtureFiles('hostile').map((f) => fileURLToPath(f)),
      'hostile run',
    ),
    ...FIXTURE_REPORTS.map((name) =>
      convertTo(
        reportDir(name),
        fixtureFiles(name).map((f) => fileURLToPath(f)),
        `${name} fixture`,
      ),
    ),
  ]);
  await cli([
    'merge',
    fileURLToPath(reportDir('small')),
    fileURLToPath(reportDir('orphans')),
    '--out',
    fileURLToPath(reportDir('merged')),
  ]);
}

const readJson = async (file: URL): Promise<{ resourceMetrics?: unknown[] }> =>
  JSON.parse(await readFile(file, 'utf8')) as { resourceMetrics?: unknown[] };

/**
 * The `metrics` fixture split in two by collection (its `resourceMetrics` are in time order, one per resource per
 * collection), each half converted on its own and the two reports merged: `metrics-merged`. `metrics-single` converts
 * the fixture in one go, for comparison.
 */
async function buildMetricsMergeReports(): Promise<void> {
  const fixture = new URL('../fixtures/metrics.otlp.json', import.meta.url);
  const all = (await readJson(fixture)).resourceMetrics ?? [];
  const inputs = new URL('metrics-inputs/', REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const half = Math.ceil(all.length / 2);
  const parts = ['first', 'last'] as const;
  await Promise.all(
    parts.map(async (part, i) => {
      const file = fileURLToPath(new URL(`${part}.json`, inputs));
      await writeFile(file, JSON.stringify({ resourceMetrics: all.slice(i * half, (i + 1) * half) }));
      await convertTo(new URL(`metrics-${part}/`, REPORTS_DIR), [file], `metrics ${part} half`);
    }),
  );
  await Promise.all([
    cli([
      'merge',
      ...parts.map((part) => fileURLToPath(new URL(`metrics-${part}/`, REPORTS_DIR))),
      '--out',
      fileURLToPath(reportDir('metrics-merged')),
    ]),
    convertTo(reportDir('metrics-single'), [fileURLToPath(fixture)], 'metrics fixture'),
  ]);
}

/**
 * The `linked` inputs written through the library API and flushed twice (metrics split around the first flush), but
 * never closed: the report a killed or still-running writer leaves, its metrics only in per-flush segments.
 */
async function buildUnfinishedReport(): Promise<void> {
  const [traces, logs, metrics] = await Promise.all(fixtureFiles('linked').map(readJson));
  const collections = metrics?.resourceMetrics ?? [];
  const half = Math.ceil(collections.length / 2);
  const report = await Report.create({
    out: fileURLToPath(reportDir('unfinished')),
    title: 'unfinished run',
  });
  await report.addSpans(traces ?? {});
  await report.addLogs(logs ?? {});
  await report.addMetrics({ resourceMetrics: collections.slice(0, half) });
  await report.flush();
  await report.addMetrics({ resourceMetrics: collections.slice(half) });
  await report.flush();
}

async function serve(
  mounts: readonly { prefix: string; root: string }[],
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname);
    const mount = mounts.find((m) => rel.startsWith(`${m.prefix}/`));
    const file = mount === undefined ? null : normalize(join(mount.root, rel.slice(mount.prefix.length)));
    if (mount === undefined || file === null || !file.startsWith(mount.root + sep)) {
      res.writeHead(404).end();
      return;
    }
    stat(file).then(
      (s) => {
        if (!s.isFile()) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
        createReadStream(file).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('static server has no TCP address');
  const { port } = address;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await rm(REPORTS_DIR, { recursive: true, force: true });
  await Promise.all([
    buildReport(),
    buildLargeReport(),
    buildFixtureReports(),
    buildScaleReports(),
    buildMetricsMergeReports(),
    buildUnfinishedReport(),
  ]);
  const dir = (u: URL): string => fileURLToPath(u).replace(/\/$/, '');
  // `metrics-scale` is built on demand by the specs that need it (e2e/metrics-scale.ts); its mount may be empty.
  const mounted: ReportName[] = [
    'main',
    'hostile',
    'merged',
    'scale',
    'huge',
    'no-manifest',
    'metrics-merged',
    'metrics-single',
    'unfinished',
    'metrics-scale',
    ...FIXTURE_REPORTS,
  ];
  const server = await serve(
    mounted.map((name) => ({ prefix: httpSubpath(name), root: dir(reportDir(name)) })),
  );
  process.env[PORT_ENV] = String(server.port);
  return () => server.close();
}
