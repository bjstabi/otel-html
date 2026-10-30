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
