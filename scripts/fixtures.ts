// Regenerates the committed OTLP/JSON fixtures in fixtures/ with the OpenTelemetry SDK.
// Output is byte-stable: seeded PRNG and ID generator, fixed start time, no wall-clock reads.
// fixtures/hostile.otlp.json is hand-authored and is only checked for presence here, never rewritten.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { type HrTime, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
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

write('small', buildSmall());
write('orphans', buildOrphans());
write('logs-only', await buildLogsOnly());
write('empty', '{"resourceSpans":[]}\n');
if (!existsSync(new URL('hostile.otlp.json', OUT)))
  throw new Error('fixtures/hostile.otlp.json is hand-authored and missing; restore it from git');
