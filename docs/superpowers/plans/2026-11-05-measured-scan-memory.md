# Measured whole-run scan memory (#112) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A span query holds at most a bounded number of matched rows however many spans it scans, and a duration measure that hit the group cap says so instead of reading as complete.

**Architecture:** `SpanQueryRun` (`src/viewer/data/span-query.ts`) stops keeping every matched `SpanEntry`. In spans mode it keeps a buffer of `SpanRow`s that it compacts to the top `limit` with the same comparator `finish` uses whenever the buffer grows past a bound, and counts matches separately. In traces mode it keeps no matched list at all (`finish` never read it there). `GroupDurations` (`src/rollups/span-rollups.ts`) counts the spans whose group came after the cap was full; the dashboard facet widget shows a note when that count is not zero.

**Tech Stack:** TypeScript (strict), vitest, React (the widget). No new dependency, no report-format or `src/api` change.

**Issue:** #112 — no spec document; this plan is the design (a fix inside one area).

**PR process:** unattended (`docs/agents/process-unattended.md`), chosen by the maintainer on 2026-11-05. One PR: branch `fix/measured-scan-memory`, title `fix(viewer): a measured whole-run scan keeps only the rows it lists and notes groups past the cap`.

## Measurement (before)

A 1,000,000-span "Scan entire run" in spans mode with `measureBy: 'http.route'`, `limit: 1` (what the toplist/table widget sends), 200 chunks of 5,000 spans each built fresh and dropped after the visit (the LRU's effect), each span with its own three-attribute map: **1,047.8 MB** of heap retained by the run before `finish`, growing linearly with the spans scanned. The PR body repeats the measurement after the change; the expectation is a few MB (the 200 histograms and at most the compaction bound of rows). A result above 50 MB is worse than this plan expects: stop and ask.

The measurement is a throwaway vitest file run with `NODE_OPTIONS=--expose-gc pnpm exec vitest run --pool=forks --silent=false <file>`; it is not committed.

## Decisions (mine, recorded for the PR body)

- Compaction rather than a heap: `topK` already exists and is exact. Compacting the kept rows (already in order, all earlier in the input than the new ones) together with the new rows gives the same result as `topK` over the whole input, ties included, because ties are broken by input position.
- Compaction bound: compact when the buffer reaches `limit + Math.max(limit, 1024)` rows, so the cost stays amortised O(n) and the buffer never exceeds about twice the limit (plus 1,024).
- The row buffer holds `SpanRow`, not `SpanEntry`: an entry also references its chunk's resource and scope tables.
- The cap note counts spans, not distinct dropped groups: counting distinct values past the cap would need an unbounded set, which is the thing the cap exists to avoid.
- No change to the 1,000 cap itself, to traces mode's per-trace rows (`finish` builds each trace row from them; the widget only measures in spans mode), or to the log query.
- The explorers never send `measureBy`, so only the dashboard widget gets the note.

## Review Focus

- **Ties and limits:** the compacted result must equal `topK(allMatchedRows, limit, ordered(dir, compare, byStart))` for limit 0, 1, a limit below the bound, a limit above the match count, and input with many equal sort keys. Test in Task 1.
- **`units` and `total`:** both are the match count in spans mode, never the buffer length. A capped (non-measure) windowed scan must still stop at `listCap` matches.
- **The cap note:** appears only for a duration measure with dropped spans; the widget's chart height accounts for it like the partial note.

---

### Task 1: `SpanQueryRun` keeps a bounded row buffer

**Files:**
- Modify: `src/viewer/data/span-query.ts`
- Test: `test/viewer/span-query.test.ts`

- [ ] **Step 1: Write failing tests** in `test/viewer/span-query.test.ts`:
  - For each of limit `0`, `1`, `7`, `100`, `5000` and sorts `duration desc`, `duration asc`, `name asc`, `start desc` over `synthetic(20_000)` (many equal durations and names), `querySpanEntries(entries, q).rows` equals the reference `[...rows].sort(ordered-equivalent).slice(0, limit)` computed in the test (sort by the column in the direction, ties by `span.start` ascending, then input order) and `total` is 20,000. This passes today; it guards the refactor.
  - A test that fails today: a `SpanQueryRun` over `synthetic(10_000)` with `limit: 1` exposes how many rows it holds. Add a `/** @internal for tests */ get heldRows(): number` getter that returns the buffer length; after visiting 10,000 entries it is at most `1 + 1024`. (Today the equivalent is 10,000.)
  - Traces mode: `heldRows` is 0 after a traces-mode run.
- [ ] **Step 2: Run** `pnpm exec vitest run test/viewer/span-query.test.ts` — the `heldRows` tests FAIL.
- [ ] **Step 3: Implement.** Replace `#matched: SpanEntry[]` with `#rows: SpanRow[]` and `#count = 0`. Build the comparator once in the constructor (`ordered(q.sort.dir, compare, (a, b) => a.span.start - b.span.start)`) and use it in both compaction and `finish`. In `visit`, after the filters: `this.#count++`; in spans mode push `e.row` and, when `#rows.length >= limit + Math.max(limit, 1024)`, replace `#rows` with `topK(#rows, limit, order)`. `units` returns `#count` in spans mode. `finish` uses `topK(#rows, limit, order)` and `total = #count`. Update the class and field comments to say what is held.
- [ ] **Step 4: Run** the file — PASS; then `pnpm exec vitest run test/viewer` — PASS.
- [ ] **Step 5:** `pnpm exec biome check .`, `mise run typecheck`, commit `fix(viewer): a span query holds at most a bounded buffer of matched rows`.

### Task 2: `GroupDurations` counts spans past the cap; the widget says so

**Files:**
- Modify: `src/rollups/span-rollups.ts` (`GroupDurations`)
- Modify: `src/viewer/dashboards/widgets/facet-chart.tsx`
- Modify: `README.md` (the dashboards paragraph at the `toplist` / `table` measure sentence)
- Test: `test/rollups/span-rollups.test.ts`, `test/viewer/dashboard-facets.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - `span-rollups.test.ts`, the existing cap test: after the adds, `g.dropped` is `1`; add `c` again and it is `2`; `g.cap` is `2`.
  - `dashboard-facets.test.tsx`: a span toplist with `measure: 'duration.max'` over a data source whose result carries a `GroupDurations` with `dropped > 0` shows the one-line text `3 spans past the first 2 values left out` (truncated, so the `NOTE_PX` budget holds in a narrow widget) with the full sentence `Measured over the first 2 service.name values; 3 spans with other values are left out` as its title (use a stub `DataSource` or the existing helpers, whichever the file already uses for a crafted result; numbers formatted with `toLocaleString('en-US')`, so `1,000`). The same widget with `dropped === 0` shows no such note, and a `count` measure never does.
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.** `GroupDurations` gains `readonly cap` (from the constructor) and `get dropped(): number` (incremented in `add` when a new group is refused); its doc comment says groups past `cap` are not kept and their spans are counted in `dropped`. In `facet-chart.tsx`, a `CapNote` beside `PartialNote` renders when `measure !== 'count'` and `result.groups?.dropped` is above 0, in the same style as the partial note, and `notes` adds `NOTE_PX` for it. README: after the measure sentence, one sentence: "A duration measure keeps the first 1,000 values of `groupBy`; the widget says how many spans had other values."
- [ ] **Step 4: Run** both files and `pnpm exec vitest run test/viewer test/rollups` — PASS.
- [ ] **Step 5:** `pnpm exec biome check .`, `mise run typecheck`, commit `fix(viewer): a duration measure says when groups past the cap were left out`.

### After the tasks

- `mise run check`, then `mise run test:e2e:chromium -- e2e/dashboards.spec.ts` (or whichever spec covers dashboard toplists), then `mise run verify`.
- Re-run the measurement; record before/after in the PR body.
