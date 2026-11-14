import type { Locator } from '@playwright/test';
import { expect, HTTP, test } from './test.js';

// Query-scaling plan, Task 25: a report built with viewer.defaultWindow 6h over a range of nearly 12 h opens on its
// last 6 h with no `t` in the URL; "Entire run" stays across a reload as `t=all`.

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
    const pressed = (name: string) => page.getByRole('button', { name, exact: true });
    await expect(pressed('6h')).toHaveAttribute('aria-pressed', 'true');
    await expect(pressed('Entire run')).toHaveAttribute('aria-pressed', 'false');
    expect(new URL(page.url()).hash).not.toContain('t=');
    await expect(page.getByRole('alert')).toHaveCount(0);
    // the traces starting in the last 6 h of a run of 48 traces 15 minutes apart: 25 of 48
    const traces = page.locator('[data-widget="traces"]');
    await expect.poll(() => traceCount(traces)).toBe(25);

    await pressed('Entire run').click();
    await expect(pressed('Entire run')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => new URL(page.url()).hash).toContain('t=all');
    await expect.poll(() => traceCount(traces)).toBe(48);

    await page.reload();
    await expect(pressed('Entire run')).toHaveAttribute('aria-pressed', 'true');
    await expect(pressed('6h')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => traceCount(traces)).toBe(48);

    await pressed('6h').click();
    await expect(pressed('6h')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => new URL(page.url()).hash).not.toContain('t=');
  },
);
