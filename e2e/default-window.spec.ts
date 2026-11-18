import type { Locator } from '@playwright/test';
import { expect, HTTP, test } from './test.js';

// Query-scaling plan, Task 25: a report built with viewer.defaultWindow 1h over a range of nearly 12 h opens on its
// last hour with no `t` in the URL; "Entire run" stays across a reload as `t=all`.

/** The `N traces` count in a widget's subtitle. */
async function traceCount(w: Locator): Promise<number> {
  const re = /(?:^|\D)(\d+) traces?/;
  await expect(w).toContainText(re);
  return Number(re.exec((await w.textContent()) ?? '')?.[1]);
}

test(
  'a report with defaultWindow opens on the default, and Entire run survives a reload',
  HTTP,
  async ({ page, reportUrl }) => {
    await page.goto(`${reportUrl('default-window')}/index.html#/dashboards/fusion`);
    // the filter bar's range dropdown says the preset in words
    const range = page.getByRole('button', { name: 'Time range' });
    const choose = async (name: string) => {
      await range.click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    await expect(range).toHaveText('last 1 hour');
    expect(new URL(page.url()).hash).not.toContain('t=');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // 48 traces 15 minutes apart; the range ends 3 ms after the last start, so the last hour overlaps 5 of 48 (the trace at 10:45 ends inside it)
    const traces = page.locator('[data-widget="traces"]');
    await expect.poll(() => traceCount(traces)).toBe(5);

    await choose('Entire run');
    await expect(range).toHaveText('entire run');
    await expect.poll(() => new URL(page.url()).hash).toContain('t=all');
    await expect.poll(() => traceCount(traces)).toBe(48);

    await page.reload();
    await expect(range).toHaveText('entire run');
    await expect.poll(() => traceCount(traces)).toBe(48);

    await choose('1h');
    await expect(range).toHaveText('last 1 hour');
    await expect.poll(() => new URL(page.url()).hash).not.toContain('t=');
  },
);
