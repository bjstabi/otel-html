import { describe, expect, test } from 'vitest';
import { OtelHtmlError } from '../../src/model/errors.js';
import { childEnvironment } from '../../src/run/child-env.js';

const base = { http: 'http://127.0.0.1:4318', grpc: '127.0.0.1:4317', traceparent: '00-aa-bb-01' };

const at = (env: Record<string, string | undefined>, key: string): string | undefined => env[key];

function usageOf(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('did not throw');
}

describe('childEnvironment', () => {
  test('defaults to http/protobuf on the http endpoint and sets TRACEPARENT', () => {
    expect(childEnvironment({ ...base, env: {} })).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      TRACEPARENT: '00-aa-bb-01',
    });
  });

  test('grpc points at the gRPC address', () => {
    const env = childEnvironment({ ...base, env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' } });
    expect(at(env, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('http://127.0.0.1:4317');
    expect(at(env, 'OTEL_EXPORTER_OTLP_PROTOCOL')).toBe('grpc');
  });

  test('http/json keeps the user protocol on the http endpoint', () => {
    const env = childEnvironment({ ...base, env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' } });
    expect(at(env, 'OTEL_EXPORTER_OTLP_PROTOCOL')).toBe('http/json');
    expect(at(env, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('http://127.0.0.1:4318');
  });

  test('grpc with the gRPC transport disabled is a usage error', () => {
    const e = usageOf(() =>
      childEnvironment({ ...base, grpc: null, env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' } }),
    );
    expect(e.code).toBe('usage');
    expect(e.message).toContain('--grpc');
  });

  test('an http protocol with the http transport disabled is a usage error', () => {
    const e = usageOf(() => childEnvironment({ ...base, http: null, env: {} }));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('--http');
  });

  test('an unknown protocol is a usage error naming the three', () => {
    const e = usageOf(() => childEnvironment({ ...base, env: { OTEL_EXPORTER_OTLP_PROTOCOL: 'foo' } }));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('grpc');
    expect(e.message).toContain('http/protobuf');
    expect(e.message).toContain('http/json');
  });

  test('a user-set endpoint is kept; TRACEPARENT is always replaced', () => {
    const env = childEnvironment({
      ...base,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:9', TRACEPARENT: 'old' },
    });
    expect(at(env, 'OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('http://collector:9');
    expect(at(env, 'TRACEPARENT')).toBe('00-aa-bb-01');
  });
});
