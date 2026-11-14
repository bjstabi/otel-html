# Read debt: a trace read by id and metric run queries follow what they ask

**Status: approved 2026-11-14.** The maintainer approved the three points of §6 as written (format 6; the listed
code the deployer runs, readers first; the summary's quantiles in the catalogue's load). Written 2026-11-14 after the query-scaling project
(`2026-11-11-query-scaling-design.md`) closed with five lines on its known-debt list. The maintainer chose to pay
them next (#291, #295) under the **unattended** process (`docs/agents/process-unattended.md`), skipped the
questions, and asked for #306 and #307 to be noted, not built. The calls below are the author's; §6 lists the ones
that need the maintainer's word before anything is built.

## 1. Why

`src/viewer/data/catalogue.ts` still owes five classes (`KNOWN_DEBT`, `DEBT_MAX` 5):

| entry | axis | measured | owed | issue |
| --- | --- | --- | --- | --- |
| `trace.get` (open a trace) | density | `scan` (7 / 10 / 11 serial requests at 2 / 4 / 8 row groups) | `matched` | #291 |
| `trace.share` (a trace-list row's "Latency by service") | density | `scan` | `matched` | #291 |
| `metrics.query.summary` | retention | `files` (4 → 6 → 10) | `fixed` | #295 |
| `metrics.runQuery`, `metrics.runQuery.failed` | retention | `files` | `fixed` | #295 |

**#291.** `readTrace` (`src/viewer/data/duckdb-source.ts`) finds a trace's partitions in `traces`, bounds the
read by the trace's own time range, and reads `spans WHERE trace_id = …`. A spans file is sorted by
`(scope_name, service_name, start_time_unix_nano)`, so a trace's spans lie in many row groups and only the sort key
has useful statistics: DuckDB reads the `trace_id` chunk of every row group the time bound keeps. A bloom filter on
`spans.trace_id` made it worse (query-scaling PR 4). The trace list calls `serviceShare` for each visible row (52 live),
so this is also most of the live trace list's cost.

**#295.** Two reads ignore the window:

- `metricShowOptions` (the summary's quantile list) runs `summaryQuantilesQuery` over every points file whose
  `metric_name` statistic matches, by design ("show options do not depend on the window").
- `metricRunQuery` passes `window: null` to `runsQuery` and the cell statements: a run is listed when its latest
  point lies in the window, and its cells aggregate the run's whole history (a counter's increase since the run
  began), so files before the window cannot simply be dropped.

## 2. Facts measured for this design (2026-11-14)

- **DuckDB 1.4 skips row groups on a `file_row_number` range.** In the counting engine (`test-support/scaling`),
  one spans file of 2 / 4 / 8 row groups of 8,192 rows, cold:
  `WHERE file_row_number BETWEEN a AND b` costs 3 / 3 / 3 serial requests at any position in the file;
  `WHERE trace_id = …` costs 4 / 6 / 14; `file_row_number IN (5, 9000)` costs 4 / 4 / 4.
  **An `OR` of ranges does not prune**: `trace_id = … AND (frn BETWEEN … OR frn BETWEEN …)` costs 4 / 8 / 16, more
  than `trace_id` alone. **A `UNION ALL` of one range per statement does**: two ranges cost 4 / 4 / 4. Not yet
  measured in Chromium; the DuckDB build is the same WASM, and PR 2's first task measures it there.
- **A column added to a Parquet table breaks readers that do not expect it.** `read_parquet([...],
  union_by_name = false)` (how every view is made, `src/query/sql/views.ts`) takes the first file's schema: with an
  older file first the new column is silently dropped, with a newer file first the read fails ("schema mismatch in
  glob"). The format-5 manifest schema is strict, too. So a change to what a partition holds is a format change.
- **The CI report records `resource:cicd.pipeline.run.id` on points** (live `statisticsKeys.points`), and both CI
  dashboards' run charts use it as `runBy`. The scaling generator records `resource:run.id`.
- **Who writes and who reads.** `pages-deploy.yml` runs the deployer with `node dist/cli/main.js` built from `main`,
  and `ci-report.yml` builds a run report from the commit under test, while run updates pushed during a job go
  through the released actions (#304 reached the site only with 0.3.1). So a reader of a new format must be on
  `main` before any commit writes it, and partitions copied from older run reports keep their old shape until
  retention drops them (#307).
- **The live CI report's points statistics carry the run id**: every points file of the 26 live partitions records
  1 to 4 `resource:cicd.pipeline.run.id` values, far under `facetValueCap`, so pruning by run works live.

## 3. Goals, non-goals, anti-goals

**Goals**

1. `trace.get` and `trace.share` cost the row groups that hold the trace, not every row group of its partitions:
   class `matched` on density, `files` on retention as today.
2. `metrics.query.summary`, `metrics.runQuery` and `metrics.runQuery.failed` cost nothing for a partition before the
   window that holds none of the runs (or metrics) the answer needs: class `fixed` on retention.
3. `KNOWN_DEBT` ends empty (`DEBT_MAX` 0); no entry gets worse on any axis; no answer changes.

**Non-goals** (noted, each has its issue)

- #306, a threaded engine build.
- #307, re-measuring the live pages once format-4 copies leave the rolling report, and a `merge` that adds what a
  copied old partition lacks.
- #273, the service share stored in `traces.parquet`: goal 1 makes the share's read cheap without it.

**Anti-goals** (a failure even if the classes are met)

- An answer that changes: a run that appears or disappears, a run's cells that differ, a quantile that leaves the
  list, a trace with a span missing.
- A report an older reader opens and misreads: an older reader must refuse a report it cannot read.
- A cost moved where the harness does not see it on a page: the summary's quantiles move into the metric catalogue's
  load (§5.1), which a page already pays once and which is memoised; that is accepted only because the catalogue's
  load already reads the same rows (its added bytes are reported in the PR).

## 4. Constraints

- Unattended process. Workflows and actions do not change. Code the deployer runs (the writer, compaction, `merge`,
  the CI update path under `src/cli/ci/`) changes in PR 2 and is listed in the plan; this design asks for that
  approval (§6).
- The viewer and the host read formats 4, 5 and 6; a partition without the new column is read as today.
- Every catalogue change is asserted by `test/scaling/classes.test.ts`; a debt line leaves only when the harness
  measures its target (`measured: true` first, as query-scaling did).

## 5. Design

### 5.1 The summary's quantile list (#295, part 1)

The quantiles a summary metric carries are read once, with the metric catalogue (`metricCatalog`'s load, which
already reads every points file whole and is memoised for the source), as a list per metric identity.
`metricShowOptions` answers a summary from it and reads no file. The list is the same as today's (the whole report),
so no answer changes. `summaryQuantilesQuery` is folded into the catalogue's statements or removed.

### 5.2 Metric run queries select files by run (#295, part 2)

`metricRunQuery` reads in two steps:

1. **Which runs.** Over the points files that can hold a point at or after the window's start (the window pruning
   `prunePartitions` already does, with no upper bound), the latest point time per run. The runs whose latest point
   lies in the window are the answer's runs, exactly as `runsFrom` selects them today. `n_series` per run comes from
   step 2. `left_out` (series with no run value, counted over the whole report today) is counted from the metric
   catalogue's memoised identities, which carry `attributes` and `resource_attributes` of every series, so it does
   not change and reads no points file.
2. **Their points.** The cell statements (and `runQuery.failed`'s series ids) read the files of step 1 plus the files
   before the window whose `runBy` statistic intersects those runs. That needs `runBy` to be
   `resource.attributes["K"]` with `resource:K` among the points statistics keys; otherwise (or where a file's
   statistic is null) every earlier file is kept, as today.

A run's earlier points therefore stay in its cells, a counter keeps its baseline (the series of a run lives in that
run's files), and a run cannot appear or disappear. An equivalence test compares the two-step answer with today's
on the scaling shapes, including a run that starts before the window and one that ends after it. The README says
which statistics key makes a run chart cheap.

### 5.3 A trace's rows in its spans file (#291): format 6

**The format.** `traces.parquet` gains a column `span_rows`: per trace and partition, the ranges of
`file_row_number` in that partition's spans file that hold the trace's spans, at most one range per row group
(the first and the last row of the trace inside that group), as `LIST<STRUCT<first: BIGINT, last: BIGINT>>`.
Nullable: null means "not recorded" and the reader falls back. The manifest is format 6 with format 5's shape; the
version tells an older reader to refuse the report. The schema document, the README's compatibility table and the
format-5 frozen fixture (kept, still read) are updated; a frozen format-6 fixture is added.

**The writer.** The ranges are computed after the spans are sorted (the encoder's `sortPermutation`), when the
partition's `traces` rows are written. Compaction rewrites the spans file, so it recomputes `span_rows` from the merged
stream when it folds the traces rows (`aggregateTraces`). `merge` copies a partition's spans and traces files byte for
byte, so their ranges stay valid; a copied format-4 or format-5 partition has no `span_rows` and is read as today.
`upgrade` to 6 rewrites the manifest's version only.

**The views.** The `traces` view reads files with and without the column (`union_by_name = true` for `traces`, or a
typed `NULL AS span_rows` per file: the builder picks after measuring both at open).

**The reader.** `readTrace` asks `traces` for each partition's `span_rows` with the bound it already reads, then
reads `spans` with `trace_id = …` and one `file_row_number BETWEEN …` per range, the ranges joined by `UNION ALL`
(an `OR` does not prune, §2), and falls back to today's read for a file without
ranges. `serviceShare` reads only the columns the share needs, through the same path.

**Cost.** One range per row group the trace touches: a small trace costs one row group per partition whatever the
density; a CI run trace of 145,000 spans touches every row group of its partition, as it must.

### 5.4 Order of work, expected results

| # | PR | closes | holds |
| - | -- | ------ | ----- |
| 1 | `perf(viewer): metric run queries read only their runs' files` (§5.1, §5.2) | #295 | the three metrics entries `fixed` on retention; their debt lines gone; equivalence test green |
| 2 | `feat(format): read format 6` (§5.3: the manifest schema, the views, `merge`, the host and the viewer accept format 6 and the column; nothing writes it yet). Its first task measures the range reads in Chromium; if a `file_row_number` range does not prune there, the plan stops before any format code | | no entry worse; the Chromium numbers recorded in the plan |
| 3 | `feat(format): format 6 records where a trace's spans lie` (§5.3 writer, compaction, `upgrade`, fixtures) | | no entry worse |
| 4 | `perf(viewer): a trace is read from the row groups that hold it` (§5.3 reader) | #291 | `trace.get`, `trace.share` `matched` on density; `KNOWN_DEBT` empty, `DEBT_MAX` 0 |

PR 4 also records, in the plan, the harness numbers before and after for the trace list and `#/traces?mode=traces`
(`mise run predict:queries`); a live measurement waits for a release and the end of #307's transition, and is added
to #307.

## 6. Approved by the maintainer on 2026-11-14

1. **Format 6** (§5.3): a new nullable column in `traces.parquet`, the version bump, a new frozen fixture. The
   alternative (no format change) is to leave `trace.get`/`trace.share` owed.
2. **Code the deployer runs changes in PRs 2 and 3**: the manifest reader, `merge`, the writer, compaction and
   `upgrade` under `src/format/`, `src/writer/` and `src/cli/`, as the plan lists them, readers first (§2). No
   workflow or action changes.
3. **The summary's quantiles join the catalogue's load** (§5.1) instead of following the window: no answer changes,
   and the cost moves into a read every metrics page already makes.

PR 1 needs none of these and can go first.

## 7. Left to the builder

The column's exact name and struct field names; whether the views use `union_by_name` or a typed null; how `runBy`
maps to a statistics key; how `left_out` is computed from the identities; module names; the frozen fixture's content.
