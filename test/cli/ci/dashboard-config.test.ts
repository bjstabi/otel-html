import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { resolveConfig } from '../../../src/config/resolve.js';
import type { Widget } from '../../../src/dashboards/schema.js';
import { DEFAULT_RUN_CONTROLS } from '../../../src/dashboards/schema.js';

const SHIPPED = '.github/actions/otel-html-publish/otel-html-ci.yaml';
const COPY = '.github/otel-html-ci.yaml';
const CI_ONLY = 'resource.attributes["cicd.pipeline.name"] == "ci"';
const FAILED_WHEN =
  'attributes["cicd.pipeline.task.run.result"] == "failure" or attributes["cicd.pipeline.task.run.result"] == "timeout" or attributes["cicd.pipeline.task.run.result"] == "error"';

interface RawConfig {
  dashboards: { widgets: { title?: string; queries?: { where?: string }[] }[] }[];
}

const raw = async (path: string) => parse(await readFile(path, 'utf8')) as RawConfig;

async function widgets(path: string): Promise<Widget[]> {
  const { config } = resolveConfig({ file: await raw(path), env: {}, fileLabel: path });
  const dash = config.dashboards.find((x) => x.dashboard.id === 'ci')?.dashboard;
  if (dash === undefined) throw new Error('no ci dashboard');
  return dash.widgets;
}

const metric = (ws: Widget[], title: string) => {
  const w = ws.find((x) => x.type === 'metric' && x.title === title);
  if (w?.type !== 'metric') throw new Error(`no ${title}`);
  return w;
};

describe('CI dashboard configs', () => {
  test.each([SHIPPED, COPY])('%s parses through the dashboard schema', async (path) => {
    await expect(widgets(path)).resolves.toHaveLength(6);
  });

  test('Job duration is a full-width run chart with the failure rule', async () => {
    const w = metric(await widgets(SHIPPED), 'Job duration');
    expect(w).toMatchObject({ w: 12, h: 20, failedWhen: FAILED_WHEN });
    expect(w.runBy).toBe('resource.attributes["cicd.pipeline.run.id"]');
    expect(w.controls).toEqual(DEFAULT_RUN_CONTROLS);
  });

  test('Queue time is an unsplit run chart without a failure rule', async () => {
    const ws = await widgets(SHIPPED);
    const w = metric(ws, 'Queue time');
    expect(w).toMatchObject({ w: 6, h: 12, failedWhen: null });
    expect(w.runBy).toBe('resource.attributes["cicd.pipeline.run.id"]');
    expect(w.controls?.split).toBe(false);
    expect(ws.find((x) => x.type === 'toplist')?.h).toBe(12);
  });

  test('no two widgets overlap', async () => {
    for (const path of [SHIPPED, COPY]) {
      const ws = await widgets(path);
      for (const [i, a] of ws.entries()) {
        for (const b of ws.slice(i + 1)) {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${path}: ${a.type} and ${b.type}`).toBe(true);
        }
      }
    }
  });

  test('the repo copy differs only by the ci filter', async () => {
    const shipped = await raw(SHIPPED);
    const copy = await raw(COPY);
    const ws = copy.dashboards[0]?.widgets ?? [];
    for (const title of ['Job duration', 'Queue time']) {
      const q = ws.find((w) => w.title === title)?.queries?.[0];
      expect(q?.where).toBe(CI_ONLY);
      delete q?.where;
    }
    expect(copy).toEqual(shipped);
  });
});
