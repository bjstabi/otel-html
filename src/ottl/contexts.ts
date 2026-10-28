import { type AnyValue, type Attributes, anyValueToDisplay } from '../model/anyvalue.js';
import { toUnixNanos, type UnixNanos } from '../model/ids.js';
import type {
  LogRecordRecord,
  MetricPointRecord,
  ResourceRecord,
  ScopeRecord,
  SpanRecord,
} from '../model/records.js';
import { LOG_SEVERITY_KEYS, SEVERITY_BANDS, severityEnumName } from '../semconv/severity.js';

export type OttlContextName = 'span' | 'log_record' | 'datapoint';

/** Runtime values the evaluator works with. `null` is OTTL `nil`. */
export type OttlValue =
  | null
  | string
  | bigint
  | number
  | boolean
  | Uint8Array
  | readonly OttlValue[]
  | ReadonlyMap<string, OttlValue>;

interface Shared {
  readonly resource: ResourceRecord;
  readonly scope: ScopeRecord;
  readonly epoch: UnixNanos;
}
export interface SpanTarget extends Shared {
  readonly span: SpanRecord;
}
export interface LogTarget extends Shared {
  readonly log: LogRecordRecord;
}
export interface DatapointTarget extends Shared {
  readonly point: MetricPointRecord;
}
export type Target = SpanTarget | LogTarget | DatapointTarget;

export interface TargetMap {
  span: SpanTarget;
  log_record: LogTarget;
  datapoint: DatapointTarget;
}
export type TargetOf<C extends OttlContextName> = TargetMap[C];

export type PathType = 'string' | 'int' | 'bool' | 'map' | 'bytes' | 'any';

export interface PathAccessor<T> {
  readonly type: PathType;
  get(t: T, keys: readonly (string | number)[]): OttlValue;
}

// ---------------------------------------------------------------------------
// AnyValue -> OttlValue
// ---------------------------------------------------------------------------

export function fromAnyValue(v: AnyValue): OttlValue {
  switch (v.kind) {
    case 'string':
    case 'bool':
    case 'int':
    case 'double':
    case 'bytes':
      return v.value;
    case 'array':
      return v.values.map(fromAnyValue);
    case 'kvlist':
      return fromAttributes(v.values);
    case 'empty':
      return null;
  }
}

function fromAttributes(a: Attributes): ReadonlyMap<string, OttlValue> {
  const m = new Map<string, OttlValue>();
  for (const [k, v] of a) m.set(k, fromAnyValue(v));
  return m;
}

/** Walk `keys` into an AnyValue; anything missing or of the wrong shape is nil. */
function descend(v: AnyValue | undefined, keys: readonly (string | number)[], from: number): OttlValue {
  let cur = v;
  for (let i = from; i < keys.length; i++) {
    if (cur === undefined) return null;
    const k = keys[i];
    if (typeof k === 'string' && cur.kind === 'kvlist') cur = cur.values.get(k);
    else if (typeof k === 'number' && cur.kind === 'array') cur = cur.values[k];
    else return null;
  }
  return cur === undefined ? null : fromAnyValue(cur);
}

function attributeAccessor<T>(select: (t: T) => Attributes): PathAccessor<T> {
  return {
    type: 'map',
    get(t, keys) {
      const attrs = select(t);
      if (keys.length === 0) return fromAttributes(attrs);
      const first = keys[0];
      if (typeof first !== 'string') return null;
      return descend(attrs.get(first), keys, 1);
    },
  };
}

function scalar<T>(type: PathType, f: (t: T) => OttlValue): PathAccessor<T> {
  return { type, get: (t, keys) => (keys.length === 0 ? f(t) : null) };
}

function sharedPaths<T extends Shared>(): [string, PathAccessor<T>][] {
  return [
    ['resource.attributes', attributeAccessor((t: T) => t.resource.attributes)],
    ['resource.dropped_attributes_count', scalar('int', (t: T) => BigInt(t.resource.droppedAttributesCount))],
    ['resource.schema_url', scalar('string', (t: T) => t.resource.schemaUrl)],
    ['instrumentation_scope.name', scalar('string', (t: T) => t.scope.name)],
    ['instrumentation_scope.version', scalar('string', (t: T) => t.scope.version)],
    ['instrumentation_scope.attributes', attributeAccessor((t: T) => t.scope.attributes)],
    [
      'instrumentation_scope.dropped_attributes_count',
      scalar('int', (t: T) => BigInt(t.scope.droppedAttributesCount)),
    ],
    ['instrumentation_scope.schema_url', scalar('string', (t: T) => t.scope.schemaUrl)],
  ];
}

// ---------------------------------------------------------------------------
// Path tables, keyed by canonical (context-prefix-free) path
// ---------------------------------------------------------------------------

export const SPAN_PATHS: ReadonlyMap<string, PathAccessor<SpanTarget>> = new Map<
  string,
  PathAccessor<SpanTarget>
