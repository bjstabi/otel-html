import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the collect action wakes the deployer without watching it start', () => {
  const action = readFileSync('.github/actions/otel-html-collect/action.yml', 'utf8');
  expect(action).toContain('ci dispatch --workflow "$WORKFLOW" --no-watch');
});
