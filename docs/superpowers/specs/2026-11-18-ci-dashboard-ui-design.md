# CI dashboard UI: the sketched dashboard, built

Status: design, approved 2026-11-18 (§11). The maintainer accepted sketch v5 ("good
enough") and chose the unattended PR process with as few PRs as reasonable. Bugs found on the way are fixed in the PR
that finds them, not filed. The work continues through `/ui-1` (§12). The plan is
`docs/superpowers/plans/2026-11-18-ci-dashboard-ui.md`.

## 1. Why

The CI dashboard today (`.github/otel-html-ci.yaml`) holds a timeline, two metric charts, two step toplists, a Runs
trace list and a logs widget. It answers "what ran", but not the questions people bring to a CI dashboard:
- Is CI healthy?
- Is it getting slower, and which job made it slower?
- Which failures belong together?
- What does each trigger cost, and what does it start?

From 2026-11-07 to 2026-11-18 the maintainer and Claude sketched an answer on this repository's real CI history. The
sketch is artifact `https://claude.ai/artifact/UFvzBwkCgUNqQpHxbmYdni` (v5, version 6). It is private to the
maintainer and readable with the Artifact tool's `read` action. Its page is the visual reference for this document,
and v5 is the version accepted. Where this document and the sketch differ, this document wins.

Along the way the maintainer decided these rules:
- **Filters.** Page filters live in one bar, pinned by default and visually separate from the widgets. A click never
  applies a filter; filters come from a menu (⋯ or right-click).
- **The open run.** A run that opens must look attached to what was clicked.
- **Range and zoom.** The range dropdown sets the extent of a zoom slider. The slider starts at full width, and every
  chart follows it live.
- **Removed.** The Steps chart is gone, and the trigger matrices became one plain table.
- **Taste.** Minimalist, short titles, nothing that spends space without earning it. The levels (run, job, step)
  look different and link to each other.

## 2. Goals, non-goals, anti-goals

**Goals**
1. **The dashboard.** The CI dashboard renders the sketch's widgets and layout (§6) in the viewer's dashboard grid, from
   the data a CI report carries after §4. It works on a phone (§5.5).
2. **Generic page pieces.** The page pieces are generic dashboard features that every dashboard gets: the filter bar,
   the range dropdown and slider, filter chips, context menus, the filter echo and the paired stacking.
3. **Configurable.** The CI widgets are one new widget type, `cicd` (§6). Any dashboard config can use it, and the
   publish action's dashboard ships it to other repositories.
4. **Fast enough.** On the live-data rebuild (the measurement in the widget-trace-index design, §1), the CI dashboard
   settles in ≤ 3.0 s with ≤ 100 requests. A slider drag redraws at ≥ 30 frames per second on that data.

**Non-goals**
- Steps across runs (the removed Steps chart).
- A workflows × events matrix.
- Data for `release` runs, which are not recorded.
- Flaky-test detection (a later project; the retry attribute exists for Playwright only).
- Editing the layout on a phone.

**Anti-goals**
- **A wrong number.** Every figure is exact for the data in range. Where a partition lacks the new table, that
  partition is read the slow way, never estimated.
- **A dashboard that reads `spans.parquet` on every partition to draw.** This is what made the old Runs widget cost
  358 requests.
- **CI-specific code in the generic page pieces.** Only the `cicd` widget type and the writer's `cicd` table know
  about the CI semantic conventions.

## 3. Current state (facts the design rests on)

- **Data.** The publisher (`src/cli/ci/`, scope `otel-html-ci`) writes:
  - a root span per run, carrying `cicd.pipeline.result`, `github.event` and `github.run_attempt`;
  - a span per job, carrying `cicd.pipeline.task.name`, `cicd.pipeline.task.run.result` and `cicd.worker.name` (the
    runner instance), with a `queued` child span;
  - a span per step, carrying name and number only;
  - CI metrics;
  - one log record per job log line.

  Two resources hold the context. The run resource carries pipeline name, run id, `vcs.ref.head.name` and
  `vcs.ref.head.revision`. The job resource is the run resource plus `cicd.pipeline.task.name`. Job artifacts merge in:
  - mise task spans with `mise.task.skipped`, whose span name, scope and resource are unconfirmed;
  - Playwright test spans (`test.suite.name`, `test.case.name`, `test.case.result.status`, `otel_html.test.retry`);
  - vitest spans (`vitest.test.name`, `vitest.test.mode`), which have no result attribute.

  The job's steps run with `OTEL_RESOURCE_ATTRIBUTES` holding the job resource (`contextEnv`,
  `src/cli/ci/context.ts`), so artifact spans from SDKs that read it carry the job's resource. Not collected:
  - the commit title;
  - runner labels;
  - matrix values;
  - `needs:` and `if:`;
  - a step result attribute;
  - the event and runner as resource attributes.
