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

---

# PR 2: balanced shards

| PR | branch              | title                                          |
| -- | ------------------- | ---------------------------------------------- |
| 2  | `ci/balance-shards` | `ci: balance the test shards by recorded duration` |

Spec: "Follow-up: balanced shards" in the design. Measurement for the PR body: shard 1 / shard 2 step times from the
PR's CI run, against PR #278's run 43058191413.

## Task 4: weighted partition, weights table, vitest sequencer

1. `test-support/shard.ts`: `partition(items: {key, weight}[], count): string[][]`, which sorts by weight descending
   then key ascending and assigns each item to the lightest bin (lowest index on a tie). It is deterministic and every
   key lands in exactly one bin. Also `shardOf(keys, weights, index, count)`: a key missing from `weights` weighs their
   median (1 when the table is empty). Parse `"i/n"` with an `OtelHtmlError`-style typed error on bad input (follow
   what test-support already does for errors). TDD in `test/test-support/shard.test.ts`.
2. `test-support/shard-weights.json`: `{ "unit": {file: s}, "unit-perf": {file: s}, "e2e": { "chromium": {file: s},
   "firefox": {…}, "webkit": {…} } }`. Files are repo-relative for unit (`test/…`) and spec basenames for e2e
   (`cross-link.spec.ts`). Seconds, with one decimal.
3. A vitest sequencer (for example `test-support/shard-sequencer.ts`) extends `BaseSequencer` from `vitest/node`,
   overrides `shard()` with `shardOf` (the `unit-perf` table under `OTEL_HTML_PERF_PASS=1`, `unit` otherwise), and
   keeps `sort()`. Wire it in `vitest.config.ts` (`test.sequence.sequencer`). Check that test:unit:main and
   test:unit:perf list the weights file among their sources (add it if not).
4. `scripts/shard-weights.ts` and a mise task `shard-weights`. It runs the unit main pass and the perf pass with the
   json reporter, then `playwright test --project <b>-file --project <b>-http* --grep-invert @perf --reporter=json` per
   browser after `e2e:fixtures`, and writes the table: per file, the vitest file duration, or the sum of the
   Playwright test durations. Pick the vitest field that best predicts wall time (including import and environment
   if the report has them) and say which in the code. Then run it to produce the committed table. Describe the task;
   `mise run gen`.
5. Verify: `vitest list --filesOnly --shard=1/2` and `2/2` have no overlap, and their union is the unsharded list (main
   and perf passes). Print each shard's weight sum.

## Task 5: Playwright main-pass shards, `test:e2e --shard`, ci.yml

1. `playwright.config.ts`: when `OTEL_HTML_E2E_SHARD=i/n` is set, the `-file` and `-http` projects of each browser get
   `testMatch` set to the shard's files. Partition with `shardOf` over that browser's candidate spec files (every
   `e2e/*.spec.ts` minus that browser's `testIgnore`) and the `e2e.<browser>` weights. Perf projects are untouched.
   Without the env var the config behaves exactly as today.
2. `test:e2e`: `flag "--shard <shard>"` (empty default). The main pass and its scale listing run with
   `OTEL_HTML_E2E_SHARD` set to it; the perf pass and its listing get `--shard=<value>` appended. Update the task
   description; `mise run gen`.
3. `ci.yml`: e2e uses `--pass main --shard ${{ matrix.shard }}/2`, and e2e-perf uses `--pass perf --shard ${{ matrix.shard }}/2`.
4. Verify: for each browser, the `--list` of shard 1 plus shard 2 equals the unsharded `--list` with no overlap (main
   pass), and print each shard's predicted weight. `mise run verify`.
