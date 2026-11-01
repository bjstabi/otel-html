# Run charts for dashboard metric widgets

## 1. Intent

The CI dashboard's Job duration chart should answer one question: how has each job performed across recent runs?
Today it can't. Points don't join into lines, all jobs are the same grey, the legend runs to three pages, and the
tooltip is large, clipped and always on.

The cause is structural. Metric widgets plot time buckets, but a CI job produces one point per run, so its points
sit far apart with empty buckets between them. This design adds a widget mode whose x axis is the run. It fixes
Job duration and Queue time first. Other metric charts have similar problems, and they come later.

The agreed look comes from a throwaway demo, kept outside the repo:
[Job Duration Chart](https://claude.ai/artifact/WVoYinxP6uf9TjHBo29akL). It uses ECharts 6.1.0 with the last 28 real
runs. Where this document and the demo differ, this document wins.

## 2. Goals

- Each job is a line, and all points from one run share one x position.
- Slider, even spacing, split and legend toggles sit on the chart, and each default is set in the dashboard config.
- Turning a toggle on or off gives its space to the plot. The widget itself doesn't change size.
- The y axis follows what's in view, zooming in as well as out, with round tick values.
- A reset button returns the chart to its configured state.
- Dates and times are shown in the viewer's local time zone.

## 3. Non-goals

- Reworking the metric charts that plot time buckets: other dashboard widgets, the Metrics explorer and the Metric
  grid. They must behave exactly as they do now.
- Changing the report format or what `otel-html ci` emits.
- Log scale, areas, bars or heatmaps in run mode.
- Changing the dashboard's own time display (the header range and the timeline).

## 4. Anti-goals

The work has failed, even if it technically runs, if:

- a tooltip opens when the pointer isn't on a dot, or gets clipped by the widget
- plain scrolling over a chart zooms it instead of moving the page
- a job's color changes when another job is hidden or the zoom changes
- hiding a toggle's feature leaves an empty gap

## 5. Configuration

A metric widget enters run mode when it has `runBy`. Toggle defaults live in `controls`.

```yaml
- type: metric
  title: Job duration
  x: 0
  y: 6
  w: 12
  h: 20
  runBy: resource.attributes["cicd.pipeline.run.id"]
  failedWhen: attributes["cicd.pipeline.task.run.result"] == "failure" or attributes["cicd.pipeline.task.run.result"] == "timeout" or attributes["cicd.pipeline.task.run.result"] == "error"
  controls:
    slider: true
    evenSpacing: true
    split: true
    legend: false
  queries:
    - id: a
      metric: cicd.pipeline.task.run.duration
      show: avg
      by: ['attributes["cicd.pipeline.task.name"]']
```

| Field | Type and default | Meaning |
|---|---|---|
| `runBy` | path, default `null` | Data point path whose value identifies a run. Validated with `compileBy`. |
| `failedWhen` | OTTL condition, default `null` | Marks a run's point as failed. Validated with `compileCondition(…, 'datapoint')`. |
| `controls.slider` | boolean, default `true` | The zoom slider. |
| `controls.evenSpacing` | boolean, default `true` | On: one evenly spaced column per run. Off: runs on real time. |
| `controls.split` | boolean, default `true` | On: one small chart per line. Off: all lines on one plot. |
| `controls.legend` | boolean, default `false` | The job list beside the plot. |

The schema rejects these combinations, each with a message that names the field:

- `failedWhen` or `controls` without `runBy`
- `runBy` with `formulas`, with `queries: null` or more than one query, with `display` other than `lines`, or with
  `scale: log`

`exemplars` and `echarts` remain legal with `runBy`. `exemplars` is ignored in run mode because exemplars have no
place on a run axis. `echarts` still merges last.

Update `src/dashboards/schema.ts` (input and output types), `WIDGET_DEFAULTS` in
`src/viewer/dashboards/copy-config.ts`, `schema/otel-html.schema.json` through `mise run gen`, and the README's
dashboard section. Existing configs need no changes and render as before.

`.github/actions/otel-html-publish/otel-html-ci.yaml` changes both the Job duration and Queue time widgets to run
mode, and the rows below them move down:

- **Job duration:** as above, at full width and `h: 20`, which leaves each of 9 small charts about 105px of plot.
- **Queue time:** keeps `w: 6` and goes to `h: 12`, with Steps beside it matching. It sets `split: false` and has no
  `failedWhen`, because queue points carry no job result and a missing attribute would compare as not equal.

The rolling report holds every workflow's runs, so this repo's `load` jobs would otherwise appear as extra lines and
columns. The shipped file is the default for everyone using the action and can't assume a workflow named `ci`, so it
has no workflow filter. This repo adds `.github/otel-html-ci.yaml`, a copy of the shipped dashboard with
`where: resource.attributes["cicd.pipeline.name"] == "ci"` on these two queries, and passes it through the action's
`config` input in `ci-report.yml`. `load` run durations leave these two charts as a result. The copy can drift from
the shipped file, so add a test that they differ only by those `where` lines.

## 6. Data

Add a run query next to `runMetricQuery` in `src/viewer/data/metric-query.ts`. It uses the existing `where`, `by` and
`show` handling and returns one value per line per run.

- **Finding runs.** Evaluate `runBy` against each series. The CI data has a separate resource per job in each run, so
  the value is known from the series definition without reading points. A series with no value is left out, and the
  card shows a note saying how many were left out. A series folded into `other` is treated the same way.
- **Run time.** A run's time is the latest data point of the widget's query. On Job duration that's when the last job
  finished, and on Queue time it's when the last job started, so one run's time can differ slightly between the two
  charts. That's accepted. Reading level 0 gives this to about a second. Latest point is used because aggregated
  levels don't keep a point's start time, so run start would need a format change.
- **Value.** The `show` aggregate over all the run's points on that line. A re-run job's attempts in one run combine
  this way.
- **Failure.** A run's point on a line is failed if any of its points match `failedWhen`.
- **Window.** The query covers the dashboard's window (`scope.window ?? run`). A run belongs to the window if its run
  time does.
- **Variables.** The widget's other variables and the selected trace narrow it as usual, with one exception in §8.

Lines and their labels come from `by` as now. In run mode the label is the group value only, with no `a · avg ·`
prefix. If `by` is empty, the label is the query's alias or metric name. If a line has no point in a run, it joins its
neighbouring points across that run (`connectNulls: true`), so a report mixing workflows still draws whole lines.
Before a line's first point and after its last, it draws nothing.

Runs are ordered by run time, with the run id as a tie-break. Local time formatting comes from
`manifest.epochUnixNano` plus the relative time.

## 7. The chart

Run mode gets its own option builder, for example `src/viewer/components/run-chart-option.ts`, and its own card,
both in `src/viewer/components/`. `buildMetricChartOption` and `MetricChartCard` don't change, because their bucket
logic (drag zoom, click menu) assumes a single time grid.

Everything is drawn in one ECharts instance with one grid per plot, so one slider drives every small chart. Add
`TitleComponent` to `use()` in `chart.tsx`. The instance's height is the widget's available height, as for the
existing card.

### Toggles and layout

Small toggle buttons and the reset button sit in the card's header row. Each uses `aria-pressed`, and they wrap at
narrow widths. Plot rectangles are computed in pixels from the chart's size and the current toggles, and recomputed
when either changes:

- **Slider off:** the plots take its height.
- **Legend off:** the plots take its width. Below 820px wide the legend sits under the plot instead of beside it.
- **Split on:** rows share the height. The column count is at most `ceil(sqrt(n))` and keeps each chart at least
  230px wide. A short last row stretches across the width. Only the bottom row of charts shows x labels.
- **Split with few lines:** the remaining charts grow, and one line fills the widget.
- **Split that doesn't fit:** if a small chart's plot would be under 60px tall, draw a single plot instead, show the
  Split toggle as on but disabled, and add the card note "Too small to split. Make this widget taller."

### Axes

- **X, even spacing:** a category axis of runs, with a faint vertical line through each column.
- **X, real time:** a time axis over the runs' extent. Each run's points still share one x.
- **X labels:** local date over local time on two lines (for example `Oct 30` over `07:56`), in the browser's locale
  and with overlaps hidden. Space is reserved so no label is cut off.
- **Y:** starts at 0 with a tick step picked so there are at most 5 ticks on one plot and 3 on a small chart.
  - Durations step through 1, 2, 5, 10, 15 and 30 s, 1, 2, 5, 15 and 30 min, and 1 and 2 h. Ticks read `30s`, `5m`,
    `1h 30m`, and zero reads `0s`.
  - Units without a time or byte meaning use a 1-2-5 step and the existing `formatMetricValue`. The builder may
    choose the byte steps.
  - The series in one plot must share a unit. With mixed units, keep each unit in its own small chart and force split
    on, as `layoutCharts` already does.

### Zoom and the vertical scale

- The slider changes a zoom held by the card. It doesn't change the dashboard's window, the URL or the other widgets.
- Zoom is stored as a pair of times, so switching spacing keeps the same runs in view.
- A `datazoom` event recomputes every plot's y scale from the visible lines and the runs in view, in both directions.
  Hiding or showing a line does the same.
- Lines run off the plot edge to runs out of view (`filterMode: 'none'`), and the y scale ignores those runs.
- Ctrl+scroll zooms over the plot. Plain scrolling is left to the page, and dragging on the plot does nothing.
- If the dashboard's window changes, the zoom clears.

In a real browser, dragging the slider past the 20m 54s run tightened the demo's y axis from 25m to 8m. Tests should
keep this case (§10).

### Hover and click

- A tooltip opens only on a dot (`trigger: 'item'`), with `confine: true` and at most 280px wide. It shows the full
  job name, the value, `failed` if it applies, and the run's local time and short commit if the resource has
  `vcs.ref.head.revision`.
- Dots use the pointer cursor. Hovering one draws a vertical guide through that run on every plot. On a single plot it
  also dims the other lines.
- Clicking a dot filters the dashboard to that run (§8).
- Failed points are status-colored diamonds, and the tooltip says `failed`, so color isn't the only signal.

### Color

Colors are keyed on the line's label through the existing `ColorAssigner`, not on `resourceService`, because every
job shares service `ci`. A line keeps its color through zooming and hiding. Lines past the seventh use
`--oh-series-other`, and each further line in that color gets a different dash so the lines stay distinct.

### Legend

The legend shows a row per line with its name, its value in the hovered run (otherwise the latest run in view) and
its change from the median in view. Rows are in a fixed order by median, so they don't move under the pointer.
Hovering a row highlights its line, and clicking hides or shows it. At least one line always stays visible.

### Long names

Show the shortened form `binary linux-arm64` for `binary (ubuntu-24.04-arm, linux-arm64)`, by keeping the part before
the parentheses and the last comma-separated part inside them. The full name goes in the tooltip and the row's title.
This applies to any label with that shape.

### Reset

Reset returns the widget to its configured state: the toggles as set in `controls`, all runs in view and no lines
hidden. It's disabled only when the widget already matches that state.

The demo's Reset left the toggles alone and was disabled until you zoomed or hid a line. It did restore zoom in a
Chromium test, so the reported failure didn't reproduce with a zoomed chart. The likely explanation is that it looked
dead after only changing toggles, which this behavior fixes. An e2e test must cover each path (§10).

## 8. Dashboard behavior

- Toggle and zoom changes last until the page reloads and don't go in the URL.
- Copy config writes the current toggles into `controls`, as it does for layout edits. The zoom and hidden lines
  aren't config and aren't copied.
- Add `setVariable(key, value)` to `WidgetActions`. Clicking a dot sets the dashboard variable whose key is the
  attribute in `runBy`. If no variable has that key, the click does nothing and dots have no pointer cursor.
- Run mode ignores a bound variable for its own `runBy` attribute, so filtering to a run doesn't collapse the chart to
  a single column. It draws the guide through that run instead.
- "Open in Metrics" stays and opens the queries as they are, in the explorer's bucket view.

## 9. Data limits

- The report keeps 30 runs per workflow on a branch page and 10 on a PR page, through the publisher's retention
  inputs. The live `main` report held only 3 runs when this was written because that layout had just shipped, so the
  chart will look sparse until runs accumulate.
- Each job in each run is a separate series, and `metricSeriesCap` defaults to 1,000 per metric. Retained CI data is
  around 270 per metric, which fits. Past the cap, series fold into `other` and the note in §6 appears.

## 10. Verification

- **Unit:** schema acceptance and each rejection, run query results (runs a line lacks, re-runs, failures, missing
  `runBy`), tick steps, label shortening, plot layout including the split fallback, and the two config files matching.
- **Regression:** existing metric chart tests pass unchanged, and `mise run gen:check` passes.
- **e2e against a fixture with several runs and an outlier:**
  - Dragging the slider past the outlier shrinks the y axis, and dragging back grows it.
  - Each toggle changes the plot rectangles and leaves the widget's size alone.
  - Switching spacing keeps the same runs in view.
  - A tooltip appears on a dot and not on empty plot, stays inside the widget, and the cursor is a pointer on a dot.
  - Reset restores the configured state after each of these separately: a zoom, a hidden line and a changed toggle.
  - The time zone test sets a non-UTC `timezoneId` and checks a label.

  Grab the slider handle a little inside its edge. A drag starting on the outermost pixel didn't register in testing.

## 11. Decided by the requester

- The chart's features are toggles on one chart, for slider, spacing, split and legend, each filling the space when
  off.
- Slider, even spacing and split default to on.
- Toggle defaults belong in the dashboard config.
- The y axis must rescale with the slider, both ways.
- There is a reset button.
- Times are local.

## 12. Calls made by the author, open to change

- Legend defaults to off, since it wasn't in the requested defaults list.
- The x position in real-time mode is the run's end, not its start.
- Reset also restores the toggles.
- The first version covers `runBy` widgets only, and Job duration and Queue time are the two adopting it.
- These two widgets show the `ci` workflow only.
- Clicking a dot filters the dashboard to that run.
- `failedWhen` is added as a config field, and skipped or cancelled jobs don't count as failed.
- A run widget takes exactly one query.
- Lines join across runs where they have no point, unlike the demo.
- This repo gets its own copy of the dashboard config to carry the `ci` filter, and the action's shipped default stays
  unfiltered.
- Job duration is `h: 20` and Queue time is `h: 12` with split off. Split falls back to a single plot below 60px.

## 13. Left to the builder

File and component names, how the card's state is structured, the exact pixel margins, slider styling, and how the
legend row's markup reuses existing components.
