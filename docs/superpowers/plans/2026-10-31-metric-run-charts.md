# Run Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard metric widgets with `runBy` plot one point per run per line, with config-driven slider, even spacing, split and legend toggles, a y axis that follows the zoom, a reset button and local times.

**Architecture:** A new query (`runMetricRunQuery`) reduces a metric to one value per line per run, reusing the bucket engine. A new pure option builder and a new card draw it in one ECharts instance with one grid per plot. The metric widget picks the new path only when `runBy` is set, so bucket charts don't change.

**Tech Stack:** TypeScript, React 19, ECharts 6.1.0, zod, vitest, Playwright, mise.

**Spec:** `docs/superpowers/specs/2026-10-31-metric-run-charts-design.md`

## Execution Notes

- Approved by the requester, with subagent-driven execution chosen. Use superpowers:subagent-driven-development.
- The spec and this plan start uncommitted on `main`. Task 1 creates `feat/metric-run-charts` and commits them. Don't commit to `main`.
- Commit on that branch as the plan says. Don't push or open a PR until the requester asks.
- Don't change `mise.toml` dependency management. That cleanup is for later.
- The demo showing the agreed look is at https://claude.ai/artifact/WVoYinxP6uf9TjHBo29akL. Where it differs from the spec, the spec wins.
- If Chromium can't start for Task 8 because system libraries are missing, stop and tell the requester rather than skipping the end-to-end tests.

## Global Constraints

- `buildMetricChartOption`, `MetricChartCard`, the Metrics explorer and the Metric grid behave exactly as before, and their tests pass unchanged.
- No change to the report format or to what `otel-html ci` emits. Existing configs need no changes.
- Control defaults: `slider: true`, `evenSpacing: true`, `split: true`, `legend: false`.
- Tooltips open only on a dot, with `confine: true` and at most 280px wide. All data-derived tooltip text is escaped.
- Plain scrolling never zooms. Ctrl+scroll zooms. Dragging on the plot does nothing.
- A line's color never changes with zoom or hiding.
- Times show in the browser's time zone and locale.
- Code style matches the surrounding code. Run `mise run check` before finishing the branch.

## Review Focus

- A report or window with one run, or none: one run draws its dots and a single column, and none shows the existing "No data points in this window" state with no crash (Tasks 4 and 5).
- A job name containing markup such as `<img onerror=…>`: tooltip and legend show it as text (Tasks 4 and 5).
- Resizing the window or switching theme while zoomed with lines hidden: zoom, hidden lines and toggles all survive (Task 5).
- A zoom that leaves no run in view on the real-time axis: the y axis falls back to the full scale and the chart stays usable (Task 4).
- A report with some series missing the `runBy` attribute: those series are left out and counted in a card note, never drawn as a phantom run (Task 2).

---

### Task 1: Widget schema and config defaults

**Files:**
- Modify: `src/dashboards/schema.ts` (the metric output type near line 43, input type near line 119, strict object near line 236, `superRefine` near line 279)
- Modify: `src/viewer/dashboards/copy-config.ts` (`WIDGET_DEFAULTS.metric`)
- Modify: `schema/otel-html.schema.json` (generated), `README.md` (dashboard section)
- Test: `test/dashboards/schema.test.ts`, `test/viewer/copy-config.test.ts`

**Interfaces:**
- Produces: exported `interface RunControls { slider: boolean; evenSpacing: boolean; split: boolean; legend: boolean }`, `DEFAULT_RUN_CONTROLS: RunControls`, and on the metric widget `runBy: string | null`, `failedWhen: string | null`, `controls: RunControls | null`. `controls` is `null` without `runBy`, and filled from the defaults when `runBy` is set.

- [ ] **Step 1: Create the branch**

Run: `git switch -c feat/metric-run-charts`, then add the spec and this plan with `git add docs/superpowers`.

- [ ] **Step 2: Write the failing schema tests**

Tests, each parsing a metric widget with the matching fields:
- `runBy` with no `controls` parses to `controls` equal to `{ slider: true, evenSpacing: true, split: true, legend: false }`.
- `controls: { legend: true }` parses with the other three at their defaults.
- A widget with no `runBy` parses to `runBy: null`, `failedWhen: null`, `controls: null`.
- Each of these fails with an issue on the named path: `controls` without `runBy` (`controls`), `failedWhen` without `runBy` (`failedWhen`), `runBy` with formulas (`formulas`), with `queries: null` (`queries`), with two queries (`queries`), with `display: 'bars'` (`display`), with `scale: 'log'` (`scale`), an invalid `runBy` path (`runBy`), an invalid `failedWhen` condition (`failedWhen`).

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run test/dashboards/schema.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement the schema**

