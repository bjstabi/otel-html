# Widget trace index: cheap traces widgets on dashboards

Status: design, 2026-11-16. The maintainer chose the format 7 bump and the unattended PR process. Follows the query-layout project
(`docs/superpowers/specs/2026-11-15-query-layout-design.md`, #336–#339).

## 1. Why

The CI dashboard is still slow after 0.7.0: on live data it makes 369–405 requests and takes 6–9 s, against the
targets of ≤ 100 requests and ≤ 3 s. On 2026-11-16 I rebuilt the live report locally, served it with 14 ms per
request (Pages' measured round trip), and measured the dashboard with one widget removed at a time:

| CI dashboard | requests | longest serial chain | settled |
| --- | --- | --- | --- |
| live data as it is | 405 | 297 | 6.9 s |
| every partition's rollup carries the *Steps* key | 381 | 273 | 6.5 s |
| the same, without the **Runs** widget | 157 | 56 | 2.9 s |
| the **Runs** widget alone | 358 | 257 | 5.7 s |

- **Runs.** A traces widget in `traces` mode with a span-attribute condition:
  ```
  instrumentation_scope.name == "otel-html-ci"
    and (IsRootSpan() or (attributes["cicd.pipeline.task.run.id"] != nil
    and attributes["cicd.pipeline.task.run.result"] != "skip"))
  ```
- **What it costs.** To list traces with a matching span, the viewer scans `spans.parquet` in every large partition:
  about 12 range requests and 720 KB per partition, 227 requests in all.
- **Why rollups do not help.** A rollup counts spans; it cannot say which traces hold one.
- **What else is left.** Without Runs, the dashboard reads no raw spans at all.

There is also a second, smaller problem. `merge` cannot give a copied partition a widget key its rollup lacks (the
three live partitions written between #337 and #339). The copy treats the key's recorded statistics as proof that a
writer weighed the key and dropped it (`#recomputedRollup`, `src/writer/partition-session.ts`). But #337's compaction
bug dropped keys without weighing them, so that proof does not hold.

## 2. Goals

1. **Traces widgets.** A traces widget defined in a dashboard config reads no `spans.parquet` on a partition written
   after this change, when it is shown with no variable set or with variables only. The CI dashboard on the live-data
   rebuild settles in ≤ 3.0 s, at ≤ 170 requests.
2. **Same answer.** The widget shows the same traces, in the same order, with the same counts as the scan does today,
   for every window, every variable binding and both directions of the default sort.
3. **No coupling.** Nothing names the CI dashboard. Any dashboard's traces widgets get this, through the same path that
   rollup widget keys take (`widgetConditionKeys`, `src/config/widget-keys.ts`).
4. **Merge repair.** `merge` recomputes a copied rollup that lacks a widget key unless the writer that made it recorded
   that it weighed the key and refused it.

## 3. Non-goals and anti-goals

- **Out of scope:**
  - The Traces explorer's own conditions, which the user types. They keep today's scan.
  - Toplist and table widgets, which rollups cover.
  - Logs widgets.
  - A server backend.
- **Anti-goal:** a wrong list. If the index cannot answer exactly, the widget falls back to today's scan for that
  partition. It never shows an approximate answer.
- **Anti-goal:** a report that grows noticeably. The index must be small, about one row per matching trace per
  partition, and is not written when it would exceed a share of the spans file (§5.3).

## 4. Current state (facts the design rests on)

- **The traces widget.** `src/viewer/dashboards/dashboard-page.tsx` and `scope.ts` give the widget the condition
  `scope.condition`. That is the widget's `query`, joined with a term per bound dashboard variable. The variables are
  resource keys: on the CI dashboard `cicd.pipeline.name`, `cicd.pipeline.run.id` and `cicd.pipeline.task.name`.
- **The statement it runs.** `traceRowsQuery` (`src/query/sql/spans.ts`) builds `traces` aggregated per `trace_id`,
  over every `traces` file, `WHERE trace_id IN (<matching spans>)`. The `traces` files are small and fetched whole.
  The matching-spans subquery is the expensive part.
- **Conditioned trace lists never cut files** (query-layout ruling, #338). Every partition is scanned.
- **The writer can evaluate a condition per span.** `src/ottl/compile.ts` (`compileCondition`) does it, and the writer
  already uses it for drops (`compileDrops`, `src/writer/open-common.ts`). The same OTTL source compiles to SQL in the
  viewer (`translateCondition`, `src/query/sql/ottl.ts`).
- **Routing per partition already exists.** Rollups route per partition (`src/query/sql/rollup.ts`,
  `src/viewer/data/route.ts`): a partition whose rollup lacks a dimension reads raw. The same shape fits here.
- **The dashboards are in the report.** The manifest carries `config.dashboards`, so the viewer knows every widget's
  condition text.

## 5. Design

### 5.1 A per-partition table `widget_traces`

This is a new Parquet table in a partition: one row per (widget condition, trace, variable tuple) that matched at
least one span of the partition.

| column | type | meaning |
| --- | --- | --- |
| `condition` | utf8 | The condition's id: a stable hash of its normalized source (§5.2). |
| `trace_id` | utf8 | A trace with at least one matching span in this partition. |
| `var:<key>` | utf8, one column per variable key | The matching span's resource value for that key, null when absent. |

- **Variable columns.** They are the union of the variable keys of every dashboard that has a traces widget. Rows are
  distinct over all columns, so a trace whose matching spans differ in a variable value has one row per value. This
  is what lets a bound variable be answered from the index.
- **Sort and encoding.** Rows are sorted by `condition`, then `trace_id`. The table is written like the other small
  tables and fetched whole by the small-file path.
- **The manifest entry.** The file's entry lists the condition ids and variable keys it holds:
  `widgetIndex: { conditions: string[]; variables: string[] }`, an optional field on `PartitionFile`. A partition
  without the entry, or one whose entry lacks a condition or variable, is answered by the scan, as today.

### 5.2 Which conditions are indexed

`widgetTraceConditions(dashboards)` lives beside `widgetConditionKeys`. For every `type: traces` widget it returns the
widget's `query` source, normalized: trimmed, with whitespace collapsed outside string literals. The id is the first
16 hex digits of the source's SHA-256.

The viewer computes the same id from the widget's `query`. A text filter (`widget.text`), or any term the viewer adds
beyond the variables, means the condition is not the indexed one. That partition then uses the scan.

### 5.3 The writer

- **When rows are made.** At every flush and every compaction, the partition session compiles each indexed condition
  once and evaluates it per span. The spans are already in memory as a column batch. Each match adds a
  `(condition, trace_id, var values)` row.
- **Compaction and merge-copy.** Compaction computes the table from the union of its inputs' spans, as it does for
  rollups. A merge-copy keeps a copied partition's `widget_traces` when it already holds this report's conditions and
  variables. Otherwise it computes the table from the copied spans, the way `#recomputedRollup` does for rollups.
- **Size guard.** When the encoded table would exceed 5 % of the encoded spans file, it is not written for that
  partition. A warning names the widget condition. Those partitions use the scan.
- **IsRootSpan() and other row-local functions.** These evaluate per span, as the drop path does. Conditions that
  need more than the span's own row are not indexed, and the writer warns once. One example is a converter that
  looks at other spans of the trace; none exists today, but the compiler is checked for that.

### 5.4 The viewer

- **Routing.** A traces-widget statement whose condition id is indexed, with no text and only variable terms, routes
  per partition:
  - A partition whose `widget_traces` holds the condition and every bound variable's column contributes
    `SELECT trace_id FROM widget_traces WHERE condition = ? AND "var:<key>" = ? …`.
  - Any other partition contributes today's matching-spans subquery over its own `spans` file.
  - The `IN (...)` relation is the union of the two.
- **Placement.** The routing lives in the data source beside the rollup router. It does not live in the widget.
- **Everything else is unchanged.** The `traces` aggregate, the window (`traceStartIn`), the sort, the page size and
  the cursor all stay as they are. Only the membership relation changes, so the answer is the same by construction
  (Goal 2).
- **One relation per statement.** The index tables of all routed partitions are read in one `read_parquet` list, so
  a statement adds at most one small-file batch. Under the small-file path it adds no serial range requests.

### 5.5 Merge repair (`#recomputedRollup`)

- **The record.** A writer that weighs a widget key and refuses it records that on the rollup description:
  `RollupDescription.refused?: string[]`, sorted keys.
- **The new skip rule.** `#recomputedRollup` skips a key only when it is in `refused`.
- **Effect on existing partitions.** A file without `refused` (every partition written before this change) is
  recomputed once on copy when it lacks a widget key. A copy then decodes its spans once, which is the cost of the
  repair.
- **Compaction.** It writes `refused` too, for keys its union weighing refused (#339's warning path).

## 6. Measures and targets

On the live-data rebuild (local, 14 ms per request, the recipe in the plan) with every partition rewritten by the new
writer:

| page | today (rebuild) | target |
| --- | --- | --- |
| CI dashboard, no variables | 381 requests, 6.5 s | ≤ 170 requests, ≤ 3.0 s, 0 `spans.parquet` reads |
| CI dashboard, `job` variable bound | to measure | 0 `spans.parquet` reads |
| traces list, logs, trace open | unchanged | no worse than today |

Report size: `widget_traces` adds ≤ 1 % of the spans bytes on the live data.

The scaling harness also gets a catalogue entry for the routed statement. A page ratchet pin for the dashboard on the
`mixed` shape holds or improves.

## 7. Decided, and left to the builder

- **Decided (my calls, not the maintainer's):**
  - A separate table rather than a column on `traces`. It keeps the `traces` schema and its stored service share
    untouched, and a partition without the table falls back cleanly.
  - Variable values in the index rather than falling back when a variable is bound.
  - A 5 % size guard.
  - The condition id is a hash of the normalized source.
  - `refused` on the rollup description for the merge repair.
  - **Format 7.** The manifest schema is strict (`z.strictObject`, `src/format/manifest.ts`), so a new table and
    two new fields are a format change. Each report ships its own viewer, so no old viewer opens a new report. But a
    0.7.0 `merge` or `host` would refuse one, and the repo has bumped the format for such changes (5 → 6).
    - Format 7 adds `widget_traces`, `PartitionFile.widgetIndex` and `RollupDescription.refused`.
    - The viewer, `host` and `merge` read formats 5, 6 and 7.
    - A format 5 or 6 input to `merge` is copied and gets its index computed.
    - `upgrade` of a format-6 report rewrites only the manifest's version, as 5 → 6 did. Its partitions have no
      index and are scanned until they age out.
    - The maintainer confirmed the bump on 2026-11-16. The name "format 7" was free once the layout proposal was
      dropped.
- **Left to the builder:**
  - The exact normalization rules, as long as the viewer and the writer share one function.
  - Where the router's code lives.
  - How the union relation is written in SQL.
  - Test shapes.
