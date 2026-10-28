# otel-html M3: Metrics design

Date: 2026-10-27 · Status: draft for approval

Builds on the main design, [`2026-10-25-otel-html-design.md`](2026-10-25-otel-html-design.md) (§7.3, §7.6, §8.3, §8.6, §9, §16), and mockup [`04-metrics.html`](2026-10-25-otel-html-mockups/04-metrics.html). Everything there still holds unless this document narrows it. M1 and M2 plans set the conventions (`docs/superpowers/plans/`).

## 1. Intent

M3 makes the third signal first-class: a **Metrics Explorer**, a **Catalog**, and the **embedded metric grid** in the log, span and trace panels. After M3 a report answers "what did the numbers do during this run, and which traces and logs explain a spike", without leaving the page.

Today the writer already keeps every data point verbatim (`MetricPointRecord`, columnar chunks under `data/chunks/metrics/`), but the only metric rollup is a point count per time bucket, and the viewer's Metrics page is a placeholder (`src/viewer/shell/pages.tsx`).

## 2. Goals, non-goals, anti-goals

**Goals**
- Explorer per §8.6: query rows (metric, where, show, by, ƒ, alias), `+ Formula`, displays Lines / Area / Bars / Heatmap / Distribution, linear or log y-axis, one chart per query or all on one, exemplars toggle, chart-click menu (exemplar → trace, traces in window, logs in window, zoom to time), Export.
- Catalog per §8.6 and mockup screen 2.
- Embedded grid as a **Metrics** tab in the log panel, the span section and the trace panel.
- All five point kinds and both temporalities, handled without the user thinking about them.
- Works the same above and below the eager budget (§7.6), and through `merge`.

**Non-goals (M3)**
- **"Copy as dashboard widget"** is left out; it arrives in M4 with the widget schema (decided).
- Dashboards, Fusion, config-defined views, the Views ▾ menu contents (M4).
- Receiver/live data (M5).

**Anti-goals**
- A second chart or list implementation for the embedded grid (§8.3 reuse rule): the grid is the Explorer's chart card with a pre-filled query.
- Silent wrong numbers: a series folded into "other", a counter reset, a summary downsampled across points, or a partial result must say so on the chart.
- Inventing vocabulary: queries use OTel names (metric name, point kind, temporality, OTTL paths) only.

## 3. Constraints

- Every rule from the main spec §11.1 and the M1/M2 Global Constraints (strict types, fail fast, DI, data tables, `file://`, browser-safe dirs, `mise run check` < 60 s).
- No new runtime dependencies expected; ECharts heatmap and custom series cover the displays.
- Report `formatVersion` may bump if the rollup layout requires it; append already requires the same otel-html version, and `merge` replays chunks, so old reports remain mergeable.

## 4. Approaches (decided: 1)

1. **Writer-side series rollups at several resolutions (chosen).** For each series the writer normalizes temporality once and keeps mergeable buckets at a ladder of resolutions; the viewer loads one metric's file on demand and never charts more than ~2k points per series. Matches §7.3 and §16, uniform above and below budget. Largest writer change in M3.
2. **One fine resolution, viewer downsamples.** Simpler writer, but a long run costs ~1 s per query change in the browser (spike: 3×1M points).
3. **No rollup, viewer scans metric chunks.** Cheapest, but above budget every query scans the whole run, contradicting §16.

Picked 1 because the spec already depends on it and only it keeps queries fast on large runs.

## 5. Writer: metric series rollup

### 5.1 Series identity
A **series** is (metric name, unit, point kind, temporality, monotonic, resource ref, scope ref, point attribute set, and for explicit histograms the bucket bounds). Points whose metric metadata conflicts with an existing series of the same name (e.g. different kind or unit) form a separate series and the Catalog flags the metric as "conflicting definitions"; no error, since OTLP permits it.

### 5.2 Temporality normalization
Series buckets store **deltas for sums and histograms**, values for gauges and non-monotonic sums:
- Cumulative monotonic sum / histogram: delta = current − previous for the same series; a drop or a changed `start` is a **reset** (the new cumulative value is the delta) and is counted on the series.
- Delta: taken as is.
- Non-monotonic sum (UpDownCounter), cumulative: stored as a value (last/min/max/avg), like a gauge; "rate/increase" are not offered for it.
- `unspecified` temporality: treated as cumulative for sums, delta for histograms (matches common SDK defaults); the Catalog shows "unspecified".
- The per-series "previous cumulative point" is session state, checkpointed at flush, so append continues correctly. Cumulative state is kept **per stream**, keyed by (series, `start`), so two producers sharing a series identity (e.g. parallel CI shards without `service.instance.id`), or `merge` replaying reports one after another, are separate streams and not resets.
- Only cumulative streams need order: a cumulative point older than its stream's last point is kept in chunks, skipped by the rollup and counted as "out-of-order". Delta, gauge and summary points are added to buckets in any order.

