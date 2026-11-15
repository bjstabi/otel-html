# Faster tests and checks

**Status: approved 2026-11-15.** Written 2026-11-15 after the CI jobs slowed down again. The maintainer asked for every
test and check to be investigated for speed, not only the longest job, because the same tasks run locally for
verification. Four read-only investigations (Sonnet 5.5) measured unit, scaling and viewer tests, e2e, and the check
and CI pipeline; their reports are the evidence below. The maintainer approved the work of §4 as one PR (four phases), decided the points of
§5, and chose the **unattended** process (`docs/agents/process-unattended.md`).

## 1. Why

- The windows unit job's second shard is the PR critical path (about 450 s). Its files sum to 690 s against 260 s on
  shard 1: `test/scaling/generator.test.ts` grew from 15 s to 160–210 s, and `rollup-equivalence.test.ts` (140–170 s)
  has no weight in `test-support/shard-weights.json`.
- Every `openTestDb()` boots a fresh DuckDB-WASM: 208+ opens in the node unit project, 91 in rollup-equivalence; about
  30 % of that project's CPU.
- `test:scaling` builds 39 reports each run (116 s of worker time on 20 cores) into a temp dir it then deletes; unit
  test files that need the same shapes build their own copies (BASE in five files; generator.test about 25 builds of
  13 shapes).
- e2e WebKit and Firefox build the scale data for `calibration.spec.ts`, which skips on them (about 100 s per job);
  e2e-perf rebuilds the same scale data in both shards (60–80 s each).
- The collect action watches the dispatched deploy start (about 20 s per publishing job, critical path included).
- Coverage reruns the whole suite serially on main (580–880 s). A run has 20–21 jobs against a 20-job concurrency cap;
  overlapping runs queued 3–43 min.
- `lefthook` runs the full `check` before every push, so every push pays the unit and scaling suites locally.
- A fresh worktree fails `check` until `mise run build`: `test/host/engine.test.ts` needs
  `.cache/duckdb-extensions/*.wasm` and the dist engine bundle, and no task declares it.

Static checks (lint, `tsc` per project under 1 s, knip) are already fast; they are out of scope.

## 2. Goals

1. The same tests assert the same things, faster. No assertion is dropped to save time (the one exception is a test
   that only waited, §4 phase 1).
2. Fixtures that do not depend on the test are built once and reused: per run where they are cheap, across runs (a
   mise-cached task with declared outputs) where they are not.
3. Shards balance on measured weights, and a test fails when a test file has no weight or its weight is stale.
4. The PR critical path drops from about 8 min toward 4–5 min; local `check` on a typical edit drops by a third or more.
5. `check` passes in a fresh worktree without a manual build.
6. Local pushes run the static checks and the tests affected by the change, not the full suite.

## 3. Non-goals and anti-goals

- No page reuse across e2e tests (#286): deferred (§5).
- Merged scaling shapes stay (§5).
- No weakened isolation: a pooled or shared resource must give each test the state a fresh one would. A pool that can
  return stale results (as the prototype did through file names reused across `reset()`) is a failure even if it is
  faster.
- Caching belongs in local tools first (mise task cache, declared outputs); CI caches the same outputs only where a
  local cache cannot reach.

## 4. The work: one PR, four phases

### Phase 1: quick wins
- Refresh `test-support/shard-weights.json` (`mise run shard-weights`); a unit test fails when a test file matched by a
  sharded project has no weight. (The 2x drift check needs CI timings, so it lives in `shard-weights` as a warning, not in
  a unit test.)
- `calibration.spec.ts` is ignored on Firefox and WebKit, so their shards stop building scale data for it; the main e2e
  pass builds only the scale report its selection needs (`rowgroups`).
- The collect action dispatches with `--no-watch`, as the pusher does. (Touches `.github/actions`; approved.)
- `test/cli/host.test.ts:221` polls for its condition instead of sleeping a fixed 6 s.
- The unit, scaling and coverage tasks depend on the task that fetches the DuckDB extensions and builds what
  `engine.test.ts` reads, so `check` passes in a fresh worktree.
- Pre-push runs `check:static` and the unit tests changed since the merge base with `origin/main`; AGENTS.md's loop
  table says so. `verify` before a PR stays the rule.

### Phase 2: build fixtures once
- A `scaling:reports` mise task builds the scaling reports into `.cache/scaling-reports/` (declared outputs), keyed by
  the generator's sources. `test:scaling`, the unit tests that read these shapes, and `predict:queries` read from it;
  CI caches the directory. The determinism test still builds fresh.
- `generator.test.ts` builds each shape once per file.
- `rollup-equivalence.test.ts` reuses its opened layouts, with a fresh data source per case.
- Host tests (`host/server`, `engine-limits`, `engine-policy`) share one host per `describe` where the tests only read.

### Phase 3: a DuckDB instance pool
- One DuckDB-WASM instance per test worker, reset between uses, with registered file names made unique per open so no
  state keyed by file name survives a reset. Prototype: rollup-equivalence 46.8 → 15.1 s, node project 98 → 68 s at 4
  workers.

### Phase 4: CI structure (workflow files; approved)
- Coverage is collected inside the unit jobs on main and merged, instead of a serial rerun (or the coverage job is
  sharded, if merging proves unreliable).
- e2e-perf caches `e2e/.reports-scale`.
- Fewer jobs per run: fold `build` into `check`; fewer binary legs on pull requests.
- The windows job skips `lefthook install` and tools it does not use.

Each phase measures before and after on the jobs and local tasks it touches; the PR body records all the numbers.

## 5. Decisions (maintainer, 2026-11-15)

1. Pre-push hook: static checks plus changed tests. Yes.
2. Merged scaling shapes: keep them; the phase 2 cache removes most of their cost. Trim later only if `test:scaling`
   is still slow.
3. #286 (page reuse in e2e): deferred.

## 6. Evidence

The four investigation reports (`unit-node`, `scaling-viewer`, `e2e`, `checks-pipeline`) were working notes in the
session's git-ignored workspace; their numbers are summarised in §1 and §4.
