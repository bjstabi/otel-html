import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const FILES = ['.github/otel-html-ci.yaml', '.github/actions/otel-html-publish/otel-html-ci.yaml'];
const text = (f: string): string => readFileSync(resolve(__dirname, '../..', f), 'utf8');

describe('the CI dashboard configs', () => {
  test.each(FILES)('%s sets viewer.defaultWindow to 7d', (f) => {
    const { viewer } = parse(text(f)) as { viewer: Record<string, unknown> };
    expect(viewer).toEqual({ home: 'dashboards', defaultDashboard: 'ci', defaultWindow: '7d' });
  });
});