>([
  ['trace_id.string', scalar('string', (t: SpanTarget) => t.span.traceId)],
  ['span_id.string', scalar('string', (t: SpanTarget) => t.span.spanId)],
  ['parent_span_id.string', scalar('string', (t: SpanTarget) => t.span.parentSpanId ?? '')],
  ['trace_state', scalar('string', (t: SpanTarget) => t.span.traceState)],
  ['flags', scalar('int', (t: SpanTarget) => BigInt(t.span.flags))],
  ['name', scalar('string', (t: SpanTarget) => t.span.name)],
  ['kind', scalar('int', (t: SpanTarget) => BigInt(t.span.kind))],
  ['start_time_unix_nano', scalar('int', (t: SpanTarget) => toUnixNanos(t.span.start, t.epoch))],
  ['end_time_unix_nano', scalar('int', (t: SpanTarget) => toUnixNanos(t.span.end, t.epoch))],
  ['attributes', attributeAccessor((t: SpanTarget) => t.span.attributes)],
  ['dropped_attributes_count', scalar('int', (t: SpanTarget) => BigInt(t.span.droppedAttributesCount))],
  ['dropped_events_count', scalar('int', (t: SpanTarget) => BigInt(t.span.droppedEventsCount))],
  ['dropped_links_count', scalar('int', (t: SpanTarget) => BigInt(t.span.droppedLinksCount))],
  ['status.code', scalar('int', (t: SpanTarget) => BigInt(t.span.status.code))],
  ['status.message', scalar('string', (t: SpanTarget) => t.span.status.message)],
  ...sharedPaths<SpanTarget>(),
]);

export const LOG_PATHS: ReadonlyMap<string, PathAccessor<LogTarget>> = new Map<
  string,
  PathAccessor<LogTarget>
>([
  ['trace_id.string', scalar('string', (t: LogTarget) => t.log.traceId ?? '')],
  ['span_id.string', scalar('string', (t: LogTarget) => t.log.spanId ?? '')],
  [
    'time_unix_nano',
    scalar('int', (t: LogTarget) => (t.log.time === null ? 0n : toUnixNanos(t.log.time, t.epoch))),
  ],
  [
    'observed_time_unix_nano',
    scalar('int', (t: LogTarget) =>
      t.log.observedTime === null ? 0n : toUnixNanos(t.log.observedTime, t.epoch),
    ),
  ],
  ['severity_number', scalar('int', (t: LogTarget) => BigInt(t.log.severityNumber))],
  ['severity_text', scalar('string', (t: LogTarget) => t.log.severityText)],
  [
    'body',
    {
      type: 'any',
      get: (t: LogTarget, keys) => descend(t.log.body, keys, 0),
    },
  ],
  ['body.string', scalar('string', (t: LogTarget) => anyValueToDisplay(t.log.body))],
  ['attributes', attributeAccessor((t: LogTarget) => t.log.attributes)],
  ['dropped_attributes_count', scalar('int', (t: LogTarget) => BigInt(t.log.droppedAttributesCount))],
  ['flags', scalar('int', (t: LogTarget) => BigInt(t.log.flags))],
  ['event_name', scalar('string', (t: LogTarget) => t.log.eventName)],
  ...sharedPaths<LogTarget>(),
]);

export const DATAPOINT_PATHS: ReadonlyMap<string, PathAccessor<DatapointTarget>> = new Map<
  string,
  PathAccessor<DatapointTarget>
>([
  ['metric.name', scalar('string', (t: DatapointTarget) => t.point.name)],
  ['metric.description', scalar('string', (t: DatapointTarget) => t.point.description)],
  ['metric.unit', scalar('string', (t: DatapointTarget) => t.point.unit)],
  [
    'start_time_unix_nano',
    scalar('int', (t: DatapointTarget) =>
      t.point.start === null ? 0n : toUnixNanos(t.point.start, t.epoch),
    ),
  ],
  ['time_unix_nano', scalar('int', (t: DatapointTarget) => toUnixNanos(t.point.time, t.epoch))],
  ['attributes', attributeAccessor((t: DatapointTarget) => t.point.attributes)],
  ['flags', scalar('int', (t: DatapointTarget) => BigInt(t.point.flags))],
  ...sharedPaths<DatapointTarget>(),
]);

export interface ContextSpec<C extends OttlContextName> {
  /** Context name, also used in error messages: "expected a span path". */
  readonly name: C;
  /** Optional leading segment accepted on every path (`span.name` == `name`). */
  readonly prefix: string;
  readonly paths: ReadonlyMap<string, PathAccessor<TargetMap[C]>>;
}

export const CONTEXTS: { readonly [C in OttlContextName]: ContextSpec<C> } = {
  span: { name: 'span', prefix: 'span', paths: SPAN_PATHS },
  log_record: { name: 'log_record', prefix: 'log', paths: LOG_PATHS },
  datapoint: { name: 'datapoint', prefix: 'datapoint', paths: DATAPOINT_PATHS },
};

// ---------------------------------------------------------------------------
// Enums (OTLP numeric values)
// ---------------------------------------------------------------------------

function severityEnums(): [string, bigint][] {
  const out: [string, bigint][] = [];
  for (const band of LOG_SEVERITY_KEYS) {
    for (let n = SEVERITY_BANDS[band].min; n <= SEVERITY_BANDS[band].max; n++) {
      out.push([severityEnumName(band, n), BigInt(n)]);
    }
  }
  return out;
}

export const ENUMS: ReadonlyMap<string, bigint> = new Map<string, bigint>([
  ['SPAN_KIND_UNSPECIFIED', 0n],
  ['SPAN_KIND_INTERNAL', 1n],
  ['SPAN_KIND_SERVER', 2n],
  ['SPAN_KIND_CLIENT', 3n],
  ['SPAN_KIND_PRODUCER', 4n],
  ['SPAN_KIND_CONSUMER', 5n],
  ['STATUS_CODE_UNSET', 0n],
  ['STATUS_CODE_OK', 1n],
  ['STATUS_CODE_ERROR', 2n],
  ...severityEnums(),
]);
