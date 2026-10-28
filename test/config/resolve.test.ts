import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { writeJsonSchema } from '../../src/config/json-schema.js';
import { formatConfig, resolveConfig } from '../../src/config/resolve.js';
import { OtelHtmlError } from '../../src/model/errors.js';

function failure(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('resolveConfig', () => {
  test('defaults', () => {
    const { config, sources } = resolveConfig({ env: {} });
    expect(config.viewer.eagerBudgetBytes).toBe(75_000_000);
    expect(config.writer.chunkTargetBytes).toBe(4_000_000);
    expect(config.writer.drop.traces.span).toEqual([]);
    expect(sources.get('viewer.theme')).toBe('default');
  });

  test('metric writer defaults and validation', () => {
    const { config } = resolveConfig({ env: {} });
    expect(config.writer.metricSeriesCap).toBe(1_000);
    expect(config.writer.metricExemplars).toBe(4);
    const e = failure(() => resolveConfig({ file: { writer: { metricSeriesCap: 0 } }, env: {} }));
    expect(e.code).toBe('invalid-config');
    expect(e.message).toContain('writer.metricSeriesCap');
  });

  test('flag > env > file > default', () => {
    const r = resolveConfig({
      file: { title: 'a' },
      env: { OTEL_HTML_TITLE: 'b' },
      flags: { title: 'c' },
    });
    expect(r.config.title).toBe('c');
    expect(r.sources.get('title')).toBe('flag');
    const e = resolveConfig({ file: { title: 'a' }, env: { OTEL_HTML_TITLE: 'b' } });
    expect(e.config.title).toBe('b');
    expect(e.sources.get('title')).toBe('env');
    const f = resolveConfig({ file: { title: 'a' }, env: {} });
    expect(f.sources.get('title')).toBe('file');
  });

  test('env overrides file for drop arrays only when set; file drop wins over default', () => {
    const r = resolveConfig({
      file: { writer: { drop: { traces: { span: ['name == "x"'] } } } },
      env: { OTEL_HTML_EAGER_BUDGET_BYTES: '5' },
    });
    expect(r.config.writer.drop.traces.span).toEqual(['name == "x"']);
    expect(r.sources.get('writer.drop.traces.span')).toBe('file');
    expect(r.config.viewer.eagerBudgetBytes).toBe(5);
    expect(r.sources.get('viewer.eagerBudgetBytes')).toBe('env');
  });

  test('flag drop beats file drop', () => {
    const r = resolveConfig({
      file: { writer: { drop: { traces: { span: ['a'] } } } },
      env: {},
      flags: { writer: { drop: { traces: { span: ['b'] } } } },
    });
    expect(r.config.writer.drop.traces.span).toEqual(['b']);
    expect(r.sources.get('writer.drop.traces.span')).toBe('flag');
  });

  test('unknown key fails with path', () => {
    const e = failure(() => resolveConfig({ file: { writer: { chunkSize: 1 } }, env: {} }));
    expect(e.code).toBe('invalid-config');
    expect(e.message).toContain('writer.chunkSize');
    expect(e.message).toContain('unrecognized key');
  });

  test('bad env int names the variable', () => {
    const e = failure(() => resolveConfig({ env: { OTEL_HTML_EAGER_BUDGET_BYTES: 'abc' } }));
    expect(e.code).toBe('invalid-config');
    expect(e.message).toContain('OTEL_HTML_EAGER_BUDGET_BYTES');
  });

  test('invalid value reports path', () => {
    const e = failure(() => resolveConfig({ file: { viewer: { theme: 'neon' } }, env: {} }));
    expect(e.message).toContain('viewer.theme');
  });

  test('formatConfig annotates sources', () => {
    const out = formatConfig(resolveConfig({ file: { title: 'a' }, env: {} }));
    expect(out).toContain('eagerBudgetBytes: 75000000 # from: default');
    expect(out).toContain('title: a # from: file');
    expect(out).toContain('# from: default');
  });
});

describe('JSON Schema', () => {
  test('committed schema is fresh', () => {
    const committed = readFileSync(new URL('../../schema/otel-html.schema.json', import.meta.url), 'utf8');
    expect(committed).toBe(writeJsonSchema());
  });
});

describe('prototype pollution', () => {
  const polluted = (): boolean => Object.hasOwn(Object.prototype, 'polluted');
  test.each([
    ['file', (o: unknown) => ({ file: o, env: {} })],
    ['flags', (o: unknown) => ({ flags: o as never, env: {} })],
  ])('%s layer with __proto__ key is rejected and does not pollute', (_name, build) => {
    for (const json of ['{"__proto__":{"polluted":1}}', '{"writer":{"__proto__":{"polluted":1}}}']) {
      const e = failure(() => resolveConfig(build(JSON.parse(json))));
      expect(e.code).toBe('invalid-config');
      expect(e.message).toContain('__proto__');
      expect(polluted()).toBe(false);
    }
  });
});
