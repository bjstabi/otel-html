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

async function resolved(path: string = PATH) {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile(path, 'utf8'));
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
    expect(dash.widgets).toHaveLength(7);
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

  test('the Slowest steps toplist ranks the publisher step spans by max duration', async () => {
    const { config } = await resolved();
    const ws = ci(config).widgets;
    const steps = ws.find((w) => w.type === 'toplist' && w.title === 'Steps');
    const slow = ws.find((w) => w.type === 'toplist' && w.title === 'Slowest steps');
    if (steps?.type !== 'toplist' || slow?.type !== 'toplist') throw new Error('no toplist');
    expect(slow.measure).toBe('duration.max');
    expect(slow.groupBy).toBe('span.name');
    expect(slow.query).toBe(steps.query);
  });

  test('the Runs widget matches root spans and job spans', async () => {
    const { config } = await resolved();
    const runs = ci(config).widgets.find((w) => w.type === 'traces');
    const query = runs && 'query' in runs ? runs.query : null;
    expect(query).not.toBeNull();
    const cond = compileCondition(query ?? '', 'span');
    const inScope = (over: Parameters<typeof spanTarget>[0] = {}) => {
      const t = spanTarget(over);
      return { ...t, scope: { ...t.scope, name: 'otel-html-ci' } };
    };
    expect(cond.test(inScope({ parentSpanId: null, kind: SpanKind.INTERNAL }))).toBe(true);
    // the run span sits on the run's resource, so with `job` set only the job span can bring its trace back
    const jobSpan = new Map<string, AnyValue>([
      ['cicd.pipeline.task.run.id', { kind: 'string', value: '7' }],
    ]);
    expect(cond.test(inScope({ attributes: jobSpan }))).toBe(true);
    // a job skipped by its `if:` did not run in that run
    const skipped = new Map<string, AnyValue>([
      ...jobSpan,
      ['cicd.pipeline.task.run.result', { kind: 'string', value: 'skip' }],
    ]);
    expect(cond.test(inScope({ attributes: skipped }))).toBe(false);
    // a step or queued span does not
    const step = new Map<string, AnyValue>([['github.job.step.number', { kind: 'int', value: 3n }]]);
    expect(cond.test(inScope({ attributes: step }))).toBe(false);
    expect(cond.test(inScope())).toBe(false);
  });
});

const RUNS =
  'instrumentation_scope.name == "otel-html-ci" and (IsRootSpan() or (attributes["cicd.pipeline.task.run.id"] != nil and attributes["cicd.pipeline.task.run.result"] != "skip"))';

test.each([
  '.github/actions/otel-html-publish/otel-html-ci.yaml',
  '.github/otel-html-ci.yaml',
  'fixtures/dashboards.otel-html.yaml',
])('%s: Runs lists CI roots and unskipped job spans, nothing of another scope', async (path) => {
  const { config } = await resolved(path);
  const runs = ci(config).widgets.find((w) => w.title === 'Runs');
  if (runs === undefined || !('query' in runs)) throw new Error('no Runs widget');
  expect(runs.query).toBe(RUNS);
  const matches = compileCondition(RUNS, 'span');
  const target = (scope: string, root: boolean, result?: string) => {
    const attributes = new Map<string, AnyValue>();
    if (!root) {
      attributes.set('cicd.pipeline.task.run.id', { kind: 'string', value: '7' });
      if (result !== undefined)
        attributes.set('cicd.pipeline.task.run.result', { kind: 'string', value: result });
    }
    const t = spanTarget({ attributes, ...(root ? { parentSpanId: null } : {}) });
    return { ...t, scope: { ...t.scope, name: scope } };
  };
  expect(matches.test(target('otel-html-ci', true))).toBe(true);
  // the run whose root never arrived is still listed by its job span
  expect(matches.test(target('otel-html-ci', false, 'success'))).toBe(true);
  expect(matches.test(target('otel-html-ci', false, 'skip'))).toBe(false);
  expect(matches.test(target('vitest', true))).toBe(false);
});
