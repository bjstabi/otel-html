# CI Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CI dashboard of sketch v5, built in the viewer: the publisher records what the widgets need, format 8
holds it in a small `cicd` table per partition, every dashboard gets the page filter bar, range slider, context menus
and paired phone stacking, and a `cicd` widget type draws the ten views and the open run.

**Architecture:** PR 1 is data. The publisher adds attributes. The writer derives a `cicd` table (run, job and
`tasks` rows) at flush, compaction and merge copy. The viewer gets `cicdRows`, which reads those small files whole, or
scans a partition that lacks one.

PR 2 is the generic page:
- range presets and a zoom slider bound to `d.sel.t`;
- the filter bar with chips and quick filters;
- the context menu component;
- the filter echo, paired stacking and the good tokens.

PR 3 is the `cicd` widget type. Its views are pure derivations over one shared fetch, drawn with ECharts for axis
charts and SVG/DOM for the rest. It also brings the open run (an attached grid pane or a Jobs tab in the trace
panel) and the new CI configs.

**Tech Stack:** TypeScript (strict), React, ECharts 6.1.0, parquet-wasm 0.9.0, DuckDB-WASM 1.32.0, `yaml` 2.9.1, zod, vitest, Playwright, mise.

**Spec:** `docs/superpowers/specs/2026-11-18-ci-dashboard-ui-design.md` (approved 2026-11-18). The visual reference
is the sketch artifact `https://claude.ai/artifact/UFvzBwkCgUNqQpHxbmYdni`, v5. Read it with the Artifact tool's
`read` action when one is available. The spec wins where they differ.

