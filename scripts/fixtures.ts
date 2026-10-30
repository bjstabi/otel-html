// Regenerates the committed OTLP/JSON fixtures in fixtures/ with the OpenTelemetry SDK.
// Output is byte-stable: seeded PRNG and ID generator, fixed start time, no wall-clock reads.
// fixtures/hostile.otlp.json is hand-authored and is only checked for presence here, never rewritten.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  type AnyValue,
  type HrTime,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  JsonLogsSerializer,
  JsonMetricsSerializer,
  JsonTraceSerializer,
} from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  AggregationType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  HOSTILE_METRIC_ATTR,
  HOSTILE_METRIC_ATTR_VALUE,
  HOSTILE_METRIC_NAME,
  HOSTILE_METRIC_UNIT,
  LINKED_SPAN,
  LINKED_TRACE,
  METRIC_HIST,
  ORPHAN_EXEMPLAR_TRACE,
} from '../test-support/fixture-ids.js';

const OUT = new URL('../fixtures/', import.meta.url);
/** 2023-11-14T22:13:20Z, the same fixed instant the e2e inputs use. */
const T0_SECONDS = 1_700_000_000;

/** mulberry32: a tiny seeded PRNG. */
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

function seededIds(rand: () => number): { generateTraceId(): string; generateSpanId(): string } {
  const hex = (bytes: number): string => {
    let out = '';
    for (let i = 0; i < bytes; i++)
      out += Math.floor(rand() * 256)
        .toString(16)
        .padStart(2, '0');
    // An all-zero id is invalid.
    return /^0+$/.test(out) ? `${out.slice(0, -1)}1` : out;
  };
  return { generateTraceId: () => hex(16), generateSpanId: () => hex(8) };
}

function hr(offsetNs: number): HrTime {
  const total = BigInt(T0_SECONDS) * 1_000_000_000n + BigInt(Math.round(offsetNs));
  return [Number(total / 1_000_000_000n), Number(total % 1_000_000_000n)];
}

function write(name: string, body: string): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL(`${name}.otlp.json`, OUT), body);
  process.stdout.write(`fixtures/${name}.otlp.json  ${body.length} bytes\n`);
}

function serializeSpans(spans: readonly ReadableSpan[]): string {
  const bytes = JsonTraceSerializer.serializeRequest([...spans]);
  if (bytes === undefined) throw new Error('JsonTraceSerializer returned nothing');
  return new TextDecoder().decode(bytes);
}

const SERVICES = [
  'frontend',
  'gateway',
  'auth',
  'orders',
  'inventory',
  'payments',
  'notifications',
  'db-proxy',
] as const;
type ServiceName = (typeof SERVICES)[number];

interface Sim {
  rand: () => number;
  exporter: InMemorySpanExporter;
  tracers: Record<ServiceName, ReturnType<BasicTracerProvider['getTracer']>>;
  /** Spans started so far, in start order, for links. */
  started: Span[];
}

