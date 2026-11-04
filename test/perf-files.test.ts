import { expect, test } from 'vitest';
import { perfFiles } from '../test-support/perf-files.js';

// Built by concatenation so this file's own source does not carry the tag and land in the perf pass.
const TAG = '@' + 'perf';
const sources: Record<string, string> = {
  'test/a.test.ts': `test('fast ${TAG}', () => {});`,
  'test/b.test.ts': "test('plain', () => {});",
  'test/viewer/c.test.ts': `test('layout ${TAG}', () => {});`,
};
const read = (f: string): string => sources[f.replaceAll('\\', '/')] ?? '';

test('the files whose source carries the tag, split into the node and viewer includes', () => {
  expect(perfFiles(Object.keys(sources), read)).toEqual({
    node: ['test/a.test.ts', 'test/viewer/c.test.ts'],
    viewer: ['test/viewer/c.test.ts'],
  });
});

test('Windows backslash paths come back with forward slashes, so they match as include patterns', () => {
  const windows = Object.keys(sources).map((f) => f.replaceAll('/', '\\'));
  expect(perfFiles(windows, read)).toEqual({
    node: ['test/a.test.ts', 'test/viewer/c.test.ts'],
    viewer: ['test/viewer/c.test.ts'],
  });
});
