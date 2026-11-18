# Trend buckets and preview browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CI dashboard's Runs over time widget shows today's runs under today's label (#352), and a deployer pass no longer installs a browser and its apt packages to screenshot the rolling report (#353).

**Architecture:** `trendBuckets` aligns its buckets to round local times instead of the window start (the same rule `minutesPerDay` already follows for days), and the bucket zoom clamps to the window. `preview.mjs` launches the browser channel `PLAYWRIGHT_CHANNEL` names, and the deploy action sets `chrome` (GitHub's Ubuntu images ship Google Chrome) and drops `playwright install --with-deps`.

**Tech Stack:** TypeScript (viewer, vitest), a Node ESM script and a composite action (Playwright).

**Spec:** issues #352 and #353 (the diagnosis is in each). PR process: **unattended** (`docs/agents/process-unattended.md`); the maintainer authorised this PR's change to the `otel-html-deploy` action in the session ("fix them both now unattended in the same pr").

## Global Constraints

- One PR, branch `fix/trend-buckets-and-preview-browser`, title `fix: align the runs trend's buckets to local days and screenshot previews with the runner's Chrome`.
- No new dependency. Report format, public API and CLI flags unchanged.
- The README is the product documentation: both behaviour changes update it in the same task that makes them.
- Conventions: TDD per task; `pnpm exec biome check .` and `mise run typecheck` before each commit; `mise run check` after an edit; `mise run verify` before the PR.

## Review Focus

- A window that starts mid-day with a 1-day step: the run at 17:34 on the last day is in the bucket whose start is that day's local midnight, never the previous day's (Task 1, test "day buckets start at local midnight").
- A sub-day step: buckets start on the step grid counted from local midnight (18:00, 19:00, …), not at 18:34 (Task 1, test "sub-day buckets start on the step grid from local midnight").
- Runs before `span[0]` or after `span[1]` are not counted even when the aligned first or last bucket would hold them (Task 1, test "runs outside the span are left out").
- The zoom menu on a partial first or last bucket zooms to the part inside the window, not before `span[0]` or after `span[1]` (Task 1, `dashboard-cicd-zoom.test.tsx`).
- A browser channel that does not exist on the machine is a `::warning::` and exit 0 with the previous images kept (Task 2, e2e test).

---

### Task 1: Align the trend's buckets to local time (#352)

**Files:**
- Modify: `src/viewer/cicd/derive.ts:260-297` (`trendBuckets`, `TrendBucket`)
- Modify: `src/viewer/cicd/views/runs-trend.tsx:44-47` (the call) and `:111-121` (the zoom menu)
- Modify: `README.md:389` (the `runs-trend` row)
- Test: `test/viewer/cicd/derive.test.ts` (`describe('trendBuckets')`), `test/viewer/dashboard-cicd-zoom.test.tsx` (its `trendBuckets` mock)

**Interfaces:**
- Produces: `trendBuckets(runs: readonly CiRun[], span: readonly [number, number], epochNs: bigint): { step: number; buckets: TrendBucket[] }` and `TrendBucket` gains `end: number` (the bucket's exclusive end, run-relative ns, unclipped like `t`). `bucketStep` is unchanged: the step still depends on `span` and the run count only; the aligned bucket count may be one more than its bound.

- [ ] **Step 1: Write the failing tests** in `describe('trendBuckets')` of `test/viewer/cicd/derive.test.ts`. Add `const HOUR = 60 * MIN;` beside `DAY`. Give the existing three tests and `bucketOf`'s, `empty input`'s calls an epoch at a local midnight, `const EPOCH = BigInt(new Date(2026, 0, 1).getTime()) * 1_000_000n;` (relative 0 is then a midnight, so the existing expectations hold: the 12-run test still gives 4 buckets of `[4, 4, 4, 0]`). Then:

```ts
  // The relative time of a local wall-clock moment, for an epoch at local 2026-01-01 18:34.
  const EVENING = BigInt(new Date(2026, 0, 1, 18, 34).getTime()) * 1_000_000n;
  const at = (epoch: bigint, ...d: [number, number, number, number?, number?]): number =>
    Number(BigInt(new Date(2026, d[0], d[1], d[2], d[3] ?? 0).getTime()) * 1_000_000n - epoch);
  // d[0] is the month index; d[1] the day; d[2] the hour; d[3] the minute

  test('day buckets start at local midnight, so a run before the window start's time of day keeps its date', () => {
    // 21 runs over a week starting 18:34: floor(21/3) = 7 buckets allowed, 7 d / 1 d = 7, so the step is 1 d.
    const runs = Array.from({ length: 21 }, (_, i) => run(at(EVENING, 0, 2 + Math.floor(i / 3), 3 + 7 * (i % 3))));
    const late = run(at(EVENING, 0, 8, 17, 34)); // Jan 8 17:34, inside the window, before 18:34
    const t = trendBuckets([...runs, late], [0, 7 * DAY + MIN], EVENING);
    expect(t.step).toBe(DAY);
    expect(t.buckets.map((b) => b.t)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((d) => at(EVENING, 0, d, 0)));
    expect(t.buckets.map((b) => b.end)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((d) => at(EVENING, 0, d, 0)));
    expect(t.buckets[7]?.runs).toContain(late);
    expect(t.buckets.map((b) => b.runs.length)).toEqual([0, 3, 3, 3, 3, 3, 3, 4]);
  });

  test('sub-day buckets start on the step grid from local midnight', () => {
    const t = trendBuckets([run(0), run(HOUR), run(5 * HOUR)], [0, 6 * HOUR], EVENING);
    expect(t.step).toBe(HOUR);
    expect(t.buckets[0]?.t).toBe(-34 * MIN);
    expect(t.buckets).toHaveLength(7);
    expect(t.buckets.at(-1)?.t).toBe(at(EVENING, 0, 2, 0));
    expect(t.buckets.map((b) => b.runs.length)).toEqual([1, 1, 0, 0, 0, 1, 0]);
  });

  test('runs outside the span are left out of the partial buckets', () => {
    const t = trendBuckets([run(-10 * MIN), run(6 * HOUR + MIN), run(MIN)], [0, 6 * HOUR], EVENING);
    expect(t.buckets.reduce((s, b) => s + b.runs.length, 0)).toBe(1);
  });
```

In `test/viewer/dashboard-cicd-zoom.test.tsx`, give the mocked bucket an `end` (`t + step`, with `step` the mock's step) and assert the zoomed window the test already checks is clamped: with a bucket whose `t` is before the span start, the selected window starts at the span start. Read the test to place that; if its span and bucket already sit inside each other, add one case where `t` is `span.start - 1_000_000_000` and `end` is `span.end + 1_000_000_000` and the selection equals the span.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run test/viewer/cicd/derive.test.ts test/viewer/dashboard-cicd-zoom.test.tsx`
Expected: FAIL (type error on the third argument / `end`, and the alignment expectations).

- [ ] **Step 3: Implement** in `src/viewer/cicd/derive.ts`:

`trendBuckets(runs, span, epochNs)`; `TrendBucket.end`. Bucket bounds, as run-relative ns:
- `midnight(rel)`: the local midnight of the day `rel` falls in, as relative ns (`new Date(ms)`, then `new Date(y, m, d)`, with `ms = Number(epochNs / 1_000_000n) + rel / 1e6`; back to relative ns by the inverse). The same arithmetic `minutesPerDay` uses.
- step < DAY: `first = midnight(span[0]) + floor((span[0] - midnight(span[0])) / step) * step`; the bounds are `first + i * step` while `< span[1]`, plus the closing bound.
- step ≥ DAY: the bounds are local midnights stepped by `step / DAY` days from `midnight(span[0])` with `Date` day arithmetic (`new Date(y, m, d + k * days)`), while `< span[1]`, plus the closing bound. Every bound is a true local midnight across a DST change.
- Buckets are the consecutive bound pairs (`t`, `end`); a run goes to the bucket with `t <= r.start < end`; runs with `r.start < span[0]` or `r.start > span[1]` are skipped as now. `p50`/`p95` as now. Empty `runs` still returns `{ step, buckets: [] }`.

In `runs-trend.tsx`: pass `epoch` to `trendBuckets` (and to the memo's dependencies); the zoom menu selects `{ start: Math.round(Math.max(b.t, span[0])), end: Math.round(Math.min(b.end, span[1])) }`.

README `runs-trend` row: after "counts per bucket", add "(buckets start on round local times: midnight for a step of a day or more, the step's multiples from midnight for a shorter one, so the first and the last bucket may be partial; the subtitle names the step)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run test/viewer/cicd/derive.test.ts test/viewer/dashboard-cicd-zoom.test.tsx test/viewer/cicd/format.test.ts`
Expected: PASS. Then `pnpm exec biome check .`, `mise run typecheck`, `mise run check`.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/cicd/derive.ts src/viewer/cicd/views/runs-trend.tsx test/viewer/cicd/derive.test.ts test/viewer/dashboard-cicd-zoom.test.tsx README.md
git commit -m "fix(viewer): align the runs trend's buckets to local days and hours"
```

### Task 2: Screenshot previews with the runner's Chrome (#353)

**Files:**
- Modify: `.github/actions/otel-html-deploy/preview.mjs:17-18` (the environment comment) and `:141` (`chromium.launch()`)
- Modify: `.github/actions/otel-html-deploy/action.yml` (the `preview` input's description; the "Install the preview browser" and "Screenshot the rolling reports" steps)
- Modify: `README.md:730` (the `preview` input row)
- Test: `e2e/preview.spec.ts`

**Interfaces:**
- Produces: `preview.mjs` reads `PLAYWRIGHT_CHANNEL` (optional): when set and non-empty, `chromium.launch({ channel })`; else `chromium.launch()` as now. The action sets `PLAYWRIGHT_CHANNEL: chrome` on the screenshot step.

- [ ] **Step 1: Write the failing test** in `e2e/preview.spec.ts`. Give `runPreview` an optional `env: Record<string, string> = {}` spread into the child's env after `PLAYWRIGHT_FROM`, then:

```ts
  test('warns and keeps the previous images when the browser channel does not exist', () => {
    siteOf(site, 'dashboards');
    for (const scheme of ['light', 'dark'])
      writeFileSync(join(dir, `preview-${scheme}.png`), `previous ${scheme}`);
    const result = runPreview(site, { PLAYWRIGHT_CHANNEL: 'no-such-browser' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::otel-html preview:');
    for (const scheme of ['light', 'dark']) {
      expect(readFileSync(join(dir, `preview-${scheme}.png`), 'utf8')).toBe(`previous ${scheme}`);
      expect(existsSync(join(dir, `preview-${scheme}.png.tmp`))).toBe(false);
    }
  });
```

- [ ] **Step 2: Run the spec to verify the new test fails**

Run: `mise run test:e2e:chromium -- e2e/preview.spec.ts`
Expected: the new test FAILS (the script ignores the variable, launches the bundled Chromium and writes new images); the four existing tests pass.

- [ ] **Step 3: Implement**

`preview.mjs`: read `process.env.PLAYWRIGHT_CHANNEL`; `chromium.launch(channel ? { channel } : {})`; extend the environment comment ("PLAYWRIGHT_CHANNEL, optional: a Playwright browser channel such as `chrome`, the machine's Google Chrome; empty launches Playwright's own Chromium").

`action.yml`:
- "Install the preview browser": keep the `npm install --prefix "$dir" --no-audit --no-fund @playwright/test@1.64.1` line, delete the `playwright install --with-deps chromium` line; rename the step "Install the preview driver".
- "Screenshot the rolling reports": add `PLAYWRIGHT_CHANNEL: chrome` to its `env`.
- `preview` input description: replace "Installs Playwright's Chromium (about 1 minute); needs Node and passwordless sudo on the runner. A failed install or screenshot is a warning." with "Drives the runner's Google Chrome (GitHub's Ubuntu images ship it) through `@playwright/test`, installed in a few seconds; needs Node on the runner. A failed install, a missing Chrome or a failed screenshot is a warning."

README row 730: the same replacement as the input description.

- [ ] **Step 4: Run the spec to verify it passes**

Run: `mise run test:e2e:chromium -- e2e/preview.spec.ts`
Expected: PASS (5 tests). Then `pnpm exec biome check .`, `mise run typecheck`, `mise run check`, and `mise run gen:check` (the README's generated section is untouched; this only confirms it).

- [ ] **Step 5: Commit**

```bash
git add .github/actions/otel-html-deploy/preview.mjs .github/actions/otel-html-deploy/action.yml e2e/preview.spec.ts README.md
git commit -m "ci(deploy): screenshot previews with the runner's Chrome instead of installing Chromium"
```

### After both tasks

- `mise run verify` on the branch; branch review on Opus 5.5; `gh pr create` with the title above and a body carrying `Fixes #352`, `Fixes #353`, per issue what changed and what was decided against (a cache of `~/.cache/ms-playwright` and dropping `--with-deps` alone were rejected: both keep a download per pass; `channel: 'chrome'` needs none), the measurements (this run's 399 s install vs the typical 15 s, the deploy step's remaining costs, link #354), and the note that the maintainer authorised the deploy action change in the session.
- Merge on green CI; the first deploy pass after the merge is the measurement: report the "Install the preview driver" step's duration and that `preview-light.png` on the live site was refreshed (its `Last-Modified` or the screenshot step's log), in the session summary.
