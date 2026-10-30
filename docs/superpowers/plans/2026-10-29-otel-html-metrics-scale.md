# otel-html metrics scale (GitHub issues #35–#37)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One task at a time, on branch `perf/metrics-scale` (from `main`).

**Goal:** Make the metrics scale check cheap (#36), bound the Explorer's first-chart work independent of run length (#37), and make the metrics writer at least 2× faster (#35).

**Spec:** `docs/superpowers/specs/2026-10-27-otel-html-m3-design.md` (Targets, line ~114). Earlier plans for context only (do not re-execute): `docs/superpowers/plans/2026-10-27-otel-html-m3.md`.

**Issue text is the requirement.** Each task names its issue; run `gh issue view <N>` and treat the issue body as the task's acceptance criteria, together with what is written here.

**Order:** #36 → #37 → #35. #36 first so later tasks can run the scale check in seconds. #37 before #35 because #37 may change the metric file format (scrape interval in `series.js`/catalog); #35's "report bytes unchanged" baseline is taken after #37 lands.

## Global Constraints

Everything in the M1–M4 plans' Global Constraints still applies. Restated where this work touches it:

- No `any`, no non-null assertions, exhaustive `switch` via `never`, typed `OtelHtmlError`s with `path`/`expected`/`actual`. Biome strict at error. `mise run check` must pass (< 60 s).
- Browser-safe dirs (`src/model`, `src/format`, `src/ottl`, `src/rollups`, `src/semconv`, `src/viewer`) never import `node:*`. `file://` rules: no fetch/XHR/ES modules/worker files.
- Domain rules are data tables. No new runtime dependencies.
- Never silently wrong: an older report without a new format field still opens (fallback), and a format change bumps the format version.
- Targets: writer peak RSS < 512 MB; Explorer < 2 s and Catalog < 1 s on the metrics scale report (`OTEL_HTML_PERF_FACTOR` scaling). Do not regress them.
- TDD: write the failing test first for behavior changes.
- Conventional commits; reference the issue (`Refs #N`, or `Fixes #N` on the commit that completes it). Each commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Do not push, open PRs, or touch GitHub issues. The controller does that.

---

### Task 1: Metrics scale check writes only the data the pages read (#36)

**Issue:** #36. Do all three parts: the smaller report (generator option to emit a subset of metrics per collection; values stay pure functions of (metric, series, collection)), the network guard in `e2e/scale.spec.ts` on `chromium-http`, and the spec/CI/README/comment updates. Bump the cache key; drop the `.cache` keep-between-runs logic, the disk cleanup step and the bare-runner setup if writing now takes under a minute (move the job into the Playwright image like the other e2e jobs if that is straightforward).

**Verify:** run the metrics scale e2e locally (see `mise.toml` / README for the command) and record write time and test results in the report. Verify the guard by temporarily pointing the Explorer at a second metric (or equivalent) and confirming it fails with the intended message; revert that and say in the report how you checked. `mise run check` passes.

### Task 2: Explorer loads metric levels on demand (#37)

**Issue:** #37. Write the scaling test first (1×, 2×, 4× durations through `Report`, count buckets loaded for the default first chart) and confirm it fails on current code. Then make levels lazy per (metric, level), cached; choose how to handle `pointIntervalNs` (prefer the writer recording the median scrape interval with a format version bump and a fallback for old reports, unless estimating from the coarsest level is demonstrably accurate); formulas load only the level at their shared width; leave `fromSegments` as is with a note; check exemplars' growth and window them if unbounded.

**Constraint from Task 1:** `e2e/scale.spec.ts` now has a network guard allowing the Explorer's first chart to load only `data/manifest.js`, `data/rollups/metrics.js` and `data/metrics/000000/*`. Keep it passing; tighten it if lazy loading makes a stricter assertion natural (e.g. not every `l<k>.js`).

**Done when:** the issue's Done-when list holds, including the M3 spec Targets update, the metrics scale budgets passing (run the scale e2e), and `mise run check`.

### Task 3: Writer throughput for metrics ingest ≥ 2× (#35)

**Issue:** #35. Measure first: reproduce the issue's 1/30 slice timing (ingest + `close`) locally under bun and write the baseline in the report. Capture a byte baseline of a written report (hash every file) before changing anything. Then apply the issue's ideas as measurement supports (single JSON encode per point straight from the protobuf message; skip zod on segments this session wrote; cache the canonical attribute key per (resource, attribute set)), re-profiling between steps.

**Done when:** the 1/30 slice ingest + `close` is ≥ 2× faster than the baseline, peak RSS target still holds (run the gated RSS test if one exists for metrics; say which you ran), the report bytes match the baseline hashes (or each difference is deliberate and documented in the report and the commit), and `mise run check` passes.
