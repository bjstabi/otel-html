import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import { StatusCode } from '../../model/records.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import type { SpanTarget } from '../../ottl/contexts.js';
import { matchesText, spanTextFields } from '../../ottl/text.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { RedSeries } from '../../rollups/red.js';
import { SpanRollups, type SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import { resourceName, serviceName } from '../../semconv/resource-name.js';
import { buildTraceTree, exclusiveTimeByService } from './trace-tree.js';

/** Nanoseconds relative to the report epoch (same unit and range as `SpanRecord.start`). */
export interface TimeWindow {
  start: number;
  end: number;
}

export interface SpanQuery {
  condition: string | null;
  text: string;
  window: TimeWindow | null;
  mode: 'spans' | 'traces';
  sort: { column: string; dir: 'asc' | 'desc' };
  limit: number;
  /** Carried for the UI; grouping is a presentation concern and is not applied by the data layer. */
  groupBy: string | null;
  scanAll: boolean;
}

/** `span` keeps the refs of the chunk it was read from; use `TraceDetail` for ref-stable spans. */
export interface SpanRow {
  span: SpanRecord;
  service: string;
  resource: string;
  /** `end - start` in RelNanos units (nanoseconds, a safe-integer number like the span times), never negative. */
  durationNs: number;
}

export interface TraceRow {
  traceId: TraceId;
  /** The root span when it was seen; null when its chunk was not scanned (windowed) or the trace has none. */
  root: SpanRow | null;
  /** The root's service, span name and resource, from the trace index when available (windowed) or the root row. */
  rootSummary: { service: string; name: string; resource: string } | null;
  start: number;
  durationNs: number;
  spans: number;
  errors: number;
  /**
   * True when `serviceShare` and `root` were computed from every span of the trace. `spans`, `errors`, `start` and
   * `durationNs` are always whole-trace values (windowed reads them from the trace index). When false,
   * `serviceShare` is empty rather than an approximation from the chunks that happened to be scanned.
   */
  shareComplete: boolean;
  /** Exclusive time per service, largest first. */
  serviceShare: readonly { service: string; ns: number }[];
}

export interface SpanQueryResult {
  rows: readonly (SpanRow | TraceRow)[];
  total: number;
  facets: FacetCounts;
  buckets: TimeBuckets<SpanStatusKey>;
  red: RedSeries;
  /** Chunks scanned of all chunks; null when the result is exact. */
  partial: { scanned: number; total: number } | null;
}

export interface LoadedChunk {
  readonly n: number;
  readonly resources: readonly ResourceRecord[];
  readonly scopes: readonly ScopeRecord[];
}

export interface SpanEntry {
  readonly row: SpanRow;
  readonly target: SpanTarget;
  readonly chunk: LoadedChunk;
}

/** Whole-trace figures from the trace index, used instead of recomputing from a subset of the trace. */
export interface TraceFacts {
  start: number;
  end: number;
  spans: number;
  errors: number;
  root: { service: string; name: string; resource: string } | null;
  /** Whether every span of the trace is among the rows the query saw. */
  complete: boolean;
}

/** Facet caps used when rebuilding facets for a filtered set (the writer's defaults). */
export const QUERY_FACET_CAPS = { facetValueCap: 1_000, facetKeyCap: 500 } as const;

const ABORT_CHECK_EVERY = 4096;

/** Queries reject with a `DOMException` named `AbortError` (the platform's own abort convention). */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException('The span query was aborted', 'AbortError');
}

export function toEntries(
  chunk: LoadedChunk,
  spans: readonly SpanRecord[],
  epoch: UnixNanos,
  path: string,
): SpanEntry[] {
  return spans.map((span, i) => {
    const resource = chunk.resources[span.resource];
    const scope = chunk.scopes[span.scope];
    if (resource === undefined || scope === undefined) {
      throw new OtelHtmlError('invalid-report', {
        path: `${path}[${i}]`,
        expected: 'resource and scope refs inside the chunk tables',
        actual: `resource ${span.resource}, scope ${span.scope}`,
      });
    }
    return {
      row: {
        span,
        service: serviceName(resource),
        resource: resourceName(span),
        durationNs: Math.max(0, span.end - span.start),
      },
      target: { span, resource, scope, epoch },
      chunk,
    };
  });
}

