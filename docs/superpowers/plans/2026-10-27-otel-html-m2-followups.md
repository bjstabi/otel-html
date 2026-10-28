# otel-html M2 follow-ups (GitHub issues #6–#10)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One task at a time, on branch `fix/m2-followups` (from `main`).

**Goal:** Close the open post-M2 GitHub issues in priority order: #6 (writer RSS bug), #7 (a11y contrast), #8 (first-trace wait), #9 (dedupe), #10 (minor findings).

**Spec:** `docs/superpowers/specs/2026-10-25-otel-html-design.md` (§16 targets; §7, §8). M2 plan for context: `docs/superpowers/plans/2026-10-26-otel-html-m2.md` (do not re-execute it).

**Issue text is the requirement.** Each task names its issue; run `gh issue view <N>` and treat the issue body as the task's acceptance criteria, together with what is written here.

## Global Constraints

- Everything in the M1/M2 plans' Global Constraints still applies: no `any`, no non-null assertions, exhaustive `switch` via `never`, typed `OtelHtmlError`s with `path`/`expected`/`actual`; Biome strict at error; `mise run check` must pass (< 60 s).
- Browser-safe dirs (`src/model`, `src/format`, `src/ottl`, `src/rollups`, `src/semconv`, `src/viewer`) never import `node:*`. `file://` rules: no fetch/XHR/ES modules/worker files.
- Domain rules are data tables (severity bands/labels/colors, facets, tabs).
- No new runtime dependencies unless a task explicitly allows it.
- Severity is never shown by color alone. Severity bands: 1–4 trace, 5–8 debug, 9–12 info, 13–16 warn, 17–20 error, 21–24 fatal, 0 unspecified.
- Targets (§16): writer peak RSS < 512 MB for 1M logs; ≤ 200 bytes/log on disk; other perf targets unchanged — do not regress them.
- TDD: write the failing test first for behavior changes and bug fixes.
- Conventional commits; reference the issue (`Refs #N`, or `Fixes #N` on the commit that completes an issue). Each commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01DJYkxdKnh2EMJxC22dYGFg`
- Do not push, open PRs, or touch GitHub issues (no comments/closing). The controller does that.

---

### Task 1: Writer peak RSS under 512 MB for 1M logs (#6)

**Issue:** #6. Gated test: `test/writer/log-size.test.ts` (run with `OTEL_HTML_LOAD=1`), currently KNOWN FAILING at ~1130 MB.

**Approach (in order):**
1. Measure first. Reproduce the gated test's number. Then attribute the peak: input parse (`src/model/otlp-json.ts` `JSON.parse(text, reviveNumbers)`, the whole file text, plus protobuf path in `src/model/otlp-proto.ts`) vs writer working set (rollups, Drain, chunk buffers, trace index, interner). Use `--heapsnapshot-near-heap-limit`, `process.memoryUsage()` checkpoints, or `--max-old-space-size` experiments. Write down the numbers in the report.
2. Fix with option 1 from the issue (stream the input): parse OTLP JSON incrementally so a whole 25 MB file is never materialized as one object tree — e.g. a small hand-written streaming tokenizer/visitor in `src/model` that emits one resource/scope batch (or one record) at a time into the existing normalize path, and read protobuf input incrementally where practical. No new runtime dependency unless it is small, maintained and pure JS — prefer hand-written. Keep the existing number-reviving semantics (64-bit ints etc.) exact; the existing OTLP JSON tests must still pass unchanged.
3. Reduce the writer's own working set where measurement shows it dominates (e.g. flush chunk buffers sooner, cap/compact Drain state, avoid retaining parsed records after chunking).
4. Remove the `KNOWN FAILING` comment once the gated test passes; update the README Limitations line about >1 GB accordingly.

**Done when:** `OTEL_HTML_LOAD=1` gated test passes (< 512 MB peak RSS) and `mise run check` passes. If after honest effort the target is unreachable without unreasonable changes, stop and report BLOCKED with measurements and the remaining gap — do NOT change the spec target yourself.

### Task 2: Light-mode severity colors ≥ 3:1 (#7)

**Issue:** #7. Files: `src/viewer/theme/tokens.css`, `palette.ts` (find via grep), the palette test.

- Choose darker light-mode warn, debug and trace colors with ≥ 3:1 contrast vs `#fff`, keeping the six severities reading as one ordered scale (trace lightest/most muted → fatal darkest/most saturated; warn stays amber/orange family).
- Raise the palette test's light-mode floor back to 3:1.
- Also make dark-mode fatal and error clearly distinguishable in hue/lightness while still passing 3:1 on the dark background.
- Update the spec's/plan's quoted light hexes? No — only update `docs` where the README or spec documents the actual palette values; mention the new values in the report.

