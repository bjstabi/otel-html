# Widget trace index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A traces widget on a dashboard lists its traces from a small per-partition index (`widget_traces`) instead of
scanning every `spans.parquet`, with the same answer as the scan. `merge` repairs copied rollups that lack a widget key.

**Architecture:** PR 1 is the format and the writer. Format 7 adds the `widget_traces` table, `PartitionFile.widgetIndex`
and `RollupDescription.refused`. The writer fills the table at flush, compaction and merge-copy, behind a 5 % guard.
`#recomputedRollup` then skips only keys a writer recorded as refused. PR 2 is the viewer. A traces widget passes its
query and variable bindings as a hint. The data source routes each partition whose index covers them to the index,
and every other partition to today's scan. The membership relation is the union of the two. Before PR 2 opens, the
plan measures the CI dashboard on the live-data rebuild against spec §6.

**Tech Stack:** TypeScript, parquet-wasm 0.9.0, apache-arrow, DuckDB-WASM 1.32.0 (DuckDB 1.4.3), vitest, Playwright, mise.

**Spec:** `docs/superpowers/specs/2026-11-16-widget-trace-index-design.md` (format 7 confirmed by the maintainer 2026-11-16).

**PR process:** unattended (`docs/agents/process-unattended.md`).
- One PR per row, in order. PR 2 starts from `main` after PR 1 merged.
- Implementers and task reviewers run on Sonnet 5.5. The branch review runs on Opus 5.5.
- The maintainer approved the format change this plan lists under `src/format/`, `src/writer/` and `src/cli/ci/`
  (2026-11-16). Every workflow and action file is still a stop, as is any other file the deployer runs.

| #   | branch                        | PR title                                                                         | closes | status |
| --- | ----------------------------- | -------------------------------------------------------------------------------- | ------ | ------ |
| 1   | `feat/widget-trace-index`     | `feat(format)!: format 7 writes a widget trace index and records refused rollup keys` |        |        |
| 2   | `perf/widget-trace-index-viewer` | `perf(viewer): traces widgets read the widget trace index`                    |        |        |

## Global Constraints

- **No answer changes (Goal 2).** A routed traces widget returns the same rows, order, counts and `total` as the scan.
  This holds for every window, every variable binding and both directions of the default sort (`start`). When the
  index cannot answer exactly, that partition scans. The list is never approximate.
- **Format.** The writer writes format 7. The viewer, `host`, `merge` and `upgrade` read formats 5, 6 and 7.
  `upgrade` of a format 5 or 6 report rewrites the manifest's version only. A format 5 or 6 input to `merge` is
  copied, and the copy computes its index.
- **The table.** It is `widget_traces`, one row per distinct (`condition`, `trace_id`, `var:<key>`…). Every column
  is utf8, sorted by `condition`, then `trace_id`.
  - `condition`: the first 16 hex digits of SHA-256 of the normalized widget `query`.
  - `var:<key>`: one column per variable key of every dashboard that has an indexed traces widget. It holds the
    matching span's resource attribute value when that value is a string, else null.
- **The manifest entry.** It is `widgetIndex: { conditions: string[]; variables: string[] }`, sorted, on the
  `widget_traces` file. It is written even when the table has 0 rows, as long as the partition has spans.
- **Size guard.** A partition's table is not written when its own bytes exceed 5 % of the encoded `spans.parquet`.
  Its own bytes are its encoded size less an empty table of the same columns (Plan note 8). A warning names the
  condition.
- **Refusals.** `RollupDescription.refused?: string[]` holds the sorted widget keys a writer weighed and refused.
  `#recomputedRollup` skips a missing widget key only when it is in `refused`.
- **Coupling.** Nothing in `src/` names the CI dashboard. The indexed conditions come from
  `widgetTraceConditions(dashboards)`, beside `widgetConditionKeys` (`src/config/`).
- **Targets (spec §6), on the live-data rebuild at 14 ms per request:**
  - CI dashboard, no variables: ≤ 170 requests, settled ≤ 3.0 s, 0 `spans.parquet` reads.
  - CI dashboard with `job` bound: 0 `spans.parquet` reads.
  - Traces list, logs and trace open: no worse than the baseline rebuild.
  - `widget_traces` bytes ≤ 1 % of spans bytes.
  - These are recorded, not gated. A miss is a stop (process: "a measurement … worse than the plan's expectation").
- **Gates.** CI gates the catalogue classes and the page ratchet on `mixed` as today. `#/dashboards/ci` holds or
  improves on its pins.
- **No new dependency.** No workflow or action file changes. Run `mise run check` after every task and
  `mise run verify` before each PR. Commits and PR bodies follow `docs/agents/conventions.md`.

## Review Focus

1. **A partition with spans but no matching span.** It must still list an empty `widget_traces` with its `widgetIndex`.
   It then contributes no members and reads no spans, and is not scanned. A partition without spans has no table.
   Test: Task 4.
2. **Partitions written under another config.** Some partitions are indexed, others are not, or their index lacks a
   condition or a variable column. This happens with an older input, a merged report, or a changed `variables` list.
   Those partitions scan, the rest route, and the answer equals the all-scan answer. Test: Task 5 (copy) and
   Task 9 (answer).
3. **Variables that are not strings.** A binding of kind `int`/`double`/`bool` sends every partition to the scan.
   A resource holding the int 123 with a string binding `"123"` matches on neither path. Test: Task 9.
4. **One trace whose matching spans are in two partitions, one indexed and one not.** Under a long window whose
   start falls inside the trace, it is listed once, with its true start and counts, in both sort directions.
   Test: Task 9.
5. **A following traces widget narrowed by a selection to a short window.** It scans and returns today's list.
   Test: Task 9 asserts it reads `spans.parquet`; Task 10 asserts the hint is still sent.

