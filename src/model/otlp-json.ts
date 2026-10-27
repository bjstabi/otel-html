import { type DescMessage, fromJson, type JsonValue, type MessageShape } from '@bufbuild/protobuf';
import { OtelHtmlError } from './errors.js';
import {
  type ExportLogsServiceRequest,
  ExportLogsServiceRequestSchema,
} from './gen/opentelemetry/proto/collector/logs/v1/logs_service_pb.js';
import {
  type ExportMetricsServiceRequest,
  ExportMetricsServiceRequestSchema,
} from './gen/opentelemetry/proto/collector/metrics/v1/metrics_service_pb.js';
import {
  type ExportTraceServiceRequest,
  ExportTraceServiceRequestSchema,
} from './gen/opentelemetry/proto/collector/trace/v1/trace_service_pb.js';

export type OtlpRequest =
  | { readonly signal: 'traces'; readonly request: ExportTraceServiceRequest }
  | { readonly signal: 'logs'; readonly request: ExportLogsServiceRequest }
  | { readonly signal: 'metrics'; readonly request: ExportMetricsServiceRequest };

export type OtlpSignal = OtlpRequest['signal'];

/**
 * OTLP-JSON field names whose protobuf type is a 64-bit integer (or a repeated one). OTLP JSON allows these
 * as numbers or strings; numbers beyond 2^53 are only exact if read from the source text, so they are
 * rewritten to strings before protobuf-es sees them.
 */
const INT64_FIELDS: ReadonlySet<string> = new Set([
  'timeUnixNano',
  'startTimeUnixNano',
  'endTimeUnixNano',
  'observedTimeUnixNano',
  'asInt',
  'intValue',
  'count',
  'zeroCount',
  'bucketCounts',
]);

/** Fields holding hex-encoded ids in OTLP JSON (protobuf-es wants base64 for bytes). */
const ID_FIELD_LENGTHS: ReadonlyMap<string, number> = new Map([
  ['traceId', 32],
  ['spanId', 16],
  ['parentSpanId', 16],
]);

export interface SignalEntry {
  readonly signal: OtlpSignal;
  readonly key: string;
  readonly schema: DescMessage;
}

const SIGNALS: readonly SignalEntry[] = [
  { signal: 'traces', key: 'resourceSpans', schema: ExportTraceServiceRequestSchema },
  { signal: 'logs', key: 'resourceLogs', schema: ExportLogsServiceRequestSchema },
  { signal: 'metrics', key: 'resourceMetrics', schema: ExportMetricsServiceRequestSchema },
];

/** The signal whose resource array a top-level OTLP-JSON key holds, if any. */
export function signalEntry(key: string): SignalEntry | undefined {
  return SIGNALS.find((s) => s.key === key);
}

/** A JSON number that is not a safe integer, kept with its exact source text. */
class UnsafeNumber {
  readonly value: number;
  readonly source: string;
  constructor(value: number, source: string) {
    this.value = value;
    this.source = source;
  }
}

type RevivedContext = { readonly source?: string };

class MissingSourceText extends Error {}

function reviveNumbers(_key: string, value: unknown, context?: RevivedContext): unknown {
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    // Without the source text a large int64 would silently lose precision, so refuse to continue.
    if (context?.source === undefined) {
      throw new MissingSourceText(
        'integer beyond 2^53 cannot be read exactly: this JavaScript runtime does not expose JSON source text to reviver functions (Node 24+ does)',
      );
    }
    return new UnsafeNumber(value, context.source);
  }
  return value;
}