`runBy` validates with `compileBy`, and `failedWhen` with `compileCondition(value, 'datapoint')`, following the error handling in `MetricQuerySchema`. Add the rejections to the existing `superRefine`. Use `z.strictObject` for `controls` so a misspelled toggle is an error. Add the three fields to `WIDGET_DEFAULTS.metric` with value `null`, so `dashboardToYaml` omits them when they're unset. When `controls` equals the defaults, omit it in the copy too (add this to `test/viewer/copy-config.test.ts`).

- [ ] **Step 5: Regenerate and document**

Run: `mise run gen`. Add `runBy`, `failedWhen` and `controls` to the README's dashboard section, with the Job duration example from spec §5.

- [ ] **Step 6: Verify**

Run: `pnpm exec vitest run test/dashboards test/config test/viewer/copy-config.test.ts && mise run gen:check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers src/dashboards src/viewer/dashboards/copy-config.ts schema README.md test
git commit -m "feat(dashboards): runBy, failedWhen and controls on metric widgets"
```

### Task 2: Run query

**Files:**
- Create: `src/viewer/data/metric-run-query.ts`
- Modify: `src/viewer/data/metric-query.ts` (export `runAtLevel` and `coarsenedTo`, no behavior change)
- Test: `test/viewer/metric-run-query.test.ts` (build `LoadedMetric` the way `test/viewer/metric-query.test.ts` does)

**Interfaces:**
- Consumes: `compileSelector`, `targetOf` from `metric-where.ts`; `LoadedMetric`, `MetricQuery`, `TimeWindow`.
- Produces:

```ts
export interface RunInfo { id: string; time: number /* RelNanos */; revision: string | null }
export interface RunPoint { value: number; failed: boolean }
export interface RunLine { key: string; label: string; unit: string; points: (RunPoint | null)[] /* aligned with runs */ }
export interface RunQueryResult { queryId: string; runs: RunInfo[]; lines: RunLine[]; leftOut: number; notes: string[] }
export async function runMetricRunQuery(
  m: LoadedMetric,
  q: MetricQuery,
  opts: { window: TimeWindow; runBy: string; failedWhen: string | null },
  signal?: AbortSignal,
): Promise<RunQueryResult>;
```

- [ ] **Step 1: Write the failing tests**

Fixture: 3 runs, 2 jobs per run, histogram with `show: 'avg'`, each run and job on its own resource with `cicd.pipeline.run.id`. Tests:
- `one value per line per run`: `lines[*].points[*].value` equal the fixture's values, and `runs` are ordered by time.
- `labels are the group value`: `by` on the job name gives labels `['build', 'check']`, with no query prefix.
- `run time is the run's latest point`: `runs[0].time` equals the bucket start of that run's last point at the finest level.
- `a re-run job combines`: two points for one job in one run give the average.
- `failedWhen marks a point`: with `attributes["result"] == "failure"`, only the failing run's point has `failed: true`.
- `a line missing from a run has null there`.
- `a run outside the window is dropped`: narrowing the window to the first two runs returns 2 runs.
- `series without the run attribute are left out`: `leftOut` is the number of such series, a note says so, and no run has an empty id.
- `a folded other series counts as left out`.
- `empty by labels with the alias, else the metric name`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/viewer/metric-run-query.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Read the finest level with `m.level(m.levels[0].level, window)`. Get each series' run id from `compileSelector(null, [runBy]).groupOf(targetOf(e, s)).shown[0]`, and failure from `compileSelector(failedWhen, []).test`. For each run, take the level with only that run's series, coarsen it with `coarsenedTo` to one bucket (a width past the window end), and call `runAtLevel`. Each returned series' single point is that line's value for the run, which reuses `where`, `by`, `show` and label handling. Run time is the max of `t × widthNs` over the run's series, and `revision` comes from the resource's `vcs.ref.head.revision`. Check `checkShow` errors propagate, and tie-break run order by id.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run test/viewer/metric-run-query.test.ts test/viewer/metric-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/data test/viewer/metric-run-query.test.ts
git commit -m "feat(viewer): one value per line per run from a metric"
```

### Task 3: Scale, label and layout helpers

**Files:**
- Create: `src/viewer/components/run-chart-format.ts`, `src/viewer/components/run-chart-layout.ts`
- Test: `test/viewer/run-chart-format.test.ts`, `test/viewer/run-chart-layout.test.ts`

**Interfaces:**
- Produces:

```ts
// run-chart-format.ts
export function niceAxis(max: number, unit: string, maxTicks: number): { min: 0; max: number; interval: number };
export function formatTick(value: number, unit: string): string;
export function shortLabel(label: string): string;
export function runDateTime(epochUnixNano: string, relNanos: number, timeZone?: string): { date: string; time: string };
// run-chart-layout.ts
export interface PlotRect { left: number; top: number; width: number; height: number; xLabels: boolean }
export function plotRects(i: { width: number; height: number; plots: number; split: boolean; slider: boolean }):
  { rects: PlotRect[]; splitFits: boolean };
