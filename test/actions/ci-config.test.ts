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

describe('the CI dashboard configs', () => {
  test.each(FILES)('%s sets viewer.defaultWindow to 7d', (f) => {
    const { viewer } = parse(text(f)) as Config;
    expect(viewer).toEqual({ home: 'dashboards', defaultDashboard: 'ci', defaultWindow: '7d' });
  });
});