type Compare = (a: SpanRow, b: SpanRow) => number;

const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

const SPAN_SORTS: Readonly<Record<string, Compare>> = {
  start: (a, b) => a.span.start - b.span.start,
  duration: (a, b) => a.durationNs - b.durationNs,
  name: (a, b) => cmp(a.span.name, b.span.name),
  service: (a, b) => cmp(a.service, b.service),
  resource: (a, b) => cmp(a.resource, b.resource),
  status: (a, b) => a.span.status.code - b.span.status.code,
};

const TRACE_SORTS: Readonly<Record<string, (a: TraceRow, b: TraceRow) => number>> = {
  start: (a, b) => a.start - b.start,
  duration: (a, b) => a.durationNs - b.durationNs,
  spans: (a, b) => a.spans - b.spans,
  errors: (a, b) => a.errors - b.errors,
  resource: (a, b) => cmp(a.root?.resource ?? '', b.root?.resource ?? ''),
  service: (a, b) => cmp(a.root?.service ?? '', b.root?.service ?? ''),
};

function sortFor<T>(table: Readonly<Record<string, T>>, column: string, mode: string): T {
  const fn = Object.hasOwn(table, column) ? table[column] : undefined;
  if (fn === undefined) {
    throw new OtelHtmlError('usage', {
      path: 'query.sort.column',
      expected: `one of ${Object.keys(table).join(', ')} (mode ${mode})`,
      actual: JSON.stringify(column),
    });
  }
  return fn;
}