function makeSim(seed: number): Sim {
  const rand = prng(seed);
  const exporter = new InMemorySpanExporter();
  const ids = seededIds(rand);
  const tracers = Object.fromEntries(
    SERVICES.map((service) => {
      const provider = new BasicTracerProvider({
        idGenerator: ids,
        resource: resourceFromAttributes({
          'service.name': service,
          'service.version': '1.4.2',
          'service.instance.id': `${service}-0`,
          'deployment.environment.name': 'production',
          'telemetry.sdk.language': 'nodejs',
        }),
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      return [service, provider.getTracer(`${service}.instrumentation`, '1.0.0')];
    }),
  ) as Sim['tracers'];
  return { rand, exporter, tracers, started: [] };
}

interface Node {
  service: ServiceName;
  name: string;
  kind: SpanKind;
  attrs: Record<string, string | number | boolean>;
  /** Own duration in ms before children are accounted for. */
  ms: number;
  children?: Node[];
}

function httpServer(service: ServiceName, route: string, children: Node[] = [], ms = 4): Node {
  return {
    service,
    name: `GET ${route}`,
    kind: SpanKind.SERVER,
    attrs: {
      'http.request.method': 'GET',
      'http.route': route,
      'url.path': route,
      'url.scheme': 'https',
      'http.response.status_code': 200,
      'server.address': `${service}.internal`,
    },
    ms,
    children,
  };
}

function httpClient(service: ServiceName, target: ServiceName, route: string, children: Node[]): Node {
  return {
    service,
    name: `GET ${target}`,
    kind: SpanKind.CLIENT,
    attrs: {
      'http.request.method': 'GET',
      'url.full': `https://${target}.internal${route}`,
      'server.address': `${target}.internal`,
      'server.port': 443,
      'http.response.status_code': 200,
    },
    ms: 1,
    children,
  };
}

function rpc(service: ServiceName, target: ServiceName, method: string, children: Node[]): Node[] {
  return [
    {
      service,
      name: `${target}.Service/${method}`,
      kind: SpanKind.CLIENT,
      attrs: { 'rpc.system': 'grpc', 'rpc.service': `${target}.Service`, 'rpc.method': method },
      ms: 1,
      children: [
        {
          service: target,
          name: `${target}.Service/${method}`,
          kind: SpanKind.SERVER,
          attrs: {
            'rpc.system': 'grpc',
            'rpc.service': `${target}.Service`,
            'rpc.method': method,
            'rpc.grpc.status_code': 0,
          },
          ms: 2,
          children,
        },
      ],
    },
  ];
}

function db(service: ServiceName, operation: string, table: string, ms: number): Node {
  return {
    service,
    name: `${operation} ${table}`,
    kind: SpanKind.CLIENT,
    attrs: {
      'db.system.name': 'postgresql',
      'db.namespace': 'shop',
      'db.operation.name': operation,
      'db.collection.name': table,
      'db.query.text': `${operation} * FROM ${table} WHERE id = $1`,
      'server.address': 'db-proxy.internal',
    },
    ms,
  };
}

function checkoutTree(rand: () => number): Node {
  const routes = ['/checkout', '/cart', '/orders', '/search'];
  const route = routes[Math.floor(rand() * routes.length)] ?? '/checkout';
  const ordersWork: Node[] = [
    db('orders', 'SELECT', 'orders', 3 + rand() * 8),
    ...rpc('orders', 'inventory', 'Reserve', [db('inventory', 'UPDATE', 'stock', 2 + rand() * 6)]),
  ];
  if (rand() < 0.6) {
    ordersWork.push(
      ...rpc('orders', 'payments', 'Charge', [
        db('payments', 'INSERT', 'charges', 4 + rand() * 9),
        { ...httpClient('payments', 'db-proxy', '/ping', [httpServer('db-proxy', '/ping', [], 2)]), ms: 2 },
      ]),
    );
  }
  if (rand() < 0.3) {
    ordersWork.push({
      service: 'notifications',
      name: 'orders publish',
      kind: SpanKind.PRODUCER,
      attrs: {
        'messaging.system': 'kafka',
        'messaging.destination.name': 'orders',
        'messaging.operation.type': 'send',
      },
      ms: 1 + rand() * 2,
    });
  }
  return httpServer('frontend', route, [
    httpClient('frontend', 'gateway', route, [
      httpServer('gateway', route, [
        ...rpc('gateway', 'auth', 'Verify', [db('auth', 'SELECT', 'sessions', 1 + rand() * 3)]),
        httpClient('gateway', 'orders', route, [httpServer('orders', route, ordersWork, 3)]),
      ]),
    ]),
  ]);
}

/** Starts the tree depth-first (children inside the parent's window) and returns the spans in start order. */
function emit(sim: Sim, node: Node, parent: Span | undefined, startNs: number, fail: boolean): number {
  const tracer = sim.tracers[node.service];
  const ctx = parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent);
  const links =
    sim.started.length > 40 && node.kind === SpanKind.SERVER && sim.rand() < 0.04
      ? [{ context: (sim.started[Math.floor(sim.rand() * (sim.started.length - 20))] as Span).spanContext() }]
      : undefined;
  const span = tracer.startSpan(
    node.name,
    {
      kind: node.kind,
      startTime: hr(startNs),
      attributes: node.attrs,
      ...(links === undefined ? {} : { links }),
    },
    ctx,
  );
  sim.started.push(span);
  let cursor = startNs + node.ms * 0.4 * 1e6;
  for (const child of node.children ?? []) {
    const childFail = fail && child === node.children?.[node.children.length - 1];
    cursor = emit(sim, child, span, cursor + 0.1e6, childFail) + 0.1e6;
  }
  const end = cursor + node.ms * 0.6 * 1e6;
  const leaf = node.children === undefined || node.children.length === 0;
  if (leaf && (fail || sim.rand() < 0.035)) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'upstream failure' });
    span.recordException(
      {
        name: 'TimeoutError',
        message: `${node.name} timed out after 5000ms`,
        stack: `TimeoutError: ${node.name} timed out after 5000ms\n    at call (/app/src/client.js:42:11)\n    at async handler (/app/src/handler.js:17:5)`,
      },
      hr(end - 0.2e6),
    );
    span.addEvent('retry', { 'retry.attempt': 1 }, hr(end - 0.4e6));
  } else if (fail) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'upstream failure' });
    span.setAttribute('error.type', '500');
  }
  span.end(hr(end));
  return end;
}

function buildSmall(): string {
  const sim = makeSim(0x5eed01);
  let t = 0;
  // About 15 spans per trace over 80 traces for roughly 1.2k spans; a few failing traces plus scattered leaf errors give about 5% error spans.
  for (let i = 0; i < 80; i++) {
    const fail = sim.rand() < 0.03 || i % 30 === 7;
    t = emit(sim, checkoutTree(sim.rand), undefined, t + 2e6 + sim.rand() * 30e6, fail) - 20e6;
  }
  return serializeSpans(sim.exporter.getFinishedSpans());
}

