import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { LOG_STEP_NS } from '../test-support/scale-logs.js';
import { scaleMetricName } from '../test-support/scale-metrics.js';
import {
  FUSION_INTERACTIVE_BUDGET_MS,
  FUSION_SELECTION_BUDGET_MS,
  perfFactor,
  reportDir,
  SCALE_LOGS,
  SCALE_METRIC_SERIES,
  SCALE_METRICS,
  SCALE_SERVICES,
  SCALE_SPAN_COUNT,
  SCALE_SPANS_PER_TRACE,
  SCALE_TRACES,
} from './fixture.js';
import { ensureMetricsScaleReport } from './metrics-scale.js';
import { expect, test } from './test.js';

/** Fixed budgets; `OTEL_HTML_PERF_FACTOR` scales them for slow machines, the constants are never loosened. */
const INTERACTIVE_BUDGET_MS = 3000;
const FACET_BUDGET_MS = 150;
/** Timed toggles after one untimed warm-up; the median is compared with the budget. */
const FACET_SAMPLES = 7;

const SCAN_BUDGET_MS = 5000;
/** Timed loads after one untimed warm-up load; the median is compared with the budget. */
const LOAD_SAMPLES = 3;

const SERVICE = SCALE_SERVICES[0];
/** Span `j` of a trace belongs to service `j % 8`, so the first service owns spans 0, 8, ..., 48 of each trace. */
const PER_SERVICE = SCALE_TRACES * Math.ceil(SCALE_SPANS_PER_TRACE / SCALE_SERVICES.length);

