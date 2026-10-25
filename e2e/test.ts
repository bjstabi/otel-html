import { test as base } from '@playwright/test';
import { baseUrlFor, type UrlKind } from './fixture.js';

export const test = base.extend({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    const kind = testInfo.project.name.split('-').at(-1);
    if (kind !== 'file' && kind !== 'http')
      throw new Error(`project ${testInfo.project.name} has no url kind`);
    await use(baseUrlFor(kind));
  },
});
export { expect } from '@playwright/test';

/** Same as `test`, but `baseURL` points at the hostile-content report. */
export const hostileTest = base.extend({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    const kind = testInfo.project.name.split('-').at(-1);
    if (kind !== 'file' && kind !== 'http')
      throw new Error(`project ${testInfo.project.name} has no url kind`);
    const k: UrlKind = kind;
    await use(baseUrlFor(k, 'hostile'));
  },
});
