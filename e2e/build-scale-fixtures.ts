/**
 * Builds the `scale` and `huge` e2e reports into `e2e/.reports-scale/` (the `e2e:fixtures:scale:data` mise task).
 * Only `e2e/scale.spec.ts` reads them, and converting 1M logs twice is most of the fixture build, so `test:e2e` runs
 * this only when the selection includes that spec; `e2e/build-fixtures.ts` builds the rest.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { toJson } from '@bufbuild/protobuf';
import { ExportMetricsServiceRequestSchema } from '../src/model/gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import { scaleLogsRequest } from '../test-support/scale-logs.js';
import { scaleMetrics } from '../test-support/scale-metrics.js';
import {
  reportDir,
  SCALE_LOG_FILES,
  SCALE_LOG_IDS,
  SCALE_LOGS,
  SCALE_REPORTS_DIR,
  SCALE_RUN_METRIC_SERIES,
  SCALE_RUN_METRICS,
  SCALE_SERVICES,
  SCALE_SPANS_PER_TRACE,
  SCALE_TRACES,
  SCALE_WRITER_STAMP,
  scaleTraceId,
  writerBuildHash,
} from './fixture.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const str = (key: string, value: string): { key: string; value: { stringValue: string } } => ({
  key,
  value: { stringValue: value },
});

/** `otel-html convert <inputs> --out <out> --title <title>` with the built CLI. */
async function convertTo(out: URL, inputs: readonly string[], title: string): Promise<void> {
  await run('node', [CLI, 'convert', ...inputs, '--out', fileURLToPath(out), '--title', title], {
    maxBuffer: 64 * 1024 * 1024,
  });
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
 * Metrics on four of the scale services (`scaleMetrics`: `service.name` only, the spans' resources), so Fusion's
 * Metrics frame has charts to narrow and draw when a trace is clicked. Two collections, 0 s and 10 s, keep the run
 * inside the spans' ~10 s.
 */
async function writeScaleMetricsFile(dir: URL): Promise<string> {
  const file = fileURLToPath(new URL('metrics.json', dir));
  const [first, ...rest] = scaleMetrics(SCALE_RUN_METRICS, SCALE_RUN_METRIC_SERIES, 2).map(
    (r) => toJson(ExportMetricsServiceRequestSchema, r) as { resourceMetrics: unknown[] },
  );
  await writeFile(
    file,
    JSON.stringify({ resourceMetrics: [first, ...rest].flatMap((r) => r?.resourceMetrics ?? []) }),
  );
  return file;
}

/**
 * One input of 100k spans, 1M logs (10 files) and the scale run's metrics, converted twice, with the default (local) format, as `scale` and
 * `huge`. The two are the same until PR 7 rebuilds them (the eager budget that told them apart is gone).
 */
async function buildScaleReports(): Promise<void> {
  const inputs = new URL('inputs/', SCALE_REPORTS_DIR);
  await mkdir(inputs, { recursive: true });
  const file = fileURLToPath(new URL('traces.json', inputs));
  await writeFile(file, JSON.stringify(scaleInput()));
  const all = [file, ...(await writeScaleLogFiles(inputs)), await writeScaleMetricsFile(inputs)];
  await Promise.all([
    convertTo(reportDir('scale'), all, 'scale run'),
    convertTo(reportDir('huge'), all, 'huge run'),
  ]);
}

await rm(SCALE_REPORTS_DIR, { recursive: true, force: true });
await buildScaleReports();
await writeFile(SCALE_WRITER_STAMP, writerBuildHash());