test(
  '100k spans: the explorer is interactive within 3 s and a facet toggle repaints within 150 ms (median)',
  { tag: '@perf' },
  async ({ page, reportUrl, browserName }, testInfo) => {
    const factor = perfFactor();
    const search = page.getByRole('searchbox', { name: 'Search', exact: true });
    const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
    const count = page.getByRole('main').locator('output', { hasText: /\bspans\b/ });

    // Timed in the page, from navigation start to the frame that paints the first result row. Timing it from the
    // test would add Playwright's assertion polling (retries 100 ms, 250 ms, 500 ms, 1 s apart) to the result.
    await page.addInitScript(() => {
      const mo = new MutationObserver(() => {
        const grid = document.querySelector('[role="grid"][aria-label="Results"]');
        if (grid === null || grid.querySelectorAll('[role="row"]').length < 2) return;
        mo.disconnect();
        requestAnimationFrame(() => {
          (window as { __OH_ROWS_PAINTED__?: number }).__OH_ROWS_PAINTED__ = performance.now();
        });
      });
      mo.observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${reportUrl('scale')}/index.html#/traces`, { waitUntil: 'commit' });
    await expect(rows.nth(1)).toBeVisible({ timeout: 30_000 });
    await search.focus();
    await expect(search).toBeFocused();
    const interactiveMs = Number(
      await (
        await page.waitForFunction(() => (window as { __OH_ROWS_PAINTED__?: number }).__OH_ROWS_PAINTED__)
      ).jsonValue(),
    );
    await expect(count).toHaveText(new RegExp(`^${SCALE_SPAN_COUNT} spans`));

    // A facet toggle is timed from the click to the next frame after the result count changed. The first toggle
    // pays for JIT warm-up, the first OTTL compile and the first chart build, so it is untimed; the budget applies to
    // the median of the toggles after it.
    const toggleMs = (service: string): Promise<number> =>
      page.evaluate(async (svc) => {
        const row = document.querySelector(`[data-testid="facet-row:service.name:${svc}"]`);
        const only = row?.querySelector<HTMLButtonElement>('button[aria-label^="Only "]');
        const out = [...document.querySelectorAll('main output')].find((o) =>
          /\bspans\b/.test(o.textContent ?? ''),
        );
        if (!only || !out) throw new Error('facet row or count output not found');
        const before = out.textContent;
        const t = performance.now();
        return await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the count never changed')), 10_000);
          const obs = new MutationObserver(() => {
            if (out.textContent === before) return;
            obs.disconnect();
            clearTimeout(timer);
            requestAnimationFrame(() => resolve(performance.now() - t));
          });
          obs.observe(out, { subtree: true, childList: true, characterData: true });
          only.click();
        });
      }, service);
    const clearFilters = async (): Promise<void> => {
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await expect(count).toHaveText(new RegExp(`^${SCALE_SPAN_COUNT} spans`));
      // The cleared view keeps rendering (100k-row query, grid, charts) after its count changes. Wait until the main
      // thread is quiet, so the next timed toggle measures its own latency and not the tail of this one.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const deadline = performance.now() + 5_000;
            let last = performance.now();
            let quiet = 0;
            const tick = (now: number): void => {
              quiet = now - last < 25 ? quiet + 1 : 0;
              last = now;
              if (quiet >= 3 || now > deadline) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
    };

    await toggleMs(SERVICE);
    await expect(count).toHaveText(new RegExp(`^${PER_SERVICE} spans`));
    await clearFilters();

    const samples: number[] = [];
    for (let i = 0; i < FACET_SAMPLES; i++) {
      samples.push(await toggleMs(SCALE_SERVICES[i % 2] ?? SERVICE));
      await clearFilters();
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const facetMs = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
    const worstMs = sorted[sorted.length - 1] ?? Number.POSITIVE_INFINITY;

    const line = `PERF scale ${testInfo.project.name} (${browserName}): interactive ${interactiveMs.toFixed(0)} ms (budget ${INTERACTIVE_BUDGET_MS * factor}), facet repaint median ${facetMs.toFixed(0)} ms, max ${worstMs.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${FACET_BUDGET_MS * factor}), factor ${factor}\n`;
    process.stdout.write(line);
    testInfo.annotations.push({ type: 'perf', description: line.trim() });
    expect(interactiveMs).toBeLessThan(INTERACTIVE_BUDGET_MS * factor);
    expect(facetMs).toBeLessThan(FACET_BUDGET_MS * factor);
    expect(worstMs).toBeLessThan(2 * FACET_BUDGET_MS * factor);
  },
);

test('a report over the eager budget filters by chunk window and opens a trace through its shard', async ({
  page,
  reportUrl,
}) => {
  const dir = fileURLToPath(reportDir('huge'));
  const spanChunks = readdirSync(`${dir}data/chunks/spans`).filter((f) => f.endsWith('.js'));
  expect(spanChunks.length).toBeGreaterThan(2);

  // Which data files the page loaded. Playwright's request events miss file:// script loads in Firefox, so an init
  // script also records every <script src> the viewer inserts; both witnesses are merged.
  await page.addInitScript(() => {
    const w = window as unknown as { __ohScripts: string[] };
    w.__ohScripts = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLScriptElement && n.src !== '') w.__ohScripts.push(n.src);
    }).observe(document, { childList: true, subtree: true });
  });
  const seen = new Set<string>();
  const note = (url: string): void => {
    const m = /\/data\/((?:traces|chunks\/spans)\/[^/?#]+\.js)(?:[?#].*)?$/.exec(url);
    if (m?.[1] !== undefined) seen.add(m[1]);
  };
  page.on('request', (r) => note(r.url()));
  const loaded = async (): Promise<ReadonlySet<string>> => {
    for (const url of await page.evaluate(() => (window as unknown as { __ohScripts: string[] }).__ohScripts))
      note(url);
    return seen;
  };

  await page.goto(`${reportUrl('huge')}/index.html#/traces`);
  const rows = page.getByRole('grid', { name: 'Results' }).getByRole('row');
  await expect(rows.nth(1)).toBeVisible({ timeout: 30_000 });

  // Filtering scans chunks on demand and stops once it has enough rows.
  const facet = page.getByTestId(`facet-row:service.name:${SERVICE}`);
  await facet.hover();
  await page.getByRole('button', { name: `Only ${SERVICE}` }).click();
  const partial = page.getByRole('status', { name: 'Partial results' });
  await expect(partial).toContainText(/from \d+ of \d+ chunks/);
  const text = (await partial.textContent()) ?? '';
  const [, scanned, total] = /from (\d+) of (\d+) chunks/.exec(text) ?? [];
  expect(Number(total)).toBe(spanChunks.length);
  expect(Number(scanned)).toBeLessThan(Number(total));
  const chunksAfterFilter = [...(await loaded())].filter((f) => f.startsWith('chunks/')).length;
  expect(chunksAfterFilter).toBeLessThan(spanChunks.length);

  // Opening a trace loads its shard, then exactly the chunks that shard lists.
  await rows.nth(1).click();
  const panel = page.getByTestId('trace-panel');
  await expect(panel.getByTestId('trace-header')).toBeVisible();
  const traceId = /trace=([0-9a-f]{32})/.exec(page.url())?.[1];
  expect(traceId).toBeDefined();
  const shard = (traceId ?? '').slice(0, 2);
  const shardBody = readFileSync(`${dir}data/traces/${shard}.js`, 'utf8');
  const payload = shardBody.slice(shardBody.indexOf(',') + 1, shardBody.lastIndexOf(')'));
  const entry = (JSON.parse(payload) as Record<string, { chunks: string[] }>)[traceId ?? ''];
  expect(entry?.chunks.length).toBeGreaterThan(0);
  const requested = await loaded();
  expect(requested).toContain(`traces/${shard}.js`);
  for (const key of entry?.chunks ?? []) expect(requested).toContain(`${key}.js`);
  expect([...requested].filter((f) => f.startsWith('chunks/')).length).toBeLessThan(spanChunks.length);
});

const LOGS_GRID = '[role="grid"][aria-label="Results"]';
const PARTIAL_NOTE = '[role="status"][aria-label="Partial results"]';
/** Warn and above, as the facet's "And above" writes it. */
const WARN_UP = 'log.severity_number >= SEVERITY_NUMBER_WARN';

/**
 * Median milliseconds from navigation start to the frame in which the log grid has rows and, when `partial` is set,
 * the partial-results note is up. Timed in the page for the reason the span test does; the first load is untimed.
 */
async function logsReadyMs(page: Page, url: string, partial: boolean): Promise<number[]> {
  await page.addInitScript(
    ({ grid, note, needNote }) => {
      const w = window as { __OH_LOGS_READY__?: number };
      const mo = new MutationObserver(() => {
        const g = document.querySelector(grid);
        if (g === null || g.querySelectorAll('[role="row"]').length < 2) return;
        if (needNote && document.querySelector(note) === null) return;
        mo.disconnect();
        requestAnimationFrame(() => {
          w.__OH_LOGS_READY__ = performance.now();
        });
      });
      mo.observe(document, { childList: true, subtree: true });
    },
    { grid: LOGS_GRID, note: PARTIAL_NOTE, needNote: partial },
  );
  const samples: number[] = [];
  for (let i = 0; i <= LOAD_SAMPLES; i++) {
    if (i === 0) await page.goto(url, { waitUntil: 'commit' });
    else await page.reload({ waitUntil: 'commit' });
    const ms = Number(
      await (
        await page.waitForFunction(() => (window as { __OH_LOGS_READY__?: number }).__OH_LOGS_READY__, null, {
          timeout: 60_000,
        })
      ).jsonValue(),
    );
    if (i > 0) samples.push(ms);
  }
  return samples;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function report(testInfo: { annotations: { type: string; description?: string }[] }, line: string): void {
  process.stdout.write(`${line}\n`);
  testInfo.annotations.push({ type: 'perf', description: line });
}

for (const name of ['scale', 'huge'] as const) {
  test(
    `1M logs (${name}): the Logs landing is windowed and interactive within 3 s (median)`,
    { tag: '@perf' },
    async ({ page, reportUrl, browserName }, testInfo) => {
      const factor = perfFactor();
      const dir = fileURLToPath(reportDir(name));
      const logChunks = readdirSync(`${dir}data/chunks/logs`).filter((f) => f.endsWith('.js')).length;
      expect(logChunks).toBeGreaterThan(10);

      const samples = await logsReadyMs(page, `${reportUrl(name)}/index.html#/logs`, true);
      const ms = median(samples);
      // Windowed: the landing shows the newest chunk(s), and says so, instead of reading all of them.
      const note = page.getByRole('status', { name: 'Partial results' });
      await expect(note).toContainText(new RegExp(`from \\d+ of ${logChunks} chunks`));
      const [, read] = /from (\d+) of \d+ chunks/.exec((await note.textContent()) ?? '') ?? [];
      expect(Number(read)).toBeGreaterThan(0);
      expect(Number(read)).toBeLessThan(logChunks);
      await expect(page.getByRole('main').locator('output', { hasText: /\blogs\b/ })).toHaveText(
        new RegExp(`^${SCALE_LOGS} logs`),
      );
      report(
        testInfo,
        `PERF ${name} logs landing ${testInfo.project.name} (${browserName}): median ${ms.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${INTERACTIVE_BUDGET_MS * factor}), factor ${factor}`,
      );
      expect(ms).toBeLessThan(INTERACTIVE_BUDGET_MS * factor);
    },
  );
}

test(
  '1M logs: a one-minute window of warn-and-above logs scans within 5 s and says which chunks it read (median)',
  { tag: '@perf' },
  async ({ page, reportUrl, browserName }, testInfo) => {
    const factor = perfFactor();
    const logChunks = readdirSync(`${fileURLToPath(reportDir('scale'))}data/chunks/logs`).filter((f) =>
      f.endsWith('.js'),
    ).length;
    // `t` is nanoseconds from the run's first record; a minute of logs sits mid-run, inside one or two chunks.
    const start = 3000n * 1_000_000_000n;
    const end = start + 60n * 1_000_000_000n;
    expect(end / LOG_STEP_NS).toBeLessThan(BigInt(SCALE_LOGS));
    const hash = `#/logs?q=${encodeURIComponent(WARN_UP)}&t=${start}~${end}`;

    const samples = await logsReadyMs(page, `${reportUrl('scale')}/index.html${hash}`, true);
    const ms = median(samples);
    const note = (await page.getByRole('status', { name: 'Partial results' }).textContent()) ?? '';
    const [, scanned, total] = /from (\d+) of (\d+) chunks/.exec(note) ?? [];
    expect(Number(total)).toBe(logChunks);
    expect(Number(scanned)).toBeGreaterThan(0);
    expect(Number(scanned)).toBeLessThan(5);
    report(
      testInfo,
      `PERF scale log window scan ${testInfo.project.name} (${browserName}): median ${ms.toFixed(0)} ms, ${scanned} of ${total} chunks, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${SCAN_BUDGET_MS * factor}), factor ${factor}`,
    );
    expect(ms).toBeLessThan(SCAN_BUDGET_MS * factor);
  },
);

test("1M logs: a trace Logs tab loads only that trace's log chunks", { tag: '@perf' }, async ({
  page,
  reportUrl,
}) => {
  const dir = fileURLToPath(reportDir('scale'));
  const allLogChunks = readdirSync(`${dir}data/chunks/logs`).filter((f) => f.endsWith('.js'));
  // Interval flushes cut log chunks too, so which traces straddle a chunk boundary depends on machine speed: the
  // trace is picked from the report's own index, the first (by id) with 20+ logs over two or more chunks.
  const candidates = readdirSync(`${dir}data/traces`)
    .filter((f) => f.endsWith('.js'))
    .flatMap((f) => {
      const body = readFileSync(`${dir}data/traces/${f}`, 'utf8');
      const payload = body.slice(body.indexOf(',') + 1, body.lastIndexOf(')'));
      return Object.entries(JSON.parse(payload) as Record<string, { logs?: number; logChunks?: string[] }>);
    })
    .filter(([, e]) => (e.logs ?? 0) >= 20 && (e.logChunks?.length ?? 0) >= 2)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const [traceId, entry] = candidates[0] ?? [];
  expect(traceId).toBeDefined();

  // Playwright's request events miss file:// script loads in Firefox, and resource timing can miss them elsewhere;
  // an init script also records every <script src> the viewer inserts, and the witnesses are merged.
  await page.addInitScript(() => {
    const w = window as unknown as { __ohScripts: string[] };
    w.__ohScripts = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n instanceof HTMLScriptElement && n.src !== '') w.__ohScripts.push(n.src);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${reportUrl('scale')}/index.html#/traces?trace=${traceId}&tab=logs`);
  const tab = page.getByTestId('trace-logs-tab');
  await expect(tab.getByRole('row').nth(1)).toBeVisible({ timeout: 30_000 });
  await expect(tab).toContainText(`${entry?.logs} logs`);

  const names = await page.evaluate(() => [
    ...performance.getEntriesByType('resource').map((e) => e.name),
    ...(window as unknown as { __ohScripts: string[] }).__ohScripts,
  ]);
  const loaded = new Set(
    names.flatMap((url) => {
      const m = /\/data\/(chunks\/logs\/[^/?#]+)\.js(?:[?#].*)?$/.exec(url);
      return m?.[1] === undefined ? [] : [m[1]];
    }),
  );
  expect([...loaded].sort()).toEqual([...(entry?.logChunks ?? [])].sort());
  expect(loaded.size).toBeLessThan(allLogChunks.length);
});

/** Metrics targets (spec §7): the Explorer draws its first chart within 2 s, the Catalog opens within 1 s. */
const METRICS_EXPLORER_BUDGET_MS = 2000;
const METRICS_CATALOG_BUDGET_MS = 1000;
/** Generating the metrics scale report the first time takes about 15 minutes (more on a slow CI runner, whose job allows 60); later runs reuse it. */
const METRICS_SCALE_SETUP_MS = 50 * 60 * 1000;

/**
 * Median milliseconds from navigation start to the frame after an element matching `selector` (and, when given,
 * whose `aria-label` matches `label`) appears, over `LOAD_SAMPLES` loads after an untimed first one.
 */
async function paintedMs(page: Page, url: string, selector: string, label: string | null): Promise<number[]> {
  await page.addInitScript(
    ({ sel, pattern }) => {
      const w = window as { __OH_PAINTED__?: number };
      const re = pattern === null ? null : new RegExp(pattern);
      const mo = new MutationObserver(() => {
        const hit = [...document.querySelectorAll(sel)].some(
          (el) => re === null || re.test(el.getAttribute('aria-label') ?? ''),
        );
        if (!hit) return;
        mo.disconnect();
        requestAnimationFrame(() => {
          w.__OH_PAINTED__ = performance.now();
        });
      });
      mo.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label'],
      });
    },
    { sel: selector, pattern: label },
  );
  const samples: number[] = [];
  for (let i = 0; i <= LOAD_SAMPLES; i++) {
    if (i === 0) await page.goto(url, { waitUntil: 'commit' });
    else await page.reload({ waitUntil: 'commit' });
    const ms = Number(
      await (
        await page.waitForFunction(() => (window as { __OH_PAINTED__?: number }).__OH_PAINTED__, null, {
          timeout: 60_000,
        })
      ).jsonValue(),
    );
    if (i > 0) samples.push(ms);
  }
  return samples;
}

/** The metrics scale check runs only with this set to 1: its report takes ~15 minutes and ~12 GB to write. */
const METRICS_SCALE_ENV = 'OTEL_HTML_METRICS_SCALE';

test.describe(`metrics scale: ${SCALE_METRICS} metrics × ${SCALE_METRIC_SERIES} series × 1 h at 10 s`, () => {
  // Skipped tests run no hooks, so the report is not written either.
  test.skip(
    process.env[METRICS_SCALE_ENV] !== '1',
    `set ${METRICS_SCALE_ENV}=1 to write the metrics scale report and run its checks`,
  );
  test.beforeAll(async () => {
    test.setTimeout(METRICS_SCALE_SETUP_MS);
    await ensureMetricsScaleReport();
  });

  test(
    'the Metrics Explorer draws its first chart within 2 s (median)',
    { tag: '@perf' },
    async ({ page, reportUrl, browserName }, testInfo) => {
      const factor = perfFactor();
      // An empty Explorer charts the first metric of the catalog.
      const samples = await paintedMs(
        page,
        `${reportUrl('metrics-scale')}/index.html#/metrics`,
        'main [role="img"]',
        ': [1-9]\\d* series$',
      );
      const ms = median(samples);
      // The first metric is a counter: its rate, all series summed into one line.
      await expect(page.getByRole('img', { name: `${scaleMetricName(0)} · rate: 1 series` })).toBeVisible();
      report(
        testInfo,
        `PERF metrics explorer ${testInfo.project.name} (${browserName}): median ${ms.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${METRICS_EXPLORER_BUDGET_MS * factor}), factor ${factor}`,
      );
      expect(ms).toBeLessThan(METRICS_EXPLORER_BUDGET_MS * factor);
    },
  );

  test(
    'the Metrics Catalog opens within 1 s (median)',
    { tag: '@perf' },
    async ({ page, reportUrl, browserName }, testInfo) => {
      const factor = perfFactor();
      const samples = await paintedMs(
        page,
        `${reportUrl('metrics-scale')}/index.html#/metrics/catalog`,
        '[role="grid"][aria-label="Results"] [role="row"][data-row-index]',
        null,
      );
      const ms = median(samples);
      await expect(page.getByRole('main')).toContainText(`${SCALE_METRICS} metrics ·`);
      report(
        testInfo,
        `PERF metrics catalog ${testInfo.project.name} (${browserName}): median ${ms.toFixed(0)} ms, samples [${samples.map((x) => x.toFixed(0)).join(', ')}] (budget ${METRICS_CATALOG_BUDGET_MS * factor}), factor ${factor}`,
      );
      expect(ms).toBeLessThan(METRICS_CATALOG_BUDGET_MS * factor);
    },
  );
});

/**
 * Fusion on `scale`: interactive when all four frames are past loading (the lists hold rows, the timeline has drawn,
 * no frame shows a status), timed in the page from navigation start. Then one trace click is timed to the frame
 * where Logs and Metrics both show the trace's scope and neither is loading.
 */
test(
  '100k spans, 1M logs: Fusion is interactive within 3 s and a trace click updates Logs and Metrics within 1 s',
  { tag: '@perf' },
  async ({ page, reportUrl, browserName }, testInfo) => {
    const factor = perfFactor();
    await page.addInitScript(() => {
      // A frame is loading while it shows a "Loading…" or "Scanning N of M chunks" status; the partial-result note
      // ("from 1 of 60 chunks") is a status too, but a finished state.
      const loading = (f: Element | null | undefined): boolean =>
        [...(f?.querySelectorAll('[role="status"]') ?? [])].some((s) =>
          /^(Loading|Scanning)/.test(s.textContent ?? ''),
        );
      const settled = (): boolean => {
        const frames = ['timeline', 'traces', 'logs', 'metrics'].map((id) =>
          document.querySelector(`[data-widget="${id}"]`),
        );
        if (frames.some((f) => f === null)) return false;
        const [timeline, traces, logs] = frames;
        const rows = (f: Element | null | undefined): number =>
          f?.querySelectorAll('[role="row"]').length ?? 0;
        return (
          frames.every((f) => !loading(f)) &&
          timeline?.querySelector('canvas') !== null &&
          rows(traces) >= 2 &&
          rows(logs) >= 2
        );
      };
      const mo = new MutationObserver(() => {
        if (!settled()) return;
        mo.disconnect();
        requestAnimationFrame(() => {
          (window as { __OH_FUSION_READY__?: number }).__OH_FUSION_READY__ = performance.now();
        });
      });
      mo.observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${reportUrl('scale')}/index.html#/dashboards/fusion`, { waitUntil: 'commit' });
    const interactiveMs = Number(
      await (
        await page.waitForFunction(
          () => (window as { __OH_FUSION_READY__?: number }).__OH_FUSION_READY__,
          null,
          {
            timeout: 30_000,
          },
        )
      ).jsonValue(),
    );

    // From the click to the frame after Logs says "for the selected trace", Metrics says "from the selected trace's
    // resources" and neither frame is loading.
    const selectionMs = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const row = document
            .querySelector('[data-widget="traces"]')
            ?.querySelectorAll<HTMLElement>('[role="row"]')[1];
          const logs = document.querySelector('[data-widget="logs"]');
          const metrics = document.querySelector('[data-widget="metrics"]');
          if (!row || !logs || !metrics) throw new Error('Fusion frames not found');
          const loading = (f: Element): boolean =>
            [...f.querySelectorAll('[role="status"]')].some((s) =>
              /^(Loading|Scanning)/.test(s.textContent ?? ''),
            );
          const done = (): boolean =>
            /for the selected trace/.test(logs.textContent ?? '') &&
            /selected trace's resources/.test(metrics.textContent ?? '') &&
            !loading(logs) &&
            !loading(metrics);
          const timer = setTimeout(
            () => reject(new Error('Logs and Metrics never followed the trace')),
            15_000,
          );
          const t = performance.now();
          const mo = new MutationObserver(() => {
            if (!done()) return;
            mo.disconnect();
            clearTimeout(timer);
            requestAnimationFrame(() => resolve(performance.now() - t));
          });
          mo.observe(document.body, { subtree: true, childList: true, characterData: true });
          row.click();
        }),
    );

    const line = `PERF fusion ${testInfo.project.name} (${browserName}): interactive ${interactiveMs.toFixed(0)} ms (budget ${FUSION_INTERACTIVE_BUDGET_MS * factor}), trace click to Logs and Metrics ${selectionMs.toFixed(0)} ms (budget ${FUSION_SELECTION_BUDGET_MS * factor}), factor ${factor}\n`;
    process.stdout.write(line);
    testInfo.annotations.push({ type: 'perf', description: line.trim() });
    expect(interactiveMs).toBeLessThan(FUSION_INTERACTIVE_BUDGET_MS * factor);
    expect(selectionMs).toBeLessThan(FUSION_SELECTION_BUDGET_MS * factor);
  },
);
