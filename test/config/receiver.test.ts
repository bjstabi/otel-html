import { describe, expect, test } from 'vitest';
import { writeJsonSchema } from '../../src/config/json-schema.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { ConfigSchema } from '../../src/config/schema.js';

describe('receiver config', () => {
  test('defaults', () => {
    expect(ConfigSchema.parse({}).receiver).toEqual({
      host: '127.0.0.1',
      http: { enabled: true, port: 4318 },
      grpc: { enabled: true, port: 4317 },
      maxBodyBytes: 67_108_864,
      inflightBudgetBytes: 134_217_728,
    });
  });

  test.each(['ftp://c/', 'file:///x', 'http://c/?q=1', 'http://c/#f', 'nonsense'])(
    'receiver.exportOtlp %s is refused',
    (url) => {
      expect(ConfigSchema.safeParse({ receiver: { exportOtlp: url } }).success).toBe(false);
    },
  );

  test('userinfo in receiver.exportOtlp is refused and the message points at the headers variable', () => {
    const r = ConfigSchema.safeParse({ receiver: { exportOtlp: 'http://user:pw@c:4318' } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('OTEL_EXPORTER_OTLP_HEADERS');
  });

  test('the committed JSON schema carries the URL rule as a pattern', () => {
    const schema: unknown = JSON.parse(writeJsonSchema());
    const rule = JSON.stringify(schema).match(/"exportOtlp":\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('"pattern"');
  });

  test.each(['http://c:4318', 'https://c/base/'])('receiver.exportOtlp %s is accepted', (url) => {
    expect(ConfigSchema.parse({ receiver: { exportOtlp: url } }).receiver.exportOtlp).toBe(url);
  });

  test('a port above 65535 fails at receiver.http.port', () => {
    const r = ConfigSchema.safeParse({ receiver: { http: { port: 70000 } } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['receiver', 'http', 'port']);
  });

  test('disabling grpc keeps its port', () => {
    const c = ConfigSchema.parse({ receiver: { grpc: { enabled: false } } });
    expect(c.receiver.grpc).toEqual({ enabled: false, port: 4317 });
  });

  test('a flag port of 0 is attributed to the flag', () => {
    const { config, sources } = resolveConfig({ env: {}, flags: { receiver: { http: { port: 0 } } } });
    expect(config.receiver.http.port).toBe(0);
    expect(sources.get('receiver.http.port')).toBe('flag');
  });
});
