import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { resolveConfig } from '../../../src/config/resolve.js';
import type { Widget } from '../../../src/dashboards/schema.js';

const SHIPPED = '.github/actions/otel-html-publish/otel-html-ci.yaml';
const COPY = '.github/otel-html-ci.yaml';
const DEMO = 'fixtures/dashboards.otel-html.yaml';

interface RawConfig {
  dashboards: { id?: string; widgets: { pipeline?: string }[] }[];
}

const raw = async (path: string) => parse(await readFile(path, 'utf8')) as RawConfig;

async function dashboard(path: string) {
  const { config } = resolveConfig({ file: await raw(path), env: {}, fileLabel: path });
  const dash = config.dashboards.find((x) => x.dashboard.id === 'ci')?.dashboard;
  if (dash === undefined) throw new Error('no ci dashboard');
  return dash;
}

const widgets = async (path: string): Promise<Widget[]> => (await dashboard(path)).widgets;

/** Spec §6: the view (and the stat) to its `x,y,w,h`. */
const LAYOUT: [string, [number, number, number, number]][] = [
  ['stat:success-rate', [0, 0, 2, 6]],
  ['stat:median-run', [2, 0, 2, 6]],
  ['stat:cache', [4, 0, 2, 6]],
  ['stat:minutes', [6, 0, 2, 6]],
  ['stat:queue-p95', [8, 0, 2, 6]],
  ['stat:reruns', [10, 0, 2, 6]],
  ['runs-trend', [0, 6, 7, 11]],
  ['runs', [7, 6, 5, 11]],
  ['jobs', [0, 17, 12, 14]],
  ['status-grid', [0, 31, 12, 12]],
  ['failures', [0, 43, 7, 10]],
  ['triggers', [7, 43, 5, 10]],
  ['queue', [0, 53, 5, 9]],
  ['minutes', [5, 53, 7, 9]],
  ['tests', [0, 62, 12, 16]],
];

const name = (w: Widget): string =>
  w.type === 'cicd' ? (w.stat === null ? w.view : `${w.view}:${w.stat}`) : w.type;

describe('CI dashboard configs', () => {
  test.each([SHIPPED, COPY, DEMO])('%s: 15 cicd widgets at the spec positions', async (path) => {
    const ws = await widgets(path);
    expect(ws.every((w) => w.type === 'cicd')).toBe(true);
    expect(ws.map((w) => [name(w), [w.x, w.y, w.w, w.h]])).toEqual(LAYOUT);
  });

  test.each([SHIPPED, COPY])('%s: variables, quick filters and the 7d window', async (path) => {
    const d = await dashboard(path);
    expect(d.variables.map((v) => [v.key, v.label])).toEqual([
      ['vcs.ref.head.name', 'branch'],
      ['cicd.pipeline.trigger', 'trigger'],
      ['cicd.pipeline.task.name', 'job'],
      ['cicd.worker.labels', 'runner'],
    ]);
    expect(d.quick).toEqual([
      { label: 'main', set: { 'vcs.ref.head.name': 'main', 'cicd.pipeline.trigger': null } },
      { label: 'pull requests', set: { 'vcs.ref.head.name': null, 'cicd.pipeline.trigger': 'pull_request' } },
      { label: 'all', set: { 'vcs.ref.head.name': null, 'cicd.pipeline.trigger': null } },
    ]);
    const { config } = resolveConfig({ file: await raw(path), env: {}, fileLabel: path });
    expect(config.viewer.defaultWindow).toBe('7d');
  });

  test('no two widgets overlap, and all fit the grid', async () => {
    for (const path of [SHIPPED, COPY]) {
      const ws = await widgets(path);
      for (const [i, a] of ws.entries()) {
        expect(a.x + a.w, `${path}: ${name(a)} fits the grid`).toBeLessThanOrEqual(12);
        for (const b of ws.slice(i + 1)) {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${path}: ${name(a)} and ${name(b)}`).toBe(true);
        }
      }
    }
  });

  test('the repo copy differs only by pipeline: ci on every widget', async () => {
    const shipped = await raw(SHIPPED);
    const copy = await raw(COPY);
    expect(shipped.dashboards[0]?.widgets.some((w) => w.pipeline !== undefined)).toBe(false);
    for (const w of copy.dashboards[0]?.widgets ?? []) {
      expect(w.pipeline).toBe('ci');
      delete w.pipeline;
    }
    expect(copy).toEqual(shipped);
  });

  test('the demo config carries the repo copy verbatim', async () => {
    const demo = (await raw(DEMO)).dashboards.find((d) => d.id === 'ci');
    expect(demo).toEqual((await raw(COPY)).dashboards[0]);
  });
});
