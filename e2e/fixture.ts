import { readFileSync } from 'node:fs';
import type { ScaleLogIds } from '../test-support/scale-logs.js';

export const RUN_TITLE = 'e2e smoke run';
export const HOSTILE_SPAN_NAME = '</script><img src=x onerror=alert(1)>';
/** The generated traces: 6 spans over 2 services (3 each), 2 of them with an error status. */
export const SPAN_COUNT = 6;
export const ERROR_SPAN_COUNT = 2;
export const TRACE_1 = '0102030405060708090a0b0c0d0e0f10';
export const TRACE_2 = '1102030405060708090a0b0c0d0e0f10';
export const SERVICE_A = 'e2e-service';
export const SERVICE_B = 'e2e-db';
/** The config the `dashboards` report is converted with; `mise run demo` uses it too. */
export const DASHBOARDS_CONFIG: URL = new URL('../fixtures/dashboards.otel-html.yaml', import.meta.url);
/** `dashboards` holds the dashboard `checkout` (default, with `DASHBOARDS_ENV_DEFAULT` on its environment variable). */
export const DASHBOARDS_ENV_DEFAULT = 'ci';
/** `dashboards-hostile`: the `hostile` fixture with a config whose title, description and variable default are markup. */
export const DASHBOARDS_HOSTILE_TITLE = '</script><img src=x onerror=alert(1)>';
export const DASHBOARDS_HOSTILE_DESCRIPTION = 'line one\u2028line two';
export const DASHBOARDS_HOSTILE_DEFAULT = 'a"b\\c';
export {
  HOSTILE_METRIC_ATTR,
  HOSTILE_METRIC_ATTR_VALUE,
  HOSTILE_METRIC_NAME,
  HOSTILE_METRIC_UNIT,
  LINKED_SPAN,
  LINKED_TRACE,
  METRIC_HIST,
  ORPHAN_EXEMPLAR_TRACE,
} from '../test-support/fixture-ids.js';

export const REPORTS_DIR: URL = new URL('./.reports/', import.meta.url);
export const REPORT_DIR: URL = new URL('main/', REPORTS_DIR);
/** A second report with one very large trace, for the flame-graph render-time check. */
export const LARGE_REPORT_DIR: URL = new URL('large/', REPORTS_DIR);
export const LARGE_SPAN_COUNT = 50_000;
export const LARGE_TRACE_ID = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
const HTTP_SUBPATH = '/sub/path';
/** The hostile-content report (built from `fixtures/hostile.otlp.json`) is served beside the main one over http. */
export const HOSTILE_REPORT_DIR: URL = new URL('hostile/', REPORTS_DIR);
const HOSTILE_SUBPATH = '/sub/hostile';
export const HOSTILE_TRACE_ID = '2a2b2c2d2e2f30313233343536373839';
export const HOSTILE_ROOT_SPAN = '1111111111111111';
export const PORT_ENV = 'OTEL_HTML_E2E_PORT';

/** Reports built from the committed SDK fixtures (`fixtures/<name>.otlp.json`) and served beside the main one. */
export const FIXTURE_REPORTS = ['small', 'orphans', 'logs-only', 'empty', 'linked', 'sample'] as const;
export type FixtureReport = (typeof FIXTURE_REPORTS)[number];
/** Fixture files of the reports that are not just `fixtures/<name>.otlp.json`. */
const FIXTURE_FILES: Partial<Record<FixtureReport, readonly string[]>> = {
  linked: ['linked-traces', 'linked-logs', 'metrics'],
  /** Traces and logs together: what `mise run demo` converts and CI uploads as the sample report. */
  sample: ['small', 'linked-traces', 'linked-logs'],
};
/**
 * `merged` is `otel-html merge` of `small` and `orphans`; `scale` and `huge` come from one generated 100k-span input.
 * `metrics-merged` merges two reports of the `metrics` fixture's first and last five collections, `metrics-single`
 * converts the fixture at once. `unfinished` holds the `linked` inputs, flushed but never closed. `metrics-scale` is
 * the metrics scale report (`e2e/metrics-scale.ts`), written only by the specs that need it.
 */
export type ReportName =
  | 'main'
  | 'hostile'
  | FixtureReport
  | 'merged'
  | 'scale'
  | 'huge'
  | 'no-manifest'
  | 'metrics-merged'
  | 'metrics-single'
  | 'unfinished'
  | 'dashboards'
  | 'dashboards-hostile'
  | 'metrics-scale';