```

- [ ] **Step 1: Write the failing tests**

Exact values:
- `niceAxis(1254, 's', 5)` gives `{ min: 0, max: 1500, interval: 300 }`. `niceAxis(404, 's', 5)` gives `{ min: 0, max: 480, interval: 120 }`. `niceAxis(37, 's', 3)` gives `{ min: 0, max: 45, interval: 15 }`.
- Unit conversion: `niceAxis(404000, 'ms', 5)` gives `{ min: 0, max: 480000, interval: 120000 }`.
- Beyond the list: `niceAxis(60000, 's', 5)` gives interval `14400` (2 h doubles).
- A plain count: `niceAxis(87, '{request}', 5)` gives interval `20`, max `100`.
- `niceAxis(0, 's', 5)` gives a positive `max`.
- `formatTick`: `0,'s'` → `0s`, `30,'s'` → `30s`, `300,'s'` → `5m`, `5400,'s'` → `1h 30m`, `120000,'ms'` → `2m`.
- `shortLabel`: `binary (ubuntu-24.04-arm, linux-arm64)` → `binary linux-arm64`, `e2e (firefox)` → `e2e firefox`, `build` → `build`.
- `runDateTime` with `timeZone: 'America/New_York'` on a known instant returns that zone's date and time, not UTC's.
- `plotRects`, at `width: 1000, height: 500`:
  - Single plot, slider on versus off: height grows by the slider's reserved height.
  - 9 split: 9 rects in 3 columns and `splitFits: true`, with `xLabels` true only on the last row.
  - 4 split: 2 columns, each taller and wider than in the 9 case.
  - 5 split: 3 columns (`ceil(sqrt(5))`), and the last row's 2 rects are wider than the first row's 3.
  - Width 500 with 9 plots: 2 columns at most, each cell at least 230px wide.
  - 9 split at `height: 200`: `splitFits: false` and one rect.
  - No rect goes outside the width and height, on any of the above.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/viewer/run-chart-format.test.ts test/viewer/run-chart-layout.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

Duration steps in seconds: `[1,2,5,10,15,30,60,120,300,900,1800,3600,7200]`, the first where `ceil(max/step) <= maxTicks`, doubling past 7200. Below 1 s, and for other units, use a 1-2-5 sequence. Known time units are `s`, `ms`, `us`, `ns`. `By` uses a 1-2-5 sequence with `formatMetricValue` for its text. Use `Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone })` and `{ hour: '2-digit', minute: '2-digit', timeZone }`. Small-chart minimum plot height is 60px. Export `SPLIT_MIN_PLOT_PX = 60`.

- [ ] **Step 4: Run to verify they pass**

Run: same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/components/run-chart-format.ts src/viewer/components/run-chart-layout.ts test/viewer/run-chart-*.test.ts
git commit -m "feat(viewer): run chart tick, label and layout helpers"
```

### Task 4: Run chart option builder

**Files:**
- Create: `src/viewer/components/run-chart-option.ts`
- Modify: `src/viewer/components/chart.tsx` (add `TitleComponent` to `use()`)
- Test: `test/viewer/run-chart-option.test.ts`

**Interfaces:**
- Consumes: Task 2's `RunQueryResult`, Task 1's `RunControls`, Task 3's helpers; `ColorAssigner`; `mergeEchartsOption`.
- Produces:

