import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { loadConfigFile } from '../../src/config/load.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';

const PATHS = [
  '.github/actions/otel-html-publish/otel-html-ci.yaml',
  '.github/otel-html-ci.yaml',
  'fixtures/dashboards.otel-html.yaml',
];

async function ciDashboard(path: string) {
  const fs = createMemoryFileSystem();
  await fs.mkdirp('/c');
  await fs.writeTextAtomic('/c/ci.yaml', await readFile(path, 'utf8'));
  const { config } = resolveConfig({
    file: await loadConfigFile(fs, '/c/ci.yaml'),
    env: {},
    fileLabel: 'otel-html-ci.yaml',
  });
  const dash = config.dashboards.find((x) => x.dashboard.id === 'ci')?.dashboard;
  if (dash === undefined) throw new Error('no ci dashboard');
  return { config, dash };
}

describe('the CI dashboard', () => {
  test.each(PATHS)('%s resolves to 15 cicd widgets that need no query', async (path) => {
    const { dash } = await ciDashboard(path);
    expect(dash.widgets).toHaveLength(15);
    for (const w of dash.widgets) expect(w.type).toBe('cicd');
  });

  test.each(PATHS.slice(0, 2))('%s is the home page, as the CI dashboard', async (path) => {
    const { config } = await ciDashboard(path);
    expect(config.title).toBe('CI');
    expect(config.viewer.home).toBe('dashboards');
    expect(config.viewer.defaultDashboard).toBe('ci');
  });
});