function buildOrphans(): string {
  const sim = makeSim(0x0c0ffee);
  let t = 0;
  for (let i = 0; i < 6; i++) {
    t = emit(sim, checkoutTree(sim.rand), undefined, t + 5e6, false);
  }
  const spans = sim.exporter.getFinishedSpans();
  // Drop the roots of the first four traces, and one mid-tree span in the fifth, so children lose their parents.
  const dropped = new Set<string>();
  const seen = new Set<string>();
  for (const s of spans) {
    const trace = s.spanContext().traceId;
    if (s.parentSpanContext === undefined && seen.size < 4 && !seen.has(trace)) {
      seen.add(trace);
      dropped.add(s.spanContext().spanId);
    }
  }
  const fifth = spans.filter((s) => s.parentSpanContext !== undefined && s.name.startsWith('GET gateway'));
  const mid = fifth[4];
  if (mid !== undefined) dropped.add(mid.spanContext().spanId);
  return serializeSpans(spans.filter((s) => !dropped.has(s.spanContext().spanId)));
}

async function buildLogsOnly(): Promise<string> {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'batch-worker', 'service.version': '2.0.1' }),
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  const logger = provider.getLogger('batch-worker.logger', '1.0.0');
  const levels = [
    { n: 9, text: 'INFO', msg: 'processed batch' },
    { n: 13, text: 'WARN', msg: 'slow batch' },
    { n: 17, text: 'ERROR', msg: 'batch failed' },
  ] as const;
  for (let i = 0; i < 12; i++) {
    const level = levels[i % 3 === 2 ? 2 : i % 3] ?? levels[0];
    const at = hr(i * 250e6);
    logger.emit({
      timestamp: at,
      observedTimestamp: at,
      severityNumber: level.n,
      severityText: level.text,
      body: `${level.msg} ${i}`,
      attributes: { 'batch.id': i, 'batch.size': 100 + i },
    });
  }
  await provider.forceFlush();
  const bytes = JsonLogsSerializer.serializeRequest(exporter.getFinishedLogRecords());
  if (bytes === undefined) throw new Error('JsonLogsSerializer returned nothing');
  return new TextDecoder().decode(bytes);
}

const LINKED_SEED = 0x11ced;

type LogContext = { span: Span } | 'none' | 'orphan' | 'dangling';
interface LinkedLog {
  service: 'checkout' | 'payments';
  ctx: LogContext;
  n: number;
  text: string;
  body: AnyValue;
  attrs?: Record<string, string | number | boolean>;
  eventName?: string;
  /** Emit with only `observedTimestamp`. */
  observedOnly?: boolean;
}

/** Marks a record to emit with only `observedTimestamp`; removed again when the SDK output is post-processed. */
const OBSERVED_ONLY_MARK = 'otel_html.fixture.observed_only';

interface OtlpLogsFile {
  resourceLogs: {
    scopeLogs: { logRecords: { timeUnixNano?: string; attributes?: { key: string }[] }[] }[];
  }[];
}

/**
 * The SDK stamps a missing `timestamp` with the wall clock; drop it again on the marked records so they carry only
 * `observedTimeUnixNano`, and drop the mark. Keyed by the mark, not the body, so another log with the same body keeps
 * its time.
 */
function stripWallClockTimestamps(json: string): string {
  const file = JSON.parse(json) as OtlpLogsFile;
  for (const rl of file.resourceLogs)
    for (const sl of rl.scopeLogs)
      for (const record of sl.logRecords) {
        const attrs = record.attributes ?? [];
        if (!attrs.some((a) => a.key === OBSERVED_ONLY_MARK)) continue;
        delete record.timeUnixNano;
        record.attributes = attrs.filter((a) => a.key !== OBSERVED_ONLY_MARK);
      }
  return JSON.stringify(file);
}

