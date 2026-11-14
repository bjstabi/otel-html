# Query scaling: what a query reads follows what it asks, not what the report holds

**Status: approved 2026-11-11.** The maintainer confirmed the five decisions of §10 as written and asked for no
other change. Two reviewers read the draft on 2026-11-11 (one as a builder, one whole-branch review on Opus 5.5);
their questions and findings are answered in the text. PR process: **unattended**
(`docs/agents/process-unattended.md`). A fresh session continues this work with `/perf-1` (§11); the next step is
the implementation plan.

## 1. Why

The rolling `branch/main` report (15 partitions, 3,086,855 spans, 297,110 logs, 745 points) was measured on GitHub
Pages on 2026-11-11, after PR #274:

| page                  | settles in  | requests  | bytes    |
| --------------------- | ----------- | --------- | -------- |
| `#/dashboards/ci`     | 15.3–19.6 s | 769–777   | 45–55 MB |
| `#/traces?mode=traces` | 35 s        | 1,065     | 91 MB    |

What the measurements say about the engine (DuckDB-WASM 1.32.0, DuckDB v1.4.3, built without threads):

- Range requests are strictly one at a time, about 14 ms each: 12.1 s of the dashboard's 15.3 s is waiting for round
  trips. On Pages the time follows the **number of requests**, not the bytes (a local mirror of the same report takes
  3.1 s).
- 61 `HEAD` and 112 `GET`s under 4 KB only open files. 48 files of at most 256 KB (3.0 MB together: traces, points,
  patterns, most logs) cost 195 requests and 2.9 s.
- An aggregate over every span reads the aggregated columns of every row group: a count by hour and status over one
  1.63 M-span file is 140 requests and 13.2 MB. Row-group statistics help only for the sort key
  (`scope_name`, `service_name`, `start_time_unix_nano`): a `scope_name =` filter on the same file is 3 requests.
- DuckDB has no index and no materialized view over Parquet. `prefetch_all_parquet_files` changes nothing here, and
  `threads` cannot be set.
