import { anyValueToDisplay } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { RelNanos, TraceId, UnixNanos } from '../../model/ids.js';
import {
  type LogRecordRecord,
  logTime,
  logTimeSource,
  type ResourceRecord,
  type ScopeRecord,
} from '../../model/records.js';
import type { LogTarget } from '../../ottl/contexts.js';
import { ATTR_HOST_NAME } from '../../semconv/attributes.js';
import { serviceName } from '../../semconv/resource-name.js';
import type { LogSeverityKey } from '../../semconv/severity.js';
import { cmp } from './query-common.js';
import type { LoadedChunk } from './span-query.js';

declare const logRefBrand: unique symbol;
/** `<partition n>.<file_row_number>`: stable while the partition exists (D8), and the URL key `log=`. */
export type LogRef = string & { readonly [logRefBrand]: 'LogRef' };

const LOG_REF = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function logRef(n: number, i: number): LogRef {
  return `${n}.${i}` as LogRef;
}

export function parseLogRef(s: string, path: string): LogRef {
  if (!LOG_REF.test(s)) {
    throw new OtelHtmlError('usage', {
      path,
      expected: 'a log ref like 12.345 (<partition>.<row>)',
      actual: JSON.stringify(s),
    });
  }
  return s as LogRef;
}

export function refParts(r: LogRef): { n: number; i: number } {
  const [n, i] = r.split('.');
  return { n: Number(n), i: Number(i) };
}

/** The part of a decoded log chunk that rows need: its number and the resource and scope tables. */
export type LoadedLogChunk = LoadedChunk;

export interface LogRow {
  ref: LogRef;
  /** The ref's chunk number. */
  n: number;
  /** The ref's row index in that chunk. */
  i: number;
  log: LogRecordRecord;
  resource: ResourceRecord;
  scope: ScopeRecord;
  /** `logTime(log)`: time, else observed time, else 0. */
  time: RelNanos;
  timeSource: 'time' | 'observed' | 'none';
  service: string;
  host: string | null;
}

export interface LogEntry {
  readonly row: LogRow;
  readonly target: LogTarget;
}

export type LogMode = 'logs' | 'patterns' | 'traces';

export interface PatternRow {
  id: number;
  template: string;
  regex: string;
  count: number;
  severities: Record<LogSeverityKey, number>;
  /** Relative time of the template's first and last log; null when none of its logs has a time. */
  first: number | null;
  last: number | null;
  sample: string;
}

export interface LogTraceRow {
  traceId: TraceId;
  /** Matched logs in the trace. */
  logs: number;
  first: number;
  last: number;
  /** Highest SeverityNumber among the matched logs. */
  maxSeverity: number;
  /** Distinct services of the matched logs, sorted. */
  services: readonly string[];
}

export function toLogEntries(
  chunk: LoadedLogChunk,
  logs: readonly LogRecordRecord[],
  epoch: UnixNanos,
  path: string,
): LogEntry[] {
  return logs.map((log, i) => {
    const resource = chunk.resources[log.resource];
    const scope = chunk.scopes[log.scope];
    if (resource === undefined || scope === undefined) {
      throw new OtelHtmlError('invalid-report', {
        path: `${path}[${i}]`,
        expected: 'resource and scope refs inside the chunk tables',
        actual: `resource ${log.resource}, scope ${log.scope}`,
      });
    }
    const hostValue = resource.attributes.get(ATTR_HOST_NAME);
    return {
      row: {
        ref: logRef(chunk.n, i),
        n: chunk.n,
        i,
        log,
        resource,
        scope,
        time: logTime(log),
        timeSource: logTimeSource(log),
        service: serviceName(resource),
        host: hostValue === undefined ? null : anyValueToDisplay(hostValue),
      },
      target: { log, resource, scope, epoch },
    };
  });
}

/** Time order with the ref as tiebreak: the order of a trace's logs and of Surrounding logs. */
export const byTimeThenRef = (a: LogRow, b: LogRow): number => a.time - b.time || a.n - b.n || a.i - b.i;

/** Surrounding logs per side: a non-negative integer (NaN, negative and fractional counts are usage errors). */
export function checkSurroundingCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new OtelHtmlError('usage', {
      path: 'surrounding.n',
      expected: 'a non-negative integer',
      actual: String(n),
    });
  }
}

/** Log comparators by sort column (the Logs Explorer's and the trace Logs tab's). */
export const LOG_SORTS: Readonly<Record<string, (a: LogRow, b: LogRow) => number>> & {
  readonly time: (a: LogRow, b: LogRow) => number;
} = {
  time: (a, b) => a.time - b.time,
  severity: (a, b) => a.log.severityNumber - b.log.severityNumber,
  service: (a, b) => cmp(a.service, b.service),
};
