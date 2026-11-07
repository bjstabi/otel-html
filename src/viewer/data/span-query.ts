import type { TraceId } from '../../model/ids.js';
import type { ResourceRecord, ScopeRecord, SpanRecord } from '../../model/records.js';
import type { TimeWindow } from './time-window.js';

export type { TimeWindow };

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

export interface LoadedChunk {
  readonly n: number;
  readonly resources: readonly ResourceRecord[];
  readonly scopes: readonly ScopeRecord[];
}
