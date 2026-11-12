# Query Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A report's load time stops growing with the days it retains: every request the viewer can make is listed in
a catalogue with a measured cost class, small files load whole and in parallel, pruning follows statistics and time,
long windows are answered from rollup tables, and a report can open on a default window.

**Architecture:** A catalogue of every `DataSource` request lives next to the data layer; a harness builds small
reports with the real writer, runs each entry against a counting Node engine and asserts how its serial reads grow
with retention, density and window. The fixes then move entries out of the known-debt list one PR at a time: a
`prepare` seam on the query engine (small files), statistics and time bounds (pruning), format 5 with two rollup
tables written at cut, a router that answers long windows from rollups with a per-partition fallback to raw files,
and `viewer.defaultWindow`.

**Tech Stack:** TypeScript, DuckDB-WASM 1.32.0 (browser worker and Node worker), Parquet via the repository's wasm
codec, Mosaic SQL builders, vitest, Playwright, mise, bun scripts.

**Spec:** [../specs/2026-11-11-query-scaling-design.md](../specs/2026-11-11-query-scaling-design.md) (approved
2026-11-11). Section numbers below (§3.4, §9, …) are that document's.

**PR process:** unattended ([docs/agents/process-unattended.md](../../agents/process-unattended.md)). One PR per row,
in order; a PR starts from `main` after the previous one merged.

| #   | branch                       | PR title                                                               | closes | status |
| --- | ---------------------------- | ---------------------------------------------------------------------- | ------ | ------ |
| 1   | `test/query-catalogue`       | `test(query): query catalogue, scaling harness and baseline`           |        |        |
| 2   | `fix/test-span-times`        | `fix(test): test spans keep real times under a faked clock`            |        |        |
| 3   | `perf/small-site-files`      | `perf(viewer): small site files load whole and in parallel`            |        |        |
| 4   | `perf/pruning-statistics`    | `perf(query): statistics survive merges and reads follow the window`   | #272   |        |
| 5   | `feat/format-5`              | `feat(format): format 5 with rollup tables and the end-time statistic` |        |        |
| 6   | `perf/rollup-router`         | `perf(viewer): long windows are answered from rollups`                 | #271   |        |
| 7   | `perf/compaction-time-bound` | `perf(writer): compaction keeps files bounded in time`                 |        |        |
| 8   | `feat/default-window`        | `feat(viewer): viewer.defaultWindow and longer presets`                |        |        |
| 9   | `docs/query-scaling-record`  | `docs(plan): query-scaling record`                                     |        |        |

The status column is empty until a PR merges (`merged #N`) or is dropped (`dropped: <reason>`). PR 7 is conditional
(Task 24 decides); only PR 7 may be dropped. `/perf-1` finds the next PR by this table (§11 rule 3).

## Decisions this plan makes

The design leaves these to the builder. They are the plan author's calls, not the maintainer's; a task that finds one
of them wrong stops and says so instead of quietly choosing otherwise.

1. The catalogue lives in `src/viewer/data/catalogue.ts`: its entries are `DataSource` requests, and `src/query` must
   not import `src/viewer`.
2. The harness is `test-support/scaling/` with tests in `test/scaling/`, in the node vitest project and so part of
   `mise run check`. It is not tagged `@perf`. If it adds more than 30 s to `check` it moves to its own cached mise
   task that `check` depends on (Task 5 measures and decides).
3. Node-versus-Chromium tolerance (Task 1): per calibration statement, Node read calls and Chromium range GETs agree
   within ±10 % or ±2 requests, whichever is larger, and both give the same cost class. Otherwise the fallback of
   §3.3 applies (Task 1, step 6).
4. Prediction: each entry's serial requests are fitted to `a + R·(r + rd·G) + W·(w + wd·G)` (R partitions outside the
   window, W inside, G row groups per partition); a page's requests are recorded by rendering it against a recording
   `DataSource`.
5. Small files: `QueryEngine.prepare(paths)`; every file stays registered by URL, a prepared file's registration is
   swapped for a buffer. Threshold starts at 262,144 bytes (Task 9 tunes it).
6. Missing statistics (§5.1) are completed by one function in `src/format/parquet/stats.ts` that decodes the file's
   key columns, called wherever a file entry is built from an existing file.
7. Format 5: the in-memory type keeps the name `ManifestV4`, widened to `formatVersion: 4 | 5`; tables
   `span_rollups` and `log_rollups`; file-entry fields `timeEndMax` and `rollup`.
8. Duration buckets are computed with integers only (Task 15 gives the rule), so TypeScript and SQL agree exactly.
9. The rollup guard: no rollup file when `rollupRows > max(4096, baseRows / 8)`.
10. Per-partition fallback is one relation: rollup rows of the partitions that have a usable rollup `UNION ALL` the
    same shape grouped from the raw files of the others.
11. A run report created at format 4 keeps a format-4 manifest. PR 5's own CI report is missing until PR 5 merges,
    because the deployer on `main` still reads only format 4 (Task 17 confirms this is a recorded rejection, not a
    failed deploy).
12. `t=all` in the URL is an explicit "Entire run" when a default window is configured. `Selection.window` stays the
    effective window (null is the entire run) and `setWindow(null)` means the entire run wherever it is called.
13. Each side of the small-file threshold is measured by moving the threshold, not the data: classes are measured
    with every `traces`, `patterns` and rollup file under the harness threshold, and the entries that read those
    files are measured once more with the threshold at zero (Task 9).
