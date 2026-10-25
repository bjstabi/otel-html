import type { AnyValue, Attributes } from '../src/model/anyvalue.js';
import { parseSpanId, parseTraceId, type RelNanos, type SpanId } from '../src/model/ids.js';
import type {
  ResourceRecord,
  ResourceRef,
  ScopeRecord,
  ScopeRef,
  SpanEventRecord,
  SpanKind,
  SpanLinkRecord,
  SpanRecord,
  StatusCode,
} from '../src/model/records.js';

/** Builders for OTLP-JSON objects (the wire shape, not protobuf-es messages). */

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type JsonObject = { readonly [k: string]: Json };

export const TRACE_ID = '5b8efff798038103d269b633813fc60c';
export const SPAN_ID = 'eee19b7ec3c1b174';
export const T0 = '1700000000000000000';

export function attr(key: string, value: Json): JsonObject {
  return { key, value };
}

export function span(overrides: JsonObject = {}): JsonObject {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: 'op',
    kind: 1,
    startTimeUnixNano: T0,
    endTimeUnixNano: '1700000000000001000',
    ...overrides,
  };
}

export function traceRequest(
  spans: readonly JsonObject[],
  resourceAttrs: readonly JsonObject[] = [],
): JsonObject {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [{ scope: { name: 'test-scope', version: '1.0.0' }, spans }],
      },
    ],
  };
}

export function logRecord(overrides: JsonObject = {}): JsonObject {
  return {
    timeUnixNano: T0,
    observedTimeUnixNano: T0,
    severityNumber: 9,
    severityText: 'INFO',
    body: { stringValue: 'hello' },
    ...overrides,
  };
}

export function logsRequest(
  logRecords: readonly JsonObject[],
  resourceAttrs: readonly JsonObject[] = [],
): JsonObject {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [{ scope: { name: 'test-scope' }, logRecords }],
      },
    ],
  };
}

export function gauge(name: string, dataPoints: readonly JsonObject[]): JsonObject {
  return { name, unit: '1', gauge: { dataPoints } };
}

