import { FORMAT_6_STEP_NS, FORMAT_6_T0, FORMAT_6_TRACES } from './fixture.js';
import { expect, HTTP, test } from './test.js';

// Format 6 (a `site` report without `epochUnixNano`, with a stored service share): the viewer anchors on the range
// start and every time in the URL is absolute unix nanoseconds, so a link is the same window after a reload. The
// frozen anchor across a Refresh that finds older data is a unit test (`test/viewer-data/manifest-range.test.ts`):
// the `refresh` fixture's second manifest adds no partition older than the range.

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(!testInfo.project.name.endsWith('-http'), 'the format-6 report is served over HTTP only');
});

const at = (i: number): bigint => FORMAT_6_T0 + BigInt(i) * FORMAT_6_STEP_NS;
const SECOND = 1_000_000_000n;

test(
  'a window in the URL is absolute unix nanoseconds and survives a reload',
  HTTP,
  async ({ page, reportUrl }) => {
    const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });
    await page.goto(`${reportUrl('format-6')}/index.html#/traces`);
    await expect(count).toHaveText(new RegExp(`^${2 * FORMAT_6_TRACES} spans`));
    await expect(page.getByRole('alert')).toHaveCount(0);

    // traces 2 to 6: five traces of two spans
    const t = `${at(2) - SECOND}~${at(6) + SECOND}`;
    await page.goto(`${reportUrl('format-6')}/index.html#/traces?t=${t}`);
    await expect(count).toHaveText(/^10 spans/);
    expect(new URL(page.url()).hash).toContain(`t=${t}`);
    await page.reload();
    await expect(count).toHaveText(/^10 spans/);
    expect(new URL(page.url()).hash).toContain(`t=${t}`);
    await expect(page.getByRole('alert')).toHaveCount(0);
  },
);

test('a window that starts before the first span is kept as written', HTTP, async ({ page, reportUrl }) => {
  const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });
  const t = `${FORMAT_6_T0 - 600n * SECOND}~${FORMAT_6_T0 + SECOND}`;
  await page.goto(`${reportUrl('format-6')}/index.html#/traces?t=${t}`);
  await expect(count).toHaveText(/^2 spans/);
  expect(new URL(page.url()).hash).toContain(`t=${t}`);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a trace of the report opens and shows its services', HTTP, async ({ page, reportUrl }) => {
  await page.goto(`${reportUrl('format-6')}/index.html#/traces?trace=${'0'.repeat(31)}1`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('checkout').first()).toBeVisible();
});
