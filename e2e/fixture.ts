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
export const HTTP_SUBPATH = '/sub/path';
/** The hostile-content report (built from `fixtures/hostile.otlp.json`) is served beside the main one over http. */
export const HOSTILE_REPORT_DIR = new URL('hostile/', REPORTS_DIR);
export const HOSTILE_SUBPATH = '/sub/hostile';
export const HOSTILE_TRACE_ID = '2a2b2c2d2e2f30313233343536373839';
export const HOSTILE_ROOT_SPAN = '1111111111111111';
export const PORT_ENV = 'OTEL_HTML_E2E_PORT';

export type UrlKind = 'file' | 'http';

/** Base URL of the report, without a trailing slash. */
export function baseUrlFor(kind: UrlKind, report: 'main' | 'hostile' = 'main'): string {
  const dir = report === 'main' ? REPORT_DIR : HOSTILE_REPORT_DIR;
  if (kind === 'file') return dir.href.replace(/\/$/, '');
  const port = process.env[PORT_ENV];
  if (port === undefined) throw new Error(`${PORT_ENV} is not set: globalSetup did not start the server`);
  return `http://127.0.0.1:${port}${report === 'main' ? HTTP_SUBPATH : HOSTILE_SUBPATH}`;
}
