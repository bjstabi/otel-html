import type { RelNanos, SpanId, TraceId } from '../../src/model/ids.js';
import type {
  LogRecordRecord,
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
} from '../../src/model/records.js';
import { FacetCounts } from '../../src/rollups/facets.js';
import { TimeBuckets } from '../../src/rollups/time-buckets.js';
import { LOG_SEVERITY_KEYS } from '../../src/semconv/severity.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { type LogRef, type LogRow, logRef } from '../../src/viewer/data/log-query.js';
import type {
  GroupStats,
  LogQuery,
  LogQueryResult,
  SpanQuery,
  SpanQueryResult,
  SpanRow,
  TraceRow,
} from '../../src/viewer/data/results.js';
import type { TimeWindow } from '../../src/viewer/data/time-window.js';
import { baseManifest, dataSourceOf } from './dashboard-shell.js';
import { detailOf, traceRow } from './trace-rows.js';

const S = 1_000_000_000;

/** The trace of the fixture: a `checkout` root over a `payments` child, at 60 s. */
export const FIXTURE_TRACE = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' as TraceId;
/** The log on `payments`, on the child span of `FIXTURE_TRACE`. */
const PAYMENTS_LOG_REF = logRef(0, 0);
/** The log on `web`, which has no trace. */
const WEB_LOG_REF = logRef(1, 0);

const inTrace = (r: SpanRow): SpanRow => ({ ...r, span: { ...r.span, traceId: FIXTURE_TRACE } });

/** `GET /checkout` on `checkout` (60.0-60.5 s) over `charge` on `payments` (60.1-60.3 s). */
const SPANS: readonly SpanRow[] = [
  inTrace(traceRow(1, null, 60 * S, 60.5 * S, { service: 'checkout', name: 'GET /checkout' })),
  inTrace(traceRow(2, 1, 60.1 * S, 60.3 * S, { service: 'payments', name: 'charge' })),
];

const RESOURCE: ResourceRecord = { attributes: new Map(), droppedAttributesCount: 0, schemaUrl: '' };
const SCOPE: ScopeRecord = {
  name: 'scope',
  version: '',
  attributes: new Map(),
  droppedAttributesCount: 0,
  schemaUrl: '',
};

function logRow(
  ref: LogRef,
  n: number,
  body: string,
  service: string,
  timeNs: number,
  traceId: TraceId | null,
): LogRow {
  const log: LogRecordRecord = {
    time: timeNs as RelNanos,
    observedTime: timeNs as RelNanos,
    severityNumber: 17,
    severityText: 'ERROR',
    body: { kind: 'string', value: body },
    attributes: new Map(),
    droppedAttributesCount: 0,
    flags: 0,
    traceId,
    spanId: traceId === null ? null : ('b2b2b2b2b2b2b2b2' as SpanId),
    eventName: '',
    resource: 0 as ResourceRef,
    scope: 0 as ScopeRef,
  };
  return {
    ref,
    n,
    i: 0,
    log,
    resource: RESOURCE,
    scope: SCOPE,
    time: timeNs as RelNanos,
    timeSource: 'time',
    service,
    host: null,
  };
}

const LOGS: readonly LogRow[] = [
  logRow(PAYMENTS_LOG_REF, 0, 'charge declined', 'payments', 60.2 * S, FIXTURE_TRACE),
  logRow(WEB_LOG_REF, 1, 'web log', 'web', 61 * S, null),
];

/** Points every 30 s from 0 to 120 s, 20 in each: 100 in all. */
function fixturePoints(): TimeBuckets<'points'> {
  const points = new TimeBuckets<'points'>(['points'], 8);
  for (let t = 0; t <= 120; t += 30) points.add((t * S) as RelNanos, 'points', 20);
  return points;
}

/** The manifest of the fixture: a run from the epoch to 121 s. */
const fixtureManifest = {
  ...baseManifest,
  range: {
    start: baseManifest.epochUnixNano,
    end: (BigInt(baseManifest.epochUnixNano) + BigInt(121 * S)).toString(),
  },
};

function within(w: TimeWindow | null, start: number, end: number): boolean {
  return w === null || (start <= w.end && end >= w.start);
}

/** The conditions the dashboard tests use: a trace id equality, `!= ""`, and anything else matches all. */
function conditionHolds(condition: string | null, traceId: TraceId | null): boolean {
  if (condition === null) return true;
  const eq = /trace_id\.string == "([0-9a-f]+)"/.exec(condition);
  if (eq !== null) return traceId === eq[1];
  if (condition.includes('trace_id.string != ""')) return traceId !== null;
  return true;
}

function sorted<T>(rows: readonly T[], dir: 'asc' | 'desc', key: (r: T) => number): T[] {
  return [...rows].sort((a, b) => (dir === 'asc' ? key(a) - key(b) : key(b) - key(a)));
}