## Plan notes against the spec

1. **Short windows (spec §5.4: "the window (`traceStartIn`) … stay as they are").**
   - The code has two window semantics. Only a long window (≥ `LONG_WINDOW_NS`, about 4.7 h) picks traces by their
     start (`windowTraceRowsQuery`, `traceStartIn`). There the condition reads every span of the named partitions
     whatever its time, so the index answers exactly.
   - A short window filters the *matching spans* by overlap (`whereOf`: `end >= lo AND start <= hi`). That covers
     `traceRowsQuery`, `spanCountQuery` and the paged `tracePage`. The index holds no span times, so it cannot
     answer that.
   - **Resolution:** route only when the filter has no window or the window is long. A short window scans every
     partition. The CI dashboard's default 7 d window is long. A selection-narrowed widget scans.
2. **Per-report columns (§5.1 `var:<key>`) against a static schema.**
   - `TABLE_COLUMNS`, `checkRow`, `batchFromRows`, `columnsToArrow`, `arrowSchema` and the views all key off the
     table name.
   - **Resolution:**
     - `TABLE_COLUMNS.widget_traces` holds the two fixed columns.
     - The codec entry points take an optional `columns` list.
     - `viewStatements` leaves `widget_traces` out: one view with `union_by_name = false` would fail on differing
       columns.
     - The routed statement reads the index files inline with `read_parquet([...], union_by_name = true)`, as
       `ownFiles` reads spans.
3. **The hash.** The flush's derive hook is synchronous. `crypto.subtle` is async, and absent outside secure
   contexts (a report served over plain http from a non-localhost host). **Resolution:** a small synchronous SHA-256
   in `src/model/sha256.ts`, shared by writer and viewer and checked against `node:crypto`. No dependency.
4. **"Evaluates it per span … as a column batch" (§5.3).**
   - `compileCondition` tests a `SpanTarget` (records), not rows.
   - **Resolution:** build the target per row with `spanFromRow` (`src/format/parquet/decode.ts`).
   - Times are rebased onto the batch's smallest start first. `spanFromRow` turns times into a `Number`, which
     loses nanoseconds on absolute times. The target's `epoch` is that anchor.
   - Task 4 measures the cost per flush.
5. **The empty index.** Spec §5.1 says a partition without the entry is scanned. For a partition with no match to
   route, the table must exist with 0 rows. `PartitionWriter` and `compactPartitions` skip empty tables today.
   **Resolution:** `widget_traces` is written whenever the partition has spans (Review Focus 1).
6. **Variable kinds.** A bound variable compares typed (`variableCondition`, by the facet's kind). **Resolution:**
   the index stores string values only, and the hint is sent only when every binding's kind is `string`. `mixed` is
   already bound as `string`.
7. **Residual and query-less widgets.**
   - A condition with residual (browser-evaluated) terms takes the id-table path. **Resolution:** route only when
     the condition translates to SQL whole (`residual === null`).
   - A traces widget without `query` lists traces from `traces` alone when no variable is set. **Resolution:** it is
     not indexed; with variables bound it scans, as today.
8. **What the 5 % weighs (decision for the maintainer to confirm).**
   - A Parquet file has a fixed cost of about 1 KB. Measured on the whole file, every flush partition under about
     20 KB of spans would refuse its index and scan.
   - **Resolution:** follow `#rollupOf`'s precedent and weigh the table's own bytes (encoded size less an empty
     table of the same columns) against the encoded spans file.
9. **Format gates beyond the readers.** These compare with `6` exactly and must read `>= 6`:
   - `shell.tsx` (absolute URLs), `keepAnchor` (`refresh-report.ts`), `manifestForWrite` (`manifest.ts`) and the
     checkpoint's epoch check (`checkpoint.ts:169`).
   - `newRunManifest` and `withSharesFormat` (`src/cli/ci/run-report.ts`) write 6 and must write 7.
10. **Frozen fixture.** The fixtures README adds a frozen report when the release is cut. Format 6 was frozen from its
    feature branch head (`0e9c9b97`), and so is format 7 here (Task 7). This lets `compat`, `host` and `e2e/frozen`
    hold the shape from the first merge. `mise run fixtures` (the OTLP inputs) is not needed: no input changes.
11. **`refused` on a summed compaction.** Spec §5.5 names only #339's union path. **Resolution:**
    - When `planRollup` sums equal inputs, the output's `refused` is the keys every input refused (the
      intersection), so a key no input weighed is recomputed by a later merge.
    - `sameDescription` ignores `refused`.
12. **The router's contract.** `RequestShape` says the router never sees a widget. **Resolution:**
    - The hint is data on `SpanQuery`: the query text, the variable condition text and the bindings.
    - The data source routes only if `q.condition === andConditions(hint.query, hint.variables)` and `q.text === ''`.
    - The routing lives in `src/viewer/data/widget-index-route.ts`, beside `route.ts`.

---

## Amendments

