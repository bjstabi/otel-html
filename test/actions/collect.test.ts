import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe.each(['setup', 'collect', 'publish'])('the %s action', (name) => {
  const action = readFileSync(`.github/actions/otel-html-${name}/action.yml`, 'utf8');

  test('does not dispatch or wake a deployer', () => {
    expect(action).not.toContain('ci dispatch');
    expect(action).not.toContain('dispatch-app');
    expect(action).not.toContain('deployer-workflow');
    expect(action).not.toContain('DISPATCH_TOKEN');
  });
});

test('the deploy accepts pr-cleanup.yml and ci-report.yml updates by default, in the action and the CLI', () => {
  const action = readFileSync('.github/actions/otel-html-deploy/action.yml', 'utf8');
  expect(action).toMatch(/report-workflow:[\s\S]*?default: pr-cleanup\.yml,ci-report\.yml/);
  expect(readFileSync('src/cli/commands/ci.ts', 'utf8')).toContain("'pr-cleanup.yml,ci-report.yml'");
});
