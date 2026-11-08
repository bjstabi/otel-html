import { readFile } from 'node:fs/promises';
import { reportDir } from './fixture.js';
import { watchProblems } from './metric-chart.js';
import { expect, HTTP, test } from './test.js';

/** `totals.spans` of a frozen report's manifest (`__OH__.push("manifest", {...})`), as `merge` rewrote it (D12). */
async function manifestSpans(report: `frozen-format-${1 | 2 | 3}`): Promise<number> {
  const text = await readFile(new URL('data/manifest.js', reportDir(report)), 'utf8');
  const match = /"totals":\{"spans":(\d+)/.exec(text);
  if (match?.[1] === undefined) throw new Error(`${report}: no totals.spans in the manifest`);
  return Number(match[1]);
}

/** The count as the viewer prints it: thousands may be grouped by any separator. */
function groupedCount(n: number): RegExp {
  return new RegExp(`^${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '\\D?')} spans`);
}

for (const n of [1, 2, 3] as const) {
  const report = `frozen-format-${n}` as const;
  const title = `the frozen format-${n} report opens after merge with the current viewer: totals, a flame graph and a metric chart`;
  test(title, HTTP, async ({ page, reportUrl }) => {
    const problems = watchProblems(page);
    const spans = await manifestSpans(report);

    await page.goto(`${reportUrl(report)}/index.html#/traces`);
    const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });
    await expect(count).toHaveText(groupedCount(spans));
    await page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1).click();
    const panel = page.getByTestId('trace-panel');
    await expect(panel.getByRole('img', { name: /^Flame graph of \d+ spans/ })).toBeVisible();

    await page.goto(`${reportUrl(report)}/index.html#/metrics/catalog`);
    await page.getByRole('grid', { name: 'Results' }).getByRole('row').nth(1).click();
    await expect(page).toHaveURL(/#\/metrics\?/);
    await expect(page.getByRole('img', { name: / · .+: [1-9]\d* series?$/ })).toBeVisible();
    expect(problems).toEqual([]);
  });
}
