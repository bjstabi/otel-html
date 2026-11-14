import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const FILES = ['.github/otel-html-ci.yaml', '.github/actions/otel-html-publish/otel-html-ci.yaml'];
const ROOT = resolve(__dirname, '../..');
const text = (f: string): string => readFileSync(resolve(ROOT, f), 'utf8');

interface Config {
  viewer: Record<string, unknown>;
  [key: string]: unknown;
}

/** The file as main has it, or null where git has no `main` (a shallow CI checkout). */
function onMain(f: string): string | null {
  for (const ref of ['main', 'origin/main']) {
    const r = spawnSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) return r.stdout;
  }
  return null;
}

describe('the CI dashboard configs', () => {
  test.each(FILES)('%s sets viewer.defaultWindow to 7d', (f) => {
    const { viewer } = parse(text(f)) as Config;
    expect(viewer).toEqual({ home: 'dashboards', defaultDashboard: 'ci', defaultWindow: '7d' });
  });

  test.each(FILES)('%s is otherwise equal to main', (f) => {
    const main = onMain(f);
    if (main === null) return; // no history to compare with
    const bare = (c: Config): Config => {
      const { defaultWindow: _w, ...viewer } = c.viewer;
      return { ...c, viewer };
    };
    expect(bare(parse(text(f)) as Config)).toEqual(bare(parse(main) as Config));
  });
});