- **Queries.** The viewer has no per-widget SQL. `DataSource` (`src/viewer/data/data-source.ts`) has a fixed set of
  methods, and every request is an entry in the catalogue (`src/viewer/data/catalogue.ts`) that the scaling tests
  hold to a cost class. Today nothing aggregates spans per run, divides one count by another, or groups by two keys.
- **Variables.** Variables filter on resource attributes only (`variableCondition`, `src/viewer/dashboards/scope.ts`).
  The page keeps `t` (the window) and `d` (`DashboardPageState`: `vars`, `sel.t`, `sel.trace`, `follow`,
  `logView`).
- **Time range.** The range presets stop at 7 days and have no custom range (`src/viewer/shell/time-range.tsx`). The
  timeline widget's brush sets `sel.t`.
- **No precedents.** The viewer has no context menu, no inline expansion of a run, and no green token
  (`src/viewer/theme/tokens.css`).
- **Grid.** `src/viewer/dashboards/grid.tsx` uses 12 columns, 20 px rows and 10 px gaps. Below 768 px it stacks into
  one column.
- **Trace panel tabs.** `src/viewer/traces/tabs.ts` has `available()` predicates.
- **Format.** Partition format 7 (`src/format/version.ts`). The viewer, `merge` and `upgrade` read formats 5 to 7.
  Merging an input whose partitions lack a derived table recomputes it at copy, which is the widget-trace-index
  precedent.
- **Config files.** `.github/otel-html-ci.yaml` is this repository's CI dashboard. The publish action's copy
  (`.github/actions/otel-html-publish/otel-html-ci.yaml`) differs only by two `where:` lines. The action's `@v0` tag
  moves only on a release, together with the binaries, so the action's copy can use the new type in the same PR as
  the viewer.
- **Fixtures.** `fixtures/ci.otlp.json` (generated by `scripts/ci-fixture.ts`) holds 12 runs of `otel-html-ci` spans
  only, and no e2e report is built from it.

## 4. Data

### 4.1 What the publisher adds

The new attributes, all written in `src/cli/ci/`:

| what | where | key |
| --- | --- | --- |
| commit title (`display_title`) | run resource | `vcs.ref.head.title` |
| trigger event | run resource (also kept on the root span) | `cicd.pipeline.trigger` |
| runner labels, joined with `,` in workflow order | job resource | `cicd.worker.labels` |
| step result (`conclusion`) | step span | `cicd.pipeline.task.step.result` |
| `needs:` job ids | job span | `cicd.pipeline.task.needs` (string array) |
| `if:` condition text | job span | `cicd.pipeline.task.condition` |
| workflow job id the job came from | job span | `cicd.pipeline.task.id` |

Key names are this document's choice where semantic conventions have none.

The event and runner labels sit on resources so that they can be variables: the existing filter machinery then
narrows every widget type by them, not just `cicd`. The new resource keys (`vcs.ref.head.title`,
`cicd.pipeline.trigger`, `cicd.worker.labels`) also go into `contextEnv` (`src/cli/ci/context.ts`), so the job's own
spans (mise, tests, `otel-html run`) carry them too.

`needs:` and `if:` come from the workflow file at the run's `head_sha` (`path` on the run, read through the
contents API). The file is parsed with the `yaml` package, which is already a dependency. A workflow job maps to its
API jobs by the job's `name:`, with any `${{ matrix… }}` expression treated as a wildcard. A job without a `name:`
maps by its id, or by `<id> (` as the prefix of a matrix leg. An unmatched job gets no `needs` and no `condition`,
and that is not an error. A failure to fetch the file is a warning, and the report is written without these two keys.

### 4.2 Format 8: the `cicd` table

A partition with CI spans gets one more file, `cicd.parquet`, written by the writer at flush, compaction and merge
copy, as `widget_traces` is.

