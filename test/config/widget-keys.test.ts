import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { ConfigSchema } from '../../src/config/schema.js';
import { widgetConditionKeys } from '../../src/config/widget-keys.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

async function ciDashboards() {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile('test-support/legacy-ci.otel-html.yaml', 'utf8'));
  const { config } = resolveConfig({
    file: await loadConfigFile(fs, '/c/ci.yaml'),
    env: {},
    fileLabel: 'otel-html-ci.yaml',
  });
  return config.dashboards;
}

const layout = { x: 0, w: 6, h: 6 };
/** The widgets stacked one below the other. */
const dashboardWith = (widgets: object[]) =>
  ConfigSchema.parse({
    dashboards: [{ id: 'd', title: 'D', widgets: widgets.map((w, i) => ({ ...w, y: i * 6 })) }],
  }).dashboards;

describe('widgetConditionKeys', () => {
  test('the CI dashboard names the step key, and not the keys only its traces widget tests', async () => {
    const keys = widgetConditionKeys(await ciDashboards());
    expect(keys).toContain('attr:github.job.step.number');
    expect(keys).not.toContain('attr:cicd.pipeline.task.run.id');
    expect(keys).not.toContain('attr:cicd.pipeline.task.run.result');
    expect(keys).toEqual([...new Set(keys)].sort());
  });

  test('toplist and table conditions by equality or presence, resource keys included', () => {
    const keys = widgetConditionKeys(
      dashboardWith([
        {
          type: 'toplist',
          signal: 'spans',
          groupBy: 'span.name',
          ...layout,
          query: 'attributes["a"] != nil and not (resource.attributes["r"] == "x")',
        },
        {
          type: 'table',
          signal: 'logs',
          groupBy: 'service.name',
          ...layout,
          query: 'attributes["b"] == "y" or attributes["a"] == 1',
        },
        { type: 'traces', ...layout, query: 'attributes["c"] != "z"' },
      ]),
    );
    expect(keys).toEqual(['attr:a', 'attr:b', 'resource:r']);
  });

  test('a metric widget and ordering comparisons contribute nothing', () => {
    const keys = widgetConditionKeys(
      dashboardWith([
        {
          type: 'metric',
          ...layout,
          queries: [{ id: 'a', metric: 'm', where: 'attributes["w"] == "v"', show: 'avg' }],
        },
        { type: 'toplist', signal: 'spans', groupBy: 'span.name', ...layout, query: 'attributes["n"] > 3' },
        { type: 'timeline', ...layout },
      ]),
    );
    expect(keys).toEqual([]);
  });
});