/** Three traces over `checkout` (runner-7) and `payments` (runner-8), and 40 logs linked to them in the ways the logs explorer must handle. */
async function buildLinked(): Promise<{ traces: string; logs: string }> {
  const rand = prng(LINKED_SEED);
  const ids = seededIds(rand);
  const spanExporter = new InMemorySpanExporter();
  const strayExporter = new InMemorySpanExporter();
  const resourceOf = (service: string, host: string) =>
    resourceFromAttributes({
      'service.name': service,
      'service.version': '3.1.0',
      'host.name': host,
      'deployment.environment.name': 'production',
    });
  const resources = {
    checkout: resourceOf('checkout', 'runner-7'),
    payments: resourceOf('payments', 'runner-8'),
  } as const;
  const tracer = (service: keyof typeof resources, exporter: InMemorySpanExporter) =>
    new BasicTracerProvider({
      idGenerator: ids,
      resource: resources[service],
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }).getTracer(`${service}.instrumentation`, '1.0.0');
  const checkout = tracer('checkout', spanExporter);
  const payments = tracer('payments', spanExporter);
  const stray = tracer('payments', strayExporter);

  const open = (
    t: ReturnType<typeof tracer>,
    name: string,
    kind: SpanKind,
    parent: Span | undefined,
    startMs: number,
    endMs: number,
    fail = false,
  ): { span: Span; end(): void } => {
    const ctx = parent === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, parent);
    const span = t.startSpan(name, { kind, startTime: hr(startMs * 1e6) }, ctx);
    return {
      span,
      end: () => {
        if (fail) span.setStatus({ code: SpanStatusCode.ERROR, message: 'upstream failure' });
        span.end(hr(endMs * 1e6));
      },
    };
  };

  // Trace 1 (LINKED_TRACE): a successful-looking checkout whose payments span retries a declined card.
  const c1 = open(checkout, 'POST /checkout', SpanKind.SERVER, undefined, 0, 900);
  const c2 = open(checkout, 'inventory reserve', SpanKind.INTERNAL, c1.span, 20, 90);
  const p1 = open(payments, 'payments.Charge', SpanKind.SERVER, c1.span, 100, 800);
  const p2 = open(payments, 'INSERT charges', SpanKind.CLIENT, p1.span, 150, 200);
  // Trace 2: a cart read.
  const c3 = open(checkout, 'GET /cart', SpanKind.SERVER, undefined, 2000, 2300);
  const c4 = open(checkout, 'cart.load', SpanKind.INTERNAL, c3.span, 2010, 2100);
  const p3 = open(payments, 'payments.Quote', SpanKind.SERVER, c3.span, 2110, 2250);
  // Trace 3: a checkout that fails after retries.
  const c5 = open(checkout, 'POST /checkout', SpanKind.SERVER, undefined, 4000, 5200, true);
  const p4 = open(payments, 'payments.Charge', SpanKind.SERVER, c5.span, 4100, 5100, true);
  const p5 = open(payments, 'INSERT charges', SpanKind.CLIENT, p4.span, 4150, 4300, true);
  // A fourth trace that is never exported: its logs are the orphan.
  const lost = open(stray, 'payments.Callback', SpanKind.SERVER, undefined, 6000, 6100);

  const danglingContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: c1.span.spanContext().traceId,
    spanId: 'deadbeefdeadbeef',
    traceFlags: 1,
  });

  const declined = (code: string): string => `card declined: 402 decline_code=${code}`;
  const retry = (ms: number, k: number): string => `retrying charge in ${ms}ms (attempt ${k}/3)`;
  const entries: [number, LinkedLog][] = [];
  const at = (ms: number, log: LinkedLog): void => void entries.push([ms, log]);

  // No trace context (5).
  at(1, { service: 'checkout', ctx: 'none', n: 1, text: 'TRACE', body: 'gc pause 3ms' });
  at(2, {
    service: 'checkout',
    ctx: 'none',
    n: 5,
    text: 'DEBUG',
    body: 'config reloaded from /etc/checkout.yaml',
  });
  at(3, { service: 'payments', ctx: 'none', n: 9, text: 'INFO', body: 'worker heartbeat' });
  at(4, { service: 'payments', ctx: 'none', n: 13, text: 'WARN', body: 'disk usage at 91%' });
  at(5, { service: 'checkout', ctx: 'none', n: 0, text: '', body: 'unclassified startup banner' });
  // Trace id absent from the traces file (1), and a span_id that is not in its trace (1).
  at(6100, {
    service: 'payments',
    ctx: 'orphan',
    n: 17,
    text: 'ERROR',
    body: 'late callback for unknown trace',
  });
  at(850, {
    service: 'checkout',
    ctx: 'dangling',
    n: 13,
    text: 'WARN',
    body: 'span context lost: parent span unknown',
  });
  // Trace 1.
  at(5, {
    service: 'checkout',
    ctx: { span: c1.span },
    n: 9,
    text: 'INFO',
    body: { payment: { amount: 4200, currency: 'usd', card: { brand: 'visa', last4: '4242' } } },
  });
  at(8, {
    service: 'checkout',
    ctx: { span: c1.span },
    n: 9,
    text: 'INFO',
    body: 'charge result={"ok":false,"retryable":true} order_id=ord-1001 user=u-77 duration_ms=213',
  });
  at(10, {
    service: 'checkout',
    ctx: { span: c1.span },
    n: 5,
    text: 'DEBUG',
    body: 'cache miss key=cart:77',
  });
  at(11, { service: 'checkout', ctx: { span: c1.span }, n: 1, text: 'TRACE', body: 'entering handler' });
  at(12, {
    service: 'checkout',
    ctx: { span: c1.span },
    n: 9,
    text: 'INFO',
    body: 'checkout started',
    eventName: 'checkout.started',
  });
  at(14, {
    service: 'checkout',
    ctx: { span: c1.span },
    n: 9,
    text: 'INFO',
    body: 'request accepted',
    observedOnly: true,
  });
  at(30, {
    service: 'checkout',
    ctx: { span: c2.span },
    n: 5,
    text: 'DEBUG',
    body: 'reserve sku=sku-1 qty=2',
  });
  at(40, {
    service: 'checkout',
    ctx: { span: c2.span },
    n: 5,
    text: 'DEBUG',
    body: 'reserve sku=sku-2 qty=1',
  });
  at(110, {
    service: 'payments',
    ctx: { span: p1.span },
    n: 9,
    text: 'INFO',
    body: 'charge started order_id=ord-1001',
  });
  at(210, {
    service: 'payments',
    ctx: { span: p1.span },
    n: 13,
    text: 'WARN',
    body: declined('insufficient_funds'),
  });
  at(260, { service: 'payments', ctx: { span: p1.span }, n: 13, text: 'WARN', body: retry(200, 1) });
  at(470, {
    service: 'payments',
    ctx: { span: p1.span },
    n: 13,
    text: 'WARN',
    body: declined('do_not_honor'),
  });
  at(520, { service: 'payments', ctx: { span: p1.span }, n: 13, text: 'WARN', body: retry(400, 2) });
  at(930, {
    service: 'payments',
    ctx: { span: p1.span },
    n: 17,
    text: 'ERROR',
    body: declined('expired_card'),
  });
  at(940, { service: 'payments', ctx: { span: p1.span }, n: 13, text: 'WARN', body: retry(800, 3) });
  at(160, {
    service: 'payments',
    ctx: { span: p2.span },
    n: 5,
    text: 'DEBUG',
    body: 'INSERT charges rows=1',
  });
  // Trace 2.
  at(2005, {
    service: 'checkout',
    ctx: { span: c3.span },
    n: 9,
    text: 'INFO',
    body: 'cart requested user=u-12',
  });
  at(2006, {
    service: 'checkout',
    ctx: { span: c3.span },
    n: 13,
    text: 'WARN',
    body: '</script><img src=x onerror=alert(1)> tail',
  });
  at(2020, { service: 'checkout', ctx: { span: c4.span }, n: 5, text: 'DEBUG', body: 'cart.load items=3' });
  at(2030, { service: 'checkout', ctx: { span: c4.span }, n: 5, text: 'DEBUG', body: 'cart.load cache hit' });
  at(2120, {
    service: 'payments',
    ctx: { span: p3.span },
    n: 9,
    text: 'INFO',
    body: 'quote computed total=1999',
  });
  at(2130, {
    service: 'payments',
    ctx: { span: p3.span },
    n: 9,
    text: 'INFO',
    body: 'quote computed',
    eventName: 'quote.computed',
  });
  // Trace 3.
  at(4005, {
    service: 'checkout',
    ctx: { span: c5.span },
    n: 9,
    text: 'INFO',
    body: 'checkout retry flow begin',
  });
  at(5190, {
    service: 'checkout',
    ctx: { span: c5.span },
    n: 17,
    text: 'ERROR',
    body: 'checkout failed: upstream error',
  });
  at(5195, {
    service: 'checkout',
    ctx: { span: c5.span },
    n: 21,
    text: 'FATAL',
    body: 'payments unavailable, giving up',
  });
  at(4200, {
    service: 'payments',
    ctx: { span: p4.span },
    n: 17,
    text: 'ERROR',
    body: declined('insufficient_funds'),
  });
  at(4400, { service: 'payments', ctx: { span: p4.span }, n: 13, text: 'WARN', body: retry(250, 1) });
  at(4700, {
    service: 'payments',
    ctx: { span: p4.span },
    n: 17,
    text: 'ERROR',
    body: declined('do_not_honor'),
  });
  at(4800, { service: 'payments', ctx: { span: p4.span }, n: 13, text: 'WARN', body: retry(500, 2) });
  at(5000, {
    service: 'payments',
    ctx: { span: p4.span },
    n: 17,
    text: 'ERROR',
    body: declined('expired_card'),
  });
  at(5050, {
    service: 'payments',
    ctx: { span: p4.span },
    n: 17,
    text: 'ERROR',
    body: 'charge aborted after 3 attempts',
  });
  at(4160, {
    service: 'payments',
    ctx: { span: p5.span },
    n: 17,
    text: 'ERROR',
    body: 'db insert failed: connection reset',
  });
  at(4170, { service: 'payments', ctx: { span: p5.span }, n: 5, text: 'DEBUG', body: 'reconnecting' });

  for (const e of [c2, p2, p1, c1, c4, p3, c3, p5, p4, c5, lost]) e.end();

  const logExporter = new InMemoryLogRecordExporter();
  const loggerOf = (service: keyof typeof resources) =>
    new LoggerProvider({
      resource: resources[service],
      processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
    }).getLogger(`${service}.logger`, '1.0.0');
  const loggers = { checkout: loggerOf('checkout'), payments: loggerOf('payments') };
  const contextFor = (c: LogContext) => {
    if (c === 'none') return ROOT_CONTEXT;
    if (c === 'orphan') return trace.setSpan(ROOT_CONTEXT, lost.span);
    if (c === 'dangling') return danglingContext;
    return trace.setSpan(ROOT_CONTEXT, c.span);
  };
  entries.sort((a, b) => a[0] - b[0]);
  for (const [ms, log] of entries) {
    const when = hr(ms * 1e6);
    loggers[log.service].emit({
      ...(log.observedOnly === true ? {} : { timestamp: when }),
      observedTimestamp: when,
      context: contextFor(log.ctx),
      severityNumber: log.n,
      ...(log.text === '' ? {} : { severityText: log.text }),
      body: log.body,
      ...(log.eventName === undefined ? {} : { eventName: log.eventName }),
      attributes: {
        'log.source': log.service,
        ...log.attrs,
        ...(log.observedOnly === true ? { [OBSERVED_ONLY_MARK]: true } : {}),
      },
    });
  }
  const logBytes = JsonLogsSerializer.serializeRequest(logExporter.getFinishedLogRecords());
  if (logBytes === undefined) throw new Error('JsonLogsSerializer returned nothing');
  return {
    traces: serializeSpans(spanExporter.getFinishedSpans()),
    logs: stripWallClockTimestamps(new TextDecoder().decode(logBytes)),
  };
}