**Rows and columns.**
- One row per run root span and one per job span (`kind` is `run` or `job`). Steps are not in the table.
- Shared columns: `trace_id`, `span_id`, `start_ns`, `end_ns`, `name` and `result`.
- From the run resource: `pipeline`, `run_id`, `trigger`, `branch`, `revision` and `title`. From the root span:
  `attempt` (`github.run_attempt`).
- **Older runs.** For runs recorded before §4.1, `trigger` falls back to the root span's `github.event`, which is
  already collected. `title`, `labels`, `needs`, `condition` and `failed_step` stay null, and the views show them as
  "not recorded" (a `queue` row labelled "(no label)", no edges, no title). No backfill.
- On job rows only: `task` (job name), `labels`, `queued_ns` (from the `queued` child), `needs` (JSON text),
  `condition` and `failed_step`, which is the name of the first step whose result is `failure`.
- A third kind, `tasks`: one row per trace in the partition that holds spans carrying `mise.task.skipped`, with
  `tasks_replayed` and `tasks_run` (the counts of `true` and `false`).
- **Rows combine across partitions.** A run's spans can arrive in more than one partition (the job artifacts are
  separate reports). So the viewer joins run, job and `tasks` rows by `trace_id` over every partition read, and adds
  up the task counts. A job row and its `queued` and step spans come from the same publisher request, so `queued_ns`
  and `failed_step` are computed where the job span is.
- **Provisional spans.** Spans with `otel_html.ci.provisional = true` are skipped, and a trace with two run roots
  keeps the latest-ending one.

**Which spans count.**
- A run is a root span whose resource has `cicd.pipeline.run.id`.
- A job is a span with `cicd.pipeline.task.run.id` and the attribute `cicd.pipeline.task.name`.
- The scope name is not consulted.

**Manifest.** The manifest entry for the file is `cicd: true` on the partition, and the format becomes 8. The viewer,
`merge` and `upgrade` read 5 to 8. `merge` computes the table for a copied partition that lacks it.

**Size.** The table is small: about one row per job (≈ 17 per run here). It carries no size guard. Its bytes are
recorded in the PR that adds it.

### 4.3 The query

**One method.** One new `DataSource` method, `cicdRows(q: { window: TimeWindow; vars: VariableBindings })`, returns
the run, job and `tasks` rows of runs that start inside the window. Its catalogue entry is `cicd.rows`, and the
plan states its class on each axis (retention, density, window) from the `widget_traces` precedent: small files read
whole.
- Partitions overlapping the window are read whole, in parallel, using the small-file path.
- A partition without the table (format ≤ 7, or format 8 with spans but no `cicd` flag) is answered by a span
  scan for the same rows. It is correct but slow, and its catalogue entry is `cicd.rows.scan`.

**Shared fetch.** Every `cicd` widget on a page shares one fetch, a hook keyed by window and variables. The window is
the page window extended backwards by its own length, so the stat tiles can compare against the previous period.
The zoom slider narrows that result in memory; it never queries. The branch and trigger variables narrow the fetch. The job and runner variables do not: they
narrow job rows in memory for the views that honour them, so run-level views keep every job (§5.3). The previous
period and the current span are split before attempts are combined, so each keeps its own latest attempt.

**Other variables.** A `cicd` view honours only `branch`, `trigger`, `job` and `runner`. These are the variables
whose keys are `vcs.ref.head.name`, `cicd.pipeline.trigger`, `cicd.pipeline.task.name` and `cicd.worker.labels`, plus
the view's `pipeline` option. Any other variable is ignored and echoed as "ignores X". The table carries no other
resource attribute.

**Runs and attempts.** A run is a run id. Its latest attempt in range stands for it in every count, bar, list and
grid. The `reruns` tile shows the runs whose latest attempt is above 1, then the cancelled runs.

**Test suites.** These read the latest run's trace with `getTrace`, the existing `trace.get` entry, when the widget
is shown. That is one trace per suite pill.

## 5. The page (generic)

### 5.1 The filter bar

The variables bar becomes the page filter bar, pinned to the top by default, with a pin toggle. It is a surface card
labelled "Page filters", with a shadow once it is stuck. Its contents, in order:

1. **Quick filters.** These are new, optional dashboard config: `quick: [{ label, set: { <key>: <value|null> } }]`.
   They render as one pill group, and the pill whose bindings match the current variables is pressed. The CI
   dashboard uses `main` (`vcs.ref.head.name=main`), `pull requests` (`cicd.pipeline.trigger=pull_request`) and
   `all`, which clears both.
