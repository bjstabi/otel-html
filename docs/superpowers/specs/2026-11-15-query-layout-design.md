# Query layout: newest-first files, paged lists, batched statements (format 7)

Status: draft for approval, 2026-11-15 (builder check done). Process: **unattended** (maintainer, 2026-11-15).

## 1. Why

Opening the site, the CI dashboard and a trace are still slow. The maintainer wants paged log and trace lists and
telemetry summaries to come back quickly, and wants a later server-backed deploy to answer each page with few
backend queries. The maintainer also asked whether we use DuckDB zone maps, adaptive radix trees (ART) or other
built-in indexing.

## 2. What was measured (2026-11-15, recon only, no code changed)

**Live `branch/main`** (format 6, 0.6.0, 23 partitions, 21 inside the 7-day window), headless Chromium, cold, 3 runs:

| path | settled | requests | longest serial chain | MB |
| --- | --- | --- | --- | --- |
| site root (opens `#/dashboards/ci`) | 7.8–8.9 s | 383 | 285 | 33.5 |
| traces list (View = List) | 2.1–2.8 s | 76 | 32–35 | 13.2 |
| open a 1-span trace | 0.5–0.7 s | 38 | 18–19 | 1.7 |
| logs, first page | 2.0–2.7 s | 94 | 37–40 | 13.4 |

The engine is ready about 0.9 s after navigation (duckdb.wasm is 7.7 MB). Everything after that is data.

- On the dashboard, 252 of the 383 requests and 16.6 MB are range reads of `spans.parquet`. All 21 partitions are
  opened with 11–19 requests each.
- These reads come from two places. The *Steps* and *Slowest steps* toplists filter on
  `attributes["github.job.step.number"] != nil`, and no rollup dimension carries that attribute. The *Runs* traces
  widget filters on span attributes.
- Every list reads all 21 `span_rollups` files whole (3.8 MB) to compute its totals.
- A large trace (a CI run has about 190k spans) was not measured. It costs more than the 1-span trace.

**Engine and layout audit** (DuckDB-WASM 1.32.0 = DuckDB 1.4.3, Node, with request counts from the repo's
calibrated cost model):

- **Zone maps.** Over Parquet, DuckDB's zone maps are the row-group min/max statistics. We write them and DuckDB
  uses them. But spans, logs, points and rollups are sorted by `(scope, service, time)`
  (`src/format/parquet/columns.ts:225`), so every row group of a spans or logs file spans the file's whole time
  range, and time bounds and newest-first top-N prune nothing. Only `traces` (sorted by time) gets time pruning.
- **TOP-N.** DuckDB's TOP-N dynamic filter and late materialization are active, but row groups are read in file
  order. Two things cancel late materialization: a filter, and the scalar `count(*)` total inside the rows
  statement (2.8 MB → 7.6 MB).
- **ART.** These indexes exist only on native DuckDB tables. They do nothing over Parquet, so they are relevant to
  a backend only.
- **Parquet page index.** We write it, but DuckDB 1.4.3 never reads it. No change.
- **Bloom filters.** We write them on `trace_id` in traces and logs, and DuckDB uses them. Spans have none, so a
  trace's spans read the whole file (17–21 requests, 4 MB per file).
- **Dictionary encoding** is on for every column, including unique ids and timestamps. The `trace_id` dictionary
  alone is 410 KB of a 794 KB chunk.
- **Native `.duckdb` file over HTTP.** This could not be verified. It fits a static site badly anyway, because
  every publish would rewrite one large file.
- **Experiments on one 7.9 MB logs file** (requests / bytes):
  - newest 50 rows plus the total: 29 / 7.6 MB today, against 8 / 0.35 MB when sorted by time descending in
    8k-row groups.
  - a trace's spans by id: 17–21 / 4 MB today, against 7–9 / 0.36 MB with time sort, bloom filter and no
    dictionary on ids.
- **Statement fan-out.** Each page issues 5–6 statements, and the host answers one `POST /query` per statement.

## 3. Goals

1. The CI dashboard, the first page of the trace and log lists, and opening a trace each cost a small, bounded
   number of requests, whatever the window's partition count. Targets are in §7.
2. Lists page: a fast first page of 200 rows, and the next page loads on scroll. Each page is its own cheap
   statement.
3. Summaries (counts, totals, timelines, toplists, facets) come from rollups and manifest statistics wherever a
   rollup can answer them, including the shipped CI dashboard's widgets.
4. Each page's statements leave the viewer as one batch, so a future server answers a page with one request.
5. Close or retarget the performance tickets this work settles.

## 4. Non-goals

- The server batch endpoint itself. The maintainer chose to shape the query layer now and build the endpoint
  later.