/**
 * The metrics scale workload (spec §7): 200 metrics × 1,000 series × 360 points (1 h at a 10 s interval). The report
 * writes it in full only for the metric the Explorer charts first (`SCALE_CHARTED_METRIC`); every other metric keeps
 * all its series but has points only in the first and last collection (`scaleMetricEmitted`). The catalog, series,
 * resources and time range are those of the full workload, at ~1% of its points. The data-file guard in
 * `e2e/scale.spec.ts` checks that the pages under test read nothing the smaller report leaves out.
 */
export const SCALE_METRICS = 200;
export const SCALE_METRIC_SERIES = 1_000;
export const SCALE_METRIC_POINTS = 360;
export const SCALE_CHARTED_METRIC = 0;

/** Whether the metrics scale report has points of metric `m` in collection `i`. */
export function scaleMetricEmitted(m: number, i: number): boolean {
  return m === SCALE_CHARTED_METRIC || i === 0 || i === SCALE_METRIC_POINTS - 1;
}

export function reportDir(name: ReportName): URL {
  return new URL(`${name}/`, REPORTS_DIR);
}

/** The committed OTLP/JSON files a fixture report is built from. */
export function fixtureFiles(name: FixtureReport | 'hostile'): URL[] {
  const stems = name === 'hostile' ? [name] : (FIXTURE_FILES[name] ?? [name]);
  return stems.map((stem) => new URL(`../fixtures/${stem}.otlp.json`, import.meta.url));
}

/** Span count of a committed fixture report, read from its files so specs never hard-code it. */
export function fixtureSpanCount(name: FixtureReport | 'hostile'): number {
  let n = 0;
  for (const file of fixtureFiles(name)) {
    const body = JSON.parse(readFileSync(file, 'utf8')) as {
      resourceSpans?: { scopeSpans?: { spans?: unknown[] }[] }[];
    };
    for (const rs of body.resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? []) n += ss.spans?.length ?? 0;
  }
  return n;
}

/** The `logs-only` fixture holds this many log records and no metrics. */
export const LOGS_ONLY_LOG_COUNT = 12;

/**
 * The `linked` report: `linked-traces` (3 traces over `checkout` on runner-7 and `payments` on runner-8) plus `linked-logs`
 * and `metrics`.
 * Of its 40 logs: 33 sit inside a span of an exported trace, 1 carries a span_id that is not in its trace (it belongs to
 * `LINKED_TRACE`), 1 carries a trace id that is not in the traces file, and 5 carry no trace context.
 */
export const LINKED_LOG_COUNT = 40;
export const ORPHAN_LOG_TRACE = 'ea30c7b71377a677cb3ce2b5f8f4abb9';
/** The warn-level log in `LINKED_TRACE` whose span_id (`deadbeefdeadbeef`) is not a span of that trace. */
export const DANGLING_SPAN_LOG_TEXT = 'span context lost: parent span unknown';
export const HOSTILE_LOG_TEXT = '</script><img src=x onerror=alert(1)> tail';
/** Severity numbers 0, 1, 5, 9, 13, 17, 21 occur 1, 2, 8, 10, 10, 8, 1 times. */
export const LINKED_SEVERITY_COUNTS = { 0: 1, 1: 2, 5: 8, 9: 10, 13: 10, 17: 8, 21: 1 } as const;
/** Logs with severity number >= 13 (warn, error, fatal). */
export const LINKED_WARN_PLUS_COUNT = 19;
/** Logs whose body contains "declined" (case-insensitive): the `card declined: 402 decline_code=<x>` lines. */
export const LINKED_DECLINED_COUNT = 6;

/**
 * The `linked` report also converts `metrics` (generated with the OTel SDK, then augmented): 10 collections 10 s apart over
 * the same two resources, as `METRICS_COUNT` metric definitions.
 */
export const METRICS_COUNT = 10;

/** Fusion on `scale` is interactive within 3 s, and a trace selection updates its Logs and Metrics within 1 s. */
export const FUSION_INTERACTIVE_BUDGET_MS = 3000;
export const FUSION_SELECTION_BUDGET_MS = 1000;

