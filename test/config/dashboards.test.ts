import { describe, expect, test } from 'vitest';
import { resolveApiConfig } from '../../src/api/report.js';
import { writeJsonSchema } from '../../src/config/json-schema.js';
import { formatConfig, resolveConfig } from '../../src/config/resolve.js';
import type { ConfigInput } from '../../src/config/schema.js';
import { OtelHtmlError } from '../../src/model/errors.js';
import { createTestWriter } from '../../test-support/writer-deps.js';

const dash = {
  id: 'ops',
  title: 'Ops',
  widgets: [{ type: 'traces' as const, x: 0, y: 0, w: 6, h: 6 }],
};

function failure(fn: () => unknown): OtelHtmlError {
  try {
    fn();
  } catch (e) {
    if (e instanceof OtelHtmlError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('dashboards in config', () => {
  test('defaults', () => {
    const { config } = resolveConfig({ env: {} });
    expect(config.dashboards).toEqual([]);
    expect(config.views).toEqual([]);
    expect(config.viewer.defaultDashboard).toBe('fusion');
    expect(config.viewer.home).toBe('traces');
  });

  test('source is the file label for a file and library API for flags', () => {
    const fromFile = resolveConfig({ file: { dashboards: [dash] }, env: {}, fileLabel: 'otel-html.yaml' });
    expect(fromFile.config.dashboards[0]?.source).toBe('otel-html.yaml');
    expect(resolveConfig({ file: { dashboards: [dash] }, env: {} }).config.dashboards[0]?.source).toBe(
      'config file',
    );
    const fromFlags = resolveConfig({ env: {}, flags: { dashboards: [dash] } });
    expect(fromFlags.config.dashboards[0]?.source).toBe('library API');
  });

  test('flags replace the file list wholesale', () => {
    const r = resolveConfig({
      file: { dashboards: [dash, { ...dash, id: 'other' }] },
      env: {},
      flags: { dashboards: [{ ...dash, id: 'mine' }] },
    });
    expect(r.config.dashboards.map((d) => d.dashboard.id)).toEqual(['mine']);
  });

  test('defaultDashboard must name fusion or a configured dashboard', () => {
    const e = failure(() => resolveConfig({ file: { viewer: { defaultDashboard: 'nope' } }, env: {} }));
    expect(e.message).toContain('viewer.defaultDashboard');
    expect(e.message).toContain('the id of a dashboard (fusion or one in dashboards)');
    const ok = resolveConfig({
      file: { dashboards: [dash], viewer: { defaultDashboard: 'ops', home: 'dashboards' } },
      env: {},
    });
    expect(ok.config.viewer.defaultDashboard).toBe('ops');
  });

  test('a bad widget query names its path', () => {
    const bad: ConfigInput = {
      dashboards: [{ ...dash, widgets: [{ type: 'traces', query: 'not ((valid', x: 0, y: 0, w: 6, h: 6 }] }],
    };
    const e = failure(() => resolveConfig({ file: bad, env: {} }));
    expect(e.message).toContain('dashboards.0.widgets.0.query');
  });

  test('formatConfig prints dashboards as written, with their source', () => {
    const out = formatConfig(resolveConfig({ file: { dashboards: [dash] }, env: {} }));
    expect(out).toMatch(/^dashboards:\n {2}# source: config file\n {2}- id: ops$/m);
    expect(out).toMatch(/^ {2}# from: file$/m);
    expect(out).not.toMatch(/^ *source:/m);
  });

  test('hostile text survives resolution unchanged', () => {
    const title = '</script><img src=x onerror=alert(1)>';
    const description = 'a\u2028b';
    const r = resolveConfig({ file: { dashboards: [{ ...dash, title, description }] }, env: {} });
    expect(r.config.dashboards[0]?.dashboard.title).toBe(title);
    expect(r.config.dashboards[0]?.dashboard.description).toBe(description);
  });

  test('the JSON Schema covers dashboards and flags echarts as unstable', () => {
    const json = writeJsonSchema();
    expect(json).toContain('"dashboards"');
    expect(json).toContain('Unstable');
    const schema = JSON.parse(json) as { properties: { dashboards: { default?: unknown } } };
    expect(schema.properties.dashboards.default).toEqual([]);
  });

  test('resolveApiConfig labels file dashboards with the file name, and object ones as library API', async () => {
    const w = createTestWriter();
    const yaml =
      'dashboards:\n  - id: ops\n    title: Ops\n    widgets: [{type: traces, x: 0, y: 0, w: 6, h: 6}]\n';
    await w.fs.writeBytes('/tmp/run/otel-html.yaml', new TextEncoder().encode(yaml));
    const fromPath = await resolveApiConfig(w.deps, '/tmp/run/otel-html.yaml', undefined);
    expect(fromPath.dashboards[0]?.source).toBe('otel-html.yaml');
    const fromObject = await resolveApiConfig(w.deps, { dashboards: [dash] }, undefined);
    expect(fromObject.dashboards[0]?.source).toBe('library API');
  });
});
