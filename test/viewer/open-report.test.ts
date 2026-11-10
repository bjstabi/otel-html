import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type Context,
  type ContextManager,
  context,
  type ProxyTracerProvider,
  ROOT_CONTEXT,
  SpanStatusCode,
  type TracerProvider,
  trace,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ManifestV4 } from '../../src/format/manifest.js';
import { partitionFilePath } from '../../src/format/paths.js';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { Engine } from '../../src/viewer/data/engine/start.js';
import {
  type LoadProgress,
  type OpenDeps,
  type OpenParts,
  openReport,
  openReportRefreshable,
} from '../../src/viewer/data/open-report.js';
import type { QueryEngine } from '../../src/viewer/data/query-engine.js';

/** Async context propagation for the test (the viewer's own context manager is the browser's). */
function asyncContextManager(): ContextManager {
  const als = new AsyncLocalStorage<Context>();
  const manager: ContextManager = {
    active: () => als.getStore() ?? ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) => als.run(ctx, () => fn.call(thisArg, ...args)),
    bind: (_ctx, target) => target,
    enable: () => manager,
    disable: () => manager,
  };
  return manager;
}

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let saved: TracerProvider | undefined;

beforeEach(() => {
  const delegate = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
  saved = delegate.constructor.name === 'NoopTracerProvider' ? undefined : delegate;
  trace.disable();
  context.disable();
  context.setGlobalContextManager(asyncContextManager());
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  if (saved !== undefined) trace.setGlobalTracerProvider(saved);
});

const spanNamed = (name: string): ReadableSpan | undefined =>
  exporter.getFinishedSpans().find((s) => s.name === name);

const file = (n: number, table: 'spans' | 'logs', bytes: number) => ({
  path: partitionFilePath(n, table),
  bytes,
  rows: 1,
  timeMin: null,
  timeMax: null,
  values: {},
});

const config = {
  viewer: {
    listCap: 10_000,
    theme: 'system',
    defaultDashboard: 'fusion',
    home: 'traces',
  },
  dashboards: [],
  views: [],
};

/** Three partitions holding 2, 1 and 2 files. */
const manifest4 = (): ManifestV4 =>
  ({
    formatVersion: 4,
    otelHtmlVersion: '0.3.0',
    title: 't',
    epochUnixNano: '1700000000000000000',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:01.000Z',
    complete: true,
    range: null,
    totals: { spans: 3, logs: 2, metrics: 0 },
    partitions: [
      { n: 0, source: 'flush:1', files: { spans: file(0, 'spans', 100), logs: file(0, 'logs', 10) } },
      { n: 1, source: 'flush:2', files: { spans: file(1, 'spans', 200) } },
      { n: 2, source: 'flush:3', files: { spans: file(2, 'spans', 300), logs: file(2, 'logs', 20) } },
    ],
    statisticsKeys: { spans: [], logs: [], points: [], traces: [], patterns: [] },
    engine: { version: '1.32.0', format: 'local', assetsBase: 'assets/' },
    config,
  }) as unknown as ManifestV4;

const manifest3 = {
  formatVersion: 3,
  otelHtmlVersion: '0.2.0',
  title: 't',
  epochUnixNano: '1700000000000000000',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:00:01.000Z',
  complete: true,
  range: null,
  totals: { spans: 0, logs: 0, metrics: 0 },
  decodedBytes: 0,
  chunks: [],
  rollups: [],
  traceShards: [],
  metricFiles: [],
  config: { ...config, viewer: { ...config.viewer, eagerBudgetBytes: 75_000_000 } },
};

function setup(overrides: Partial<OpenParts> = {}) {
  const close = vi.fn(() => Promise.resolve());
  const engine = { close } as unknown as Engine;
  const source = { querySpans: vi.fn(() => Promise.resolve({ rows: [1] })) } as unknown as DataSource;
  const warn = vi.fn();
  const parts: Partial<OpenParts> = {
    startEngine: vi.fn(() => Promise.resolve(engine)),
    registerPartitions: vi.fn((_e, _m, _d, onProgress) => {
      for (let done = 1; done <= 5; done++) onProgress?.({ done, total: 5 });
      return Promise.resolve();
    }),
    createQueryEngine: vi.fn(() => ({}) as QueryEngine),
    createSource: vi.fn(() => source),
    ...overrides,
  };
  const deps = {
    logger: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    parts,
  } as unknown as OpenDeps;
  return { deps, parts, close, warn, source };
}

