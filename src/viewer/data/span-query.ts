import { OtelHtmlError } from '../../model/errors.js';
import type { TraceId, UnixNanos } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import { StatusCode } from '../../model/records.js';
import { type CompiledCondition, compileCondition } from '../../ottl/compile.js';
import type { SpanTarget } from '../../ottl/contexts.js';
import { matchesText, spanTextFields } from '../../ottl/text.js';
import type { FacetCounts } from '../../rollups/facets.js';
import type { RedSeries } from '../../rollups/red.js';
import { facetValueOf, GroupDurations, SpanRollups, type SpanStatusKey } from '../../rollups/span-rollups.js';
import type { TimeBuckets } from '../../rollups/time-buckets.js';
import { resourceName, serviceName } from '../../semconv/resource-name.js';
import {
  AbortTicker,
  checkLimit,
  cmp,
  DEFAULT_FACET_CAPS,
  type FacetCaps,
  ordered,
  sortFor,
  throwIfAborted,
} from './query-common.js';
import { TopKBuffer, topK } from './top-k.js';
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
  /** The facet key to aggregate span durations by (`SpanQueryResult.groups`); null for none. */
  measureBy: string | null;
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
  /** Duration histograms per `measureBy` value; null when `measureBy` is null. */
  groups: GroupDurations | null;
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

interface TraceGroup {
  rows: SpanRow[];
  hit: boolean;
  /** Rows were dropped at a chunk end before the trace hit, so what is held is a fragment. */
  dropped: boolean;
}

type Compare = (a: SpanRow, b: SpanRow) => number;

/** The spans-mode tiebreak: start, then span id, so the order is total and windowed and eager scans agree. */
const bySpanStartThenId: Compare = (a, b) => a.span.start - b.span.start || cmp(a.span.spanId, b.span.spanId);

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
  resource: (a, b) =>
    cmp(a.root?.resource ?? a.rootSummary?.resource ?? '', b.root?.resource ?? b.rootSummary?.resource ?? ''),
  service: (a, b) =>
    cmp(a.root?.service ?? a.rootSummary?.service ?? '', b.root?.service ?? b.rootSummary?.service ?? ''),
};

function traceRow(
  traceId: TraceId,
  rows: readonly SpanRow[],
  facts: TraceFacts | undefined,
  dropped: boolean,
): TraceRow {
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
    // A share built from a fragment (rows dropped at a chunk end) is never complete.
    shareComplete: !dropped,
    serviceShare: dropped ? [] : exclusiveTimeByService(tree),
  };
}

/**
 * One filtered pass over span entries, shared by the eager (all entries) and windowed (chunk by chunk)
 * strategies. Feed every candidate entry to `visit`, then call `finish`. Holds no state outside itself, so an
 * abandoned or aborted run leaves nothing behind. It keeps matched rows only up to a bound in spans mode (the best
 * `limit` so far plus a little slack). In traces mode it keeps, per trace, the rows since the trace's first chunk
 * with a hit, plus the current chunk's rows; `endChunk` drops the rest. A trace that hits in a later chunk than its
 * root is built from the rows seen since (windowed reads whole-trace figures from the trace index).
 */
export class SpanQueryRun {
  readonly #q: SpanQuery;
  readonly #signal: AbortSignal | undefined;
  readonly #condition: CompiledCondition<'span'> | null;
  readonly #rollups: SpanRollups;
  readonly #groups: GroupDurations | null;
  /** Spans mode: the best `limit` matched rows so far plus compaction slack; null in traces mode. */
  readonly #rows: TopKBuffer<SpanRow> | null;
  readonly #traces = new Map<TraceId, TraceGroup>();
  readonly #order: ((a: SpanRow, b: SpanRow) => number) | null;
  readonly #traceCompare: ((a: TraceRow, b: TraceRow) => number) | null;
  readonly #window: TimeWindow | null;
  readonly #ticker: AbortTicker;
  #hitTraces = 0;
  #count = 0;

