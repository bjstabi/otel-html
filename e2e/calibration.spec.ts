import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { reviveDataJson, unwrapDataFile } from '../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../src/format/manifest.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import { SMALL_FILE_BYTES } from '../src/viewer/data/engine/small-files.js';
import { chunksOf } from '../test-support/parquet-footer.js';
import { costOf, rangesOf } from '../test-support/scaling/cost.js';
import { openCountingEngine, type ReadEvent } from '../test-support/scaling/counting-engine.js';
import { PORT_ENV, type ReportName, reportDir, SCALE_SERVICES, scaleTraceId } from './fixture.js';
import { REQUESTS_PATH, type RequestRecord } from './static-server.js';
import { expect, test } from './test.js';
import { runWorkerSql } from './worker-sql.js';

// Calibration of the scaling harness (query-scaling plan, Task 1): the modelled range requests of the Node counting engine (`rangesOf`, cost.ts) against
// the HEADs and range GETs Chromium makes for the same statement, cold, over the site-format scale reports. `rowgroups`
// is one partition with a four-row-group spans file, `many` is a hundred partitions. The reports come from
// `mise run e2e:fixtures:scale` (`test:e2e` builds them only when the selection includes e2e/scale.spec.ts or this spec).

/** `@perf @http`: the `chromium-perf-http` project (playwright.config.ts). */
const PERF_HTTP = { tag: ['@perf', '@http'] };

/** Decision 3: the model and Chromium agree within 10 % or 2 requests, whichever is larger. */
const tolerance = (chromium: number): number => Math.max(2, 0.1 * chromium);

function readManifest(name: ReportName): ManifestV4 {
  // global-setup does not check the scale reports (they are built on demand), so a direct run without them fails here.
  if (!existsSync(new URL('data/manifest.js', reportDir(name, 'http'))))
    throw new Error(`the scale fixture reports are missing: run \`mise run e2e:fixtures:scale\` (${name})`);
  const text = readFileSync(new URL('data/manifest.js', reportDir(name, 'http')), 'utf8');
  const manifest = parseAnyManifest(reviveDataJson(unwrapDataFile(text, MANIFEST_KEY)));
  if (!isV4(manifest)) throw new Error(`${name}: not a v4 manifest`);
  return manifest;
}

/** Waits until the server has seen no new request for `quietMs`: the viewer's own landing queries are done. */
async function quiet(seen: () => Promise<RequestRecord[]>, quietMs = 1000): Promise<void> {
  let last = -1;
  for (;;) {
    const n = (await seen()).length;
    if (n === last) return;
    last = n;
    await new Promise((r) => setTimeout(r, quietMs));
  }
}

/** A new document each time (a hash change alone would keep the engine and what it cached), on a route that reads no span. */
async function freshPage(page: Page, url: string): Promise<void> {
  await page.goto('about:blank');
  await page.goto(`${url}/index.html#/metrics`);
}

for (const name of ['rowgroups', 'many'] as const) {
  test(`the Node read counts track Chromium's requests (${name})`, PERF_HTTP, async ({ page, reportUrl }) => {
    test.setTimeout(300_000);
    const manifest = readManifest(name);
    const range = manifest.range;
    if (range === null) throw new Error(`${name}: the report has no time range`);
    const lo = BigInt(range.start);
    const span = BigInt(range.end) - lo;
    const statements = [
      'SELECT count(*) FROM spans',
      `SELECT count(*) FROM spans WHERE service_name = '${SCALE_SERVICES[1]}'`,
      `SELECT status_code, count(*) FROM spans WHERE start_time_unix_nano BETWEEN ${lo + (span * 4n) / 10n} AND ${lo + (span * 5n) / 10n} GROUP BY 1`,
      `SELECT * FROM spans WHERE trace_id = '${scaleTraceId(1000)}'`,
      'SELECT trace_id FROM traces ORDER BY start_time_unix_nano DESC LIMIT 50',
    ];
    const base = `http://127.0.0.1:${process.env[PORT_ENV]}`;
    const seen = async (): Promise<RequestRecord[]> =>
      (await (await fetch(`${base}${REQUESTS_PATH}`)).json()) as RequestRecord[];
    const prefix = new URL(reportUrl(name)).pathname;
    const counting = await openCountingEngine(
      fileURLToPath(reportDir(name, 'http')).replace(/\/$/, ''),
      manifest,
    );
    try {
      for (const [i, statement] of statements.entries()) {
        await freshPage(page, reportUrl(name));
        await quiet(seen);
        const before = (await seen()).length;
        const reply = await runWorkerSql(page, statement);
        expect(reply.type, `${statement}: ${reply.message}`).not.toMatch(/ERROR/);
        const mine = (await seen())
          .slice(before)
          .filter((r) => r.path.startsWith(`${prefix}/data/partitions/`));
        const heads = mine.filter((r) => r.method === 'HEAD').length;
        const gets = mine.filter((r) => r.method === 'GET').length;

        await counting.cold();
        await counting.engine.exec(statement);
        const events: readonly ReadEvent[] = await counting.take();
        const opens = events.filter((e) => e.kind === 'open').length;
        const reads = events.filter((e) => e.kind === 'read').length;
        const ranges = rangesOf(events);
        const predicted = costOf(events, new Map()).serial;
        const actual = heads + gets;
        process.stdout.write(
          `CALIBRATION ${name} #${i + 1}: Node opens ${opens}, reads ${reads} (${ranges} modelled ranges); Chromium HEADs ${heads}, GETs ${gets}; predicted ${predicted} against ${actual}\n`,
        );
        expect
          .soft(Math.abs(predicted - actual), `${name} #${i + 1} ${statement}`)
          .toBeLessThanOrEqual(tolerance(actual));
      }
    } finally {
      await counting.close();
    }
  });
}

