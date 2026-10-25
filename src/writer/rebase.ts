import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRef,
  ScopeRef,
  SpanRecord,
} from '../model/records.js';

/** Shift a relative timestamp by `shift` ns, failing fast when it leaves the exact-integer range. */
export function shiftNanos(t: RelNanos, shift: bigint, path: string): RelNanos {
  if (shift === 0n) return t;
  const v = BigInt(t) + shift;
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new OtelHtmlError('time-out-of-range', {
      path,
      expected: 'offset within 2^53 ns (~104 days) of the report epoch',
      actual: `${v} ns`,
    });
  }
  return Number(v) as RelNanos;
}

function shiftOrNull(t: RelNanos | null, shift: bigint, path: string): RelNanos | null {
  return t === null ? null : shiftNanos(t, shift, path);
}

export interface Refs {
  resource: ResourceRef;
  scope: ScopeRef;
}

export function rebaseSpan(s: SpanRecord, shift: bigint, refs: Refs, path: string): SpanRecord {
  return {
    ...s,
    start: shiftNanos(s.start, shift, `${path}.start`),
    end: shiftNanos(s.end, shift, `${path}.end`),
    events: s.events.map((e, i) => ({ ...e, time: shiftNanos(e.time, shift, `${path}.events[${i}].time`) })),
    ...refs,
  };
}

export function rebaseLog(l: LogRecordRecord, shift: bigint, refs: Refs, path: string): LogRecordRecord {
  return {
    ...l,
    time: shiftOrNull(l.time, shift, `${path}.time`),
    observedTime: shiftOrNull(l.observedTime, shift, `${path}.observedTime`),
    ...refs,
  };
}

export function rebasePoint(
  p: MetricPointRecord,
  shift: bigint,
  refs: Refs,
  path: string,
): MetricPointRecord {
  return {
    ...p,
    start: shiftOrNull(p.start, shift, `${path}.start`),
    time: shiftNanos(p.time, shift, `${path}.time`),
    ...refs,
  };
}
