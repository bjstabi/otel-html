# Query layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CI dashboard, the first page of the trace and log lists, and opening a trace each cost a small, bounded
number of requests. Lists page by a cursor. Each page's statements leave the viewer in batches a future server can
answer in one request each.

**Architecture:** PR 1 writes format 7. Files are sorted so DuckDB's row-group statistics (its zone maps over Parquet)
can skip by time. Spans get a `trace_id` bloom filter, unique ids lose dictionary encoding, and rollups carry the
attribute keys that dashboard widget conditions test. The sort and row-group size are picked by a measurement that
runs first. PR 2 changes the viewer's list reads: a newest-first file cutoff, keyset pages of 200 rows loaded on
scroll, totals out of the rows statement, and a `queryBatch` seam on the engine. A docs PR records the live numbers
after a release.

**Tech Stack:** TypeScript, parquet-wasm 0.9.0 (`WriterPropertiesBuilder`), DuckDB-WASM 1.32.0 (DuckDB 1.4.3),
vitest, Playwright, mise.

**Spec:** `docs/superpowers/specs/2026-11-15-query-layout-design.md` (approved 2026-11-15).

**PR process:** unattended (`docs/agents/process-unattended.md`).
- One PR per row, in order. Each starts from `main` after the previous one merged.
- Implementers and task reviewers run on Sonnet 5.5; the branch review runs on Opus 5.5.
- The maintainer approved format 7 (2026-11-15). That covers the files these tasks list under `src/format/`,
  `src/writer/`, `src/cli/` and `src/host/`.
- Every workflow and action file is still a stop, as is any other file the deployer runs.

| #   | branch                  | PR title                                                                | closes            | status |
| --- | ----------------------- | ----------------------------------------------------------------------- | ----------------- | ------ |
| 1   | `perf/format-7-layout`  | `feat(format): format 7 lays files out for newest-first reads`          | #291 (+ #284, #240 if measured) |        |
| 2   | `perf/paged-lists`      | `perf(viewer): lists page by cursor from the newest files; batched statements` | #290 (+ #239 if it falls out) |        |
| 3   | `docs/query-layout-record` | `docs: query-layout live record`                                     | #281; #229/#287 per record |        |

## Global Constraints

- **No answer changes.** Every catalogue entry and page returns the same rows, totals, facets and buckets as on
  `main`, except the rows a page has not loaded yet.
- **Formats.** Readers accept formats 6 and 7. Nothing writes format 7 until Task 2 (readers) is committed on the
  branch. Format-6 reports keep opening.
- **Measurement.** The unit is modelled serial requests (`test-support/scaling/cost.ts`), and the live-shaped report
  is the `rolling` shape (`test-support/scaling/shapes/rolling.json`).
- **Pick rule (spec §6.1).** The chosen layout must meet both:
  - no §7 path is worse than `main`;
  - no other catalogue entry is worse by more than 10 %, except raw full scans that a rollup answers in the viewer.
    Those are listed in the PR body.
- **List pages.** Page size is 200 rows. `viewer.listCap` (default 10,000) caps the rows held.
- **Non-time sorts.** A list sorted by anything but time keeps today's single statement capped at `listCap`.
- **Trace lists.** Rows already shown never change or move. The cutoff pulls in every older file whose `timeEndMax`
  reaches the kept set's start.
- **Rollup size.** A widget-condition rollup key that makes a rollup larger than 15 % of its spans/logs file stays
  raw, and the PR names it.
- **Gates.** The §7 targets (spec) are recorded live, not gated. CI gates the catalogue classes as today, plus a
  per-page ratchet of modelled serial requests on `rolling`, pinned at the measured value + 10 %.
- **No new dependency.** No workflow or action file changes. Run `mise run check` after every task and
  `mise run verify` before each PR.
- **Commits and PR bodies** follow `docs/agents/conventions.md`. PR bodies carry the measurement tables the tasks
  name.

## Review Focus

1. **Equal timestamps across files.** Rows with the same `time` in different files and row groups must page without
   a duplicate or a gap, through the `(time, filename, file_row_number)` cursor. Test: Task 7.
