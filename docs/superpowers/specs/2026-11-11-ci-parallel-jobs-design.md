# CI: shard the long jobs across runners (design)

Approved by the maintainer in session on 2026-11-11 ("full split, unattended").

## Problem

A full CI run takes 8.5–10 min, set by `e2e (chromium)`. Measured on runs 43017103120, 43011921719 and 42957289406
(seconds):

| job               | total   | inside                                                                                  |
| ----------------- | ------- | --------------------------------------------------------------------------------------- |
| e2e (chromium)    | 470–605 | scale reports 66 · main pass 276 (125 tests, 4 workers) · @perf pass 156 (1 worker) · ~90 overhead |
| e2e (webkit)      | 386–471 | main pass 294 · ~90 overhead                                                            |
| unit-os (windows) | 290–460 | vitest main 250–380 · @perf 32 · setup 38                                               |
| check             | 245–360 | test:unit:main 210 · test:unit:perf 30 · lint/typecheck/knip < 20 in parallel           |
| e2e (firefox)     | 230–350 | main pass ~250                                                                          |
| e2e-metrics-scale | 135–170 |                                                                                         |

The e2e runner has 4 vCPUs and Playwright already runs 4 workers, so in-runner parallelism is spent. No single test
or test file dominates (slowest e2e test 34 s, slowest unit file 32 s of 266), so sharding by count balances well.
The main e2e pass selects no `scale.spec.ts` test, yet the Chromium job builds the scale reports (66 s) because the
same task also runs the @perf pass, which needs them.

## Design

Free GitHub-hosted runners only (public repo: free minutes, 20 concurrent jobs per account).

1. **`test:e2e --pass main|perf|all`** (default `all`, today's behaviour). The scale-report decision lists only the
   projects of the selected passes, so `--pass main` never builds the scale reports. `--shard=i/n` after `--` already
   reaches both passes (and the listing, which honours it).
2. **e2e matrix** `project × shard` (`[chromium, firefox, webkit] × [1, 2]`), each `--pass main -- --shard=i/2`.
3. **`e2e-perf` job**, Chromium, `shard: [1, 2]`, `--pass perf -- --shard=i/2`. The perf tests still run one at a
   time, each shard alone on its runner. Split measured at 52 s / 99 s of test time.
4. **Unit tests sharded.** `test:unit:main` and `test:unit:perf` take extra vitest args (mise appends args after `--`
   to a task with no `usage`). A new `unit` job (Linux, always runs like `check`) and `unit-os` (Windows) each run
   `shard: [1, 2]` with `test:unit:main -- --shard=i/2` and `test:unit:perf -- --shard=i/2`.
5. **`check` in CI** runs a new `check:static` task (lint, typecheck, knip) after `gen:check`; the unit tests moved to
   `unit`. Locally `mise run check` is unchanged (it now depends on `check:static` and `test:unit:main`).
6. Per-shard names: artifact names, the mise-task cache key and the otel-html-collect `name` carry the shard, so
   shards neither collide nor restore each other's task cache. `sample-report-*` is uploaded by shard 1 only.

## Expected result

Every job ≈ 3–4.5 min; the run ≈ 4.5–5 min instead of 8.5–10. Per-job fixed overhead (container, setup, build,
fixtures, collect) is ~90 s, which is the floor. 19 jobs on a PR, 20 on a push to `main` (coverage): two overlapping
runs queue part of each other at the 20-job account limit.

## Decided against

- More Playwright workers per runner: 4 workers on 4 vCPUs; the viewer's DuckDB-WASM work is CPU-bound.
- Merging `e2e-metrics-scale` into a perf shard: it sets `OTEL_HTML_PERF_FACTOR=1.5` and `OTEL_HTML_METRICS_SCALE`,
  which would change the other perf tests' budgets and selection.
- Building `dist/` once and sharing it as an artifact: the build step takes 5–8 s.
- No branch ruleset change is needed: it requires no status checks.

## Follow-up: balanced shards (PR 2)

PR #278's first run (43058191413) left the shards uneven, because Playwright and vitest both split by count in a fixed
order. Time inside the shard steps, shard 1 / shard 2: chromium main pass 207 / 103 s, Windows unit main 182 / 130 s
plus perf 35 / <10 s, Linux unit main 107 / 73 s plus perf 24 / <10 s, webkit 163 / 139 s. Firefox and e2e-perf were
within 15 s.

Design: split by weight, using a committed table of recorded durations (`test-support/shard-weights.json`) and a greedy
longest-first partition (`test-support/shard.ts`), so every shard computes the same split from the same file list
without any CI state.

- **Vitest:** a custom sequencer (`sequence.sequencer`) whose `shard()` partitions the files by weight. The main pass
  and the perf pass have their own tables. CI still passes `-- --shard=N/2`.
- **Playwright main pass:** `test:e2e --shard i/n` (a task flag) sets `OTEL_HTML_E2E_SHARD`. With it,
  `playwright.config.ts` gives each browser's `-file` and `-http` projects the spec files of shard i, partitioned by
  that browser's weights (Chromium sums `-file` and `-http`). Whole files, because Playwright takes no weights. The
  largest file is about 26% of Chromium's main pass, so a two-way split can still come out about even.
- **Playwright perf pass:** the same flag becomes Playwright's own `--shard=i/n`. That pass is already within 15 s, and
  9 of its 10 tests are in `scale.spec.ts`.
- A file missing from the table weighs the median, so new tests spread without a regeneration. `mise run shard-weights`
  rewrites the table from JSON-reporter runs of the unit passes and the three browsers' main passes. It is run when the
  shards drift; nothing runs it automatically.

Decided against: a third shard (the 20-job limit), vitest's own duration cache in CI (the shards would read different
caches and could drop or double a file), and per-test Playwright partitions passed as `file:line` filters (these OR with
any file the caller names).