2. **The range dropdown** (§5.2).
3. **The variables.**
   - A variable with a value shows as a chip, `label = value ×`.
   - An unset variable shows as a compact `+ label` button that opens today's value list.
   - A variable can also be set from a context menu (§5.4). Clicking a mark never sets one.
4. **The run count, or the widget's summary line, and the pin.**
5. **The slider** (§5.2), on its own row.

On a phone, the slider hides while the bar is stuck.

### 5.2 Range dropdown and slider

**Presets.** The dropdown offers last 1 hour, 24 hours, 7 days, 30 days, 90 days, 1 year, and custom (two
datetime inputs). This replaces the shell's preset list on every page: 15m and 6h go, and Entire run stays where it
is offered today. A preset sets `t`, the extent.

**The slider.** It is on dashboard pages only; the explorers keep today's range control with the new presets.
- It draws the extent with one tick per run, coloured by result, from the `cicd` rows when the page has a `cicd`
  widget. A dashboard without one draws no ticks and adds no query.
- Its selection is `d.sel.t`. It starts at full width, which means `sel.t` is null.
- Dragging a handle or the band, or drawing a new range, sets `sel.t` live, throttled to one frame. A double-click,
  "↺ full range" or a preset clears it.

**The dropdown label.**
- With no zoom it reads the preset ("last 7 days", or "custom").
- Zoomed with the end at the extent's end, it reads "last N <unit>".
- Zoomed with the end moved, it reads "custom".
- While zoomed it adds a muted " of 7 days", an accent ring and the "↺ full range" button.

**The slider's header line.** It shows the extent on the left. On the right it shows either "all N selected · drag to
zoom", or, when zoomed, "from – to · duration · N runs". The left side hides under 640 px when zoomed.

**Which widgets follow.** Widgets follow `sel.t` by default from this change on. The per-widget follow toggle and its
URL key stay.

### 5.3 The filter echo

Each widget header shows, after its subtitle:
- a filled chip for each active variable it honours (`job = check`);
- a dashed chip for each it ignores ("ignores job");
- a dashed scope chip, instead of the above, when the widget's scope is fixed ("one run per suite", "the clicked run").

What a widget honours:
- A generic widget honours every variable, as today.
- A `cicd` view declares what it honours (§6). Run-level views (stats, runs over time, runs, triggers) ignore `job`
  and `runner`.

On a phone the echo hides; the bar's chips remain.

### 5.4 Context menus

A small menu component: right-click, a long press on touch, or a ⋯ button. Escape and an outside click close it;
arrow keys move between items; the first item takes focus.

| target | items |
| --- | --- |
| a job | "Filter the page by job", or "Clear the job filter"; "Open its trend" (jobs table) |
| a run | "Open the run here"; "Open on GitHub ↗"; "Filter by trigger"; "Show main only" or "Show pull requests only" (whichever quick filter applies); up to two "Filter by job" items for its failed jobs |
| a runner | "Filter the page by runner" |
| a trigger | "Filter the page by trigger" |
| a time bucket | "Zoom the slider to this bucket" |

The menu sets variables only. Generic widgets get no menu in this project.

### 5.5 Grid and phone

Below 768 px the grid keeps stacking, but widgets with `w ≤ 3` pair two to a row, in reading order. A lone small
widget takes a full row. Heights stay `h` rows. Edit mode stays off below 768 px.

The `cicd` widgets size their charts to the widget body: width and height come from the frame, and a resize redraws.

### 5.6 Tokens

New colour tokens:
- `--color-good`: `#0ca30c` light, the same in dark;
- `--color-good-ink`: `#006300` light, `#3ddc3d` dark;
- `--color-ok-cell`: `#d6e9fb` light, `#23385a` dark.

`STATUS` in `palette.ts` (today `critical` and `warning`) gains `good`. Charts use `good`, `critical` and the
`--color-series-other` grey for passed, failed and cancelled.

## 6. The `cicd` widget type

**Config.**
`type: cicd`, `view: <view>`, plus the view's options. It takes no `query`; it reads `cicdRows`. It honours the
variables listed per view, `sel.t` (follow) and the page window. It contributes no rollup key and no trace index. The
schema, the generated JSON schema and the README document it.

