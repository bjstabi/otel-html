import type { Page } from '@playwright/test';

/** A stub clipboard records what the Copy buttons write, so the assertion is the same in every browser and under file:. */
export async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w: Window & { __copied?: string } = window;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string): Promise<void> => {
          w.__copied = t;
          return Promise.resolve();
        },
      },
    });
  });
}

export const copied = (page: Page): Promise<string> =>
  page.evaluate(() => (window as Window & { __copied?: string }).__copied ?? '');