- A time window skips a spans file only by `timeMin`; a file that ended before the window is still opened (#271).
  Twelve of the fifteen spans files carry `null` for the `resource:cicd.pipeline.*` statistics, so a workflow, run or
  job selection skips no file (#272).

PR #274 fixed what the CI dashboard's own statements did wrong. This project fixes the layer below, so that the cost
of a query follows **what it asks** (its window, the data that matches, the rows it returns) and not **what the
report holds** (how many runs are retained, how many test spans each run carries), for every kind of query the viewer
can issue and not only for the ones today's dashboards issue.

The maintainer's order: small files whole and in parallel, a rollup table, better pruning, then a default time
window. A threaded engine build is a later task: it shortens the wait per request and does not change how the reads
grow.

## 2. Goals, non-goals, anti-goals

**Goals**

1. Every kind of query the viewer can issue is listed in one catalogue with a declared cost class, and a test holds
   it to that class as the report grows (§3). The test counts reads; it does not time anything.
2. An aggregate over a long window reads no span or log file (§6).
3. A window, or a selection on a statistics key, skips whole files, and a read by trace id reads only the row groups
   its time range can be in (§5).
4. A small file costs one request, and those requests run in parallel (§4).
5. A report can open on a bounded window instead of its whole range (§7).
6. A new dashboard, widget kind, view or page needs no change to the query layer. A new kind of **query** needs a
   catalogue entry with its cost class, and the completeness test fails until it has one.

**Non-goals** (each stays possible later)

- A threaded or cross-origin-isolated engine build; coalescing or prefetching range reads inside the engine.
- A browser cache of partition files across visits.
- #273 (the per-trace service share in `traces.parquet`).
- Leaving the test spans out of the rolling report.
- Rollups for metric points (the format-4 metrics plan decided against `points_1m`; nothing measured since asks for it).
- Changing the sort order of the span, log or point files.
- A server: the `site` report stays static files.

**Anti-goals** (the work has failed if one of these is true, even if the dashboard is fast)

- The router or the pruning knows a widget kind, a dashboard name, a `cicd.*` key or anything else from the CI
  configuration. It may know only the structured request: table, needs, window, the paths the condition reads.
- The same request gives different answers depending on which files happen to carry a rollup, or on which route
  answered it. **The answer is a function of the request and the data alone.**
- A report written before this project, or a partition without a rollup, no longer opens.
- A test that passes or fails on wall-clock time. A budget loosened to make a test pass.
- Speed bought by silently showing less (a hidden row cap, a dropped series) without the page saying so.

## 3. The query catalogue and the scaling tests (first PR)

Nothing like this exists today. The performance tests are wall-clock budgets on fixed fixtures (`e2e/scale.spec.ts`,
the `@perf` unit tests), one range-request bound (Fusion on `many`, under 1,764) and one byte bound (metrics scale,
1.1 × the points file). None says how a query grows.

### 3.1 The catalogue

One module (the plan names it; `src/query/catalogue.ts` is the working name) holds a closed list of entries. An entry
is one representative request per **query shape**, expressed at the `DataSource` level (`src/viewer/data/data-source.ts`),
with the cost class it is allowed on each growth axis. The shapes, from the inventory of 2026-11-11:

| family | `DataSource` method and needs | builders (`src/query/sql/`) |
| ------ | ----------------------------- | --------------------------- |
| count | `querySpans` `total` (spans, or distinct traces in trace mode); the log total, which today is a subquery of the rows statement | `spanCountQuery`; inside `logRowsQuery` and `logTracesQuery` |
| time buckets | `buckets`, `timeline` (spans); `timeline` (logs); `metricPoints` | `timelineQuery`, `logTimelineQuery`, `pointsTimelineQuery` |
| top values | `facets` on core keys; on attributes | `coreFacetsQuery`, `attributeFacetsQuery` |
| group statistics | `groups` (`measureBy`), `services` | `groupStatsQuery`, `servicesQuery`, `serviceBucketsQuery` |
| duration distribution | `durations`, `percentileOf` | `durationSummaryQuery`, `durationBinsQuery`, `percentileQuery` |
| rows page | `rows` (spans, logs), sorted, limited | `spanRowsQuery`, `logRowsQuery` |
| trace list | `rows` in trace mode | `traceRowsQuery`, `logTracesQuery` |
| read by id | `getTrace`, `hasTrace`, `serviceShare`, `traceLogs`, `getLog`, `surroundingLogs` | `tracePartitionsQuery`, `traceSpansQuery`, `traceSummaryQuery`, `traceLogsQuery`, `logByRefQuery`, `surroundingQueries` |
| distinct values | `resourceValues` | `resourceValuesQuery` |
| patterns | `patterns` | `patternsQuery` |
| metrics | `metricCatalog`, `metricShowOptions`, `metricQuery`, `metricRunQuery`, `metricsForResources` | `points.ts` (`metricDefsQuery` … `runsQuery`) |

Each family has entries for the variants that change the read pattern: no window, a short window, a long window; no
condition, a condition on a sort-key column, on a statistics key, on an attribute, a text search.

A **completeness test** fails when an exported builder of `src/query/sql/`, a `DataSource` method, or a value of
`SpanNeed` or `LogNeed` has no entry. That is the mechanism behind goal 6: dashboards and views compose requests that
are already in the catalogue; a new kind of request cannot be added without declaring how it scales. Two things
have to change for the test to mean that:

- Some statements are built outside `src/query/sql/` today (inline in `src/viewer/data/duckdb-metrics.ts`, the
  id-table path in `duckdb-source.ts`). They move into builders, or the test covers the data layer another way; a
  statement the test cannot see is not allowed.
- The log total is part of the rows statement, so it costs what a rows page costs. It becomes a need of its own
  (as `total` is for spans) so that it can reach the class of a count.

### 3.2 Axes and cost classes

Three axes, each varied alone over at least three steps on synthetic reports from a deterministic generator:

- **retention**: the number of partitions outside the request's window (the window and its contents stay the same);
- **density**: the rows per partition inside the window;
- **window**: the number of partitions the window covers.

Four classes, per entry and axis:

- `fixed`: the reads do not change along the axis;
- `files`: at most a stated number of whole-file fetches of small files per added partition, and nothing else;
- `matched`: the reads grow with the rows or row groups the answer needs, within a stated factor;
- `scan`: the reads grow with the rows. Allowed where the design says so (§3.4); anywhere else an entry in class
  `scan` must be on the **known-debt list**, which names an issue for each entry. The list can only shrink: a test
  fails when an entry on it measures better than `scan` and is still listed, and when an entry not on it measures
  `scan`.

### 3.3 The harness

- It writes the reports through the real writer and runs each entry cold through the real engine and the real
  `DataSource`. It records, per file: opens, read calls and bytes.
- It turns those into what a `site` report would cost: serial range requests, parallel whole-file fetches (§4) and
  bytes. A small **cost model** (one module, constants from the measurement in §1: about 15 ms per serial request,
  one round trip per parallel batch, a bytes term) turns the counts into a predicted time. The model's output is
  printed, never asserted.
- **Prediction for a dashboard or page**: a page runs in one engine, where a read one entry shares with another is free,
  so the page is not the sum of its entries. The harness renders each page whole in one cold counting engine on
  generated shapes (dense and sparse spacing; partitions of 1 to 4 production-size row groups and partitions of 8, 14
  and 22) and fits its serial requests, parallel requests and bytes as `a + P·(p + pd·G) + q·G²` (P partitions of G row
  groups; there is no retention/window split, because a page's window spans the report), by non-negative least squares
  (the squared term is non-negative and is taken by a page whose cost grows faster than linearly). A window shorter
  than the report (`--window 7d`) is split off afterwards from the entries' own ratios (`splitWindow`). The prediction for a named shape is that fit summed over the shape's partitions, each by its own
  row groups. A later PR's effect is the fit scaled, term by term, by the share of that term that the page's entries
  without a debt line for that PR still carry. A mise task prints the table for named shapes: today's rolling report,
  30 runs × 150,000 spans, 90 runs × 150,000, 30 runs × 1,500,000. On the live report the fit stays at about half the
  requests Chromium makes (four live checks, 0.3 to 0.6), so the expectations of `rolling` are anchored on the live
  counts and a later PR is held to the live baseline times the harness's after/before ratio; the other shapes are
  harness absolutes, not live-calibrated. This is the "how will it scale" answer without a load test, and it works for
  a dashboard that does not exist yet.
- The entries are measured on small row groups (a small report behaves like a large one): `writer.rowGroupRows` has a
  minimum of 50,000 and keeps it, and the harness gets 8,192-row groups through an internal writer option that the
  configuration does not expose. A page's density is measured at production row-group size (50,000 rows).

**Where it runs** is settled by the plan's first task, by measurement:

- Preferred: unit level, in `mise run check`, on the Node engine (`startHostEngine`, `src/host/`), counting the
  worker's file reads. The Node runtime of duckdb-wasm reads `NODE_FS` files with `fs.readSync`; nothing observes
  those reads today, and HTTP files are not supported in Node at all, so the browser's request pattern is not
  available there directly.
- The task measures, on one report, the Node read counts against the Chromium range requests the static server
  already logs (`e2e/static-server.ts`, `GET /__requests`) for a handful of entries. If they agree within a
  tolerance the plan states, the unit harness is the test and one `@perf @http` e2e test keeps the calibration
  honest. If they do not, the harness runs in Chromium (`runWorkerSql` in `e2e/worker-sql.ts` shows the way into the
  page's worker) and is part of `mise run verify` instead.

**Baseline.** The first PR lands the catalogue, the harness, the classes as they measure today, the known-debt list
and the prediction table for today's report. Every later PR removes entries from the list and carries the before and
after counts of the entries it moved in its body.

### 3.4 Target classes

What each family must measure when the project is done. "Long" and "short" windows are defined in §6.3. Two
conditions apply to the table:

- The rollup rows are for partitions that **have** a rollup. A partition without one (written in format 4, refused
  by the guard, or lacking a needed dimension) is read raw for the same request and costs `scan` on density. The
  harness measures both; the fallback is allowed, and the README says that such partitions cost more until
  retention or a compaction replaces them.
- `files` holds while the file stays under §4's threshold. A `traces` file has one row per trace, so a partition
  with very many traces has a `traces` file that is read by ranges and grows with the number of traces
  (`matched`: the list is of traces). The harness's density axis has a step on each side of the threshold.

| family and variant | retention | density | window |
| ------------------ | --------- | ------- | ------ |
| count, time buckets, top values, group statistics, duration distribution, distinct values, when the condition and the grouping use only rollup dimensions and the window is long | `fixed` | `fixed` | `files` |
| the same with a short window | `fixed` | `scan` (allowed: the window is bounded) | `scan` (allowed) |
| any aggregate whose condition or grouping needs an attribute, a text search or a distinct trace count | `fixed` with a window | `scan` (allowed, and documented in the README as what such a condition costs) | `scan` (allowed) |
| trace list without a condition, under no window or a long one | `files` (the small `traces` file of each partition, in parallel) | `files` | `files` |
| trace list with a condition, or under a short window | `files` for `traces`, plus the span scan the condition needs in the partitions that hold the window's traces: `matched` on a sort-key or statistics-key condition, `scan` (allowed) otherwise | | |
| a trace's spans by id (`getTrace`, `serviceShare`) | `files` (the small `traces` file of each partition, in parallel) | `matched` (the row groups the trace's time range can be in) | not applicable |
| a trace's logs by id (`traceLogs`) | `files` | `scan` (allowed: the logs files of the trace's partitions, without a time bound, §5.2) | not applicable |
| the other reads by id (`hasTrace`, `getLog`, `surroundingLogs`) | set by the first PR's baseline; no worse than today | | |
| patterns | `files` | `files` | `files` |
| rows page; metrics | set by the first PR's baseline; no worse than today, `fixed` on retention with a window | | |

Four requests read more files than their answer needs today. What becomes of each:

- **The trace list** (`traceRowsQuery`). Today it finds the trace ids by scanning spans under the window and the
  condition, then aggregates `traces` over every partition, so that a trace split over partitions is one whole row
  whatever the window. The whole-trace rule stays, which is why the class on retention is `files` and not `fixed`.
  What changes depends on the window (§6.3 defines long and short):
  - No window, no condition: the list is every trace that has spans, read from the `traces` files alone.
  - Long window: a trace belongs to the window it **starts** in (its earliest span start, over all its partitions).
    Without a condition the list comes from the `traces` files alone. With a condition it is those traces that have
    a matching span, and the spans are read only in the partitions the `traces` rows name. So a condition that is
    always true gives the same list as no condition, and the trace count follows the same rule.
  - Short window: as today, by span overlap, with or without a condition.
  - Only rows of `traces` with spans count (`traces` also holds rows for traces that have only logs, which the list
    never shows), and times come from span rows, as the statement does today. No condition is answered from `traces`
    columns: `root_service` and `root_name` describe the root, a condition on service or name matches any span.
- **`percentileOf`** takes no window and reads every span of one service and resource. On a report whose range is
  long (§6.3) it reads the rollup over the whole report instead and is approximate like every percentile there; on a
  short report it stays as it is.
- **`resourceValues`** takes no window and reads the resource column of every span, log and point file. It gains the
  page's window, so a dashboard variable lists the values inside the window, and the files outside are skipped. Under
  a long window the span and log values come from the rollups if the rollup can keep what the method returns (the
  value's kind); points have no rollup and are read as today.
- **`patterns`** applies the window already but skips no file, and it must not: a template's count and first and
  last times are combined over every partition before the window is applied, so skipping a file would change the
  answer. Patterns files are small and load through §4; their class stays `files`.

## 4. Small files, whole and in parallel

Today a `site` report registers every file by URL (`registerFiles` in `src/viewer/data/engine/files.ts`), and the
engine opens each with a `HEAD` and several small range reads, one after another.

- A file whose manifest `bytes` is at most a threshold (256 KiB is the measured starting point; the plan tunes it
  with the harness) is fetched whole with `fetch` and registered as a buffer. The fetches run in parallel.
- It happens lazily: before a statement runs, the files its pruned list needs and that are under the threshold are
  fetched if they are not registered yet. This "prepare the files of a statement" step is one seam in the engine
  layer, not something a caller of `DataSource` sees.
- Larger files keep the range reads.
- The refresh path (`refresh-report.ts`, `dropFiles`) handles buffers: a partition that is replaced or retired frees
  its buffer.
- `local` reports and `otel-html host` are unchanged.

Expected on today's report: 195 serial requests and 2.9 s become one parallel round. The rollup files of §6 are
small by design and load this way.

## 5. Pruning

Five changes. The first three change no format.

1. **Statistics survive merges (#272).** Every file of a report carries, for every key of the manifest's
   `statisticsKeys`, the set of values it holds; `[]` means the key is absent from the file and `null` means only
   "more values than the cap". Today `entryFrom` (`src/cli/ci/run-report.ts`) writes `null` for a key the job's file
   did not record, and compaction keeps a key `null` when any input has it `null`. The plan finds the root cause
   (which writer leaves the keys out, and why) before choosing where to compute them. Acceptance is #272's test: on a
   merged two-run report a run selection opens only the files that hold that run. Logs and traces files are checked
   for the same defect.
2. **Span reads by trace id carry a time bound (#271).** The trace's start and end from its `traces` rows become a
   predicate on `start_time_unix_nano`, so row-group statistics exclude what cannot hold it. Measured in #271: 43
   requests become 21 for one trace in the large partition. The bound is for spans only: a trace's times in
   `traces` come from its spans, and a log of the trace can lie outside them or have no time of its own, so
   `traceLogs` keeps reading the trace's partitions without a time bound.
3. **Test spans keep real times.** Tests that fake the clock (`vi.useFakeTimers`, `vi.setSystemTime`; the SDK takes a
   span's start from the global `Date`) put spans dated 2026-11-10T12:00Z into every run's trace: 48 in the run that
   was looked at, which makes the trace look 24 h long and pins the partition's `timeMin` a day early, so no window
   can skip it. The test SDK (`test-support/otel/`) gives spans real times whatever a test does to the clock, and a
   test proves it. This is a small early PR because it weakens everything else in this section on our own report.
   Statistics that one stray row can ruin are a general weakness of minimum and maximum; this project does not solve
   that in general.
4. **An end-time statistic (#271).** A span matches a window by overlap, so a spans file can be skipped only when
   its latest **end** is before the window. Files of spans and traces record it, and `prunePartitions`
   (`src/query/sql/prune.ts`) uses it. This is a manifest field, so it lands with format 5 (§8).
5. **No file spans more time than it has to.** A compacted file should not cover days when its inputs covered
   minutes: partition 164 of today's report (`compact:0..38`) is 61.6 MB, 1.63 M spans, nine days. The rolling report
   is now rebuilt as one partition per run, so the plan first establishes whether such a file can still be produced
   and whether this one retires by itself. The requirement is stated as a catalogue result: on a report that went
   through compaction, a windowed read stays `fixed` on retention. If compaction can still merge across more than 24
   h of start times, it groups its inputs by time first.

## 6. Rollups

DuckDB cannot keep an index or a materialized view over Parquet, so the writer keeps the aggregate itself. The
precedent is `traces.parquet`: a derived table, written when a partition is cut and merged at compaction.

### 6.1 The tables

Two new tables per partition, written by the writer, merged by compaction and by `merge`:

- **Span rollup.** One row per time bucket × **rollup dimensions** × duration bucket, with the measures count, sum,
  minimum and maximum of `duration_ns`.
- **Log rollup.** One row per time bucket × rollup dimensions, with the count. A log with no time at all has no
  bucket: its rows carry a null time bucket, and the reader places them where the raw timeline does (at the
  report's epoch). An absolute bucket would go stale when a merge moves the epoch.

Details that are part of the design:

- **Dimensions** are the table's **core facets** plus the report's `statisticsKeys` for that table. The core facets
  are the ones the Traces and Logs pages always draw (`src/query/sql/facets.ts`): for spans the service, scope,
  name, kind, status, `resource_name`, `host.name` and `deployment.environment.name`; for logs the service, scope,
  severity, `host_name`, `event_name` and whether the record has a trace. The statistics keys add, in the CI report,
  the three `resource:cicd.pipeline.*` keys that come from the dashboard variables. The rule is "what every page
  groups by, plus what the report says it filters by", not a list chosen for one dashboard.
- **A dimension keeps the raw value.** A rollup row must give the same value as a raw row for every expression the
  raw path evaluates on a dimension: the column's own name, type and nullability (`status_code` and `kind` as the
  integers they are, not the facet's labels; an empty `event_name` as the raw file has it), and for a key inside
  `resource_attributes` or `attributes` the JSON value with its kind (`5` and `"5"` differ). The intended form is the
  raw columns under their own names plus a `resource_attributes` (and `attributes`) reduced to the dimension keys,
  so the predicate that `translateCondition` produces runs on the rollup unchanged. Facet values that are derived
  (the status label, whether a log has a trace) are computed from the dimensions at read time or kept as their own
  dimension; either way the facet counts equal the raw ones.
- **The description is per rollup file.** `statisticsKeys` comes from the configuration and can change between
  runs, so a rolling report can hold rollups with different dimensions. Each rollup file's entry records its
  dimensions, grain and duration-bucket rule. A rollup that lacks a dimension a request needs counts as no rollup
  for that request. Compaction and `merge` add up only rollups whose descriptions are equal; the others are computed
  again from rows or left out. A condition is any
  boolean expression over dimensions: the rollup's rows are groups, so the whole predicate is evaluated on them.
- **Grain.** 65.536 s (2^16 ms), aligned on absolute time. The viewer's bucket widths are 1 ms × 2^k
  (`bucketSpec` in `src/query/sql/time.ts`), so every bucket of at least that width is a whole number of rollup
  buckets; a one-minute grain would not nest. Buckets are aligned relative to the manifest epoch today, and the
  epoch of a rolling report moves, so the alignment of buckets at or above the grain becomes absolute.
- **Durations.** The duration bucket is a logarithmic index with a relative width of 2^(1/8) (about 9 %), which
  bounds the error of a percentile read from it to about 5 %. Sum, minimum, maximum and count stay exact. Durations
  of zero or less have a bucket of their own.
- **Size and the guard.** Measured on one run of 146,085 spans: 748 groups by minute, service, scope, name, status
  and kind, and 870 when every distinct set of resource attributes is added. `resource_name` and the duration bucket
  were not in that measurement. The plan measures rows and bytes with the full key on the same partition before
  anything is built on it; the expectation is under 2 % of the spans file's bytes. A span name with unbounded values would defeat
  the table, so the writer has a guard: when a partition's rollup would exceed a stated share of its span rows, the
  partition gets no rollup (the manifest then lists none for it) and a warning says which dimension grew.
- **Compaction and merge** add up the rows of inputs whose rollup descriptions are equal. An input without a
  rollup (a format-4 partition, or one the guard refused) or with a different description gets one computed from
  its rows where compaction reads them anyway; where a partition is copied
  byte for byte it stays without, which §6.2 handles.

### 6.2 The router

- It sits in the data layer, between the structured request and the SQL builders. Its inputs are the table, the
  needs, the window, the grouping keys and the **paths the condition reads**. That last one does not exist as data
  today: `translateCondition` (`src/query/sql/ottl.ts`) returns a predicate, a residual and pruning hints. It gains
  the set of OTTL paths, attribute keys included (`resource.attributes["cicd.pipeline.name"]` is a different path
  from `resource.attributes["x"]`, though both read one column), and each builder declares what it reads in the
  same terms. A request whose condition leaves a residual (a term the browser evaluates on rows) is not answerable.
  No SQL text is inspected.
- A request is **rollup-answerable** when its window is long (§6.3; no window on a report whose range is long counts
  as one) and everything it reads is a rollup dimension or measure. Not answerable, by nature: a condition or grouping on an
  attribute that is not a dimension (the attribute facets among them), a text search, a distinct trace count, a rows
  page, a read by id.
- **Partitions without a rollup do not change the answer.** For those partitions the same statement computes the
  rollup's shape from the raw file (same buckets, same duration buckets) and unions it with the rollup rows of the
  others. A report with no rollup at all is the case where every partition takes that path. The plan may answer the
  whole statement from raw files when any partition lacks a rollup if the harness shows that is enough; the rule that
  the answer does not depend on coverage holds either way.
- Rollup files are pruned by time and by statistics like any other table, and load through §4.
- **An equivalence test** holds the anti-goal: for every catalogue entry that is rollup-answerable, the answer from
  rollup files, the answer computed from raw files in the rollup's shape and the answer from a mix of both are
  identical on generated data. The data includes a key with values of several kinds, null and empty values, a span
  that starts and a log stamped exactly on a bucket edge and on the window's end, a duration of zero, a rollup with
  fewer dimensions than its neighbours, a log with no time at all, and a merge that moves the report's epoch.

### 6.3 Long and short windows

- A window is **long** when it covers at least 256 grains (about 4 h 40 min). A report whose whole range is shorter
  (a single run, the product's classic case) never uses the rollup, and nothing about it changes.
- **No window on a report whose range is long is a long window over the whole range**, for every rule below. (Its
  buckets would otherwise be finer than the grain: about 4 s on a 5 h range.) It adds no time filter: every row
  counts as it does today, a log with no time at all included.
- A long window is aligned outward to the grain where the window is made (the selection state), so every request of
  a page sees the same window. Its end is exclusive for every table: a span that starts, or a log stamped, exactly on the end
  belongs to the next window. (The window tests are inclusive today, `whereOf` in `src/query/sql/filter.ts`.)
- These rules depend on the window and the report's range, never on the format: a format-4 report with a long range
  gets them too, computed from its raw files.
- Under a long window, spans are selected and counted by **start time**. Today a span matches a window when it
  overlaps it, and one that started earlier counts in the first bucket; a table keyed on start time cannot reproduce
  that. Short windows keep overlap, where it matters (a long job span over a one-minute window). The trace list
  follows with the same rule one level up: a trace belongs to the window it starts in (§3.4).
- Under a long window, timeline buckets are at least one grain wide. Today a 6 h window draws 2,637 buckets of 8.2 s;
  it will draw 330 of 65.5 s.
- Under a long window, percentiles (p50, p95, p99, the duration histogram) come from the duration buckets and are
  approximate within the bound of §6.1. Under a short window they stay exact (`quantile_cont`).

- These rules follow from the window alone, so they also hold for a request the rollup cannot answer (an attribute
  condition, a text search): it reads the raw files, selects by start time, uses the same buckets and computes its
  percentiles from the same duration buckets. Adding a filter never changes how a number on the page is computed, and
  the page can say "approximate" from the window.
- Under a long window the Traces and Logs pages compute the **attribute facets** only when the reader asks for them
  (the section says so and offers to load them). They unnest the attributes of every row in the window, which no
  rollup can answer; under a short window they load with the page as today.

All of this follows from the request alone, so the anti-goal holds.

## 7. A default window

- A report-level setting, `viewer.defaultWindow` (a duration such as `7d`; unset means the whole report, which is
  today's behaviour and stays the default). It applies when the URL carries no window, is anchored at the end of the
  report's range, and is shown in the time-range control like any other window; "Entire run" stays one click away.
- The time-range presets today are "Entire run", 15 m and 1 h. Longer presets (6 h, 24 h, 7 d) appear when the
  report's range is longer than they are.
- The CI configuration sets `7d`. With 30 retained runs the rolling report rarely covers more than that, so this
  changes little today; it is what keeps the first view bounded when the retention grows. With §6 in place a long
  window is cheap, which is why this comes last.
- The setting is written into the manifest's `config`, which is a strict object, so its schema lands with format 5.

## 8. Format and compatibility

The manifest is a strict object at every level (`ManifestV4Schema` in `src/format/manifest.ts`): a new table under
`partitions[].files`, a new field of a file entry, a new top-level key or a new `viewer` key is rejected by a viewer
that does not know it. The README's rule is that `formatVersion` changes for exactly that. So:

- **This project introduces format 5.** It contains: the two rollup tables, each rollup file's description
  (dimensions, grain, duration-bucket rule), the end-time statistic and `viewer.defaultWindow`.
- **Everything format 5 adds lands in one PR**, including the fields a later PR starts to use. A second schema change
  after a release would be another format.
- The viewer and `otel-html host` open format 4 and format 5. `merge` reads both and writes 5. A format-4 report
  is a report in which no partition has a rollup: it opens, gets §4 and the parts of §5 that need no new field, and
  is answered by the same rules as any other (with a long range, §6.3's rules computed from its raw files).
- **The PR that first writes format 5 also reads it.** The deployer publishes the rolling report from `main` as soon
  as a PR merges, so the viewer and the host must open format 5 (answering everything from raw files) in the same PR
  that makes the writer produce it.
- A frozen `fixtures/reports/format-5` joins the format-4 fixture; both keep their byte-for-byte checksum tests.
- The code that names the tables one by one is updated: `tableKeyed` and `files` in `manifest.ts`, the strict update
  schema and the layout expression in `src/cli/ci/update.ts`, the `Record<Table, …>` maps in `columns.ts`, the
  derived-table branch in `compaction.ts`.
- A run report that is in progress when the deployer changes version keeps the viewer it was created with
  (`assetsBase` is set once), while later passes write its manifest. The plan must make sure such a report never gets
  a manifest its viewer cannot read, and has a test for it.

## 9. Order of work, expected results

One plan, one PR per row unless the plan finds a reason to split or join. Each PR carries the catalogue counts it
moved and the predicted time for today's report.

| # | PR | closes |
| - | -- | ------ |
| 1 | The query catalogue, the scaling harness, the baseline and the known-debt list; statements built outside `src/query/sql/` move into builders (§3) | |
| 2 | Test spans keep real times under a faked clock (§5.3) | |
| 3 | Small `site` files load whole and in parallel (§4) | |
| 4 | Statistics survive merges; span reads by trace id carry a time bound; `resourceValues` takes the window; the unconditioned trace list without a window reads no span; the log total is its own need (§5.1, §5.2, §3.1, §3.4) | #272 |
| 5 | Format 5: the schema; the writer, compaction, `merge` and the CI update path write rollups and the end-time statistic; the viewer and the host open format 5, answering from raw files; the frozen fixture (§6.1, §5.4, §8) | |
| 6 | The viewer prunes by end time and routes rollup-answerable requests; the long-window rules, the trace list included; attribute facets on request; the equivalence test (§6.2, §6.3) | #271 |
| 7 | Compaction keeps files bounded in time, if §5.5's check says it is still needed | |
| 8 | `viewer.defaultWindow`, the longer presets, the CI configuration (§7) | |
| 9 | The record: live measurements against the predictions, the README, what is left on the known-debt list | |

**Expected when done**, measured the way §1 was (headless Chromium, cold, live Pages, twice):

- `#/dashboards/ci`: at most 150 serial range requests and at most 5 s (today 708 and 15.3–19.6 s).
- `#/traces?mode=traces`: at most 5 s (today 35 s). The single-span test traces that fill the list today come from
  runs before #274 and leave with retention; this project does not remove them.
- In the harness: doubling the retention under a fixed window adds no serial request to any entry that is not on
  the known-debt list, and the list holds no aggregate over rollup dimensions.

These are estimates made before the harness exists, and "settles" does not include attribute facets nobody asked
for (§6.3). What a PR is held to:

- **Classes.** The plan names, per PR, the catalogue entries that must reach their target class and leave the
  known-debt list. The harness asserts it. An entry that does not get there is a stop under the unattended process.
- **Numbers.** PR 1 has a task that writes an expectation table into the plan: per later PR, the predicted serial
  requests for today's rolling report after it, computed by the harness from the baseline with the moved entries at
  their target class. A PR whose own prediction is more than 20 % above its row is a stop.
- **Live.** The record PR measures the live pages against the figures above. A miss there is reported in the record
  with its cause; it is not a stop, because nothing is left to hold back.

**Left to the builder:** the names of modules, tables, columns and manifest fields; the small-file threshold; the
guard's share; the tolerance between Node and Chromium counts; where the missing statistics of §5.1 are computed;
how an in-progress run report crosses a format change; whether partitions without a rollup are handled per partition
or per statement.

## 10. Decisions

**Confirmed by the maintainer on 2026-11-11**, as written (each changes what gets built):

1. **Format 5** (§8), **and that this project's source changes run in the deployer.** The deployer checks out
   `main`, builds it and runs the whole CLI with a write token (`pages-deploy.yml`), so every merged change to the
   writer, compaction, the format and the CI publishing code (`src/cli/ci/update.ts`, `run-report.ts` and others)
   runs there on the next deploy: PRs 4, 5 and 7 at least. The unattended process stops before a change to
   anything that runs with a write token on `main`. Approving this point lifts that stop for the source files
   under `src/` that the plan lists, and for the build files the deployer's build reads (`mise.toml`,
   `package.json`, the lockfile) where the plan lists a change to them (a mise task for the harness, for one). It
   stays for every workflow file, every action definition and anything the plan does not list; none of those is
   expected to change, apart from point 5.
2. **Approximate percentiles under long windows** (within about 5 %), exact under short ones (§6.1, §6.3). The
   alternative is that every request that needs a percentile reads the raw spans whatever the window; then the
   Traces page over a long window stays as slow as it is.
3. **Long-window rules** (§6.3), once a window (or, with no window, the report's range) is longer than about
   4 h 40 min: spans counted by start time instead of overlap, a trace listed in the window it starts in, the window
   aligned to 65.5 s, and timeline buckets no finer than 65.5 s. A long-range report written in format 4 gets the
   same rules.
4. **Attribute facets on request under a long window** on the Traces and Logs pages (§6.3). The alternative is that
   those pages read the attributes of every span or log in the window on every load, and stay slow on a long window.
5. **The CI default window, `7d`**, set in `.github/otel-html-ci.yaml` and in the publish action's own
   configuration, `.github/actions/otel-html-publish/otel-html-ci.yaml` (the two files already differ in two `where`
   lines; only the window is added to each). The deployer reads the first file; the second is inside the
   `otel-html-publish` action. The unattended process touches neither without the maintainer's word; approving this
   point lifts that stop for this one line in each of the two files.

**Calls made in this document** (the author's; the maintainer approved the document with them):

- The grain is 2^16 ms, not one minute, so the bucket ladder stays as it is.
- Rollup dimensions are each table's core facets plus the report's `statisticsKeys`; a guard refuses a rollup that
  grows too large rather than dropping a dimension.
- The trace list keeps whole traces and reads every partition's small `traces` file; without a condition (and with
  no window or a long one) it reads no span.
- Reads of a trace's logs get no time bound, and patterns files are never skipped, because either would change
  answers.
- A rollup keeps raw values under raw column names, its description is per file, and an equivalence test compares
  the rollup's answers with the raw files'.
- The log total becomes a need of its own, and statements built outside `src/query/sql/` move into builders.
- Dashboard variables list the values inside the page's window (`resourceValues` gains the window).
- `percentileOf` is approximate on a report with a long range.
- Under a long window every percentile is computed from duration buckets, also when the raw files are read.
- Points get no rollup.
- A partition without a rollup is answered from its raw file in the rollup's shape, so coverage never changes an
  answer.
- The scaling tests count reads and assert growth classes; predicted times are printed and never asserted. Whether
  they run on the Node engine or in Chromium is decided by the first task's measurement.
- The faked-clock fix is part of this project.
- `viewer.defaultWindow` is unset by default, so only reports that ask for it change.
- All format-5 schema additions land in one PR.
- The live targets in §9, and what a PR is held to (classes asserted, a 20 % margin on the predicted requests).

## 11. Sessions for `/perf-1`

The maintainer works from the console and clears the session between steps; `/perf-1`
(`.claude/skills/perf-1/SKILL.md`) reads this section and picks the next session. Without the skill:

```
Continue the query-scaling work. Read §11 of docs/superpowers/specs/2026-11-11-query-scaling-design.md on main, decide which session is next from the rules there, say which and why, then run that session's prompt exactly as written.
```

**Which session is next** (`git fetch origin`, then look at `origin/main`):

0. First, `gh pr list --base main --state open` for an open PR of this project (a `docs(spec): query-scaling…` or
   `docs(plan): query-scaling…` title, or a branch the plan's PR table names). An open PR is unfinished work of the
   session that opened it: check out its branch and finish that (read its body, its checks and its review state)
   instead of starting the step again. When it is merged, apply rules 1 to 4.
1. The status line at the top of this document says "awaiting the maintainer's approval" → **session 0**.
2. The document is approved and no `docs/superpowers/plans/*-query-scaling*.md` exists → **session A**.
3. A plan exists and a PR of its PR table is neither merged nor marked dropped in the plan
   (`gh pr list --base main --state all --head <branch>` for each branch the table names) → **session B**; resume at
   the first such PR, on its existing branch if it has one, at the first task whose commit is not on it.
4. Every PR of the plan is merged or marked dropped, the record included → the work is complete; say so, name what
   §2 left for later (the threaded engine build first), and stop.

PR 1 note (2026-11-11): session B's first run built Tasks 1–6, opened PR 1 as a draft (#285) and stopped at Task
6 step 5 (the prediction model; see the PR body). The maintainer then added Task 6a (the measurement in parallel and
in CI). After that, the maintainer chose the union-of-reads prediction model recommended in the PR body; Task 6b built it (36236691) and stopped: summing entries' data parts overcounts a page 1.3–3.8×. On 2026-11-12 the maintainer chose to measure each page whole and fit it per axis; Task 6c builds it; on 2026-11-12 the maintainer also approved random trace ids in the generator and the live viewport in the page test, so lookups by trace id become debt owed by PR 4. After a second miss the maintainer chose to fit page density on production-size (50,000-row) groups, then (after a third miss) to measure a 22-group partition, falling back to expectations anchored on live counts (applied after a fourth miss; issue #287). After the branch review the maintainer chose Parquet bloom filters on `trace_id` for lookups by trace id (PR 4, Task 11a, which starts with a spike and stops if DuckDB-WASM or the writer cannot use them). In PR 3 the maintainer chose to size the generator's logs like live ones (mostly under the small-file limit), so PR 3 re-derived the Expectations table from one generator (row 1 small files off, row 3 on) and the limit became 524,288 by the plan's 10 % rule. In PR 4 the maintainer chose bloom filters on `traces` and `logs` only, not `spans` (they made opening a trace dearer); `trace.get` and `trace.share` stay owed. PR 4 missed its expectation row (562 / 692 live-anchored against 465 / 484): the row credited `trace.get`/`trace.share` and `resourceValues.all`, which PR 4 does not pay, and batching the trace list's service shares saved statements but no reads; the maintainer accepted it and had rows 4-8 re-derived from the measurement; the batching was then reverted, after a review found it could read more than the single reads. In PR 5 the rollup of the live report's largest spans file measured 3.46 % of it (862 KB of 24.9 MB, 53,071 rows for 661,031 spans), over the 2 % expectation of §6.1; the grain and duration bucket set the rows and the exact sum/minimum/maximum hold 78 % of the bytes, and the maintainer accepted it as specified (2026-11-13). PR 5 merged as #293; its two rollup views cost 6 serial requests at every open and Refresh (18 against 12 on a small site report), so the maintainer chose to have PR 6 create them lazily, on the first rollup-routed query, and added `views.ts`, `engine/files.ts` and `refresh-report.ts` to PR 6's files (2026-11-13). PR 6's router checks a rollup's dimensions before pruning by its statistics (a rollup records "no value" for keys outside its description). In PR 6 the `.statkey.` entries missed their row because `merge` copied run reports' rollups, written without the report's statistics keys, byte for byte; the maintainer chose that a merge recomputes a copied partition's rollup from its rows when its description lacks the target report's keys (a format-4 partition with no rollup is still copied as it is), and Tasks 20 and 21 land as one commit (2026-11-13). PR 6 missed its row on 30x1.5M (dashboard 1,888 against 1,331): the attribute-conditioned dashboard reads stay raw per row group, which the per-entry derivation had credited; the maintainer accepted it and had rows 6 and 8 re-derived from PR 6's measurement, and added `fusion-timeline.tsx` to PR 6 (2026-11-13). The metrics entries `metrics.query.summary`, `metrics.runQuery` and `metrics.runQuery.failed` still measure `files` on retention (every partition's points file is loaded); the maintainer retargeted their debt to #295, owed by PR 9, and declared `resourceValues.all.short` (no window on a short-range report) `scan`, allowed by §6.3. PR 6 merged as #296. In PR 7 the live report's partition 166 (`compact:0..29`, 216 h) decided that PR 7 is built; the maintainer limited row 7's hold to retention and window, since three logs entries measure `scan` on density on the compacted shape only because its compacted logs file passes the small-file limit, and added `src/cli/commands/merge.ts` to PR 7 for the `--compact` help text (2026-11-14). Open before PR 8: its hold (`#/dashboards/ci` predicted ≤ 150 serial requests on rolling and 30x150k) against the Expectations row 8 (271 live-anchored on rolling, 40 harness on 30x150k, since PR 6); the session that reaches PR 8 asks the maintainer first. Rule 0 resumes on that PR's branch; a task whose commit is on the branch is not run again.

A PR the plan makes conditional (§9's row 7) is marked "dropped" in the plan's PR table, with the reason, by the
session that decides it.

A planning session that splits the work into two plans rewrites rules 2 to 4 to match and adds each plan's execution
prompt here, in the same commit as the plan.

**Session 0, approval:**

```
The query-scaling design (docs/superpowers/specs/2026-11-11-query-scaling-design.md) is not approved yet. Read it whole. Put §10's decisions to the maintainer in one message, most important first, each with the document's recommendation in one line, and ask whether anything else in the design should change. Do not build anything. When the maintainer has answered, update the document (the decisions, any section they change, and the status line to "approved <date>"), open a PR titled "docs(spec): query-scaling design approved" under the unattended process (docs/agents/process-unattended.md), merge it when CI is green, and go on to session A in the same session unless the maintainer says to stop.
```

**Session A, write the plan:**

```
Write the implementation plan for docs/superpowers/specs/2026-11-11-query-scaling-design.md with superpowers:writing-plans. Skip brainstorming: the design is approved. Read the design whole first, then the code it names. The plan follows §9's order; its first task measures whether the Node engine's read counts track Chromium's range requests (§3.3) and its first PR is the catalogue, the harness and the baseline. State in the plan: the PR process is unattended (docs/agents/process-unattended.md); the PR table (branch and title per PR, and a status column where a conditional PR can be marked dropped); per PR, the catalogue entries it must move and what it is held to (§9); the list of every source file under src/ that each PR changes, and every change to mise.toml, package.json or the lockfile (the deployer builds and runs all of it with a write token, and the maintainer's approval of §10 point 1 covers what is on this list), and the one line added to .github/otel-html-ci.yaml and to .github/actions/otel-html-publish/otel-html-ci.yaml (§10 point 5). Run the builder check, save as docs/superpowers/plans/<date>-query-scaling.md, add the execution prompt to §11 of the design if it needs to differ from session B's below, and merge both through one docs PR titled "docs(plan): query-scaling plan".
```

**Session B, execute the plan:**

```
Execute the query-scaling plan (docs/superpowers/plans/*-query-scaling*.md) with superpowers:subagent-driven-development, resuming at the first PR of its PR table that is neither merged nor marked dropped, on that PR's existing branch if it has one, at the first task whose commit is not on it. The PR process is unattended (docs/agents/process-unattended.md): review on the branch, squash-merge when CI is green, branch the next PR from the updated main. Per CLAUDE.md, implementers and task reviewers run on Sonnet 5.5 and the whole-branch review on Opus 5.5; say which model each review ran on. Every PR body carries the catalogue counts it moved, before and after, and the predicted time for today's rolling report. Stop and ask where the process says so. Its stop for what runs with a write token on main is lifted only for the source and build files that the plan lists and for the one window line in the two CI configuration files (§10 points 1 and 5 of the design); a workflow file, an action definition or a source or build file the plan does not list is a stop. One exception, decided by the maintainer on 2026-11-11: PR 1's Task 6a adds one step running `mise run test:scaling` to the `check` job of .github/workflows/ci.yml. A catalogue entry that misses its class, or a prediction more than 20 % above the plan's expectation table, is a stop (§9). After the last PR, measure the live pages the way §1 of the design did and write the record.
```
