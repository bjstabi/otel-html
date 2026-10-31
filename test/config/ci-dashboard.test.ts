import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { type ResolveResult, resolveConfig } from '../../src/config/resolve.js';
import type { AnyValue } from '../../src/model/anyvalue.js';
import { SpanKind } from '../../src/model/records.js';
import { compileCondition } from '../../src/ottl/compile.js';
import { compileBy } from '../../src/query/metric-paths.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { spanTarget } from '../ottl/fixtures.js';

const PATH = '.github/actions/otel-html-publish/otel-html-ci.yaml';

const ci = (config: ResolveResult['config']) => {
  const d = config.dashboards.find((x) => x.dashboard.id === 'ci')?.dashboard;
  if (d === undefined) throw new Error('no ci dashboard');
  return d;
};

async function resolved() {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile(PATH, 'utf8'));
  return resolveConfig({
    file: await loadConfigFile(fs, '/c/ci.yaml'),
    env: {},
    fileLabel: 'otel-html-ci.yaml',
  });
}

describe('.github/actions/otel-html-publish/otel-html-ci.yaml', () => {
  test('loads and resolves to the CI dashboard as the home page', async () => {
    const { config } = await resolved();
    expect(config.title).toBe('CI');
    expect(config.viewer.home).toBe('dashboards');
    expect(config.viewer.defaultDashboard).toBe('ci');
    const dash = ci(config);
    expect(dash.widgets).toHaveLength(6);
    // `workflow` tells ci and load apart now that both share one rolling page
    expect(dash.variables.map((v) => [v.key, v.label])).toEqual([
      ['cicd.pipeline.name', 'workflow'],
      ['cicd.pipeline.run.id', 'run'],
      ['cicd.pipeline.task.name', 'job'],
    ]);
  });

  test('metric widgets group by a data point attribute the viewer can run', async () => {
    const { config } = await resolved();
    const metrics = ci(config).widgets.flatMap((w) => (w.type === 'metric' ? (w.queries ?? []) : []));
    expect(metrics.map((q) => q.by)).toEqual([
      ['attributes["cicd.pipeline.task.name"]'],
      ['attributes["cicd.pipeline.task.name"]'],
    ]);
    for (const q of metrics) expect(() => compileBy(q.by[0] ?? '')).not.toThrow();
  });

  test('the Steps toplist counts the publisher step spans by name', async () => {
    const { config } = await resolved();
    const top = ci(config).widgets.find((w) => w.type === 'toplist');
    if (top?.type !== 'toplist') throw new Error('no toplist');
    expect(top.title).toBe('Steps');
    expect(top.groupBy).toBe('span.name');
    const cond = compileCondition(top.query ?? '', 'span');
    const target = (scope: string, attributes: Map<string, AnyValue>) => {
      const t = spanTarget({ attributes });
      return { ...t, scope: { ...t.scope, name: scope } };
    };
    const step = new Map<string, AnyValue>([['github.job.step.number', { kind: 'int', value: 3n }]]);
    expect(cond.test(target('otel-html-ci', step))).toBe(true);
    // a job, queued or run span of the publisher, and a span of the job shell's own report
    expect(cond.test(target('otel-html-ci', new Map()))).toBe(false);
    expect(cond.test(target('otel-html', step))).toBe(false);
  });

  test('the Runs widget selects root spans only', async () => {
    const { config } = await resolved();
    const runs = ci(config).widgets.find((w) => w.type === 'traces');
    const query = runs && 'query' in runs ? runs.query : null;
    expect(query).not.toBeNull();
    const cond = compileCondition(query ?? '', 'span');
    expect(cond.test(spanTarget({ parentSpanId: null, kind: SpanKind.INTERNAL }))).toBe(true);
    expect(cond.test(spanTarget())).toBe(false);
  });
});