14. Under a long window every aggregate need is built over one relation (rollup rows `UNION ALL` raw rows in the
    rollup's shape), also when nothing can come from a rollup, so a condition never changes how a number is
    computed (Task 21).
15. "approximate" is said once per page, in the time-range control, whenever the window is long; the trace panel's
    percentile line says it when the report's range is long (Task 23).
16. Attribute facets on request need no new request field: the existing `facetKeys` restriction is the mechanism
    (Task 23).
17. Grain-aligned buckets are carried by an `originNs` on the bucket series; the epoch and the relative times of a
    report do not change (Task 20).
18. The `rolling` shape is a snapshot of the live manifest taken the day Task 6 runs, and the model is checked
    against a page load measured that same day; the 2026-11-11 counts are cited for orientation only (Task 6).

## What each PR moves and is held to

Every PR: the declared classes of all catalogue entries are asserted by `test/scaling/classes.test.ts`; the
known-debt list may only shrink; `mise run predict:queries` is run and its totals pasted into the PR body next to the
expectation table's row (Task 6 writes that table at the end of this plan). **Stops** (§9): a prediction more than
20 % above its expectation row; an entry that misses the class this section names for the PR; a `src/` or build file
outside the PR's list below.

| PR  | entries it moves (ids from Task 4; `*` is a prefix)                                                                                                                                                                 | held to                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | none: it declares today's classes and files the debt                                                                                                                                                                | completeness test green; every `scan` has an allowed reason or a debt line with an issue; statement text of moved builders unchanged                |
| 2   | none                                                                                                                                                                                                                | a span started under a faked clock has a start time within 5 s of the real clock                                                                    |
| 3   | the debt lines of the small-file group → `files` on retention. Task 5 names the group by measurement: the entries whose growth on retention is only in files under the harness threshold (expected: `patterns`, `trace.has`, `trace.get`, `trace.share`, `trace.logs`, `log.get`). Entries with other growth too (`traces.list.*`) keep their lines for PRs 4 and 6 | no entry makes a serial read of a sub-threshold file (asserted for every catalogue entry); one e2e test asserts a small file is fetched whole exactly once |
| 4   | `spans.total.statkey.*`, `logs.timeline.statkey.*` on the `merged` shape → the classes they have on the plain shape; `trace.get`, `trace.share` → `matched` on density; `traces.list.all`, `traces.list.all.long` → `files` on every axis; new entries `resourceValues.short`/`.long` (their logs and points parts skip files outside the window; their spans part stays on #271's end-time debt line until PR 6) and `logs.total.*` (declared as measured) | #272's test: a run selection on a merged two-run report opens only that run's files |
| 5   | none (the rollups exist but nothing reads them); no entry may get worse                                                                                                                                             | format-4 reports open unchanged; rollup file < 2 % of its spans file on the measured partition; frozen `format-5` fixture; README table             |
| 6   | the long-window aggregates over rollup dimensions (`spans.total.long`, `spans.total.sortkey.long`, `spans.total.statkey.long`, `spans.buckets.long`, `spans.timeline.long`, `spans.facets.core.long`, `spans.groups.long`, `spans.services.long`, `spans.durations.long`, `logs.timeline.long`, `logs.timeline.statkey.long`, `logs.facets.core.long`, `logs.total.long`, `resourceValues.long`) → `fixed`/`fixed`/`files`; `percentile.long` → `files`/`fixed`/n.a.; `traces.list.long` → `files`×3; every windowed spans entry and `resourceValues.short` → `fixed` on retention (end-time pruning, Task 19) | equivalence test (rollup = raw = mix) on the edge data of §6; debt list holds no aggregate over rollup dimensions |
| 7   | the `compacted` generator shape: entries keep their classes when one partition is a compaction of many                                                                                                              | no file written by compaction spans more than 24 h unless a single input does                                                                       |
| 8   | none; the prediction for today's shape is taken with the 7-day window                                                                                                                                               | `#/dashboards/ci` predicted ≤ 150 serial range requests                                                                                             |
| 9   | none | live: `#/dashboards/ci` ≤ 150 serial range requests and ≤ 5 s; `#/traces?mode=traces` ≤ 5 s (§9). A miss is reported in the record with its cause; it is not a stop |

## Files each PR changes

The deployer builds and runs this code with a write token; the maintainer's approval of §10 point 1 covers exactly
what is listed here. Tests, `test-support/`, `e2e/`, `scripts/`, `docs/`, `fixtures/` and `README.md` are not
restricted. `(new)` marks a file the PR creates. No PR adds a dependency: `package.json` and `pnpm-lock.yaml` do not
change in any PR (a need for one is a stop).

- **PR 1** — `src/query/sql/logs.ts`, `src/query/sql/points.ts`, `src/query/sql/residual.ts` (new),
  `src/viewer/data/catalogue.ts` (new), `src/viewer/data/duckdb-source.ts`, `src/viewer/data/duckdb-metrics.ts`,
  `src/viewer/data/residual.ts`, `src/host/node-duckdb.ts`, `src/writer/session.ts`,
  `src/writer/partition-session.ts`, `src/writer/compaction.ts`, `src/writer/merge.ts`. `mise.toml`: a new task
  `predict:queries`; `test-support/scaling/**` and `test/scaling/**` added to the `sources` of the unit-test tasks if
  their globs do not already cover them; possibly a new cached task `test:scaling` (decision 2). Task 6a (the maintainer's
  decision of 2026-11-11): one step `- run: mise run test:scaling` in the `check` job of `.github/workflows/ci.yml`,
  nothing else under `.github/`. `src/model/gen/` or
  other generated files only as `mise run gen` rewrites them.
- **PR 2** — nothing under `src/`. No build file.
- **PR 3** — `src/viewer/data/query-engine.ts`, `src/viewer/data/mosaic.ts`, `src/viewer/data/duckdb-source.ts`,
  `src/viewer/data/duckdb-metrics.ts`, `src/viewer/data/open-report.ts`, `src/viewer/data/refresh-report.ts`, `src/viewer/data/query-common.ts`,
  `src/viewer/data/engine/files.ts`, `src/viewer/data/engine/start.ts`, `src/viewer/data/engine/small-files.ts` (new),
  `src/viewer/data/catalogue.ts`, `src/host/engine.ts` (the no-op `prepare`). No build file.
- **PR 4** — `src/format/parquet/stats.ts`, `src/cli/ci/run-report.ts`, `src/writer/partition-session.ts`,
  `src/writer/partition-checkpoint.ts`, `src/writer/compaction.ts`, `src/writer/merge.ts`, `src/query/sql/spans.ts`,
  `src/query/sql/logs.ts`, `src/viewer/data/data-source.ts`, `src/viewer/data/duckdb-source.ts`,
  `src/viewer/data/results.ts`, `src/viewer/data/log-results.ts`, `src/viewer/data/traced.ts`,
  `src/viewer/data/trace-detail.ts`, `src/viewer/data/catalogue.ts`, `src/viewer/dashboards/dashboard-page.tsx`,
  `src/viewer/dashboards/variables-bar.tsx`, `src/viewer/logs/explorer.tsx`, and any other file under `src/viewer/`
  that calls `resourceValues` or reads `LogNeed` (the type change forces them; list them in the PR body). No build
  file.
- **PR 5** — `src/format/manifest.ts`, `src/format/version.ts`, `src/format/paths.ts`, `src/format/state.ts`,
  `src/format/columns.ts`, `src/format/validate.ts`, `src/format/parquet/columns.ts`, `src/format/parquet/schema.ts`,
  `src/format/parquet/stats.ts`, `src/format/parquet/duration-bucket.ts` (new), `src/config/schema.ts`,
  `src/writer/rollup-rows.ts` (new), `src/writer/partition-writer.ts`, `src/writer/partition-session.ts`,
  `src/writer/partition-checkpoint.ts`, `src/writer/compaction.ts`, `src/writer/merge.ts`, `src/writer/upgrade.ts`,
  `src/writer/checkpoint.ts`, `src/writer/prune.ts`, `src/writer/rebase.ts`, `src/cli/ci/update.ts`,
  `src/cli/ci/push-update.ts`, `src/cli/ci/run-report.ts`, `src/cli/ci/deploy-apply.ts`, `src/cli/ci/deploy-plan.ts`,
  `src/cli/ci/site-main.ts`, `src/cli/ci/site.ts`, `src/cli/ci/publish-io.ts`, `src/query/sql/views.ts`,
  `src/query/sql/columns.ts`, `src/viewer/data/require-format4.ts`, `src/viewer/data/open-report.ts`,
  `src/viewer/data/refresh-report.ts`, `src/viewer/data/manifest-range.ts`, `src/viewer/data/engine/files.ts`,
  `src/host/manifest.ts`, `src/host/engine.ts`, `src/host/engine-files.ts`, and any file with a `Record<Table, …>`
  literal the two new tables force (the typecheck names them; list them in the PR body). Generated schema files as
  `mise run gen` rewrites them. No `mise.toml` change.
- **PR 6** — `src/query/sql/prune.ts`, `src/query/sql/filter.ts`, `src/query/sql/time.ts`, `src/query/sql/ottl.ts`,
  `src/query/sql/facets.ts`, `src/query/sql/spans.ts`, `src/query/sql/logs.ts`, `src/query/sql/rollup.ts` (new),
  `src/viewer/data/route.ts` (new), `src/viewer/data/duckdb-source.ts`, `src/viewer/data/time-window.ts`,
  `src/viewer/data/query-common.ts`, `src/viewer/data/catalogue.ts`, `src/viewer/data/data-source.ts`,
  `src/viewer/data/results.ts`, `src/viewer/data/span-results.ts`, `src/viewer/data/log-results.ts`,
  `src/viewer/data/traced.ts`, `src/viewer/data/trace-detail.ts`, `src/viewer/data/duckdb-metrics.ts`,
  `src/rollups/time-buckets.ts`, `src/viewer/dashboards/widgets/timeline.tsx`, `src/viewer/state/selection.ts`,
  `src/viewer/shell/shell.tsx`, `src/viewer/shell/time-range.tsx`, `src/viewer/traces/explorer.tsx`,
  `src/viewer/logs/explorer.tsx`, `src/viewer/components/facet-panel.tsx`,
  `src/viewer/components/histogram-card.tsx`, `src/viewer/traces/span-section.tsx`,
  `src/viewer/traces/trace-panel.tsx`. No build file.
- **PR 7** — `src/writer/compaction.ts`, `src/writer/partition-session.ts`, `src/viewer/data/catalogue.ts`. No build
  file.
- **PR 8** — `src/config/schema.ts`, `src/viewer/shell/shell.tsx`, `src/viewer/shell/time-range.tsx`,
  `src/viewer/state/selection.ts`, `src/viewer/state/url-state.ts`, `src/viewer/state/param-schemas.ts`,
  `src/viewer/state/carry.ts`, `src/viewer/dashboards/dashboard-page.tsx`, `src/viewer/metrics/catalog.tsx`,
  `src/viewer/data/time-window.ts`, `src/viewer/data/catalogue.ts`, `src/writer/inherit-config.ts`, generated schema files as `mise run gen` rewrites them; and one line,
  `  defaultWindow: 7d`, added under `viewer:` in `.github/otel-html-ci.yaml` and in
  `.github/actions/otel-html-publish/otel-html-ci.yaml` (§10 point 5). Nothing else under `.github/`.
- **PR 9** — nothing under `src/`. No build file.

## Global Constraints

- Conventions: [docs/agents/conventions.md](../../agents/conventions.md). TDD per task; no `any`, no non-null
  assertions; failures are typed `OtelHtmlError`s; `pnpm exec biome check .` and `mise run typecheck` before each
  commit; `mise run check` before each push; `mise run verify` before each PR; a new or changed mise task sets its
  `description` and runs `mise run gen`; a behaviour change updates the README in the same PR.
- Still stops under the unattended process: `release.yml`, `ci-report.yml`, `pages-deploy.yml`, the
  `otel-html-publish` and `otel-html-deploy` action definitions, and any `src/` or build file not listed above.
- No test in this plan asserts wall-clock time. Costs are read counts and bytes; the cost model's milliseconds are
  printed, never asserted. `@perf` tests run only in the perf pass and a budget is never loosened.
- Anti-goals (§2): no widget kind, dashboard name or `cicd.*` key appears in the router, the pruning code, the
  catalogue or the rollup dimensions' code path; an answer is a function of the request and the data alone (no cache
  whose content changes an answer).
- Rollup values (§6, verbatim): grain 2^16 ms = `65_536_000_000` ns on absolute time; a window is long at
  ≥ 256 grains = `16_777_216_000_000` ns; duration buckets of relative width 2^(1/8); zero and negative durations
  have their own bucket; dimensions are the core facets plus the report's `statisticsKeys`.
- All format-5 additions land in PR 5 and nowhere else; the code that writes format 5 reads it in the same PR;
  format 4 stays readable everywhere it is today.
- The known-debt list can only shrink after PR 1. A new request added by a task gets a catalogue entry in the same
  task. One exception, stated here: Task 12 gives `resourceValues` a window, so its entry becomes two
  (`resourceValues.short`, `.long`) and its debt lines are replaced by theirs on #271; `DEBT_MAX` may rise by that
  difference in that commit, and the PR body gives the number.
- Commits and PR bodies carry the session's attribution lines.

## Review Focus

1. A dashboard variable whose selected value has no data in the window stays selected and visible, not silently
   cleared (Task 12 pins it).
2. With a default window configured, choosing "Entire run" survives a reload and a shared link (Task 25 pins it).
3. A small file whose fetch fails or is aborted leaves the statement working by range reads and is fetched again
   later; two statements needing the same file fetch it once (Task 8 pins it).
4. A logs-only report, and a report with an empty table, under a long window answer empty results, not an error
   (Tasks 18 and 21 pin it).
5. Window boundaries: exactly 256 grains is long and one nanosecond less is short; aligning an aligned window changes
   nothing; no window on a range of exactly 256 grains follows the same rule (Task 20 pins it).

---

## PR 1: catalogue, harness, baseline

### Task 1: A counting Node engine, and whether it tracks Chromium

**Files:**

- Modify: `src/host/node-duckdb.ts` (`openNodeDuckDb` takes options), `src/writer/session.ts` (`WriterDeps.rowGroupRows`),
  `src/writer/partition-session.ts:254,901`, and the `rowGroupRows` reads in `src/writer/compaction.ts` and
  `src/writer/merge.ts`
- Create: `test-support/scaling/counting-engine.ts`, `test-support/scaling/cost.ts`,
  `test/scaling/counting-engine.test.ts`, `e2e/calibration.spec.ts`
- Modify: this plan (the "Calibration" section at its end)

**Interfaces:**

- Consumes: `openNodeDuckDb`, `NODE_FS_PROTOCOL`, `WORKER_SHIM` (`src/host/node-duckdb.ts`); `packageHostEngineFiles()`
  (`test-support/host-engine-files.ts`); `buildFormat4Report`, `writeReportDir` (`test-support/`); `viewStatements`;
  `mosaicQueryEngine(createCoordinator(connector, logger), files)` (`src/viewer/data/mosaic.ts`); `runWorkerSql`
  (`e2e/worker-sql.ts`); the static server's request log (`e2e/static-server.ts`, `RequestRecord`).
- Produces:

```ts
// src/host/node-duckdb.ts: `preamble` is JavaScript run in the worker before the shim; `workerData` is merged in.
export function openNodeDuckDb(
  files: HostEngineFiles,
  opts?: { preamble?: string; workerData?: Record<string, unknown>; transferList?: readonly MessagePort[] },
): Promise<NodeDuckDb>;

// src/writer/session.ts: tests only; production never sets it. Read as `deps.rowGroupRows ?? config.writer.rowGroupRows`.
interface WriterDeps { /* … */ rowGroupRows?: number }

// test-support/scaling/counting-engine.ts
export interface ReadEvent { path: string; kind: 'open' | 'read'; offset: number; bytes: number }
export interface CountingEngine {
  engine: QueryEngine;
  /** The events since the last take, complete: it round-trips a marker through the worker first. */
  take(): Promise<ReadEvent[]>;
  /** After it, the next statement reads every footer again (no cached metadata, no cached result). */
  cold(): Promise<void>;
  close(): Promise<void>;
}
export function openCountingEngine(dir: string, manifest: ManifestV4): Promise<CountingEngine>;

// test-support/scaling/cost.ts
export interface Cost { serial: number; parallel: number; bytes: number }
export const REQUESTS_PER_OPEN: number; // from the calibration
/** Reads of a path in `prepared` cost one parallel request of the file's size; all other events are serial. */
export function costOf(events: readonly ReadEvent[], prepared: ReadonlyMap<string, number>): Cost;
```

`path` in a `ReadEvent` is the manifest path (`partitions/000001/spans.parquet`), not the absolute one. The preamble
patches `fs.openSync`, `fs.readSync` and `fs.closeSync` and posts events over a `MessagePort` passed in `workerData`;
`openCountingEngine` does not use `startHostEngine` (its policy locks the configuration and its REST engine has no
temp tables).

- [ ] **Step 1: Write the failing tests** (`test/scaling/counting-engine.test.ts`)

```ts
test('a count over one file reads that file and no other', async () => {
  // report: two partitions (buildFormat4Report with two requests, close: false)
  await c.engine.query(Query.from('spans').select({ n: sql`count(*)` }).where(sql`filename = ${first}`));
  const paths = new Set((await c.take()).map((e) => e.path));
  expect([...paths]).toEqual([first]);
});
test('cold() makes a repeated statement cost the same again', async () => {
  const a = costOf(await run(), new Map());
  await c.cold();
  const b = costOf(await run(), new Map());
  expect(b).toEqual(a);
  expect(a.serial).toBeGreaterThan(0);
});
test('take() without cold() after a repeat shows the cache', async () => { /* second run: serial < first */ });
test('a path in `prepared` costs one parallel request of its size', () => {
  expect(costOf([open(p), read(p, 0, 8), read(p, 100, 50)], new Map([[p, 4096]]))).toEqual({ serial: 0, parallel: 1, bytes: 4096 });
});
test('WriterDeps.rowGroupRows overrides the configured size', async () => {
  // 2,000 spans with deps.rowGroupRows = 512 → parquet_metadata shows 4 row groups in the spans file
});
```

- [ ] **Step 2: Run them, expect failure.** `pnpm exec vitest run test/scaling/counting-engine.test.ts` → FAIL
      (`openCountingEngine` is not defined).
- [ ] **Step 3: Implement** the options on `openNodeDuckDb`, the `WriterDeps` override and the two `test-support`
      modules. Run the tests → PASS. Commit: `test(query): a Node engine that counts file reads`.
- [ ] **Step 4: Calibrate against Chromium.** `e2e/calibration.spec.ts`, tagged `@perf @http`, opens the site-format
      scale fixture (`mise run e2e:fixtures:scale`; if neither scale fixture is site-format with a spans file of at
      least 4 row groups, add one to `e2e/build-scale-fixtures.ts`), and for each statement below reloads the page,
      runs it with `runWorkerSql`, and reads from the request log the HEADs and range GETs per path. The same test
      opens the same directory with `openCountingEngine` and runs the same statements cold. Statements:
      1. `SELECT count(*) FROM spans`
      2. `SELECT count(*) FROM spans WHERE service_name = '<a value present in one file>'`
      3. `SELECT status_code, count(*) FROM spans WHERE start_time_unix_nano BETWEEN <lo> AND <hi> GROUP BY 1`
         (a tenth of the range)
      4. `SELECT * FROM spans WHERE trace_id = '<an id>'`
      5. `SELECT trace_id FROM traces ORDER BY start_time_unix_nano DESC LIMIT 50`

      It asserts decision 3's tolerance per statement: `|nodeReads·k − chromiumGets| ≤ max(2, 0.1·chromiumGets)` with
      one `k` and one `REQUESTS_PER_OPEN` for all five. Write both constants into `cost.ts`.
- [ ] **Step 5: Calibrate the small row groups.** Build three one-partition reports of 16 row groups each with
      `rowGroupRows` 512, 2,048 and 8,192 and one with 50,000 × 4; run statements 2 and 3 on each. Pick as
      `ROW_GROUP_ROWS` (exported from `cost.ts`) the smallest size whose serial count per row group is within ±10 % of
      the 50,000-row file's. Record requests per row group per statement.
- [ ] **Step 6: Record and decide.** Fill the "Calibration" section of this plan (table: statement, Node opens, Node
      reads, Chromium HEADs, Chromium GETs, within tolerance). If any statement is outside the tolerance, or no row
      group size passes step 5, the harness runs in Chromium instead (§3.3): `openCountingEngine` keeps its signature
      but sends SQL to the page's worker (`runWorkerSql` extended to return rows as Arrow IPC bytes) and `take()` reads
      the static server's request log; every `test/scaling/<x>.test.ts` named later is then
      `e2e/scaling/<x>.spec.ts`, run by `mise run test:e2e:chromium -- e2e/scaling` and by `verify`. Record that
      switch in the Calibration section and in §11 of the design in the same commit.
- [ ] **Step 7: Commit.** `test(query): Node read counts calibrated against Chromium range requests`

### Task 2: Every statement comes from a builder

**Files:**

- Modify: `src/query/sql/logs.ts`, `src/query/sql/points.ts`, `src/viewer/data/duckdb-source.ts:520-531`,
  `src/viewer/data/duckdb-metrics.ts` (`:180`, `:400`, `servicesQuery` at `:485`), `src/viewer/data/residual.ts:45-72`
- Create: `src/query/sql/residual.ts`
- Test: `test/query/sql/logs.test.ts`, `test/query/sql/points.test.ts`, `test/query/sql/residual.test.ts` (new)

**Interfaces:**

- Produces:

```ts
// src/query/sql/logs.ts
export function logsWithTraceCountQuery(f: SqlFilter): Query; // n: count(*) of whereOf(f,'logs') AND trace_id IS NOT NULL
// src/query/sql/points.ts
export function idTableSeriesQuery(table: string): Query;     // SELECT series_id FROM <table>
export function seriesIdsQuery(series: Query): Query;         // SELECT series_id FROM (<series>) s
export function seriesServicesQuery(series: Query, by: readonly ByExpr[]): Query; // today's servicesQuery, moved
// src/query/sql/residual.ts
export function idTableStatement(name: string, columns: readonly string[], types: readonly ('BIGINT' | 'VARCHAR')[]): string;
export function idTableRowsQuery(table: string, columns: readonly string[]): Query;
```

- [ ] **Step 1: Characterize first.** For each of the five statements, a test that captures today's SQL text from
      the existing call site (through `db.connector.requests` in the existing data-source tests) as an inline
      snapshot. Run → PASS before any move.
- [ ] **Step 2: Write the failing builder tests**: each new builder's `String(query)` equals the captured text. Run
      → FAIL (not defined).
- [ ] **Step 3: Move the statements** into the builders above; the call sites call them. If the scan of Task 4 would
      find any other `Query.from(`, `Query.select(`, `Query.with(` or `Query.union(` under `src/viewer/` or
      `src/host/`, move it the same way and name it in the commit message.
- [ ] **Step 4:** `pnpm exec vitest run test/query/sql test/viewer-data` → PASS, snapshots unchanged.
- [ ] **Step 5: Commit.** `refactor(query): every statement the data layer runs comes from a builder`

### Task 3: A deterministic report generator

**Files:**

- Create: `test-support/scaling/generator.ts`, `test/scaling/generator.test.ts`

**Interfaces:**

- Consumes: `WriterDeps.rowGroupRows`, `ROW_GROUP_ROWS` (Task 1); `createTestWriter`, `testConfig`, `otlp`
  (`test-support/writer-deps.ts`); `openSession`; `writeReportDir`.
- Produces:

```ts
export interface Shape {
  outside: number;   // partitions before the window (R)
  inside: number;    // partitions in the window (W)
  rowGroups: number; // spans row groups per partition (G)
  spacing: 'dense' | 'sparse'; // 20 min or 6 h between partition starts
}
export interface ScalingReport {
  dir: string; manifest: ManifestV4; epoch: bigint;
  /** From the first inside partition's first span to the last one's last span, in the viewer's window type. */
  window: TimeWindow;
  /** One existing value of each kind the catalogue's point reads and conditions need. */
  ids: { traceId: string; spanId: string; logRef: string; service: string; resource: string; runId: string; route: string; text: string; metric: string };
  close(): Promise<void>;
}
export function buildScalingReport(shape: Shape): Promise<ScalingReport>; // cached per shape for the test run
export const BASE: Shape; // { outside: 2, inside: 2, rowGroups: 2, spacing: 'dense' }
export function stepsOf(axis: Axis, spacing: Shape['spacing']): readonly Shape[]; // 3 steps, the other two axes at BASE
export const CROSS: Shape; // { outside: 4, inside: 2, rowGroups: 4 }: makes the model of Task 6 identifiable
```

Contents, per partition `n` (one flush each, `close: false`, config `writer.format: 'site'`,
`writer.statisticsKeys: ['resource:run.id']`): `rowGroups × ROW_GROUP_ROWS` spans in traces of 8, spread evenly over
10 minutes from `T0 + n × spacing`, each trace within one second and across both services; 2 services under one
scope name (so a service's slice of the file is 1, 2 and 4 row groups, ordered by time), 8 span names, every 16th span an error, resource attribute
`run.id = run-<n>`, span attribute `http.route` with 16 values; a quarter as many logs, half of them with a trace id,
4 severities, one body in 64 containing the word `needle`; 2 metrics × 4 series × 16 points. Everything derives from
`n` and the row index: no `Math.random`, no `Date.now`. Axis steps: retention `outside` 2, 4, 8; window `inside` 2,
4, 8; density `rowGroups` 2, 4, 8. Dense windows of up to 8 partitions are short (2 h 30 m); sparse windows of 2 or
more are long (≥ 6 h 10 m).

- [ ] **Step 1: Write the failing tests**

```ts
test('the same shape gives byte-identical files', async () => { /* two builds, sha256 of every file equal */ });
test('a partition has the row groups its shape asks for', async () => {
  // parquet_metadata of each spans file: BASE → 2 row groups, rowGroups: 8 → 8
});
test('dense windows are short and sparse windows are long', async () => {
  expect(widthNs((await buildScalingReport({ ...BASE, inside: 8 })).window)).toBeLessThan(16_777_216_000_000n);
  expect(widthNs((await buildScalingReport({ ...BASE, spacing: 'sparse' })).window)).toBeGreaterThanOrEqual(16_777_216_000_000n);
});
test('each partition records run.id in its statistics', async () => {
  // manifest.partitions[n].files.spans statistics value for 'resource:run.id' is exactly ['run-<n>']
});
test('ids name rows that exist', async () => { /* one count(*) per id > 0 */ });
```

- [ ] **Step 2:** `pnpm exec vitest run test/scaling/generator.test.ts` → FAIL. **Step 3:** implement. **Step 4:**
      → PASS. **Step 5: Commit.** `test(query): deterministic reports for the scaling harness`

### Task 4: The catalogue and its completeness test

**Files:**

- Create: `src/viewer/data/catalogue.ts`, `test/scaling/catalogue.test.ts`, `test/scaling/catalogue.test-d.ts`

**Interfaces:**

- Produces:

```ts
export type CostClass = 'fixed' | 'files' | 'matched' | 'scan';
export type Axis = 'retention' | 'density' | 'window';
export type Family = /* §3.1's eleven families, in the table's order, as a string union */;
export interface CatalogueContext { window: TimeWindow | null; ids: ScalingIds } // ScalingIds = ScalingReport['ids'], declared here
export interface CatalogueEntry {
  id: string;
  family: Family;
  method: keyof DataSource;
  needs?: readonly (SpanNeed | LogNeed)[];
  /** Exported names of the `src/query/sql/` builders this request runs, exactly. */
  builders: readonly string[];
  spacing: 'dense' | 'sparse';
  window: boolean; // false: the request carries no window and the window axis is n/a
  run(ds: DataSource, ctx: CatalogueContext): Promise<unknown>;
}
export const CATALOGUE: readonly CatalogueEntry[];
```

Entry ids (a method with a window gets `.short` = dense + window and `.long` = sparse + window; `.all` = dense, no
window; `.all.long` = sparse, no window). The completeness test may force more entries; none of these may be left
out:

| group             | ids                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| span aggregates   | `spans.total`, `spans.buckets`, `spans.timeline`, `spans.facets.core`, `spans.facets.attr`, `spans.groups`, `spans.durations`, `spans.services`, each `.short` and `.long`       |
| span conditions   | `spans.total.sortkey`, `spans.total.statkey`, `spans.total.attr`, `spans.total.text`, each `.short` and `.long`; `spans.total.traces.long`                                       |
| span rows         | `spans.rows.short`, `spans.rows.long`, `spans.rows.all`; `percentile.short` (dense), `percentile.long` (sparse)                                                                                                         |
| trace list        | `traces.list.all`, `traces.list.all.long`, `traces.list.short`, `traces.list.long`, `traces.list.statkey.long`, `traces.list.attr.long`                                          |
| point reads       | `trace.get`, `trace.share`, `trace.has`, `trace.logs`, `log.get`, `log.surrounding`                                                                                              |
| logs              | `logs.timeline`, `logs.facets.core`, `logs.facets.attr`, `logs.rows`, `logs.traces`, `logs.timeline.statkey`, each `.short` and `.long`; `logs.timeline.text.long`                                        |
| resource values   | `resourceValues.all`                                                                                                                                                             |
| patterns, metrics | `patterns`; `metrics.catalog`, `metrics.showOptions`, `metrics.query.short`, `metrics.query.long`, `metrics.runQuery`, `metrics.forResources`, `metrics.points`                  |

A `facets.core` entry asks the `facets` need with `facetKeys` set to the core keys; a `facets.attr` entry asks it with
`facetKeys: null` (core and attributes, as the pages do today).

Conditions use only the generator's keys: sort key `service.name = ids.service`, statistics key
`resource.run.id = ids.runId`, attribute `http.route = ids.route`, text `needle`. No `cicd.*` key.

- [ ] **Step 1: Write the failing tests**

```ts
// catalogue.test-d.ts: adding a DataSource method, a SpanNeed or a LogNeed without an entry fails the typecheck
type Covered = (typeof CATALOGUE)[number]['method'];
expectTypeOf<Exclude<keyof DataSource, 'close'>>().toEqualTypeOf<Covered>();
// catalogue.test.ts
test('every SpanNeed and LogNeed is asked by an entry', () => { /* over Record<SpanNeed, true> and Record<LogNeed, true> literals */ });
test('ids are unique and every id of the plan table exists', () => {});
test('every exported builder of src/query/sql is named by an entry', async () => {
  // import * of each src/query/sql/*.ts; exported functions whose name ends in Query or Statement ⊆ ∪ entry.builders
});
test('no statement is built outside src/query/sql', () => {
  // read every file under src/viewer and src/host: no match of /\bQuery\.(from|select|with|union)\(/
});
test('each entry runs exactly the builders it names', async () => {
  // vi.mock each src/query/sql module with a recording wrapper; run the entry on BASE; recorded set equals entry.builders
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** write the catalogue. **Step 4:** `pnpm exec vitest run test/scaling` and
      `mise run typecheck` → PASS. **Step 5: Commit.** `test(query): the catalogue of every request the viewer makes`

### Task 5: Measured classes, the classifier and the known debt

**Files:**

- Create: `test-support/scaling/measure.ts`, `test-support/scaling/classify.ts`, `test/scaling/classify.test.ts`,
  `test/scaling/classes.test.ts`
- Modify: `src/viewer/data/catalogue.ts` (`DECLARED`, `KNOWN_DEBT`)

**Interfaces:**

- Consumes: Tasks 1, 3, 4.
- Produces:

```ts
// test-support/scaling/measure.ts
export function measureEntry(entry: CatalogueEntry, shape: Shape): Promise<Cost>; // report of that shape, cold, run, costOf
// test-support/scaling/classify.ts
/** `reference`: the serial count of the entry's unconditioned sibling (`Declared.scanOf`) at the same step; its own when it has none. */
export interface Step { partitions: number; selectedGroups: number; neededGroups: number; reference: number; cost: Cost }
export const FILES_PER_PARTITION = 3;
export function classify(steps: readonly Step[]): CostClass;
// src/viewer/data/catalogue.ts
export interface Declared {
  class: Record<Axis, CostClass | null>;            // null: the axis does not apply
  /** Why a `scan` on this axis is right (§3.4's "scan allowed"), in a sentence. */
  allowed?: Partial<Record<Axis, string>>;
  /** Row groups that hold rows the request must read; default: every row group of the selected partitions. */
  needed?: (shape: { outside: number; inside: number; rowGroups: number }) => number;
  /** The id of the same request without its condition; what `matched` is measured against. */
  scanOf?: string;
}
export const DECLARED: Record<string, Declared>;     // one line per CATALOGUE id
export interface DebtLine { id: string; axis: Axis; issue: number; pr: number; target: CostClass; measured: boolean }
export const KNOWN_DEBT: readonly DebtLine[];
```

`classify` returns the best class the steps satisfy:

| class     | rule over the axis's three steps                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixed`   | `serial` and `parallel` equal at every step, and `bytes` at the last step within 10 % of the first                                                            |
| `files`   | `serial` equal at every step; `parallel` grows by at most `FILES_PER_PARTITION` per added partition; `bytes` may grow (whole files that got larger)           |
| `matched` | with Δ = last step − first step: `ΔneededGroups < ΔselectedGroups` and `Δserial ≤ max(2, 1.25 × ΔneededGroups / ΔselectedGroups × Δreference)`               |
| `scan`    | anything else                                                                                                                                                 |

- [ ] **Step 1: Write the failing tests**

```ts
// classify.test.ts: one synthetic step series per class, plus
test('serial growth of one request per step is not fixed', () => {});
test('a matched series whose needed groups grow as fast as the selected ones is scan', () => {});
// classes.test.ts
test.each(CATALOGUE)('$id measures the class it declares', async (entry) => {
  for (const axis of AXES) {
    const declared = DECLARED[entry.id].class[axis];
    if (declared === null) continue;
    expect(classify(await stepsFor(entry, axis))).toBe(declared);
  }
});
test('every scan is allowed or owed', () => {
  // class 'scan' on an axis ⇒ allowed[axis] is a sentence, or a KNOWN_DEBT line { id, axis, measured: true }
});
test('a debt line names a scan, an open issue number and a PR of the plan table', () => {
  // measured line ⇒ DECLARED says 'scan' on that axis and no `allowed` for it; 3 ≤ pr ≤ 8; issue > 0
});
test('the debt list has not grown', () => { expect(KNOWN_DEBT.length).toBeLessThanOrEqual(DEBT_MAX); });
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement `measure.ts` and `classify.ts`; print (do not assert) one table
      of entry × axis × measured class with `OTEL_HTML_SCALING_PRINT=1`.
- [ ] **Step 4: Declare what is measured.** Fill `DECLARED` from the printed table. For each `scan`: if §3.4 allows
      it (aggregates under a short window on density and window; attribute, text and distinct-trace aggregates on
      density and window; `trace.logs` on density) write the `allowed` sentence; otherwise it is debt. Entries §3.4
      leaves to the baseline (`trace.has`, `log.get`, `log.surrounding`, span and log rows, metrics) are declared as
      measured and get a debt line only if they are `scan` on retention with a window.
- [ ] **Step 5: File the debt.** One issue per group, reusing an open one that already describes it (read #271,
      #272, #273 first): small files read serially (PR 3: the entries whose serial growth on retention is only in
      files under `HARNESS_SMALL_FILE_BYTES`; `measure.ts` prints serial reads split by that size); a spans file
      that lies wholly before the window is still opened, because no statistic says when its spans end, #271
      (PR 6, Task 19: every windowed spans entry on retention); `resourceValues` ignores the window, the trace
      list reads `spans` when it has no condition, logs have no count need (PR 4); statistics lost in a merge,
      #272 (PR 4, `measured: false` until Task 10 adds the `merged` shape); long-window aggregates scan raw files,
      #271 (PR 6); compaction makes files unbounded in time (PR 7, `measured: false` until Task 24). Set
      `DEBT_MAX` (in the test) to the list's length; a PR that removes lines lowers it.
- [ ] **Step 6:** `pnpm exec vitest run test/scaling` → PASS. Time `mise run check` before and after this PR on a
      cold cache and write both in the PR body; over 30 s added → move `test/scaling` to a cached task
      `test:scaling` that `check` depends on (decision 2), `mise run gen`.
- [ ] **Step 7: Commit.** `test(query): measured cost classes and the known-debt list`

### Task 6: Prediction for named report shapes

**Files:**

- Create: `test-support/scaling/recording-source.ts`, `test-support/scaling/model.ts`,
  `test-support/scaling/shapes/rolling.json`, `test/scaling/model.test.ts`,
  `test/viewer/scaling-pages.test.tsx`, `scripts/predict-queries.ts`
- Modify: `mise.toml` (task `predict:queries`), this plan ("Expectations")

**Interfaces:**

- Produces:

```ts
// recording-source.ts
export interface RecordedCall { method: keyof DataSource; needs: readonly string[]; window: 'none' | 'window'; condition: 'none' | 'sortkey' | 'statkey' | 'attr' | 'text' }
export function recordingDataSource(inner: DataSource, manifest: ManifestV4): { ds: DataSource; calls: RecordedCall[] };
/** One id per need of the call. `long`: whether the window (or, with none, the range) of the shape being predicted is long. */
export function entryIdsOf(call: RecordedCall, long: boolean): string[];
// model.ts
export interface Model { a: number; r: number; rd: number; w: number; wd: number } // serial = a + R·(r + rd·G) + W·(w + wd·G)
export function fitModel(points: readonly { shape: Shape; serial: number }[]): Model; // least squares over the axis steps and CROSS
export interface PartitionShape { rowGroups: number; inWindow: boolean; smallFiles: number }
export function predict(model: Model, partitions: readonly PartitionShape[]): number; // sums per partition
export const SERIAL_REQUEST_MS = 15; export const PARALLEL_BATCH_MS = 50; export const MS_PER_MB = 62;
```

`scripts/predict-queries.ts [--after <pr>] [--window none|7d] [--threshold <bytes>]` reads the recordings and
measurements that the tests write when `OTEL_HTML_SCALING_OUT=<dir>` is set, and prints, per page and per shape,
serial requests, parallel requests, megabytes and modelled milliseconds. A call maps to `spans.<need>.<short|long>`
or `logs.<need>.<short|long>` whatever its condition, except `total`, which has an entry per condition kind; a call
with an attribute or text condition keeps its entry's baseline model at every `--after` (no rollup answers it). The
script prints how many calls each rule mapped. Shapes: `rolling` (the snapshot file, taken from the live
`data/manifest.js` on the day this task runs, with a `takenAt` date: per partition its rows and bytes per table and
its time range; on 2026-11-11 the report held 15 partitions, 3,086,855 spans, 297,110 logs and 745 points), `30x150k`, `90x150k`, `30x1.5M` (runs × spans per run, one partition per
run a day apart, 50,000 rows per row group). `--after <pr>` replaces the model of every entry with a debt line for
that PR or an earlier one by its target class (`fixed`: `r = rd = w = wd = 0`; `files`: the same, with one parallel
request per small file; `matched`: `rd = wd = 0`). The mise task `predict:queries` runs the two test files with the
variable set and then the script; its `description` says it prints estimates and asserts nothing.

- [ ] **Step 1: Write the failing tests**

```ts
// model.test.ts
test('fitModel recovers a known model exactly', () => {
  const m = { a: 7, r: 1, rd: 0, w: 3, wd: 5 };
  expect(fitModel(points(m))).toEqual(m); // points on stepsOf(...) and CROSS
});
test('predict sums partitions of different sizes', () => {
  expect(predict({ a: 2, r: 1, rd: 0, w: 0, wd: 4 }, [out(3), inside(2), inside(5)])).toBe(2 + 1 + 8 + 20);
});
// scaling-pages.test.tsx: renders with the recording source over a BASE report
test.each(['#/dashboards/ci', '#/traces?mode=traces', '#/traces', '#/logs', '#/metrics'])('%s asks only catalogued requests', async (hash) => {
  // the ci dashboard is the shipped .github/otel-html-ci.yaml; wait for every widget to settle
  for (const id of calls.flatMap((c) => entryIdsOf(c, false))) expect(IDS).toContain(id); // IDS: the catalogue's ids
  expect(calls.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement the three modules and the script. **Step 4:** tests → PASS;
      `mise run predict:queries` prints a table; `mise run gen`.
- [ ] **Step 5: Check the model against the live report.** On the day the snapshot is taken, load
      `#/dashboards/ci` and `#/traces?mode=traces` of the live report once each, cold, in headless Chromium (a
      scratch Playwright script, not committed) and count the range requests (2026-11-11: 708 and about 1,000). The
      `rolling` prediction without `--after` must be within 25 % of those counts. If it is not, the model or the recording is wrong: find out which (compare one entry's prediction with a
      Chromium request count on the scale fixture) before going on. Still outside 25 % after that is a stop.
- [ ] **Step 6: Write the expectation table** into "Expectations" at the end of this plan: one row per `--after`
      value 1 (baseline), 3, 4, 6, 8 (8 with `--window 7d`), and per shape the serial requests of `#/dashboards/ci`
      and of `#/traces?mode=traces`. These rows are what §9's 20 % rule compares against from PR 3 on.
- [ ] **Step 7: Commit, then open PR 1.** `test(query): predicted requests for named report shapes`. PR body: the
      calibration table, the class table, the debt list with its issues, the expectation table, the `check` timing.

### Task 6a: The measurement runs in parallel and in CI

Added 2026-11-11 by the maintainer's decision during session B: the scaling measurement (`test:scaling`, 274 s
locally on one vitest worker) must run in CI, with no new job (CI already peaks at 19 of 20 concurrent jobs) and
without adding minutes to the pipeline's wall time (≈ 5 min on a pull request).

**Files:**

- Modify: `test-support/scaling/counting-engine.ts` (a spare worker), `test-support/scaling/measure.ts`,
  `test/scaling/classes.test.ts` (split), `mise.toml` (`test:scaling`'s `run` and `description`),
  `.github/workflows/ci.yml` (one step in the `check` job, nothing else)
- Create: one test file per axis and spacing under `test/scaling/` (e.g. `classes-retention-dense.test.ts`), or the
  equivalent split the implementer finds; the cheap declared-rules tests stay in one file in `test:unit:main`

- [ ] **Step 1: Measure the starting point.** `MISE_TASK_CACHE=off mise run test:scaling` wall time, and the share
      spent in `cold()` (the Task 5 report: 493 ms × 449 calls).
- [ ] **Step 2: A spare worker.** `cold()` swaps in a worker started in the background after the previous swap
      (views created, port wired), then starts the next spare; the events of the old worker are drained before the
      swap as today. A test: two `cold()` calls in a row each give a statement that reads every footer again, and
      `close()` terminates the spare too.
- [ ] **Step 3: Shapes in parallel.** Split the measured describe so vitest runs independent files in parallel
      workers: one file per axis and spacing (each measures its three step shapes; `BASE` is measured in more than one
      file, which is accepted). Every catalogue entry and applicable axis is still asserted exactly once; a test in
      the cheap file checks that the files' (entry, axis) pairs cover `DECLARED` exactly. `predict:queries` still gets
      its measurements (`OTEL_HTML_SCALING_OUT`), including `CROSS`.
- [ ] **Step 4: Measure again** with the same command; the target is ≤ 90 s locally. Print, never assert. Above
      120 s: stop and report the numbers before Step 5.
- [ ] **Step 5: CI.** In `.github/workflows/ci.yml`'s `check` job, one step `- run: mise run test:scaling` after
      `- run: mise run check:static`, with a one-line comment saying what it runs. No other workflow change.
      Update `test:scaling`'s `description` (the time, that CI's `check` job runs it) and AGENTS.md's loop row if
      the cost it states changed; `mise run gen`.
- [ ] **Step 6: Commit.** `test(query): the scaling measurement runs its shapes in parallel and in CI`. The PR body
      carries the before and after wall times, locally and of the `check` job on the PR's CI run.

### Task 6b: A page is predicted from the union of its entries' reads

Added 2026-11-11 by the maintainer's decision during session B, after Task 6's live check failed: the prediction
summed each entry's cold cost (2,533 / 4,672 serial requests against 891 / 1,064 live). A page runs in one engine,
so footers and bytes read by one request are free to the next. An experiment costing the union of a page's entries'
cold reads matched the one-engine page cost within 25 % on 6 of 10 page × shape cases, exactly on 3, and never
above; the miss was the trace list's service share over 52 distinct traces. The whole-branch review (Opus 5.5) found
defects in the per-entry model itself; this task fixes those too.

**Files:**

- Modify: `test-support/scaling/model.ts`, `test-support/scaling/measure.ts`, `test-support/scaling/recording-source.ts`,
  `scripts/predict-queries.ts`, `test/scaling/model.test.ts`, the measured test files of Task 6a (outputs only),
  `test/viewer/scaling-pages.test.tsx`; this plan ("Expectations"); §3.3 of the design (the prediction sentence)
- No `src/` file. No `mise.toml` change unless `predict:queries`'s description must say something new.

**The model:**

1. Each entry's cold read events are split per file into the **open** part (the open, and the footer read: the reads
   before the first data read, as Task 1's calibration identifies them) and the **data** part (the rest, costed
   with the read-ahead model). An entry records, per step shape, which files it opens, by role: table, and
   whether the partition is inside or outside the window.
2. The data part is fitted per entry as today, `a + R·(r + rd·G) + W·(w + wd·G)`, by **non-negative** least squares
   (every coefficient ≥ 0). For a `window: false` entry the fit is constrained to `r = w` and `rd = wd` (every
   partition is read alike).
3. A page's prediction for a shape = `REQUESTS_PER_OPEN + footer reads` once for every file in the **union** of the
   files its entries open (by table and partition role, scaled to the shape's partitions), plus the sum of its
   entries' data parts. A by-id call (`getTrace`, `serviceShare`, `hasTrace`, `traceLogs`, `getLog`,
   `surroundingLogs`) counts its data part once per **distinct id** the page asked; the recording source records
   the distinct ids per method.
4. `--after <pr>` acts **per axis**: a debt line for retention replaces `r, rd`; for window `w, wd`; for density
   the `G` terms (`rd, wd`), by the line's target (`fixed`: those coefficients 0; `matched`: the `G` terms 0;
   `files`: 0, plus one parallel request per small file of the partitions read). The open part follows the same rule
   by the files an improved entry stops opening (an entry `fixed` on retention opens no outside partition).
5. Density is fitted with one more step than the class steps: a `rowGroups: 16` shape (dense, `outside` and
   `inside` at BASE), measured only when `OTEL_HTML_SCALING_OUT` is set (the `predict:queries` run), so
   `test:scaling` does not grow.

- [ ] **Step 1: Failing tests** (`test/scaling/model.test.ts`): non-negative fit recovers a known non-negative model
      and never returns a negative coefficient on data that would pull one below zero; a `window: false` fit gives
      `r = w`, `rd = wd`; the union counts a file opened by two entries once; a by-id entry asked for 3 distinct ids
      costs 3 data parts and its files' opens once; `--after` with a retention line leaves `w, wd` unchanged.
- [ ] **Step 2: Implement** the split, the fit, the union and the per-axis `--after`.
- [ ] **Step 3: Check against one engine.** A test (counts, not time) renders each of the five pages on `BASE`,
      `CROSS` and the `rowGroups: 16` shape in one counting engine and asserts the prediction is within 25 % of the
      measured page cost. If a page misses, find whether the union, the per-id rule or the fit is wrong before going
      on; still outside after that is a stop.
- [ ] **Step 4: Live check, again.** The same day, refresh `shapes/rolling.json` from the live manifest and count
      the live `#/dashboards/ci` and `#/traces?mode=traces` range requests in headless Chromium (scratch script,
      not committed), as Task 6 step 5. The `rolling` baseline must be within 25 % of both counts. Outside: a stop,
      reported with both counts, the prediction and the diagnosis; no constant is tuned to hit the number.
- [ ] **Step 5: The expectation table.** Rewrite "Expectations (Task 6)" from `mise run predict:queries` (rows 1, 3,
      4, 6, 8 with `--window 7d`); remove the "not yet usable" note. Update §3.3 of the design: the page prediction is
      the union of its entries' opens plus the sum of their data parts, by-id calls once per distinct id.
- [ ] **Step 6: Commit.** `test(query): a page is predicted from the union of its entries' reads`. The PR body
      carries the one-engine comparison table, the live check and the new expectation table.

Status: stopped 2026-11-12 at 36236691 (see Task 6c); the code stays, its page model is replaced.

### Task 6c: A page is predicted from its own measurements

Added 2026-11-12 by the maintainer's decision, after Task 6b stopped (36236691). Task 6b counted a page's opens once
but still summed its entries' data parts. In one engine DuckDB's cache makes the reads one entry shares with another
free: the CI page's data parts alone sum to 121 requests where the whole page costs 61. Its prediction was 1.3–3.8×
the one-engine page on all 15 cases, and live 1.49× (CI dashboard) and 0.69× (traces mode). The traces-mode page
also asks for 52 distinct traces live but 26 in the generated report, because the generated window holds fewer
traces than the list's 50 rows. This task measures each page whole instead of composing it from entries.

**Files:**

- Modify: `test-support/scaling/model.ts`, `test-support/scaling/measure.ts`, `test-support/scaling/generator.ts`
  (the trace count, if needed), `scripts/predict-queries.ts`, `test/scaling/model.test.ts`,
  `test/viewer/scaling-pages.test.tsx`; this plan ("Expectations"); §3.3 of the design (the prediction sentence)
- Keep from Task 6b what still serves: the non-negative fit, the `window: false` constraint and the per-entry fits
  (`--after` uses them). Remove what only served the summed page model (the union of opens, per-id data counting)
  unless this task uses it.
- No `src/` file. `mise.toml` only for `predict:queries`'s description.

**The model:**

1. A page's cost (serial requests, parallel requests and bytes) is measured by rendering the page in one cold
   counting engine, as Task 6b's one-engine check does, at the class steps of each axis (retention, window,
   density with the `rowGroups: 16` step) on the dense and sparse shapes.
2. Every measured shape holds at least as many traces in the page window as the longest list a page shows
   (50 rows), so the distinct ids a page asks for match a full report. If the generator cannot do that at a shape,
   it grows the shape's trace count, not the list.
3. Each page's cost is fitted per axis with the per-entry form, `a + R·(r + rd·G) + W·(w + wd·G)`, by non-negative
   least squares. The prediction for a named shape is that fit.
4. `--after <pr>` scales each axis term of a page by the share of that term its entries without a debt line for
   that PR carry. The shares come from the per-entry fits of the page's entries. An entry `fixed` on an axis
   contributes 0 to the term; `matched` keeps its non-`G` part; `files` adds one parallel request per small file.
6. Added 2026-11-12 after the first live check (0.46× and 0.32×): the generator's trace ids are random, as real
   ones are, so a lookup by id is not pruned to one partition by min/max statistics. The page test renders at the
   live check's viewport height, so a list asks for as many ids as live. Entries whose class changes get their
   catalogue class and `KNOWN_DEBT` lines; a lookup by trace id that reads every partition is owed by Task 11
   (PR 4).
7. Added 2026-11-12 after the second live check (0.51× and 0.33×): the density axis of the page fit is measured on
   row groups of production size (50,000 rows, the writer's default), 1 to 4 per partition, because a live group's
   larger column chunks cost more requests than a harness group's. The class steps keep their small groups. The
   live traces-mode page asks for 52 distinct traces while 26 rows mount; the second 26 are found from a Chromium
   request log and modelled in the page measurement.
5. Measuring pages runs only when `OTEL_HTML_SCALING_OUT` is set (the `predict:queries` run), so `test:scaling`
   does not grow.

- [ ] **Step 1: Failing tests** (`test/scaling/model.test.ts`): a page fit recovers a known non-negative model from
      page points; `--after` with a retention line on an entry carrying half a page's `r` halves the page's `r`
      and leaves `w, wd` unchanged; a shape in the generator holds at least 50 traces in the window.
- [ ] **Step 2: Implement** the page measurements, the page fit and `--after` by entry shares.
- [ ] **Step 3: Check against one engine.** The fit must reproduce each page at `BASE`, `CROSS` and the
      `rowGroups: 16` shape within 25 %. `CROSS` is left out of the fit, so it tests how the fit extrapolates
      across axes.
- [ ] **Step 4: Live check, again.** As Task 6b step 4: refresh `shapes/rolling.json` the same day, count the live
      `#/dashboards/ci` and `#/traces?mode=traces` requests in headless Chromium (Range GETs plus HEADs). The
      `rolling` prediction must be within 25 % of both. Outside: a stop, reported with both counts, the prediction
      and the diagnosis; no constant is tuned to hit the number.
- [ ] **Step 5: The expectation table**, as Task 6b step 5; §3.3 of the design says a page is predicted from its own
      measurements fitted per axis, and a later PR's effect from its entries' shares.
- [ ] **Step 6: Commit.** `test(query): a page is predicted from its own measurements`. The PR body carries the
      one-engine table, the live check and the new expectation table.

## PR 2: test spans keep real times

### Task 7: The test SDK stamps spans from the real clock

**Files:**

- Modify: `test-support/otel/sdk.ts` (and a sibling module for the clock if it reads better)
- Test: `test/test-support/otel-sdk-clock.test.ts`

**Interfaces:**

- Produces: `startTestSdk(...)`'s `tracer` and `record` unchanged in type; a span's start and end are taken from a
  clock captured at module load (`Date.now` and `performance.now` bound before any test can fake them) and passed as
  explicit `startTime` and `endTime`.

- [ ] **Step 1: Root cause first.** In the newest run trace of `https://bjstabi.github.io/otel-html/branch/main/`
      (or a local `otel-html run` of `test/viewer/shortcuts.test.ts`, run directly, not through `mise run`), find the
      spans whose times are outside their run and name the code path that stamped them (the SDK's default clock, the
      vitest reporter, or `record`). Write it in the PR body. Fix that path; the test below must fail for that reason.
- [ ] **Step 2: Write the failing test**

```ts
test('a span started and ended under a faked clock keeps real times', async () => {
  const before = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2001-01-01T00:00:00Z'));
  const span = sdk.tracer.startSpan('faked');
  vi.advanceTimersByTime(86_400_000);
  span.end();
  vi.useRealTimers();
  const [s] = exported();
  expect(ms(s.startTime)).toBeGreaterThanOrEqual(before - 5);
  expect(ms(s.endTime)).toBeGreaterThanOrEqual(ms(s.startTime));
  expect(ms(s.endTime) - before).toBeLessThan(5_000);
});
test('a child span under a faked clock starts inside its parent', async () => {});
```

- [ ] **Step 3:** `pnpm exec vitest run test/test-support/otel-sdk-clock.test.ts` → FAIL (year 2001). **Step 4:**
      implement. **Step 5:** → PASS; `mise run check`.
- [ ] **Step 6: Commit and open PR 2.** `fix(test): test spans keep real times under a faked clock`. After it
      merges, check one run on `main`: no trace in `#/traces?mode=traces` starts before its run. Note the result in
      the PR as a comment.

## PR 3: small files whole and in parallel

### Task 8: `prepare` on the query engine, and the site's small-file loader

**Files:**

- Create: `src/viewer/data/engine/small-files.ts`, `test/viewer-data/engine-small-files.test.ts`
- Modify: `src/viewer/data/query-engine.ts`, `src/viewer/data/mosaic.ts`, `src/viewer/data/engine/files.ts`,
  `src/viewer/data/engine/start.ts`, `src/viewer/data/open-report.ts`, `src/viewer/data/refresh-report.ts`,
  `test-support/duckdb-node.ts`

**Interfaces:**

- Produces:

```ts
// query-engine.ts
interface QueryEngine {
  /** Makes these files cheap to read before a statement that reads them. Resolves even when a file could not be fetched. */
  prepare(paths: readonly string[], signal?: AbortSignal): Promise<void>;
}
// engine/small-files.ts
export const SMALL_FILE_BYTES = 262_144;
export interface SmallFiles { prepare(paths: readonly string[], signal?: AbortSignal): Promise<void>; forget(paths: readonly string[]): void }
export function smallFiles(deps: {
  bytesOf(path: string): number | undefined;              // the manifest's size
  fetchWhole(path: string): Promise<Uint8Array>;          // one GET without a Range header
  swap(path: string, bytes: Uint8Array): Promise<void>;   // replace the URL registration by a buffer
  threshold?: number;                                     // default SMALL_FILE_BYTES
  concurrency?: number;                                   // default 6
}): SmallFiles;
// engine/files.ts
export function swapToBuffer(engine: Engine, path: string, bytes: Uint8Array): Promise<void>;
```

`mosaicQueryEngine` takes an optional `prepare`; without one (local reports, tests) and in `restQueryEngine` it is a
no-op. A site report registers every file by URL at open exactly as today, so a path that was never prepared still
answers by range reads. `dropFiles` and Refresh call `forget` for the paths they drop.

- [ ] **Step 1: Write the failing tests**

```ts
test('a file of exactly 262,144 bytes is fetched whole; one byte more is not', async () => {});
test('two prepares that share a file fetch it once', async () => {
  await Promise.all([s.prepare(['a', 'b']), s.prepare(['b', 'c'])]);
  expect(fetched).toEqual(['a', 'b', 'c']); // any order, each once
});
test('a prepared file is not fetched again', async () => {});
test('a failed fetch resolves, swaps nothing, and is retried by the next prepare', async () => {
  fail.add('a');
  await expect(s.prepare(['a'])).resolves.toBeUndefined();
  expect(swapped).toEqual([]);
  fail.clear();
  await s.prepare(['a']);
  expect(swapped).toEqual(['a']);
});
test('one caller aborting does not fail another caller waiting on the same file', async () => {});
test('an aborted prepare rejects with AbortError and leaves the file retryable', async () => {});
test('no more than `concurrency` fetches run at once', async () => {});
test('forget makes the next prepare fetch and swap again', async () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement `smallFiles`, `swapToBuffer` (`dropFile` then
      `registerFileBuffer`) and the wiring. **Step 4:** → PASS.
- [ ] **Step 5: Prove the swap in Chromium.** `e2e/small-files.spec.ts` (first test tagged `@http`): on a site
      fixture, `SELECT count(*) FROM traces` through `runWorkerSql` before any prepare (range reads), then open
      `#/traces?mode=traces` (which prepares), then the same count again: same answer, no engine error. If the engine
      rejects or misreads a file swapped after it was opened, stop and report: the alternatives (buffers decided at
      open, or a second file name per small file) change §4.
- [ ] **Step 6: Commit.** `perf(viewer): the query engine can load small site files whole`

### Task 9: The data layer prepares what each statement reads

**Files:**

- Modify: `src/viewer/data/query-common.ts`, `src/viewer/data/duckdb-source.ts`, `src/viewer/data/duckdb-metrics.ts`,
  `src/viewer/data/catalogue.ts`, `test-support/scaling/counting-engine.ts`, `test-support/scaling/measure.ts`,
  `e2e/small-files.spec.ts`, `README.md`

**Interfaces:**

- Consumes: `QueryEngine.prepare`, `smallFiles` (Task 8); `SqlFilter.files`, `tableFiles(manifest, table, resolve)`.
- Produces:

```ts
// query-common.ts: the one way the data layer runs a statement
export function runPrepared(engine: QueryEngine, q: Query, files: readonly string[], signal?: AbortSignal): Promise<Table>;
/** The files a statement over `tables` reads: the filter's pruned list, or every file of the tables. */
export function filesFor(manifest: ManifestV4, tables: readonly Table[], pruned?: Pruned): readonly string[];
// counting-engine.ts
interface CountingEngine { /** Paths prepared since the last take, with their sizes. */ prepared(): ReadonlyMap<string, number> }
/** Above the generator's largest traces, patterns and rollup file (8 row groups), below its smallest spans and logs file (2 row groups). */
export const HARNESS_SMALL_FILE_BYTES: number;
// measure.ts
export function measureEntry(entry: CatalogueEntry, shape: Shape, opts?: { threshold?: number }): Promise<Cost>;
// catalogue.ts, in Declared: for an entry that reads traces, patterns or rollup files. Measured at the densest step with
// threshold 0 (every file by range): serial ≤ REQUESTS_PER_OPEN × files + perRowGroup × the row groups of those files.
aboveThreshold?: { perRowGroup: number };
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/viewer-data/duckdb-source-spans.test.ts
test('a trace list prepares the traces files of the pruned partitions and nothing else', async () => {
  // engine wrapper records prepare(); window covering partition 2 of 3 → prepare lists only partition 2's files
});
test('no statement runs before its prepare resolved', async () => {});
// test/scaling/classes.test.ts
test.each(CATALOGUE)('$id makes no serial read of a file under the threshold', async (entry) => {});
test.each(SMALL_TABLE_ENTRIES)('$id above the threshold stays within its stated factor', async (entry) => {}); // Declared.aboveThreshold, 2 per row group
// and: delete the small-file debt lines and declare those entries 'files' on retention → FAIL today
// e2e/small-files.spec.ts
test('each small traces file is fetched whole at most once and never by range afterwards', async () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** route every `engine.query` of the two data-source files through
      `runPrepared`; the counting engine's `prepare` runs the same `smallFiles` with `HARNESS_SMALL_FILE_BYTES`.
      **Step 4:** unit and scaling tests → PASS; lower `DEBT_MAX` to the new length. If the generator's logs
      files are not all above the threshold, raise its log count (Task 3's "a quarter as many") until they are.
      Points files are under it at every step, as on the live report.
- [ ] **Step 5: Tune the threshold.** `mise run predict:queries -- --threshold <n>` for 131,072, 262,144, 524,288
      and 1,048,576 on the `rolling` shape. Keep 262,144 unless another value's modelled time for the dashboard plus
      the trace list is at least 10 % lower; put the four rows in the PR body.
- [ ] **Step 6:** README: one paragraph under the site format on small files; `mise run verify`; prediction against
      the "after 3" row. **Commit and open PR 3.**

## PR 4: pruning

### Task 10: Statistics survive merges (#272)

**Files:**

- Modify: `src/format/parquet/stats.ts`, `src/cli/ci/run-report.ts` (`entryFrom`, `:108-127`),
  `src/writer/partition-session.ts` (`#copyPartition`, `:817-860`), `src/writer/partition-checkpoint.ts` (`withKeys`,
  `:61-71`), `src/writer/compaction.ts` (`StatisticsFold`, `keepUnknown`), `src/writer/merge.ts`,
  `test-support/scaling/generator.ts`, `src/viewer/data/catalogue.ts`
- Test: `test/format/parquet/stats.test.ts`, `test/cli/ci/run-report.test.ts`, `test/scaling/classes.test.ts`

**Interfaces:**

- Produces:

```ts
// stats.ts: values already recorded are kept; a key the entry lacks is computed by decoding that key's column of the file.
// A key stays null only when its distinct values exceed the cap fileStatistics already applies.
export function completeStatistics(table: Table, entry: PartitionFile, keys: readonly string[], read: () => Promise<Uint8Array>): Promise<PartitionFile>;
// generator.ts
interface Shape { /** Each partition is written as a run report and merged the way the deployer merges. */ merged?: boolean }
```

- [ ] **Step 1: Root cause first** (superpowers:systematic-debugging). Reproduce #272 in a test: two run reports
      with `writer.statisticsKeys: ['resource:run.id']` and different `run.id`, merged through the code the deployer
      runs. Find which of the four places listed under Files writes the null (or whether the run's own writer never
      recorded the key because its config lacked it), and say so in the PR body. The fix goes where the value is
      lost; `completeStatistics` is for a file that arrives without the key.
- [ ] **Step 2: Write the failing tests**

```ts
test('#272: after a merge of two runs, a run selection opens only that run’s files', async () => {
  const pruned = prunePartitions(merged.manifest, conditionOf(`resource.run.id = "run-a"`));
  expect(new Set(pruned.files.map(partitionOf))).toEqual(new Set([partitionOfRunA]));
  // every table whose statisticsKeysFor keeps the key; `traces` has no resource column and is not one
  for (const t of ['spans', 'logs', 'points'] as const) expect(valuesOf(merged.manifest, runA, t, 'resource:run.id')).toEqual(['run-a']);
});
test('completeStatistics computes a missing key from the file and keeps recorded ones', async () => {});
test('completeStatistics leaves a key null when its values exceed the cap', async () => {});
test('a key that only one of two compacted files knows is computed for the other, not dropped', async () => {});
// classes.test.ts: on stepsOf(axis) with merged: true, spans.total.statkey.* and logs.timeline.statkey.* measure what DECLARED says
```

- [ ] **Step 3:** run → FAIL for the reason of step 1. **Step 4:** fix. **Step 5:** → PASS; delete #272's debt line.
- [ ] **Step 6: Commit.** `fix(writer): file statistics survive merges and copies`

### Task 11: Span reads by trace id carry the trace's time bound

**Files:**

- Modify: `src/query/sql/spans.ts`, `src/viewer/data/duckdb-source.ts` (`getTrace`, `serviceShare`),
  `src/viewer/data/trace-detail.ts`, `src/viewer/data/catalogue.ts`
- Test: `test/query/sql/spans.test.ts`, `test/viewer-data/duckdb-source-spans.test.ts`

**Interfaces:**

- Produces: `traceSpansQuery(traceId: string, files: readonly string[], epoch: bigint, bound?: { startNs: bigint; endNs: bigint } | null): Query`
  adds `start_time_unix_nano BETWEEN <startNs> AND <endNs>` when a bound is given. The bound is the minimum start and
  maximum end over the trace's `traces` rows (the statement `getTrace` already runs); a null on either side means no
  bound. The share statement takes the same parameter. `traceLogs` gets none (§5.2).

- [ ] **Step 1: Write the failing tests**

```ts
test('the span statement of a trace is bounded by the trace’s start and end', () => {
  expect(String(traceSpansQuery(id, files, 0n, { startNs: 10n, endNs: 20n }))).toContain('BETWEEN 10 AND 20');
});
test('a zero-length span starting exactly at the trace’s end is returned', async () => {});
test('a trace split over two partitions returns the spans of both', async () => {});
test('a trace whose summary has no start (logs only) reads without a bound', async () => {});
// classes: trace.get and trace.share declare { retention: 'files', density: 'matched', window: null }, needed: () => 2
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS. If `trace.get` does not measure `matched` on
      density, that is the stop of "What each PR moves": report the measured step series.
- [ ] **Step 5: Commit.** `perf(query): span reads by trace id are bounded in time`

### Task 12: `resourceValues` takes the window

**Files:**

- Modify: `src/viewer/data/data-source.ts`, `src/viewer/data/duckdb-source.ts:779`, `src/viewer/data/traced.ts`,
  `src/viewer/dashboards/dashboard-page.tsx:259`, `src/viewer/dashboards/variables-bar.tsx`,
  `src/viewer/data/catalogue.ts`
- Test: `test/viewer-data/duckdb-source-spans.test.ts`, `test/viewer/dashboards/` (the page's test file)

**Interfaces:**

- Produces: `resourceValues(key: string, opts: { window: TimeWindow | null }, signal?: AbortSignal): Promise<ResourceValues>`.
  The window prunes partitions and filters rows like any other request. Catalogue: `resourceValues.short` and
  `resourceValues.long` are added; `resourceValues.all` stays.

- [ ] **Step 1: Write the failing tests**

```ts
test('values outside the window are not listed and their partitions are not read', async () => {});
test('the dashboard passes its window and asks again when the window changes', async () => {});
test('a selected value with no data in the window stays selected and is shown in the list', async () => {
  // variable run.id = run-a selected; window covers only run-b
  expect(screen.getByRole('combobox', { name: /run\.id/ })).toHaveValue('run-a');
  expect(optionTexts()).toEqual(expect.arrayContaining(['run-a', 'run-b']));
  expect(location.hash).toContain('run-a');
});
// a windowed call opens no logs or points file that lies outside the window (the counting engine's opens)
// classes: resourceValues.short and .long are declared as measured; their retention debt is #271's end-time line (PR 6)
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS; the `resourceValues` debt lines are
      replaced by the lines the two new entries measure, on #271 with PR 6 (the exception of Global Constraints).
      **Step 5: Commit.**
      `perf(viewer): dashboard variables read only the window`

### Task 13: The unconditioned trace list reads `traces` alone; logs get a count need

**Files:**

- Modify: `src/query/sql/spans.ts`, `src/query/sql/logs.ts`, `src/viewer/data/data-source.ts` (`LogNeed`),
  `src/viewer/data/duckdb-source.ts`, `src/viewer/data/log-results.ts`, `src/viewer/data/results.ts`,
  `src/viewer/data/catalogue.ts`, callers that only read a log count (name them in the PR body)
- Test: `test/query/sql/spans.test.ts`, `test/query/sql/logs.test.ts`, `test/viewer-data/duckdb-source-*.test.ts`

**Interfaces:**

- Produces:

```ts
// spans.ts: today's traceRowsQuery without the `matching` relation; groups carry HAVING sum(span_count) > 0
export function allTraceRowsQuery(files: Pruned, sort: TraceSort, limit: number): Query;
export function allTraceCountQuery(files: Pruned): Query; // n: traces with at least one span
// logs.ts
/** One row: `n` and `matched`. 'logs': n = count(*), matched = n. 'traces': n = count(DISTINCT trace_id), matched = count(*) of logs with a trace id. */
export function logCountQuery(f: SqlFilter, mode: 'logs' | 'traces'): Query;
// data-source.ts
export type LogNeed = 'rows' | 'facets' | 'timeline' | 'total';
```

The data source uses the `all…` builders when the filter has no predicate, no text, no residual and no window; every
other case is unchanged. `total` on logs runs `logCountQuery` only when `rows` is not asked, as spans do
(`duckdb-source.ts:396-401`); today's inline `matched` statement of the trace-mode rows path goes away with it. New
catalogue entries: `logs.total.short`, `logs.total.long`, `logs.total.traces.long`, each declared as measured.
`logs.total.traces.long` stays that way for good (a distinct-trace count is no rollup's measure: `scan` is allowed on
density and window); only the logs-mode total moves in PR 6.

- [ ] **Step 1: Write the failing tests**

```ts
test.each(TRACE_SORTS)('allTraceRowsQuery equals traceRowsQuery on an unfiltered report, sorted by %s', async (sort) => {
  // fixture: a trace split over two partitions, a trace with logs only (absent from both), a trace with an error
  expect(await rows(allTraceRowsQuery(all, sort, 50))).toEqual(await rows(traceRowsQuery(noFilter, sort, 50)));
});
test('an unconditioned trace list runs no statement over spans', async () => {
  expect(db.connector.requests.filter((r) => /\bspans\b/.test(r.sql))).toEqual([]);
});
test('a window, a condition or a text each keep the spans path', async () => {});
test('logs: total without rows runs one count statement and returns matched', async () => {});
test('logs: total with rows runs no extra statement', async () => {});
// classes: traces.list.all and traces.list.all.long → 'files' on retention and density
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS; delete the two debt lines.
- [ ] **Step 5:** `mise run verify`; prediction against the "after 4" row. **Commit and open PR 4** (`Fixes #272`).

## PR 5: format 5

All five tasks are one PR: a writer that emits format 5 and a reader that cannot open it never share a commit on
`main`. Until this PR merges, its own CI report is missing (decision 11); say so at the top of the PR body.

### Task 14: The format-5 manifest, the two tables, and gates that read 4 and 5

**Files:**

- Modify: `src/format/manifest.ts`, `src/format/version.ts`, `src/format/paths.ts` (`PARTITION_FILE_RE`),
  `src/format/state.ts`, `src/format/columns.ts`, `src/format/validate.ts`, `src/format/parquet/columns.ts`,
  `src/format/parquet/schema.ts`, `src/config/schema.ts`, `src/query/sql/views.ts` (`PARTITION_IN_FILENAME`),
  `src/query/sql/columns.ts`, and the gates: `src/writer/merge.ts:126-158`, `src/writer/upgrade.ts:73-97`,
  `src/writer/checkpoint.ts:129-133`, `src/writer/partition-checkpoint.ts:86`, `src/cli/ci/run-report.ts:46,303`,
  `src/viewer/data/require-format4.ts`, `src/viewer/data/manifest-range.ts:10`, `src/host/manifest.ts:30`
- Test: `test/format/manifest.test.ts`, `test/format/compat.test.ts`, `test/format/paths.test.ts`,
  `test/query/sql/views.test.ts`, the gate tests next to each gate

**Interfaces:**

- Produces:

```ts
// version.ts
export const PARTITION_FORMAT_VERSION = 5;
export const READABLE_PARTITION_FORMATS = [4, 5] as const;
// parquet/columns.ts
export const TABLES = ['spans', 'logs', 'points', 'traces', 'patterns', 'span_rollups', 'log_rollups'] as const;
export const ROLLUP_OF: { readonly span_rollups: 'spans'; readonly log_rollups: 'logs' };
// SORT_COLUMNS, TIME_COLUMN and FIXED_STATISTICS_COLUMNS of a rollup table equal its base table's.
// manifest.ts
export const ROLLUP_GRAIN_NS = 65_536_000_000;
export interface RollupDescription { grainNs: typeof ROLLUP_GRAIN_NS; dimensions: string[]; durationBuckets?: 'log2x8' }
export interface PartitionFile extends FileStatistics { /* … */ timeEndMax?: string | null; rollup?: RollupDescription }
export interface ManifestV4 { formatVersion: 4 | 5 /* the name stays; fields above are optional and absent in format 4 */ }
export const ManifestV5Schema: z.ZodType<ManifestV4>;  // strict at every level; ManifestV4Schema is not edited
export function isPartitioned(m: AnyManifest): m is ManifestV4; // replaces isV4 and requireFormat4's test at every gate
// config/schema.ts, in ViewerSchema (the viewer acts on it in PR 8)
defaultWindow: z.string().regex(/^[1-9][0-9]*(m|h|d)$/).optional()
```

`dimensions` are in the statistics-key grammar (`service_name`, `resource:<key>`, `attr:<key>`), sorted.
`timeEndMax` is allowed on `spans` and `traces` files, `rollup` on the two rollup tables only, where it is required.

- [ ] **Step 1: Write the failing tests**

```ts
test('the format-4 schema still rejects every format-5 addition', () => {
  for (const m of [withTimeEndMax(v4), withRollupFile(v4), withDefaultWindow(v4)]) expect(ManifestV4Schema.safeParse(m).success).toBe(false);
});
test('the format-5 schema accepts them, and a format-4 body with formatVersion 5', () => {});
test('format 5 rejects: timeEndMax before timeMin; a rollup file without a description; a description on spans; grainNs 60000000000', () => {});
test('parseAnyManifest: 4 and 5 parse, 6 fails with the newer-format error naming 6', () => {});
test('rollup paths are partition files', () => {
  expect(PARTITION_FILE_RE.test('data/partitions/000012/span_rollups.parquet')).toBe(true);
  expect(PARTITION_IN_FILENAME.exec('https://x/data/partitions/000012/log_rollups.parquet')?.[1]).toBe('000012');
});
test('a table with no file gets a typed empty view, the rollup tables included', async () => {});
test.each(GATES)('%s accepts a format-5 manifest and still accepts format 4', async () => {});
test('merging a format-4 report into a format-5 one writes format 5 and keeps the old partitions’ entries unchanged', async () => {});
test('defaultWindow: 7d, 90m, 1h parse; 0d, 7, 1w, -1h do not', () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement; the typecheck lists every `Record<Table, …>` that needs the two
      tables. **Step 4:** `mise run gen`, `mise run check` → PASS; `test/format/compat.test.ts` byte-for-byte checks
      of formats 1 to 4 unchanged. **Step 5: Commit.** `feat(format): format 5 manifest, rollup tables, gates read 4 and 5`

### Task 15: Rollup rows at cut

**Files:**

- Create: `src/format/parquet/duration-bucket.ts`, `src/writer/rollup-rows.ts`
- Modify: `src/format/parquet/schema.ts`, `src/writer/partition-writer.ts`, `src/writer/partition-session.ts:236-272`
  (the `derive` callback), `src/format/parquet/stats.ts`
- Test: `test/format/parquet/duration-bucket.test.ts`, `test/writer/rollup-rows.test.ts`,
  `test/writer/partition-session.test.ts`

**Interfaces:**

- Produces:

```ts
// duration-bucket.ts: integers only, so SQL and TypeScript agree exactly
export const DURATION_THRESHOLDS = [5029079263719320435n, 5484249825272419511n, 5980616842327661685n,
  6521908912666391106n, 7112192101001162094n, 7755900482342532474n, 8457869449776733335n] as const; // floor(2^(62 + j/8)), j = 1…7
export function durationBucket(durationNs: bigint): number; // -1 for d ≤ 0, else 8·e + #{j : (d << (62 − e)) ≥ T_j}, e = bitLength(d) − 1
export function bucketValue(bucket: number): number;        // 0 for -1, else 2^((bucket + 0.5) / 8)
export function durationBucketSql(column: string): string;  // the same rule over a BIGINT column
// rollup-rows.ts
export function rollupDimensions(table: 'spans' | 'logs', statisticsKeys: readonly string[]): string[];
export function spanRollupRows(spans: ColumnBatch, dimensions: readonly string[]): Row[];
export function logRollupRows(logs: ColumnBatch, dimensions: readonly string[]): Row[];
export function rollupAllowed(rollupRows: number, baseRows: number): boolean; // rollupRows ≤ max(4096, baseRows / 8)
```

Columns. `span_rollups`: `start_time_unix_nano` (the grain's start, absolute: `t − t mod 65_536_000_000`),
`service_name`, `scope_name`, `name`, `kind`, `status_code`, `resource_name`, `resource_attributes` and `attributes`
(JSON reduced to the dimension keys, each value's text kept byte for byte, an absent key left out), `duration_bucket`
(int32), `n` (int64), `duration_sum`, `duration_min`, `duration_max` (int64). `log_rollups`: `time_unix_nano` (the
grain of `coalesce(time, observed)`; null for a log with neither), `observed_time_unix_nano` (always null, so the raw
time expression runs unchanged), `service_name`, `scope_name`, `severity_number`, `host_name`, `event_name`,
`has_trace` (bool), reduced `resource_attributes` and `attributes`, `n`. One row per distinct combination of every
column but the measures. `rollupDimensions` is the columns behind `SPAN_EXPRS` / `LOG_EXPRS` of
`src/query/sql/facets.ts` plus the table's statistics keys (`statisticsKeysFor`).

- [ ] **Step 1: Measure before building** (§6). Download the largest spans file of the live report, compute its
      rollup with one DuckDB `GROUP BY` in a scratch script (dimensions: the core facets plus the keys of the shipped
      CI config), write it with the writer's codec settings, and compare sizes. Under 2 % of the spans file: go on,
      and put the two sizes in the PR body. Not under 2 %: stop and report sizes per dimension.
- [ ] **Step 2: Write the failing tests**

```ts
test('durationBucket: exact values', () => {
  expect([0n, -5n, 1n, 2n, 3n, 1024n, 1_000_000n].map(durationBucket)).toEqual([-1, -1, 0, 8, 12, 80, 159]);
});
test('SQL and TypeScript agree on 2^k, 2^k ± 1 (k = 0…62) and 10,000 seeded values', async () => {});
test('bucketValue is within 4.43 % of every duration in its bucket', () => {
  for (const d of seeded) expect(Math.abs(bucketValue(durationBucket(d)) / Number(d) - 1)).toBeLessThanOrEqual(0.0443 + 1e-9);
});
test('three spans of one grain, dimensions and bucket make one row', () => {
  expect(rows).toEqual([expect.objectContaining({ n: 3n, duration_bucket: 79, duration_sum: 3_030n, duration_min: 1_000n, duration_max: 1_020n })]);
});
test('a span starting exactly on a grain edge belongs to the grain that starts there', () => {});
test('a value’s kind is kept: "1" and 1 under one key are two rows; an empty string and an absent key are two rows', () => {});
test('a duration of zero is bucket -1 with duration_sum 0', () => {});
test('a log with no time has a null grain; a log with only an observed time uses it', () => {});
test('the sum of n equals the base rows, for spans and for logs', async () => {});
test('rollupAllowed: boundaries', () => {
  expect([rollupAllowed(4096, 10), rollupAllowed(4097, 32_768), rollupAllowed(4097, 32_776)]).toEqual([true, false, true]);
});
test('a partition whose rollup the guard refuses has no rollup file and one warning naming the widest dimension', async () => {});
test('a flushed partition has both rollup files, each with its description', async () => {});
```

- [ ] **Step 3:** run → FAIL. **Step 4:** implement; rollup rows are computed in TypeScript from the column batches
      the `derive` callback already receives, next to `traceRows` and `patternRows`. **Step 5:** → PASS.
- [ ] **Step 6: Commit.** `feat(writer): span and log rollups are written with each partition`

### Task 16: Compaction, merge and the end-time statistic

**Files:**

- Modify: `src/writer/compaction.ts`, `src/writer/merge.ts`, `src/writer/partition-session.ts`,
  `src/writer/partition-writer.ts`, `src/writer/prune.ts`, `src/writer/rebase.ts`, `src/format/parquet/stats.ts`
- Test: `test/writer/compaction.test.ts`, `test/writer/merge.test.ts`

**Interfaces:**

- Produces: `timeEndMax` on every `spans` file (max `end_time_unix_nano`) and `traces` file (max end) written at
  format 5, as int64 text like `timeMax`; `foldTimeEndMax(values: readonly (string | null | undefined)[]): string | null`
  in `stats.ts` (the max, or null when any input lacks it and its rows are not read).
  `addRollupRows(a: readonly Row[], b: readonly Row[]): Row[]` in `rollup-rows.ts` (same key: `n` and `duration_sum`
  add, min of mins, max of maxes).

- [ ] **Step 1: Write the failing tests**

```ts
test('compacting partitions with equal rollup descriptions equals the rollup of the compacted rows', async () => {
  expect(sorted(await rowsOf(compacted, 'span_rollups'))).toEqual(sorted(spanRollupRows(await batchOf(compacted, 'spans'), dims)));
});
test('compacting a partition without a rollup, or with other dimensions, recomputes from the rows', async () => {});
test('the guard applies to a compacted rollup', async () => {});
test('timeEndMax: written at cut, the max after compaction, absent after a file-copying merge of a format-4 partition', async () => {});
test('a merge that moves the epoch leaves rollup files byte-identical', async () => {});
test('pruning a partition removes its rollup files', async () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS. **Step 5: Commit.**
      `feat(writer): rollups and timeEndMax through compaction and merge`

### Task 17: The CI update path

**Files:**

- Modify: `src/cli/ci/update.ts` (`partitionShape.files` at `:42-48`, `TABLE_ALT` and `LAYOUT` at `:176-184`),
  `src/cli/ci/push-update.ts`, `src/cli/ci/run-report.ts` (`entryFrom`, `planSync`), `src/cli/ci/deploy-apply.ts`,
  `src/cli/ci/deploy-plan.ts`, `src/cli/ci/site.ts`, `src/cli/ci/site-main.ts`, `src/cli/ci/publish-io.ts`
- Test: `test/cli/ci/update.test.ts`, `test/cli/ci/run-report.test.ts`, `test/cli/ci/deploy-apply.test.ts`

**Interfaces:**

- Produces: `readUpdate` accepts an update with or without rollup files; a run report is created at format 5; a run
  report that exists at format 4 stays format 4 (its manifest entries drop rollup files, `timeEndMax` and `rollup`)
  until it is rebuilt.

- [ ] **Step 1: Confirm the transition is safe.** Read `deploy-apply.ts:380-415` as it is on `main`: an update the
      format-4 deployer cannot read must end in `record(c, 'rejected', …)` and a green deploy. If it can fail the
      deploy job or damage the site, stop.
- [ ] **Step 2: Write the failing tests**

```ts
test('an update with rollup files is read; one without is read', async () => {});
test('an update with an unknown file name is still rejected', async () => {});
test('a format-4 run report that receives a format-5 update still parses with ManifestV4Schema and has no rollup file', async () => {});
test('a new run report is format 5 and lists the rollup files with their descriptions', async () => {});
test('the site merge of a format-4 run and a format-5 run is format 5 and opens', async () => {});
```

- [ ] **Step 3:** run → FAIL. **Step 4:** implement. **Step 5:** → PASS. **Step 6: Commit.**
      `feat(ci): updates carry rollup files; format-4 run reports stay format 4`

### Task 18: The viewer and the host open format 5

**Files:**

- Modify: `src/viewer/data/require-format4.ts`, `src/viewer/data/open-report.ts`, `src/viewer/data/refresh-report.ts`,
  `src/viewer/data/manifest-range.ts`, `src/viewer/data/engine/files.ts` (`manifestFiles`), `src/host/manifest.ts`,
  `src/host/engine.ts` (`listedPaths`), `src/host/engine-files.ts`, `README.md`
- Create: `fixtures/reports/format-5/**` (and its line in `SHA256SUMS`, the fixtures README, and the five places a
  frozen fixture is registered: follow format 4's with `git grep -n 'format-4'`)
- Test: `test/viewer-data/frozen-reports.test.ts`, `test/viewer-data/engine-files.test.ts`,
  `test/host/manifest.test.ts`, `test/format/compat.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('the frozen format-5 report opens and its checksums hold', async () => {});
test('the frozen format-4 report still opens, with empty rollup views', async () => {
  expect(await count('span_rollups')).toBe(0);
});
test('a logs-only format-5 report opens: span_rollups is an empty typed view, log_rollups has rows', async () => {});
test('an empty format-5 report opens and every catalogue entry answers without an error', async () => {});
test('the host serves the rollup files of a format-5 report and refuses a format-6 one with the newer-format error', async () => {});
test('Refresh picks up a rollup file added to a partition', async () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement; build the frozen fixture with the command the fixtures README
      gives for format 4. **Step 4:** → PASS. README: the compatibility table gets a format-5 row (written by this
      version on; read by this version on; format 4 still read), and one paragraph on what the rollup files are.
- [ ] **Step 5:** `mise run verify` (every e2e fixture is now format 5; the frozen format-4 spec still passes).
      `mise run test:scaling` or the scaling tests: no entry changed class. Prediction: unchanged from "after 4"
      within 5 %. **Commit and open PR 5.**

## PR 6: the router and the long-window rules

### Task 19: Pruning by end time

**Files:**

- Modify: `src/query/sql/prune.ts`
- Test: `test/query/sql/prune.test.ts`

**Interfaces:**

- Produces: `prunePartitions` drops a `spans` or `traces` file whose `timeEndMax` is before the window's start; a file
  without `timeEndMax` is kept as today.

- [ ] **Step 1: Write the failing tests**

```ts
test('a spans file that ends before the window starts is not read', () => {});
test('a file whose timeEndMax equals the window’s start is read', () => {});
test('a format-4 file (no timeEndMax) is read whenever it is today', () => {});
test('a logs file is unaffected', () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS; delete the end-time debt line of Task 5
      (every windowed spans entry and `resourceValues.short` are now `fixed` on retention). **Step 5: Commit.**
      `perf(query): short windows skip files that ended before them`

### Task 20: What a condition reads, long windows, and their rules on the raw path

**Files:**

- Modify: `src/query/sql/ottl.ts`, `src/query/sql/filter.ts`, `src/query/sql/time.ts`, `src/query/sql/spans.ts`,
  `src/query/sql/logs.ts`, `src/query/sql/prune.ts`, `src/rollups/time-buckets.ts`,
  `src/viewer/data/time-window.ts`, `src/viewer/data/query-common.ts`, `src/viewer/data/duckdb-source.ts`,
  `src/viewer/data/span-results.ts`, `src/viewer/dashboards/widgets/timeline.tsx`,
  `src/viewer/components/histogram-card.tsx`, `src/viewer/state/selection.ts`, `src/viewer/shell/shell.tsx`
- Test: `test/query/sql/ottl.test.ts`, `test/query/sql/spans.test.ts`, `test/query/sql/prune.test.ts`,
  `test/rollups/time-buckets.test.ts`, `test/viewer/time-window.test.ts`, `test/viewer/selection.test.ts`,
  `test/viewer-data/duckdb-source-spans.test.ts`

**Interfaces:**

- Produces:

```ts
// ottl.ts: statistics-key grammar; 'resource:*' / 'attr:*' when a term reads a whole map; a column name otherwise
interface Translation { /* … */ reads: ReadonlySet<string> }
// time-window.ts (TimeWindow is nanoseconds relative to the epoch)
// the grain is ROLLUP_GRAIN_NS from src/format/manifest.ts (Task 14); no second constant
export const LONG_WINDOW_NS = 16_777_216_000_000; // 256 grains
export function isLongWindow(window: TimeWindow | null, range: TimeWindow | null): boolean; // (window ?? range): end − start ≥ LONG_WINDOW_NS
export function alignLongWindow(window: TimeWindow, epoch: bigint): TimeWindow; // start down, end up to a grain of absolute time
// filter.ts
interface SqlFilter { /* … */ long: boolean }
interface FilterOptions { /* … */ long?: boolean }
// time.ts: under `long` the width is at least ROLLUP_GRAIN_NS and buckets are aligned on absolute time (it needs the epoch)
export function bucketSpec(window: RelWindow | null, range: RelWindow | null, maxBuckets?: number, long?: { epoch: bigint }): BucketSpec;
/** Gains `originNs`: the relative time of one absolute multiple of `widthNs`, in [0, widthNs). 0 outside `long`; under `long` it is mod(−epoch, widthNs), computed in bigint. */
interface BucketSpec { widthNs: number; startNs: number; endNs: number; originNs: number }
// time-buckets.ts: the serialized object gains optional `originNs` (default 0); the alignment rule becomes
//   mod(startNs − originNs, widthNs) === 0. Readers that step from `startNs` (timeline.tsx, histogram-card.tsx) change only where they rebuild a serialized object: they carry `originNs` through.
// prune.ts: under `long`, a spans or traces file is also dropped when its `timeMax` (latest start) is before the window's
//   start: selection is by start time, so this holds for format-4 files too
export function prunePartitions(manifest, table, hints, window, resolve, opts?: { long?: boolean }): Pruned;
```

Rules, applied wherever `long` is true and never by format (§6.3): `whereOf` selects spans by
`start_time_unix_nano >= lo AND start_time_unix_nano < hi`, logs and points by their time `>= lo AND < hi`; no window
on a long range adds no time filter at all; timeline and bucket widths come from the `long` branch of `bucketSpec`.
Percentiles from duration buckets arrive with the measures relation in Task 21. The selection state aligns a long window when it is set (`setWindow`) and when it is
read from the URL (`dataFromUrl`); the data source aligns again, which changes nothing.

- [ ] **Step 1: Write the failing tests**

```ts
test('reads: a column, a resource key, an attribute key, a whole map', () => {
  expect(reads('service.name == "a" and resource.attributes["run.id"] == "x"')).toEqual(new Set(['service_name', 'resource:run.id']));
  expect(reads('attributes["http.route"] == "/"')).toEqual(new Set(['attr:http.route']));
  expect(reads('duration > 5')).toEqual(new Set(['duration_ns']));
});
test('exactly 256 grains is long; one nanosecond less is short', () => {
  expect(isLongWindow({ start: 0, end: 16_777_216_000_000 }, null)).toBe(true);
  expect(isLongWindow({ start: 0, end: 16_777_215_999_999 }, null)).toBe(false);
});
test('no window on a range of exactly 256 grains is long; on a shorter range it is short', () => {});
test('alignLongWindow moves outward to absolute grains and is idempotent', () => {
  const w = alignLongWindow({ start: 1, end: 16_777_216_000_001 }, 1_700_000_000_000_000_000n);
  expect((1_700_000_000_000_000_000n + BigInt(w.start)) % 65_536_000_000n).toBe(0n);
  expect((1_700_000_000_000_000_000n + BigInt(w.end)) % 65_536_000_000n).toBe(0n);
  expect(w.start).toBeLessThanOrEqual(1); expect(w.end).toBeGreaterThanOrEqual(16_777_216_000_001);
  expect(alignLongWindow(w, 1_700_000_000_000_000_000n)).toEqual(w);
});
test('the selection aligns a long window from setWindow and from the URL, and leaves a short one alone', () => {});
test('long: a span starting exactly on the end is out, one starting on the start is in, one that only overlaps is out', async () => {});
test('short: overlap and inclusive ends, as today', async () => {});
test('long: a 6 h window draws buckets of 65.536 s on absolute grain edges', () => {});
test('TimeBuckets.from accepts a start aligned to originNs and refuses one that is not', () => {
  expect(() => TimeBuckets.from({ maxBuckets: 4, widthNs: 10, originNs: 3, startNs: 13, keys: [], counts: [] })).not.toThrow();
  expect(() => TimeBuckets.from({ maxBuckets: 4, widthNs: 10, originNs: 3, startNs: 10, keys: [], counts: [] })).toThrow();
});
test('long: a spans file whose latest start is before the window is not read; under a short window it is (no timeEndMax)', () => {});
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS; existing e2e specs that pin bucket counts or
      exact percentiles under a window of 4 h 40 min or more are updated to the new rule and listed in the PR body.
- [ ] **Step 5: Commit.** `feat(viewer): long windows count by start time, on grain-aligned buckets`

### Task 21: The measures relation, the router, and the equivalence test

**Files:**

- Create: `src/query/sql/rollup.ts`, `src/viewer/data/route.ts`, `test/query/sql/rollup.test.ts`,
  `test/viewer-data/route.test.ts`, `test/viewer-data/rollup-equivalence.test.ts`
- Modify: `src/query/sql/facets.ts`, `src/viewer/data/duckdb-source.ts`, `src/viewer/data/results.ts`,
  `src/viewer/data/span-results.ts`, `src/viewer/data/log-results.ts`, `src/viewer/data/catalogue.ts`

**Interfaces:**

- Produces:

```ts
// rollup.ts
export interface MeasureKey { name: string; raw: ExprNode; rollup?: ExprNode } // rollup defaults to raw (same column names)
export interface Split { rollup: readonly string[]; raw: readonly string[] }   // file paths
/** A partition's rollup is usable when its description's dimensions ⊇ reads, its grain is ROLLUP_GRAIN_NS and, if durations are asked, durationBuckets is 'log2x8'. */
export function splitFiles(manifest: ManifestV4, table: 'spans' | 'logs', pruned: Pruned, reads: ReadonlySet<string>, opts: { durations: boolean; rawOnly: boolean }): Split; // rawOnly: every file goes to `raw`
/**
 * Rows (…keys, n, duration_sum, duration_min, duration_max and, when asked, duration_bucket): the rollup rows of
 * split.rollup UNION ALL the same shape grouped from split.raw. The rollup branch applies the filter's predicate and
 * window; the raw branch applies the whole filter the request runs with today (text, residual terms and the id-table
 * restriction included).
 */
export function measuresRelation(f: SqlFilter, table: 'spans' | 'logs', split: Split, keys: readonly MeasureKey[], durations: boolean): Query;
export function rollupTotalQuery(rel: Query): Query;
export function rollupTimelineQuery(rel: Query, spec: BucketSpec, epoch: bigint, by: MeasureKey | null): Query;
export function rollupFacetQuery(rel: Query, key: MeasureKey, cap: number): Query;
export function rollupGroupsQuery(rel: Query, keys: readonly MeasureKey[]): Query;
export function rollupDurationsQuery(rel: Query): Query; // p50, p95, p99 by bucketValue, clamped to [min, max]; the histogram's buckets
// spans.ts
export function durationBucketsQuery(f: SqlFilter): Query; // the raw branch's shape: duration_bucket, n, duration_sum, duration_min, duration_max
// facets.ts: CoreFacet gains `reads: string` (its statistics-key name) and, where the rollup stores it otherwise, `rollupExpr`
//   (trace.present: `CASE WHEN has_trace THEN 'yes' ELSE 'no' END`)
// route.ts
export interface RequestShape { table: 'spans' | 'logs'; need: SpanNeed | LogNeed; mode: 'spans' | 'traces' | 'logs'; long: boolean; reads: ReadonlySet<string>; residual: boolean; text: boolean }
/** 'measures': the need is built over measuresRelation. 'direct': today's statement. */
export function routeOf(shape: RequestShape): 'measures' | 'direct';
export function rawOnly(shape: RequestShape): boolean; // text, a residual term, or a whole-map read
```

`routeOf` is `'measures'` exactly when `long` and the need is `total` (not in trace mode), `timeline`, `buckets`,
`groups`, `durations`, `services` or core `facets`; its inputs are the request's shape only: no widget, dashboard or
key name. So under a long window each of those numbers has one computation, whatever the condition (decision 14).
`rawOnly` is true for text, a residual term, or a whole-map read (the literal entries `resource:*` or `attr:*` in
`reads`; a named key such as `resource:run.id` is fine): then `splitFiles` sends every file to `raw`. A condition on
a named attribute that is no partition's dimension ends the same way through `splitFiles`' own rule. Rollup files are pruned by time and statistics by `prunePartitions`
like any table and are prepared through `runPrepared` (Task 9), so on a site they load whole. Every `.long`
aggregate entry in the catalogue names the `rollup…` builders, the attribute- and text-conditioned ones too; those
are declared as measured (`scan` is allowed on density and window: they read raw files by design).

- [ ] **Step 1: Write the failing tests**

```ts
// route.test.ts
test.each(MEASURED_NEEDS)('%s is built over measures under a long window and directly under a short one', (shape) => {});
test('rows, attribute facets and a distinct-trace count are direct under a long window', () => {});
test('rawOnly: a text search, a residual term and a whole-map read; not a named resource or attribute key', () => {});
// rollup.test.ts
test('splitFiles: a rollup lacking a read dimension sends its partition to raw; a format-4 partition is raw', () => {});
test('measuresRelation applies the predicate in both branches', () => {
  expect(String(rel).match(/service_name = 'a'/g)).toHaveLength(2);
});
// rollup-equivalence.test.ts: the same OTLP input written three ways:
//   A every partition with rollups; B none (format-4 partitions); C mixed, one partition's rollup with fewer dimensions
test.each(ROLLUP_ENTRIES)('$id answers the same from rollups, from raw files and from a mix', async (entry) => {
  expect(await run(entry, A)).toEqual(await run(entry, B));
  expect(await run(entry, C)).toEqual(await run(entry, B));
});
```

The input of the equivalence test holds, by name: a key whose values are a string, a number and a boolean in different
spans; a key present with an empty string, present with null, and absent; a span starting exactly on a grain edge and
one exactly on the window's end; a log stamped exactly on each; a span of duration zero; a log with no time (inside a
no-window request on a long range it is counted, under a long window it is not); a partition written before a merge
moved the epoch. `ROLLUP_ENTRIES` is every catalogue entry `routeOf` sends to `'measures'` and `rawOnly` does not
hold for, each also run with a sort-key and a statistics-key condition.

```ts
test.each(['attributes["http.route"] != "no-such"', RESIDUAL_ALWAYS_TRUE])('%s gives the same total, timeline, groups, services and durations as no condition', async (cond) => {});
test('long: p50, p95 and p99 are within 4.43 % of quantile_cont over the same rows, and inside [min, max]', async () => {});
test('short: percentiles are exact, as today', async () => {});
```

```ts
test('a logs-only report and a report with an empty spans table answer empty under a long window', async () => {
  expect(await ds.querySpans({ needs: ['total', 'timeline', 'facets', 'durations'], window: longWindow })).toMatchObject({ total: 0 });
});
// classes.test.ts: the entries of the plan's PR 6 row declare { retention: 'fixed', density: 'fixed', window: 'files' }
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS; delete #271's remaining debt lines; assert
      in `classes.test.ts` that no debt line names an entry in `ROLLUP_ENTRIES`.
- [ ] **Step 5: Commit.** `perf(viewer): rollup-answerable requests under a long window read rollups`

### Task 22: The trace list, `percentileOf` and `resourceValues` under a long window

**Files:**

- Modify: `src/query/sql/spans.ts`, `src/query/sql/logs.ts`, `src/query/sql/rollup.ts`,
  `src/viewer/data/duckdb-source.ts`, `src/viewer/data/trace-detail.ts`, `src/viewer/data/catalogue.ts`
- Test: `test/query/sql/spans.test.ts`, `test/viewer-data/duckdb-source-spans.test.ts`,
  `test/viewer-data/rollup-equivalence.test.ts`

**Interfaces:**

- Produces:

```ts
// spans.ts. A trace belongs to the window its earliest span start (over all its partitions) falls in: lo ≤ start < hi.
export function allTraceRowsQuery(files: Pruned, sort: TraceSort, limit: number, window?: AbsWindow | null): Query; // HAVING on the trace's start
export function allTraceCountQuery(files: Pruned, window?: AbsWindow | null): Query;
/** The partitions (traces file names) that hold a row of a trace starting in the window. */
export function windowTracePartitionsQuery(files: Pruned, window: AbsWindow): Query;
/** traceRowsQuery restricted to traces that start in the window; `f.files` is the spans files of those partitions. */
export function windowTraceRowsQuery(f: SqlFilter, traces: Pruned, sort: TraceSort, limit: number): Query;
// rollup.ts
export function rollupPercentileQuery(rel: Query, bucket: number): Query; // sum(n) FILTER (duration_bucket <= bucket) * 100.0 / sum(n), n
export function rollupResourceValuesQuery(rel: Query, key: MeasureKey, cap: number): Query;
```

Under a long window the trace list without a condition reads `traces` files only. With a condition it runs
`windowTracePartitionsQuery`, then `windowTraceRowsQuery` over the spans files of the partitions it named (every
`traces` file is still read: whole traces). `percentileOf` on a report whose range is long reads the rollup over the
whole report; on a short one it is unchanged. `resourceValues` under a long window takes its span and log parts from
rollups when `resource:<key>` is a dimension (per partition, like every routed request); the points part is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test('long window: a trace split over two partitions that starts before the window is not listed, though one partition’s row starts inside', async () => {});
test('long window: a condition that is always true lists the same traces, in the same order, as no condition', async () => {});
test('long window: an unconditioned list and its count run no statement over spans', async () => {});
test('long window: a conditioned list reads spans only in the partitions the traces rows name', async () => {});
test('short window: the list is by overlap, as today', async () => {});
test('percentileOf on a long range is within 4.43 percentage points… of the exact share at a bucket edge, and equal from rollup and raw', async () => {});
test('resourceValues under a long window is the same list from rollups, raw files and a mix', async () => {});
// classes: traces.list.long → 'files' on all three axes; traces.list.statkey.long → window 'matched';
//   percentile.long → retention 'files', density 'fixed'; resourceValues.long as the PR 6 row; percentile.short unchanged
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS. **Step 5: Commit.**
      `perf(viewer): the trace list, percentiles and variables under a long window`

### Task 23: Attribute facets on request, and the page says "approximate"

**Files:**

- Modify: `src/viewer/data/results.ts`, `src/viewer/data/duckdb-source.ts`, `src/viewer/data/catalogue.ts`,
  `src/viewer/traces/explorer.tsx`, `src/viewer/logs/explorer.tsx`, `src/viewer/components/facet-panel.tsx`,
  `src/viewer/shell/time-range.tsx`, `src/viewer/traces/span-section.tsx`, `src/viewer/traces/trace-panel.tsx`,
  `README.md`
- Test: `test/viewer/traces/explorer.test.tsx`, `test/viewer/logs/explorer.test.tsx`, `e2e/long-window.spec.ts` (new;
  its first test tagged `@http`)

**Interfaces:**

- Produces: no new request field. `results.ts` exports `CORE_SPAN_FACET_KEYS` and `CORE_LOG_FACET_KEYS`
  (`readonly string[]`, from the core facet lists). Under a long window the explorers ask the `facets` need with
  `facetKeys` set to that list (the existing rule: no key outside the core, no attribute statement) and, when the
  reader asks, send one more request `{ needs: ['facets'], facetKeys: null }` with the same filter and window. Copy,
  exact: section text `Attribute facets are not loaded for windows of 4 h 40 min or longer.`, button
  `Load attribute facets`. The time-range control shows `percentiles approximate` whenever the page's window is long,
  with the title `Percentiles over windows of 4 h 40 min or longer are within about 5 %.`; the trace panel shows the
  word `approximate`, same title, next to its percentile line when the report's range is long (decision 15).

- [ ] **Step 1: Write the failing tests**

```ts
test('long window: the page loads without the attribute-facet statement and shows the section text and the button', async () => {});
test('pressing the button loads them once; changing the filter or the window shows the button again', async () => {});
test('short window: attribute facets load with the page and there is no button', async () => {});
test('long window: the time-range control says "percentiles approximate"; short window: it does not', async () => {});
test('the label follows the window, not the condition: adding an attribute condition changes nothing', async () => {});
test('the trace panel marks its percentile line on a long range and not on a short one', async () => {});
// e2e/long-window.spec.ts: on a site fixture with a range over 5 h, the Traces page under "Entire run" makes no range request to a spans file
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** → PASS. README: a section "Long windows" stating the
      five rules of §6.3 in the reader's terms.
- [ ] **Step 5:** `mise run verify`; prediction against the "after 6" row. **Commit and open PR 6** (`Fixes #271`).

## PR 7: compaction keeps files bounded in time (conditional)

### Task 24: Decide whether PR 7 is needed, and build it if it is

**Files:**

- Modify: `src/writer/compaction.ts`, `src/writer/partition-session.ts`, `src/viewer/data/catalogue.ts`,
  `test-support/scaling/generator.ts`
- Test: `test/writer/compaction.test.ts`, `test/scaling/classes.test.ts`

**Interfaces:**

- Consumes: `Shape` (Task 3), `KNOWN_DEBT` (Task 5), `timeEndMax` (Task 14).
- Produces: `Shape.compacted?: boolean` (the generator writes each partition's rows as several flushes spread over
  the report's whole range and compacts them at close); in `compaction.ts`
  `export const COMPACTION_SPAN_NS = 86_400_000_000_000n` and
  `export function timeGroups<T extends { timeMin: string | null; timeMax: string | null }>(inputs: readonly T[]): T[][]`.

- [ ] **Step 1: Decide.** Two measurements, recorded in the PR body or, if the PR is dropped, in the plan:
      (a) with the `compacted` shape, does any output file span more than 24 h when no single input does? Write the
      test of step 2 and see whether it fails on `main`. (b) on the live report, read `data/manifest.js` and list
      the partitions whose spans file spans more than 24 h, with the retention rule that will retire each and when.
      If (a) passes on `main` and (b) is empty or retires within the report's retention, the PR is **dropped**: set
      its status in the PR table to `dropped: <the two findings in one line>`, delete the compaction debt line with
      the same reason in its commit, carry both edits in PR 8's branch, and go to Task 25.

- [ ] **Step 2: Write the failing tests**

```ts
test('timeGroups: inputs sorted by timeMin are grouped while the union spans at most 24 h', () => {
  expect(timeGroups([at(0, 1), at(2, 3), at(30, 31), at(60, 61)]).map((g) => g.length)).toEqual([2, 1, 1]); // at(startHour, endHour)
});
test('timeGroups: one input longer than 24 h is a group of its own; inputs with no time share the first group', () => {});
test('compaction at close writes one partition per time group and no output spans more than 24 h unless one input does', async () => {});
test('compactOnMerge still writes per merge input, each split by time group', async () => {});
test('rollup rows, statistics and timeEndMax of the outputs equal those of an uncompacted report (Task 16’s fold)', async () => {});
// classes.test.ts: on the `compacted` shape every `.short` entry has the class it has on the plain shape
```

- [ ] **Step 3:** run → FAIL. **Step 4:** implement: `#compactGroup` compacts each of `timeGroups(inputs)`
      separately. **Step 5:** → PASS; set the debt line's `measured: true`, see the class test fail, then delete the
      line. README: the compaction paragraph says outputs are bounded to 24 h.
- [ ] **Step 6:** `mise run verify`. **Commit and open PR 7.**
      `perf(writer): compaction keeps files bounded in time`

## PR 8: the default window

### Task 25: `viewer.defaultWindow`, the longer presets, and "Entire run" that stays

**Files:**

- Modify: `src/config/schema.ts`, `src/writer/inherit-config.ts`, `src/viewer/state/param-schemas.ts`,
  `src/viewer/state/url-state.ts`, `src/viewer/state/selection.ts`, `src/viewer/state/carry.ts`,
  `src/viewer/dashboards/dashboard-page.tsx`, `src/viewer/metrics/catalog.tsx`, `src/viewer/shell/shell.tsx`,
  `src/viewer/shell/time-range.tsx`, `src/viewer/data/time-window.ts`, `src/viewer/data/catalogue.ts`, the generated
  schema files `mise run gen` rewrites, `.github/otel-html-ci.yaml`,
  `.github/actions/otel-html-publish/otel-html-ci.yaml`, `README.md`
- Test: `test/config/schema.test.ts`, `test/writer/inherit-config.test.ts`, `test/viewer/url-state.test.ts`,
  `test/viewer/selection.test.ts`, `test/viewer/carry.test.ts`, `test/viewer/shell.test.tsx`,
  `e2e/default-window.spec.ts` (new)

**Interfaces:**

- Consumes: `defaultWindow` in the manifest's viewer block (Task 14), `isLongWindow`, `alignLongWindow` (Task 20).
- Produces:

```ts
// schema.ts, in ViewerSchema; absent means no default
defaultWindow: z.string().regex(/^[1-9][0-9]*(m|h|d)$/).optional(),
// time-window.ts
export function durationNs(text: string): number; // '90m' → 5_400_000_000_000, '6h', '7d'
export function defaultWindowOf(text: string | undefined, range: TimeWindow | null): TimeWindow | null; // anchored at range.end; null when absent or not shorter than the range
// param-schemas.ts: `t` also accepts the literal
export const T_ALL = 'all';
// url-state.ts. UrlState.t stays `string | undefined`. `fallback` is the report's default window, or null.
/** No fallback: the formatted window, or undefined for null. With one: null → 'all'; equal to the fallback → undefined; else formatted. */
export function windowParam(window: TimeWindow | null, fallback: TimeWindow | null): string | undefined;
/** undefined → fallback; 'all' → null; else parseWindow(t). */
export function windowFromParam(t: string | undefined, fallback: TimeWindow | null): TimeWindow | null;
// selection.ts: Selection.window stays the effective window (null: the entire run). SelectionData gains
//   defaultWindow: TimeWindow | null — not in the URL; the shell passes it when it creates the store
export function createSelectionStore(initial: UrlState, opts?: { defaultWindow?: TimeWindow | null }): SelectionStore;
// time-range.tsx
const PRESETS = [Entire run, 15m, 1h, 6h, 24h, 7d]; // a preset is shown only when the range is longer than it
```

Every place that reads `t` into a window uses `windowFromParam` and every place that writes a window to `t` uses
`windowParam`, both with the store's `defaultWindow`: `dataFromUrl` and `selectionToUrlState` (`selection.ts:104,129`),
`carry.ts:35,41,53`, `dashboard-page.tsx:136,152` (`windowParam(…) ?? null` in the patch) and
`metrics/catalog.tsx:165`. Writers of an explicit window (`carry.ts:129`, `metrics/chart-pick.ts:40`) are unchanged.
`setWindow(null)` means the entire run wherever it is called, the histogram's brush clear included (decision 12).

Behaviour: with no `t` the selection's window is `defaultWindowOf(manifest.viewer.defaultWindow, range)`, and the URL
stays without `t`. Choosing "Entire run" writes `t=all` when a default is configured and removes `t` when none is.
Choosing the preset equal to the default removes `t`. `t=all` on a report without a default means the entire run.
`inheritDashboards` carries `viewer.defaultWindow` from the prior report when the new config leaves it out, as it does
`viewer.home`. The two CI config files each gain one line, `  defaultWindow: 7d`, under `viewer:`; nothing else in
either file changes.

- [ ] **Step 1: Write the failing tests**

```ts
test.each(['7d', '6h', '90m'])('%s is a valid defaultWindow', () => {});
test.each(['0d', '7', '1w', '-1h', ''])('%s is rejected with the path viewer.defaultWindow', () => {});
test('durationNs', () => {
  expect(durationNs('7d')).toBe(604_800_000_000_000);
  expect(durationNs('90m')).toBe(5_400_000_000_000);
});
test('no t: the window is the default, anchored at the end of the range, aligned when long', () => {});
test('a default as long as the range or longer is the entire run, and "Entire run" is shown as selected', () => {});
test('windowParam and windowFromParam', () => {
  const d = { start: 5, end: 9 };
  expect(windowParam(null, null)).toBeUndefined();
  expect(windowParam(null, d)).toBe('all');
  expect(windowParam(d, d)).toBeUndefined();
  expect(windowParam({ start: 1, end: 2 }, d)).toBe('1~2');
  expect(windowFromParam(undefined, d)).toEqual(d);
  expect(windowFromParam('all', d)).toBeNull();
  expect(windowFromParam('all', null)).toBeNull();
  expect(windowFromParam('1~2', d)).toEqual({ start: 1, end: 2 });
});
test('navigating between pages keeps "Entire run" (t=all is carried) and keeps the default (no t is carried)', () => {});
test('a dashboard whose scope is the entire run links to the explorers with t=all when a default is configured', () => {});
test('clearing the histogram brush under a default goes to the entire run and writes t=all', () => {});
test('choosing Entire run with a default writes t=all; a reload and a copied link both open the entire run', () => {});
test('choosing Entire run without a default removes t, as today', () => {});
test('a link with an explicit t wins over the default', () => {});
test('presets: 6h, 24h and 7d appear only when the range is longer than each', () => {});
test('a merge without --config keeps the prior report’s defaultWindow; a config that sets one replaces it', () => {});
test('both CI configs set viewer.defaultWindow to 7d and are otherwise equal to main', () => {}); // test/actions
// e2e/default-window.spec.ts: a site fixture built with defaultWindow 6h over a 12 h range opens the dashboard on the
// last 6 h; "Entire run" → reload → still the entire run; the URL of the first load has no t
```

- [ ] **Step 2:** run → FAIL. **Step 3:** implement; `mise run gen`. **Step 4:** → PASS. README: `viewer.defaultWindow`
      in the configuration reference, the presets, and what `t=all` means.
- [ ] **Step 5:** prediction: `mise run predict:queries -- --after 8 --window 7d`; the dashboard on the `rolling` and
      `30x150k` shapes is at or under 150 serial requests. Over 150, or over the "after 8" row by more than 20 %, is a
      stop with the printed table.
- [ ] **Step 6:** `mise run verify`. **Commit and open PR 8.** `feat(viewer): viewer.defaultWindow and longer presets`

## PR 9: the record

### Task 26: Measure the live report and write down what happened

**Files:**

- Modify: this plan (a section "Record" at its end), `README.md` (the performance section),
  `docs/superpowers/specs/2026-11-11-query-scaling-design.md` (§11 only: the session marked done)

- [ ] **Step 1:** wait until `branch/main` has been deployed by a run that includes PR 8 and at least one CI run has
      written format-5 partitions; note the deployed commit.
- [ ] **Step 2:** measure cold, twice each, in headless Chromium against
      `https://bjstabi.github.io/otel-html/branch/main/` with a Playwright script kept in the scratchpad (not committed; a new context per load, cache disabled):
      `#/dashboards/ci` and `#/traces?mode=traces`. Per load: requests, range requests, the longest serial chain,
      bytes, time to the last widget or row.
- [ ] **Step 3:** compare with §9: the dashboard at most 150 serial range requests and at most 5 s; the trace list at
      most 5 s. A miss is not a stop (§9: nothing is left to hold back): the record gives the two loads, the
      prediction for the same shape, where they part and the cause, and a follow-up issue is filed for it.
- [ ] **Step 4:** write "Record": the figures before (design §2) and after, per PR what moved in the catalogue, the
      final prediction table, what is still on the known-debt list and why, any PR marked dropped, and the follow-ups
      filed as issues (the threaded engine build is one; file it if no issue exists).
- [ ] **Step 5: Commit and open PR 9.** `docs(plan): query-scaling record`

## Calibration (Task 1)

Filled by Task 1 in PR 1; later tasks read it. **Status: the tolerance holds on all ten statements (two reports, five
statements) once the harness models the browser's read-ahead; the harness runs on the Node counting engine.** Step 5
found no row group size within 10 %; `ROW_GROUP_ROWS` is provisional (Task 6's 25 % check against the live report is the
guard).

- Engine the harness runs on: the Node counting engine (`test-support/scaling/counting-engine.ts`) with the read-ahead
  model of `rangesOf` (`cost.ts`). `cold()` replaces the worker, because DuckDB's footer and file caches are emptied by
  no SQL setting; a fresh worker with the views created is where a reloaded page stands.
- The read-ahead model (`rangesOf`), fitted on the `Range` headers the static server logged (the starts of every range
  agree on all ten statements): a read inside a stream's current range is free; a read that starts where a stream's
  range ends continues it with the next size, 16 KiB, 64 KiB, 256 KiB, 1 MiB, 4 MiB (the new range replaces the old);
  any other read starts a stream at 16 KiB; a stream survives a jump elsewhere; an open forgets the file's streams.
  Node itself reads 16 KiB per call, so raw read calls overstate Chromium's GETs up to 20 times (243 against 13).
  The model was fitted on the same ten statements it is checked against, so the exact agreement is a fit, not an
  independent validation; Task 6's live check against the report is the independent guard.
- `REQUESTS_PER_OPEN`: 2 (a HEAD and DuckDB's `bytes=0-0` probe GET; the footer read is one of the modelled ranges).
  `REQUESTS_PER_READ` (the `k` of decision 3): 1 per modelled range. `ROW_GROUP_ROWS`: 8192, provisional (below). All
  three are exported from `test-support/scaling/cost.ts`.
- Run: `mise run e2e:fixtures:scale`, then `mise run test:e2e:chromium -- e2e/calibration.spec.ts` (the spec is
  `@perf @http`). `test:e2e` builds the scale reports only when the selection lists `e2e/scale.spec.ts`, so a lone run
  needs the first command by hand. Each statement runs on a fresh page (`about:blank` first, on `#/metrics`, which
  reads no span) once the server has been quiet for a second; the Node side is `cold()`.
- Checked per statement: `opens·REQUESTS_PER_OPEN + modelledRanges·REQUESTS_PER_READ` against Chromium's HEADs plus
  range GETs, within `max(2, 10 %)`. The test pins the model on synthetic events (`test/scaling/counting-engine.test.ts`).

`rowgroups` (one partition, spans file of four 50,000-row groups, 4.0 MB; footers cached by the view creation):

| statement                         | Node opens | Node reads | modelled ranges | Chromium HEADs | Chromium range GETs | within tolerance |
| --------------------------------- | ---------- | ---------- | --------------- | -------------- | ------------------- | ---------------- |
| 1 `count(*)` of spans             | 0          | 0          | 0               | 0              | 0                   | yes              |
| 2 `service_name = 'api'`          | 0          | 1          | 1               | 0              | 1                   | yes              |
| 3 time range, a tenth, `GROUP BY` | 0          | 100        | 12              | 0              | 12                  | yes              |
| 4 `SELECT *` by `trace_id`        | 0          | 243        | 13              | 0              | 13                  | yes              |
| 5 `traces` newest 50              | 0          | 3          | 2               | 0              | 2                   | yes              |

`many` (99 flush partitions of 1,000 spans, never closed):

| statement                         | Node opens | Node reads | modelled ranges | Chromium HEADs | Chromium range GETs | within tolerance |
| --------------------------------- | ---------- | ---------- | --------------- | -------------- | ------------------- | ---------------- |
| 1 `count(*)` of spans             | 99         | 108        | 108             | 99             | 207                 | yes (306 = 306)  |
| 2 `service_name = 'api'`          | 99         | 199        | 199             | 99             | 298                 | yes (397 = 397)  |
| 3 time range, a tenth, `GROUP BY` | 99         | 108        | 108             | 99             | 207                 | yes (306 = 306)  |
| 4 `SELECT *` by `trace_id`        | 99         | 109        | 109             | 99             | 208                 | yes (307 = 307)  |
| 5 `traces` newest 50              | 99         | 99         | 99              | 99             | 198                 | yes (297 = 297)  |

Step 5, with the modelled counts: one partition of 16 row groups of 512, 2,048 and 8,192 rows and of 4 of 50,000 (Node,
cold; synthetic spans of `spansOnlyRequest`); modelled serial requests per row group, and the deviation from the
50,000-row file:

| rows per group | groups | st. 2 per group | deviation | st. 3 per group | deviation |
| -------------- | ------ | --------------- | --------- | --------------- | --------- |
| 512            | 16     | 0.125           | 83 %      | 0.063           | 94 %      |
| 2,048          | 16     | 0.250           | 67 %      | 0.125           | 88 %      |
| 8,192          | 16     | 0.500           | 33 %      | 0.250           | 75 %      |
| 50,000         | 4      | 0.750           | reference | 1.000           | reference |

No size is within 10 %. `ROW_GROUP_ROWS` is 8,192, the size with the smallest maximum deviation (75 %): provisional.
Requests per group grow with the column chunk size, which small groups of the synthetic spans do not reproduce.

## Expectations (Task 6)

Task 6 fills this table in PR 1 from `mise run predict:queries`; each later PR is held to its row (more than 20 %
above it is a stop). Cells are serial requests, dashboard / trace list.

| after PR      | rolling     | 30x150k       | 90x150k        | 30x1.5M         |
| ------------- | ----------- | ------------- | -------------- | --------------- |
| 1 (baseline)  | 2,533 / 4,672 | 3,572 / 6,459 | 10,850 / 18,979 | 8,002 / 27,277 |
| 3             | 2,197 / 772   | 3,092 / 999   | 9,410 / 2,599   | 7,522 / 757    |
| 4             | 1,291 / 545   | 1,825 / 675   | 5,610 / 1,628   | 848 / 199      |
| 6             | 841 / 199     | 1,200 / 199   | 3,733 / 199     | 669 / 199      |
| 8 (window 7d) | 841 / 199     | 1,030 / 199   | 3,123 / 199     | 7,158 / 199    |

Taken on 2026-11-11 from `mise run predict:queries` (rolling is the snapshot of that day, 21 partitions). Not yet a
usable bound: the live check of Task 6 step 5 found the baseline 2.8 and 4.4 times the requests Chromium made on the
live report (891 and 1,064), because the model adds the cold cost of every entry a page asks while the page opens each
file once; the 30x1.5M column also extrapolates the fitted line from 8 to 30 row groups. See the Task 6 report.
