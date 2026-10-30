import { describe, expect, test } from 'vitest';
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
