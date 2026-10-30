# otel-html open issues after the metrics scale work (GitHub issues #14, #18, #25, #38–#41)

**Goal:** close every open issue without opening follow-ups. Split into PRs that each close their issues whole:

1. **PR 1 (branch `fix/open-issues-m3-followups`):** #41, #40, #39, #25. Small and mechanical. #25 was already fixed by #32 (the e2e global setup times a fixed CPU workload and scales the budgets by `measured ÷ OTEL_HTML_PERF_REFERENCE_MS`, and logs the CPU model); the PR says so and closes it.
2. **PR 2:** #38, report format 3 (paged level and exemplar files). Design below.
3. **PR 3:** the rest of the #18 checklist, and #14.

Everything in the M1–M4 plans' Global Constraints still applies (no `any`, exhaustive switches, typed `OtelHtmlError`s, browser-safe dirs never import `node:*`, TDD, conventional commits, `mise run check` green). Git hooks are not installed in this checkout: run `pnpm exec biome check .` and the three `tsc` projects by hand before each commit, never through a pipe that hides the exit status.

## #38 design: pages (format 3)

**Problem.** A zoomed chart reads the whole finer level file `l<k>.js` and, for levels 0–2, the whole `ex.js`, so its cost grows with run length. Only the coarsest level is bounded (≤ `LEVEL_MAX_BUCKETS` = 2,000 buckets per series).

**Layout.** `PAGE_BUCKETS = 2048`. Page `p` of level `k` holds the bucket indexes in `[p·2048, (p+1)·2048)`. A level whose buckets all fall in one page is written as today, one `l<k>.js` (so the coarsest level, ≤ 2,000 buckets, always is, and short runs are byte-identical to format 2). A level spanning more than one page is written as `l<k>-<p6>.js` per non-empty page, with `page: p` in the head; there is no `l<k>.js` then. Exemplar files follow the grid of the level they serve: `ex.js` (levels 0–2, on level 2's grid of 65.536 s × 2048 ≈ 37 h per page) becomes `ex-<p6>.js` pages when it spans more than one, and `ex<k>.js` becomes `ex<k>-<p6>.js` on level k's grid. Every page is listed in `manifest.metricFiles` (a 7-day run at 10 s lists ~340 files per metric; acceptable). `METRIC_FILE_PATH` gains the three paged forms.

**Writer.** Compaction splits each level by page (binary search per series), writes pages in pieces as it writes whole levels now, and lists them. Demotion (`#readLevel(id, 0)`, `#readExemplars`) reads every page of the level and merges with `mergeBucketSeries` / concatenation. `byMetric` groups pages per level. `merge` replays chunks and never reads level files, so it is untouched. `FORMAT_VERSION` = 3; `READABLE_FORMAT_VERSIONS` = [1, 2, 3]; a format-2 report still opens (only whole files) and appending to it upgrades it.

**Viewer.** `LoadedMetric.level(k, window?)` returns the level's data over the pages that overlap `window` (all pages when `window` is omitted or the level is one file); pages are cached per (level, page); a series' buckets are concatenated in page order. Exemplars come from the exemplar pages overlapping the window. `runMetricQueryAtWidth` passes the chart window. **Counter `sum`** (a running total since the run start) needs the deltas before the window: they are taken from the coarsest level (one bounded file) for the coarse buckets wholly before the first loaded page, plus the fine buckets from that page's start to the window; when the coarse width exceeds the page (`8^(K−k) > 2048`, runs of months zoomed to level 0) the loaded fine range is extended back to the coarse bucket's start. Exact, and bounded by the window in every realistic run.

**Tests.** Format: page split and parse, out-of-page bucket rejected, paths. Writer: a long run compacts into pages, a reopened paged report demotes and recompacts to the same bytes, the crash/retry test still holds. Viewer: `test/viewer/metric-scaling.test.ts` gets a fixed-width zoom at 1×/2×/4× (buckets and exemplars loaded do not grow with the run), the counter `sum` over a zoomed window equals the unpaged result, format-2 fixtures still load. e2e: the scale guard still expects exactly `l1.js` for the first chart.

**Docs.** M3 spec Targets paragraph (the sentence "A zoomed chart reads whole finer-level files…" is replaced), README format tree and Limits, `version.ts` comment.

## PR 3: the rest of #18, and #14

Decisions per remaining #18 item (the issue's task ids). "Note" means the PR explains why nothing changes.

**Correctness.** T6: `toLevelData` drops series ids at or past the catalog's count. T7 narrow width: `runMetricQueryAtWidth` throws a `usage` error naming the metric when no level is as fine as the width (only a malformed report reaches it). T7 recursion: the parser's `MAX_DEPTH` (64) already bounds `evalAt`/`unitOf`; note. T7 ordering: heat and distribution are built from the series `top`/`bottom` kept. T12 `where: null`: an origin with no scalar attribute counts every other resource as unexcluded, so the grid's note says the filter matches everything. T12 `unexcluded`: distinct other resources, not per clause. T12 null range: clamp to the run's range. T13: window ends are inclusive, so a window ending on a bucket boundary holds one bucket more than its length over the width; documented at `bucketsOver`, by design.

**Viewer.** T9: the card's unit is the one every series shares, else none; the window marker and band live on their own silent series; duplicate legend labels get ` (2)`, ` (3)`; area exemplars sit on their series' stacked value; a drag released outside the plot zooms to the plot's edge, and a click outside bumps `seq` so an older lookup cannot open the menu. T10: the chip takes its colour from the plot's first series; plots label results with the state they ran under (`MetricQueries.ran`), relabelled only by alias; the exports carry `heat` and `distribution`; the click menu's window uses the picked query's width; legend labels truncate at 48 characters with the full label in the tooltip. T11: `entries()` memoised; a "No metrics match" line; the Explore cell is a real link. T12: a `ltab`/`tab`/`stab` the record has no tab for shows a notice instead of a silent fallback.

**Writer and format.** Pre-release checkpoint keys: note. T3: `restoreSeries` already rejects a duplicate key (note); `ValueBuckets#fit` grows geometrically; folded points intern through the identity cache, which is one `Map` lookup (note). T4: `close` releases the lock in `finally` around `prune`; `ChunkBuffer.push` is a broken-invariant throw (note); `encodeAttrs` carries the key for every kind; `series.js` attribute order is the canonical key's, documented; the README says `addMetrics` reads OTLP JSON in place; segment exemplars are appended, not concatenated. T5: the fixture generator no longer stamps gauges with a start time (fixtures regenerated).

**Tests.** Each listed gap gets a test unless an existing one already covers it (the PR names which).

**Tidiness.** T3: the attribute codec moves to `src/rollups/attribute-codec.ts`. T4: `wrapDataFilePieces` reports an undefined item at `items[i]` like `wrapDataFile`'s root. T12: the `f.start as RelNanos` cast goes. T8: the dashboards carry-over keeps `m` (M4 shipped with it; the Fusion grid reads it).

**#14.** The library figure is measured through the API in the gated memory test (reported, with the CLI's figure the asserted one), `mise run test:load` runs on ubuntu in a `workflow_dispatch` + weekly job, and the README numbers are refreshed from that run.