**PR process:** unattended (`docs/agents/process-unattended.md`).
- **Order.** One PR per row, in order, each branched from `main` after the previous merged.
- **Models.** Implementers and task reviewers run on Sonnet 5.5. The branch review runs on Opus 5.5.
- **Bugs.** A bug found on the way is fixed in the PR being built and listed under **Also**. No issue is opened
  (the maintainer's rule for this project).
- **Write-token files (spec §11 point 5).** The maintainer approved the files this plan lists under `src/cli/ci/`,
  `src/format/` and `src/writer/`, and the two CI configs. Any other workflow or action file, or a deployer-run file
  not listed, is a stop.

| #   | branch                      | PR title                                                                              | status |
| --- | --------------------------- | ------------------------------------------------------------------------------------- | ------ |
| 1   | `feat/cicd-table`           | `feat(format)!: format 8 records CI runs in a cicd table`                             |        |
| 2   | `feat/dashboard-filter-bar` | `feat(viewer): page filter bar, range slider, context menus and paired stacking`      |        |
| 3   | `feat/cicd-widgets`         | `feat(viewer): cicd widgets, the open run and the new CI dashboard`                   |        |

## Global Constraints

- **Exact numbers (spec §2 anti-goal).** No figure is estimated. A partition without a `cicd` table is read by span
  scan for the same rows.
- **Format.** The writer writes format 8. The viewer, `host`, `merge` and `upgrade` read 5, 6, 7 and 8. `upgrade` of
  5 to 7 rewrites the manifest version only. `merge` computes `cicd` for a copied partition that lacks it.
- **No coupling (spec §2 anti-goal).** Only `src/writer/cicd-rows.ts`, `src/viewer/data/cicd-*.ts`,
  `src/viewer/cicd/**` and `src/cli/ci/**` know CI semantic conventions. The generic page pieces never test for
  `type === 'cicd'` except through the `WIDGET_SCOPE`-style tables every type fills.
- **Attribute keys (spec §4.1).**
  - Run resource: `vcs.ref.head.title`, `cicd.pipeline.trigger`.
  - Job resource: `cicd.worker.labels`.
  - Step span: `cicd.pipeline.task.step.result`.
  - Job span: `cicd.pipeline.task.needs` (string array), `cicd.pipeline.task.condition`, `cicd.pipeline.task.id`.
- **The `cicd` table.**
  - `kind` (`run` | `job` | `tasks`).
  - `trace_id`, `span_id`, `start_ns`, `end_ns`, `name` and `result`.
  - `pipeline`, `run_id`, `attempt`, `trigger`, `branch`, `revision` and `title`.
  - `task`, `task_id`, `labels`, `queued_ns`, `needs` (JSON text), `condition` and `failed_step`.
  - `tasks_replayed` and `tasks_run`.

  Every column is nullable except `kind`, `trace_id`, `start_ns` and `end_ns`. The table is sorted by `trace_id`,
  `kind` and `start_ns`.
- **Durations (spec §6).** A run's duration is the latest job end minus the run start. Cancelled runs are left out
  of percentiles. CI minutes are the sum of job durations. A run is a run id, counted by its latest attempt.
- **Variables in `cicd` views.** Only `vcs.ref.head.name`, `cicd.pipeline.trigger`, `cicd.pipeline.task.name` and
  `cicd.worker.labels`, plus the `pipeline` option. Run-level views (stat, runs-trend, runs, triggers) ignore `job` and
  `runner`.
- **Presets (spec §5.2), on every page.** Entire run (where offered today), 1h, 24h, 7d, 30d, 90d, 1y, custom.
- **Tokens.**
  - `--color-good`: `#0ca30c` / `#0ca30c`.
  - `--color-good-ink`: `#006300` / `#3ddc3d`.
  - `--color-ok-cell`: `#d6e9fb` / `#23385a`.
- **Grid.** 12 columns, 20 px rows, 10 px gaps. Below 768 px, widgets with `w ≤ 3` pair up in reading order.
- **Targets (spec §2 goal 4), on the live-data rebuild at 14 ms per request.**
  - CI dashboard: settled ≤ 3.0 s, ≤ 100 requests.
  - Slider drag: ≥ 30 frames per second.
  - `cicd` bytes ≤ 1 % of spans bytes.

  A miss is a stop.
- **Dependencies.** No new dependency. Run `mise run check` after every task, and `mise run verify` before each PR.
  Commits and PR bodies follow `docs/agents/conventions.md`. `mise run gen` after any schema change.

## Review Focus

1. **Mixed and upgraded formats.** A window spanning format-7 partitions, upgraded ones (format 8, no flag) and
   derived ones returns the same combined runs as an all-derived rewrite of the same data. Test: Task 8.
2. **Re-run attempts.** Two attempts of one run id, the first failed and the second passed, count as one passed run
   with `reruns` 1. The status grid and failures show only attempt 2. Test: Task 18.
3. **A run split across partitions.** The root and job spans are in one partition and the mise spans in another.
   `tasks_replayed` is summed across both, and the run reads as cache-on. Test: Tasks 5 and 8.
4. **Nothing in range.** No runs, or a filter that excludes every job: every view shows its empty line, with no NaN,
   no `–%` and no thrown error. Tests: Tasks 18 and 20.
5. **A phone.** At 390 px, nothing scrolls sideways, small widgets pair up, the open pane comes right after its
   source widget, and the echo hides. Test: Task 25.

## Plan notes against the spec

1. **The `cicd` manifest flag (spec §4.2, "`cicd: true` on the partition").**
   - **What is written.** A writer that ran the derivation on a partition's spans records `cicd: true` on the
     partition entry, and writes `files.cicd` only when there are rows.
   - **Why the format version is not enough.** `upgrade` rewrites a 5–7 manifest as 8 without touching partitions,
     and sets no flag. So "format 8" cannot mean "derived".
   - **What the viewer reads.** A partition with `cicd: true` is read from `files.cicd`; none at all when it has no
     file. Any partition with spans and without the flag takes the scan path, whatever the manifest version.
2. **The live-data rebuild.** It is made as in `docs/superpowers/plans/2026-11-16-widget-trace-index.md` Task 12
   (download the live site's rolling report, `merge` it with the branch build, serve it at 14 ms per request). That
   plan's measuring script is reused.
3. **Follow by default (spec §11 point 3).** The schema already defaults `follow` to `true`
   (`src/dashboards/schema.ts:263`). Task 11 checks every followable type uses it, and that no viewer default
   overrides it.
4. **Charts.** Axis charts (runs-trend, runs, minutes, the expanded job trend, queue) use `components/chart.tsx` with
   the ECharts theme. Sparklines reuse `src/viewer/traces/sparkline.tsx`. The status grid, tables, slider and Gantt are
   SVG or DOM, as in the sketch.

---

## PR 1: data, format 8 and `cicdRows`

### Task 1: confirm the mise and test spans in a real artifact (no code)

- [ ] **Step 1: download an artifact.** Run `gh run list --workflow ci.yml --branch main --status success -L 5`. Take
  the latest push run, then `gh run download <id> -n otel-html-check -D <scratch>/check`. Do the same for an
  `otel-html-e2e-chromium` artifact.
- [ ] **Step 2: list the spans.** Use `node dist/cli/main.js query` or DuckDB over the partitions. List the span
  names, scope names and resource attributes of the spans that carry `mise.task.skipped`. Do the same for the test
  spans (vitest and Playwright). Note whether their resource carries `cicd.pipeline.task.name`.
- [ ] **Step 3: record.** Write the findings under a new "Amendments" heading at the end of this plan.
  - **Stop and ask** if no span carries `mise.task.skipped` (spec §10). The `cache` tile and the hollow marks
    depend on it.
  - Commit `docs(plan): ci-dashboard-ui artifact findings`.

### Task 2: run title, trigger and runner labels on the resources

**Files:**
- Modify:
  - `src/cli/ci/github-api.ts`: `ApiRun.display_title: string`; `ApiJob.labels: string[]`.
  - `src/cli/ci/workflow-trace.ts`: `ciResource` adds `vcs.ref.head.title` and `cicd.pipeline.trigger`.
    `jobResource` adds `cicd.worker.labels` (`labels.join(',')`, left out when empty). The root span keeps
    `github.event`.
  - `src/cli/ci/context.ts`: `ContextInputs` gains `event: string`, `title: string | null` and
    `labels: readonly string[]`. `contextEnv` appends the three keys, leaving out empty values.
  - `src/cli/ci/context-main.ts`: reads `GITHUB_EVENT_NAME`, plus the run's `display_title` and the job's `labels`
    from the lookups it already makes.
  - `scripts/ci-fixture.ts`: the fixture's API shapes gain the fields.
- Test: `test/cli/ci/workflow-trace.test.ts`, `test/cli/ci/context.test.ts`

**Interfaces:**
- Produces: the run and job resources and `OTEL_RESOURCE_ATTRIBUTES` carry the three keys.

- [ ] **Step 1: failing tests.**
  - A run with `display_title: 'fix: x'` and `event: 'pull_request'` gives a run resource with
    `vcs.ref.head.title = 'fix: x'` and `cicd.pipeline.trigger = 'pull_request'`, and a job resource that also has
    `cicd.worker.labels = 'ubuntu-24.04-arm'`.
  - A job with `labels: []` has no `cicd.worker.labels`.
  - `contextEnv({... event: 'push', title: 'a,b=c', labels: ['x','y'] })` encodes the values, so
    `OTEL_RESOURCE_ATTRIBUTES` contains `cicd.pipeline.trigger=push`, `vcs.ref.head.title=a%2Cb%3Dc` and
    `cicd.worker.labels=x%2Cy`.
- [ ] **Step 2:** `pnpm exec vitest run test/cli/ci/workflow-trace.test.ts test/cli/ci/context.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** the same command → PASS. Then `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(ci): record the run title, trigger and runner labels on the resources`.

### Task 3: step results, and `needs:` and `if:` from the workflow file

**Files:**
- Create: `src/cli/ci/workflow-file.ts`
- Modify:
  - `src/cli/ci/workflow-trace.ts`: the step span gains `cicd.pipeline.task.step.result` (the step's `conclusion`,
    left out when null). The job span gains `cicd.pipeline.task.id`, `cicd.pipeline.task.needs` and
    `cicd.pipeline.task.condition` from an optional `WorkflowJobs` argument.
  - `src/cli/ci/report-main.ts`: fetches the workflow file once per run before `workflowTraceRequest`. A failure is
    `warn('workflow file not read: …')`, and the report is written without the three keys.
- Test: `test/cli/ci/workflow-file.test.ts`, `test/cli/ci/workflow-trace.test.ts`

**Interfaces:**
- Produces: `interface WorkflowJob { id: string; name: string | null; needs: string[]; condition: string | null }`.
- Produces: `parseWorkflow(text: string): WorkflowJob[]`. `needs` may be a string or a list; `if` is the raw
  text.
- Produces: `matchJob(jobs: readonly WorkflowJob[], apiName: string): WorkflowJob | null`.
  - A `name:` matches with each `${{ … }}` treated as a wildcard.
  - Without `name:`, it matches the id itself, or `<id> (` as a prefix.
  - The first match in file order wins.
- Produces: `fetchWorkflowFile(o: { fetch: typeof fetch; apiUrl: string; repository: string; path: string; ref: string; token: string }): Promise<string>`.
  It calls `GET /repos/{repository}/contents/{path}?ref={ref}` and base64-decodes `content`.

- [ ] **Step 1: failing tests.** Use this repository's `.github/workflows/ci.yml` as text.
  - `parseWorkflow` finds `changes`, `check`, `e2e` and `coverage`. `coverage.needs` contains `changes`, and its
    `condition` contains `push`.
  - `matchJob(jobs, 'e2e (chromium)')` is `e2e`, `matchJob(jobs, 'check')` is `check`, and
    `matchJob(jobs, 'nope')` is null.
  - A job span built with the matched `WorkflowJob` has `cicd.pipeline.task.needs = ['changes']` and
    `cicd.pipeline.task.id = 'coverage'`.
  - A step with `conclusion: 'skipped'` has `cicd.pipeline.task.step.result = 'skipped'`.
  - `report-main` with a fetch returning 404 warns once and still writes the job spans, without `needs`.
- [ ] **Step 2:** `pnpm exec vitest run test/cli/ci/workflow-file.test.ts test/cli/ci/workflow-trace.test.ts test/cli/ci/report-main.test.ts` → FAIL.
- [ ] **Step 3: implement**, using `yaml`'s `parse`.
- [ ] **Step 4:** → PASS. Then `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(ci): record step results and the workflow's needs and conditions`.

### Task 4: format 8, read and written, with the `cicd` table declared

**Files:**
- Modify:
  - `src/format/version.ts`: `PARTITION_FORMAT_VERSION = 8`; `READABLE_PARTITION_FORMATS = [5, 6, 7, 8]`;
    `READABLE_FORMAT_VERSIONS` gains 8; the message says "formats 5 to 8".
  - `src/format/parquet/columns.ts`:
    - `TABLES` gains `'cicd'`, last.
    - `TABLE_COLUMNS.cicd` lists the columns of Global Constraints. The times are `int64`, the counts `int32`, and
      the rest `utf8`. `kind`, `trigger`, `pipeline` and `result` are dictionary columns.
    - `SORT_COLUMNS.cicd = ['trace_id','kind','start_ns']`.
    - `TIME_COLUMN.cicd = 'start_ns'`.
    - `FIXED_STATISTICS_COLUMNS.cicd = []`.
  - `src/format/manifest.ts`:
    - `ManifestV8Schema`: format 7's, plus a `cicd` partition file and `cicd?: true` on the partition entry (Plan note 1).
    - `parseAnyManifest` dispatches 8.
    - `StatisticsKeys` excludes `cicd`.
  - `src/query/sql/views.ts`: a `cicd` view over every partition's `cicd` file.
  - Every gate that compares `formatVersion` with 7 exactly (`grep -rn "formatVersion" src | grep -E "=== ?7|>= ?7|\b7\b"`)
    reads `>= 7`. This includes `newRunManifest` and `withSharesFormat` in `src/cli/ci/run-report.ts`, which write 8.
  - `src/writer/upgrade.ts`: a 5, 6 or 7 manifest is rewritten as 8.
- Test: `test/format/manifest-v4.test.ts`, `test/format/compat.test.ts`, `test/query/sql/views.test.ts`,
  `test/writer/upgrade.test.ts`, `test/cli/ci/run-report.test.ts`

**Interfaces:**
- Produces: `ManifestV4['formatVersion']` is `5 | 6 | 7 | 8`; `Table` includes `'cicd'`.

- [ ] **Step 1: failing tests.**
  - A format-8 manifest listing a `cicd` file and `cicd: true` parses. The same entry in a format-7 manifest is
    `invalid-report`.
  - `upgradeReport` of a format-7 report writes 8, changes no partition byte, and sets no `cicd` flag.
  - A fresh session writes `formatVersion: 8`, and so does `newRunManifest`.
  - `viewStatements` over a manifest with a `cicd` file creates the `cicd` view.
- [ ] **Step 2:** `pnpm exec vitest run test/format test/query/sql/views.test.ts test/writer/upgrade.test.ts test/cli/ci/run-report.test.ts` → FAIL.
- [ ] **Step 3: implement.** Update the tests that pin `formatVersion: 7` for fresh reports.
- [ ] **Step 4:** `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(format): read and write format 8`.

### Task 5: `cicd` rows from a span batch

**Files:**
- Create: `src/writer/cicd-rows.ts`
- Test: `test/writer/cicd-rows.test.ts`

**Interfaces:**
- Consumes: `spanFromRow` (`src/format/parquet/decode.ts`), `ColumnBatch`.
- Produces: `class CicdRowSet { add(batch: ColumnBatch): void; rows(): Row[]; readonly size: number }`.
  - **Run row.** A root span (no parent) whose resource has `cicd.pipeline.run.id`:
    - `result` is `cicd.pipeline.result`;
    - `attempt` is `github.run_attempt`;
    - `trigger` is the resource's `cicd.pipeline.trigger`, else the span's `github.event`;
    - `pipeline`, `run_id`, `branch`, `revision` and `title` come from the resource.
  - **Job row.** A span with the attributes `cicd.pipeline.task.run.id` and `cicd.pipeline.task.name`:
    - `task` is the task name; `task_id` is `cicd.pipeline.task.id`; `result` is `cicd.pipeline.task.run.result`;
      `labels` comes from the resource;
    - `needs` is JSON text of the array; `condition` comes from the span;
    - `queued_ns` is the duration of its child span named `queued`;
    - `failed_step` is the name of its first child (by `github.job.step.number`) with
      `cicd.pipeline.task.step.result = 'failure'`, else of its first child with ERROR status.
  - **`tasks` row.** One per trace holding spans with the bool `mise.task.skipped`: `tasks_replayed` counts `true`,
    `tasks_run` counts `false`.
  - **Skipped.** Spans with `otel_html.ci.provisional = true` are left out. When one batch holds two run roots of
    one trace, only the latest-ending one is kept.
  - `add` may be called per chunk. Children seen in a later chunk than their job are resolved in `rows()`.
- Produces: `encodeCicd(rows: readonly Row[], rowGroupRows: number): Uint8Array`.

- [ ] **Step 1: failing tests.** Build spans with `test-support/otlp-builders.ts`.
  - **A run with two jobs.** One job has a `queued` child of 3 s and a failed step "Run mise run check" (result
    `failure`). The run gives one `run` row and two `job` rows with `queued_ns = 3e9` and
    `failed_step = 'Run mise run check'`.
  - **Trigger fallback.** A root span with `github.event = 'push'` and no resource trigger gives `trigger = 'push'`.
  - **mise counts.** Three mise spans (two `true`, one `false`) in the same trace give one `tasks` row with 2/1.
    Mise spans with no run root in the batch still give the `tasks` row (Review Focus 3).
  - **Provisional.** A provisional root and a final root in one batch give one `run` row, the final one.
  - **Chunks.** `add` over two chunks, with the steps in the second, equals `add` over their concatenation.
  - **Other spans.** A span of another service with none of the keys gives no row.
- [ ] **Step 2:** `pnpm exec vitest run test/writer/cicd-rows.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(writer): cicd rows from a span batch`.

### Task 6: flush, compaction and merge copy write `cicd`

**Files:**
- Modify:
  - `src/writer/partition-session.ts`: the `derive` hook adds `cicd` from `taken.spans`. `#copyPartition` copies a
    source `cicd` byte for byte when the source format is 8. Otherwise it computes one from the decoded spans,
    sharing the memo used by the widget index and the rollup repair.
  - `src/writer/partition-writer.ts`: `Derived.cicd?: Row[]`. Whenever the derivation ran, the partition entry gets
    `cicd: true`; the file is written after `spans` only when it has rows.
  - `src/writer/compaction.ts`: `onRows('spans')` also feeds a `CicdRowSet`. The table is written after the TABLES
    loop when it has rows. The loop skips `cicd`.
  - `src/cli/ci/update.ts`, `src/cli/ci/push-update.ts`, `src/cli/ci/deploy-apply.ts` (maintainer-approved
    2026-11-18): the update schema accepts a `cicd` partition file and `cicd: true`; the push update and the run
    report carry the flag, so the job update path keeps both.
- Test: `test/writer/cicd-flush.test.ts`, `test/writer/merge-cicd.test.ts`

**Interfaces:**
- Consumes: Task 5's `CicdRowSet` and `encodeCicd`.
- Produces: every new partition holding CI spans lists `files.cicd` (Plan note 1).

- [ ] **Step 1: failing tests.**
  - A flush of a CI run writes `cicd` with Task 5's rows and `cicd: true`. A flush of non-CI spans writes no file
    but still sets `cicd: true`.
  - Three flushes compacted give one `cicd` whose rows equal the union.
  - Merging a format-7 input (`fixtures/reports/format-7`) and a format-6 input gives a `cicd` file per partition
    holding CI spans, equal to a fresh write.
  - A format-8 input's `cicd` is copied byte for byte.
  - The input `spans.parquet` is read once per copied partition.
- [ ] **Step 2:** `pnpm exec vitest run test/writer/cicd-flush.test.ts test/writer/merge-cicd.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** → PASS. Then `mise run check` → PASS.
- [ ] **Step 5: measure the writer cost.** Time a flush of the scaling `mixed` shape's largest partition before and
  after, and record it in the PR body. **Stop and ask** above +15 %.
- [ ] **Step 6:** commit `feat(writer): flushes, compactions and merge copies write the cicd table`.

### Task 7: the CI fixture, an e2e `ci` report, and a frozen format-8 report

**Files:**
- Modify:
  - `scripts/ci-fixture.ts`:
    - 40 runs over 10 days: push, pull_request, schedule and workflow_dispatch;
    - one run with two attempts;
    - one cancelled run, one failed step, and a job skipped on docs-only;
    - the §4.1 attributes, with labels in two pools;
    - mise task spans with `mise.task.skipped` (all false on schedule runs);
    - vitest and Playwright test spans under the `check` and `e2e (chromium)` jobs, with 3 skipped tests and one
      Playwright retry;
    - one provisional root.

    Regenerate `fixtures/ci.otlp.json` with `mise run fixtures`.
  - `e2e/fixture.ts`: `FIXTURE_REPORTS` gains `'ci'`, and `ReportName` gains it.
  - `e2e/build-fixtures.ts`: builds `ci` from `fixtures/ci.otlp.json` with config `.github/otel-html-ci.yaml`.
  - Freezing follows `fixtures/reports/README.md`'s recipe, which updates the frozen lists:
    - `fixtures/reports/format-8/**`, `fixtures/reports/README.md` and `SHA256SUMS`;
    - `test/format/frozen-checksums.test.ts`, `test/viewer-data/frozen-reports.test.ts` and
      `test/format/compat.test.ts`;
    - `e2e/global-setup.ts`, `e2e/frozen.spec.ts` and `test/cli/host.test.ts`.
- Test: the frozen and compat tests above; `test/cli/ci/dashboard-config.test.ts` still passes.

- [ ] **Step 1:** regenerate the fixture. Assert in `test/scripts/ci-fixture.test.ts` (create it) that it holds 40
  run ids, one with attempt 2, and one provisional root.
- [ ] **Step 2:** freeze format 8 from the branch head. Check that the frozen report holds a `cicd` file with
  `run`, `job` and `tasks` rows.
- [ ] **Step 3:** `mise run check` → PASS. Then `mise run test:e2e:chromium -- e2e/frozen.spec.ts` → PASS.
- [ ] **Step 4:** commit `test: a CI fixture with the new attributes, an e2e ci report and a frozen format-8 report`.

### Task 8: `cicdRows` and the combined runs

**Files:**
- Create:
  - `src/viewer/data/cicd-query.ts`: SQL over the `cicd` view; the scan over `spans` for older partitions.
  - `src/viewer/cicd/runs.ts`: combine rows into runs, a pure function.
- Modify:
  - `src/viewer/data/data-source.ts`: `cicdRows`.
  - `src/viewer/data/duckdb-source.ts`: implements it.
  - `src/viewer/data/catalogue.ts`: entries `cicd.rows` and `cicd.rows.scan`.
- Test: `test/viewer-data/cicd-rows.test.ts`, `test/viewer/cicd/runs.test.ts`

**Interfaces:**
- Produces: `interface CicdRow { kind: 'run' | 'job' | 'tasks'; traceId: string; spanId: string | null; start: number; end: number; name: string | null; result: string | null; pipeline: string | null; runId: string | null; attempt: number | null; trigger: string | null; branch: string | null; revision: string | null; title: string | null; task: string | null; taskId: string | null; labels: string | null; queuedNs: number | null; needs: string[] | null; condition: string | null; failedStep: string | null; tasksReplayed: number | null; tasksRun: number | null }`.
  - `start` and `end` are run-relative ns, like other viewer times.
- Produces: `DataSource.cicdRows(q: { window: TimeWindow | null; bindings: VariableBinding[]; pipeline: string | null }, signal?: AbortSignal): Promise<readonly CicdRow[]>`.
  - It returns the rows of the traces whose run row starts in the window.
  - It applies only the run-level bindings (branch, trigger) and `pipeline`. The `job` and `runner` bindings are not
    sent: they narrow job rows in memory, per view (Task 18), so the run-level views keep every job of a run.
- Produces: `interface CiJob { name: string; id: string | null; result: string; start: number; end: number; queuedNs: number | null; labels: string | null; needs: string[]; condition: string | null; failedStep: string | null; spanId: string | null }`.
- Produces: `interface CiRun { traceId: string; runId: string; attempt: number; attempts: number; start: number; duration: number; result: 'success' | 'failure' | 'cancelled'; trigger: string | null; branch: string | null; revision: string | null; title: string | null; jobs: CiJob[]; minutes: number; replayed: number; ran: number; cached: boolean | null }`.
  - `cached` is null when `replayed + ran = 0`, else `replayed > 0`.
  - `result` maps `cancellation` to `cancelled`, and any result other than success to `failure`.
- Produces: `combineRuns(rows: readonly CicdRow[]): CiRun[]`. Rows are joined by trace, the task counts summed,
  each run id keeps its latest attempt (`attempts` = how many were seen), and the result is sorted by start.

- [ ] **Step 1: failing tests.**
  - **Format-8 report.** On the `ci` e2e report's data (open it with the Node engine as the viewer-data tests do),
    `cicdRows` over 7 days returns 1 row per run, its jobs and its `tasks` rows, and reads no `spans.parquet`.
  - **Mixed formats (Review Focus 1).** The same data with half its partitions rewritten as format 7 (copy
    `fixtures/reports/format-7`'s procedure) returns equal rows; the format-7 half takes `cicd.rows.scan`.
  - **Upgraded.** The same format-7 half after `upgradeReport` (format 8, no flag) is still scanned and returns
    equal rows.
  - **Bindings.** A `trigger` binding keeps only those runs, with all their jobs.
  - **`combineRuns`.** Two attempts give one run with `attempts: 2`, taking attempt 2's result (Review Focus 2).
    `tasks` rows from two partitions sum (Review Focus 3). A run with no job rows has duration
    `end - start` of its root.
- [ ] **Step 2:** `pnpm exec vitest run test/viewer-data/cicd-rows.test.ts test/viewer/cicd/runs.test.ts` → FAIL.
- [ ] **Step 3: implement.**
  - The catalogue classes follow the `widget_traces` route entry:
    - `cicd.rows`: `files` on retention and density, and on window.
    - `cicd.rows.scan`: `scan` on retention, density and window (measured), with the `allowed` reason "partitions
      without the cicd flag (older or upgraded)".
  - The SQL builders live in `src/query/sql/cicd.ts` and `encodeCicd` in `src/writer/cicd-encode.ts`.
  - Add a scaling-shape test that both stay in class.
- [ ] **Step 4:** → PASS. Then `mise run check` → PASS (the catalogue gates included).
- [ ] **Step 5:** commit `feat(viewer): cicdRows reads the cicd table and combines runs`.

### Task 9: docs, measurement, PR 1

**Files:**
- Modify: `README.md`:
  - the format table (8: `cicd`);
  - the CI section: the new attributes and what each feeds;
  - the publisher's need for `contents: read` to record `needs` and `if`.
- [ ] **Step 1: measure.** Build the live-data rebuild with the branch (Plan note 2). Record `cicd` bytes against
  spans bytes, which must be ≤ 1 %. **Stop and ask** if they are over.
- [ ] **Step 2: check the deploy path.** Read `site.yml` and the `otel-html-deploy` action without changing them.
  Confirm that the deployer builds from `main` and reads format 7 and format 8. **Stop** if a released binary that
  cannot read 8 merges the site.
- [ ] **Step 3:** `mise run verify` → PASS. Commit `docs: format 8 and the CI attributes`.
- [ ] **Step 4: open PR 1.** The body carries:
  - why the format change is breaking (0.7.x `merge` and `host` refuse format 8);
  - Task 6's timing and Task 9's bytes;
  - Task 1's findings;
  - **Also**.

  Then: branch review on Opus 5.5 → fix → CI green → merge.

## PR 2: the generic page

### Task 10: range presets on every page, and custom

**Files:**
- Modify: `src/viewer/shell/time-range.tsx`: `PRESETS` becomes Entire run, `1h`, `24h`, `7d`, `30d`, `90d`, `1y`,
  plus a "custom…" item. Custom opens two `datetime-local` inputs and an Apply button, and sets `t` to `<start>~<end>`.
- Test: `test/viewer/time-range.test.tsx`

- [ ] **Step 1: failing tests.**
  - The menu lists `1h, 24h, 7d, 30d, 90d, 1y` (offered by run length as today) and "custom…".
  - Custom with from < to sets `t` to that window. With from ≥ to, Apply is disabled.
  - `15m` and `6h` are gone.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): range presets up to a year, and a custom range`.

### Task 11: the zoom slider and its label

**Files:**
- Create:
  - `src/viewer/dashboards/range-label.ts`: pure label logic.
  - `src/viewer/dashboards/range-slider.tsx`: an SVG slider bound to the page window `t` (the extent) and `d.sel.t`
    (the zoom).
- Modify:
  - `src/viewer/dashboards/dashboard-page.tsx`: renders the slider in the bar (Task 12). Its drag updates `sel.t`
    through `requestAnimationFrame`, so there is at most one URL write per frame.
  - `src/dashboards/schema.ts`: check `follow` defaults to true for every followable type (Plan note 3).
- Test: `test/viewer/range-label.test.ts`, `test/viewer/range-slider.test.tsx`

**Interfaces:**
- Produces: `rangeLabel(o: { preset: string | null; extent: [number, number]; zoom: [number, number] | null }): { label: string; of: string | null; zoomed: boolean; header: string }`.
  - No zoom: the preset label ("last 7 days", or "custom").
  - Zoomed with the end within 0.5 % of the extent's end: `last <humanDur>`.
  - Zoomed with the end moved: `custom`.
  - `of`: ` of <extent duration>` when zoomed.
  - `header`: `<from> – <to> · <humanDur>` when zoomed.
- Produces: `humanDur(ns: number): string`, giving "N minutes" under 1 h, "N hours" under 48 h, else "N days" with
  one decimal unless whole.
- Produces: `<RangeSlider extent zoom ticks onZoom />`, where `ticks: readonly { t: number; color: string }[]` is
  empty until PR 3.

- [ ] **Step 1: failing tests.**
  - `rangeLabel` with preset `7d`, extent 7 d and zoom [3 d, 7 d] gives "last 4 days", with `of` " of 7 days".
  - The same with zoom [1 d, 5 d] gives "custom", and its header names both dates and "4 days".
  - Without zoom it gives "last 7 days" and `zoomed: false`.
  - `humanDur` of 90 min is "2 hours", of 30 min "30 minutes", and of 3.5 d "3.5 days".
  - Slider: dragging the left handle by a quarter calls `onZoom` with [¼, 1] of the extent. A drag within 0.5 % of
    an edge snaps to it. Double-click calls `onZoom(null)`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): a zoom slider over the page range`.

### Task 12: the page filter bar and quick filters

**Files:**
- Create: `src/viewer/dashboards/filter-bar.tsx`, which replaces `variables-bar.tsx`'s use on the page.
  `variables-bar.tsx` keeps `withVariable` and the value list.
- Modify:
  - `src/dashboards/schema.ts`: dashboard `quick?: { label: string; set: Record<string, string | null> }[]`, at most
    6. Every key must be one of the dashboard's variables. Run `mise run gen`.
  - `src/viewer/dashboards/dashboard-page.tsx`: renders the bar above the grid.
- Test: `test/viewer/filter-bar.test.tsx`, `test/dashboards/schema.test.ts`

**Interfaces:**
- Produces: `<FilterBar dashboard state onVars onZoom slider />`. It is sticky and pinned by default; the pin state
  lives in `localStorage` key `otel-html.filters.pinned`, read and written in try/catch. Its contents, in order:
  - "Page filters";
  - the quick pills, with a pill pressed when its `set` equals the current bindings;
  - the range dropdown (the shell's, from Task 10, and its "↺ full range" when zoomed);
  - per variable, a chip `label = value ×` when set, else a `+ label` button opening the value list;
  - the run count slot;
  - the pin toggle;
  - the slider row.

- [ ] **Step 1: failing tests.**
  - A quick filter keyed to a key that is not a variable is a schema error.
  - Pressing `main` sets `vcs.ref.head.name=main` and clears `cicd.pipeline.trigger`; pressing `all` clears both.
  - A set variable shows a chip; its × clears it.
  - Unpinning stores `false`; a throwing `localStorage` still renders, pinned.
  - The stuck bar gets the `stuck` class when its sentinel leaves the viewport (IntersectionObserver mocked).
  - Stuck under 768 px, the slider row is hidden.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. Then `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(viewer): the page filter bar with chips and quick filters`.

### Task 13: the context menu component

**Files:**
- Create: `src/viewer/components/context-menu.tsx`
- Test: `test/viewer/context-menu.test.tsx`

**Interfaces:**
- Produces: `type MenuItem = { label: string; code?: string; run(): void } | 'separator'`.
- Produces: `useContextMenu(): { open(at: { x: number; y: number }, title: string | null, items: readonly MenuItem[]): void; element: JSX.Element }`.
  - The menu is placed inside the viewport and the first item takes focus.
  - Arrow keys move, Enter runs, and Escape, an outside pointer-down or a scroll closes it.
- Produces: `menuTriggers(open: (at: { x: number; y: number }) => void): { onContextMenu; onPointerDown; onPointerUp; onPointerCancel }`.
  A right-click or a 500 ms touch press opens the menu.

- [ ] **Step 1: failing tests.**
  - Opening focuses the first item; ArrowDown then Enter runs the second.
  - Escape closes it; so does a pointer-down outside.
  - An open at x = viewport width − 10 is shifted left inside the viewport.
  - A touch press of 500 ms opens it; one of 200 ms does not.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): a context menu component`.

### Task 14: the filter echo in widget headers

**Files:**
- Modify:
  - `src/viewer/dashboards/scope.ts`: `honours(widget: Widget, variable: Variable): boolean`. It is true for every
    generic type, and table-driven, so PR 3 adds `cicd`. `fixedScope(widget: Widget): string | null` returns null for
    generic types.
  - `src/viewer/dashboards/widget-frame.tsx`: after the subtitle, it shows a filled chip per active honoured
    variable, a dashed "ignores <label>" chip per active ignored one, or a dashed scope chip. Under 768 px it is
    hidden (`useStacked`).
- Test: `test/viewer/dashboard-page.test.tsx` (extend)

- [ ] **Step 1: failing tests.**
  - With `job = check` bound, a metric widget's header shows `job = check`.
  - With nothing bound, no chip is shown.
  - At a 390 px viewport (matchMedia mocked), no chip is shown.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): widget headers echo the page filters`.

### Task 15: paired stacking and the good tokens

**Files:**
- Modify:
  - `src/viewer/dashboards/grid.tsx`: in the stacked branch, a two-column CSS grid. A widget with `w ≤ 3` spans one
    column, anything else spans two, in `byPosition` order. Heights stay `widgetHeightPx(h)`.
  - `src/viewer/theme/tokens.css`: the three tokens, light and dark.
  - `src/viewer/theme/palette.ts`: `STATUS.good`.
- Test: `test/viewer/dashboard-grid.test.tsx` (extend), `test/viewer/palette.test.ts`

- [ ] **Step 1: failing tests.**
  - Six `w: 2` widgets and one `w: 12` stacked give three rows of two, then one full row.
  - A lone `w: 3` widget between two `w: 12` widgets takes a full row.
  - `STATUS.good` reads `--color-good`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): small widgets pair up on phones; good status tokens`.

### Task 16: e2e and PR 2

**Files:**
- Modify: `e2e/dashboards.spec.ts`

- [ ] **Step 1: e2e tests** on the `dashboards` fixture report:
  - **Presets.** Choosing 30d sets `t`.
  - **Zoom.** Dragging the slider handle zooms: the label reads "last …", with "of …" and "↺ full range".
    "↺ full range" clears the zoom.
  - **Quick filters and chips.** A quick filter press sets a chip, and × clears it.
  - **Pin.** Scrolling keeps the pinned bar visible; unpinned, it scrolls away.
  - **Phone.** At 390 px, nothing scrolls sideways and two small widgets share a row (add two `w: 3` widgets to
    `fixtures/dashboards.otel-html.yaml` if it has none).
- [ ] **Step 2:** `mise run test:e2e:chromium -- e2e/dashboards.spec.ts` → PASS.
- [ ] **Step 3:** check the CI dashboard's request count with the scaling page test (`#/dashboards/ci` pins). It must
  not grow; a growth is a bug to fix here.
- [ ] **Step 4:** README: the dashboard page section (filter bar, quick filters, presets, slider, echo, phone
  stacking). `mise run verify` → PASS. Commit `docs: the dashboard filter bar`.
- [ ] **Step 5: open PR 2.** Then: branch review on Opus 5.5 → fix → CI green → merge.

## PR 3: the `cicd` widget type

### Task 17: the `cicd` type in the schema and the scope tables

**Files:**
- Modify:
  - `src/dashboards/schema.ts`: `WidgetType` gains `'cicd'`. The object has:
    - `view`: one of `stat`, `runs-trend`, `runs`, `jobs`, `status-grid`, `failures`, `triggers`, `queue`, `minutes`,
      `tests`;
    - `stat?`: one of `success-rate`, `median-run`, `cache`, `minutes`, `queue-p95`, `reruns`, required when
      `view: stat` and refused otherwise;
    - `by?`: `trigger` | `job`, `minutes` only, default `trigger`;
    - `pipeline?: string`;
    - `follow`, `title`, `x`, `y`, `w` and `h` as for other types.

    It takes no `query`. Run `mise run gen`.
  - `src/viewer/dashboards/scope.ts`: `WIDGET_SCOPE.cicd`. `honours` follows the spec §6 table: run-level views
    honour only branch and trigger; `failures` all but runner; the rest all four. `fixedScope` is "latest run" for
    `tests`.
  - `src/viewer/dashboards/dashboard-page.tsx` (`WIDGETS`, `openInOf` → null), `copy-widget.ts` and
    `widget-frame.tsx` (`TYPE_TITLES.cicd = 'CI'`).
- Test: `test/dashboards/schema.test.ts`, `test/viewer/dashboard-page.test.tsx`

- [ ] **Step 1: failing tests.**
  - `{type: cicd, view: stat}` without `stat` is an error, as is `stat` on `view: runs`.
  - `{type: cicd, view: minutes, by: job}` parses.
  - `honours(runs widget, job variable)` is false; `honours(jobs widget, job variable)` is true.
- [ ] **Step 2:** → FAIL. **Step 3:** implement, with a placeholder renderer that shows the view name. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(dashboards): the cicd widget type`.

### Task 18: the shared fetch and the derivations

**Files:**
- Create:
  - `src/viewer/cicd/use-cicd.ts`: the shared fetch.
  - `src/viewer/cicd/derive.ts`: one pure function per view.
- Test: `test/viewer/cicd/derive.test.ts`

**Interfaces:**
- Consumes: `combineRuns`, `CiRun` and `DataSource.cicdRows` (Task 8).
- Produces: `useCicd(widget: Widget): { status: 'loading' | 'ready' | 'error'; runs: CiRun[]; previous: CiRun[]; error?: Error }`.
  - It reads one shared fetch per page (React context keyed by page window, run-level bindings and pipeline).
  - The fetch window is the page window extended backwards by its own length.
  - **Periods first.** The rows are split by run start into the current span (the page window narrowed by `sel.t`
    when following) and `previous` (the same length just before it). `combineRuns` runs on each part separately, so
    each period keeps its own latest attempt.
  - **Job and runner.** For a view that honours them, the `job` and `runner` bindings then drop non-matching jobs,
    and runs left with no job. Run-level views get the runs unnarrowed.
- Produces, all pure:
  - `stat(kind, runs, previous): { value: string; delta: { text: string; better: boolean | null } | null; spark: number[] | null; note: string | null }`.
  - `trendBuckets(runs, span: [number, number]): { step: number; buckets: { t: number; p50: number | null; p95: number | null; passed: number; failed: number; cancelled: number; runs: CiRun[] }[] }`.
    - The step is the smallest of 5 min, 15 min, 30 min, 1 h, 3 h, 6 h, 12 h, 1 d, 2 d, 1 w, 2 w and 30 d that
      gives at most `min(48, max(6, floor(runs/3)))` buckets.
  - `jobsTable(runs, all)`: its rows carry `name`, `points`, `latest`, `median`, `p25`, `p75`, `delta`, `deltaA`,
    `deltaB` and `failed: [k, n]`.
    - Order is by median start offset.
    - `delta` is the median of the last 10 successful runs against the 20 before, and null when either side has
      fewer than 3.
    - Jobs with fewer than 3 points are left out.
  - `statusGrid(runs, 60)`: `{ runs: CiRun[]; rows: { job: string; cells: ('success'|'failure'|'cancelled'|null)[]; failed: number; ran: number }[] }`.
  - `failures(runs, 10)`.
  - `triggers(runs)`: `{ trigger, runs, passedShare, jobs: number, always: number, chips: { names: string[]; share: number; count: number }[] }[]`.
    Jobs of equal ran-count fold into one chip.
  - `queue(runs)`: one entry per label (null as "(no label)") with at least 5 jobs: `{ label, p50, p95, max, n }`.
  - `minutesPerDay(runs, by: 'trigger' | 'job')`: by job, the top 7 plus "Other". Days are local.
  - `rerunsAndCancelled(runs)`.

- [ ] **Step 1: failing tests** on 12 hand-built `CiRun`s with exact expected values for each function:
  - success rate 9/11 when one run is cancelled;
  - the trend step is 2 d for 12 runs over 7 days (at most 6 buckets), and 6 h for 257 runs over 7 days;
  - Δ "baseline too small" under 3;
  - folded trigger chips;
  - a `(no label)` queue row;
  - the minutes top-7 cut.

  Review Focus 2: two attempts give `reruns` 1 and one grid column. Attempt 1 in the previous period and attempt 2
  in the current one count once in each period. A `job` binding drops a run without that job from `jobsTable`, but
  not from `stat('median-run')`. Review Focus 4: an empty `runs` gives
  `value: '–'`, empty buckets and empty rows, and no number in any result is `NaN` or infinite (walk the result and
  check `Number.isFinite` on every number).
- [ ] **Step 2:** `pnpm exec vitest run test/viewer/cicd/derive.test.ts` → FAIL.
- [ ] **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): cicd derivations and the shared fetch`.

### Task 19: run marks, selection rings and run menus (shared view plumbing)

**Files:**
- Create: `src/viewer/cicd/run-actions.ts`
- Modify: `src/viewer/state/dashboard-state.ts`: `run: { from: string; mode: 'attached' | 'panel' } | null`,
  default null, in the schema.
- Test: `test/viewer/cicd/run-actions.test.ts`, `test/viewer/dashboard-state.test.ts`

**Interfaces:**
- Produces: `useRunActions(widgetId: string): { openRun(run: CiRun): void; runMenu(run: CiRun, at: {x:number;y:number}): void; jobMenu(job: string, at): void; triggerMenu(trigger: string, at): void; runnerMenu(label: string, at): void; selectedTraceId: string | null; isSource: boolean }`.
  - `openRun` sets `sel.trace` and `run = { from: widgetId, mode }`, keeping the last mode (default `attached`).
  - The menus hold the spec §5.4 items and set variables through `withVariable`.
- Produces: `<RunRing />`, an SVG ring. It is drawn faint on the open run in every view, and full with a dotted
  connector in the source view.

- [ ] **Step 1: failing tests.**
  - `openRun` writes `d.run` and `d.sel.trace`.
  - `runMenu` on a failed pull-request run lists "Open the run here", "Open on GitHub ↗", "Filter the page by
    trigger" (pull request), "Show main only", and one "Filter the page by job" per failed job (at most 2).
  - A `d` without `run` parses as `run: null`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): opening a run and the run menus`.

### Task 20: the stat, runs-trend and runs views

**Files:**
- Create: `src/viewer/cicd/views/stat.tsx`, `runs-trend.tsx`, `runs.tsx`, and `src/viewer/cicd/widget.tsx` (the
  renderer that switches on `view`, registered in `WIDGETS`).
- Test: `test/viewer/cicd/views-runs.test.tsx`

- [ ] **Step 1: failing tests** (rendered with the `dashboard-shell.tsx` helper and a fake `cicdRows`):
  - **stat.** It shows 82% and "▲ … pts vs 7 days before". Better is green: success up is good ink, duration up is
    critical ink.
  - **runs-trend.** For 12 runs over 7 days the subtitle reads "2 days buckets". The chart option has two line series (p50, p95) and three
    stacked bar series. Right-clicking a bucket offers "Zoom the slider to this bucket", which sets `sel.t`.
  - **runs.** There is one bar per run, a run with `cached: false` is hollow, and a click calls `openRun`.
  - **Empty (Review Focus 4).** All three show "No run in this range." with no error.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. Charts size to the widget body (`heightPx` minus the header) and
  redraw on resize. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): cicd stat, runs-trend and runs views`.

### Task 21: the jobs, status-grid, failures and triggers views

**Files:**
- Create: `src/viewer/cicd/views/jobs.tsx`, `status-grid.tsx`, `failures.tsx`, `triggers.tsx`
- Test: `test/viewer/cicd/views-jobs.test.tsx`

- [ ] **Step 1: failing tests.**
  - **jobs.** A row click expands the trend chart; the ⋯ opens the job menu; "baseline too small" shows.
  - **status-grid.** It has 60 columns at most. A failed cell click opens its run. A label longer than its column is
    truncated with `…` and carries a `<title>` holding the full name.
  - **failures.** Rows are latest first, with the trigger and branch under the title. A failed-job chip opens the
    job menu.
  - **triggers.** The push row reads "all N" when every job always ran, and a chip reads "7 jobs 95%".
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): cicd jobs, status-grid, failures and triggers views`.

### Task 22: the queue, minutes and tests views

**Files:**
- Create: `src/viewer/cicd/views/queue.tsx`, `minutes.tsx`, `tests.tsx`, and `src/viewer/cicd/test-suites.ts`
  (pure: test spans of a trace to suites).
- Test: `test/viewer/cicd/views-cost.test.tsx`, `test/viewer/cicd/test-suites.test.ts`

**Interfaces:**
- Produces: `testSuites(trace: TraceDetail): { id: string; job: string; task: string; framework: 'vitest' | 'playwright'; files: { file: string; ms: number; tests: { name: string; ms: number; skipped: boolean; project: string | null }[]; skipped: number }[]; total: number; skipped: number }[]`.
  - The suite is (the job span ancestor's task name, the mise task ancestor's name).
  - Skipped means a vitest `vitest.test.mode` of `skip` or `todo`, or a Playwright `test.case.result.status` of
    `skipped`.

- [ ] **Step 1: failing tests.**
  - **queue.** It shows one row per label with at least 5 jobs; "(no label)" appears for older runs.
  - **minutes.** The by-job toggle shows the top 7 plus Other. A legend item opens its menu.
  - **testSuites.** On the `ci` fixture's latest run with tests, it finds `check › test:unit:main` and
    `e2e (chromium) › test:e2e`, with 3 skipped in all.
  - **tests.** Pills per suite; files sorted by test time (top 10); a row expands to its tests; the skipped
    disclosure. It calls `getTrace` once per shown suite run.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): cicd queue, minutes and tests views`.

### Task 23: the open run, attached and in the trace panel

**Files:**
- Create:
  - `src/viewer/cicd/run-gantt.tsx`: the shared content.
  - `src/viewer/cicd/run-pane.tsx`: the attached frame, with a caret.
- Modify:
  - `src/viewer/dashboards/grid.tsx`: accepts an optional
    `insert: { after: string; render(heightPx: number): JSX.Element; rows: number }`.
    - Desktop: the pane spans 12 columns. Its `y` is the largest bottom among the widgets whose vertical span
      overlaps the source's. Widgets at or below that `y` shift down by `rows`.
    - Stacked: it comes right after the source.
    - Edit mode ignores `insert`.
  - `src/viewer/dashboards/dashboard-page.tsx`: passes the pane when `d.run.mode === 'attached'` and `sel.trace` is a
    run of a `cicd` widget. When the mode is `panel`, it opens the `TracePanel` on the Jobs tab.
  - `src/viewer/traces/tabs.ts` and `trace-panel.tsx`: a `jobs` tab, `available` when the trace has a span whose
    resource has `cicd.pipeline.run.id` and no parent.
  - `src/viewer/state/url-state.ts`: the `jobs` tab id.
- Test: `test/viewer/cicd/run-gantt.test.tsx`, `test/viewer/dashboard-grid.test.tsx` (extend),
  `test/viewer/trace-tabs.test.ts`

**Interfaces:**
- Produces: `<RunGantt run={CiRun} traceId />`:
  - the summary line;
  - job bars, with hatched queue, result colours, the last-to-finish outline and a dashed end line;
  - `needs` edges: `needs` names workflow job ids, and an edge is drawn from every job whose `id` is one of them
    (every leg of a matrix);
  - expanding a job loads `getTrace(traceId)` once and shows its steps (`cicd.pipeline.task.step.result` colours);
  - a step with mise task descendants expands to them, replayed ones hatched.
- Produces: the pane height in rows, which is `ceil((contentPx + 10) / 30)` and is measured after render.

- [ ] **Step 1: failing tests.**
  - **Grid insert.** With the source at y 31, h 12 and full width, the pane lands at y 43 and the widget at y 43
    moves to 43 + rows. With a stacked source, the pane is next in order.
  - **Gantt.** On the fixture run with a failed job: 11 job rows; the last-to-finish job outlined; `coverage` has an
    edge from `changes`; expanding `check` shows its steps after one `getTrace` call.
  - **Jobs tab.** `available` is true on a run trace and false on a non-CI trace.
  - **Modes.** Switching to "side panel" sets `d.run.mode = 'panel'` and opens the panel; ✕ clears `d.run` and
    `sel.trace`.
  - **Detached.** A `trigger` binding that removes the open run from its source view hides the caret, and the pane
    shows "The run is outside the current selection".
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. Then `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(viewer): the open run, attached in the grid or as the trace panel's Jobs tab`.

### Task 24: slider ticks and the run count

**Files:**
- Modify:
  - `src/viewer/dashboards/dashboard-page.tsx`: when the page has a `cicd` widget, the slider's ticks come from the
    shared fetch (one per run, result colour), and the bar's count reads "N runs".
  - `src/viewer/cicd/use-cicd.ts`: exposes `useCicdPage()` for the page.
- Test: `test/viewer/dashboard-page.test.tsx` (extend)

- [ ] **Step 1: failing test.** A page with a `cicd` widget passes one tick per run to the slider and shows
  "12 runs". A page without one passes `[]`, and `cicdRows` is not called.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): the slider shows runs on CI dashboards`.

### Task 25: the CI configs, e2e, measurement and PR 3

**Files:**
- Modify:
  - `.github/otel-html-ci.yaml` and `.github/actions/otel-html-publish/otel-html-ci.yaml`, per spec §8:
    - the variables, quick filters and the 15 widgets at the §6 positions;
    - `defaultWindow: 7d`;
    - this repository's copy sets `pipeline: ci` on every `cicd` widget.
  - `test/config/ci-dashboard.test.ts` and `test/cli/ci/dashboard-config.test.ts`: assert the new layout, that both
    copies differ only by `pipeline: ci`, and that no widget overlaps another.
  - `README.md`: the `cicd` widget type (views, options, what each honours), the open run, and the CI dashboard.
- Create: `e2e/ci-dashboard.spec.ts`

- [ ] **Step 1: e2e tests** on the `ci` report. The first test carries the `HTTP` tag.
  - Every view renders without console errors.
  - Clicking a status-grid cell opens the attached pane under the grid row, with the caret over the cell. Then
    "side panel" opens the Jobs tab.
  - Right-click a job → "Filter the page by job" sets the chip. The runs view echoes "ignores job" and the jobs view
    `job = …`.
  - Dragging the slider redraws runs-trend: its bucket subtitle changes.
  - **Phone (Review Focus 5).** At 390 px: no horizontal scroll; stats paired; a clicked run's pane comes right after
    its widget; no echo chips.
- [ ] **Step 2:** `mise run test:e2e:chromium -- e2e/ci-dashboard.spec.ts` → PASS.
- [ ] **Step 3: measure (spec §2 goal 4)** on the live-data rebuild (Plan note 2):
  - settled time and request count of `#/dashboards/ci`;
  - frames per second during a scripted 2 s slider drag (Playwright, `requestAnimationFrame` counter).

  Record them in the PR body. **Stop and ask** on a miss.
- [ ] **Step 4:** `mise run verify` → PASS. Commit `feat(ci): the new CI dashboard configs`.
- [ ] **Step 5: open PR 3.** The body carries the measurements, the dashboard's screenshots at 1360 and 390 px, and
  **Also**. Then: branch review on Opus 5.5 → fix → CI green → merge.
- [ ] **Step 6: the record.** After the deploy that runs PR 3's build on the live site, measure `#/dashboards/ci` as
  in Step 3. Write it under "Record" at the end of this plan, mark every row merged, and merge that change as
  `docs(plan): ci-dashboard-ui record`.

## Amendments

### Task 1 findings (2026-11-18)

Read from `otel-html-check` of push run 44232036620 (main, `3c97d775`; 4053 spans, 1 trace) and `otel-html-e2e-chromium-1of2`
of push run 44009807376 (693 spans, 1 trace). The latest push run (44232036620) uploaded no e2e artifact, so the e2e one
is from the previous push run. Attributes and resource attributes are JSON text columns in `spans.parquet`.

- **`mise.task.skipped`.** Four spans in the check artifact carry it: `lint`, `typecheck`, `knip`, `scaling:reports`
  (scope `mise.tasks`, service `ci/check`). It is a JSON boolean (`true` on all four); no span carries `false`, so absence
  means "ran". The e2e artifact has none. Other `mise.tasks` spans: 34 in the check artifact (task spans with
  `mise.task.name`, `mise.task.display_name`, `mise.task.source`, `process.exit.code`; `mise.span_type` = `run` or
  `setup` for the "mise run X", "resolve tasks", "install tools", "deps", "start daemons" spans).
- **Resource of mise spans.** `service.name` `ci/<job>`, `cicd.pipeline.run.id`, `cicd.pipeline.task.name` (`check`),
  `cicd.pipeline.name`, `cicd.pipeline.run.url.full`, `vcs.*`, `telemetry.sdk.*`. All 38 spans of scope `mise.tasks`
  (34) and `otel-html` (4 `bash` step spans) carry run.id and task.name (38 of 4053); the e2e artifact's mise spans
  carry `cicd.pipeline.task.name` = `e2e (chromium, 1)`.
- **Vitest spans.** 4015 of 4053, scope `vitest`, resource `{service.name: otel-html-tests, service.version, test.framework: vitest}`:
  no `cicd.pipeline.*` on the resource. Names include `vitest.start`, `vitest.coverage.init`, `vitest.config.*` and the
  test spans. Same trace as the mise spans.
- **Playwright spans.** 75 spans in the chromium-1of2 artifact, scope `otel-html-tests`, resource
  `{service.name: otel-html-tests, service.version, test.framework: playwright}`: no `cicd.pipeline.*`. Span name is the
  test title; attributes `test.suite.name` (spec file), `test.case.name`, `playwright.project`, `otel_html.test.retry`,
  `otel_html.test.tags`, `test.case.result.status`. Also 614 `otel-html-viewer` spans (scope and service
  `otel-html-viewer`). Same trace as the mise spans.
- **Trace and root.** Each artifact is one trace. No span has an empty parent; the only spans whose parent is absent
  from the artifact are the `bash` step spans (scope `otel-html`: 4 in check, 3 in e2e). The CI run root span is not in
  these artifacts (it is joined later by `otel-html ci`), so a widget must not assume a root in the per-job data.
- **Consequence for the plan.** The `cache` tile and hollow marks can key on `mise.task.skipped = true` (bool, present
  only when skipped). Test spans carry no `cicd.pipeline.task.name`/`run.id` on the resource: attribute them to a CI run
  and job through `trace_id` shared with the mise spans of the same job, not through their own resource.

### PR 2 amendments (2026-11-18)

What PR 3 builds on, changed from the task text by the branch review:
- **FilterBar** takes `count?: ReactNode` (the run-count slot) and `ticks` (threaded to `ZoomRow`/`RangeSlider`);
  Task 24 passes them instead of filling an empty slot.
- **The slider header line of spec §5.2** (extent; "all N selected · drag to zoom" or "from – to · duration · N runs")
  and drawing a new range on the bare track are built in PR 2. `count` supplies the N and the "· N runs" part.
- **A preset, custom range or step clears `sel.t`**; slider writes are whole nanoseconds; URL writes during a drag
  are throttled (`markLive`, at most one per 250 ms, the final value on release).
- **`useContextMenu`** renders through a portal to `document.body`; `element` is `JSX.Element | null`.
- **`honours`** is false for a metric widget's `runBy` variable (the run chart ignores it); PR 3 adds the `cicd` rows.
- **The shell sidebar** folds into a drawer under 768 px (every page scrolled sideways at 390 px before).
- The 30 fps drag figure is still measured in Task 25 (ruling R14).

### PR 3 amendments (2026-11-18)

- **Task 26 (added).** The first live measurement missed spec §2 goal 4: 207 requests, 3.2 s, and a 10.4 fps drag. About
  139 of the requests were the four variables' value lists, read with `resourceValues` across every signal and
  partition. The maintainer chose to fix it in PR 3. The fix:
  - A generic values-source table (`registerValuesSource` in `scope.ts`). `src/viewer/cicd` registers the four CI keys,
    which answer from the widgets' shared cicd fetch.
  - The tests view reads its traces only once visible.
  - A scaling pin for the shipped config: `{cicdRows: 1}`, at most 5 requests.

  Result: 62 requests, 1.31 s, 60.8 fps.
- **No coupling.** Honours, the fixed scope and the "opens runs" flag are registered from `src/viewer/cicd`
  (`registerHonours`, `registerFixedScope`, `registerOpensRuns`). The generic page names no CI key.
- **Keyboard.** `menuTriggers` opens on Shift+F10 / ContextMenu. The status grid's run dots have a roving
  tabindex and respond to Enter and Space. The canvas views (runs, job trend) are one focusable element with
  Left/Right over runs.
- **The Jobs tab is dashboard-only.** It needs a `CiRun` from the cicd table, so the Traces explorer does not offer
  it. This is a known gap.
- **`measure:live` reports more.** It now reports the `cicd` byte share and the slider's frame rate. The Record
  (Task 25 Step 6) reads all three targets from one run.
