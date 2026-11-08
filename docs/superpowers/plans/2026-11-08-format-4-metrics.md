# Format 4 Metrics Implementation Plan (plan 3 of the format-4 spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Metrics explorer, catalog, embedded grids and dashboard metric widgets (time charts and run charts) answer every question from SQL over the `points` view, exactly, in both output formats; the metric levels, segments, series cap and the chunk-era metric engine are gone from the viewer; and the partition writer meets the `test:load` memory targets for metrics (#227).

**Architecture:** `src/query/sql/points.ts` holds typed mosaic-sql builders for the shapes the metric pages need: the catalog (metric definitions, series identities, a sparkline), a per-metric `series` subquery (one row per `series_id` with its attributes, resource and scope, where the OTTL `where` and the `by` paths are evaluated, as the spec's "per series, not per point"), the aggregated cells per (`by` group, time bucket or run) with one aggregate shape per metric kind, the point interval that sets the bucket width, exemplars and runs. `src/viewer/data/duckdb-metrics.ts` runs them through the `QueryEngine` seam (D19) and `src/viewer/data/metric-results.ts` maps the Arrow rows into the result types the components already draw (`MetricQueryResult`, `SeriesPoints`, `RunQueryResult`): the `ƒ` list, formulas, histogram quantiles and the heatmap layout stay in TypeScript over those results. The writer adds per-bucket histogram deltas to `points` (closing R40) and bounds its memory: back-pressure on the library path, a byte estimate that counts every cell, compaction output written as it is encoded.

**Tech Stack:** TypeScript (strict), `@uwdata/mosaic-sql` 0.35.0, `@duckdb/duckdb-wasm` 1.32.0 (the Node build runs the data-layer tests), `parquet-wasm` 0.9.0 (`transformParquetStream` for streaming output), React 19, vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md` §6.1 (`points`), §6.4, §7.2, §10, §11 milestone 3, read with the "Record: rulings and notes for plan 3" at the end of `docs/superpowers/plans/2026-11-07-format-4-viewer.md` (the record wins over the spec) and plan 1's record in `docs/superpowers/plans/2026-11-06-format-4-writer.md` (R11 to R14, R21, R36 to R40). The metric semantics the pages keep are those of `docs/superpowers/specs/2026-10-27-otel-html-m3-design.md` §6.1 and `2026-10-31-metric-run-charts-design.md` §6, minus what format 4 removed (levels, segments, the series cap). Column names: `docs/format/schema.md`.

**Process:** unattended (`docs/agents/process-unattended.md`); PRs target `feat/format-4`, the next PR branches from the updated `feat/format-4`. Implementers and task reviewers on Sonnet 5.5, the branch review on Opus 5.5; each review's summary names its model. PR 6 edits `ci.yml`'s Playwright project selection for the metrics-scale job, which R90 allows (project and test selection only); its PR body lists the lines. The one open decision is PR 6's downsampled table (D33): stop and ask if the measurement forces it.

## Decisions this plan makes

The spec leaves these to the builder (§14 "metric levels dropped unless the scale budget forces a downsampled table", §15 "which metric `fn`s become SQL and which post-process") or says nothing. Each is applied where named; the maintainer can object at review. Numbering continues plan 2's D1 to D19.

- **D20 The catalog is SQL over `points`, not a sixth table.** `metricCatalog()` runs three statements once per report open (cached on the data source): the definitions (`GROUP BY metric_name, point_type, metric_unit, aggregation_temporality, is_monotonic` with `count(*)`, `count(DISTINCT series_id)`, `count(*) FILTER (WHERE reset)`, `FILTER (WHERE out_of_order)`, no-value points, `min(metric_description)`, `list(DISTINCT scope_name)`), the distinct series identities (`DISTINCT` over the definition columns, `attributes`, the resource columns, the scope columns; attribute keys and resources are derived from those texts in TypeScript, so no JSON function runs per point) and a 128-bucket sparkline per definition. Its cost is proportional to the points of the report, which the README's Limits say; the metrics-scale stand-in (0.76M points) measures it, the full 72M-point report would not meet the 1 s budget this way. The alternative, a writer-maintained `metrics` table per partition like `traces`, was rejected for this plan because a series count cannot be summed across partitions; it is the first candidate if the release measurement (session F) needs it, and PR 7's record says so.
- **D21 `MetricEntry` is the viewer's type.** `src/viewer/data/metric-catalog.ts` declares `MetricDef`, `MetricEntry` and `MetricCatalogData`; `src/rollups/metric-catalog.ts` and `value-buckets.ts` are deleted (PR 5) with the writer taking the series-identity helpers it uses. `MetricEntry` loses `folded` and `foldedEvicted` (no series cap in format 4: the Catalog shows the series count, never "+ other"), and `spark` becomes a plain `SparkBuckets` object. The kind tables (`kindOf`, `SHOW_BY_KIND`, `COMBINE`, `DEFAULT_SHOW`, `PERCENTILES`, `checkShow`, `metricTypeLabel`) stay in `metric-tables.ts`.
- **D22 Series first.** Every chart and run query starts from a `series` subquery: the distinct series of one metric definition in the pruned files, with the OTTL `where` as a SQL predicate on its columns and the `by` paths as expressions over them. Points join on `series_id`. This keeps the spec's rule that `where` is evaluated per series and makes the fallback for untranslatable terms cheap: the series rows (at most `RESIDUAL_SERIES_CAP` = 200 000, else the D5 `usage` error) are fetched, tested in the browser with `compileCondition(where, 'datapoint')` on a target built from the row, and the survivors' ids go through the D5 temp-table mechanism as `series_id IN (SELECT ...)`. The result carries `residual` (R74) and the pages show "Evaluated in the browser: <term>".
- **D23 Group keys are typed.** A `by` value is the JSON text of the path's value (`attributes["k"]` through `jsonAt`, a plain column through `to_json`), so int `1` and string `"1"` stay distinct groups, as `metric-where.ts`'s `typed` did; the mapper decodes with `anyValueFromJson` for the label (`(none)` for SQL NULL). The group key is `JSON.stringify([[path, jsonText], ...])`.
- **D24 Bucket width without levels.** `pick` is the smallest `1 ms × 2^k` with `floor(end / w) - floor(start / w) + 1 <= maxPoints` over the window; `interval` is the upper median of the first 32 gaps of up to 64 series (sampled by `hash(series_id)`), 0 under 8 gaps (`pointIntervalQuery`, median computed in TypeScript as `pointIntervalNs` does today); the width is `pick` when `interval <= pick`, else `ceil(interval / pick) × pick`. This reproduces the old answers (10 s points over 1 h at 600 or 1 100 points: 16.384 s; 100 s of 10 s points: 10.24 s). A formula re-runs its operands at exactly the coarsest operand width (`widthNs` in the request), as `runMetricQueryAtWidth` did.
- **D25 One aggregate shape per kind, in SQL.** counter: `sum(delta_value)` per cell, resets counted; number (gauge, non-monotonic sum): per (series, cell) `avg`, `min`, `max`, `arg_max(value_double, time_unix_nano)`, then across series per `COMBINE.number.byShow` (`mean`, `min`, `max`, `sum`); hist: `sum(delta_count)`, `sum(delta_value)`, `min(min)`, `max(max)` and the elementwise sum of `delta_bucket_counts` (`unnest ... WITH ORDINALITY`, grouped by index, `list(... ORDER BY idx)`), one group per `explicit_bounds` set (the bounds-differ note when a by-group has several); exp: merged at the smallest `delta_scale` of the cell (index `>> (scale - min_scale)`), the mapper applies `downscaleExp` to at most 160 buckets per side and `quantileOf`; summary: never combined, per (series, cell) `arg_max(count | sum | quantiles, time_unix_nano)` and the points per cell (more than one gives the "quantiles from the last point per bucket" note). The counter running total (`show: sum`) adds a baseline cell for the deltas before the window (one query, the pre-window rows bucketed as cell `-1`), then the cumulative sum runs in the mapper.
- **D26 `ƒ`, formulas, quantiles and the heatmap stay in TypeScript.** `applyFns` (rate, increase, rollup, top, bottom), `evaluateFormula`, `quantileOf`, `downscaleExp`, `histogramViews` and the dense-frame construction run over the cells SQL returns (at most groups × `maxPoints` cells). Nothing is gained by SQL window functions here and the tests of those modules stand.
- **D27 Exemplars are read per query.** `exemplarsQuery` returns (group, relative time, `exemplars` JSON) for the kept groups' points in the window that carry exemplars, oldest first, at most `EXEMPLAR_ROWS_CAP` = 5 000 rows; the mapper keeps at most 4 per (group, bucket), those with a trace id first, then the largest absolute value, and notes "exemplars capped" when the cap was hit. The explorer's `exemplars` toggle and the widget's `exemplars` flag skip the query when off.
- **D28 Run charts are cells by run.** `metricRunQuery` uses the same cell builder with the cell being the `runBy` value (a `by` expression) instead of a time bucket: runs are the distinct values whose latest point (`max(time_unix_nano)`) lies in the window, ordered by time then id; a line's `failed` mark comes from a second cells query over the series `failedWhen` keeps; `revision` is `arg_max(json_extract_string(resource_attributes, '/vcs.ref.head.revision'), time_unix_nano)` per run; series with a NULL or empty run value count in `leftOut` and the note.
- **D29 Resources by stored text.** The catalog keeps, per resource record (deduplicated by `resourceKey`), every stored `resource_attributes` text that decodes to it. `metricsForResources(resources)` answers from the catalog (entries whose resources match by `resourceKey`); the grid narrows a query with `resources` (catalog indexes) and the data source adds `resource_attributes IN (<texts>)` to the series subquery. Resources that differ only in `schema_url` or dropped count are not told apart here (noted in the README).
- **D30 Data-source API.** `DataSource` gains `metricQuery(req, signal)`, `metricRunQuery(req, signal)` and `metricShowOptions(entryId)`; `metricCatalog()` returns `MetricCatalogData`; `metric(id)` and `LoadedMetric` go (PR 5). `MetricQueryResult`, `SeriesPoints` and `RunQueryResult` keep their shapes, so `metric-chart-card.tsx`, `metric-chart-option.ts`, the run-chart components, `export.ts`, `plots.ts`, `metric-fn.ts` and `metric-formula.ts` do not change.
- **D31 Writer memory (#227).** Three causes, three fixes: the library path (`Report.addMetrics`, `flush`) never waits for an in-flight checkpoint, so held rows grow without bound while one runs: `add` awaits the in-flight checkpoint when the held bytes reach `chunkTargetBytes` and cuts after it; the byte estimate ignores numeric, bigint and boolean cells (a 40-column `points` row counts as 64 bytes plus its strings): every fixed-width cell counts 8 bytes; `encodeBatches` collects the whole compressed file before `writeBytes`: the `FileSystem` port gains `writeByteChunksAtomic?(p, chunks)` and compaction writes each merge round and the final file as the stream yields them (also the open part of #210). Fan-out and reader batch size are the implementer's knobs; `mise run test:load` under 512 MB for all three workloads is the acceptance, and the API test asserts it instead of printing it.
- **D32 Per-bucket histogram deltas (R40).** `points` gains `delta_bucket_counts` (list_int64), `delta_scale` (int32), `delta_zero_count` (int64), `delta_positive_offset` (int32), `delta_positive_counts` (list_int64), `delta_negative_offset` (int32), `delta_negative_counts` (list_int64), filled for the points whose `delta_count` is filled from the normalizer's `HistAgg` / `ExpAgg`, null otherwise. Format 4 is unreleased, so the column add needs no version bump; `docs/format/schema.md` is regenerated.
- **D33 No downsampled table unless measured.** The metrics-scale report is written in `site` format and measured over HTTP (`chromium-perf-http`), as the spec's §13 decision says for the scale reports. If the Explorer's first chart exceeds 2 s median or the Catalog 1 s after the obvious fixes (pruning by `metric_name` statistics, row-group statistics, the three catalog statements in parallel), the implementer stops and asks whether to add a writer-produced `points_1m` table (spec §6.4) or to raise the budget to twice the median (R85's rule); the plan does not pre-decide.
- **D34 Unfinished reports are exact.** A report with several `points` partitions (not closed, `many`-shaped, or merged) is queried like any other; there is no "merged from flush segments" note, and the e2e test that asserted it asserts a chart over several partitions instead.

## Plans for this spec

Plan 1 (writer), plan 2 (viewer) are merged; this is plan 3 (§6.4 and §7.2 for metrics, milestone 3); plan 4 is `host` (session E); session F opens the release PR once this plan is merged; the publishing plan (session G) follows.

## Global Constraints

- Plan 2's constraints hold: Mosaic pinned exact, `@uwdata/mosaic-sql` only under `src/query/sql/` and `src/viewer/data/`, `@uwdata/mosaic-core` only in `mosaic.ts`, `@duckdb/duckdb-wasm` only under `src/viewer/data/engine/` and `mosaic.ts`, `apache-arrow` never under `src/viewer` or `src/query` (R62); components, pages and state never import `@uwdata/*` or `@duckdb/*`.
- Queries name only the five views and the two virtual columns; every time column is selected relative to the epoch (D2); the only DDL is the view creation and the D5 temp table.
- `MetricQuery`, `MetricFormula`, `MetricPageState` (`src/query/metric-query.ts`) and the dashboard metric widget schema (`src/dashboards/schema.ts`) do not change: every URL and config that works today keeps working.
- `MetricQueryResult`, `SeriesPoints`, `RunQueryResult`, `RunLine`, `RunInfo` keep their shapes (D30).
- Format 4 may gain columns (D32) but keeps five views; `docs/format/schema.md` is regenerated in the same commit (`mise run gen`, checked by `gen:check`).
- Writer memory targets (spec §10): 1M logs, `convert` of 200 × 1 000 × 360 points and `Report.addMetrics` of the same under 512 MB RSS (`mise run test:load`); the receiver load test re-run and cited.
- e2e budgets (D15, R85): twice the measured median over three runs on the development machine, never above the format-3 value; a budget that cannot meet that is a stop-and-ask (D33) and goes to #229.
- Engineering standards of plans 1 and 2: strict TS, no `any`, typed `OtelHtmlError`s, injected deps, Biome clean, README in the PR that changes behaviour, TDD per task, `mise run check` before every push, the Chromium e2e suite before every PR. No new dependency.

## Review Focus

1. A cumulative counter that resets inside the window, and one whose points all precede the window: `rate` and `increase` show the reset point's own value with the note "1 counter reset in range"; `sum` (running total) includes the pre-window deltas of both series; a window that starts between two points of a series gives no phantom first bucket. (Task 4.3)
2. `where` and `by` on attribute keys containing `/`, `~`, `"` and on tagged values (`{"$i":"9007199254740993"}`, `{"$d":"3"}`): `attributes["k"] == 3` keeps the same series in SQL as `compileCondition` does, and `by: attributes["k"]` keeps int `1` and string `"1"` as two groups. (Tasks 3.1, 4.3)
3. Two histogram series with different `explicit_bounds` in one by-group, and two exponential histograms at scales 3 and 5: the first gives two lines labelled by bounds and the note, no heatmap; the second gives one line merged at scale 3 and a heatmap; p95 of a merged explicit histogram equals `quantileOf` over the summed counts. (Task 4.3)
4. A report whose `points` sit in three partitions (unclosed, or merged): the catalog's series count is the distinct count across files, a summary's quantile options come from every partition, and a window spanning two partitions charts both. (Tasks 4.2, 4.3)
5. A `where` with a converter SQL cannot express (`IsMatch(attributes["k"], "^a.*")` is translatable; `Len(attributes["k"]) > 2` is not): the series are filtered in the browser, the chart equals the all-SQL chart over the same series, the note says "Evaluated in the browser: Len(...) > 2"; with more than 200 000 series it fails with the D5 `usage` message. (Task 4.3)

---

## PR 1: Histogram bucket deltas on `points`; a flush that fails after a partial write

Branch `feat/format-4-points-deltas` from `feat/format-4`. Title: `feat(format): per-bucket histogram deltas on points; a flush that fails after a partial write stays valid`.

### Task 1.1: The delta bucket columns

**Files:**
- Modify: `src/format/parquet/columns.ts` (the `points` table, after `delta_count`), `src/format/parquet/rows.ts` (`applyNormalization`, `pointRow`), `src/writer/partition-checkpoint.ts` (`PointNormalization`, `UNNORMALIZED`, `pointNormalization`), `docs/format/schema.md` (generated)
- Test: `test/writer/points-table.test.ts`, `test/format/parquet/codec-reference.test.ts` (only if its fixture holds points)

**Interfaces:**
- Produces: `PointNormalization` gains `deltaBuckets: { bucketCounts: readonly number[] } | { scale: number; zeroCount: number; positiveOffset: number; positiveCounts: readonly number[]; negativeOffset: number; negativeCounts: readonly number[] } | null`; the seven columns of D32 in `TABLE_COLUMNS.points`, in that order after `delta_count`, all nullable.

- [ ] **Step 1: Write the failing tests** in `points-table.test.ts`: a cumulative explicit histogram with two points (counts `[1, 2, 0]` then `[2, 5, 1]`) writes `delta_bucket_counts` `[1, 2, 0]` then `[1, 3, 1]` and null `delta_scale`; a cumulative exponential histogram whose second point has a finer scale writes the delta at the normalizer's common scale (`delta_scale` equal to the coarser one, offsets and counts as `mergeAgg`'s difference gives them) and null `delta_bucket_counts`; a gauge, a summary and an out-of-order point write null for all seven; a reset point writes its own counts.
- [ ] **Step 2: Run** `pnpm exec vitest run test/writer/points-table.test.ts`; expected FAIL (unknown columns).
- [ ] **Step 3: Implement**: the columns in `columns.ts`; `pointNormalization` fills `deltaBuckets` from `agg.k === 'hist'` (`counts`) and `agg.k === 'exp'` (`scale`, `zeroCount`, `positive`, `negative`); `applyNormalization` writes the seven cells (BigInt for int64 cells, as `countColumn` does); `mise run gen` regenerates `docs/format/schema.md`.
- [ ] **Step 4: Run** the test; expected PASS. `mise run check` PASS (if `codec-reference.test.ts` fails because its fixture has points, regenerate the reference and say so in the commit body; R38's guard is for the arrow encoding, not the column set).
- [ ] **Step 5: Commit** `feat(format): points carry per-bucket histogram deltas (R40)`

### Task 1.2: A flush that fails between two tables

**Files:**
- Test: `test/writer/partition-crash.test.ts`

- [ ] **Step 1: Write the failing test**: a session with logs and metrics held, `failNextWrite('000001/points.parquet')` (memory-fs), `flush()` rejects; the manifest still lists partition 0 only, `logs.parquet` of partition 1 exists on disk but is not listed; a retry `flush()` writes partition 1 with both tables and the same rows (R22: the rows went back), and `metric-streams` state was not advanced twice (the second point's delta is unchanged, as `points-table.test.ts:403` checks for points alone); the reopened report prunes nothing it lists.
- [ ] **Step 2: Run**; expected PASS or FAIL. If it fails, fix the cut's rollback for the mixed case in `PartitionWriter.cut` (`src/writer/partition-writer.ts`) and record the fix in the PR body under **Also**.
- [ ] **Step 3: Commit** `test(writer): a flush that fails after logs were written leaves the report valid and retries whole`

### PR 1 close

- [ ] `mise run verify`; PR; body notes D32 and the parked note 7 of plan 2's record. Branch review on Opus 5.5. Merge.

---

## PR 2: The points path within the memory targets

Branch `fix/format-4-points-memory` from `feat/format-4`. Title: `fix(writer): the points path stays within the test:load memory targets`. Fixes #227; re-measures #210 and closes it if the Bun site convert is under the chunk-era figure.

### Task 2.1: Back-pressure on the library path

**Files:**
- Modify: `src/writer/partition-session.ts` (`add`, `#maybeCheckpoint`, `#acceptPoints`)
- Test: `test/writer/background-checkpoint.test.ts`

**Interfaces:**
- Consumes: `#inflight`, `#cutPartial`, `PartitionWriter.pendingBytes`, memory-fs `holdNextWrite(pathSuffix)` (`test-support/memory-fs.ts`).
- Produces: `add()` resolves only after the writer's held bytes are below `2 × chunkTargetBytes`; the rule is written in the method's doc comment.

- [ ] **Step 1: Write the failing test**: hold the write of partition 1's `points.parquet`; add metrics (non-partial) until `pendingBytes` passes `chunkTargetBytes` while the checkpoint is in flight; assert `add` does not resolve before the held write is released and that, once released, the writer's held bytes never exceeded `2 × chunkTargetBytes` (observe `pendingBytes` after each `add`).
- [ ] **Step 2: Run**; expected FAIL (held bytes grow without bound).
- [ ] **Step 3: Implement**: in `add`, after staging, when `pendingBytes >= chunkTargetBytes` and `#inflight !== null`, `await this.#inflight` (errors already go through `#dirty`), then `#maybeCheckpoint()`; the partial path is unchanged.
- [ ] **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `fix(writer): add waits for the in-flight checkpoint once the held rows reach the target`

### Task 2.2: Every cell counts

**Files:**
- Modify: `src/writer/partition-writer.ts` (`#estimate` or where `ROW_OVERHEAD_BYTES` is applied)
- Test: `test/writer/partition-writer.test.ts`

- [ ] **Step 1: Write the failing test**: a `points` row with no strings beyond the identity columns estimates at least `64 + 8 × <number of non-null fixed-width cells>`; a spans row's estimate grows by 8 per numeric cell against today's value (assert the exact number for one row).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** (`FIXED_CELL_BYTES = 8` for number, bigint and boolean cells; the doc comment of `pendingBytes` updated). **Step 4: Run**; PASS.
- [ ] **Step 5: Commit** `fix(writer): the flush-by-size estimate counts fixed-width cells`

### Task 2.3: Compaction output written as it is encoded

**Files:**
- Modify: `src/writer/ports.ts` (`FileSystem.writeByteChunksAtomic?`), `src/writer/node-fs.ts`, `test-support/memory-fs.ts`, `src/format/parquet/stream.ts` (`encodeBatches` returns `AsyncIterable<Uint8Array>`), `src/writer/compaction.ts` (`mergeFiles`, the final round)
- Test: `test/format/parquet/stream.test.ts`, `test/writer/compaction.test.ts`, `test/writer/node-fs.test.ts`

**Interfaces:**
- Produces: `writeByteChunksAtomic?(p: string, chunks: AsyncIterable<Uint8Array>): Promise<void>` (temp file then rename, as `writeTextAtomic`; the memory fs records the chunk count); `encodeBatches(table, batches, opts): AsyncIterable<Uint8Array>`; a helper `writeChunks(fs, p, chunks)` in compaction.ts that falls back to collecting and `writeBytes` when the fs lacks the method.

- [ ] **Step 1: Write the failing tests**: the bytes written through `writeByteChunksAtomic` equal `concat` of the chunks and a failure mid-stream leaves no file at `p`; a two-file merge through the chunked path produces bytes identical to the collected path (same statistics fold, same row count); the memory fs saw more than one chunk for a merge over 2 × 4 096 rows.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS; `mise run check` PASS.
- [ ] **Step 5: Commit** `fix(writer): compaction writes each merge round and the final file as the stream yields them`

### Task 2.4: Measure and tune

**Files:**
- Modify: `test/writer/metric-memory.test.ts` (the API test asserts `peakBytes < MAX_RSS_BYTES`), `src/writer/compaction.ts` (`FANOUT`, `READ_BATCH_ROWS` in `src/format/parquet/stream.ts`) if the measurement asks, `README.md` Limits (the metric figures)

- [ ] **Step 1**: the API test's assertion (it fails today with an out-of-memory crash; the CLI test fails with 4.6 GB).
- [ ] **Step 2**: `mise run test:load` (about an hour on the development machine). Expected: all three under 512 MB. If `convert` is not, lower `READ_BATCH_ROWS` (32 768 to 8 192) and raise `FANOUT` (8 to 16) so the merge readers hold under 100 MB together, and re-run. Record `MAXRSS` of each workload, the wall time and the number of flush partitions in the PR body.
- [ ] **Step 3**: `mise run test:load:receiver`; record the peak RSS against the 749 MB of PR 6 of plan 2 and the 512 MB target; cite #210. `mise run bench:metrics --runs 1` (ingest and close time) against plan 1's figure, so the back-pressure did not cost throughput.
- [ ] **Step 4**: the README's Limits paragraph for metrics (line about 636) carries the new figures and drops "runs out of memory".
- [ ] **Step 5: Commit** `test(writer): the API metrics load test asserts the 512 MB target; measured figures`

A measurement still over 512 MB after the tuning is a stop-and-ask (process rule), with the figures.

### PR 2 close

- [ ] `mise run verify`; PR; body: the three fixes, every figure of Task 2.4, `Fixes #227`, #210's new figure (close it there if under 489 MB). Branch review on Opus 5.5. Merge.

---

## PR 3: Metric queries over `points`; OTTL datapoint conditions as SQL

Branch `feat/format-4-points-sql` from `feat/format-4`. Title: `feat(query): metric catalog, series, cell, interval, exemplar and run queries over points; datapoint OTTL as SQL`.

Nothing in the viewer changes in this PR; the builders are tested with the DuckDB Node build over `buildFormat4Report` fixtures.

### Task 3.1: The datapoint context

**Files:**
- Modify: `src/query/sql/columns.ts` (`SqlContext` gains `'datapoint'`, `PATH_COLUMNS.datapoint`, `UNMAPPED_PATHS.datapoint`), `src/query/sql/ottl.ts` (`eqHint`: `metric.name` hints `metric_name`; `textPredicate` returns null for `datapoint`), `src/query/sql/filter.ts` (`FilterOptions.table` gains `'points'`; `whereOf(f, 'points')` adds `time_unix_nano BETWEEN lo AND hi`)
- Test: `test/query/sql/ottl.test.ts`, `test/query/sql/ottl-equivalence.test.ts`, `test/query/sql/columns.test.ts`

**Interfaces:**
- Produces: `PATH_COLUMNS.datapoint`: `metric.name` → `metric_name` (string), `metric.description` → `metric_description` (string, nullAsEmpty), `metric.unit` → `metric_unit` (string, nullAsEmpty), `attributes` → json, plus `SHARED`. `start_time_unix_nano`, `time_unix_nano`, `flags` are in `UNMAPPED_PATHS.datapoint` (the schema rejects them before translation, `rejectPerPointPaths`).

- [ ] **Step 1: Write the failing tests**: `translateCondition('metric.name == "a" and attributes["k"] == 3', 'datapoint')` gives a predicate, no residual and hints `{ metric_name: {"a"} }`; `resource.attributes["service.name"] == "x"` hints `service_name`; `Len(attributes["k"]) > 2` is residual; the equivalence test runs the datapoint translation and `compileCondition(..., 'datapoint')` over series rows with keys containing `/`, `~`, `"` and tagged values and asserts the same `series_id`s; `columns.test.ts` asserts every `CONTEXTS.datapoint.paths` key is mapped or listed unmapped.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS; `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(query): OTTL datapoint conditions translate to SQL over the series columns`

### Task 3.2: Fixture builders for every point kind

**Files:**
- Modify: `test-support/otlp-builders.ts`

**Interfaces:**
- Produces: `sum(name, dataPoints, opts: { monotonic: boolean; temporality: 'cumulative' | 'delta'; unit?: string })`, `histogram(name, dataPoints, opts: { temporality; unit? })` (points carry `explicitBounds`, `bucketCounts`, `count`, `sum`, optional `min`/`max`/`exemplars`), `expHistogram(name, dataPoints, opts)` (`scale`, `zeroCount`, `positive`/`negative` `{ offset, bucketCounts }`), `summary(name, dataPoints)` (`quantileValues`), beside the existing `gauge`; and `pointsAt(ms: number[], value: (i) => JsonObject, attrs?)` for time series in a request. Each returns OTLP JSON as `metricsRequest` takes it.

- [ ] **Step 1**: a test in `test/test-support/otlp-builders.test.ts` writes one request of each kind through `buildFormat4Report` and asserts `manifest.totals.metrics` and one `point_type` per kind in the `points` view (`openFixtureDb`).
- [ ] **Step 2 to 4** as above. **Step 5: Commit** `test(support): OTLP builders for sums, histograms, exponential histograms and summaries`

### Task 3.3: Catalog queries

**Files:**
- Create: `src/query/sql/points.ts`
- Test: `test/query/sql/points.test.ts`

**Interfaces:**
- Produces, all returning mosaic-sql `Query`:
  - `metricDefsQuery(): Query`: one row per (`metric_name`, `point_type`, `metric_unit`, `aggregation_temporality`, `is_monotonic`) with `description` (`min(metric_description)`), `points`, `series` (`count(DISTINCT series_id)`), `resets`, `out_of_order`, `no_value` (`point_type IN ('gauge','sum') AND value_double IS NULL`), `scopes` (`list(DISTINCT scope_name ORDER BY scope_name)`), ordered by the five identity columns.
  - `metricIdentitiesQuery(): Query`: `DISTINCT` rows of the five identity columns plus `attributes`, `resource_attributes`, `resource_schema_url`, `resource_dropped_attributes_count`, `scope_name`, `scope_version`, `scope_attributes`, `scope_schema_url`, `scope_dropped_attributes_count`, `explicit_bounds`.
  - `metricSparkQuery(spec: BucketSpec, epoch: bigint): Query`: per identity and `bucket` (`bucketExpr('time_unix_nano', spec, epoch)`): `sum` of the natural value (`CASE point_type WHEN 'sum' THEN CASE WHEN is_monotonic THEN delta_value ELSE value_double END WHEN 'gauge' THEN value_double WHEN 'summary' THEN count ELSE delta_count END`) and `n` (rows with a non-null natural value). `bucketSpec` is called with `MAX_BUCKETS` 128 (a new optional argument of `bucketSpec(window, range, maxBuckets = 4096)` in `time.ts`).
  - `summaryQuantilesQuery(identity: MetricIdentity): Query`: the distinct `q` values over the metric's `quantiles` JSON, ascending.
  - `export interface MetricIdentity { name: string; type: string; unit: string | null; temporality: number | null; monotonic: boolean | null }` (the stored values: `point_type` as `pointRow` writes it, `aggregation_temporality` as OTLP's number) and `identityTerms(id: MetricIdentity): ExprNode[]` (IS NOT DISTINCT FROM for the nullable ones). The mapping to `MetricDef`'s `type` and `temporality` is the viewer's (Task 4.2).

- [ ] **Step 1: Write the failing tests** over a fixture with two partitions (built with `close: false`), one gauge seen in both partitions by two series, a counter with a reset, a summary with quantiles 0.5 and 0.99 in different partitions, two resources: defs rows, the distinct series count across partitions (not the sum), the scopes list, the identities' row count, the spark buckets' sums, the summary quantiles `[0.5, 0.99]`.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(query): the metric catalog's definitions, series identities and sparkline from points`

### Task 3.4: Series, `by` and the point interval

**Files:**
- Modify: `src/query/sql/points.ts`
- Test: `test/query/sql/points.test.ts`

**Interfaces:**
- Produces:
  - `export interface ByExpr { src: string; expr: ExprNode; identity: boolean }`; `byExpr(path: string): ByExpr`: the path through `compileBy` for validation, then `attributes["k"...]` → `CAST(jsonAt('attributes', keys) AS VARCHAR)`, `resource.attributes[...]` and `instrumentation_scope.attributes[...]` likewise, a scalar path of `PATH_COLUMNS.datapoint` → `to_json(<column>)`; `invalid-ottl` otherwise.
  - `seriesQuery(opts: { identity: MetricIdentity; files: Pruned; where: ExprNode | null; resourceTexts: readonly string[] | null; seriesIds: Query | null; by: readonly ByExpr[] }): Query`: `DISTINCT` over `series_id`, the identity columns listed in Task 3.3 and `g0..gN` (`by[i].expr`), from `points` with `identityTerms`, `filename IN` (unless all), `where`, `resource_attributes IN (texts)`, `series_id IN (seriesIds)`.
  - `pointIntervalQuery(series: Query, files: Pruned, window: AbsWindow | null): Query`: for a sample of at most 64 series (`ORDER BY hash(series_id) LIMIT 64`), the first 32 gaps `time_unix_nano - lag(time_unix_nano) OVER (PARTITION BY series_id ORDER BY time_unix_nano)` of each in the window, as rows `gap` (BIGINT, non-null).

- [ ] **Step 1: Tests**: `byExpr('attributes["k"]')` groups int `1` and string `"1"` apart (two series rows with `g0` `1` and `"1"`); `where` keeps the matching series only; `resourceTexts` narrows; `pointIntervalQuery` over 10 s points returns 32 gaps of `10_000_000_000n` per sampled series and none for a single-point series.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(query): a metric's series with their by values, and the sampled point interval`

### Task 3.5: Cells per kind, exemplars and runs

**Files:**
- Modify: `src/query/sql/points.ts`
- Test: `test/query/sql/points.test.ts`

**Interfaces:**
- Produces:
  - `export type Cell = { kind: 'time'; widthNs: number; baseline: boolean } | { kind: 'run'; run: ByExpr }`; `cellExpr(cell, epoch)`: for `time`, `floor(relTime / w) * w` with the non-negative modulo of `bucketExpr`, and `-1` for rows before the window when `baseline` (the window's lower bound is then dropped from `whereOf`); for `run`, the run expression's text.
  - `metricCellsQuery(opts: { kind: MetricKind; show: string; series: Query; files: Pruned; window: AbsWindow | null; cell: Cell; epoch: bigint; byCount: number }): Query`, rows per (`g0..gN`, `cell`, and `bounds` for `hist`, `series_id` for `summary`) with the columns of D25: counter `delta`, `resets`, `n`; number `value` (the `show`'s across aggregate over per-series values), `n`; hist `count`, `sum`, `min`, `max`, `counts` (list), `bounds`; exp `count`, `sum`, `min`, `max`, `scale` (the cell's minimum), `zero_count`, `positive` and `negative` as `list(struct(idx, cnt))` at that scale, `zero_threshold` (max); summary `count`, `sum`, `quantiles` (JSON), `points`. Ordered by the group columns then `cell`.
  - `exemplarsQuery(series: Query, files: Pruned, window: AbsWindow | null, epoch: bigint, limit: number): Query`: (`g0..gN`, `time_ns` relative, `exemplars`) for rows with `exemplars IS NOT NULL`, oldest first, `LIMIT limit`.
  - `runsQuery(series: Query, files: Pruned, epoch: bigint): Query`: per `run` (`g0` of the series query built with the `runBy` expression): `t` (`max` relative time), `revision` (D28), `n_series`; plus one row with `run IS NULL` counting the series with a NULL or empty run value (`left_out`).

- [ ] **Step 1: Tests** (one fixture, 10 s points, two series per kind): counter cells of 20 s sum two deltas; a reset is counted; the baseline cell `-1` holds the pre-window deltas; number `last` across two series sums their last values and `avg` means them; hist cells sum `delta_bucket_counts` elementwise and keep one row per bounds set; exp cells at scales 3 and 5 come back at scale 3 with the finer one's indexes halved twice; summary cells carry the last point's quantiles and `points` 2 when two points fall in one cell; exemplars rows with the limit; runs with `t`, `revision` and the left-out count.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(query): metric cells per kind, exemplars and runs over the series of a metric`

### PR 3 close

- [ ] `mise run verify`; PR; body notes D22 to D25, D27, D28 and the test fixture. Branch review on Opus 5.5. Merge.

---

## PR 4: The metric data layer

Branch `feat/format-4-viewer-metrics-source` from `feat/format-4`. Title: `feat(viewer): metric catalog, chart and run queries answered from points behind the query-engine seam`.

Nothing in the UI or in `DataSource` changes in this PR (R60's rule: the old engine keeps compiling on its old types until PR 5 replaces both at once). The new layer is `metricMethods(ctx)`, tested directly through the Node engine; PR 5 puts its members on `DataSource`.

### Task 4.1: Types and the width rule

**Files:**
- Create: `src/viewer/data/metric-catalog.ts`, `src/viewer/data/metric-results.ts`
- Modify: `src/viewer/data/metric-tables.ts` (`NOTES` gains `residual: (term: string) => \`Evaluated in the browser: ${term}\`` and `exemplarsCapped: 'exemplars capped: the oldest 5 000 exemplar points are shown'`; the four notes format 4 cannot raise go in PR 5 with the engine)
- Test: `test/viewer-data/metric-results.test.ts`

**Interfaces:**
- Produces, in `metric-catalog.ts`:
  ```ts
  export interface MetricDef { id: number; name: string; description: string; unit: string; type: MetricPointRecord['type']; temporality: MetricPointRecord['temporality']; monotonic: boolean }
  export interface SparkBuckets { widthNs: number; startNs: number; sums: number[]; counts: number[] }
  export interface MetricEntry extends MetricDef { conflicting: boolean; scopes: string[]; attributeKeys: string[]; resources: number[]; series: number; points: number; resets: number; outOfOrder: number; noValue: number; spark: SparkBuckets }
  export interface MetricCatalogData { entries: readonly MetricEntry[]; resources: readonly ResourceRecord[]; scopes: readonly ScopeRecord[] }
  ```
  `id` is the entry's index in `entries` (ordered by name, type, unit, temporality, monotonic); `conflicting` is true when another entry shares the name. `MetricDef` is structurally the one `rollups/metric-catalog.ts` declares today, so `metric-tables.ts`'s `kindOf` and `metricTypeLabel` accept both until PR 5.
- In `metric-results.ts`: `MetricQueryResult`, `SeriesPoints`, `RunInfo`, `RunLine`, `RunQueryResult` (copied from `metric-query.ts` and `metric-run-query.ts`; the originals go in PR 5), `SeriesRow` (one decoded row of `seriesQuery`: `seriesId`, `attributes`, `resource: ResourceRecord`, `scope: ScopeRecord`, `bounds: number[] | null`, `groups: (string | null)[]`), `resolveMetric(catalog: MetricCatalogData, q: Pick<MetricQuery, 'metric' | 'kind' | 'unit'>)`, and:
  ```ts
  export interface MetricQueryRequest { entry: MetricEntry; query: MetricQuery; window: TimeWindow; maxPoints: number; widthNs?: number; resources?: readonly number[]; exemplars: boolean }
  export interface MetricRunQueryRequest { entry: MetricEntry; query: MetricQuery; window: TimeWindow; runBy: string; failedWhen: string | null; resources?: readonly number[] }
  export function pickWidthNs(window: TimeWindow, maxPoints: number): number        // the smallest 1 ms × 2^k with bucketsOver <= maxPoints
  export function chartWidthNs(pick: number, intervalNs: number): number           // D24
  export function upperMedian(gaps: readonly number[]): number                      // 0 under 8 gaps
  ```
- `export interface MetricMethods { metricCatalog(): Promise<MetricCatalogData>; metricShowOptions(entryId: number): Promise<readonly string[]>; metricQuery(req: MetricQueryRequest, signal?: AbortSignal): Promise<MetricQueryResult>; metricRunQuery(req: MetricRunQueryRequest, signal?: AbortSignal): Promise<RunQueryResult>; metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]> }` in `metric-results.ts`; PR 5 makes `DataSource` extend it.

- [ ] **Step 1: Tests**: `pickWidthNs({0, 3_600e9}, 600)` is `8_192e6`; `chartWidthNs(8_192e6, 10e9)` is `16_384e6`; `chartWidthNs(256e6, 10e9)` is `10_240e6`; `upperMedian` of 7 gaps is 0, of `[1, 2, 3, 4]` is 3.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(viewer): metric catalog and request types; the bucket width without levels`

### Task 4.2: The catalog on the data source

**Files:**
- Create: `src/viewer/data/duckdb-metrics.ts`
- Modify: `src/viewer/data/metric-results.ts` (`catalogFrom(defs: Table, identities: Table, spark: Table, spec: BucketSpec): MetricCatalogData & { resourceTexts: readonly string[][] }`, `summaryShowOptions(t: Table): string[]`)
- Test: `test/viewer-data/duckdb-source-metrics.test.ts` (calls `metricMethods` directly over `openFixtureDb` and `mosaicQueryEngine`, as `duckdb-source-logs.test.ts` builds its engine)

**Interfaces:**
- Produces: `metricMethods(ctx: { engine: QueryEngine; manifest: ManifestV4; epoch: bigint; range: RelWindow | null }): MetricMethods`; the catalog is one memoised promise (a rejection clears it); `attributeKeys` are the sorted union of the keys of the metric's distinct `attributes` texts (`anyValueFromJson`); `resources` are the indexes of the distinct records (by `resourceKey`, which moves from `metric-load.ts` to `metric-catalog.ts`); `metricShowOptions` is `SHOW_BY_KIND[kind]` except summaries: `q<quantile>` per `summaryQuantilesQuery` value then `count`, `sum`; `metricsForResources` filters entries by `resourceKey` membership.

- [ ] **Step 1: Tests** over a fixture of all five kinds in two uncompacted partitions and two resources (the Review Focus 4 shape): `entries` ordered and ids sequential, `conflicting` for a name with two units, `series` the distinct count, `attributeKeys`, `resources` indexes and `catalog.resources` records, `scopes.length`, `spark` with 128 buckets at most; `metricShowOptions` of the summary `['q0.5', 'q0.99', 'count', 'sum']`; `metricsForResources([resourceB])` lists only the metrics with a series on B; one statement for `metricShowOptions`, three for the catalog (count the engine's `query` calls).
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(viewer): the metric catalog, show options and resources from points`

### Task 4.3: Chart and run queries on the data source

**Files:**
- Modify: `src/viewer/data/duckdb-metrics.ts`, `src/viewer/data/metric-results.ts` (`seriesFrom(kind, show, cells: Table, frame, by, unit)`, `exemplarsFrom(t, by)`, `runsFrom(runs: Table, cells: Table, failed: Table | null)`, `seriesTarget(entry: MetricDef, row: SeriesRow): DatapointTarget` for the residual test, built as `metric-where.ts`'s `targetOf` builds one), `src/viewer/data/residual.ts` (`residualIdTable` generalised to `idTable(engine, columns: readonly string[], rows: readonly (string | number)[][])`; `duckdb-source.ts`'s `withIds` calls it with `['filename', 'file_row_number']`)
- Test: `test/viewer-data/duckdb-source-metrics.test.ts`

**Interfaces:**
- Consumes: Task 3.4 and 3.5 builders, `applyFns`, `evaluateFormula` (unchanged), `histogramViews`, `quantileOf`, `downscaleExp`, `buildFilter({ table: 'points', condition: q.where, text: '', window })` for the translation, hints and pruning (spans/traces prune on the upper bound only, points on both: `prunePartitions` already does).
- Produces: `metricQuery` runs, in order: the filter (translation of `where`; the residual path of D22 when `residual !== null`), `pointIntervalQuery` unless `req.widthNs` is given, then in parallel the cells query (with the baseline when `kind === 'counter' && show === 'sum'`), the exemplars query when `req.exemplars`; the mapper builds the dense frame from the first to the last cell, applies `applyFns(series, widthNs, q.fn)`, drops exemplars of groups `top`/`bottom` removed, builds `heat`/`distribution` for `hist`/`exp` with one layout, and the notes (`resets(n)`, `noValue(n)`, `conflicting`, `boundsDiffer`, `heatBoundsDiffer`, `summariesNotCombined`, `summaryCoarse`, `residual(term)`, `exemplarsCapped`). `unit`: `<unit>/s` for counter `rate`, `{count}` for `count`, else the entry's. `metricRunQuery` per D28; `checkShow(kind, show)` first in both.

- [ ] **Step 1: Write the failing tests**, porting the semantics of `test/viewer/metric-query.test.ts` and `metric-run-query.test.ts` onto fixtures written through `buildFormat4Report`:
  - counter: `rate` over 10 s buckets with delta 20 is 2/s; `increase` is the delta; `sum` is the running total including pre-window deltas (Review Focus 1, both series shapes) and a reset gives the note; the unit `1/s`.
  - number: `last` by everything over two series sums their last values; `avg` means; `min`/`max`.
  - hist: p95 equals `quantileOf` of the summed counts; different bounds give two lines and the notes, no heatmap (Review Focus 3); same bounds give `heat.cells` and `distribution`.
  - exp: scales 3 and 5 merge at 3 with heat and distribution.
  - summary: `q0.99` and `count`; two points in a bucket give `summaryCoarse`; `summariesNotCombined` when `by` groups several series.
  - `by: ['attributes["k"]']` labels groups and keeps `1` and `"1"` apart (Review Focus 2); `where` keeps matching series; a residual `where` gives the same series and the note (Review Focus 5), and 200 001 series reject with the D5 message (a unit test on the cap with a stubbed engine).
  - width: 10 s points over 1 h at 600 points chart at 16.384 s; `widthNs: 20e9` re-runs at exactly 20 s; `rollup(max, 60000)` re-buckets to 60 s and the heat cells keep the source width (#146).
  - `top 1` keeps the largest group and its exemplars only; exemplars in the window carry their group key, prefer trace ids, at most 4 per bucket.
  - a window spanning two partitions charts both (Review Focus 4); a `resources` narrowing keeps one resource's series.
  - run query: one value per line per run; run time is the latest point; order by time then id; `failedWhen` marks a point; a line missing from a run is null; a run outside the window is dropped but keeps its earlier points; series without the run attribute are left out with the note; `revision`.
  - `@perf`: 1 000 series × 360 points in one partition, `metricQuery` with `by` under a budget set at twice the measured median (record the median in the test's comment and the PR body).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS; `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(viewer): metric chart and run queries answered from points cells`

### PR 4 close

- [ ] `mise run verify` (knip: `metricMethods` is reached only by tests until PR 5; list it in knip's ignore for this PR with a comment naming PR 5, and remove the entry there); PR; body notes D20 to D30, the `@perf` median. Branch review on Opus 5.5. Merge.

---

## PR 5: The Metrics pages query points; the metric engine and rollups leave

Branch `feat/format-4-viewer-metrics-pages` from `feat/format-4`. Title: `feat(viewer): the Metrics explorer, catalog, grids and widgets query points; the metric engine and rollups are gone`.

### Task 5.1: The `DataSource` API, the explorer hook and the formula re-run

**Files:**
- Modify: `src/viewer/data/data-source.ts` (`DataSource extends MetricMethods`; `metric(id)` and the `LoadedMetric`, `MetricCatalog` imports go), `src/viewer/data/duckdb-source.ts` (spreads `metricMethods(...)` into the returned object; `planThree` goes), `src/viewer/metrics/use-metric-query.ts`, every file that typed a `MetricEntry` or `MetricCatalog` from the rollups: `src/viewer/metrics/explorer.tsx`, `catalog.tsx` (`seriesLabel` drops "+ other"; `sparkValues` reads `e.spark`), `metric-grid.tsx`, `metric-picker.tsx`, `query-row.tsx`, `src/viewer/state/metric-state.ts`, `src/viewer/dashboards/widgets/metric.tsx` (`entries()` → `entries`, `resources()` → `resources`, `scopes().length` → `scopes.length`); the stub sources `test/viewer/dashboard-shell.tsx`, `test/viewer/fusion-source.ts`
- Test: `test/viewer/use-metric-query.test.tsx` (new; a stub `DataSource` whose `metricQuery` records requests), `test/viewer/metric-state.test.ts`

The pages compile against the new methods after this task but still call the old engine where Tasks 5.2 to 5.4 have not reached; those calls are replaced task by task and the engine is deleted in Task 5.5, so `mise run check` is green after every task.

**Interfaces:**
- Consumes: `metricCatalog`, `metricShowOptions`, `metricQuery` (D30).
- Produces: `MetricQueries` unchanged; `run()` resolves each query's entry (`resolveMetric`), calls `metricShowOptions(entry.id)` and `metricQuery({ entry, query, window, maxPoints, exemplars: state.exemplars })` per visible query; for a formula whose operands differ in `widthNs`, re-runs them with `widthNs: formulaWidth(...)` and evaluates.

- [ ] **Step 1: Tests**: two queries run in parallel with `exemplars` from the state; a formula over operands at 10 s and 20 s re-runs the 10 s one at 20 s; an ambiguous metric gives the existing error text; a missing one too.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(viewer): the data source carries the metric methods; the explorer hook queries through them`

### Task 5.2: Explorer, Catalog, picker and state

**Files:**
- Modify: `src/viewer/metrics/explorer.tsx` (`applyEntry` uses `metricShowOptions` for `defaultShow`: the last `q…` option for summaries, `DEFAULT_SHOW[kind]` otherwise, through a `defaultShowOf(kind, options)` in `metric-tables.ts`), `catalog.tsx`, `src/viewer/state/metric-state.ts`
- Test: `test/viewer/metrics-explorer.test.tsx`, `metrics-catalog.test.tsx` (new, over `createDuckDbDataSource` on a `buildFormat4Report` fixture through the Node engine, as `frozen-reports.test.ts` opens one; the Shell renders `#/metrics` and `#/metrics/catalog`)

- [ ] **Step 1: Tests**: the Explorer draws `N series` for a query from the URL `m` param, shows the `Evaluated in the browser` note for a residual `where`, and lists `by` options from the entry's attribute keys and the catalog's resources; the Catalog lists every metric with type badge, unit, temporality, scopes, attribute keys, the series count and a sparkline, filters by text, and a row click sets the URL to the Explorer with the kind's default show.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(viewer): the Metrics explorer and Catalog read format 4`

### Task 5.3: Grids and the Metrics tabs

**Files:**
- Modify: `src/viewer/metrics/metric-grid.tsx` (a chart's query is `metricQuery({ entry, query: gridQuery(...), window, maxPoints: GRID_MAX_POINTS[size], resources: <catalog indexes matching the origin's resources by resourceKey>, exemplars: true })`; `seriesOnResources` and the `OTHER_LEFT_OUT` note go), `useHasMetrics` unchanged in shape
- Test: `test/viewer/metric-grid.test.tsx` (new, over the Node engine): a log's resource gets one chart per metric of that resource and none of the other resource's; the trace origin with two resources draws one line per resource; `useHasMetrics` is false for a resource without points and true with.
- [ ] **Step 1 to 4**. **Step 5: Commit** `feat(viewer): the Metrics tabs chart the origin's resources from points`

### Task 5.4: Dashboard metric widgets

**Files:**
- Modify: `src/viewer/dashboards/widgets/metric.tsx` (`RunBody` calls `metricRunQuery({ entry, query: { ...own, where }, window, runBy, failedWhen })`; `QueriesBody` through the hook; `GridBody` through the grid)
- Test: `test/viewer/dashboard-metric.test.tsx` (new, over the Node engine with the run-charts shape of `e2e/build-fixtures.ts`): a run chart widget shows one dot per run per line with the failed mark; a queries widget narrowed to a selected trace's resources; the variables' condition reaches `where`.
- [ ] **Step 1 to 4**. **Step 5: Commit** `feat(viewer): dashboard metric widgets and run charts query points`

### Task 5.5: Delete the metric engine and the rollups it needed

**Files:**
- Delete: `src/viewer/data/metric-load.ts`, `metric-query.ts`, `metric-run-query.ts`, `src/format/metric-files.ts`, `src/rollups/metric-catalog.ts`, `src/rollups/value-buckets.ts`, `src/rollups/attribute-codec.ts` (if knip reports it unused), their tests (`test/viewer/metric-query.test.ts`, `metric-run-query.test.ts`, `test/rollups/metric-catalog.test.ts`, `value-buckets.test.ts`), `test/viewer/metrics-plan3.test.tsx`, the D11 rejections and `planThree()` in `duckdb-source.ts`, `metric(id)` in `DataSource`
- Modify: `src/writer/series-id.ts` (takes `boundsOf` and the identity-key helpers it imported from `metric-catalog.ts`; `src/rollups/metric-streams.ts` likewise if it imported any), `src/viewer/data/metric-tables.ts` (`MetricDef` and `MetricEntry` now come from `metric-catalog.ts`; `NOTES` loses `quantilesFromLevel`, `fromSegments`, `partial`, `foldedEvicted`; `AbortTicker` is gone with `runAtLevel`), `test/viewer-data/duckdb-source-spans.test.ts:417` (the plan-3 rejection test goes), the test-only `toJSON`/`from` pairs plan 2's note 6 parked (`ExpHistogram`, `FacetCounts`, `TimeBuckets`: delete each pair whose only callers were the deleted tests)

- [ ] **Step 1 to 4**: `mise run check` PASS with knip clean (delete what it reports unused after the removals, and the PR 4 knip ignore entry; `grep -rn "plan 3" src test` finds nothing).
- [ ] **Step 5: Commit** `refactor(viewer): the chunk-era metric engine, catalog and value buckets are deleted`

### Task 5.6: README

**Files:**
- Modify: `README.md` ("Viewing metrics": the "not available yet" note goes; the Explorer paragraph says charts are exact over every partition and names the "Evaluated in the browser" note; no series cap or "other"; the Catalog paragraph says it reads the whole `points` table once per open; "Viewing dashboards" unchanged in substance; the format-4 "Metrics pages are not yet available" paragraph goes; Limits: the Catalog's cost, resources matched by their attributes (D29), exemplars capped at 5 000 points per chart; config table unchanged)

- [ ] **Step 1 to 3**: edit; `mise run gen:check` PASS (the Development section is generated, the rest hand-written). **Commit** `docs: metrics in the format-4 viewer`

### PR 5 close

- [ ] `mise run verify`; PR; body notes D21, D26, D29, D30, D34 and the deleted modules. Branch review on Opus 5.5. Merge.

---

## PR 6: The metric e2e specs return; metrics-scale in site format over HTTP

Branch `test/format-4-metrics-e2e` from `feat/format-4`. Title: `test(e2e): the Metrics pages back in the suite; metrics-scale in site format over HTTP; budgets re-baselined`.

### Task 6.1: The four metric specs

**Files:**
- Modify: `e2e/metrics-explorer.spec.ts`, `e2e/metric-grid.spec.ts`, `e2e/metrics-catalog.spec.ts`, `e2e/run-chart.spec.ts` (the `test.skip(true, 'plan 3: ...')` lines go)

- [ ] **Step 1**: run each: `mise run test:e2e:chromium -- e2e/<spec>.spec.ts`. Expected: the explorer's test at :123 (`an unfinished report ... from its segments`) fails on the format-3 layout assertions; the others should pass or fail on a real regression.
- [ ] **Step 2**: rewrite :123 per D34: on `unfinished` (several partitions, never closed) the Catalog opens `METRIC_HIST`, the chart draws 3 series by `http.route` with 2 exemplar rings and the Notes list has no "report unfinished" entry; the on-disk assertions check `data/partitions/` holds more than one folder.
- [ ] **Step 3**: fix any real regression in `src/` with a unit test first; list it under **Also**. All four PASS. **Commit** `test(e2e): the Metrics explorer, grid, Catalog and run-chart specs run on format 4`

### Task 6.2: The trimmed parts

**Files:**
- Modify: `e2e/merge.spec.ts:37` (`test.skip` → `test`), `e2e/views.spec.ts:30, :63` (the Metrics part of the views test and the Copy-as-widget test return), `e2e/hostile.spec.ts:71`, `e2e/dashboards.spec.ts:81, :153` (the metric grid text and the w4 chart), `e2e/frozen.spec.ts:32` (title and the Catalog → chart part return for `frozen-format-1/2/3`), `e2e/trace-panel.spec.ts:64` (`'Metrics'` back in the tab list, between Services and Errors), `e2e/preview.spec.ts:84` (the screenshot test copies `dashboards` again)

- [ ] **Step 1**: restore each from `git show 9a7e2caf:e2e/<spec>` where the plan-2 commit removed it, adapted to format-4 fixtures (the frozen reports are opened after `merge`); run the specs; PASS.
- [ ] **Step 2: Commit** `test(e2e): the metric assertions trimmed in plan 2 return`

### Task 6.3: metrics-scale over HTTP and the Fusion Metrics frame

**Files:**
- Modify: `e2e/metrics-scale.ts` (`Report.create({ out, title, config: { writer: { format: 'site' } } })`), `e2e/scale.spec.ts` (the metrics-scale describe: tag `@perf @http`, the format-3 file guard replaced, the Fusion frames include Metrics again), `e2e/build-scale-fixtures.ts` (the `scale` input gets its metrics back, R86 reversed), `e2e/fixture.ts` (budgets), `e2e/global-setup.ts` (already serves `e2e/.metrics-scale/` at `/sub/metrics-scale`; only its existence check changes if the `site` folder layout asks), `.github/workflows/ci.yml:276` (`--project chromium-perf-http`), `mise.toml` (`test:e2e` description if the project name appears)
- Test: `e2e/scale.spec.ts`

- [ ] **Step 1**: the metrics-scale tests: the Explorer's first chart `scale.metric.000 · rate: 1 series` within `METRICS_EXPLORER_BUDGET_MS` median over three loads, and the range requests it adds beyond the start read fewer bytes than a quarter of `points.parquet` (the charted metric is about 47 % of the rows; the guard catches a whole-file read); the Catalog shows `200 metrics ·` within `METRICS_CATALOG_BUDGET_MS`; both read `/__requests` as R86's tests do.
- [ ] **Step 2**: `OTEL_HTML_METRICS_SCALE=1 mise run test:e2e:chromium -- e2e/scale.spec.ts` three times; medians recorded. Budgets: twice the median, never above 2 000 / 1 000 ms. If a median exceeds its format-3 budget, apply D33: stop and ask with the figures.
- [ ] **Step 3**: Fusion: `fusion-settled` and `fusion` wait for the Metrics frame (a series `img`, no `aria-busy`) and the trace click waits for "from the selected trace's resources"; `mise run e2e:fixtures:scale` rebuilds `scale` and `many` with metrics; the Fusion medians re-measured on `scale` and `many`; budgets per the rule; #229 gets the new figures as a comment.
- [ ] **Step 4**: `ci.yml:276` selects `chromium-perf-http` for `--grep 'metrics scale'`; the comment at :273 updated. The PR body lists the two lines (R90).
- [ ] **Step 5: Commit** `test(e2e): metrics-scale runs in site format over HTTP; Fusion waits for its Metrics frame again`

### PR 6 close

- [ ] `mise run verify`; PR; body: every median and budget, the request-byte guard figure, the ci.yml lines, D33's outcome, D34. Branch review on Opus 5.5. Merge.

---

## PR 7: Record and plan close-out

Branch `docs/format-4-metrics-record` from `feat/format-4`. Title: `docs(plan): plan 3 record; notes for the host plan and the release`.

### Task 7.1: Record

- [ ] Append to this plan a "Record: rulings and notes for plan 4 and the release" section in plan 1's format: rulings `R<n>` continuing from R92 (from the PR bodies), spec deviations with line numbers (§6.4's downsampled table, D20's catalog cost against §7 of the M3 design, D29, D32's columns against §6.1), notes for plan 4 (`host` must create the five views and the datapoint translation runs unchanged; the catalog's three statements and the D5 temp table over the REST connector; which metric queries carry a residual and are therefore refused served, as D5 says for aggregates) and for session F (the `metrics` table alternative of D20, #229's state, #210's figure, the frozen format-4 fixture). Commit `docs(plan): plan 3 record and notes for plan 4`.

### Task 7.2: Kickoff prompts

- [ ] In `docs/superpowers/plans/2026-11-06-format-4-writer.md`, the "Kickoff prompts" section: rule 4 reads "metrics plan merged" once this PR lands; confirm session E's prompt names this plan among "the earlier format-4 plans" and that session F's paragraph lists what the release PR body must carry (the load-test figures of PR 2, the e2e budgets of PR 6). Commit `docs: kickoff prompts after plan 3`.

### Plan close-out

- [ ] `mise run check`; PR; merge. Post the summary the unattended process asks for: each PR's number, title and measurements (PR 2's three RSS figures, PR 4's `@perf` median, PR 6's medians and budgets); issues opened or closed (#227, #210, #229 comments); anything stopped on (D33). This session ends; `/format-4` next picks session E (write plan 4) or F (the release).
