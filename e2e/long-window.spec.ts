import { readFileSync } from 'node:fs';
import { reviveDataJson, unwrapDataFile } from '../src/format/data-file.js';
import { isPartitioned, parseAnyManifest } from '../src/format/manifest.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import { baseUrlFor, reportDir } from './fixture.js';
import type { RequestRecord } from './static-server.js';
import { expect, HTTP, test } from './test.js';

// Query-scaling plan, Task 23: a report whose range is over 5 h makes "Entire run" a long window (spec 6.3), so the
// Traces page reads rollups and the raw spans file by no Range request; attribute facets wait for the reader.

function spansPaths(): string[] {
  const text = readFileSync(new URL('data/manifest.js', reportDir('long-range', 'http')), 'utf8');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isPartitioned(manifest)) throw new Error('not a partitioned manifest');
  return manifest.partitions.flatMap((p) => (p.files.spans ? [p.files.spans.path] : []));
}

test(
  'the Traces page under "Entire run" of a long report reads rollups and makes no range request to a spans file',
  HTTP,
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.endsWith('-file'), 'a local report holds every file as a buffer already');
    const paths = spansPaths();
    expect(paths.length).toBeGreaterThan(0);
    const seen: RequestRecord[] = [];
    page.on('request', (request) => {
      seen.push({
        path: new URL(request.url()).pathname,
        range: (request.headers() as { range?: string }).range ?? null,
        method: request.method(),
      });
    });
    await page.goto(`${baseUrlFor('http', 'long-range')}/index.html#/traces?mode=traces`);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('main').locator('output', { hasText: /\btraces\b/ })).toBeVisible();
    await expect(page.getByText('percentiles approximate')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load attribute facets' })).toBeVisible();
    // The engine opens every table's file with a footer read before the first statement; a statement that reads a
    // spans file raw reads it by range after that. Aggregates under a long window read the rollups instead.
    const firstRollup = seen.findIndex((r) => r.path.endsWith('/span_rollups.parquet'));
    expect(firstRollup, 'the span rollups were read').toBeGreaterThan(0);
    const ranged = seen
      .slice(firstRollup)
      .filter((r) => r.range !== null && paths.some((p) => r.path.endsWith(`/${p}`)));
    expect(ranged, 'a Range request to a spans file once the page asked for its aggregates').toEqual([]);
  },
);

test(
  'the Load attribute facets button loads them and the section goes away',
  HTTP,
  async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.endsWith('-file'), 'the long-range report is read over HTTP');
    await page.goto(`${baseUrlFor('http', 'long-range')}/index.html#/traces`);
    await page.getByRole('button', { name: 'Load attribute facets' }).click();
    await expect(
      page.getByText('Attribute facets are not loaded for windows of 4 h 40 min or longer.'),
    ).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  },
);
