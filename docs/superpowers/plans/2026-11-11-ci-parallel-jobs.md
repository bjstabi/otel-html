# CI parallel jobs (plan)

Spec: [2026-11-11-ci-parallel-jobs-design.md](../specs/2026-11-11-ci-parallel-jobs-design.md).
PR process: **unattended** (maintainer, 2026-11-11). One PR.

| PR | branch             | title                                         |
| -- | ------------------ | --------------------------------------------- |
| 1  | `ci/parallel-jobs` | `ci: shard the e2e and unit jobs across runners` |

Measurements the PR body carries: per-job durations and the run's wall clock from the PR's own CI run, next to the
baseline in the spec.

## Task 1: mise tasks (`mise.toml`, README via `mise run gen`)

1. `test:e2e`: add `flag "--pass <pass>" default="all"` (values `main`, `perf`, `all`; any other value exits 2 with
   a message). The scale-report listing passes only the selected passes' projects (`main`: `-file` and `http`;
   `perf`: `perf`; `all`: all three). The main pass runs only for `main|all`; the perf pass only for `perf|all`.
   Describe `--pass` and `--shard` sharding in the task description.
2. `test:unit:main`, `test:unit:perf`: no `usage`, so mise appends args after `--` to the command
   (`mise run test:unit:main -- --shard=1/2`). Say so in their descriptions.
3. New `check:static` task: `depends = ["lint", "typecheck", "knip"]`, description "lint, typecheck and knip (the
   part of `check` without tests)". `check` becomes `depends = ["check:static", "test:unit:main"]`, run unchanged.
4. `mise run gen` (README task docs), `mise run check`.

Verify: `mise run test:e2e --browser chromium --pass main -- e2e/<a small spec>.spec.ts` prints "does not need the
scale reports" and runs no perf pass; `mise run test:e2e --browser chromium --pass perf -- e2e/trace-panel.spec.ts`
runs only the perf pass (one test); `--pass bogus` exits non-zero; `mise run test:unit:perf -- --shard=1/2` runs
about half the perf files.

## Task 2: `.github/workflows/ci.yml`

1. `check`: replace `mise run check` with `mise run check:static`.
2. New `unit` job after `check` (no `needs`, always runs, as `check` does): Linux, `strategy.matrix.shard: [1, 2]`,
   `fail-fast: false`, `OTEL_HTML_PERF_REFERENCE_MS: "100"`, the same checkout/setup/task cache/build/otel-html-setup
   steps as `check`; steps `mise run test:unit:main -- --shard=${{ matrix.shard }}/2` and
   `mise run test:unit:perf -- --shard=${{ matrix.shard }}/2`; collect `name: otel-html-unit-${{ matrix.shard }}of2`.
   Task cache key carries the shard.
3. `unit-os`: matrix adds `shard: [1, 2]`, `fail-fast: false`; the two commands as in `unit` replace
   `mise run test:unit`; cache key and collect name carry the shard.
4. `e2e`: matrix adds `shard: [1, 2]`; run `mise run --skip-deps test:e2e --browser ${{ matrix.project }} --pass main
   -- --shard=${{ matrix.shard }}/2`; artifact `playwright-results-<project>-<shard>of2`; `sample-report-<project>`
   only `if: always() && matrix.shard == 1`; cache key and collect name carry the shard. Update the comments that
   say the chromium leg runs the perf passes.
5. New `e2e-perf` job, a copy of `e2e` for Chromium only with `shard: [1, 2]`: `--pass perf -- --shard=i/2`,
   artifact `playwright-results-perf-<shard>of2`, no sample-report upload, collect `otel-html-e2e-perf-<shard>of2`.
6. `actionlint` via `mise run lint`; `mise run check`.

## Task 3 (coordinator): PR and measurement

`mise run verify`, branch review on Opus 5.5, `gh pr create`, wait for CI, record the job durations in the PR body,
merge on green.
