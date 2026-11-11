import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { reviveDataJson, unwrapDataFile } from '../src/format/data-file.js';
import { isV4, type ManifestV4, parseAnyManifest } from '../src/format/manifest.js';
import { MANIFEST_KEY } from '../src/format/paths.js';
import { costOf, rangesOf } from '../test-support/scaling/cost.js';
import { openCountingEngine, type ReadEvent } from '../test-support/scaling/counting-engine.js';
import { PORT_ENV, type ReportName, reportDir, SCALE_SERVICES, scaleTraceId } from './fixture.js';
import { REQUESTS_PATH, type RequestRecord } from './static-server.js';
import { expect, test } from './test.js';
import { runWorkerSql } from './worker-sql.js';

// Calibration of the scaling harness (query-scaling plan, Task 1): the modelled range requests of the Node counting engine (`rangesOf`, cost.ts) against
// the HEADs and range GETs Chromium makes for the same statement, cold, over the site-format scale reports. `rowgroups`
// is one partition with a four-row-group spans file, `many` is a hundred partitions. The reports come from
// `mise run e2e:fixtures:scale` (`test:e2e` builds them only when the selection includes e2e/scale.spec.ts).

/** `@perf @http`: the `chromium-perf-http` project (playwright.config.ts). */
const PERF_HTTP = { tag: ['@perf', '@http'] };

/** Decision 3: the model and Chromium agree within 10 % or 2 requests, whichever is larger. */
const tolerance = (chromium: number): number => Math.max(2, 0.1 * chromium);

function readManifest(name: ReportName): ManifestV4 {
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