2. **A trace that crosses partitions.** It appears once on the trace list's first page, whole (true start, span
   count), and does not move when the next page joins older files. Test: Task 8.
3. **A rolling report mixing format-6 and format-7 partitions.** Lists stay newest first and correct, and trace
   lookups work on both layouts. Test: Tasks 6 and 8.
4. **Filter, window or sort changes while a next page is in flight.** The stale page is dropped and never appended
   to the new list. Test: Task 10.
5. **Residual (non-SQL) conditions.** They keep paging through `residualRows` with the same rows and totals as on
   `main`. Test: Task 9.

---

## PR 1: format 7

### Task 1: measure the layout candidates (decides Tasks 3–5's values)

**Files:**
- Create: `scripts/measure-layout.ts` (kept; `mise run measure:layout`), `test-support/scaling/layout-statements.ts`
- Modify: `src/format/parquet/columns.ts`, `src/format/parquet/codec.ts`. Thread an internal `LayoutOptions`
  through `encodeTable`, defaulting to today's layout so nothing else changes. Also `mise.toml` (the new task, with
  its description; run `mise run gen`).
- Test: `test/format/parquet/layout-options.test.ts`

**Interfaces:**
- Produces: `interface SortKey { column: string; dir: 'asc' | 'desc' }`.
- Produces: `interface LayoutOptions { sort?: Partial<Record<Table, readonly SortKey[]>>; rowGroupRows?: number; noDictionary?: readonly string[]; bloom?: ReadonlySet<Table> }`.
- Produces: `encodeTable(table, rows, opts: EncodeOptions & { layout?: LayoutOptions })`.
- Produces: `LAYOUT_STATEMENTS: readonly { id: string; sql: (ids: ScalingIds) => string }[]`. These are the
  spec §6.2 shapes written as SQL:
  - the newest 200 spans or logs from the cutoff files;
  - the next page by cursor;
  - the newest 200 with `severity_number >= 13`;
  - a `scope_name = 'otel-html-ci'` toplist with an attribute presence condition;
  - trace spans by id with the time bound;
  - a traces top-N;
  - a count by minute.

- [ ] **Step 1: failing test.** `test('a layout sorts by its keys, desc included, and sets row groups and dictionaries', …)`
  - Encode 1,000 spans with `sort: { spans: [{column:'scope_name',dir:'asc'},{column:'start_time_unix_nano',dir:'desc'}] }`,
    `rowGroupRows: 100`, `noDictionary: ['trace_id']`.
  - Read it back with DuckDB `parquet_metadata`. Expect: 10 row groups; rows ordered as given; no dictionary page
    on `trace_id`; a dictionary page on `service_name`.
- [ ] **Step 2:** `pnpm exec vitest run test/format/parquet/layout-options.test.ts` → FAIL.
- [ ] **Step 3: implement.**
  - Sort with nulls last, stable.
  - `setColumnDictionaryEnabled(col, false)` per `noDictionary` column.
  - `rowGroupRows` overrides the configured value.
  - A missing `layout` writes byte-identical files to `main`. Assert this in the same test against a file encoded
    without `layout`.
- [ ] **Step 4:** → PASS. Commit `test(scaling): layout options for the format-7 measurement`.
- [ ] **Step 5: build the measurement.**
  - `scripts/measure-layout.ts` builds the `rolling` shape once per candidate:
    - sorts: (a) `time DESC`; (b) `scope_name, time DESC`; (c) `scope_name, service_name, time DESC`; (d) hour
      bucket DESC, `scope_name, service_name, time DESC`. Traces always sort by `time DESC`; points by
      `scope, service, metric, time DESC`.
    - row-group sizes: 8,192, 16,384 and 50,000.
    - every candidate uses `noDictionary` on `trace_id, span_id, parent_span_id` and the time columns, and bloom
      filters on traces, logs and spans.
  - For each candidate it runs `LAYOUT_STATEMENTS` and the full catalogue (`test-support/scaling/measure.ts`) cold
    in the counting engine.
  - It prints modelled serial requests and bytes per statement and per entry, against `main`'s layout.
