import { type ProxyTracerProvider, SpanStatusCode, type TracerProvider, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import type { ServicesResult, SpanQueryResult } from '../../src/viewer/data/results.js';
import { tracedDataSource, tracedLoader } from '../../src/viewer/data/traced.js';
import { watchNavigation } from '../../src/viewer/telemetry.js';
import { createScriptedLoader } from '../../test-support/scripted-loader.js';

// A provider's shutdown stops its exporter, so each test gets its own pair.
let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
// Under an OTLP endpoint vitest's own SDK is already the global provider; set it aside and put it back.
let saved: TracerProvider | undefined;

beforeEach(() => {
  const delegate = (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();
  saved = delegate.constructor.name === 'NoopTracerProvider' ? undefined : delegate;
  trace.disable();
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  if (saved !== undefined) trace.setGlobalTracerProvider(saved);
  vi.unstubAllGlobals();
});

const spansNamed = (name: string): ReadableSpan[] =>
  exporter.getFinishedSpans().filter((s) => s.name === name);

function fakeSource(overrides: Partial<DataSource>): DataSource {
  return overrides as DataSource;
}

describe('tracedLoader', () => {
  test('records a chunk load span', async () => {
    const loader = tracedLoader(createScriptedLoader(new Map([['data/a.js', '__OH__.push("k", 7);']])));
    await expect(loader.load('data/a.js', 'k')).resolves.toBe(7);
    const [span] = spansNamed('viewer.script.load');
    expect(span?.attributes['otel_html.path']).toBe('data/a.js');
    expect(span?.attributes['otel_html.key']).toBe('k');
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test('marks a failed load as an error', async () => {
    const failure = new Error('boom');
    const loader = tracedLoader({ load: () => Promise.reject(failure) });
    await expect(loader.load('data/a.js', 'k')).rejects.toBe(failure);
    const [span] = spansNamed('viewer.script.load');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((e) => e.name)).toContain('exception');
  });
});

describe('tracedDataSource', () => {
  const result = { rows: [1, 2, 3] } as unknown as SpanQueryResult;

  test('records querySpans with its kind and count', async () => {
    const ds = tracedDataSource(fakeSource({ querySpans: () => Promise.resolve(result) }));
    await ds.querySpans({} as never);
    const [span] = spansNamed('viewer.query');
    expect(span?.attributes['otel_html.query.kind']).toBe('querySpans');
    expect(span?.attributes['otel_html.query.result_count']).toBe(3);
  });

  test('an aborted query is not an error', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const ds = tracedDataSource(fakeSource({ querySpans: () => Promise.reject(abort) }));
    await expect(ds.querySpans({} as never)).rejects.toBe(abort);
    const [span] = spansNamed('viewer.query');
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes['otel_html.query.aborted']).toBe(true);
  });

  test('records services with its kind and count', async () => {
    const services = { services: [{}, {}], total: 2 } as unknown as ServicesResult;
    const ds = tracedDataSource(fakeSource({ services: () => Promise.resolve(services) }));
    await ds.services({ window: null, condition: null, limit: 50 });
    const [span] = spansNamed('viewer.query');
    expect(span?.attributes['otel_html.query.kind']).toBe('services');
    expect(span?.attributes['otel_html.query.result_count']).toBe(2);
  });

  test('other methods pass through untraced', async () => {
    const ds = tracedDataSource(fakeSource({ percentileOf: () => Promise.resolve(5) }));
    await expect(ds.percentileOf('a', 'b', 1)).resolves.toBe(5);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe('watchNavigation', () => {
  test('records the route and parameter names but not values', () => {
    const stop = watchNavigation(window);
    window.location.hash = '#/logs?q=secret&sort=time';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    stop();
    const [span] = spansNamed('viewer.navigate');
    expect(span?.attributes['otel_html.route']).toBe('/logs');
    expect(span?.attributes['otel_html.route.params']).toBe('q,sort');
    expect(JSON.stringify(span?.attributes)).not.toContain('secret');
  });
});

describe('without a provider', () => {
  test('nothing is recorded and nothing is fetched', async () => {
    trace.disable();
    const fail = vi.fn(() => {
      throw new Error('network');
    });
    vi.stubGlobal('fetch', fail);
    vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(fail);
    const ds = tracedDataSource(fakeSource({ querySpans: () => Promise.resolve({ rows: [] } as never) }));
    await expect(ds.querySpans({} as never)).resolves.toBeDefined();
    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(fail).not.toHaveBeenCalled();
  });
});