/** The generated scale input: `SCALE_TRACES` traces of `SCALE_SPANS_PER_TRACE` spans each. */
export const SCALE_TRACES = 2000;
export const SCALE_SPANS_PER_TRACE = 50;
export const SCALE_SPAN_COUNT: number = SCALE_TRACES * SCALE_SPANS_PER_TRACE;
/** The viewer's eager budget used to build `huge`, so the same input is served by the windowed strategy. */
export const HUGE_EAGER_BUDGET_BYTES = 5_000_000;
/** Scale traces use ids `scaleTraceId(i)`; the service of span `j` is `SCALE_SERVICES[j % 8]`. */
export const SCALE_SERVICES = ['edge', 'api', 'auth', 'db', 'cache', 'queue', 'worker', 'search'] as const;
export function scaleTraceId(i: number): string {
  return `${(i + 1).toString(16).padStart(8, '0')}${'a1'.repeat(12)}`;
}

/** The scale input also holds this many logs, in `SCALE_LOG_FILES` OTLP/JSON files of equal size. */
export const SCALE_LOGS = 1_000_000;
/** The `scale` run's metrics: this many metrics × series on four of its services, at 0 s and 10 s. */
export const SCALE_RUN_METRICS = 60;
export const SCALE_RUN_METRIC_SERIES = 250;
export const SCALE_LOG_FILES = 10;
/** Logs and spans share a clock origin; log `i` is at origin + `i` x `LOG_STEP_NS` (10 ms), so the logs span about 2.8 hours. */
const SCALE_EPOCH_NS = 1_700_000_000_000_000_000n;
export const SCALE_LOG_IDS: ScaleLogIds = {
  services: SCALE_SERVICES,
  hosts: ['host-0', 'host-1', 'host-2', 'host-3'],
  traces: SCALE_TRACES,
  spansPerTrace: SCALE_SPANS_PER_TRACE,
  epochNs: SCALE_EPOCH_NS,
  traceId: scaleTraceId,
  // The scale span generator numbers spans `t * SCALE_SPANS_PER_TRACE + j` and writes them as `n + 1` in hex.
  spanId: (t, j) => (t * SCALE_SPANS_PER_TRACE + j + 1).toString(16).padStart(16, '0'),
};

/** Perf budgets are scaled by `OTEL_HTML_PERF_FACTOR` (slow machines, CI); the constants themselves stay fixed. */
const PERF_ENV = 'OTEL_HTML_PERF_FACTOR';
/**
 * The calibration workload's time on a typical machine of this kind (CI sets it for its runners). When set, a runner
 * slower than that scales the budgets by how much slower it is (never below 1), so runner speed variance does not
 * fail them; without it the factor is `OTEL_HTML_PERF_FACTOR` alone.
 */
export const PERF_REFERENCE_ENV = 'OTEL_HTML_PERF_REFERENCE_MS';
/** This run's calibration time in ms, measured once by the global setup (`test-support/calibrate.ts`). */
export const PERF_CALIBRATION_ENV = 'OTEL_HTML_PERF_CALIBRATION_MS';

function positiveEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
  return n;
}

/** How much slower this runner is than the reference (at least 1), or 1 without a reference or a calibration. */
export function runnerFactor(): number {
  const reference = positiveEnv(PERF_REFERENCE_ENV);
  const measured = positiveEnv(PERF_CALIBRATION_ENV);
  return reference === null || measured === null ? 1 : Math.max(1, measured / reference);
}

export function perfFactor(): number {
  return Math.round((positiveEnv(PERF_ENV) ?? 1) * runnerFactor() * 100) / 100;
}

export type UrlKind = 'file' | 'http';

/** Where a report is mounted under the static server. */
export function httpSubpath(name: ReportName): string {
  if (name === 'main') return HTTP_SUBPATH;
  if (name === 'hostile') return HOSTILE_SUBPATH;
  return `/sub/${name}`;
}

/** Base URL of the report, without a trailing slash. */
export function baseUrlFor(kind: UrlKind, report: ReportName = 'main'): string {
  if (kind === 'file') return reportDir(report).href.replace(/\/$/, '');
  const port = process.env[PORT_ENV];
  if (port === undefined) throw new Error(`${PORT_ENV} is not set: globalSetup did not start the server`);
  return `http://127.0.0.1:${port}${httpSubpath(report)}`;
}
