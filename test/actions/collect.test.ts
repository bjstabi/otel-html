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