function hexToBase64(hex: string): string {
  let bin = '';
  for (let i = 0; i < hex.length; i += 2)
    bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function fail(source: string, path: string, expected: string, actual: string): never {
  throw new OtelHtmlError('invalid-otlp', { path: `${source}: ${path}`, expected, actual });
}

function convertField(key: string, value: unknown, path: string, source: string): unknown {
  const idLen = ID_FIELD_LENGTHS.get(key);
  if (idLen !== undefined && typeof value === 'string') {
    if (value === '') return value;
    if (value.length !== idLen || !/^[0-9a-fA-F]+$/.test(value)) {
      fail(source, path, `${idLen} hex chars`, JSON.stringify(value));
    }
    return hexToBase64(value);
  }
  if (INT64_FIELDS.has(key)) {
    const exact = (v: unknown, at: string): unknown => {
      if (v instanceof UnsafeNumber) return v.source;
      if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) {
        // Only reachable for already-parsed objects: the exact digits are gone.
        fail(source, at, 'an exact integer (pass 64-bit values as strings)', String(v));
      }
      return v;
    };
    if (Array.isArray(value)) return value.map((v, i) => exact(v, `${path}[${i}]`));
    return exact(value, path);
  }
  return convertTree(value, path, source);
}

/** Rebuilds the parsed tree: int64 source text for int64 fields, hex ids to base64, plain numbers elsewhere. */
function convertTree(value: unknown, path: string, source: string): unknown {
  if (value instanceof UnsafeNumber) return value.value;
  if (Array.isArray(value)) return value.map((v, i) => convertTree(v, `${path}[${i}]`, source));
  if (typeof value === 'object' && value !== null) {
    // Object.fromEntries defines own properties, so a "__proto__" key stays inert data.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        convertField(k, v, path === '' ? k : `${path}.${k}`, source),
      ]),
    );
  }
  return value;
}

/** `where` (optional) follows "invalid JSON" in the message, to place a slice of a larger text. */
export function parseJsonText(text: string, source: string, where = ''): unknown {
  try {
    return JSON.parse(text, reviveNumbers);
  } catch (e) {
    throw new OtelHtmlError('invalid-otlp', {
      message: `${source}: ${e instanceof MissingSourceText ? e.message : `invalid JSON${where}: ${e instanceof Error ? e.message : String(e)}`}`,
    });
  }
}

export function parseOtlpJson(text: string, source: string): OtlpRequest[] {
  return parseOtlpObject(parseJsonText(text, source), source);
}

/**
 * Reads an already-parsed OTLP-JSON object. Same rules as `parseOtlpJson`, except that numbers beyond 2^53
 * in int64 fields are rejected (their digits are already lost); pass such values as strings.
 */
export function parseOtlpObject(root: unknown, source: string): OtlpRequest[] {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new OtelHtmlError('invalid-otlp', {
      message: `${source}: expected a JSON object, got ${describe(root)}`,
    });
  }
  const out: OtlpRequest[] = [];
  for (const entry of SIGNALS) {
    if (!Object.hasOwn(root, entry.key)) continue;
    const entries = new Map(Object.entries(root));
    const raw = entries.get(entry.key);
    if (!Array.isArray(raw)) fail(source, entry.key, 'array', describe(raw));
    out.push(requestOf(entry, raw, 0, source));
  }
  if (out.length === 0) throw noSignal(source);
  return out;
}

/**
 * The request of one signal holding the parsed resource entries `items`, the first of which is element `first` of
 * the signal's array in its file (for error paths). A lone entry's path also prefixes protobuf-es errors.
 */
export function requestOf(
  entry: SignalEntry,
  items: readonly unknown[],
  first: number,
  source: string,
): OtlpRequest {
  const { signal, key, schema } = entry;
  const resources = items.map((v, i) => convertTree(v, `${key}[${first + i}]`, source));
  const at = items.length === 1 ? `${key}[${first}]: ` : '';
  try {
    const request: MessageShape<typeof schema> = fromJson(schema, { [key]: resources } as JsonValue, {
      ignoreUnknownFields: true,
    });
    return { signal, request } as OtlpRequest;
  } catch (e) {
    throw new OtelHtmlError('invalid-otlp', {
      message: `${source}: ${at}${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

export function noSignal(source: string): OtelHtmlError {
  return new OtelHtmlError('invalid-otlp', {
    message: `${source}: expected at least one of resourceSpans, resourceLogs or resourceMetrics`,
  });
}
