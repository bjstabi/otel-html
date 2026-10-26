import { readFileSync } from 'node:fs';

export const RUN_TITLE = 'e2e smoke run';
export const HOSTILE_SPAN_NAME = '</script><img src=x onerror=alert(1)>';
/** The generated traces: 6 spans over 2 services (3 each), 2 of them with an error status. */
export const SPAN_COUNT = 6;
export const ERROR_SPAN_COUNT = 2;
export const TRACE_1 = '0102030405060708090a0b0c0d0e0f10';
export const TRACE_2 = '1102030405060708090a0b0c0d0e0f10';
export const SERVICE_A = 'e2e-service';
export const SERVICE_B = 'e2e-db';
export const REPORTS_DIR = new URL('./.reports/', import.meta.url);
export const REPORT_DIR = new URL('main/', REPORTS_DIR);
/** A second report with one very large trace, for the flame-graph render-time check. */
export const LARGE_REPORT_DIR = new URL('large/', REPORTS_DIR);
export const LARGE_SPAN_COUNT = 50_000;
export const LARGE_TRACE_ID = 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
const HTTP_SUBPATH = '/sub/path';
/** The hostile-content report (built from `fixtures/hostile.otlp.json`) is served beside the main one over http. */
export const HOSTILE_REPORT_DIR = new URL('hostile/', REPORTS_DIR);
const HOSTILE_SUBPATH = '/sub/hostile';
export const HOSTILE_TRACE_ID = '2a2b2c2d2e2f30313233343536373839';
export const HOSTILE_ROOT_SPAN = '1111111111111111';
export const PORT_ENV = 'OTEL_HTML_E2E_PORT';

/** Reports built from the committed SDK fixtures (`fixtures/<name>.otlp.json`) and served beside the main one. */
export const FIXTURE_REPORTS = ['small', 'orphans', 'logs-only', 'empty'] as const;
export type FixtureReport = (typeof FIXTURE_REPORTS)[number];
/** `merged` is `otel-html merge` of `small` and `orphans`; `scale` and `huge` come from one generated 100k-span input. */
export type ReportName = 'main' | 'hostile' | FixtureReport | 'merged' | 'scale' | 'huge' | 'no-manifest';

export function reportDir(name: ReportName): URL {
  return new URL(`${name}/`, REPORTS_DIR);
}

export function fixtureFile(name: FixtureReport | 'hostile'): URL {
  return new URL(`../fixtures/${name}.otlp.json`, import.meta.url);
}

/** Span count of a committed fixture, read from the file so specs never hard-code it. */
export function fixtureSpanCount(name: FixtureReport | 'hostile'): number {
  const body = JSON.parse(readFileSync(fixtureFile(name), 'utf8')) as {
    resourceSpans?: { scopeSpans?: { spans?: unknown[] }[] }[];
  };
  let n = 0;
  for (const rs of body.resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) n += ss.spans?.length ?? 0;
  return n;
}

/** The `logs-only` fixture holds this many log records and no metrics. */
export const LOGS_ONLY_LOG_COUNT = 12;

/** The generated scale input: `SCALE_TRACES` traces of `SCALE_SPANS_PER_TRACE` spans each. */
export const SCALE_TRACES = 2000;
export const SCALE_SPANS_PER_TRACE = 50;
export const SCALE_SPAN_COUNT = SCALE_TRACES * SCALE_SPANS_PER_TRACE;
/** The viewer's eager budget used to build `huge`, so the same input is served by the windowed strategy. */
export const HUGE_EAGER_BUDGET_BYTES = 5_000_000;
/** Scale traces use ids `scaleTraceId(i)`; the service of span `j` is `SCALE_SERVICES[j % 8]`. */
export const SCALE_SERVICES = ['edge', 'api', 'auth', 'db', 'cache', 'queue', 'worker', 'search'] as const;
export function scaleTraceId(i: number): string {
  return `${(i + 1).toString(16).padStart(8, '0')}${'a1'.repeat(12)}`;
}

/** Perf budgets are scaled by `OTEL_HTML_PERF_FACTOR` (slow machines, CI); the constants themselves stay fixed. */
const PERF_ENV = 'OTEL_HTML_PERF_FACTOR';
export function perfFactor(): number {
  const raw = process.env[PERF_ENV];
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${PERF_ENV} must be a positive number, got ${raw}`);
  return n;
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
