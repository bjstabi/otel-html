import { globSync, readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { perfFiles } from '../../test-support/perf-files.ts';

interface Table {
  unit: Record<string, number>;
  'unit-perf': Record<string, number>;
  e2e: Record<string, Record<string, number>>;
}
const table = JSON.parse(readFileSync('test-support/shard-weights.json', 'utf8')) as Table;
const slash = (f: string): string => f.replaceAll('\\', '/');

// every file a sharded project runs has a recorded weight; a missing one would weigh the median and unbalance the shards
it('every unit test file has a weight', () => {
  const files = globSync('test/**/*.test.{ts,tsx}').map(slash);
  expect(files.filter((f) => table.unit[f] === undefined)).toEqual([]);
});
it('every file with an @perf test has a weight in the perf pass', () => {
  const perf = perfFiles(globSync('test/**/*.test.{ts,tsx}'), (f) => readFileSync(f, 'utf8'));
  expect(
    [...perf.node, ...perf.viewer].map(slash).filter((f) => table['unit-perf'][f] === undefined),
  ).toEqual([]);
});
it.each(['chromium', 'firefox', 'webkit'])('every e2e spec has a %s weight', (browser) => {
  const specs = readdirSync('e2e').filter((f) => f.endsWith('.spec.ts'));
  expect(specs.filter((s) => table.e2e[browser]?.[s] === undefined)).toEqual([]);
});
