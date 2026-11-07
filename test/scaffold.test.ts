import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
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

test('runtime dependencies are exactly what the library and CLI import', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const runtime = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)]);
  const imported = new Set<string>();
  // every .ts/.tsx under src/ except src/viewer/, both quote styles, `import type` included
  for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
    if (file.startsWith(`viewer${sep}`) || !/\.tsx?$/.test(file)) continue;
    const source = readFileSync(join('src', file), 'utf8');
    // statement-anchored, so prose like "came from'" in a string is not an import
    const pattern = /^(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]/gm;
    for (const m of source.matchAll(pattern)) {
      const spec = m[1] ?? m[2] ?? '';
      if (spec.startsWith('.')) continue;
      if (spec.startsWith('node:')) continue;
      imported.add(
        spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec),
      );
    }
  }
  for (const name of imported)
    expect(runtime.has(name), `${name} is imported but not a dependency`).toBe(true);
  // Task 2.1 removes this exemption: src/query/sql imports @uwdata/mosaic-sql from then on (until then only src/viewer does).
  const notYetImported = new Set(['@uwdata/mosaic-sql']);
  for (const name of Object.keys(pkg.dependencies).filter((n) => !notYetImported.has(n)))
    expect(imported.has(name), `${name} is never imported`).toBe(true);
  expect(Object.keys(pkg.dependencies).sort()).toEqual([
    '@bufbuild/protobuf',
    '@grpc/grpc-js',
    '@lezer/common',
    '@lezer/lr',
    '@opentelemetry/api',
    '@opentelemetry/resources',
    '@uwdata/mosaic-sql',
    'apache-arrow',
    'commander',
    'parquet-wasm',
    'yaml',
    'zod',
  ]);
});