- [ ] **Step 6: run it and apply the pick rule** (Global Constraints).
  - Write the table and the pick to `.superpowers/sdd/2026-11-15-query-layout/layout.md` (git-ignored); it goes
    into PR 1's body.
  - **Stop and ask** if no candidate meets the rule.
- [ ] **Step 7:** commit `test(scaling): measure:layout compares format-7 layout candidates`.

### Task 2: readers accept format 7

**Files:**
- Modify:
  - `src/format/version.ts`: `READABLE_PARTITION_FORMATS = [6, 7]`, `READABLE_FORMAT_VERSIONS` gains 7,
    `oldFormatMessage` names 6 and 7. Format 5 drops out: one format back.
  - `src/format/manifest.ts`: the format-7 schema is format 6's.
  - `src/host/manifest.ts`, `src/viewer/data/open-report.ts`.
  - The format gates found by `grep -rn "READABLE_PARTITION_FORMATS\|formatVersion === 6\|formatVersion: 6" src`.
- Test: `test/format/compat.test.ts`, `test/viewer/open-report.test.ts`, `test/host/manifest.test.ts`. Move the
  tests that build a format-5 manifest to 6.

- [ ] **Step 1: failing tests.**
  - A format-7 manifest parses, and the viewer and host open it.
  - A format-5 manifest is refused with `oldFormatMessage(5)`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `mise run check` → PASS.
- [ ] **Step 5: check the dropped format.**
  - Dropping format 5 must lose nothing live: the live report is format 6.
  - Check the deploy path the way read-debt PR 0 did (`mergeSkippingBad` warns and skips a format-5 run).
  - **Stop** if any path in the deployer would refuse instead.
- [ ] **Step 6:** commit `feat(format): read format 7`.

### Task 3: the writer writes format 7

**Files:**
- Modify:
  - `src/format/parquet/columns.ts`: `SORT_COLUMNS` becomes `Record<Table, readonly SortKey[]>` with Task 1's
    pick. Update every reader of `SORT_COLUMNS`.
  - `src/format/parquet/codec.ts`: `writerProperties` sets `noDictionary` columns.
  - `src/format/parquet/bloom.ts`: `BLOOM_TABLES` gains `'spans'`.
  - `src/format/version.ts`: `PARTITION_FORMAT_VERSION = 7`.
  - `src/config/schema.ts:138`: the `rowGroupRows` floor and default become Task 1's pick.
  - `src/writer/merge.ts` and `src/writer/compaction.ts`: compacting a 24 h group that holds format-6 partitions
    writes them in format 7.
  - `README.md`: the format table and `writer.rowGroupRows`.
- Test: `test/format/parquet/codec.test.ts`, `test/format/parquet/bloom.test.ts`, `test/writer/compaction.test.ts`,
  `test/writer/merge-copy.test.ts`, `test/config/schema.test.ts`

