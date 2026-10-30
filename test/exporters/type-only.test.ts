import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SDK_IMPORT = /^(?:import|export)\s[^;]*?from\s+'@opentelemetry\/(?:sdk-|core)[^']*'/gm;

function sourceFiles(dir: string, prefix: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.ts') && f.startsWith(prefix))
    .map((f) => join(dir, f));
}

test('exporters and SDK mappers import @opentelemetry/sdk-* and core as types only', () => {
  const files = [...sourceFiles('src/exporters', ''), ...sourceFiles('src/model', 'sdk-')];
  expect(files.length).toBeGreaterThan(1);
  const offenders: string[] = [];
  let seen = 0;
  for (const file of files) {
    for (const statement of readFileSync(join(ROOT, file), 'utf8').match(SDK_IMPORT) ?? []) {
      seen += 1;
      if (!/^(?:import|export) type\s/.test(statement))
        offenders.push(`${file}: ${statement.split('\n')[0]}`);
    }
  }
  expect(seen).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