**Interaction.** A click on a run mark opens the run (§7), and a right-click opens the run menu (§5.4). Every view
rings the open run's mark faintly; the view it was opened from rings it fully. Tooltips follow the sketch.

**Durations.** A run's duration is the latest job end minus the run's start. Cancelled runs are left out of
percentiles. CI minutes are the sum of job durations.

**Views**, with the CI dashboard's grid position as `x,y,w,h`:

| view | position | shows | honours |
| --- | --- | --- | --- |
| `stat` (one of `success-rate`, `median-run`, `cache`, `minutes`, `queue-p95`, `reruns`) | six tiles at y 0, w 2, h 6 | a value; a delta against the same length of time before the range, coloured so that better is green; a sparkline for median-run, minutes and queue-p95. `cache` is median duration with no replayed task divided by median with any; the tile reads "–" when either side is empty | trigger, branch |
| `runs-trend` | 0,6,7,11 | p50 and p95 run duration lines over stacked passed/failed/cancelled counts per bucket. The bucket is the smallest of 5 min, 15 min, 30 min, 1 h, 3 h, 6 h, 12 h, 1 d, 2 d, 1 w, 2 w and 30 d that gives at most min(48, max(6, runs/3)) buckets in the selected span. The subtitle names the bucket; a crosshair tooltip; the bucket menu | trigger, branch |
| `runs` | 7,6,5,11 | one bar per run, height = duration, colour = result, hollow when no task was replayed | trigger, branch |
| `jobs` | 0,17,12,14 | one row per job (ordered by median start offset): sparkline with the p25–p75 band, failure diamonds and hollow points; latest; median; a diverging Δ bar (median of the last 10 successful runs against the 20 before, "baseline too small" under 3 each); failed `k / n`; ⋯ menu. A row click expands the full trend chart (click a point to open the run) | all |
| `status-grid` | 0,31,12,12 | jobs × the last 60 runs in range, cells passed/failed/cancelled/did not run, failed `k / n` per row, run result dots on top, labels truncated to fit with the full name on hover | all |
| `failures` | 0,43,7,10 | failed runs, latest first: when; commit title with trigger and branch under it; failed job chips (menu); ↗ to GitHub. The failing step goes in the hover text | all but runner |
| `triggers` | 7,43,5,10 | per trigger: runs (bar and count), passed %, "all N" or "k of N always", and chips for jobs it does not always start, with jobs of equal share folded into one chip ("7 jobs 95%"). The tooltip gives the count and the `condition` | trigger, branch |
| `queue` | 0,53,5,9 | per runner label: a p50–p95 range bar, a tick at the longest wait, and n. Labels with fewer than 5 jobs are left out | all |
| `minutes` | 5,53,7,9 | CI minutes per day as stacked bars, by trigger (default) or by job (the top 7 plus Other), with a pill toggle in the header | all |
| `tests` | 0,62,12,16 | pills per suite of the latest run that has test spans: a suite is (job, task), named `job › task`. Files are sorted by test time (top 10), each with a bar, test count and skipped count; a row expands to its tests. A "N skipped tests in M files" disclosure lists the skipped tests | scope chip "latest run" |

The positions are the CI dashboard's (§8), not defaults of the type.

## 7. The open run

