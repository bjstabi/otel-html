import { anyValueToDisplay } from '../../model/anyvalue.js';
import { OtelHtmlError } from '../../model/errors.js';
import type { RelNanos, TraceId, UnixNanos } from '../../model/ids.js';
import { type LogRecordRecord, logTime, type ResourceRecord, type ScopeRecord } from '../../model/records.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import type { LogTarget } from '../../ottl/contexts.js';
import { logTextFields, matchesText } from '../../ottl/text.js';
import { type Drain, type DrainCluster, template, templateToRegex } from '../../rollups/drain.js';
import type { FacetCounts } from '../../rollups/facets.js';
import { LogRollups } from '../../rollups/log-rollups.js';
import type { LogSeverityKey } from '../../rollups/signal-counts.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import { ATTR_HOST_NAME } from '../../semconv/attributes.js';
import { serviceName } from '../../semconv/resource-name.js';
import {
  AbortTicker,
  checkLimit,
  cmp,
  ordered,
  QUERY_FACET_CAPS,
  sortFor,
  throwIfAborted,
} from './query-common.js';
import type { LoadedChunk, TimeWindow } from './span-query.js';
import { topK } from './top-k.js';

declare const logRefBrand: unique symbol;
/** `<chunk n>.<row index>`: stable for a report folder, and the URL key `log=`. */
export type LogRef = string & { readonly [logRefBrand]: 'LogRef' };

const LOG_REF = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function logRef(n: number, i: number): LogRef {
  return `${n}.${i}` as LogRef;
}

export function parseLogRef(s: string, path: string): LogRef {
  if (!LOG_REF.test(s)) {
    throw new OtelHtmlError('usage', {
      path,
      expected: 'a log ref like 12.345 (<chunk>.<row>)',
      actual: JSON.stringify(s),
    });
  }
  return s as LogRef;
}

export function refParts(r: LogRef): { n: number; i: number } {
  const [n, i] = r.split('.');
  return { n: Number(n), i: Number(i) };
}

function compareRefs(a: LogRef, b: LogRef): number {
  const x = refParts(a);
  const y = refParts(b);
  return x.n - y.n || x.i - y.i;
}

/** The part of a decoded log chunk that rows need: its number and the resource and scope tables. */
export type LoadedLogChunk = LoadedChunk;

export interface LogRow {
  ref: LogRef;
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

export interface LogQuery {
  condition: string | null;
  text: string;
  window: TimeWindow | null;
  mode: LogMode;
  sort: { column: string; dir: 'asc' | 'desc' };
  limit: number;
  scanAll: boolean;
}

export interface PatternRow {
  id: number;
  template: string;
  regex: string;
  count: number;
  severities: Record<LogSeverityKey, number>;
  first: number;
  last: number;
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

export type LogQueryResult = {
  /** Matched logs; patterns in patterns mode; traces in traces mode. */
  total: number;
  /** Logs that matched the filter, in every mode (`total` counts patterns or traces in those modes). */
  matched: number;
  facets: FacetCounts;
  buckets: TimeBuckets<LogSeverityKey>;
  /** Chunks scanned of all chunks; null when the result is exact. */
  partial: { scanned: number; total: number } | null;
} & (
  | { mode: 'logs'; rows: readonly LogRow[] }
  | {
      mode: 'patterns';
      rows: readonly PatternRow[];
      /** Matched logs Drain could not cluster (cluster cap reached); they are in `matched` but in no pattern. */
      unclustered: number;
    }
  | { mode: 'traces'; rows: readonly LogTraceRow[] }
);

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
        log,
        resource,
        scope,
        time: logTime(log),
        timeSource: log.time !== null ? 'time' : log.observedTime !== null ? 'observed' : 'none',
        service: serviceName(resource),
        host: hostValue === undefined ? null : anyValueToDisplay(hostValue),
      },
      target: { log, resource, scope, epoch },
    };
  });
}

export function patternRowsOf(d: Drain): PatternRow[] {
  return d.clusters().map((c: DrainCluster) => ({
    id: c.id,
    template: template(c),
    regex: templateToRegex(c),
    count: c.count,
    severities: c.severities,
    first: c.first,
    last: c.last,
    sample: c.sample,
  }));
}