1. **Nanoseconds past 2^53 (Task 3, CodeRabbit on #342).**
   - Rebasing keeps nanoseconds only while a chunk's offsets stay within `Number.MAX_SAFE_INTEGER`, about 104 days.
   - `WidgetTraceSet.add` marks the set `exact = false` when a chunk's latest start or end lies more than
     `Number.MAX_SAFE_INTEGER` ns after its smallest start.
   - A set that is not exact is never written; the partition scans. Task 3 adds the test, and Task 4 treats it like
     a refusal by the guard, with its own warning.
2. **The index-only count (Task 8, CodeRabbit on #342).**
   - Under `UNION` the arms are deduplicated together. With the scan arm omitted, though, the index relation alone
     can repeat a trace: one row per variable tuple and per partition.
   - So `spanCountQuery(f, 'traces', route)` keeps `count(DISTINCT trace_id)` over the relation. Task 8 tests that
     an index-only count over two rows of one trace gives 1.
3. **`traceTotal` under a long window.** CodeRabbit's third comment on #342 is answered without a change:
   - `traceTotal` runs only on the paged path, and `pagesTraces` excludes a long window.
   - The long-window total goes through `traceList`, which is aggregated by trace start.
   - A routed `spanCountQuery` therefore only ever sees no window.
   - Task 9 asserts that the long-window total equals the scan's.

4. **PR 2 decisions after the live measurement (maintainer, 2026-11-17).**
   - The live rebuild has the CI dashboard at 185 requests and 2.92 s. It misses ≤ 170 requests and 0 `spans.parquet` reads. The 5 reads that remain are not the Runs widget's: 3 bind the base `spans` view at open, and 2 are share cells for traces written before #319. PR 2 ships with the misses recorded.
   - The `#/dashboards/ci` requests pin on `mixed` is re-pinned at 22 (measured 20 + 10 %). The shape spans about 3.8 h, a short window, so its other widgets scan anyway, and the index adds one small file per partition there.
   - **Task 13 (added): the empty state reads no spans.**
     - On the live rebuild with `job` bound to a job that has no runs in the window, `EmptyFacet`'s `spanKeys` scans every spans file for attribute keys, twice: 313 requests and 20 s.
     - The empty state must take its keys from data the report already holds, without scanning `spans.parquet`, and must show the same keys.
   - **Task 14 (added): the index records its evaluator.**
     - `WidgetIndexDescription.evaluator` is the version of the OTTL evaluation that wrote the rows (`WIDGET_INDEX_EVALUATOR`, starting at 1).
     - `merge` copies a source index only when its version equals the writer's, and otherwise computes the index.
     - The viewer routes a partition only when its version equals the viewer's, and otherwise scans it.
     - An index without the field (written between #343 and this change) counts as a mismatch.
     - The frozen format-7 report is frozen again.

5. **Task 15 (added, maintainer 2026-11-17): the writer records each table's attribute keys.**
   - Task 13 found that no data the report holds gives the empty state's key set without a scan. The keys come from `attributeFacetsQuery`: scalar-valued attribute keys, core keys excluded, the `facetKeyCap` keys with the most values, ranked by count and then by key.
   - **What the writer records.** Each `spans` and `logs` partition file records `attributeKeys: Record<string, number>`: every attribute key, with how many of that file's rows hold a scalar value for it. A value counts by the same rules `attributeFacetsQuery` applies: its JSON kind is a scalar, and its text is not null.
   - **Where it is written.** Flush, compaction and the merge-computed path all write it. A merge-copy keeps the source's record, and computes it from the streamed spans or logs when the source has none.
   - **What the viewer does.** It sums the counts across the files, removes the core keys, ranks by total descending then key, and keeps `facetKeyCap`. If any file lacks the record, it scans as today.
   - **Size guard (my call).** A file with more than 1,000 distinct keys records nothing, and that report scans. Report the manifest growth on the live rebuild.
   - **Tests.** An equivalence test compares the recorded path with `attributeFacetsQuery` on fixtures that mix kinds (string, int, double, bool, null, object and array values) for spans and logs, and over the key cap. It asserts no `spans.parquet` or `logs.parquet` is read. The frozen format-7 report is frozen again.

## PR 1: format 7 and the writer

### Task 1: format 7, read and written (no new content yet)

**Files:**
- Modify:
  - `src/format/version.ts`: `PARTITION_FORMAT_VERSION = 7`, `READABLE_PARTITION_FORMATS = [5, 6, 7]`,
    `READABLE_FORMAT_VERSIONS` gains 7, and `oldFormatMessage` says "formats 5 to 7".
  - `src/format/parquet/columns.ts`:
    - `TABLES` gains `'widget_traces'`, last.
    - `TABLE_COLUMNS.widget_traces = [required('condition','utf8'), required('trace_id','utf8')]`, and `'condition'`
      joins `DICTIONARY_COLUMNS`.
    - `SORT_COLUMNS.widget_traces = ['condition', 'trace_id']`.
    - `TIME_COLUMN` becomes `Record<Table, string | null>`, with `null` for `widget_traces`.
    - `FIXED_STATISTICS_COLUMNS.widget_traces = []`.
  - `src/format/parquet/stats.ts`: `effectiveTime` treats a `null` time column as no time.
  - `src/format/manifest.ts`:
    - `WidgetIndexDescription`, and `PartitionFile.widgetIndex?`.
    - `RollupDescription.refused?: string[]`.
    - `StatisticsKeys` excludes `widget_traces` too.
    - `ManifestV7Schema`: format 6's, plus `widget_traces` (`WidgetTracesPartitionFileSchema`, `widgetIndex`
      required) and `refused` (`z.exactOptional(z.array(z.string()))`) on the rollup description. Formats 5 and 6
      keep their schemas.
    - `parseAnyManifest` dispatches 7.
    - `manifestForWrite` drops the anchor for 6 and 7.
  - `src/query/sql/views.ts`: `viewStatements` leaves `widget_traces` out of every set.
  - The gates in Plan note 9: `src/viewer/shell/shell.tsx:126`, `src/viewer/data/refresh-report.ts:103`,
    `src/writer/checkpoint.ts:148,169`, `src/cli/ci/run-report.ts:45,135`.
  - `src/writer/upgrade.ts:199`: a 5 or 6 manifest is rewritten as 7.
- Test: `test/format/manifest-v4.test.ts`, `test/format/compat.test.ts`, `test/query/sql/views.test.ts`,
  `test/writer/upgrade.test.ts`, `test/host/manifest.test.ts`, `test/cli/ci/run-report.test.ts`

**Interfaces:**
- Produces: `interface WidgetIndexDescription { conditions: string[]; variables: string[] }` (`src/format/manifest.ts`).
- Produces: `PartitionFile.widgetIndex?: WidgetIndexDescription`, `RollupDescription.refused?: string[]`.
- Produces: `ManifestV4['formatVersion']` is `5 | 6 | 7`.

- [ ] **Step 1: failing tests.**
  - A format-7 manifest with a `widget_traces` file carrying `widgetIndex`, and a `span_rollups` file with
    `refused: ['attr:k']`, parses.
  - The same `widget_traces` entry in a format-6 manifest is `invalid-report`.
  - A format-7 `widget_traces` entry without `widgetIndex` is `invalid-report`.
  - `viewStatements(m)` over a manifest that lists `widget_traces` creates no `widget_traces` view.
  - `upgradeReport` of a format-6 report writes `formatVersion: 7` and changes no partition byte.
  - A new report from `openSession` writes `formatVersion: 7`. `newRunManifest` writes 7.
  - The viewer anchor test (`test/viewer-data/manifest-range.test.ts`) treats 7 as 6.
- [ ] **Step 2:** `pnpm exec vitest run test/format test/query/sql/views.test.ts test/writer/upgrade.test.ts` → FAIL.
- [ ] **Step 3: implement** the files above. Update the tests that assert `formatVersion: 6` for a fresh report.
- [ ] **Step 4:** `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(format): read and write format 7`.

### Task 2: the indexed conditions, their ids, and the codec's column list

**Files:**
- Create: `src/model/sha256.ts`, `src/config/widget-traces.ts`
- Modify:
  - `src/ottl/converters.ts`: `ConverterSpec.rowLocal?: false` (none set today).
  - `src/format/parquet/columns.ts`: `widgetTracesColumns`.
  - `src/format/parquet/codec.ts`, `src/format/parquet/batch.ts`, `src/format/parquet/schema.ts`: an optional
    `columns` parameter wherever `TABLE_COLUMNS[table]` is read (`checkRow`, `batchFromRows`, `columnsToArrow`,
    `arrowSchema`). It is also `EncodeOptions.columns` for `encodeColumns`.
- Test: `test/model/sha256.test.ts`, `test/config/widget-traces.test.ts`, `test/format/parquet/codec.test.ts`

**Interfaces:**
- Produces: `sha256Hex(text: string): string` (UTF-8, lowercase hex).
- Produces: `normalizeCondition(source: string): string`. It trims, and collapses each run of whitespace outside
  string literals to one space. Literals keep their escapes.
- Produces: `conditionId(source: string): string`, which is `sha256Hex(normalizeCondition(source)).slice(0, 16)`.
- Produces: `interface WidgetTraceIndexSpec { conditions: { id: string; source: string }[]; variables: string[]; notRowLocal: string[] }`.
- Produces: `widgetTraceConditions(dashboards: readonly ResolvedDashboard[]): WidgetTraceIndexSpec`.
  - Every `type: 'traces'` widget with a non-null `query` that parses and compiles in the `span` context counts.
  - `source` is normalized, and `conditions` are distinct by id and sorted by id.
  - `variables` are the variable keys of the dashboards holding such a widget, sorted and distinct.
  - `notRowLocal` lists the sources that call a converter with `rowLocal: false`. They are left out of `conditions`.
- Produces: `widgetTracesColumns(variables: readonly string[]): ColumnDef[]`. It is the two fixed columns, then
  `var:<key>` (utf8, nullable, dictionary) per key in the order given.
- Produces: `VAR_COLUMN_PREFIX = 'var:'`.

- [ ] **Step 1: failing tests.**
  - `sha256Hex('')`, `sha256Hex('abc')` and a 1,000-character non-ASCII text equal `node:crypto`'s digest.
  - `normalizeCondition('  a  ==\n "x  y" ')` is `'a == "x  y"'`.
  - The CI config's Runs query, written on one line and over three lines, has one id of 16 hex digits.
  - Over `.github/otel-html-ci.yaml`: one condition (the Runs query) and the variables `cicd.pipeline.name`,
    `cicd.pipeline.run.id` and `cicd.pipeline.task.name`.
  - Over `fixtures/dashboards.otel-html.yaml`: the traces widget without a query adds nothing.
  - A query that does not parse adds nothing.
  - With a test converter marked `rowLocal: false`, its condition is in `notRowLocal` and not in `conditions`.
  - `encodeColumns('widget_traces', batch, { rowGroupRows, columns: widgetTracesColumns(['k']) })` round-trips
    through DuckDB with the columns `condition, trace_id, "var:k"`, sorted by `condition, trace_id`.
  - Without `columns`, every other table encodes byte-identical to `main` (an existing codec test, unchanged).
- [ ] **Step 2:** `pnpm exec vitest run test/model/sha256.test.ts test/config/widget-traces.test.ts test/format/parquet/codec.test.ts` → FAIL.
- [ ] **Step 3: implement.** SHA-256 per FIPS 180-4 over `TextEncoder` bytes, with no tables beyond the round
  constants.
- [ ] **Step 4:** → PASS. `mise run check` → PASS.
- [ ] **Step 5:** commit `feat(config): the traces-widget conditions a report indexes, and their ids`.

### Task 3: index rows from a span batch, and the guard

**Files:**
- Create: `src/writer/widget-trace-rows.ts`
- Test: `test/writer/widget-trace-rows.test.ts`

**Interfaces:**
- Consumes: `WidgetTraceIndexSpec`, `widgetTracesColumns` (Task 2); `spanFromRow` (`src/format/parquet/decode.ts`).
- Produces: `interface CompiledWidgetIndex { conditions: readonly { id: string; source: string; test: (t: SpanTarget) => boolean }[]; variables: readonly string[]; columns: readonly ColumnDef[]; description: WidgetIndexDescription }`.
- Produces: `compileWidgetIndex(spec: WidgetTraceIndexSpec): CompiledWidgetIndex | null` (null when no condition).
- Produces: `class WidgetTraceSet { constructor(index: CompiledWidgetIndex); add(batch: ColumnBatch): void; rows(): Row[]; readonly size: number }`.
  - `add` evaluates every condition on every span row and keeps distinct rows. It may be called per chunk.
  - Times are rebased onto the chunk's smallest `start_time_unix_nano` before `spanFromRow` (Plan note 4).
  - `var:<key>` is the row's `resource_attributes[key]` when it is a string AnyValue, else null.
- Produces: `encodeWidgetTraces(rows: readonly Row[], index: CompiledWidgetIndex, rowGroupRows: number): Uint8Array`.
- Produces: `WIDGET_INDEX_SHARE = 0.05`, and `widgetIndexAllowed(indexBytes: number, emptyBytes: number, spansBytes: number): boolean`,
  true when `indexBytes - emptyBytes <= 0.05 × spansBytes`.

- [ ] **Step 1: failing tests**, on spans built with `test-support/otlp-builders.ts`. The condition is the CI Runs
  query, and the variables are the three CI keys.
  - A root span of scope `otel-html-ci` gives one row with the run resource's values.
  - A job span (task run id set, result `success`) gives a row. With result `skip` it gives none. A span of another
    scope gives none.
  - Two matching spans of one trace with the same resource give one row. With different
    `cicd.pipeline.task.name` they give two.
  - An int-valued resource attribute gives null in its column.
  - A condition on `start_time_unix_nano == <exact absolute ns>` matches only that span: the rebasing keeps
    nanoseconds.
  - `add` over two chunks equals `add` over their concatenation.
  - `widgetIndexAllowed(1_000 + 600, 1_000, 10_000)` is false, and `(1_000 + 500, 1_000, 10_000)` is true.
- [ ] **Step 2:** `pnpm exec vitest run test/writer/widget-trace-rows.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(writer): widget trace rows from a span batch`.

### Task 4: flush and compaction write `widget_traces`

**Files:**
- Modify:
  - `src/writer/partition-session.ts`:
    - The constructor compiles the index from `config.dashboards`, warning once per `notRowLocal` source.
    - The `derive` hook adds `widgetIndex` from `taken.spans`.
    - The compact options pass `widgetIndex` and `warn`.
  - `src/writer/partition-writer.ts`:
    - `Derived.widgetIndex?: { rows: Row[]; index: CompiledWidgetIndex; allowed(indexBytes: number, emptyBytes: number, spansBytes: number): boolean }`.
    - It is written after `spans` when the cut has spans, even with 0 rows, and its entry carries
      `widgetIndex: index.description`.
    - When `allowed` is false the table is left out. The session's `allowed` warns once per session and condition
      set: `the widget trace index of this partition is not written: it would weigh over 5 % of the spans file`,
      with `{ conditions: [sources], indexBytes, spansBytes }`.
  - `src/writer/compaction.ts`:
    - `CompactOptions.widgetIndex?: CompiledWidgetIndex`.
    - `onRows('spans')` also feeds a `WidgetTraceSet`.
    - The table is written after the TABLES loop when the output has spans, with the same guard against
      `files.spans.bytes`, through `opts.warn`.
    - The `TABLES` loop skips `widget_traces` (it is never merged from the inputs).
- Test: `test/writer/widget-index-flush.test.ts`

**Interfaces:**
- Consumes: Task 3's `compileWidgetIndex`, `WidgetTraceSet`, `encodeWidgetTraces`, `widgetIndexAllowed`.
- Produces: every new partition with spans lists `files.widget_traces` with `widgetIndex`, unless the guard refused.

- [ ] **Step 1: failing tests.** Use a config with the CI dashboard (`parse(readFileSync('.github/otel-html-ci.yaml'))`).
  - A flush of a CI run (a root span, two job spans, one skipped step) writes a `widget_traces` file.
    - Decoded, it holds the root's and the non-skipped job's rows, sorted.
    - Its entry has `widgetIndex` = `{ conditions: [<id>], variables: [the three keys] }`.
  - A flush of spans with no match writes a 0-row `widget_traces` with `widgetIndex` (Review Focus 1). A flush of
    logs only writes none.
  - Closing a session of three such flushes compacts them into one `widget_traces`. Its decoded rows equal the union
    of the three flushes' rows.
  - A partition where every span is its own matching trace, each with a distinct 200-character run id, refuses the
    table. The test sizes the spans so the index's own bytes exceed 5 %. It warns once, naming the Runs query
    source, and lists no `widget_traces`.
  - A config with no traces widget writes no `widget_traces`.
- [ ] **Step 2:** `pnpm exec vitest run test/writer/widget-index-flush.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** → PASS. `mise run check` → PASS.
- [ ] **Step 5: measure the writer cost.**
  - Time a flush of the scaling `mixed` shape's largest partition, with and without the CI dashboard config, and
    record both in the PR body.
  - **Stop and ask** if the index adds more than 25 % to the flush time.
- [ ] **Step 6:** commit `feat(writer): flushes and compactions write the widget trace index`.

### Task 5: merge-copy keeps or computes the index

**Files:**
- Modify: `src/writer/partition-session.ts`.
  - `#copyPartition` decodes a copied `spans` file at most once. A memo per copy is shared by `#recomputedRollup`
    and the index.
  - A source `widget_traces` whose `widgetIndex` covers this report's ids and variables (the report's ⊆ the
    file's) is copied byte for byte, with its entry.
  - Otherwise, when this report indexes anything and the partition has spans, the table is computed from the
    decoded spans, with the guard.
  - When this report indexes nothing, a source `widget_traces` is not copied.
- Test: `test/writer/merge-widget-index.test.ts`

**Interfaces:**
- Consumes: Task 4's guard and warning; `CompiledWidgetIndex` held by the session.

- [ ] **Step 1: failing tests**, merging with the CI dashboard config (`mergeReports(w.deps, [input], { out, config })`).
  - A format-6 input (`fixtures/reports/format-6`) and a format-7 input written without dashboards both come out
    with a `widget_traces` per partition with spans. Its rows equal those a flush with the config writes.
  - An input written with the same config has its `widget_traces` copied byte for byte.
  - An input whose index lacks the `job` variable column (written with a config without that variable) is
    recomputed with it (Review Focus 2).
  - The input's `spans.parquet` is read from disk once per partition: count `fs.readBytes` calls. Decoding it is
    shared with a rollup repair in the same copy; count `readColumns` calls on it, through a spy.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(writer): merge copies or computes the widget trace index`.

### Task 6: refused keys are recorded; merge repairs rollups that lack one (Goal 4)

**Files:**
- Modify:
  - `src/writer/partition-session.ts`:
    - `#rollupOf` collects the widget keys it refused (both `why` cases) and returns them as
      `description.refused`, sorted, left out when empty.
    - `#recomputedRollup`: a missing widget key is skipped only when it is in `f.rollup.refused`. The rule that read
      the recorded statistics is removed.
  - `src/writer/compaction.ts`:
    - In the union branch, a refused `wide` sets `description.refused` to the disputed keys.
    - A `sum` plan's description carries the intersection of the inputs' `refused` (Plan note 11).
    - `sameDescription` is unchanged.
- Test: `test/writer/merge-rollups.test.ts`, `test/writer/compaction-widget-keys.test.ts`

- [ ] **Step 1: failing tests.**
  - The existing "a key dropped for size is not weighed again" test still passes, and the copied description has
    `refused: [WK]`.
  - **The #337 case.** The input rollup lacks `WK`, its statistics record `WK`, and it has no `refused`. Build it by
    deleting `refused` from the manifest of the "dropped" input. The merge recomputes it, and with small values the
    result groups by `WK`, equal to a fresh write.
  - A compaction whose union refuses `WK` writes `refused: [WK]`. The same compaction with a cheap union writes no
    `refused`.
  - Summing two inputs that both refused `WK` keeps `refused: [WK]`. Summing one that refused it with one without
    `refused` writes none.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS. `mise run check` → PASS.
- [ ] **Step 5:** commit `fix(writer): merge recomputes a copied rollup that lacks a widget key no writer refused`.

### Task 7: frozen format-7 report, docs, PR 1

**Files:**
- Create: `fixtures/reports/format-7/data/**`
- Modify:
  - `fixtures/reports/README.md` (its row: written by the PR 1 head, with inputs `fixtures/small.otlp.json`,
    `fixtures/metrics.otlp.json` and `fixtures/ci.otlp.json`, and config `fixtures/dashboards.otel-html.yaml`).
  - `fixtures/reports/SHA256SUMS`.
  - `test/format/frozen-checksums.test.ts` (`FROZEN`), `test/viewer-data/frozen-reports.test.ts` (both lists
    with `['format-6', 6]`), `test/format/compat.test.ts`, and `ReportName` (`e2e/fixture.ts`).
  - `e2e/global-setup.ts`, `e2e/frozen.spec.ts`, `test/cli/host.test.ts`.
  - `README.md`: the format table (7: `widget_traces`, `widgetIndex`, `refused`), and a paragraph under the
    dashboards' traces widget on the index and the 5 % guard.

- [ ] **Step 1: freeze.** Run the README's recipe from the branch head (`convert … --config fixtures/dashboards.otel-html.yaml`).
  Check that the report holds a `widget_traces` with at least one row.
- [ ] **Step 2:** `mise run check` → PASS (compat merges format 7; host serves it).
  `mise run test:e2e:chromium -- e2e/frozen.spec.ts` → PASS.
- [ ] **Step 3: check the deploy path.**
  - Read the site deploy (`otel-html-deploy` action, `site.yml`) without changing it. The live report is format 6,
    and the next publish merges it with format-7 runs using the build from `main`. Confirm that build reads both.
  - **Stop** if any step pins a released `otel-html` that cannot read format 7.
- [ ] **Step 4:** commit `test: a frozen format-7 report`. Run `mise run verify` → PASS.
- [ ] **Step 5: open PR 1.** Title as in the table. The body carries:
  - the format change and why it is breaking (a 0.7.0 `merge` or `host` refuses format 7);
  - Task 4's flush timing;
  - the guard's basis (Plan note 8), flagged for the maintainer;
  - **Also** items, if any.

  Then branch review on Opus 5.5 → fix → CI green → merge.

## PR 2: the viewer routes traces widgets

### Task 8: the membership relation in SQL

**Files:**
- Create: `src/query/sql/widget-index.ts`
- Modify: `src/query/sql/spans.ts` (`traceRowsQuery`, `windowTraceRowsQuery`, `spanCountQuery`)
- Test: `test/query/sql/widget-index.test.ts`

**Interfaces:**
- Produces: `interface WidgetIndexRoute { files: readonly string[]; condition: string; bindings: readonly { key: string; value: string }[] }`.
- Produces: `widgetIndexRelation(route: WidgetIndexRoute): ExprNode`. It is
  `SELECT trace_id FROM read_parquet([<files>], union_by_name = true) WHERE condition = '<id>' AND "var:<key>" = '<value>' …`,
  with strings quoted as `ownFiles` quotes them. The name has no builder suffix, so the catalogue's builder lists
  stay as they are.
- Produces: `traceRowsQuery(f, sort, limit, page?, route?: WidgetIndexRoute | null)`,
  `windowTraceRowsQuery(f, traces, sort, limit, route?)` and `spanCountQuery(f, mode, route?)`.
  - With a route, the matching relation is the scan over `f.files` `UNION` the index relation. The scan arm is
    omitted when `f.files.files` is empty.
  - `spanCountQuery` takes a route only for `mode: 'traces'`, counting `count(*)` over the union.
  - Without a route, the SQL is byte-identical to `main`.

- [ ] **Step 1: failing tests.**
  - The SQL text with and without a route, and with an empty scan.
  - Run in DuckDB (node) over two index files whose `var:` columns differ: the relation returns the bound traces,
    and the unbound columns do not matter.
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `perf(query): a trace list's members may come from the widget trace index`.

### Task 9: the data source routes per partition (Goal 2)

**Files:**
- Create: `src/viewer/data/widget-index-route.ts`
- Modify:
  - `src/viewer/data/results.ts`: `SpanQuery.widgetIndex?: WidgetIndexHint`.
  - `src/viewer/data/duckdb-source.ts`:
    - In `querySpans`, the hint is eligible under Plan notes 1, 6, 7 and 12.
    - `traceList` (both branches), `tracePage` and `traceTotal` take the route over the files they would scan. In
      the long branch these are `namedSpans`' files.
    - Their `read` prepares `route.scan.files`, the route's index files and the `traces` files.
  - `src/viewer/data/query-common.ts`: `filesFor` gains an `extra` list.
- Test: `test/viewer-data/widget-trace-index.test.ts`, `test/viewer-data/widget-index-route.test.ts`

**Interfaces:**
- Consumes: Task 8's `WidgetIndexRoute`, builders; `conditionId` (Task 2).
- Produces: `interface WidgetIndexHint { query: string; variables: string | null; bindings: readonly { key: string; value: string }[] }`.
- Produces: `routeWidgetIndex(manifest: ManifestV4, scan: Pruned, hint: WidgetIndexHint): { scan: Pruned; route: WidgetIndexRoute | null }`.
  - A spans file moves from `scan` to `route.files` when its partition's `widget_traces` entry lists
    `conditionId(hint.query)` and every bound key. `route.files` then holds that partition's `widget_traces` path.
  - `scan.all` becomes false once anything moved, and `total` is kept.
  - `route` is null when nothing moved.

- [ ] **Step 1: failing tests.**
  - Unit (`widget-index-route.test.ts`): partitions with an index, without one, with one lacking the bound key, and
    with one for another condition id route as described.
  - Equivalence (`widget-trace-index.test.ts`).
    - Setup: build with `buildFormat4Report` and the CI dashboard config, from three requests:
      - a CI run whose job spans are flushed in two partitions;
      - a partition of unrelated spans;
      - a run whose job uses an int-valued `cicd.pipeline.task.name`.
    - Make a second fixture with `widget_traces` stripped from one partition (a `withoutWidgetIndex(f, n)` helper
      beside `withoutRollups` in `test-support/rollup-fixture.ts`), and a third with all of them stripped.
    - Assert that the indexed, partly indexed and stripped reports give `plain`-equal results (rows, order, `total`,
      `next`) for every combination of:
      - window: none, `longWindow()`, a long window starting inside the first run's trace, and `shortWindow()`;
      - bindings: none, `job` bound, and `job` and `workflow` bound;
      - sort: `start` `desc` and `asc`;
      - limit: 1 (paging, with the `next` cursor followed to the end) and 200.
    - That covers Review Focus 2 and 4.
    - The indexed report's statements under no window and the long window read no `spans.parquet`. Assert it with
      a spy on `engine.prepare`.
    - The short window reads `spans.parquet` (Review Focus 5).
    - An `int`-kind hint is not sent by the widget (Task 10), so here assert that a condition with an int binding
      and no hint gives the stripped report's answer (Review Focus 3).
    - A hint whose `query` does not equal the condition's first part is ignored (the scan's answer, spans read).
  - `test/viewer-data/host-server.test.ts`: the routed statement runs on `host` (allowed paths include
    `widget_traces`).
- [ ] **Step 2:** `pnpm exec vitest run test/viewer-data/widget-trace-index.test.ts test/viewer-data/widget-index-route.test.ts` → FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** → PASS. `mise run check` → PASS. A catalogue class that changes is a stop.
- [ ] **Step 5:** commit `perf(viewer): a traces widget's list reads the widget trace index where it covers the partition`.

### Task 10: the traces widget sends the hint

**Files:**
- Modify:
  - `src/viewer/dashboards/scope.ts`: `WidgetScope.vars: readonly VariableBinding[]`, set by `scopeFor`.
  - `src/viewer/dashboards/widgets/traces.tsx`: `query.widgetIndex` when all of these hold:
    - `widget.query !== null`;
    - `widget.text === ''`;
    - `scope.traceFilter === null`;
    - every binding's kind is `'string'`.

    The hint is `{ query: widget.query, variables: variableCondition(scope.vars, 'span'), bindings: scope.vars.map(({ key, value }) => ({ key, value })) }`.
- Test: `test/viewer/dashboard-traces.test.tsx`

- [ ] **Step 1: failing tests.**
  - The Runs widget's `SpanQuery` carries the hint with no variables and with `job` bound.
  - It carries none with a widget `text`, or with an `int`-kind binding.
  - A following widget with a selection still sends the hint. The data source decides the window (Review Focus 5).
- [ ] **Step 2:** → FAIL. **Step 3:** implement. **Step 4:** → PASS.
- [ ] **Step 5:** commit `feat(viewer): the traces widget names its indexed condition`.

### Task 11: catalogue entry and page ratchet

**Files:**
- Modify:
  - `src/viewer/data/catalogue.ts`:
    - `ScalingIds.widgetQuery: string`.
    - An entry `traces.list.widget` with variants `[LONG]`, family `trace list`, builders `WINDOW_TRACES`, and
      `over: { mode: 'traces', condition: ids.widgetQuery, widgetIndex: { query: ids.widgetQuery, variables: null, bindings: [] } }`.
    - Its `DECLARED` line.
  - `test-support/scaling/generator.ts`: `widgetQuery` is the first traces widget query of the config it writes with.
  - `test/scaling/catalogue.test.ts` and `test/scaling/classes.test.ts`: the id lists.
  - `test/viewer/scaling-pages-support.tsx`: `pageOn` also returns `spansReads`, the `read` events whose path ends
    `/spans.parquet`.
  - `test/viewer/scaling-pages.test.tsx`: `PAGE_SERIAL_MAX`, `PAGE_REQUESTS_MAX` and `PAGE_BATCH_MAX` for
    `#/dashboards/ci` are re-pinned at measured + 10 % (batches exact), and `spansReads` is asserted 0.
- Test: the same files.

- [ ] **Step 1:** write the entry and the assertions. Run `mise run test:scaling` and
  `pnpm exec vitest run test/viewer/scaling-pages.test.tsx` and read the measured class and page numbers.
  - The entry's class must be `files` or better on retention and window, and not `scan` on any axis.
  - `#/dashboards/ci` must be at or below today's pins (95 serial, 18 requests, 3 batches).
  - If a widget other than Runs reads `spans.parquet` on `mixed`, record which one and assert the Runs statement's
    reads instead (filter `take()` by the statement). Say so in the PR body.
  - **Stop and ask** if a pin gets worse.
- [ ] **Step 2:** pin, then run → PASS. `mise run check` → PASS.
- [ ] **Step 3:** commit `test(scaling): the routed traces widget entry and the dashboard ratchet`.

### Task 12: measure on the live-data rebuild, then PR 2

**Files:**
- Create: `scripts/measure-live.ts`, and a `measure:live` task in `mise.toml`. Its description states the cost (a
  download of the live report, a merge, and about 3 minutes of browser runs). Run `mise run gen`.
- Modify: `e2e/static-server.ts`: `serve(mounts, opts?: { delayMs?: number })` delays every response by `delayMs`.

`scripts/measure-live.ts [--build <dist dir>] [--job <name>] [--no-rebuild] --out <dir>` does the following, in order.

1. **Download.** Fetch `https://bjstabi.github.io/otel-html/branch/main/data/manifest.js` and unwrap
   `__OH__.push("manifest", {...})` with `unwrapDataFile` and `MANIFEST_KEY`. Then fetch every file each partition
   lists into `<out>/live/` at its manifest path, plus `data/manifest.js`. Skip files already there with the listed
   size.
2. **Rebuild** (skipped with `--no-rebuild`, which serves `<out>/live` as downloaded). Run `node <build>/cli/main.js merge <out>/live -o <out>/rebuilt --format site --config .github/otel-html-ci.yaml`.
   With format 7 the copy computes the indexes and repairs the rollups.
3. **Report size.** Print the sum of `widget_traces` bytes against the sum of `spans` bytes from the rebuilt
   manifest.
4. **Serve.** Serve `<out>/rebuilt` with `serve([...], { delayMs: 14 })`.
5. **Measure.** For each page, 3 cold runs, each in a new Chromium context with the cache off.
   - The pages:
     - `#/dashboards/ci`;
     - `#/dashboards/ci?d=<{"vars":{"cicd.pipeline.task.name":"<job>"}}>`;
     - `#/traces?mode=traces`;
     - `#/logs`;
     - `#/traces/trace/<the first trace of the traces list>`.
   - Record, from Playwright's `request` events:
     - the request count;
     - the `spans.parquet` requests;
     - settled: the time from navigation to the last response before 2 s with none.
   - Print the median and range per page.

- [ ] **Step 1: write the script and the delay option.** Unit-test the delay in `test/e2e-support/static-server.test.ts`:
  a request takes at least `delayMs`.
- [ ] **Step 2: baseline.**
  - Build `main` before this branch (`git worktree add <tmp> <PR 1's merge base>`, then `mise run build`).
  - Run the script with `--build <tmp>/dist`. It writes format 6 with no index, as live is today.
  - Pick `--job` as the first value of the dashboard's `job` list on the rebuilt report, and record it.
- [ ] **Step 3: measure the branch** with `mise run build` and the same `--job`.
- [ ] **Step 4: compare with spec §6.**
  - Write both tables to `.superpowers/sdd/2026-11-16-widget-trace-index/live.md` (git-ignored).
  - **Stop and ask** if any of these misses:
    - CI dashboard ≤ 170 requests and ≤ 3.0 s;
    - 0 `spans.parquet` reads, with and without `job`;
    - traces list, logs and trace open no worse than the baseline: median requests no higher, median settled
      within 10 %;
    - `widget_traces` ≤ 1 % of spans bytes.
- [ ] **Step 5:** commit `test: measure:live measures the live-data rebuild`. Run `mise run verify` → PASS.
- [ ] **Step 6: open PR 2.** The body carries:
  - the live tables (baseline and branch);
  - the job name used;
  - the page ratchet before and after;
  - the catalogue entry's class.

  Branch review on Opus 5.5 → CI green → merge.
- [ ] **Step 7:** once released and deployed, re-run the script with `--no-rebuild` on a fresh `--out`. Post the numbers as a comment on PR 2. Open an issue for any target
  missed.
