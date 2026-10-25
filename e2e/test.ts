import { test as base } from '@playwright/test';
import { baseUrlFor } from './fixture.js';

export const test = base.extend({
  baseURL: async ({ baseURL: _unused }, use, testInfo) => {
    const kind = testInfo.project.name.split('-').at(-1);
    if (kind !== 'file' && kind !== 'http')
      throw new Error(`project ${testInfo.project.name} has no url kind`);
    await use(baseUrlFor(kind));
  },
});
export { expect } from '@playwright/test';