function groupStats(rows: readonly SpanRow[], key: string): GroupStats[] {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const group = key === 'service.name' ? r.service : r.span.name;
    by.set(group, [...(by.get(group) ?? []), r.durationNs]);
  }
  return [...by].map(([group, d]) => {
    const asc = [...d].sort((a, b) => a - b);
    const sum = d.reduce((a, b) => a + b, 0);
    const at = (p: number): number => asc[Math.min(asc.length - 1, Math.ceil(p * asc.length) - 1)] ?? 0;
    return {
      group,
      count: d.length,
      sum,
      avg: sum / d.length,
      max: asc.at(-1) ?? 0,
      p95: at(0.95),
      p99: at(0.99),
    };
  });
}

function spanResult(q: SpanQuery): SpanQueryResult {
  const needs = new Set(q.needs);
  const kept = SPANS.filter(
    (r) => within(q.window, r.span.start, r.span.end) && conditionHolds(q.condition, r.span.traceId),
  );
  const facets = new FacetCounts(10, 10);
  const buckets = new TimeBuckets<'ok' | 'error' | 'unset'>(['ok', 'error', 'unset'], 8);
  const wanted = (k: string): boolean => q.facetKeys === null || q.facetKeys.includes(k);
  for (const r of kept) {
    if (needs.has('facets')) {
      if (wanted('service.name')) facets.add('service.name', r.service);
      if (wanted('span.name')) facets.add('span.name', r.span.name);
    }
    if (needs.has('timeline')) buckets.add(r.span.start, 'unset');
  }
  const result: SpanQueryResult = {
    rows: [],
    total: 0,
    facets,
    buckets,
    red: null,
    durations: { summary: null, bins: [] },
    groups: null,
    residual: null,
    tables: { resources: [], scopes: [] },
  };
  if (needs.has('rows')) {
    result.total = kept.length;
    if (q.mode === 'spans') {
      result.rows = sorted(kept, q.sort.dir, (r) => r.span.start).slice(0, q.limit);
    } else {
      const root = kept.find((r) => r.span.parentSpanId === null);
      const trace: TraceRow = {
        traceId: FIXTURE_TRACE,
        rootSummary:
          root === undefined
            ? null
            : { service: root.service, name: root.span.name, resource: root.resource },
        start: 60 * S,
        durationNs: 0.5 * S,
        spans: kept.length,
        errors: 0,
      };
      result.rows = kept.length === 0 ? [] : [trace];
      result.total = kept.length === 0 ? 0 : 1;
    }
  }
  if (needs.has('groups') && q.measureBy !== null) {
    result.groups = { groups: groupStats(kept, q.measureBy), cap: 10, dropped: 0 };
  }
  return result;
}

function logResult(q: LogQuery): LogQueryResult {
  const needs = new Set(q.needs);
  const kept = LOGS.filter(
    (r) =>
      within(q.window, r.time, r.time) &&
      (q.traceId == null || r.log.traceId === q.traceId) &&
      conditionHolds(q.condition, r.log.traceId),
  );
  const facets = new FacetCounts(10, 10);
  const buckets = new TimeBuckets(LOG_SEVERITY_KEYS, 8);
  for (const r of kept) {
    if (needs.has('facets') && (q.facetKeys === null || q.facetKeys.includes('service.name'))) {
      facets.add('service.name', r.service);
    }
    if (needs.has('timeline')) buckets.add(r.time, 'error');
  }
  const rows = needs.has('rows') ? sorted(kept, q.sort.dir, (r) => r.time).slice(0, q.limit) : [];
  const total = needs.has('rows') ? kept.length : 0;
  return { mode: 'logs', rows, total, matched: total, facets, buckets, residual: null };
}

/**
 * A format-4 source over the linked fixture's rows (see `buildEmbeddedMetricsReport`): the SQL path is covered in
 * `test/viewer-data/`, so the dashboard tests ask this fake for the scope's window, trace and a few conditions.
 */
export function fusionSource(over: Partial<DataSource> = {}): DataSource {
  return {
    ...dataSourceOf(fixtureManifest),
    querySpans: (q) => Promise.resolve(spanResult(q)),
    queryLogs: (q) => Promise.resolve(logResult(q)),
    getTrace: () => Promise.resolve({ ...detailOf(SPANS), traceId: FIXTURE_TRACE }),
    hasTrace: () => Promise.resolve(true),
    metricPoints: () => Promise.resolve(fixturePoints()),
    resourceValues: (key) =>
      Promise.resolve({
        values: key === 'service.name' ? ['checkout', 'payments', 'web'] : [],
        kind: 'string',
        capped: false,
      }),
    ...over,
  };
}
