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
    expect(config.viewer).not.toHaveProperty('eagerBudgetBytes');
    expect(config.writer.chunkTargetBytes).toBe(4_000_000);
    expect(config.writer.drop.traces.span).toEqual([]);
    expect(sources.get('viewer.theme')).toBe('default');
  });

  test('the chunk writer metric keys are gone: writer.metricSeriesCap and metricExemplars are unknown', () => {
    for (const key of ['metricSeriesCap', 'metricExemplars']) {
      const e = failure(() => resolveConfig({ file: { writer: { [key]: 1 } }, env: {} }));
      expect(e.code).toBe('invalid-config');
      expect(e.message).toContain(key);
    }
  });

  test('format-4 writer keys: defaults, bounds and the env binding', () => {
    const { config } = resolveConfig({ env: {} });
    expect(config.writer.rowGroupRows).toBe(50_000);
    expect(config.writer.statisticsKeys).toEqual([]);
    expect(config.writer.localWarnBytes).toBe(256_000_000);
    expect(config.writer.compactOnMerge).toBe(false);
    expect(config.writer.assetsBase).toBe('assets/');
    const bad = (writer: object) => failure(() => resolveConfig({ file: { writer }, env: {} }));
    expect(bad({ rowGroupRows: 10 }).message).toContain('writer.rowGroupRows');
    expect(bad({ rowGroupRows: 100_001 }).message).toContain('writer.rowGroupRows');
    expect(bad({ format: 'site', assetsBase: '/x' }).message).toContain('assets/ or a relative path');
    expect(
      resolveConfig({ file: { writer: { format: 'site', compactOnMerge: true } }, env: {} }).config.writer
        .compactOnMerge,
    ).toBe(true);
    const f = bad({ format: 'parquet' }).message;
    expect(f).toContain('writer.format');
    for (const v of ['local', 'site']) expect(f).toContain(v);
    expect(resolveConfig({ env: { OTEL_HTML_FORMAT: 'site' } }).config.writer.format).toBe('site');
    expect(
      resolveConfig({
        file: { writer: { assetsBase: '../../assets/0.3.0/' } },
        env: { OTEL_HTML_FORMAT: 'site' },
      }).config.writer.assetsBase,
    ).toBe('../../assets/0.3.0/');
    expect(
      resolveConfig({ file: { writer: { assetsBase: '../../assets/0.3.0/' } }, env: {} }).config.writer
        .assetsBase,
    ).toBe('../../assets/0.3.0/');
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
      env: { OTEL_HTML_TITLE: 'from env' },
    });
    expect(r.config.writer.drop.traces.span).toEqual(['name == "x"']);
    expect(r.sources.get('writer.drop.traces.span')).toBe('file');
    expect(r.config.title).toBe('from env');
    expect(r.sources.get('title')).toBe('env');
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

  test('a file key containing a dot is an unknown top-level key (#176)', () => {
    const e = failure(() => resolveConfig({ file: { 'writer.chunkTargetBytes': 5 }, env: {} }));
    expect(e.code).toBe('invalid-config');
    expect(e.message).toContain('writer.chunkTargetBytes: unrecognized key');
    // the nested spelling still works
    expect(
      resolveConfig({ file: { writer: { chunkTargetBytes: 5 } }, env: {} }).config.writer.chunkTargetBytes,
    ).toBe(5);
  });

  test('a flag key containing a dot is an unknown key too', () => {
    const e = failure(() => resolveConfig({ flags: { 'viewer.theme': 'dark' } as never, env: {} }));
    expect(e.message).toContain('viewer.theme: unrecognized key');
  });

  test('a layer setting a path through a non-object reports the non-object (#176)', () => {
    const e = failure(() => resolveConfig({ file: { writer: 5 }, env: { OTEL_HTML_FORMAT: 'site' } }));
    expect(e.code).toBe('invalid-config');
    expect(e.message).toContain('writer: expected object, got 5');
  });

  test('invalid value reports path', () => {
    const e = failure(() => resolveConfig({ file: { viewer: { theme: 'neon' } }, env: {} }));
    expect(e.message).toContain('viewer.theme');
  });

  test('formatConfig annotates sources', () => {
    const out = formatConfig(resolveConfig({ file: { title: 'a' }, env: {} }));
    expect(out).toContain('listCap: 10000 # from: default');
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

describe('writer.format after the chunk format', () => {
  const CHUNKS_MESSAGE =
    'format 3 (chunks) is no longer written; use local or site (otel-html merge converts an older report)';

  test('defaults to local', () => {
    const { config, sources } = resolveConfig({ env: {} });
    expect(config.writer.format).toBe('local');
    expect(sources.get('writer.format')).toBe('default');
  });

  test('chunks fails invalid-config with the retirement message, from file, env and flag', () => {
    for (const input of [
      { file: { writer: { format: 'chunks' } }, env: {} },
      { env: { OTEL_HTML_FORMAT: 'chunks' } },
      { flags: { writer: { format: 'chunks' } } as never, env: {} },
    ]) {
      const e = failure(() => resolveConfig(input));
      expect(e.code).toBe('invalid-config');
      expect(e.message).toContain(CHUNKS_MESSAGE);
    }
  });

  test('assetsBase and compactOnMerge need no explicit format any more', () => {
    const { config } = resolveConfig({
      file: { writer: { assetsBase: '../../assets/0.3.0/', compactOnMerge: true } },
      env: {},
    });
    expect(config.writer.assetsBase).toBe('../../assets/0.3.0/');
    expect(config.writer.compactOnMerge).toBe(true);
  });

  test('viewer.eagerBudgetBytes is an unknown key, and OTEL_HTML_EAGER_BUDGET_BYTES is not read', () => {
    const e = failure(() => resolveConfig({ file: { viewer: { eagerBudgetBytes: 5 } }, env: {} }));
    expect(e.code).toBe('invalid-config');
    expect(e.message).toContain('viewer.eagerBudgetBytes: unrecognized key');
    expect(resolveConfig({ env: { OTEL_HTML_EAGER_BUDGET_BYTES: '5' } }).config.viewer).not.toHaveProperty(
      'eagerBudgetBytes',
    );
  });
});
