import { test as base } from '@playwright/test';
import { baseUrlFor, type ReportName, type UrlKind } from './fixture.js';

function kindOf(projectName: string): UrlKind {
  const kind = projectName.split('-').at(-1);
  if (kind !== 'file' && kind !== 'http') throw new Error(`project ${projectName} has no url kind`);
  return kind;
}

export const test = base.extend<{ reportUrl: (name: ReportName) => string }>({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    await use(baseUrlFor(kindOf(testInfo.project.name)));
  },
  reportUrl: async ({ baseURL: _unused }, use, testInfo) => {
    await use((name) => baseUrlFor(kindOf(testInfo.project.name), name));
  },
});
export { expect } from '@playwright/test';

/** Same as `test`, but `baseURL` points at the hostile-content report. */
export const hostileTest = base.extend({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    await use(baseUrlFor(kindOf(testInfo.project.name), 'hostile'));
  },
});
