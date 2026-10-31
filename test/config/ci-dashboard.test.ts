import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { SpanKind } from '../../src/model/records.js';
import { compileCondition } from '../../src/ottl/compile.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { spanTarget } from '../ottl/fixtures.js';

const PATH = '.github/otel-html-ci.yaml';

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

describe('.github/otel-html-ci.yaml', () => {
  test('loads and resolves to the CI dashboard as the home page', async () => {
    const { config } = await resolved();
    expect(config.title).toBe('CI');
    expect(config.viewer.home).toBe('dashboards');
    expect(config.viewer.defaultDashboard).toBe('ci');
    const ci = config.dashboards.find((d) => d.dashboard.id === 'ci')?.dashboard;
    expect(ci?.widgets).toHaveLength(6);
    expect(ci?.variables.map((v) => [v.key, v.label])).toEqual([
      ['cicd.pipeline.run.id', 'run'],
      ['cicd.pipeline.task.name', 'job'],
    ]);
  });

  test('the Runs widget selects root spans only', async () => {
    const { config } = await resolved();
    const runs = config.dashboards[0]?.dashboard.widgets.find((w) => w.type === 'traces');
    const query = runs && 'query' in runs ? runs.query : null;
    expect(query).not.toBeNull();
    const cond = compileCondition(query ?? '', 'span');
    expect(cond.test(spanTarget({ parentSpanId: null, kind: SpanKind.INTERNAL }))).toBe(true);
    expect(cond.test(spanTarget())).toBe(false);
  });
});
