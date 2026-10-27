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
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

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

interface OtlpLogsFile {
  resourceLogs: {
    scopeLogs: { logRecords: { timeUnixNano?: string; body?: { stringValue?: string } }[] }[];
  }[];
}

/** The SDK stamps a missing `timestamp` with the wall clock; drop it again so the record carries only `observedTimeUnixNano`. */
function stripWallClockTimestamps(json: string, bodies: ReadonlySet<AnyValue>): string {
  const file = JSON.parse(json) as OtlpLogsFile;
  for (const rl of file.resourceLogs)
    for (const sl of rl.scopeLogs)
      for (const record of sl.logRecords)
        if (bodies.has(record.body?.stringValue ?? null)) delete record.timeUnixNano;
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
  const observedOnlyBodies = new Set(entries.flatMap(([, l]) => (l.observedOnly === true ? [l.body] : [])));
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
      attributes: { 'log.source': log.service, ...log.attrs },
    });
  }
  const logBytes = JsonLogsSerializer.serializeRequest(logExporter.getFinishedLogRecords());
  if (logBytes === undefined) throw new Error('JsonLogsSerializer returned nothing');
  return {
    traces: serializeSpans(spanExporter.getFinishedSpans()),
    logs: stripWallClockTimestamps(new TextDecoder().decode(logBytes), observedOnlyBodies),
  };
}

write('small', buildSmall());
write('orphans', buildOrphans());
write('logs-only', await buildLogsOnly());
const linked = await buildLinked();
write('linked-traces', linked.traces);
write('linked-logs', linked.logs);
write('empty', '{"resourceSpans":[]}\n');
if (!existsSync(new URL('hostile.otlp.json', OUT)))
  throw new Error('fixtures/hostile.otlp.json is hand-authored and missing; restore it from git');
