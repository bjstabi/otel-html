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
export const FIXTURE_REPORTS = ['small', 'orphans', 'logs-only', 'empty', 'linked'] as const;
export type FixtureReport = (typeof FIXTURE_REPORTS)[number];
/** Fixture files of the reports that are not just `fixtures/<name>.otlp.json`. */
const FIXTURE_FILES: Partial<Record<FixtureReport, readonly string[]>> = {
  linked: ['linked-traces', 'linked-logs'],
};
/** `merged` is `otel-html merge` of `small` and `orphans`; `scale` and `huge` come from one generated 100k-span input. */
export type ReportName = 'main' | 'hostile' | FixtureReport | 'merged' | 'scale' | 'huge' | 'no-manifest';

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
 * The `linked` report: `linked-traces` (3 traces over `checkout` on runner-7 and `payments` on runner-8) plus `linked-logs`.
 * Of its 40 logs: 33 sit inside a span of an exported trace, 1 carries a span_id that is not in its trace (it belongs to
 * `LINKED_TRACE`), 1 carries a trace id that is not in the traces file, and 5 carry no trace context.
 */
export const LINKED_LOG_COUNT = 40;
export const LINKED_TRACE = '5134a3f57d52d9e9822e617916d38b35';
/** `payments.Charge` in `LINKED_TRACE`: 7 logs, among them 3 declined-card and 3 retry lines. */
export const LINKED_SPAN = '1d8745a159cef356';
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

const SCALE_LOG_TRACE_INDEX = 1014;

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
export const SCALE_LOG_FILES = 10;
/** Logs and spans share a clock origin; log `i` is at origin + `i` x `LOG_STEP_NS` (10 ms), so the logs span about 2.8 hours. */
const SCALE_EPOCH_NS = 1_700_000_000_000_000_000n;
/** A scale trace with 20 or more logs spread over two or more log chunks. */
export const SCALE_LOG_TRACE: string = scaleTraceId(SCALE_LOG_TRACE_INDEX);

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
