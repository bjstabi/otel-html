import './scaling-pages-mocks.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { CATALOGUE } from '../../src/viewer/data/catalogue.js';
import { createDuckDbDataSource } from '../../src/viewer/data/duckdb-source.js';
import { Shell } from '../../src/viewer/shell/shell.js';
import { createHashHistory } from '../../src/viewer/state/hash-history.js';
import { ThemeProvider } from '../../src/viewer/theme/theme-provider.js';
import { costWith } from '../../test-support/scaling/cost.js';
import { openCountingEngine, type ReadEvent } from '../../test-support/scaling/counting-engine.js';
import {
  BASE,
  buildScalingReport,
  PAGE_CROSS,
  pageShapes,
  type ScalingReport,
  type Shape,
} from '../../test-support/scaling/generator.js';
import { closeMeasured } from '../../test-support/scaling/measure.js';
import { entryIdsOf, recordingDataSource } from '../../test-support/scaling/recording-source.js';
import {
  manifestWithCi,
  measureShape,
  PAGE_CALLS,
  PAGE_THRESHOLD,
  PAGES,
  pageOn,
  shapeFile,
  TRACE_PAGE,
} from './scaling-pages-support.js';

const IDS = new Set(CATALOGUE.map((e) => e.id));
const { OTEL_HTML_SCALING: SCALING, OTEL_HTML_SCALING_OUT: OUT } = process.env;

/** Methods any rendering of the page must call: a page that records fewer lost a widget's request. */
let report: ScalingReport;
let close: () => Promise<void>;
let cold: () => Promise<void>;
let take: () => Promise<ReadEvent[]>;
let prepared: () => ReadonlyMap<string, number>;
let make: () => ReturnType<typeof createDuckDbDataSource>;

beforeAll(async () => {
  report = await buildScalingReport(BASE);
  const counting = await openCountingEngine(report.dir, report.manifest, { threshold: PAGE_THRESHOLD });
  close = async () => {
    await counting.close();
    await report.close();
  };
  cold = () => counting.cold();
  take = () => counting.take();
  prepared = () => counting.prepared();
  make = () => createDuckDbDataSource({ engine: counting.engine, manifest: report.manifest });
}, 120_000);
afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await close();
});

describe('the pages ask only catalogued requests', () => {
  test.each(PAGES)(
    '%s',
    async (hash) => {
      const manifest = manifestWithCi(report.manifest, report.ids.metric);
      // a page opens the report cold: no footer or file content left in the engine by the page before
      await cold();
      const { ds, calls, settled } = recordingDataSource(make(), manifest);
      window.location.hash = hash;
      render(
        <ThemeProvider>
          <Shell dataSource={ds} history={createHashHistory(window)} />
        </ThemeProvider>,
      );
      await settled(PAGE_CALLS[hash] ?? []);
      const settledCount = calls.length;
      // nothing may start after the page counted as settled
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      expect(calls.length, `${hash}: calls started after settled()`).toBe(settledCount);
      const warm = costWith(await take(), prepared());
      expect(calls.length).toBeGreaterThan(0);
      for (const method of PAGE_CALLS[hash] ?? [])
        expect(
          calls.map((c) => c.method),
          `${hash} calls ${method}`,
        ).toContain(method);
      for (const long of [false, true])
        for (const id of calls.flatMap((c) => entryIdsOf(c, long)))
          expect(IDS.has(id), `${hash}: ${id}`).toBe(true);
      if (OUT !== undefined) {
        const dir = join(OUT, 'recordings');
        mkdirSync(dir, { recursive: true });
        const mapped = calls.map((call) => ({
          call,
          ids: { short: entryIdsOf(call, false), long: entryIdsOf(call, true) },
        }));
        writeFileSync(
          join(dir, `${encodeURIComponent(hash)}.json`),
          JSON.stringify({ calls: mapped, warm }, null, 1),
        );
      }
    },
    60_000,
  );
});

/**
 * What each page asks of the `mixed` shape (the live-shaped mix: four scopes, hourly partitions), pinned at the measured
 * value + 10 % rounded up: a page that asks for more fails here until the number is raised on purpose. The shape's files
 * are all under the production small-file limit, which prepares them in parallel and leaves no serial request, so the
 * serial requests are pinned with preparing off (`pageOn` at threshold 0: what a report of large files costs) and the
 * requests of both kinds with the production limit.
 */
const PAGE_SERIAL_MAX: Readonly<Record<string, number>> = {
  '#/dashboards/ci': 95,
  '#/traces?mode=traces': 54,
  // 29 measured: the first page asks 201 rows, which DuckDB plans as a TOP_N with a dynamic filter pushed into the scan
  // (the 10,001 rows of the one statement before paging were a full sort); the same bytes, read in an order that breaks
  // four read-ahead streams on these small files. 29 + 10 % rounded up.
  '#/traces': 32,
  '#/logs': 31,
  '#/metrics': 14,
  [TRACE_PAGE]: 54,
};
const PAGE_REQUESTS_MAX: Readonly<Record<string, number>> = {
  '#/dashboards/ci': 18,
  '#/traces?mode=traces': 9,
  '#/traces': 5,
  '#/logs': 9,
  '#/metrics': 5,
  [TRACE_PAGE]: 15,
};

describe('a page asks no more requests than pinned on the mixed shape (+10 % of the measured value)', () => {
  let live: ScalingReport;
  beforeAll(async () => {
    live = await buildScalingReport({ ...BASE, mixed: true });
  }, 120_000);
  afterAll(async () => {
    await live.close();
  });

  test.each(PAGES)(
    '%s',
    async (hash) => {
      const off = await pageOn(live, hash, 0);
      const prepared = await pageOn(live, hash, PAGE_THRESHOLD);
      expect(off.serial, `${hash}: serial requests, files not prepared`).toBeLessThanOrEqual(
        PAGE_SERIAL_MAX[hash] ?? 0,
      );
      expect(prepared.serial + prepared.parallel, `${hash}: requests`).toBeLessThanOrEqual(
        PAGE_REQUESTS_MAX[hash] ?? 0,
      );
    },
    120_000,
  );
});

const SPACINGS = ['dense', 'sparse'] as const;
/** The shapes of one worker: the big-partition shapes are in `scaling-pages-big.test.tsx` (their own heap). */
const smallShapes = (spacing: (typeof SPACINGS)[number]): Shape[] =>
  [...pageShapes(spacing), PAGE_CROSS(spacing)].filter((s) => s.bigRowGroups === undefined);

/**
 * Each page rendered whole in a cold counting engine on the page shapes, for `mise run predict:queries` (the folder of
 * OTEL_HTML_SCALING_OUT); the script fits them and runs the one-engine check.
 */
describe.skipIf(SCALING !== '1' || OUT === undefined)('a page is measured whole', () => {
  afterAll(async () => {
    await closeMeasured();
  });

  describe.each(SPACINGS)('%s', (spacing) => {
    test.each(smallShapes(spacing).map((shape) => [shapeFile(shape), shape] as const))(
      'the five pages on %s',
      async (_file, shape) => {
        await measureShape(shape, OUT ?? '');
      },
      600_000,
    );
  });
});
