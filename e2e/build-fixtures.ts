import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Report } from '../src/api/index.js';
import {
  DASHBOARDS_CONFIG,
  DASHBOARDS_HOSTILE_DEFAULT,
  DASHBOARDS_HOSTILE_DESCRIPTION,
  DASHBOARDS_HOSTILE_TITLE,
  FIXTURE_REPORTS,
  fixtureFiles,
  HOSTILE_REPORT_DIR,
  HOSTILE_SPAN_NAME,
  LARGE_REPORT_DIR,
  LARGE_SPAN_COUNT,
  LARGE_TRACE_ID,
  METRICS_SCALE_DIR,
  REPORT_DIR,
  REPORTS_DIR,
  REPORTS_SITE_DIR,
  type ReportName,
  RUN_CHART_FAILED_JOB,
  RUN_CHART_FAILED_RUN,
  RUN_CHART_HOSTILE_JOB,
  RUN_CHART_JOBS,
  RUN_CHART_OUTLIER_JOB,
  RUN_CHART_OUTLIER_S,
  RUN_CHART_RUN_MINUTES,
  RUN_CHART_T0_MS,
  RUN_TITLE,
  reportDir,
  runChartRunId,
  SERVICE_A,
  SERVICE_B,
  TRACE_1,
  TRACE_2,
} from './fixture.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
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
  await run('node', [CLI, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
}

/** Every convert and merge here names `--format local` although it is the default: the fixtures state the format they test. */
async function convertTo(
  out: URL,
  inputs: readonly string[],
  title: string,
  env?: Record<string, string>,
  config?: string,
): Promise<void> {
  await cli(
    [
      'convert',
      ...inputs,
      '--out',
      fileURLToPath(out),
      '--title',
      title,
      '--format',
      'local',
      ...(config === undefined ? [] : ['--config', config]),
    ],
    env,
  );
}

/** `linked-*` and `metrics` converted with the fixture dashboard config; the hostile one converts `hostile` with markup in its text. */
async function buildDashboardReports(): Promise<void> {
  const hostileConfig = fileURLToPath(new URL('dashboards-hostile.json', REPORTS_DIR));
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(
    hostileConfig,
    JSON.stringify({
      dashboards: [
        {
          id: 'hostile',
          title: DASHBOARDS_HOSTILE_TITLE,
          description: DASHBOARDS_HOSTILE_DESCRIPTION,
          variables: [{ key: 'service.name', default: DASHBOARDS_HOSTILE_DEFAULT }],
          widgets: [{ type: 'traces', x: 0, y: 0, w: 12, h: 10 }],
        },
      ],
      viewer: { defaultDashboard: 'hostile' },
    }),
  );
  await Promise.all([
    convertTo(
      reportDir('dashboards'),
      fixtureFiles('linked').map((f) => fileURLToPath(f)),
      'dashboards fixture',
      undefined,
      fileURLToPath(DASHBOARDS_CONFIG),
    ),
    convertTo(
      reportDir('dashboards-hostile'),
      fixtureFiles('hostile').map((f) => fileURLToPath(f)),
      'dashboards hostile',
      undefined,
      hostileConfig,
    ),
  ]);
}

/** One histogram point of `seconds` under its own resource per job per run, the shape `otel-html ci` writes. */
function runChartMetric(
  metric: string,
  jobs: readonly string[],
  seconds: (job: string, jobIndex: number, run: number) => number,
): object[] {
  return RUN_CHART_RUN_MINUTES.flatMap((minutes, run) =>
    jobs.map((job, jobIndex) => {
      const value = seconds(job, jobIndex, run);
      const end = BigInt(RUN_CHART_T0_MS + minutes * 60_000) * 1_000_000n;
      const result = job === RUN_CHART_FAILED_JOB && run === RUN_CHART_FAILED_RUN ? 'failure' : 'success';
      return {
        resource: {
          attributes: [
            str('service.name', 'ci'),
            str('cicd.pipeline.run.id', runChartRunId(run)),
            str('cicd.pipeline.task.name', job),
            str('vcs.ref.head.revision', `abcdef${run}000000`),
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'e2e-run-charts' },
            metrics: [
              {
                name: metric,
                unit: 's',
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      startTimeUnixNano: String(end - BigInt(Math.round(value * 1e9))),
                      timeUnixNano: String(end),
                      count: '1',
                      sum: value,
                      min: value,
                      max: value,
                      bucketCounts: ['1'],
                      explicitBounds: [],
                      attributes: [
                        str('cicd.pipeline.task.name', job),
                        str('cicd.pipeline.task.run.result', result),
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }),
  );
}

/** The `run-charts` report: a Job duration widget on default controls, and a job named in markup on its own dashboard. */
async function buildRunChartReport(): Promise<void> {
  const inputs = new URL('run-chart-inputs/', REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const metrics = fileURLToPath(new URL('metrics.json', inputs));
  const config = fileURLToPath(new URL('config.json', inputs));
  const variables = [{ key: 'cicd.pipeline.run.id', label: 'run' }];
  const widget = (metric: string): object => ({
    type: 'metric',
    title: 'Job duration',
    x: 0,
    y: 0,
    w: 12,
    h: 20,
    runBy: 'resource.attributes["cicd.pipeline.run.id"]',
    failedWhen: 'attributes["cicd.pipeline.task.run.result"] == "failure"',
    queries: [{ id: 'a', metric, show: 'avg', by: ['attributes["cicd.pipeline.task.name"]'] }],
  });
  await writeFile(
    metrics,
    JSON.stringify({
      resourceMetrics: [
        ...runChartMetric('ci.job.duration', RUN_CHART_JOBS, (job, jobIndex, run) =>
          job === RUN_CHART_OUTLIER_JOB && run === 0 ? RUN_CHART_OUTLIER_S : 40 + 25 * jobIndex + 7 * run,
        ),
        ...runChartMetric('ci.hostile.duration', [RUN_CHART_HOSTILE_JOB, 'plain'], (_, jobIndex, run) =>
          jobIndex === 0 ? 60 + run : 200 + run,
        ),
      ],
    }),
  );
  await writeFile(
    config,
    JSON.stringify({
      dashboards: [
        { id: 'runs', title: 'Runs', variables, widgets: [widget('ci.job.duration')] },
        {
          id: 'runs-hostile',
          title: 'Hostile runs',
          variables,
          widgets: [{ ...widget('ci.hostile.duration'), controls: { split: false, legend: true } }],
        },
      ],
    }),
  );
  await convertTo(reportDir('run-charts'), [metrics], 'run charts', undefined, config);
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
    '--format',
    'local',
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
      '--format',
      'local',
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
    format: 'local',
  });
  await report.addSpans(traces ?? {});
  await report.addLogs(logs ?? {});
  await report.addMetrics({ resourceMetrics: collections.slice(0, half) });
  await report.flush();
  await report.addMetrics({ resourceMetrics: collections.slice(half) });
  await report.flush();
}

/**
 * The frozen data folders (`fixtures/reports/format-<n>/`, never edited) converted into format-4 reports by
 * `otel-html merge`, which writes the current viewer beside the data (D12: the viewer reads format 4 only).
 */
async function buildFrozenReports(): Promise<void> {
  // Format 4 takes the path a user's report takes: the frozen folder is upgraded in place, so its manifest and
  // `.parquet.js` wrappers are what the viewer reads.
  const out4 = fileURLToPath(reportDir('frozen-format-4'));
  await rm(out4, { recursive: true, force: true });
  await cp(fileURLToPath(new URL('../fixtures/reports/format-4', import.meta.url)), out4, {
    recursive: true,
  });
  await cli(['upgrade', out4]);
  for (const n of [1, 2, 3] as const) {
    await cli([
      'merge',
      fileURLToPath(new URL(`../fixtures/reports/format-${n}`, import.meta.url)),
      '--out',
      fileURLToPath(reportDir(`frozen-format-${n}`)),
      '--format',
      'local',
    ]);
  }
}

/** The reports `e2e/global-setup.ts` mounts over HTTP that are built into `REPORTS_DIR` (`large` is file only). */
const SITE_REPORTS: readonly ReportName[] = [
  'main',
  'hostile',
  'merged',
  'metrics-merged',
  'metrics-single',
  'unfinished',
  'dashboards',
  'dashboards-hostile',
  'run-charts',
  'frozen-format-1',
  'frozen-format-2',
  'frozen-format-3',
  'frozen-format-4',
  ...FIXTURE_REPORTS,
];

/**
 * A `site` copy of every mounted report under `REPORTS_SITE_DIR` (a plain copy, then `upgrade --format site`), so
 * the `@http` tests read partitions with Range requests. `no-manifest` is the copy of `main` without its manifest.
 */
async function buildSiteCopies(): Promise<void> {
  await Promise.all(
    SITE_REPORTS.map(async (name) => {
      const dest = fileURLToPath(reportDir(name, 'http'));
      await cp(fileURLToPath(reportDir(name)), dest, { recursive: true });
      // `unfinished` is never closed, so its writer's lock names this (live) process; the copy is a snapshot.
      await rm(`${dest}data/state/lock.json`, { force: true });
      await cli(['upgrade', dest, '--format', 'site']);
    }),
  );
  const noManifest = reportDir('no-manifest', 'http');
  await cp(reportDir('main', 'http'), noManifest, { recursive: true });
  await rm(new URL('data/manifest.js', noManifest));
}

await rm(REPORTS_DIR, { recursive: true, force: true });
await rm(REPORTS_SITE_DIR, { recursive: true, force: true });
// The on-demand metrics scale report is built from `dist`, which a rebuild of the fixtures may have changed.
await rm(METRICS_SCALE_DIR, { recursive: true, force: true });
await Promise.all([
  buildReport(),
  buildLargeReport(),
  buildFixtureReports(),
  buildMetricsMergeReports(),
  buildUnfinishedReport(),
  buildDashboardReports(),
  buildRunChartReport(),
  buildFrozenReports(),
]);
await buildSiteCopies();