A run opens from any `cicd` view: a click, Enter on a focused mark, or "Open the run here". It sets `d.sel.trace` to
the run's trace and records the view it came from in a new key, `d.run = { from: <widget id>, mode: 'attached' |
'panel' }`. The pane has two modes:

**Attached (the default).**
- The pane is a full-width grid item placed under the row of the widget it was opened from. A row is the widgets
  whose vertical span overlaps the source widget's. The rows below move down by the pane's height in grid rows.
- The pane has a caret on its top edge at the clicked mark's x, and the source view draws a dotted connector from
  the mark down. When a filter change takes the run out of the source view, the caret hides and the pane says so.
- When stacked, the pane goes right after its source widget.
- The pane's header has the run title, an "opens: attached / side panel" pill and ✕.

**Side panel.** The existing trace panel with a new "Jobs" tab, whose `available()` is true when the trace has a run
root span. It holds the same content as the attached pane. The other tabs (flame graph, waterfall, spans, logs) stay
as they are.

**Content, shared by both modes.**
- A summary line: branch @ sha · trigger · time · result · duration · jobs · CI minutes · cache.
- A Gantt of the jobs, with:
  - the queue drawn hatched before each bar;
  - result colours;
  - the job that finished last outlined, and a dashed line at its end;
  - `needs` edges drawn from the needed job's end to the dependent job's start.
- Job rows expand to their steps (from the trace, loaded with `getTrace` on first expand). A step with mise task
  spans under it expands to the tasks, with replayed ones hatched.

## 8. The CI dashboard configs

Both CI configs are replaced in the same PR as the widgets:
- `.github/otel-html-ci.yaml` (this repository);
- `.github/actions/otel-html-publish/otel-html-ci.yaml` (the action's copy).

**Contents.**
- The §6 widgets at the §6 positions.
- Variables `vcs.ref.head.name` (branch), `cicd.pipeline.trigger` (trigger), `cicd.pipeline.task.name` (job) and
  `cicd.worker.labels` (runner).
- The quick filters of §5.1.
- `defaultWindow: 7d`.

**What goes.**
- The workflow and run variables.
- The timeline, metric, toplist, traces and logs widgets of today's config. The trace list and the logs remain
  reachable from the explorers.

**What stays.** This repository's copy keeps its `cicd.pipeline.name == "ci"` scoping, now as the pipeline filter of
the `cicd` views (`pipeline: ci`, an option of the type). The action's copy has no pipeline filter.

## 9. Order of work

Three PRs, in order. Each is reviewed on its branch and merged when CI is green. Bugs found while building any of
them are fixed in that PR and listed under **Also**.

| PR | contents | held to |
| --- | --- | --- |
| 1. `feat(format)!: format 8 records CI runs in a cicd table` | §4.1 publisher attributes; the `cicd` table, writer, merge copy, manifest flag, readers 5–8; `cicdRows` and its two catalogue entries; the CI fixture regenerated with the new attributes, mise and test spans; an e2e fixture report built from it | catalogue classes; table bytes ≤ 1 % of spans bytes on the live-data rebuild; every format test |
| 2. `feat(viewer): page filter bar, range slider, context menus and paired stacking` | §5 entirely, on today's widgets. Variables are generic; the slider has no ticks until PR 3 | e2e on the dashboards spec: preset, zoom, label states, pin, quick filters, chip set and clear from a menu, phone stacking; the CI dashboard's request count does not grow |
| 3. `feat(viewer): cicd widgets, the open run and the new CI dashboard` | §6, §7, §8, README; measure §2 goal 4 | the §2 targets; e2e on a CI fixture report: every view renders, open attached and as a panel, the filter echo, phone layout |

## 10. Risks

- **mise spans.** Their scope and attributes are unconfirmed. PR 1 starts by reading a real `otel-html-check`
  artifact (`gh run download`). If `mise.task.skipped` is not there, the `cache` tile and the hollow marks are
  dropped: that is a stop.
- **Job-name mapping.** The mapping from workflow jobs to API jobs can miss a job whose `name:` uses expressions
  other than the matrix. Such a job simply has no edges.
- **Live partitions.** Live partitions written before the release have no table until a deploy merges them through
  the new `merge`. Until then they are read the slow way, which is correct, and §2 goal 4 is measured after that
  deploy.

## 11. Decisions

Decided by the maintainer, 2026-11-18:
1. **Format 8.** The `cicd` table is written (§4.2).
2. **Range presets.** The new presets apply on every page (§5.2).
3. **Follow.** Widgets follow the selection by default (§5.2).
4. **The old widgets.** The CI dashboard drops its Runs trace list and its Warnings-and-errors logs widget (§8).
5. **Write-token files.** These may change unattended, exactly as the plan lists them per PR:
   - `src/cli/ci/` (the publisher);
   - `src/format/` and `src/writer/` (format 8);
   - the two CI dashboard configs, including `.github/actions/otel-html-publish/otel-html-ci.yaml`.

   No workflow file and no other action file changes; a file outside the plan's lists is a stop.
   2026-11-18: the job update path (`src/cli/ci/update.ts`, `push-update.ts`, `deploy-apply.ts`) carries the `cicd` file and flag, approved for PR 1.

Taken by this document, listed so that they can be checked:
- **The `cache` tile.** It is derived from replayed mise tasks, not from the workflow's `MISE_TASK_CACHE`. Nothing
  in the workflow changes.
- **Key names.** §4.1's keys are this document's names where the semantic conventions have none.
- **One widget type.** The CI widgets are one type with views, not ten types.
- **Variables.** Trigger and runner become resource attributes, so they are ordinary variables and every widget can
  honour them.
- **The run pane.** It keeps both modes, attached by default, as the sketch did.
- **Older runs.** Runs from before §4.1 are shown with what they have. The trigger falls back to `github.event`, and
  nothing is backfilled.
- **Rows across partitions.** These are joined in the viewer, and provisional spans are skipped (§4.2).
- **Runs and attempts.** A run is a run id, counted by its latest attempt.
- **Variables in `cicd` views.** These views honour only the four CI variables. Job and runner narrow job rows in memory, per view.
- **The slider.** It appears on dashboards only.

## 12. Sessions for `/ui-1`

The maintainer clears the session between steps. `/ui-1` (`.claude/skills/ui-1/SKILL.md`) reads this section and
picks the next session. Without the skill:

```
Continue the CI dashboard UI work. Read §12 of docs/superpowers/specs/2026-11-18-ci-dashboard-ui-design.md on main, decide which session is next from the rules there, say which and why, then run that session's prompt exactly as written.
```

**Which session is next.** Start with `git fetch origin`, then look at `origin/main`.

0. First, look for an open PR of this project: `gh pr list --base main --state open`, for a branch the plan's PR
   table names or a `docs(spec|plan): ci-dashboard-ui…` title. An open PR is unfinished work: check out its branch
   and finish it (its body, checks and review state) before anything else.
1. The status line says "awaiting the maintainer's answers" → **session 0**. (Not the case since 2026-11-18.)
2. A plan exists (`docs/superpowers/plans/*-ci-dashboard-ui*.md`) and a PR of its table is neither merged nor marked
   dropped (`gh pr list --base main --state all --head <branch>`) → **session B**. Resume at the first such PR, on
   its branch if it exists, at the first task whose commit is not on it.
3. Every PR is merged or dropped, but the plan has no "Record" section → **session R**: when a deploy has run PR 3's
   build on the live site (`gh run list --workflow ci.yml --branch main` after PR 3's merge commit), measure and
   record; otherwise say it is still waiting for that deploy, and stop.
4. Every PR is merged or dropped and the plan has its Record → the work is complete. Say so, name what §2 left out
   (flaky tests, steps across runs), and stop.

**Session 0, answers:**

```
The CI dashboard UI design (docs/superpowers/specs/2026-11-18-ci-dashboard-ui-design.md) waits for the maintainer's answers to §11. Read it whole, put the open decisions of §11 to the maintainer in one message, most important first, each with the recommendation in one line. Build nothing. When answered, update §11, any section the answers change, the plan if one exists, and the status line to "approved <date>", open a PR titled "docs(spec): ci-dashboard-ui decisions" under the unattended process (docs/agents/process-unattended.md), merge it when CI is green, and go on to session B unless told to stop.
```

**Session B, execute the plan:**

```
Execute the CI dashboard UI plan (docs/superpowers/plans/*-ci-dashboard-ui*.md) with superpowers:subagent-driven-development, resuming at the first PR of its table that is neither merged nor marked dropped, on its branch if it exists, at the first task whose commit is not on it. The PR process is unattended (docs/agents/process-unattended.md): review on the branch, squash-merge when CI is green, branch the next PR from the updated main. Per CLAUDE.md, implementers and task reviewers run on Sonnet 5.5 and the whole-branch review on Opus 5.5; say which model each review ran on. A bug found while building is fixed in the same PR and listed under Also in its body; do not open an issue for it. Stop and ask where the process says so; its stop for files that run with a write token on main is lifted only for the files the plan lists (§11 point 5 of the design records the maintainer's approval). Every PR body carries the measurements its row in the plan asks for. After the last PR, measure the live dashboard as §2 goal 4 says and write the record in the plan.
```

**Session R, the record:**

```
Run Task 25 Step 6 of the CI dashboard UI plan (docs/superpowers/plans/*-ci-dashboard-ui*.md): measure #/dashboards/ci on the live site as §2 goal 4 of the design says, write the Record section at the end of the plan, mark every PR row merged, and merge it as "docs(plan): ci-dashboard-ui record" under the unattended process. A miss against §2 goal 4 is reported to the maintainer, not fixed in this session.
```

A session that changes what the next session has to do updates this section in the same commit.