function traceRow(traceId: TraceId, rows: readonly SpanRow[], facts?: TraceFacts): TraceRow {
  const tree = buildTraceTree(rows);
  const root = tree.roots.find((n) => n.row.span.parentSpanId === null)?.row ?? null;
  const rootSummary =
    root === null ? null : { service: root.service, name: root.span.name, resource: root.resource };
  if (facts !== undefined) {
    return {
      traceId,
      root,
      rootSummary: facts.root ?? rootSummary,
      start: facts.start,
      durationNs: Math.max(0, facts.end - facts.start),
      spans: facts.spans,
      errors: facts.errors,
      shareComplete: facts.complete,
      serviceShare: facts.complete ? exclusiveTimeByService(tree) : [],
    };
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let errors = 0;
  for (const r of rows) {
    start = Math.min(start, r.span.start);
    end = Math.max(end, r.span.end);
    if (r.span.status.code === StatusCode.ERROR) errors++;
  }
  return {
    traceId,
    root,
    rootSummary,
    start,
    durationNs: Math.max(0, end - start),
    spans: rows.length,
    errors,
    shareComplete: true,
    serviceShare: exclusiveTimeByService(tree),
  };
}

/**
 * One filtered pass over span entries, shared by the eager (all entries) and windowed (chunk by chunk)
 * strategies. Feed every candidate entry to `visit`, then call `finish`. Holds no state outside itself, so an
 * abandoned or aborted run leaves nothing behind.
 */
export class SpanQueryRun {
  readonly #q: SpanQuery;
  readonly #signal: AbortSignal | undefined;
  readonly #condition: CompiledCondition<'span'> | null;
  readonly #rollups = new SpanRollups(QUERY_FACET_CAPS);
  readonly #matched: SpanEntry[] = [];
  readonly #traces = new Map<TraceId, { rows: SpanRow[]; hit: boolean }>();
  readonly #compare: Compare | null;
  readonly #traceCompare: ((a: TraceRow, b: TraceRow) => number) | null;
  readonly #window: TimeWindow | null;
  #visited = 0;
  #hitTraces = 0;

  constructor(q: SpanQuery, signal?: AbortSignal) {
    if (q.groupBy !== null) {
      throw new OtelHtmlError('usage', {
        path: 'query.groupBy',
        expected: 'null (grouping is not implemented by the data layer yet)',
        actual: JSON.stringify(q.groupBy),
      });
    }
    if (!Number.isInteger(q.limit) || q.limit < 0) {
      throw new OtelHtmlError('usage', {
        path: 'query.limit',
        expected: 'a non-negative integer',
        actual: String(q.limit),
      });
    }
    this.#q = q;
    // "Scan entire run" means the whole run, whatever window the view had.
    this.#window = q.scanAll ? null : q.window;
    this.#signal = signal;
    this.#condition = q.condition === null ? null : compileCondition(q.condition, 'span');
    this.#compare = q.mode === 'spans' ? sortFor(SPAN_SORTS, q.sort.column, q.mode) : null;
    this.#traceCompare = q.mode === 'traces' ? sortFor(TRACE_SORTS, q.sort.column, q.mode) : null;
    throwIfAborted(signal);
  }

  /** What a scan's cap counts: matched spans, or matched traces in traces mode. */
  get units(): number {
    return this.#q.mode === 'traces' ? this.#hitTraces : this.#matched.length;
  }

  /** Ids of traces with a matching span (traces mode), in first-seen order. */
  hitTraceIds(): TraceId[] {
    return [...this.#traces].filter(([, g]) => g.hit).map(([id]) => id);
  }

  /** The rows seen so far for a trace (traces mode). */
  seenRows(id: TraceId): readonly SpanRow[] {
    return this.#traces.get(id)?.rows ?? [];
  }

  visit(e: SpanEntry): void {
    if (++this.#visited % ABORT_CHECK_EVERY === 0) throwIfAborted(this.#signal);
    const window = this.#window;
    const { span } = e.row;
    const traces = this.#traces;
    let group: { rows: SpanRow[]; hit: boolean } | undefined;
    if (this.#q.mode === 'traces') {
      group = traces.get(span.traceId);
      if (group === undefined) {
        group = { rows: [], hit: false };
        traces.set(span.traceId, group);
      }
      group.rows.push(e.row);
    }
    if (window !== null && (span.end < window.start || span.start > window.end)) return;
    if (this.#condition !== null && !this.#condition.test(e.target)) return;
    if (this.#q.text !== '' && !matchesText(this.#q.text, spanTextFields(e.target))) return;
    this.#matched.push(e);
    if (group !== undefined) {
      if (!group.hit) this.#hitTraces++;
      group.hit = true;
    }
    this.#rollups.add(e.target);
  }

  finish(
    partial: SpanQueryResult['partial'],
    factsOf?: (id: TraceId) => TraceFacts | undefined,
  ): SpanQueryResult {
    throwIfAborted(this.#signal);
    const sign = this.#q.sort.dir === 'asc' ? 1 : -1;
    let rows: (SpanRow | TraceRow)[];
    let total: number;
    if (this.#compare !== null) {
      const compare = this.#compare;
      rows = this.#matched
        .map((e) => e.row)
        .sort((a, b) => sign * compare(a, b) || a.span.start - b.span.start)
        .slice(0, this.#q.limit);
      total = this.#matched.length;
    } else {
      const compare = this.#traceCompare;
      const hits = [...this.#traces]
        .filter(([, g]) => g.hit)
        .map(([id, g]) => traceRow(id, g.rows, factsOf?.(id)));
      if (compare !== null) hits.sort((a, b) => sign * compare(a, b) || a.start - b.start);
      rows = hits.slice(0, this.#q.limit);
      total = hits.length;
    }
    return {
      rows,
      total,
      facets: this.#rollups.facets,
      buckets: this.#rollups.buckets,
      red: this.#rollups.red,
      partial,
    };
  }
}

/** Run a query over entries that are all in memory (the eager strategy, and the perf test). */
export function querySpanEntries(
  entries: readonly SpanEntry[],
  q: SpanQuery,
  signal?: AbortSignal,
): SpanQueryResult {
  const run = new SpanQueryRun(q, signal);
  for (const e of entries) run.visit(e);
  return run.finish(null);
}
