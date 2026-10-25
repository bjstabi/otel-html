export const RUN_TITLE = 'e2e smoke run';
export const HOSTILE_SPAN_NAME = '</script><img src=x onerror=alert(1)>';
export const REPORTS_DIR = new URL('./.reports/', import.meta.url);
export const REPORT_DIR = new URL('main/', REPORTS_DIR);
export const HTTP_SUBPATH = '/sub/path';
export const PORT_ENV = 'OTEL_HTML_E2E_PORT';

export type UrlKind = 'file' | 'http';

/** Base URL of the report, without a trailing slash. */
export function baseUrlFor(kind: UrlKind): string {
  if (kind === 'file') return REPORT_DIR.href.replace(/\/$/, '');
  const port = process.env[PORT_ENV];
  if (port === undefined) throw new Error(`${PORT_ENV} is not set: globalSetup did not start the server`);
  return `http://127.0.0.1:${port}${HTTP_SUBPATH}`;
}