describe('openReport over a host', () => {
  function hosted(overrides: Partial<OpenParts> = {}) {
    const { deps, parts, source } = setup(overrides);
    const rest = {} as QueryEngine;
    const createRestEngine = vi.fn(() => rest);
    const mustNot = vi.fn(() => Promise.reject(new Error('must not be called')));
    const hostParts = {
      ...parts,
      createRestEngine,
      startEngine: mustNot,
      registerPartitions: mustNot,
    } as Partial<OpenParts>;
    const hostDeps = {
      ...deps,
      baseUrl: 'http://127.0.0.1:4318/index.html',
      host: 'query',
      parts: hostParts,
    } as unknown as OpenDeps;
    return { hostDeps, hostParts, createRestEngine, mustNot, rest, source };
  }

  test('queries the REST endpoint resolved against the base url, starting no engine', async () => {
    const { hostDeps, hostParts, createRestEngine, mustNot, rest, source } = hosted();
    const seen: LoadProgress[] = [];
    const ds = await openReport(manifest4(), hostDeps, (p) => seen.push(p));
    expect(createRestEngine).toHaveBeenCalledWith('http://127.0.0.1:4318/query', hostDeps.logger);
    expect(mustNot).not.toHaveBeenCalled();
    expect(hostParts.createSource).toHaveBeenCalledWith(expect.objectContaining({ engine: rest }));
    expect(seen).toEqual([{ phase: 'host' }]);
    expect(await ds.querySpans({} as never)).toEqual({ rows: [1] });
    expect(source.querySpans).toHaveBeenCalledOnce();
  });

  test('openReportRefreshable gives a served report no refresh (#246)', async () => {
    const { hostDeps, source } = hosted();
    const opened = await openReportRefreshable(manifest4(), hostDeps, () => undefined);
    expect(opened.refresh).toBeNull();
    expect(await opened.dataSource.querySpans({} as never)).toEqual({ rows: [1] });
    expect(source.querySpans).toHaveBeenCalledOnce();
  });

  test('a format-3 manifest still fails the D12 gate', async () => {
    const { hostDeps, createRestEngine } = hosted();
    await expect(openReport(manifest3, hostDeps, () => undefined)).rejects.toThrow('format 3');
    expect(createRestEngine).not.toHaveBeenCalled();
  });
});

describe('openReportRefreshable', () => {
  test('a report with an engine in the page gets a refresh function; openReport returns the same data source kind', async () => {
    const { deps } = setup();
    const opened = await openReportRefreshable(manifest4(), deps, () => undefined);
    expect(opened.refresh).toBeInstanceOf(Function);
    expect(await opened.dataSource.querySpans({} as never)).toEqual({ rows: [1] });
  });
});

describe('openReport', () => {
  test('a format-3 manifest rejects with the D12 text and starts nothing', async () => {
    const { deps, parts } = setup();
    await expect(openReport(manifest3, deps, () => undefined)).rejects.toThrow(
      'This report is format 3; this viewer reads format 4. `otel-html merge <report> --out <new>` converts it.',
    );
    expect(parts.startEngine).not.toHaveBeenCalled();
  });

  test('a malformed manifest rejects rather than throwing', async () => {
    const { deps } = setup();
    await expect(openReport({ formatVersion: 4 }, deps, () => undefined)).rejects.toThrow();
  });

  test('progress runs engine, partitions counted as partitions, then views', async () => {
    const { deps } = setup();
    const seen: LoadProgress[] = [];
    const ds = await openReport(manifest4(), deps, (p) => seen.push(p));
    expect(seen).toEqual([
      { phase: 'engine' },
      { phase: 'partitions', done: 0, total: 3 },
      { phase: 'partitions', done: 0, total: 3 }, // 1 of 5 files: partition 0 has 2
      { phase: 'partitions', done: 1, total: 3 }, // 2 files
      { phase: 'partitions', done: 2, total: 3 }, // 3 files
      { phase: 'partitions', done: 2, total: 3 }, // 4 files
      { phase: 'views' },
    ]);
    await ds.querySpans({} as never);
  });

  test('the engine is closed when registering fails, and the error stands', async () => {
    const boom = new Error('register');
    const { deps, close } = setup({ registerPartitions: () => Promise.reject(boom) });
    await expect(openReport(manifest4(), deps, () => undefined)).rejects.toBe(boom);
    expect(close).toHaveBeenCalledOnce();
  });

  test('the engine is closed when the data source cannot be created; a failing close is logged', async () => {
    const boom = new Error('source');
    const { deps, close, warn } = setup({
      createSource: () => {
        throw boom;
      },
    });
    close.mockRejectedValueOnce(new Error('close'));
    await expect(openReport(manifest4(), deps, () => undefined)).rejects.toBe(boom);
    expect(close).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  test('viewer.load parents the engine and partition spans, with format, partitions and bytes', async () => {
    const { deps } = setup();
    await openReport(manifest4(), deps, () => undefined);
    const load = spanNamed('viewer.load');
    const start = spanNamed('viewer.engine.start');
    const register = spanNamed('viewer.partitions.register');
    expect(load).toBeDefined();
    for (const child of [start, register]) {
      expect(child?.parentSpanContext?.spanId).toBe(load?.spanContext().spanId);
      expect(child?.attributes['otel_html.format']).toBe('local');
      expect(child?.attributes['otel_html.partitions']).toBe(3);
      expect(child?.attributes['otel_html.bytes']).toBe(630);
    }
    expect(load?.status.code).toBe(SpanStatusCode.UNSET);
  });
});