### Task 3: Opening the first trace no longer waits on the eager log load (#8)

**Issue:** #8.
- `getTrace` reads the trace's log count from the trace index (`TraceEntry.logs`) instead of the loaded logs, so opening a trace does not await the log load.
- If the log load fails, the trace panel still works; the span panel's Logs tab stays visible and shows the load error there instead of being hidden.
- Tests: a unit test that `getTrace` resolves without awaiting logs (e.g. log load never resolves / rejects) and returns the indexed count; a test for the Logs tab error state.

### Task 4: Deduplicate helpers — data and small utilities (#9, part 1)

**Issue:** #9, these checklist items only:
- Severity bands defined once (writer rollups, `severityRangeTokens`, histogram `SEVERITY_SERIES`) — one data table in a browser-safe dir that all three derive from.
- `DEFAULT_LOG_FACETS` the only list of log facets (drop `FACET_DEFS.log` copy).
- Trace Logs tab (`trace-logs-tab.tsx`) uses the shared log comparators.
- `FIELD` constant defined once.
- Remove `replaceRoute` (use `navigateRoute`).
- Share the try/catch wrapper repeated in `log-windowed.ts`.
Pure refactor: no behavior change; existing tests pass; add tests only where a new shared module has logic.

### Task 5: Deduplicate helpers — React components (#9, part 2)

**Issue:** #9, the remaining items:
- One keyed-async hook shared by the five components that load data by key and drop stale results (find them by the stale-result pattern). Unit-test the hook (stale result dropped, error surfaced, key change resets).
- Share the explorer control row (mode, view, column picker) between traces and logs explorers.
- Share the log filter closure between `log-tabs.tsx` and `span-section.tsx`.
Pure refactor otherwise; e2e-visible markup and test ids unchanged.

### Task 6: #10 behavior fixes — query, filter and routing (T7, T8, T11)

**Issue:** #10 "Behavior" items tagged T7, T8, T11 (8 items). Fix each with a failing test first. For "`setSeverityRange` with min > max", surface a typed usage error rather than silently matching nothing.

### Task 7: #10 behavior fixes — logs table, panel, writer and misc (T4, T6, T9, T10, T12, T13, T14)

**Issue:** #10 remaining "Behavior" items (T10 ×3, T6 ×2, T12, T14, T9, T4, T13). Fix each with a test first where testable. Rulings to apply:
- T10 trace link: render the trace id as plain text (with "trace not in this report" title) when `hasTrace` is false.
- T10 bodies > 256 KiB: segment the first 256 KiB and render the rest as one plain-text segment (never drop text); document the cap in code.
- T6 `logCount` after crash/resume: make the count derive from rows actually committed.
- T6 surrounding-logs inexactness: if an exact fix is disproportionate, keep behavior but label the result "partial"/approximate when chunks overlap in time, and say so in the report.
- T13 `CHAR_PX`: replace with measured text width via a cached canvas `measureText` (fallback to the heuristic when no canvas, e.g. jsdom).
If any single item turns out to need a design decision beyond these, implement the conservative option and list it under concerns.

### Task 8: #10 test gaps and naming/tidiness

**Issue:** #10 "Tests" and "Naming and tidiness" items (skip the already-checked T3 `as never`). Add the missing tests; do the renames/cleanups. For "facet truncation can split a surrogate pair", fix it (truncate on code points) with a test.