```ts
export interface RunZoom { start: number; end: number } // RelNanos, both inclusive
export interface RunChartInput {
  result: RunQueryResult; controls: RunControls; hidden: ReadonlySet<string> /* line keys */;
  zoom: RunZoom | null; width: number; height: number; colors: ColorAssigner;
  epochUnixNano: string; selectedRun: string | null; echarts: Record<string, unknown> | null;
}
export function buildRunChartOption(i: RunChartInput): { option: ChartProps['option']; splitFits: boolean };
export function runYAxes(i: Pick<RunChartInput,'result'|'controls'|'hidden'|'zoom'>, split: boolean): { min: 0; max: number; interval: number }[];
export function runsInView(result: RunQueryResult, zoom: RunZoom | null): RunInfo[];
export function zoomFromEvent(result: RunQueryResult, evenSpacing: boolean, startValue: number, endValue: number): RunZoom | null; // null when every run is in view
```
Each data item carries `meta: { line: string; label: string; value: number; failed: boolean; run: RunInfo; runIndex: number }`.

- [ ] **Step 1: Write the failing tests**

With a 28-run-like fixture where the first run has a 1254 s outlier on one line:
- Split on, 9 lines: `grid.length === 9`, 9 `xAxis`, and a slider `dataZoom` whose `xAxisIndex` covers all 9. Split off: 1 grid holds all series.
- Slider off: no `type: 'slider'` entry, the `inside` one remains, and the grid is taller.
- `inside` has `zoomOnMouseWheel: 'ctrl'`, `moveOnMouseWheel: false`, `moveOnMouseMove: false`; both have `filterMode: 'none'`.
- Even spacing: `xAxis.type === 'category'` and point x values are run indexes. Off: `type === 'time'`, and a run's points on every line share one x.
- `tooltip.trigger === 'item'`, `confine === true`. The formatter escapes `<img src=x>` in a label and includes `failed` only for a failed point.
- `connectNulls: true` on each line and `cursor: 'pointer'`.
- A failed point has `symbol: 'diamond'`.
- Colors: a line has the same color when another line is hidden and when zoom changes.
- Lines past the seventh use `--oh-series-other`, each with a different dash type.
- `runYAxes` with no zoom has max 1500 on the single plot, and with a zoom excluding run 0 has max 480. Hiding the outlier line gives 480 with no zoom.
- `runYAxes` with a zoom containing no run returns the full-scale axis.
- `zoomFromEvent` round trip: even spacing indexes 3 and 27 map to run 3's and run 27's times, and 0 and 27 map to `null`.
- One-run result: one column, `showSymbol: true`, no throw. Empty result: no series, no throw.
- `selectedRun` draws a guide `markLine` on every plot.
- `echarts` merges last, so `{ animation: true }` wins.
- `x` labels use `runDateTime`, and only rects with `xLabels` show them.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/viewer/run-chart-option.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the builder**

Draw per spec §7. Key colors by label through `colors.colorFor(line.label)`, resolving the token with the same helper `metric-chart-option.ts` uses (export `seriesToken` and `token` from there if needed, with no behavior change). Small-chart titles use the `title` array with `shortLabel`. Each plot gets a guide series with id `guide<i>`, as in the demo. Set `animation: false`. Y ticks: 5 on a single plot, 3 on a small chart. Mixed units with one query can't occur except across series of one metric, so force split when `new Set(lines.map(unit)).size > 1`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run test/viewer/run-chart-option.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/components/run-chart-option.ts src/viewer/components/chart.tsx test/viewer/run-chart-option.test.ts
git commit -m "feat(viewer): build the run chart's ECharts option"
```

### Task 5: Run chart card

**Files:**
- Create: `src/viewer/components/run-chart-card.tsx`, `src/viewer/components/run-chart-legend.tsx`
- Test: `test/viewer/run-chart-card.test.tsx`, following `test/viewer/metric-chart-card.test.tsx` for mocking ECharts

**Interfaces:**
- Consumes: Task 4's builder, Task 1's `RunControls`.
- Produces:

```ts
export interface RunChartCardProps {
  title: string; subtitle: string; result: RunQueryResult; configured: RunControls;
  controls: RunControls; onControls(c: RunControls): void;
  height: number; epochUnixNano: string; selectedRun: string | null; echarts: Record<string, unknown> | null;
  onPickRun: ((runId: string) => void) | null; notes: string[];
}
export function RunChartCard(p: RunChartCardProps): JSX.Element;
```

The card owns `zoom` and `hidden`. Toggles are lifted to the widget so Copy config can read them (Task 6).

- [ ] **Step 1: Write the failing tests**

- The header shows 4 toggle buttons named `Slider`, `Even spacing`, `Split`, `Legend`, with `aria-pressed` matching `controls`, and `Reset`.
- Clicking a toggle calls `onControls` with only that key flipped.
- `Reset` is disabled when `controls` equals `configured`, zoom is null and nothing is hidden. It's enabled after each of: a toggle differing, a `datazoom` event, a hidden line. Each click restores all three to configured state.
- A `datazoom` event calls `setOption` with only new `yAxis` values (`max: 480` after excluding the outlier run), and doesn't rebuild the series.
- Legend off: no legend in the DOM. On: one row per line, showing the latest run in view's value and the change from the median in view.
- Hovering a legend row dispatches `highlight`. Clicking hides the line, and clicking the last visible line does nothing.
- A label `<img src=x>` renders as text in the legend, with no `img` element.
- A `mouseover` on a dot updates the legend to that run and draws the guide. `globalout` restores the latest.
- `onPickRun` is called with the run id when a dot is clicked. With `onPickRun: null`, the series `cursor` is `default`.
- Split that doesn't fit (small `height`): the `Split` toggle is pressed and disabled, and the note `Too small to split. Make this widget taller.` shows.
- Changing `result` to one with a different window clears zoom. Rerendering with an identical window keeps it.
- Resize and theme tick: after zooming and hiding a line, a resize and a `data-theme` change keep the same zoom, hidden lines and toggles.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/viewer/run-chart-card.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Use `Chart` with its `onInstance` and `onEvents`. The legend goes beside the chart with a CSS grid, under it below 820px, and is 290px wide. Measure the chart host with `ResizeObserver` for `width` and `height`, rebuilding the option on a size change. Re-read colors on theme change as `MetricChartCard` does. Legend rows are in fixed order by median over all runs. Legend text uses `shortLabel`, with the full name in `title`. Use existing Tailwind tokens and component patterns.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run test/viewer/run-chart-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/components/run-chart-card.tsx src/viewer/components/run-chart-legend.tsx test/viewer/run-chart-card.test.tsx
git commit -m "feat(viewer): run chart card with toggles, legend and reset"
```

