/** The tag a timing-sensitive test carries in its name; `vitest.config.ts` runs those tests in a pass of their own. */
export const PERF_TAG = '@perf';

/**
 * The test files whose source carries `PERF_TAG`, as include patterns for the node project (all of them; its exclude
 * drops the viewer's) and the viewer project. Paths come back with forward slashes: Windows' `globSync` returns
 * backslashes, which match nothing as include patterns.
 */
export function perfFiles(
  paths: readonly string[],
  read: (path: string) => string,
): { node: string[]; viewer: string[] } {
  const node = paths.filter((f) => read(f).includes(PERF_TAG)).map((f) => f.replaceAll('\\', '/'));
  return { node, viewer: node.filter((f) => f.startsWith('test/viewer/')) };
}