export function metricsRequest(
  metrics: readonly JsonObject[],
  resourceAttrs: readonly JsonObject[] = [],
): JsonObject {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [{ scope: { name: 'test-scope' }, metrics }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Normalized-record builders (SpanRecord & friends) for the report-format tests.
// ---------------------------------------------------------------------------------------------

export interface SpanFixture {
  readonly spans: SpanRecord[];
  readonly resources: ResourceRecord[];
  readonly scopes: ScopeRecord[];
}

/** Small deterministic PRNG (mulberry32) so fixtures are stable across runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(rand: () => number, len: number): string {
  let s = '';
  while (s.length < len)
    s += Math.floor(rand() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  const out = s.slice(0, len);
  return /^0+$/.test(out) ? `1${out.slice(1)}` : out;
}

function str(value: string): AnyValue {
  return { kind: 'string', value };
}
function int(value: bigint | number): AnyValue {
  return { kind: 'int', value: BigInt(value) };
}
function attrsOf(entries: readonly (readonly [string, AnyValue])[]): Attributes {
  return new Map(entries);
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(rand() * xs.length)];
  if (x === undefined) throw new Error('pick from empty list');
  return x;
}

const rel = (n: number): RelNanos => n as RelNanos;

/** One attribute value of every AnyValue kind, including the awkward numeric ones. */
function everyKindAttributes(i: number): Attributes {
  return attrsOf([
    ['k.string', str(`value-${i % 7}`)],
    ['k.empty-string', str('')],
    ['k.hostile', str('</script><img src=x onerror=alert(1)> \u2028\u2029 "q" \\ \n')],
    ['k.unicode', str('héllo \u{1F680}')],
    ['k.bool', { kind: 'bool', value: i % 2 === 0 }],
    ['k.int', int(i - 250)],
    ['k.int.big', int(2n ** 62n + BigInt(i))],
    ['k.int.min', int(-(2n ** 63n))],
    ['k.int.max', int(2n ** 63n - 1n)],
    ['k.int.unsafe-edge', int(BigInt(Number.MAX_SAFE_INTEGER) + 1n)],
    ['k.double', { kind: 'double', value: i + 0.5 }],
    ['k.double.whole', { kind: 'double', value: 2 }],
    ['k.double.negzero', { kind: 'double', value: -0 }],
    ['k.double.nan', { kind: 'double', value: Number.NaN }],
    ['k.double.inf', { kind: 'double', value: Number.POSITIVE_INFINITY }],
    ['k.double.ninf', { kind: 'double', value: Number.NEGATIVE_INFINITY }],
    ['k.double.huge', { kind: 'double', value: 1e300 }],
    ['k.bytes', { kind: 'bytes', value: new Uint8Array([0, 1, 2, 253, 254, 255, i % 256]) }],
    ['k.bytes.empty', { kind: 'bytes', value: new Uint8Array(0) }],
    ['k.empty', { kind: 'empty' }],
    [
      'k.array',
      {
        kind: 'array',
        values: [str('a'), int(1), { kind: 'array', values: [] }, { kind: 'empty' }, int(2n ** 60n)],
      },
    ],
    [
      'k.kvlist',
      {
        kind: 'kvlist',
        values: attrsOf([
          ['inner', str('x')],
          ['nested', { kind: 'kvlist', values: attrsOf([['deep', { kind: 'double', value: 0.25 }]]) }],
        ]),
      },
    ],
  ]);
}

/**
 * `n` spans covering every AnyValue kind, events, links, orphans (parent never arrives), negative
 * RelNanos, and RelNanos at the +/- 2^53 extremes. Resources and scopes are referenced in first-use
 * order so a per-chunk renumbering is the identity.
 */
export function sampleSpans(n: number): SpanFixture {
  const rand = prng(42);
  const resources: ResourceRecord[] = [0, 1, 2].map((i) => ({
    attributes: attrsOf([
      ['service.name', str(`svc-${i}`)],
      ['process.pid', int(1000 + i)],
    ]),
    droppedAttributesCount: i,
    schemaUrl: i === 0 ? '' : 'https://opentelemetry.io/schemas/1.27.0',
  }));
  const scopes: ScopeRecord[] = [0, 1].map((i) => ({
    name: `scope-${i}`,
    version: `1.${i}.0`,
    attributes: i === 0 ? new Map() : attrsOf([['scope.attr', str('s')]]),
    droppedAttributesCount: 0,
    schemaUrl: '',
  }));
  const traceCount = Math.max(1, Math.floor(n / 5));
  const traceIds = Array.from({ length: traceCount }, () => parseTraceId(hex(rand, 32), 'sample'));
  const known: SpanId[] = [];
  const spans: SpanRecord[] = [];
  for (let i = 0; i < n; i++) {
    const spanId = parseSpanId(hex(rand, 16), 'sample');
    const orphan = i % 17 === 5;
    const parentSpanId: SpanId | null =
      i % 4 === 0 ? null : orphan ? parseSpanId(hex(rand, 16), 'sample') : (known[known.length - 1] ?? null);
    known.push(spanId);
    let start = (i - 20) * 1_000_003; // starts negative: before the epoch
    let end = start + Math.floor(rand() * 5_000_000);
    if (i === 3) {
      start = -Number.MAX_SAFE_INTEGER;
      end = Number.MAX_SAFE_INTEGER;
    }
    if (i === 4) {
      start = Number.MAX_SAFE_INTEGER;
      end = Number.MAX_SAFE_INTEGER;
    }
    const events: SpanEventRecord[] =
      i % 3 === 0
        ? [
            {
              time: rel(start + 10),
              name: 'exception',
              attributes: attrsOf([
                ['exception.type', str('Error')],
                ['exception.big', int(2n ** 55n)],
              ]),
              droppedAttributesCount: 1,
            },
            { time: rel(start - 5), name: 'before', attributes: new Map(), droppedAttributesCount: 0 },
          ]
        : [];
    const links: SpanLinkRecord[] =
      i % 5 === 0
        ? [
            {
              traceId: pick(rand, traceIds),
              spanId: parseSpanId(hex(rand, 16), 'sample'),
              traceState: 'a=b',
              attributes: attrsOf([['link.k', { kind: 'bytes', value: new Uint8Array([9, 8]) }]]),
              droppedAttributesCount: 2,
              flags: 257,
            },
          ]
        : [];
    spans.push({
      traceId: traceIds[i % traceCount] ?? parseTraceId(hex(rand, 32), 'sample'),
      spanId,
      parentSpanId,
      traceState: i % 6 === 0 ? 'vendor=1,other=2' : '',
      flags: i % 2 === 0 ? 0 : 256,
      name: `GET /thing/${i % 9}`,
      kind: ((i % 5) + 1) as SpanKind,
      start: rel(start),
      end: rel(end),
      attributes: i === 1 ? new Map() : everyKindAttributes(i),
      droppedAttributesCount: i % 3,
      events,
      droppedEventsCount: events.length > 0 ? 1 : 0,
      links,
      droppedLinksCount: links.length > 0 ? 3 : 0,
      status:
        i % 7 === 0
          ? { code: 2 as StatusCode, message: `failed <${i}>` }
          : { code: 0 as StatusCode, message: '' },
      resource: (i < 3 ? i : Math.floor(rand() * 3)) as ResourceRef,
      scope: Math.min(i, 1) as ScopeRef,
    });
  }
  const used = new Set(spans.map((s) => s.resource));
  const usedScopes = new Set(spans.map((s) => s.scope));
  return {
    spans,
    resources: resources.filter((_, i) => used.has(i as ResourceRef)),
    scopes: scopes.filter((_, i) => usedScopes.has(i as ScopeRef)),
  };
}

const SERVICES = [
  'frontend',
  'checkout',
  'cart',
  'payments',
  'inventory',
  'shipping',
  'recommendations',
  'auth',
] as const;
const ROUTES = [
  '/api/cart',
  '/api/checkout',
  '/api/products/{id}',
  '/api/orders/{id}',
  '/api/users/me',
  '/api/search',
  '/healthz',
  '/api/recommendations',
] as const;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const STATUSES = [200, 200, 200, 200, 201, 204, 301, 400, 404, 500] as const;
const DB_STATEMENTS = Array.from(
  { length: 40 },
  (_, i) => `SELECT id, name, price FROM products WHERE category_id = $1 AND region = $2 LIMIT ${10 + i}`,
);
const ERROR_MESSAGES = [
  'connection reset by peer',
  'deadline exceeded',
  'upstream returned 503',
  'invalid argument: quantity',
] as const;
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'okhttp/4.12.0',
  'python-requests/2.32.3',
] as const;

/**
 * `n` realistic spans: 8 services, ~12 attributes per span drawn from HTTP/DB/RPC semantic conventions,
 * 5% errors, one event per 10 spans. Traces are ~8 spans deep; times ascend like a live feed.
 */
export function realisticSpans(n: number): SpanFixture {
  const rand = prng(7);
  const resources: ResourceRecord[] = SERVICES.map((name, i) => ({
    attributes: attrsOf([
      ['service.name', str(name)],
      ['service.version', str(`2.${i}.1`)],
      ['service.instance.id', str(`${name}-7d9f${i}c5b-x${i}k2p`)],
      ['deployment.environment.name', str('production')],
      ['host.name', str(`node-${i}.internal`)],
      ['telemetry.sdk.language', str('nodejs')],
      ['telemetry.sdk.name', str('opentelemetry')],
      ['telemetry.sdk.version', str('2.12.0')],
    ]),
    droppedAttributesCount: 0,
    schemaUrl: '',
  }));
  const scopes: ScopeRecord[] = [
    {
      name: '@opentelemetry/instrumentation-http',
      version: '0.300.0',
      attributes: new Map(),
      droppedAttributesCount: 0,
      schemaUrl: '',
    },
  ];
  const spans: SpanRecord[] = [];
  let clock = 0;
  let traceId = parseTraceId(hex(rand, 32), 'realistic');
  let prev: SpanId | null = null;
  for (let i = 0; i < n; i++) {
    if (i % 8 === 0) {
      traceId = parseTraceId(hex(rand, 32), 'realistic');
      prev = null;
    }
    clock += 100_000 + Math.floor(rand() * 900_000);
    const dur = 200_000 + Math.floor(rand() * 40_000_000);
    const svc = i % SERVICES.length;
    const flavor = i % 3;
    const error = rand() < 0.05;
    const status = pick(rand, STATUSES);
    const route = pick(rand, ROUTES);
    const method = pick(rand, METHODS);
    const entries: [string, AnyValue][] = [
      ['server.address', str(`${pick(rand, SERVICES)}.internal`)],
      ['server.port', int(pick(rand, [8080, 5432, 50051] as const))],
      ['network.protocol.version', str(flavor === 2 ? '2' : '1.1')],
    ];
    let name: string;
    let kind: SpanKind;
    if (flavor === 0) {
      name = `${method} ${route}`;
      kind = 2 as SpanKind;
      entries.push(
        ['http.request.method', str(method)],
        ['http.route', str(route)],
        ['url.path', str(route.replace('{id}', String(Math.floor(rand() * 20))))],
        ['url.scheme', str('https')],
        ['http.response.status_code', int(error ? 500 : status)],
        ['user_agent.original', str(pick(rand, USER_AGENTS))],
        ['client.address', str(`10.0.${Math.floor(rand() * 4)}.${Math.floor(rand() * 20)}`)],
        ['http.response.body.size', int(Math.floor(rand() * 8192))],
        ['enduser.id', str(`user-${Math.floor(rand() * 500)}`)],
      );
    } else if (flavor === 1) {
      name = 'SELECT products';
      kind = 3 as SpanKind;
      entries.push(
        ['db.system.name', str('postgresql')],
        ['db.namespace', str('shop')],
        ['db.operation.name', str('SELECT')],
        ['db.collection.name', str('products')],
        ['db.query.text', str(pick(rand, DB_STATEMENTS))],
        ['db.response.returned_rows', int(Math.floor(rand() * 30))],
        ['network.peer.address', str(`10.1.0.${Math.floor(rand() * 6)}`)],
        ['network.peer.port', int(5432)],
        ['thread.id', int(Math.floor(rand() * 16))],
      );
    } else {
      name = 'oteldemo.CartService/GetCart';
      kind = 3 as SpanKind;
      entries.push(
        ['rpc.system', str('grpc')],
        ['rpc.service', str('oteldemo.CartService')],
        ['rpc.method', str('GetCart')],
        ['rpc.grpc.status_code', int(error ? 14 : 0)],
        ['network.transport', str('tcp')],
        ['network.peer.address', str(`10.2.0.${Math.floor(rand() * 6)}`)],
        ['network.peer.port', int(50051)],
        ['thread.id', int(Math.floor(rand() * 16))],
        ['rpc.request.size', int(Math.floor(rand() * 512))],
      );
    }
    const spanId = parseSpanId(hex(rand, 16), 'realistic');
    const events: SpanEventRecord[] =
      i % 10 === 0
        ? [
            {
              time: rel(clock + 1000),
              name: 'exception',
              attributes: attrsOf([
                ['exception.type', str('Error')],
                ['exception.message', str(pick(rand, ERROR_MESSAGES))],
              ]),
              droppedAttributesCount: 0,
            },
          ]
        : [];
    spans.push({
      traceId,
      spanId,
      parentSpanId: prev,
      traceState: '',
      flags: 256,
      name,
      kind,
      start: rel(clock),
      end: rel(clock + dur),
      attributes: attrsOf(entries),
      droppedAttributesCount: 0,
      events,
      droppedEventsCount: 0,
      links: [],
      droppedLinksCount: 0,
      status: error
        ? { code: 2 as StatusCode, message: pick(rand, ERROR_MESSAGES) }
        : { code: 0 as StatusCode, message: '' },
      resource: svc as ResourceRef,
      scope: 0 as ScopeRef,
    });
    prev = spanId;
  }
  return { spans, resources, scopes };
}