- [ ] **Step 1: failing tests.**
  - Spans files carry a `trace_id` bloom filter, and DuckDB skips a row group without the id (assert the
    statement's row groups read, as `bloom.test.ts` does for logs).
  - Rows come back in the picked order.
  - `trace_id` has no dictionary page.
  - `merge --compact` of a 24 h group of format-6 partitions writes one format-7 partition with identical
    `SELECT * ORDER BY ALL` rows.
  - A merge that only copies a format-6 partition copies it as is.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `mise run check` → PASS.
- [ ] **Step 5: measure copy rewrites.**
  - Measure peak memory of a merge that also rewrites copied format-6 partitions (spec §6.1; #297's concern)
    on the `rolling` shape.
  - Rewrite copies only if the peak stays under the current merge's peak + 25 %. Record the numbers and the call.
- [ ] **Step 6:** commit `feat(format): write format 7 (newest-first sort, spans bloom, no dictionary on ids)`.

### Task 4: rollups carry the keys widget conditions test

**Files:**
- Create: `src/config/widget-keys.ts`
- Modify: `src/format/parquet/stats.ts` (`statisticsKeysFor` adds the widget keys), `src/writer/rollup-rows.ts`
  (`rollupDimensions`), `src/writer/partition-session.ts` (the 15 % rule beside `rollupAllowed`; warn with the key)
- Test: `test/config/widget-keys.test.ts`, `test/writer/rollup-rows.test.ts`

**Interfaces:**
- Produces: `widgetConditionKeys(dashboards: readonly ResolvedDashboard[]): string[]`.
  - It covers the `attr:`/`resource:` keys that spans/logs toplist, timeline, count and traces widgets test in
    `query`/`where`, by equality or presence, walking `parseCondition`'s `Expr`.
  - Keys come back sorted and distinct.
- Produces: `rollupKeyAllowed(rollupBytes: number, baseBytes: number): boolean` (≤ 15 %).

- [ ] **Step 1: failing tests.**
  - Over `.github/otel-html-ci.yaml`, `widgetConditionKeys` returns at least `attr:github.job.step.number`,
    `attr:cicd.pipeline.task.run.id` and `attr:cicd.pipeline.task.run.result`.
  - A metric widget's `where` contributes nothing.
  - A key whose rollup passes 15 % is dropped with a warning naming it.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5: check the route.** `pnpm exec vitest run test/viewer/scaling-pages.test.tsx` shows the *Steps*
  toplists routed to rollups. Assert it in `test/viewer-data/route.test.ts` with the CI config.
- [ ] **Step 6:** commit `perf(writer): rollups carry the attribute keys dashboard widgets test`.

### Task 5: views read newest first; trace spans use the bloom and time bound

**Files:**
- Modify: `src/query/sql/views.ts:89` (files listed by partition descending), `src/query/sql/spans.ts`
  (`traceSpansQuery` keeps its time bound; nothing else should need to change: check), `src/viewer/data/catalogue.ts`
  (`KNOWN_DEBT`: set the #291 line `measured: true`, run the class test, delete the line)
- Test: `test/query/sql/views.test.ts`, `test/scaling/classes.test.ts`

- [ ] **Step 1: failing test.** `viewStatements` lists `data/partitions/000023/...` before `000022`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `mise run test:scaling` passes.
  - `trace.get` is no longer in the `density`/`matched` debt.
  - Any catalogue class that moves follows the pick rule. Re-derive the declared classes for moves that improve.
- [ ] **Step 5:** commit `perf(viewer): views read the newest partitions first; trace.get debt paid`.

### Task 6: the page ratchet, and PR 1

**Files:**
- Modify:
  - `test/viewer/scaling-pages-support.tsx`: `PAGES` gains `'#/traces/<traceId>'`, a trace view on the CI run
    trace of the shape, and `PAGE_CALLS` gains its calls.
  - `test/viewer/scaling-pages.test.tsx`: a `rolling` assertion per page, with
    `PAGE_SERIAL_MAX: Record<Page, number>` set to the measured value + 10 %.
- Test: the same files, plus a mixed report (three format-6 partitions written by a `layout` matching format 6,
  then four format-7 ones): the trace list and logs list are newest first and equal to an all-format-6 build of
  the same rows.

- [ ] **Step 1:** write the ratchet and the mixed-report test. **Step 2:** run them → PASS on the branch. Record
  the before (on `main`) and after per page.
- [ ] **Step 3:** run `mise run verify` → PASS.
- [ ] **Step 4: open PR 1.**
  - Title as in the table.
  - The body carries: Task 1's table and pick; Task 3's merge memory numbers; Task 4's dropped keys, if any; the
    page ratchet before and after; the catalogue class moves.
  - `Fixes #291`. Add `Fixes #284` and `Fixes #240` only if the table shows their entries fixed; otherwise comment
    the numbers on them.
- [ ] **Step 5:** branch review on Opus 5.5 → fix → CI green → merge.

## PR 2: paged lists, totals apart, batches

### Task 7: list statements page by cursor

**Files:**
- Modify: `src/query/sql/spans.ts` (`spanRowsQuery`), `src/query/sql/logs.ts` (`logRowsQuery`)
- Test: `test/query/sql/spans.test.ts`, `test/query/sql/logs.test.ts`

**Interfaces:**
- Produces: `interface RowCursor { time: bigint; filename: string; row: bigint }`.
- Produces: `spanRowsQuery(f, sort, limit, cursor?: RowCursor | null)` and `logRowsQuery(f, sort, limit, cursor?)`.
  - With a time sort, the cursor adds `(time, filename, file_row_number) < (…)`, or `>` for `asc`.
  - With a time sort, the scalar `total` subquery is gone: the column is not selected.
  - Other sorts keep today's shape, and `total`, unchanged.
- Produces: `spanTotalQuery(f)` and `logTotalQuery(f)` (`count(*)` only), routed to rollups through
  `src/viewer/data/route.ts` when the filter is rollup-answerable.

- [ ] **Step 1: failing tests.**
  - The SQL shape with and without a cursor.
  - Run on a fixture with 5 rows at one timestamp spread over 2 files: pages of 2 return all 5 exactly once, in
    order. This is Review Focus 1.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. **Step 5:** commit
  `perf(query): list statements page by a time cursor; totals are their own statement`.

### Task 8: the newest-files cutoff

**Files:**
- Create: `src/query/sql/cutoff.ts`
- Test: `test/query/sql/cutoff.test.ts`

**Interfaces:**
- Produces: `newestFiles(manifest: ManifestV4, table: 'spans' | 'logs' | 'traces', pruned: Pruned, need: number, counts?: ReadonlyMap<string, number>): { files: Pruned; complete: boolean }`.
  - It returns the fewest partitions, newest first by `timeMax`, whose rows (from `counts` when given, else the
    file's `rows`) reach `need`.
  - For `traces`, it adds every older file whose `timeEndMax` is at least the kept set's smallest `timeMin`.
  - `complete` means every pruned file is in.
- Produces: `rollupCounts(...)`. It reads per-file counts from the rollups for a filtered list: one statement over
  the rollup files, `GROUP BY filename`, mapped back to base files by partition.

- [ ] **Step 1: failing tests.**
  - 10 partitions of 100 rows with `need` 200 keep the newest 2.
  - With `counts` showing 0 matches in the newest 3, it keeps partitions 4–6.
  - A trace whose `timeEndMax` reaches into an older partition pulls that partition in. This is Review Focus 2.
  - Mixed format-6 and format-7 partitions give the same answer.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. **Step 5:** commit
  `perf(query): pick the newest files that can fill a page`.

### Task 9: the data source pages

**Files:**
- Modify:
  - `src/viewer/data/results.ts`: `SpanQuery` and `LogQuery` gain `cursor?: RowCursor | null`, results gain
    `next: RowCursor | null`.
  - `src/viewer/data/duckdb-source.ts`: the rows paths at :459, :540–:590 and :920–:940 use `newestFiles` and the
    cursor, the total comes from the total need, and `traceList` uses `newestFiles` for the unconditioned list
    instead of grouping every traces file.
  - A conditioned trace list (the *Runs* widget, spec §6.3) takes its spans files from `newestFiles` over spans,
    with `rollupCounts` when the condition is rollup-answerable.
  - `src/viewer/data/catalogue.ts`: the `*.rows` and `traces.list` entries ask a first page; a `*.rows.next` entry
    per table.
- Test: `test/viewer-data/duckdb-source-paging.test.ts`, `test/scaling/classes.test.ts`

- [ ] **Step 1: failing tests.**
  - Paging the logs, spans and traces lists to the end returns exactly `main`'s 10,000-row answer, in order,
    totals equal.
  - A residual condition returns `main`'s rows and totals. This is Review Focus 5.
  - A first page reads only the cutoff files, checked against the recorded file list.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `mise run check` → PASS (re-derive the improved
  classes). **Step 5:** commit `perf(viewer): lists read a page at a time from the newest files`.

### Task 10: the viewer loads pages on scroll

**Files:**
- Modify:
  - `src/viewer/components/results-table.tsx`: `onEndReached` when the last 50 rows render.
  - `src/viewer/logs/explorer.tsx`, `src/viewer/traces/explorer.tsx`, and the page hooks (`useLogsPage`, the
    traces page hook): `limit: 200`, append on `next`, stop at `listCap`, and drop a page whose query key changed.
  - `src/viewer/logs/views.ts:49`: the scatter's own statement, time and severity only, up to `listCap`.
- Test: `test/viewer/logs/explorer-paging.test.tsx`, `test/viewer/traces/explorer-paging.test.tsx`,
  `e2e/logs.spec.ts` (scroll to the end loads the next page; row count grows by 200)

- [ ] **Step 1: failing tests.**
  - Scrolling appends the next page.
  - A filter change while a page is in flight shows only the new list. This is Review Focus 4.
  - The scatter plots the same points as on `main`.
  - A non-time sort issues one statement with `limit: listCap`.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** `mise run test:e2e:chromium -- e2e/logs.spec.ts e2e/traces.spec.ts`
  → PASS. **Step 5:** commit `feat(viewer): lists load the next page on scroll`.

### Task 11: a page's statements go as batches

**Files:**
- Modify:
  - `src/viewer/data/query-engine.ts`: `queryBatch(qs: readonly Query[], signal?): Promise<Table[]>`.
  - `src/viewer/data/duckdb-source.ts`: a `Batcher` collects the `read` calls of one microtask and sends them with
    `queryBatch`.
  - The browser engine runs them in order on its one connection.
  - The host engine client sends one `POST /query` per statement for now, with a `// seam: POST /query/batch`
    comment.
  - `test/viewer/scaling-pages.test.tsx`: `PAGE_BATCH_MAX` per page, pinned at the measured value.
- Test: `test/viewer-data/batcher.test.ts`

- [ ] **Step 1: failing tests.**
  - Three `read`s in one tick make one `queryBatch` of 3.
  - An aborted signal rejects only its own query.
  - A failing statement rejects only its own caller.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS; record batches per page. **Step 5:** commit
  `refactor(viewer): a page's statements go to the engine in batches`.

### Task 12: Also, then PR 2

**Files:**
- Modify: `src/viewer/data/engine/small-files.ts` (#290: a path whose fresh fetch still mismatched is remembered,
  so no later statement refetches it until `forget`), `src/viewer/data/refresh-report.ts`
- Test: `test/viewer-data/small-files.test.ts`

- [ ] **Step 1: failing test.** After a mismatch confirmed by the fresh fetch, two statements make 0 further
  `fetchWhole` calls for the path.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. Commit
  `fix(viewer): a confirmed size mismatch is not refetched per statement`.
- [ ] **Step 5: #239.**
  - If format 7's points stats now hold the metric identity columns, answer `metricIdentitiesQuery` from the
    manifest. Test: `metricCatalog` makes 0 statements against points. Commit.
  - Otherwise comment on #239 with why, and leave it.
- [ ] **Step 6:** run `mise run verify` → PASS.
- [ ] **Step 7: open PR 2.** The body carries the page ratchet before and after, batches per page, `Fixes #290`,
  and `Fixes #239` if Step 5 did it. Branch review on Opus 5.5 → CI green → merge.

## PR 3: live record (after the maintainer releases PR 1 and PR 2)

### Task 13: record

- [ ] **Step 1: measure live, cold, three times.**
  - The pages are: site root, `#/dashboards/ci`, the traces list, the logs list's first and next page, a 1-span
    trace, and a CI run trace.
  - Use the session's Playwright script (recreate from the spec §2 method).
  - Re-measure once the format-6 copies have left the 7-day window.
- [ ] **Step 2: record and close.**
  - Add a "Record" section to this plan comparing against the spec §7 targets.
  - Close #281 with #289 as evidence.
  - Close or retarget #229 and #287 with the numbers.
  - Open an issue for any target missed, and reconsider #306 there.
- [ ] **Step 3:** commit `docs: query-layout live record`, open PR 3, merge on green.