- The threaded engine (#306). Decide on it after this lands, since the serial chain it attacks will be much
  shorter.
- Writer memory and test hygiene: #297, #210, #298, #286.
- Shipping a native `.duckdb` file, or ART indexes, on the static site.

## 5. Anti-goals

- Any listed path in §7 getting slower than today on the catalogue. In particular, the scope and service filters
  that prune row groups today must not start reading whole files.
- Lists that look or scroll differently. Paging is invisible to the user, apart from speed.
- Breaking the reading of format-6 reports. One format back stays readable: pushers run the released action while
  the deployer runs `main`.

## 6. Design

### 6.1 Format 7: files laid out for newest-first reads (writer)

- **Sort.**
  - Today's leading `scope_name` (and `service_name`) clustering is what lets
    `instrumentation_scope.name == "otel-html-ci"` read 3 requests instead of the whole file. A pure time sort
    would lose that.
  - The sort is therefore chosen **by measurement**, the first task of PR 1. The candidates are:
    - (a) `time DESC`
    - (b) `scope_name, time DESC`
    - (c) `scope_name, service_name, time DESC`
    - (d) a coarse time bucket (for example the hour, descending), then scope, service and time
  - Measure them on the query catalogue (`mise run test:scaling` shapes, with `rolling`
    (`test-support/scaling/shapes/rolling.json`) as the live-shaped one).
  - The unit is **modelled serial requests**, because live time follows serial request count.
  - Measure the list paths with the §6.2 statement shapes (cursor, cutoff, separate total), prototyped as harness
    catalogue entries in PR 1. Under today's shapes a time sort cannot show its gain on lists. PR 2 then moves
    those shapes into the viewer.
  - Pick the candidate with the lowest sum over the §7 paths, provided:
    - no §7 path gets worse than today;
    - no other catalogue entry gets worse by more than 10 %, except raw full scans that a rollup answers in the
      viewer. Those may regress, and the PR lists them.
  - Record the table in the PR.
  - My guess is (b), because scope cardinality is small and the CI scope is a sliver of the spans.
- **Tables affected.** The chosen sort applies to spans, logs and the two rollup tables. `points` keeps metric
  clustering, so it uses `(scope, service, metric, time DESC)`. `traces` changes to `time DESC`.
- **Row-group size.** Measure 8k, 16k and 50k under the chosen sort and pick by the same rule. The config floor in
  `src/config/schema.ts:138` (50,000) is lowered to whatever is chosen. Smaller groups make full scans worse, which
  is acceptable only because summaries move to rollups (§6.3).
- **Bloom filter** on `spans.trace_id` (`BLOOM_TABLES`, `src/format/parquet/bloom.ts:14`).
- **No dictionary encoding** on `trace_id`, `span_id`, `parent_span_id` and the time columns.
- **Manifest.** `formatVersion` goes to 7.
  - Readers accept 6 and 7.
  - `merge` and `--compact` rewrite format-6 partitions into format 7 when they compact a 24 h group. Copies that
    are not compacted stay format 6 until they rotate out.
  - The builder measures whether a rewrite of every copied partition on merge is affordable (see #297's memory
    note) and does it only if it is.

### 6.2 Viewer: lists page through a cursor

- **Views.** Views list files newest first (`src/query/sql/views.ts:89`).
- **List statements.** List statements for spans, logs and traces become
  `ORDER BY time DESC, filename, file_row_number LIMIT 200` with a keyset cursor
  `time < t OR (time = t AND (filename, file_row_number) > (f, r))` for the next page (the tie-breakers stay
  ascending, as in the ORDER BY). Under a time-sorted layout the cursor's predicate
  prunes row groups by their statistics.
- **Paging.** The virtualised list asks for the next page when the user scrolls near the end. `listCap` keeps
  capping the total rows held, and its default stays 10,000.
- **Other sort orders.** A list sorted by any column other than time keeps today's single statement, capped at
  `listCap`. It costs what it costs today, with no regression and no visible change.
- **Views drawn from list rows.** The logs scatter (`src/viewer/logs/views.ts:49`), and any other view that draws
  from list rows, gets its own narrow statement: the time and severity columns only, up to `listCap`, with late
  materialization. It looks the same, and its requests count against §7.
- **Totals.** Totals leave the rows statement.
  - An unconditioned or rollup-answerable total comes from rollups, or from manifest `rows` and time statistics.
  - Any other total is its own statement, run after the first page is shown.
  - `count(*) OVER ()` goes away.
- **Time cutoff.** Before a list's first page, use manifest per-file `timeMin`/`timeMax`/`rows` (unfiltered) or
  rollup counts (filtered) to find the smallest newest-first set of files that holds 200 rows. Only those files
  are listed in the statement, and the next page extends the set.
  - Every other file whose `timeMax` is at or above the kept set's smallest `timeMin` also joins, because
    partitions can overlap in time. An ascending time sort takes the oldest files first, by the mirror rule.
  - A filtered page without rollup counts that comes up short reads the next older group, until it fills or no
    file is left.
- **Trace list.** The unconditioned trace list stops grouping every traces file (`src/query/sql/spans.ts:116`).
  It groups only the files the cutoff keeps.
  - The cutoff also pulls in any older file whose `timeEndMax` reaches past the kept set's start, so a trace that
    crosses partitions is whole on the page that shows it. Rows already on screen never change or move.

### 6.3 Summaries from rollups, including the CI dashboard

- **Rollup dimensions.** Today they come from statistics keys (`statisticsKeysFor`, `src/format/parquet/stats.ts:157`):
  dashboard variables plus `writer.statisticsKeys`.
- **Widget conditions.** Extend them with the attribute keys that dashboard widgets' `query`/`where` conditions
  test, for spans and logs toplists, timelines and counts. Presence tests (`!= nil`) and equality are covered.
  This is derived from whatever dashboards the report's config declares, not hard-coded to the CI dashboard.
- **Rollup size.** The builder measures rollup growth on the live-shaped generator. If one widget's key makes a
  rollup larger than 15 % of its spans file, that key stays raw and is listed in the PR.
- **Traces widgets.** Traces widgets with span-attribute conditions (*Runs*) use the §6.2 cutoff and paging (the
  widget shows at most its row count), not a full scan.

### 6.4 One batch per page (query layer, for the future backend)

- **Batch API.** The data source gets a `runBatch(statements)` that the page's hooks feed. One microtask's worth of
  statements from the same render go out together.
- **In the browser,** the batch runs its statements in order on the one engine. The behaviour is the same as
  today.
- **In `src/host`,** the client sends the batch as today's per-statement `POST /query` calls for now. The seam is
  where a single `POST /query/batch` will go later. No server endpoint is in scope.
- **Batch count.** "One batch" is a goal, not a literal rule. Deferred totals, dependent follow-ups (a list's
  service shares, rollup views bound on first use) and widgets that render at different times may each add a
  batch.
- **Test.** The batch count per page open is measured, recorded in the PR, and pinned by a test, so the future
  endpoint's request count is known and cannot grow unnoticed.

### 6.5 Inline fixes (Also)

- **#290.** `small-files.ts` remembers a confirmed size mismatch, so a failed Refresh does not refetch twice per
  statement.
- **#239.** The Metrics Catalog's `SELECT DISTINCT` over `points` is answered from manifest statistics where they
  hold the identity columns. Do this only if it falls out of the §6.1 points change; otherwise leave #239 open.

## 7. Targets

These targets are my call. The maintainer can change them.

| path | today (live) | target (live, after format-6 copies rotate out) |
| --- | --- | --- |
| CI dashboard | 383 req, 285 chain, 7.8–8.9 s | ≤ 100 req, ≤ 3 s |
| traces list, first page | 76 req, 2.1–2.8 s | ≤ 25 req after boot |
| logs list, first page | 94 req, 2.0–2.7 s | ≤ 20 req after boot |
| next page of either list | n/a (one 10k-row query) | ≤ 6 req |
| open a trace (1 span / a CI run) | 38 req / not measured | ≤ 12 req / measured and recorded |

- **Gate.** The live targets are recorded, not gated, because live coverage grows as format-6 copies rotate out of
  the 7-day window (about 7 days after release). Harness-to-live ratios also ran from 0.3× to 2.8× last time.
- **What CI gates.** CI gates the catalogue as today (`test:scaling` classes). A page-level ratchet is added too:
  modelled serial requests per §7 path on the `rolling` shape, pinned at the value PR 1 or PR 2 measures, plus
  10 %.
- **CI dashboard path.** The catalogue rule against naming a dashboard (`test/scaling/catalogue.test.ts:162`)
  stays. That path is expressed as its widget statements (an attribute-condition toplist, a traces widget with
  span-attribute conditions, a logs severity list), not as "the CI dashboard".

## 8. PRs

| # | branch | contents | closes |
| --- | --- | --- | --- |
| 1 | `perf/format-7-layout` | §6.1 (sort and row-group measurement first), §6.3 rollup dimensions, newest-first view order, catalogue re-derivation | #291, #284 (if the measurement shows it), #240 if points layout settles it |
| 2 | `perf/paged-lists-batch` | §6.2, §6.4, §6.5 | #290, maybe #239 |
| — | docs PR after a release | live record (§7), close or retarget #287 and #229, close #281 now with its evidence (#289) | #281, #229 / #287 per record |

Order: 1, then 2. PR 2 depends on the time-sorted layout for its cursor pruning. Releasing is the maintainer's
call, and the live record waits for a release that includes PR 1.

## 9. Left to the builder

- The candidate sort, row-group size and rollup-key list, by the rules above.
- How the scroll trigger and the cutoff extension are wired in the viewer.
- Whether `traces` drops dictionary encoding on more columns.
- The exact batch-collection mechanism.

Every such call is recorded in the PR body.

## 10. Calls I made (not the maintainer's)

- The sort is chosen by measurement, not pure `time DESC`, because a pure time sort would lose the scope pruning
  the CI dashboard depends on.
- The rollup dimensions are extended from dashboard conditions.
- Two PRs plus a docs record.
- The reviewer's questions, settled as above:
  - non-time sorts keep today's statement;
  - views drawn from list rows get their own narrow statement;
  - the trace-list cutoff follows `timeEndMax`;
  - the batch count is pinned, not forced to one;
  - the measurement unit is modelled serial requests;
  - the ratchet gate.
- The targets in §7.
- #306, #297, #210, #298 and #286 are out of scope.
