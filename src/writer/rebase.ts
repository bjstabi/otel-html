import { OtelHtmlError } from '../model/errors.js';
import type { RelNanos } from '../model/ids.js';
import type { NormalizeContext } from '../model/normalize.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRef,
  ScopeRef,
  SpanRecord,
} from '../model/records.js';
import type { RecordBatch } from './session.js';

/** Shift a relative timestamp by `shift` ns, failing fast when it leaves the exact-integer range. */
function shiftNanos(t: RelNanos, shift: bigint, path: string): RelNanos {
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

interface Refs {
  resource: ResourceRef;
  scope: ScopeRef;
}

function rebaseSpan(s: SpanRecord, shift: bigint, refs: Refs, path: string): SpanRecord {
  return {
    ...s,
    start: shiftNanos(s.start, shift, `${path}.start`),
    end: shiftNanos(s.end, shift, `${path}.end`),
    events: s.events.map((e, i) => ({ ...e, time: shiftNanos(e.time, shift, `${path}.events[${i}].time`) })),
    ...refs,
  };
}

function rebaseLog(l: LogRecordRecord, shift: bigint, refs: Refs, path: string): LogRecordRecord {
  return {
    ...l,
    time: shiftOrNull(l.time, shift, `${path}.time`),
    observedTime: shiftOrNull(l.observedTime, shift, `${path}.observedTime`),
    ...refs,
  };
}

function rebasePoint(p: MetricPointRecord, shift: bigint, refs: Refs, path: string): MetricPointRecord {
  return {
    ...p,
    start: shiftOrNull(p.start, shift, `${path}.start`),
    time: shiftNanos(p.time, shift, `${path}.time`),
    ...refs,
  };
}

function badRef(path: string, ref: number, len: number): OtelHtmlError {
  return new OtelHtmlError('invalid-report', {
    path,
    expected: `a ref in [0, ${len})`,
    actual: String(ref),
  });
}

/** A batch's rows moved into the session's context: epoch-shifted, with resources and scopes interned there. */
export type Rebased =
  | { signal: 'spans'; rows: readonly SpanRecord[] }
  | { signal: 'logs'; rows: readonly LogRecordRecord[] }
  /** Lazy: a bad ref or time surfaces while the points are consumed, as the chunk session always had it. */
  | { signal: 'metrics'; rows: () => Iterable<MetricPointRecord> };

/**
 * The step both sessions' `addRecords` share. An empty batch is `null` (nothing to accept, the epoch untouched);
 * otherwise `ensureEpoch` fixes the session context from `batch.epoch` and every row is rebased onto it.
 */
export function rebaseBatch(
  batch: RecordBatch,
  ensureEpoch: (epoch: RecordBatch['epoch']) => NormalizeContext,
): Rebased | null {
  if (batch.rows.length === 0) return null;
  const ctx = ensureEpoch(batch.epoch);
  const shift = batch.epoch - ctx.epoch;
  const resources = new Map<number, ResourceRef>();
  const scopes = new Map<number, ScopeRef>();
  const refsOf = (r: number, s: number, path: string): Refs => {
    let resource = resources.get(r);
    if (resource === undefined) {
      const rec = batch.resources[r];
      if (rec === undefined) throw badRef(`${path}.resource`, r, batch.resources.length);
      resource = ctx.resources.intern(rec) as ResourceRef;
      resources.set(r, resource);
    }
    let scope = scopes.get(s);
    if (scope === undefined) {
      const rec = batch.scopes[s];
      if (rec === undefined) throw badRef(`${path}.scope`, s, batch.scopes.length);
      scope = ctx.scopes.intern(rec) as ScopeRef;
      scopes.set(s, scope);
    }
    return { resource, scope };
  };
  switch (batch.signal) {
    case 'spans':
      return {
        signal: 'spans',
        rows: batch.rows.map((s, i) =>
          rebaseSpan(s, shift, refsOf(s.resource, s.scope, `rows[${i}]`), `rows[${i}]`),
        ),
      };
    case 'logs':
      return {
        signal: 'logs',
        rows: batch.rows.map((l, i) =>
          rebaseLog(l, shift, refsOf(l.resource, l.scope, `rows[${i}]`), `rows[${i}]`),
        ),
      };
    case 'metrics':
      return {
        signal: 'metrics',
        rows: function* () {
          for (const [i, p] of batch.rows.entries()) {
            yield rebasePoint(p, shift, refsOf(p.resource, p.scope, `rows[${i}]`), `rows[${i}]`);
          }
        },
      };
  }
}