### Task 6: Dashboard wiring

**Files:**
- Modify: `src/viewer/dashboards/widgets/metric.tsx` (new `RunBody`, chosen in `MetricWidget` when `widget.runBy !== null`)
- Modify: `src/viewer/dashboards/dashboard-page.tsx` (`WidgetActions`, session toggle state, Copy config)
- Modify: `src/viewer/dashboards/copy-config.ts` (`dashboardToYaml` gains a controls override)
- Test: `test/viewer/dashboard-metric.test.tsx`, `test/viewer/dashboard-page.test.tsx`, `test/viewer/copy-config.test.ts`

**Interfaces:**
- Consumes: `runMetricRunQuery`, `RunChartCard`.
- Produces: on `WidgetActions`, `setVariable(key: string, value: string): void`, `setControls(c: RunControls): void`, and the widget prop `controls: RunControls | null` (the session value, falling back to `widget.controls`). `dashboardToYaml(d, layout, controls?: Readonly<Record<string, RunControls>>)`. `runByKey(runBy: string): string | null` in `scope.ts` returns the attribute key of a `resource.attributes["…"]` path.

- [ ] **Step 1: Write the failing tests**

- A `runBy` widget renders `RunChartCard` with `runMetricRunQuery` results, and a widget without it still renders `MetricChartCard`.
- Run mode ignores a binding on its own `runBy` key (the query's `where` omits it), and other bindings still narrow it. The bound value reaches the card as `selectedRun`.
- Clicking a dot calls `setVariable('cicd.pipeline.run.id', '<run>')` when the dashboard has that variable. Without one, `onPickRun` is `null`.
- `setVariable` updates the page state the variables bar reads, and the bar shows the value.
- Toggling survives a re-render of the page, and is not in the URL.
- `dashboardToYaml` with a controls override writes those toggles, and parsing the YAML gives them back. Zoom and hidden lines aren't written.
- `leftOut` becomes a card note, and a query error or missing metric shows the same empty and error states as `QueriesBody`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run test/viewer/dashboard-metric.test.tsx test/viewer/dashboard-page.test.tsx test/viewer/copy-config.test.ts`
Expected: new tests FAIL.

- [ ] **Step 3: Implement**

`RunBody` follows `QueriesBody` for the catalog, narrowing, loading and error states, using `useKeyedAsync` for the query. Toggle state is a `useState` record keyed by widget id in the dashboard page. `setVariable` uses the same state change the variables bar makes. Keep "Open in Metrics" as is.

- [ ] **Step 4: Run to verify they pass**

Run: same command as Step 2, then `pnpm exec vitest run test/viewer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/dashboards test/viewer
git commit -m "feat(dashboards): metric widgets with runBy draw run charts"
```

### Task 7: CI dashboards

**Files:**
- Modify: `.github/actions/otel-html-publish/otel-html-ci.yaml`, `.github/workflows/ci-report.yml` (line 72's publish step gets `config:`)
- Create: `.github/otel-html-ci.yaml`
- Test: `test/cli/ci/dashboard-config.test.ts`

**Interfaces:**
- Consumes: Task 1's schema.

- [ ] **Step 1: Write the failing test**

Tests:
- Both YAML files parse through the dashboard config schema.
- In the shipped file, Job duration has `runBy`, `h: 20`, `w: 12`, the `failedWhen` from spec §5 and default controls. Queue time has `runBy`, `w: 6`, `h: 12`, `controls.split: false` and no `failedWhen`. Steps has `h: 12`. No two widgets overlap.
- `the repo copy differs only by the ci filter`: delete `where` from the Job duration and Queue time queries in the parsed repo copy, then `expect(copy).toEqual(shipped)`. Both those queries' `where` equal `resource.attributes["cicd.pipeline.name"] == "ci"`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run test/cli/ci/dashboard-config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update both YAML files and the workflow**

Move the rows below each changed widget down. In `ci-report.yml`'s publish step, add `config: .github/otel-html-ci.yaml`, and keep the `cleanup` step as it is.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run test/cli/ci` and `node dist/cli/main.js --help >/dev/null` after `mise run build:lib` to confirm the build still runs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github test/cli/ci/dashboard-config.test.ts
git commit -m "feat(ci): job duration and queue time as run charts"
```

### Task 8: End-to-end coverage

**Files:**
- Modify: `e2e/global-setup.ts` (a `run-charts` report and config), the `ReportName` type in `e2e/test.ts` as needed
- Create: `e2e/run-chart.spec.ts`

**Interfaces:**
- Consumes: everything above. Expose nothing new in product code. Read chart state through the existing helpers in `e2e/metric-chart.ts`, extending that file if it lacks a way to read the option.

Fixture: 6 runs with uneven gaps, 9 jobs including one 3-part name, a 1254 s outlier on one job in the oldest run, a failed job in run 3, a `cicd.pipeline.run.id` dashboard variable, and default controls.

- [ ] **Step 1: Write the tests**

Using `test.use({ timezoneId: 'Asia/Tokyo' })` for the file:
- `opens split with the slider and no legend`: 9 grids, and pressed state on Slider, Even spacing and Split only.
- `dragging the slider past the outlier tightens the y axis, and back widens it`: read the outlier job's y max, drag with a real mouse, starting 2px inside the handle, and assert it shrinks then returns.
- `each toggle fills the space and leaves the widget size alone`: for Slider, Legend and Split, the widget's bounding box is unchanged and the plot rectangles change.
- `spacing keeps the same runs in view`: zoom, toggle Even spacing, and the first and last runs inside the chart's `dataZoom` range are unchanged.
- `tooltip only on a dot`: hover a dot and the tooltip is visible and inside the widget box, with cursor `pointer`. Move to empty plot and the tooltip is hidden.
- `plain wheel scrolls the page and doesn't zoom`.
- `Reset after a zoom`, `Reset after a hidden line`, `Reset after a toggle`: three separate tests, each asserting configured state is restored and the button ends disabled.
- `clicking a dot filters to the run and keeps all columns`: the variable shows the run, the chart still has every run and a guide is drawn.
- `labels are in local time`: an x label matches the fixture instant formatted for Asia/Tokyo.
- `Copy config writes the current toggles`, using `e2e/clipboard.ts`.

- [ ] **Step 2: Run**

Run: `OTEL_HTML_SKIP_BROWSER_INSTALL=1 mise run test:e2e:chromium -- e2e/run-chart.spec.ts`
Expected: PASS. Any failure is a product bug to fix in the owning file, not a test to relax. Chromium needs its system libraries: `libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libdbus-1-3 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libxres1 libgbm1 libxcb1 libxkbcommon0 libasound2t64 fontconfig fonts-dejavu-core`.

- [ ] **Step 3: Full verification**

Run: `mise run check`, `mise run gen:check`, and `OTEL_HTML_SKIP_BROWSER_INSTALL=1 mise run test:e2e:chromium`
Expected: all PASS, with no change to existing test files other than the additions above.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): run chart toggles, zoom, tooltip, reset and local time"
```