/** The `Range: bytes=a-b` requests for `path` made since request number `from`, as [first, last] byte pairs. */
function rangesFor(requests: readonly RequestRecord[], path: string): [number, number][] {
  return requests
    .filter((r) => r.method === 'GET' && r.path === path)
    .flatMap((r): [number, number][] => {
      const m = /^bytes=(\d+)-(\d*)$/.exec(r.range ?? '');
      return m === null ? [] : [[Number(m[1]), m[2] === '' ? Number.POSITIVE_INFINITY : Number(m[2])]];
    });
}

// Over HTTP, in Chromium: a lookup by trace id of a partition that lacks the id reads the footer and the bloom
// filters of its spans file and no data page. `rowgroups` has one partition whose spans file (four row groups, far
// above the small-file limit) is read by range. The absent id has the shape of the stored ones, so every row group's
// min/max statistics of `trace_id` span it and only the filter can rule the group out.
test(
  'a trace id the partition lacks reads no data page of its spans file (rowgroups)',
  {
    tag: ['@http'],
  },
  async ({ page, reportUrl }, testInfo) => {
    test.skip(testInfo.project.name.endsWith('-file'), 'the scale reports are read over HTTP only');
    test.setTimeout(120_000);
    const manifest = readManifest('rowgroups');
    const entry = manifest.partitions[0]?.files.spans;
    if (entry === undefined) throw new Error('rowgroups: no spans file');
    expect(entry.bytes, 'above the small-file limit').toBeGreaterThan(SMALL_FILE_BYTES);
    const bytes = readFileSync(new URL(entry.path, reportDir('rowgroups', 'http')));
    const groups = chunksOf(new Uint8Array(bytes)).map((g) => g.find((c) => c.path === 'trace_id'));
    expect(groups.length).toBeGreaterThan(1);
    const filters = groups.map((c) => c?.offset);
    expect(
      filters.every((o) => o !== undefined),
      'every row group has a filter',
    ).toBe(true);
    const dataEnd = Math.min(...filters.map((o) => Number(o)));

    const base = `http://127.0.0.1:${process.env[PORT_ENV]}`;
    const seen = async (): Promise<RequestRecord[]> =>
      (await (await fetch(`${base}${REQUESTS_PATH}`)).json()) as RequestRecord[];
    const path = `${new URL(reportUrl('rowgroups')).pathname}/${entry.path}`;
    const lookup = async (id: string): Promise<[number, number][]> => {
      await freshPage(page, reportUrl('rowgroups'));
      await quiet(seen);
      const before = (await seen()).length;
      const reply = await runWorkerSql(page, `SELECT count(*) FROM spans WHERE trace_id = '${id}'`);
      expect(reply.type, reply.message).not.toMatch(/ERROR/);
      return rangesFor((await seen()).slice(before), path);
    };

    const present = await lookup(scaleTraceId(1000));
    expect(
      present.some(([first]) => first < dataEnd),
      'a stored id reads data pages (the check can fail)',
    ).toBe(true);

    const absent = await lookup(`${scaleTraceId(1000).slice(0, -1)}b`);
    expect(absent.length, 'the footer and the filters are read').toBeGreaterThan(0);
    process.stdout.write(
      `BLOOM absent id: ranges ${JSON.stringify(absent)}; data ends at ${dataEnd} of ${bytes.length}\n`,
    );
    // A read may start up to one 16 KiB block before a filter (the engine's reads are block aligned).
    for (const [first] of absent)
      expect(first, `range from ${first}`).toBeGreaterThanOrEqual(dataEnd - 16_384);
  },
);