### 5.3 Buckets and resolutions
- Bucket aggregate per point kind, all mergeable:
  - number (gauge, non-monotonic sum): count, sum, min, max, last (+ last time).
  - monotonic sum: delta sum, resets.
  - explicit histogram: count, sum, min, max, per-bound counts.
  - exponential histogram: our `ExpHistogram`, **extended to negative values and the zero threshold** (it is non-negative only today).
  - summary: count, sum, and the **last** point's quantiles in the bucket (quantiles cannot be merged; charts at coarser resolutions say "quantiles from last point per bucket").
- Resolutions: a ladder of widths aligned like `TimeBuckets` (1 ms × 2^k), e.g. three levels each 8× coarser, with the finest chosen so a full-run series has ≤ ~2k buckets at the coarsest level that is still ≥ the median scrape interval. Exact ladder is the builder's call.
- **Cardinality cap** per metric (default 1,000 series, a writer config option): further series fold into one "other" series per metric. Filters or group-bys that would need to split "other" are marked **partial** on the chart.

### 5.4 Exemplars
Exemplars are copied into the series file (not read from chunks): per series per finest bucket keep up to N (default 4, prefer exemplars with a `trace_id`), mergeable by keeping the N with the most extreme values. Each keeps value, time, trace_id, span_id and filtered attributes. This makes the embedded grid's "exemplar = this trace" highlight and the exemplar → trace jump one-file lookups, at any report size. (Changes what I said in conversation; flag if you prefer chunk lookups.)