/** Time order with the ref as tiebreak: the order of a trace's logs and of Surrounding logs. */
export const byTimeThenRef = (a: LogRow, b: LogRow): number => a.time - b.time || compareRefs(a.ref, b.ref);

/** Logs from the same stream as `target`: same service and same host. */
export function sameStream(target: LogRow, row: LogRow): boolean {
  return row.service === target.service && row.host === target.host;
}

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

/**
 * The `n` same-stream logs on each side of `target` among `rows` (any order; `target` itself may be among them),
 * in time order with the ref as tiebreak.
 */
export function surroundingIn(
  target: LogRow,
  rows: readonly LogRow[],
  n: number,
): { before: LogRow[]; after: LogRow[] } {
  checkSurroundingCount(n);
  const before: LogRow[] = [];
  const after: LogRow[] = [];
  for (const r of rows) {
    if (!sameStream(target, r)) continue;
    const c = byTimeThenRef(r, target);
    if (c < 0) before.push(r);
    else if (c > 0) after.push(r);
  }
  before.sort(byTimeThenRef);
  after.sort(byTimeThenRef);
  return { before: n === 0 ? [] : before.slice(-n), after: after.slice(0, n) };
}

const LOG_SORTS: Readonly<Record<string, (a: LogRow, b: LogRow) => number>> = {
  time: (a, b) => a.time - b.time,
  severity: (a, b) => a.log.severityNumber - b.log.severityNumber,
  service: (a, b) => cmp(a.service, b.service),
};

const PATTERN_SORTS: Readonly<Record<string, (a: PatternRow, b: PatternRow) => number>> = {
  count: (a, b) => a.count - b.count,
  first: (a, b) => a.first - b.first,
  last: (a, b) => a.last - b.last,
};

const TRACE_SORTS: Readonly<Record<string, (a: LogTraceRow, b: LogTraceRow) => number>> = {
  first: (a, b) => a.first - b.first,
  logs: (a, b) => a.logs - b.logs,
  severity: (a, b) => a.maxSeverity - b.maxSeverity,
};

interface TraceGroup {
  logs: number;
  first: number;
  last: number;
  maxSeverity: number;
  services: Set<string>;
}

/**
 * One filtered pass over log entries, shared by the eager (all entries) and windowed (chunk by chunk)
 * strategies. Feed every candidate entry to `visit`, then call `finish`. Holds no state outside itself, so an
 * abandoned or aborted run leaves nothing behind.
 */
export class LogQueryRun {
  readonly #q: LogQuery;
  readonly #signal: AbortSignal | undefined;
  readonly #ticker: AbortTicker;
  readonly #condition: CompiledCondition<'log_record'> | null;
  readonly #window: TimeWindow | null;
  readonly #rollups: LogRollups;
  readonly #matched: LogRow[] = [];
  readonly #traces = new Map<TraceId, TraceGroup>();
  readonly #logCompare: ((a: LogRow, b: LogRow) => number) | null;
  readonly #patternCompare: ((a: PatternRow, b: PatternRow) => number) | null;
  readonly #traceCompare: ((a: LogTraceRow, b: LogTraceRow) => number) | null;
  #count = 0;

  constructor(q: LogQuery, signal?: AbortSignal) {
    checkLimit(q.limit);
    this.#q = q;
    // Drain is the costly part of the rollups; only patterns mode reads it.
    this.#rollups = new LogRollups(QUERY_FACET_CAPS, { cluster: q.mode === 'patterns' });
    // "Scan entire run" means the whole run, whatever window the view had.
    this.#window = q.scanAll ? null : q.window;
    this.#signal = signal;
    this.#ticker = new AbortTicker(signal);
    this.#condition = q.condition === null ? null : compileCondition(q.condition, 'log_record');
    this.#logCompare = q.mode === 'logs' ? sortFor(LOG_SORTS, q.sort.column, q.mode) : null;
    this.#patternCompare = q.mode === 'patterns' ? sortFor(PATTERN_SORTS, q.sort.column, q.mode) : null;
    this.#traceCompare = q.mode === 'traces' ? sortFor(TRACE_SORTS, q.sort.column, q.mode) : null;
    throwIfAborted(signal);
  }

