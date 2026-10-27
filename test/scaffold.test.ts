import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('strict compiler flags are on', () => {
  const base = JSON.parse(readFileSync('tsconfig.base.json', 'utf8')).compilerOptions;
  for (const flag of [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noPropertyAccessFromIndexSignature',
    'noFallthroughCasesInSwitch',
    'verbatimModuleSyntax',
    'isolatedDeclarations',
  ]) {
    expect(base[flag], flag).toBe(true);
  }
});
