import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixtureSpanCount, REFRESH_FIRST, REFRESH_SECOND, reportDir } from './fixture.js';
import { expect, HTTP, test } from './test.js';

// Refresh over HTTP (D55, D56): the `refresh` report is a `site` report that is still growing (`complete: false`); the
// test publishes its second partition by copying `manifest.step2.js` over the served `manifest.js`, as a CI run does.
// The files are shared with no other spec; the tests are serial and `afterEach` puts the served files back.
test.describe.configure({ mode: 'serial' });

const DATA = fileURLToPath(new URL('data/', reportDir('refresh', 'http')));
const FIRST = fixtureSpanCount(REFRESH_FIRST);
const TOTAL = FIRST + fixtureSpanCount(REFRESH_SECOND);
const PARTITION_1_SPANS = `${DATA}partitions/000001/spans.parquet`;

const isHttpProject = (projectName: string): boolean => projectName.endsWith('-http');

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(!isHttpProject(testInfo.project.name), 'the refresh report is served over HTTP only');
});

/** Replaces a served file in one step, so the server never reads a half-written one. */
async function replaceServed(file: string, content: string | null): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  if (content === null) await copyFile(`${DATA}manifest.step1.js`, temp);
  else await writeFile(temp, content);
  await rename(temp, file);
}

/** Publishes step 2 as a run's next flush does: the new manifest, whose `updatedAt` is now. */
async function publishStep2(): Promise<void> {
  const manifest = await readFile(`${DATA}manifest.step2.js`, 'utf8');
  await replaceServed(
    `${DATA}manifest.js`,
    manifest.replace(/"updatedAt":"[^"]*"/, `"updatedAt":"${new Date().toISOString()}"`),
  );
}

// Only the http project's copies touch the served files: a skipped file-project copy runs on another worker, possibly
// while the http test is in the middle of its run.
test.afterEach(async ({ page: _page }, testInfo) => {
  if (!isHttpProject(testInfo.project.name)) return;
  await replaceServed(`${DATA}manifest.js`, null);
  await rename(`${PARTITION_1_SPANS}.away`, PARTITION_1_SPANS).catch(() => undefined);
});

test('Refresh picks up a partition published after the page opened', HTTP, async ({ page, reportUrl }) => {
  const requested: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });
  const line = page.getByRole('status').filter({ hasText: 'In progress' });

  await page.goto(`${reportUrl('refresh')}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${FIRST} spans`));
  await expect(line).toBeVisible();
  const secondSpans = (path: string): boolean => path.endsWith('/partitions/000001/spans.parquet');
  expect(requested.some(secondSpans)).toBe(false);

  await publishStep2();
  const started = Date.now();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(count).toHaveText(new RegExp(`^${TOTAL} spans`));
  // Recorded for the PR: how long the Refresh step took, click to the new count (an annotation, shown by the reporter's JSON).
  test.info().annotations.push({ type: 'refresh-timing', description: `${Date.now() - started} ms` });
  await expect(line).toContainText('updated just now');
  expect(requested.some(secondSpans)).toBe(true);
});

// The 404 wording, measured in Chromium (the only browser this project runs; Firefox's and WebKit's are unverified).
// DuckDB-WASM reports neither the status nor "HTTP". The view over the partition fails with
//   Invalid Error: Opening file 'data/partitions/000001/spans.parquet' failed with error: Failed to open file: data/partitions/000001/spans.parquet
// (the viewer logs `falling back to full HTTP read for: <url>` before it), and every query after it with
//   IO Error: No files found that match the pattern "data/partitions/000001/spans.parquet"
// `isGoneFile` (src/viewer/data/refresh-report.ts) matches both (unit-tested on these strings); this test checks that the
// viewer shows its notice for the real thing. The file is one the new manifest lists and the site no longer serves.
test('a partition the site no longer serves offers Refresh', HTTP, async ({ page, reportUrl }) => {
  const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });
  await page.goto(`${reportUrl('refresh')}/index.html#/traces`);
  await expect(count).toHaveText(new RegExp(`^${FIRST} spans`));

  await publishStep2();
  await rename(PARTITION_1_SPANS, `${PARTITION_1_SPANS}.away`);
  await page.getByRole('button', { name: 'Refresh' }).first().click();
  // The notice is a line of text and its own button; the in-progress line has a Refresh button too, so look inside it.
  const notice = page.getByText('This report has changed').first();
  await expect(notice).toBeVisible();
  await expect(notice.locator('..').getByRole('button', { name: 'Refresh' })).toBeVisible();
});