const METRICS_SEED = 0x3e7c5;
const COLLECTIONS = 10;
const COLLECTION_STEP_S = 10;
const ROUTES = ['/checkout', '/cart', '/health'] as const;
const NS_PER_S = 1_000_000_000n;
const START_NS = BigInt(T0_SECONDS) * NS_PER_S;
/** The collection that restarts `jobs.completed.cumulative` (a process restart), counting from 0. */
const RESET_AT = 6;
/** The restarted process starts 2 s after the last point of the previous one: a reset needs a start time after it. */
const RESTART_AFTER_NS = 2n * NS_PER_S;
const STRING = (value: string): { stringValue: string } => ({ stringValue: value });

interface OtlpKeyValue {
  key: string;
  value: { stringValue: string };
}
interface OtlpExemplar {
  timeUnixNano: string;
  asDouble: number;
  traceId: string;
  spanId: string;
  filteredAttributes?: OtlpKeyValue[];
}
interface OtlpPoint {
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  attributes?: OtlpKeyValue[];
  asInt?: string;
  asDouble?: number | string;
  exemplars?: OtlpExemplar[];
  count?: string;
  sum?: number;
  quantileValues?: { quantile: number; value: number }[];
}
interface OtlpMetric {
  name: string;
  description?: string;
  unit?: string;
  sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: OtlpPoint[] };
  gauge?: { dataPoints: OtlpPoint[] };
  histogram?: { aggregationTemporality: number; dataPoints: OtlpPoint[] };
  exponentialHistogram?: { aggregationTemporality: number; dataPoints: OtlpPoint[] };
  summary?: { dataPoints: OtlpPoint[] };
}
interface OtlpResourceMetrics {
  resource: { attributes: { key: string; value: { stringValue?: string } }[] };
  scopeMetrics: { scope: { name: string; version?: string }; metrics: OtlpMetric[] }[];
}

