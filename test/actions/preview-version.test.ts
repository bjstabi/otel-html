import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';

// The action installs Playwright by version; it must match the one the repo tests with.
test('the action installs the Playwright version package.json pins', () => {
  const action = readFileSync(
    resolve(__dirname, '../../.github/actions/otel-html-publish/action.yml'),
    'utf8',
  );
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  const found = [...action.matchAll(/@playwright\/test@([\w.-]+)/g)].map((m) => m[1]);
  expect(found.length).toBeGreaterThan(0);
  for (const v of found) expect(v).toBe(pkg.devDependencies['@playwright/test']);
});