### 5.5 Files
- `data/rollups/metrics.js` grows a **catalog**: per metric name, the series definitions (kind, unit, temporality, monotonic, scope, attribute keys, series count, conflicts, resets, out-of-order count) and a coarse sparkline series (sum over series of the metric's natural "show").
- `data/metrics/…`: per-metric series buckets and exemplars, sharded by metric so the viewer loads only what a query names.
- **Built incrementally, valid after every flush (decided).** Series bucket state is not held in memory for the whole run (200 metrics × 1,000 series × 1 h at 10 s is ~72M points, over the 512 MB RSS target). At each flush the writer spills the **finest-level** buckets (and exemplars) accumulated since the last flush to per-metric **segment files**, listed in the manifest, and keeps only open buckets and cumulative stream state in memory (checkpointed). At close it **compacts** each metric's segments into its final file(s) and adds the coarser levels. Until close (a killed run, or a report opened mid-run, M5), a metric spans several segments; the viewer loads and merges a metric's segments and computes coarser levels itself, so charts work at every flush, more slowly on very long unfinished runs. Append resumes from the checkpoint and the existing segments. Shard and segment layout are the builder's call.
- `merge` keeps working unchanged in principle: it replays chunk points through a session, which rebuilds series. Chunks are time-partitioned, so replay order is close to time order; the out-of-order rule in §5.2 covers the rest.

## 6. Viewer

### 6.1 Metric query engine (in-house, shared)
- Query: `{ id, metric, show, by[], where (OTTL, datapoint context), fn[], alias, hidden }`; formula: `{ id, expr, alias }` over query ids (`+ − × ÷`, parentheses, numeric literals). These are the §9 shapes; M4 reuses them for the `metric` widget.
- **Combining series within a `by` group** (or "everything") is a per-kind rule table, not a query field: monotonic sums add; histograms merge buckets (explicit histograms with different bounds can't merge, so the chart shows one line per bounds set with a note); exponential histograms merge; gauges and non-monotonic sums use the `show` aggregation across series (avg → mean of series values, min/max → extreme, last → **sum** of each series' last value, so `process.memory.usage` by everything is total memory); summaries never combine, so a summary query is implicitly grouped by series, with a note. An optional `across` field (sum|avg|min|max) may be added in M4 without breaking the shape.
- **Conflicting definitions:** `metric` is a name plus optional `kind` and `unit`. They are required only when the catalog lists conflicting definitions for that name; otherwise the Explorer shows a picker notice instead of guessing.
- `where` is evaluated **per series**, not per point (series carry resource, scope and point attributes), so it is cheap at any size.
- `show` per kind (a data table): Sum (monotonic) → rate, increase, sum; Sum (non-monotonic) and Gauge → avg, min, max, last; Histogram / ExpHistogram → p50, p75, p90, p95, p99, count, sum, avg; Summary → its quantiles, count, sum.
- `ƒ`: rate (per second), increase, rollup(avg|min|max|sum, interval), top-N / bottom-N by group.
- The engine picks the coarsest resolution giving ≥ the chart's pixel-limited point count for the selected time range, aggregates series into the `by` groups, then applies `ƒ` and formulas. Formula operands align on time bucket and group key; a group present in only one operand yields gaps, not zeros.
- Time range, selection and filters live in the selection store as today; the metric queries serialize into the URL (`#/metrics?q=…`), validated at the boundary like other URL state.

### 6.2 Explorer (mockup screen 1)
- Query rows with the shared filter-token editor for `where` (OTTL datapoint context; `resource.attributes[…]`, `attributes[…]`, `metric.name`). Metric picker shows the type badge and unit from the catalog.
- Displays: Lines, Area, Bars (any kind); Heatmap and Distribution (histograms only, built from bucket counts). Y-axis linear/log. "One chart per query" toggle. Single y-axis per chart (§8.1); queries with different units in one chart are not allowed and the toggle forces split, with a note.
- Chart card is the shared component (S/M/L), extended for exemplars (ringed points, §8.1 colors), a marker line, and the pinned click menu.
- Click menu: exemplar → trace panel; traces/logs in this window → the Traces/Logs explorer with `t` set to the bucket window and the `where` carried using the M2 carry rule (only conditions that compile in the target context survive; dropped ones produce the existing notice); zoom to time.
- Export: CSV and JSON of the charted series (no OTLP JSON export for derived series).
- Empty and partial states follow the M1/M2 patterns.

### 6.3 Catalog (mockup screen 2)
Table from the catalog rollup: Metric, Type (with "monotonic"), Unit, Temporality, Scope, Attribute keys (+N), Series (with "+other" when capped), sparkline, Explore →. Text filter over name, unit, scope. Row click opens the Explorer with that metric and its default `show`. Sidebar gets the Catalog entry; `g m` opens the Explorer.

### 6.4 Embedded grid (mockup screen 3)
- A **Metrics** tab in the log panel, the span section and the trace panel, added to the existing tab tables; available only when the originating resource has metric series.
- Filter: the origin's resource (same resource ref; for the trace panel, the resources of the trace's spans). Window: the moment ± 5 min, clamped to the run (trace: the trace's span ± 5 min). Size toggle S/M/L. "Open in Explorer" carries the filters and window.
- Charts grouped by semconv namespace (`process.*`, `http.*`, …) via a data table, namespaces in semconv order then alphabetical; **every** metric of the resource gets a chart, but only the first namespace is expanded and charts render lazily as they scroll into view. One chart per metric with the kind's default `show`; a "this log / this span" marker; exemplars whose trace_id matches the origin's trace are highlighted.
- Trace panel with several resources: one chart per metric, one line per resource (color follows the service, §8.1).
- Each chart is the Explorer chart card fed by the query engine.

## 7. Tests, fixtures, targets

- **Fixtures** (OTel SDK, as in M1/M2): a metrics fixture with all five kinds, delta and cumulative, a counter reset, exemplars pointing into `linked-traces`, two resources, and a high-cardinality metric exceeding the cap in a test-only config. A hostile case: NaN/±Inf values, empty histograms, zero-count buckets, a metric name with `</script>`.
- **Unit:** temporality normalization (resets, start changes, out-of-order), bucket merging at each resolution, exp-histogram with negatives, percentile from explicit and exponential buckets, formula alignment, cardinality fold, per-series `where`.
- **e2e:** Explorer query → chart → exemplar jump; Catalog → Explorer; Metrics tab in all three panels; `file://` and static server; merge of two reports with metrics.
- **Targets** (new, ubuntu-latest, `OTEL_HTML_PERF_FACTOR` as before): Metrics Explorer interactive < 2 s on a report with 200 metrics × 1,000 series × 1 h at 10 s scrape; a query change re-renders < 150 ms (median); Catalog < 1 s; writer peak RSS stays < 512 MB with the series state included.

## 8. Decided in conversation

- Option 1 (writer-side multi-resolution series).
- Series files are built incrementally (segments per flush, compacted at close), so metric charts work in killed and in-progress reports.
- "Copy as dashboard widget" is out of M3.

## 9. Designer's calls (flag if wrong)

- Exemplars stored in the series file (§5.4), not read from chunks.
- `unspecified` temporality defaults (§5.2).
- Cardinality cap 1,000 series per metric, "other" series, partial label.
- Summary quantiles keep the last point per bucket.
- Embedded grid window ± 5 min and resource-ref matching.
- Mixed units in one chart force "one chart per query".
- Combining series within a group: per-kind rule table (§6.1); gauge `last` sums across series.
- Conflicting metric definitions: optional `kind`/`unit` on the query, required only when ambiguous.
- Cumulative state per (series, start) stream; out-of-order skip applies only to cumulative streams; merge order needs no change.
- Embedded grid shows every metric of the resource, collapsed by namespace and rendered lazily; trace panel draws one line per resource.

## 10. Left to the builder

Resolution ladder and widths (the ladder may be fixed at close; segments carry the finest level only), shard layout, exemplar attribute filtering, exact percentile interpolation for explicit buckets, URL encoding of queries, chart-card API extension, ECharts series types per display, plan task order.