function pointsOf(m: OtlpMetric): OtlpPoint[] {
  return (m.sum ?? m.gauge ?? m.histogram ?? m.exponentialHistogram ?? m.summary)?.dataPoints ?? [];
}

function serviceOf(rm: OtlpResourceMetrics): string | undefined {
  return rm.resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue;
}

/** The SDK side of the metrics fixture: what one service does during one collection interval. */
interface Interval {
  /** Request durations (s) per route. */
  durations: Record<(typeof ROUTES)[number], number[]>;
  dbDurations: number[];
  jobs: number;
  activeDelta: number;
  cpu: { user: number; system: number };
  memory: number;
  fds: number;
}

function planIntervals(rand: () => number, scale: number): Interval[] {
  const duration = (): number => Math.round((0.005 + rand() * rand() * 0.9 * scale) * 1000) / 1000;
  return Array.from({ length: COLLECTIONS }, () => ({
    durations: {
      '/checkout': Array.from({ length: 6 + Math.floor(rand() * 6) }, duration),
      '/cart': Array.from({ length: 4 + Math.floor(rand() * 5) }, duration),
      '/health': Array.from({ length: 8 }, () => Math.round((0.001 + rand() * 0.004) * 1000) / 1000),
    },
    dbDurations: Array.from({ length: 5 + Math.floor(rand() * 5) }, duration),
    jobs: 3 + Math.floor(rand() * 5),
    activeDelta: Math.floor(rand() * 5) - 2,
    cpu: {
      user: Math.round((0.2 + rand() * 0.3) * 100) / 100,
      system: Math.round((0.05 + rand() * 0.1) * 100) / 100,
    },
    memory: Math.round(180e6 + rand() * 40e6),
    fds: 40 + Math.floor(rand() * 20),
  }));
}