  /** What a scan's cap counts: matched logs, or matched traces in traces mode. */
  get units(): number {
    return this.#q.mode === 'traces' ? this.#traces.size : this.#count;
  }

  visit(e: LogEntry): void {
    this.#ticker.tick();
    const { row } = e;
    const window = this.#window;
    if (window !== null && (row.time < window.start || row.time > window.end)) return;
    if (this.#condition !== null && !this.#condition.test(e.target)) return;
    if (this.#q.text !== '' && !matchesText(this.#q.text, logTextFields(e.target))) return;
    if (this.#q.mode === 'traces') {
      const id = row.log.traceId;
      if (id === null) return;
      this.#group(id, row);
    } else if (this.#q.mode === 'logs') {
      this.#matched.push(row);
    }
    this.#count++;
    this.#rollups.add(e.target);
  }

  #group(id: TraceId, row: LogRow): void {
    let g = this.#traces.get(id);
    if (g === undefined) {
      g = { logs: 0, first: row.time, last: row.time, maxSeverity: 0, services: new Set() };
      this.#traces.set(id, g);
    }
    g.logs++;
    g.first = Math.min(g.first, row.time);
    g.last = Math.max(g.last, row.time);
    g.maxSeverity = Math.max(g.maxSeverity, row.log.severityNumber);
    g.services.add(row.service);
  }

  /** The comparator for the active mode is set in the constructor; this guards the other modes' branches. */
  #unreachable(): never {
    throw new OtelHtmlError('usage', {
      path: 'query.mode',
      expected: 'a mode with a sort table',
      actual: this.#q.mode,
    });
  }

  /** Patterns-mode rows of `d` in this query's sort and limit (the run's own clusters, or the writer's rollup). */
  patternsOf(d: Drain): { mode: 'patterns'; rows: PatternRow[]; total: number; unclustered: number } {
    const compare = this.#patternCompare ?? this.#unreachable();
    const all = patternRowsOf(d);
    const rows = topK(
      all,
      this.#q.limit,
      ordered(this.#q.sort.dir, compare, (a, b) => a.id - b.id),
    );
    return { mode: 'patterns', rows, total: all.length, unclustered: d.unclustered };
  }

  finish(partial: LogQueryResult['partial']): LogQueryResult {
    throwIfAborted(this.#signal);
    const { limit, sort, mode } = this.#q;
    const common = {
      matched: this.#count,
      facets: this.#rollups.facets,
      buckets: this.#rollups.buckets,
      partial,
    };
    switch (mode) {
      case 'logs': {
        const compare = this.#logCompare ?? this.#unreachable();
        const rows = topK(this.#matched, limit, ordered(sort.dir, compare, byTimeThenRef));
        return { ...common, mode, rows, total: this.#matched.length };
      }
      case 'patterns':
        return { ...common, ...this.patternsOf(this.#rollups.patterns) };
      case 'traces': {
        const compare = this.#traceCompare ?? this.#unreachable();
        const all: LogTraceRow[] = [...this.#traces].map(([traceId, g]) => ({
          traceId,
          logs: g.logs,
          first: g.first,
          last: g.last,
          maxSeverity: g.maxSeverity,
          services: [...g.services].sort(),
        }));
        const rows = topK(
          all,
          limit,
          ordered(sort.dir, compare, (a, b) => a.first - b.first || cmp(a.traceId, b.traceId)),
        );
        return { ...common, mode, rows, total: all.length };
      }
      default: {
        const never: never = mode;
        throw new OtelHtmlError('usage', {
          path: 'query.mode',
          expected: 'logs, patterns or traces',
          actual: String(never),
        });
      }
    }
  }
}

/** Run a query over entries that are all in memory (the eager strategy, and the perf test). */
export function queryLogEntries(
  entries: readonly LogEntry[],
  q: LogQuery,
  signal?: AbortSignal,
): LogQueryResult {
  const run = new LogQueryRun(q, signal);
  for (const e of entries) run.visit(e);
  return run.finish(null);
}