  constructor(q: SpanQuery, signal: AbortSignal | undefined, caps: FacetCaps) {
    if (q.groupBy !== null) {
      throw new OtelHtmlError('usage', {
        path: 'query.groupBy',
        expected: 'null (grouping is not implemented by the data layer yet)',
        actual: JSON.stringify(q.groupBy),
      });
    }
    checkLimit(q.limit);
    this.#q = q;
    this.#rollups = new SpanRollups(caps);
    this.#groups = q.measureBy === null ? null : new GroupDurations(caps.facetValueCap);
    // "Scan entire run" means the whole run, whatever window the view had.
    this.#window = q.scanAll ? null : q.window;
    this.#signal = signal;
    this.#ticker = new AbortTicker(signal);
    this.#condition = q.condition === null ? null : compileCondition(q.condition, 'span');
    this.#order =
      q.mode === 'spans'
        ? ordered(q.sort.dir, sortFor(SPAN_SORTS, q.sort.column, q.mode), bySpanStartThenId)
        : null;
    this.#rows = this.#order === null ? null : new TopKBuffer(q.limit, this.#order);
    this.#traceCompare = q.mode === 'traces' ? sortFor(TRACE_SORTS, q.sort.column, q.mode) : null;
    throwIfAborted(signal);
  }

  /** What a scan's cap counts: matched spans, or matched traces in traces mode. */
  get units(): number {
    return this.#q.mode === 'traces' ? this.#hitTraces : this.#count;
  }

  /** @internal for tests: how many matched rows the run holds right now. */
  get heldRows(): number {
    if (this.#rows !== null) return this.#rows.size;
    let n = 0;
    for (const g of this.#traces.values()) n += g.rows.length;
    return n;
  }

  /**
   * Call after a chunk has been visited whole (traces mode): drops the rows of traces that have not hit, so a
   * whole-run scan does not hold every span. The group stays, so a later hit still counts the trace once.
   */
  endChunk(): void {
    if (this.#q.mode !== 'traces') return;
    for (const g of this.#traces.values()) {
      if (g.hit || g.rows.length === 0) continue;
      g.rows.length = 0;
      g.dropped = true;
    }
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
    this.#ticker.tick();
    const window = this.#window;
    const { span } = e.row;
    const traces = this.#traces;
    let group: TraceGroup | undefined;
    if (this.#q.mode === 'traces') {
      group = traces.get(span.traceId);
      if (group === undefined) {
        group = { rows: [], hit: false, dropped: false };
        traces.set(span.traceId, group);
      }
      group.rows.push(e.row);
    }
    if (window !== null && (span.end < window.start || span.start > window.end)) return;
    if (this.#condition !== null && !this.#condition.test(e.target)) return;
    if (this.#q.text !== '' && !matchesText(this.#q.text, spanTextFields(e.target))) return;
    this.#count++;
    this.#rows?.push(e.row);
    if (group !== undefined) {
      if (!group.hit) this.#hitTraces++;
      group.hit = true;
    }
    this.#rollups.add(e.target);
    if (this.#groups !== null && this.#q.measureBy !== null) {
      const v = facetValueOf(e.target, this.#q.measureBy);
      if (v !== undefined) this.#groups.add(v, e.row.durationNs);
    }
  }

  finish(
    partial: SpanQueryResult['partial'],
    factsOf?: (id: TraceId) => TraceFacts | undefined,
  ): SpanQueryResult {
    throwIfAborted(this.#signal);
    let rows: (SpanRow | TraceRow)[];
    let total: number;
    if (this.#rows !== null) {
      rows = this.#rows.take();
      total = this.#count;
    } else {
      const compare = this.#traceCompare;
      const hits = [...this.#traces]
        .filter(([, g]) => g.hit)
        .map(([id, g]) => traceRow(id, g.rows, factsOf?.(id), g.dropped));
      rows =
        compare === null
          ? hits.slice(0, this.#q.limit)
          : topK(
              hits,
              this.#q.limit,
              ordered(this.#q.sort.dir, compare, (a, b) => a.start - b.start),
            );
      total = hits.length;
    }
    return {
      rows,
      total,
      facets: this.#rollups.facets,
      buckets: this.#rollups.buckets,
      red: this.#rollups.red,
      groups: this.#groups,
      partial,
    };
  }
}

/** Run a query over entries that are all in memory (the eager strategy, and the perf test). */
export function querySpanEntries(
  entries: readonly SpanEntry[],
  q: SpanQuery,
  signal?: AbortSignal,
  caps: FacetCaps = DEFAULT_FACET_CAPS,
): SpanQueryResult {
  const run = new SpanQueryRun(q, signal, caps);
  for (const e of entries) run.visit(e);
  return run.finish(null);
}