/** The SDK instruments of one service, collected through a cumulative and a delta reader. */
function instrument(
  service: 'checkout' | 'payments',
  host: string,
  intervals: readonly Interval[],
  cumulative: InMemoryMetricExporter,
  delta: InMemoryMetricExporter,
): { record(k: number): void; flush(): Promise<void>; shutdown(): Promise<void> } {
  const reader = (exporter: InMemoryMetricExporter): PeriodicExportingMetricReader =>
    // The interval never fires: `flush` collects on demand, one collection at a time.
    new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': service,
      'service.version': '3.1.0',
      'host.name': host,
      'deployment.environment.name': 'production',
    }),
    readers: [reader(cumulative), reader(delta)],
    views: [
      {
        instrumentName: 'db.client.operation.duration',
        aggregation: { type: AggregationType.EXPONENTIAL_HISTOGRAM, options: { maxSize: 32 } },
      },
    ],
  });
  const meter = provider.getMeter(`${service}.instrumentation`, '1.0.0');
  const requests = meter.createHistogram(METRIC_HIST, { unit: 's' });
  const dbOps = meter.createHistogram('db.client.operation.duration', { unit: 's' });
  const jobs = meter.createCounter('jobs.completed', { unit: '{job}' });
  const active = meter.createUpDownCounter('http.server.active_requests', { unit: '{request}' });
  let now = 0;
  const at = (k: number): Interval => intervals[k] ?? intervals[0] ?? fail('no intervals');
  meter.createObservableGauge('process.cpu.utilization', { unit: '1' }).addCallback((r) => {
    r.observe(at(now).cpu.user, { 'cpu.mode': 'user' });
    r.observe(at(now).cpu.system, { 'cpu.mode': 'system' });
  });
  meter
    .createObservableGauge('process.memory.usage', { unit: 'By' })
    .addCallback((r) => r.observe(at(now).memory));
  meter
    .createObservableGauge('process.open_file_descriptor.count', { unit: '{file}' })
    .addCallback((r) => r.observe(at(now).fds));
  return {
    record(k) {
      now = k;
      const step = at(k);
      for (const route of ROUTES)
        for (const d of step.durations[route]) requests.record(d, { 'http.route': route });
      for (const d of step.dbDurations) dbOps.record(d, { 'db.system.name': 'postgresql' });
      jobs.add(step.jobs);
      active.add(step.activeDelta);
    },
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/** The delta reader keeps these two; the cumulative reader keeps everything else. */
const DELTA_METRICS: ReadonlySet<string> = new Set(['db.client.operation.duration', 'jobs.completed']);

function serializeMetrics(rm: ResourceMetrics, keep: (name: string) => boolean): OtlpResourceMetrics {
  const filtered: ResourceMetrics = {
    resource: rm.resource,
    scopeMetrics: rm.scopeMetrics.map((sm) => ({
      scope: sm.scope,
      metrics: sm.metrics.filter((m) => keep(m.descriptor.name)),
    })),
  };
  const bytes = JsonMetricsSerializer.serializeRequest(filtered);
  if (bytes === undefined) throw new Error('JsonMetricsSerializer returned nothing');
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { resourceMetrics: OtlpResourceMetrics[] };
  const [only] = parsed.resourceMetrics;
  if (only === undefined) throw new Error('JsonMetricsSerializer returned no resourceMetrics');
  return only;
}

/** The SDK stamps points with the wall clock; replace it with collection `k`'s deterministic window. */
function restamp(rm: OtlpResourceMetrics, k: number): void {
  const end = START_NS + BigInt((k + 1) * COLLECTION_STEP_S) * NS_PER_S;
  const previous = k === 0 ? START_NS : end - BigInt(COLLECTION_STEP_S) * NS_PER_S;
  for (const sm of rm.scopeMetrics)
    for (const m of sm.metrics) {
      const temporality = (m.sum ?? m.histogram ?? m.exponentialHistogram)?.aggregationTemporality;
      for (const p of pointsOf(m)) {
        // A gauge has no start time (the SDK leaves it 0); the others start the collection (delta) or the run.
        if (m.gauge !== undefined) delete p.startTimeUnixNano;
        else p.startTimeUnixNano = String(temporality === 1 ? previous : START_NS);
        p.timeUnixNano = String(end);
      }
    }
}

/**
 * The metrics fixture: 10 collections, 10 s apart, over `checkout` (runner-7) and `payments` (runner-8). The OTel SDK
 * produces the seven metrics below (histograms and `http.server.active_requests` cumulative, `db.client.operation.duration`
 * and `jobs.completed` delta); `augment` adds what it cannot.
 */
async function buildMetrics(): Promise<string> {
  const rand = prng(METRICS_SEED);
  const cumulative = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const delta = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const services = [
    { service: 'checkout', host: 'runner-7', scale: 1 },
    { service: 'payments', host: 'runner-8', scale: 1.6 },
  ] as const;
  const instruments = services.map((s) => ({
    ...instrument(s.service, s.host, planIntervals(rand, s.scale), cumulative, delta),
  }));
  const collections: OtlpResourceMetrics[][] = [];
  for (let k = 0; k < COLLECTIONS; k++) {
    for (const i of instruments) {
      i.record(k);
      await i.flush();
    }
    const fromCumulative = cumulative
      .getMetrics()
      .map((rm) => serializeMetrics(rm, (n) => !DELTA_METRICS.has(n)));
    const fromDelta = delta.getMetrics().map((rm) => serializeMetrics(rm, (n) => DELTA_METRICS.has(n)));
    cumulative.reset();
    delta.reset();
    const merged: OtlpResourceMetrics[] = [];
    for (const { service } of services) {
      const parts = [...fromCumulative, ...fromDelta].filter((rm) => serviceOf(rm) === service);
      const [first] = parts;
      if (first === undefined) throw new Error(`no metrics for ${service} in collection ${k}`);
      const rm: OtlpResourceMetrics = {
        resource: first.resource,
        scopeMetrics: parts.flatMap((p) => p.scopeMetrics).filter((sm) => sm.metrics.length > 0),
      };
      restamp(rm, k);
      merged.push(rm);
    }
    collections.push(merged);
  }
  await Promise.all(instruments.map((i) => i.shutdown()));
  augment(collections);
  return JSON.stringify({ resourceMetrics: collections.flat() });
}

/**
 * Adds to the SDK's output what the SDK cannot produce, each item for a reader the explorer must handle:
 *
 * - `legacy.request.latency`: a summary metric (quantiles 0.5/0.9/0.99). The SDK has no summary aggregation, and summaries
 *   cannot be merged across series or re-bucketed, so the explorer must show them as they are and say so.
 * - `jobs.completed.cumulative`: a cumulative copy of `jobs.completed` that restarts at collection `RESET_AT`. The SDK
 *   never resets a cumulative stream, and the writer must count the reset and the chart must mark it.
 * - Two exemplars on `http.server.request.duration` (`/checkout`, `checkout`): one pointing at `LINKED_TRACE` /
 *   `LINKED_SPAN` (a trace in the same report, so the exemplar links to it), one at `ORPHAN_EXEMPLAR_TRACE` (a trace
 *   that is not, so the explorer must say the trace is missing). The SDK's exemplar reservoirs are off by default and
 *   cannot be pointed at a chosen trace.
 * - One NaN point on `process.open_file_descriptor.count` (`payments`, collection 4): a gauge with no usable value, which
 *   the writer counts as `noValue` and the chart must skip. The SDK would not record NaN.
 * - `HOSTILE_METRIC_NAME`: a gauge named with markup, with a markup unit (`HOSTILE_METRIC_UNIT`) and a markup attribute
 *   value (`HOSTILE_METRIC_ATTR_VALUE`), to show names, units and values are never interpreted as HTML. The SDK rejects
 *   the name as invalid.
 */
function augment(collections: readonly OtlpResourceMetrics[][]): void {
  const find = (k: number, service: string): OtlpResourceMetrics =>
    collections[k]?.find((rm) => serviceOf(rm) === service) ?? fail(`no ${service} metrics at ${k}`);
  const metricOf = (rm: OtlpResourceMetrics, name: string): OtlpMetric =>
    rm.scopeMetrics.flatMap((sm) => sm.metrics).find((m) => m.name === name) ?? fail(`no metric ${name}`);
  const end = (k: number): bigint => START_NS + BigInt((k + 1) * COLLECTION_STEP_S) * NS_PER_S;
  let jobsTotal = 0;
  for (let k = 0; k < COLLECTIONS; k++) {
    const rm = find(k, 'checkout');
    const scope = rm.scopeMetrics[0] ?? fail('no scope');
    const stamp = { startTimeUnixNano: String(START_NS), timeUnixNano: String(end(k)) };

    scope.metrics.push({
      name: 'legacy.request.latency',
      description: 'Request latency from a client library that reports summaries',
      unit: 's',
      summary: {
        dataPoints: [
          {
            ...stamp,
            count: String(100 * (k + 1)),
            sum: 4.2 * (k + 1),
            quantileValues: [
              { quantile: 0.5, value: 0.03 + 0.001 * k },
              { quantile: 0.9, value: 0.11 + 0.004 * k },
              { quantile: 0.99, value: 0.42 + 0.01 * k },
            ],
          },
        ],
      },
    });

    const jobs = pointsOf(metricOf(rm, 'jobs.completed'))[0] ?? fail('no jobs point');
    const added = Number(jobs.asInt ?? jobs.asDouble);
    jobsTotal = k === RESET_AT ? added : jobsTotal + added;
    scope.metrics.push({
      name: 'jobs.completed.cumulative',
      description: 'jobs.completed as a cumulative sum, restarted at collection 6',
      unit: '{job}',
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [
          {
            ...stamp,
            startTimeUnixNano: String(k < RESET_AT ? START_NS : end(RESET_AT - 1) + RESTART_AFTER_NS),
            asInt: String(jobsTotal),
          },
        ],
      },
    });

    scope.metrics.push({
      name: HOSTILE_METRIC_NAME,
      unit: HOSTILE_METRIC_UNIT,
      gauge: {
        dataPoints: [
          {
            ...stamp,
            asDouble: 0.5,
            attributes: [{ key: HOSTILE_METRIC_ATTR, value: STRING(HOSTILE_METRIC_ATTR_VALUE) }],
          },
        ],
      },
    });
  }

  const checkoutRoute = (k: number): OtlpPoint =>
    pointsOf(metricOf(find(k, 'checkout'), METRIC_HIST)).find((p) =>
      p.attributes?.some((a) => a.value.stringValue === '/checkout'),
    ) ?? fail('no /checkout point');
  // The linked exemplar sits inside the first window, where `LINKED_TRACE` happened (0 to 900 ms after the start).
  checkoutRoute(0).exemplars = [
    {
      timeUnixNano: String(START_NS + 500_000_000n),
      asDouble: 0.9,
      traceId: LINKED_TRACE,
      spanId: LINKED_SPAN,
      filteredAttributes: [{ key: 'http.request.method', value: STRING('POST') }],
    },
  ];
  checkoutRoute(4).exemplars = [
    {
      timeUnixNano: String(end(4) - 3n * NS_PER_S),
      asDouble: 1.3,
      traceId: ORPHAN_EXEMPLAR_TRACE,
      spanId: '7a1b2c3d4e5f6071',
    },
  ];

  const nan =
    pointsOf(metricOf(find(4, 'payments'), 'process.open_file_descriptor.count'))[0] ?? fail('no fd point');
  delete nan.asInt;
  nan.asDouble = 'NaN';
}

write('small', buildSmall());
write('orphans', buildOrphans());
write('logs-only', await buildLogsOnly());
const linked = await buildLinked();
write('linked-traces', linked.traces);
write('linked-logs', linked.logs);
write('metrics', await buildMetrics());
write('empty', '{"resourceSpans":[]}\n');
if (!existsSync(new URL('hostile.otlp.json', OUT)))
  throw new Error('fixtures/hostile.otlp.json is hand-authored and missing; restore it from git');
