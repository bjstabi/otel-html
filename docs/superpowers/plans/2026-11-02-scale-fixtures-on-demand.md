# Scale fixtures on demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scale` and `huge` (~14 s of the ~15 s fixture build) are built only when the selected Playwright tests include `e2e/scale.spec.ts`, and a viewer-only change refreshes them with `otel-html upgrade` instead of converting them again.

**Architecture:** The two reports move out of `e2e/build-fixtures.ts` into `e2e/build-scale-fixtures.ts` and the folder `e2e/.reports-scale/`. Two mise tasks build them: `e2e:fixtures:scale:data`, whose sources are the `build:lib` outputs and the generators, and `e2e:fixtures:scale`, whose source is `dist/viewer/**` and which runs `upgrade` on both reports. `test:e2e` runs `playwright test --list` with its arguments and runs the two tasks only when a listed test is in `scale.spec.ts`.

**Tech Stack:** unchanged (TypeScript, bun, Playwright, mise 2026.10.25 with `task.source_freshness_hash_contents = true`). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-02-scale-fixtures-on-demand-design.md`. Read it first: it has the measurements and the maintainer's decisions.

## PR process (unattended)

`docs/agents/process-unattended.md` and `docs/agents/conventions.md` apply. Implementers and per-task reviewers: Sonnet 5.5 subagents. Whole-branch review before the PR opens: Opus 5.5; every review summary names its model. Squash-merge on green CI (`gh pr merge <n> --squash --delete-branch`). Nothing here touches a write-token area.

| PR | Branch | Title (the squash commit) | Tasks |
|---|---|---|---|
| 1 | `test/scale-fixtures-on-demand` (exists; holds the spec commit) | `test(e2e): build the scale fixture reports only when scale.spec runs; a viewer change upgrades them instead of converting again` | 1–2 |

## Global Constraints

- Folder: `e2e/.reports-scale/` (reports `scale/`, `huge/`; generated inputs under `inputs/`). Not inside `e2e/.reports/`.
- Task names: `e2e:fixtures:scale:data`, `e2e:fixtures:scale`. Script: `e2e/build-scale-fixtures.ts`, run with `bun`.
- `e2e:fixtures:scale:data` sources: `@group:deps`, `dist/cli/**`, `dist/index.js`, `dist/index.d.ts`, `dist/receiver-*.js`, `e2e/build-scale-fixtures.ts`, `e2e/fixture.ts`, `test-support/scale-logs.ts`, `test-support/scale-metrics.ts`, `test-support/otlp-builders.ts`, `test-support/fixture-ids.ts`. **Not** `dist/viewer/**`. `depends = ["build"]`.
- `e2e:fixtures:scale` sources: `@group:deps`, `dist/viewer/**`; `depends = ["e2e:fixtures:scale:data"]`; runs `node dist/cli/main.js upgrade` on both reports.
- `.github/workflows/ci.yml` is not changed. CI's `e2e-metrics-scale` job (`pnpm exec playwright test e2e/scale.spec.ts --project chromium-perf-file --grep 'metrics scale' --workers=1`, no scale reports built) must keep passing.
- The missing-report message names `mise run e2e:fixtures:scale`.
- A changed task description is followed by `mise run --force gen` (`gen`'s sources do not include `mise.toml`); README's task section is never hand-edited; `gen:check` must pass.
- Before each commit: `pnpm exec biome check .` and `mise run typecheck`, by hand. Before the push: `mise run check`. Before the PR: `mise run verify`. Commit messages end with the session's `Co-Authored-By` and `Claude-Session` trailers.
- The PR body lists the measurements in Task 2 Step 6.

## Review Focus

1. **Tests selected by grep alone** (`mise run test:e2e:chromium -- -g "1M logs"`, no file argument): the scale reports must be built. Pinned in Task 2 Step 3.
2. **A viewer-only edit after the scale reports exist**: `scale`/`huge` must carry the new viewer (`assets/` matches `dist/viewer/assets/`), not the old one. This is a stale-fixture anti-goal. Pinned in Task 2 Step 4.
3. **A writer edit** (`src/writer/**`): `e2e:fixtures:scale:data` must convert again. Pinned in Task 2 Step 4.
4. **CI's metrics-scale job with no `e2e/.reports-scale/`**: it must pass without the missing-report check firing. Pinned in Task 1 Step 6.
5. **A Playwright argument that `--list` rejects, or a listing that fails**: `test:e2e` must not quietly skip the scale build. It builds the reports and lets the real pass report the argument error. Pinned in Task 2 Step 3.

---

### Task 1: Scale reports in their own folder and tasks; `test:e2e` builds them unconditionally

The tree stays green at the end of this task: `test:e2e` depends on `e2e:fixtures:scale` unconditionally. Task 2 makes that conditional.

**Files:**
- Create: `e2e/build-scale-fixtures.ts`
- Modify: `e2e/build-fixtures.ts` (remove `scaleInput`, `writeScaleLogFiles`, `writeScaleMetricsFile`, `buildScaleReports`, their imports and the call at the bottom)
- Modify: `e2e/fixture.ts` (`SCALE_REPORTS_DIR`, `reportDir`, the `ReportName` doc comment)
- Modify: `e2e/global-setup.ts` (`assertReportsBuilt` skips `scale` and `huge`; they stay mounted)
- Modify: `e2e/scale.spec.ts` (the missing-report check)
- Modify: `mise.toml` (two new tasks; `e2e:fixtures` description; `test:e2e` `depends`), `.gitignore`, `biome.json`
- Modify: `AGENTS.md:48` (name the second script)

**Interfaces:**
- Produces: `export const SCALE_REPORTS_DIR: URL` in `e2e/fixture.ts` = `new URL('./.reports-scale/', import.meta.url)`; `reportDir('scale' | 'huge')` returns `new URL('<name>/', SCALE_REPORTS_DIR)`.
- Produces: the mise tasks `e2e:fixtures:scale:data` and `e2e:fixtures:scale` (see Global Constraints).

- [ ] **Step 1: See the check fail first.** Add a top-level `test.beforeEach` to `e2e/scale.spec.ts` that, unless `testInfo.titlePath` contains a title starting with `metrics scale`, throws ``the scale fixture reports are missing: run `mise run e2e:fixtures:scale` (<name>)`` for the first of `scale`, `huge` whose `data/manifest.js` (under `reportDir(name)`) does not exist. Point `reportDir('scale' | 'huge')` at `SCALE_REPORTS_DIR` (fixture.ts) before anything builds there. Run `mise run e2e:fixtures && pnpm exec playwright test e2e/scale.spec.ts --project chromium-file -g "1M logs"`. Expected: FAIL with that message naming `scale`.

- [ ] **Step 2: Move the build.** Create `e2e/build-scale-fixtures.ts`: the moved scale functions, writing inputs to `inputs/` under `SCALE_REPORTS_DIR`. It removes `SCALE_REPORTS_DIR` first, then converts `scale` and `huge` in parallel exactly as `buildScaleReports` does today (same titles, same `OTEL_HTML_EAGER_BUDGET_BYTES` for `huge`). Give it its own `cli`/`convertTo` helpers; do not import from `build-fixtures.ts`, because that file runs its build at top level. Remove the moved code from `build-fixtures.ts`.

- [ ] **Step 3: The tasks.** Add `e2e:fixtures:scale:data` (`run = "bun e2e/build-scale-fixtures.ts"`, `outputs = ["e2e/.reports-scale/**"]`) and `e2e:fixtures:scale` (`run` = `upgrade` on `e2e/.reports-scale/scale` and `e2e/.reports-scale/huge`; outputs as mise needs to record freshness, e.g. `{ auto = true }`). Their sources and depends are in Global Constraints. Each description says what it builds, when it is skipped and what it costs (~14 s / ~0.3 s). The `e2e:fixtures` description says it no longer builds scale/huge. `test:e2e`: `depends = ["e2e:fixtures", "e2e:fixtures:scale"]`. Add `e2e/.reports-scale/` to `.gitignore` and `!e2e/.reports-scale` to `biome.json` next to `!e2e/.reports`. In `global-setup.ts`, `assertReportsBuilt` skips `scale` and `huge` and its doc comment says why. Run `mise run --force gen`.

- [ ] **Step 4: The check passes once built.** Run `mise run e2e:fixtures:scale`, then the Step 1 command. Expected: PASS.

- [ ] **Step 5: `e2e:fixtures` no longer builds them.** Run `rm -rf e2e/.reports e2e/.reports-scale && mise run e2e:fixtures`. Expected: `e2e/.reports/` holds no `scale/`, `huge/` or `scale-inputs/`, `e2e/.reports-scale/` does not exist, and the task takes ~1–2 s after `build` (record the time).

- [ ] **Step 6: CI's metrics-scale job, unchanged.** With `e2e/.reports-scale/` deleted, run `OTEL_HTML_METRICS_SCALE=1 pnpm exec playwright test e2e/scale.spec.ts --project chromium-perf-file --grep 'metrics scale' --workers=1`. Expected: PASS, with no missing-report error.

- [ ] **Step 7: Whole spec.** `mise run test:e2e:chromium -- e2e/scale.spec.ts`. Expected: PASS (it builds the scale reports through `depends`).

- [ ] **Step 8: Commit.** `pnpm exec biome check .`, `mise run typecheck`, `mise run check`, then commit `test(e2e): build the scale and huge fixture reports in their own mise tasks`.

### Task 2: `test:e2e` builds the scale reports only when the selection needs them

**Files:**
- Modify: `mise.toml` (`test:e2e`: `depends` back to `["e2e:fixtures"]`, the listing in `run`, the description)
- Modify: `AGENTS.md` (the development-loop line about `e2e:fixtures` if it now misleads)

**Interfaces:**
- Consumes: the two tasks from Task 1.

- [ ] **Step 1: The listing.** In `test:e2e`'s `run`, before the browser install, list once with all three projects and the user's arguments: `pnpm exec playwright test "$@" --project "${usage_browser}-file" --project "${usage_browser}-http" --project "${usage_browser}-perf-file" --list`. Do not add `--grep-invert @perf`: the union of the two passes is what counts. If the listing exits non-zero, or any listed line contains `scale.spec.ts`, run `mise run --skip-deps e2e:fixtures:scale:data` and then `mise run --skip-deps e2e:fixtures:scale`, and fail the task if either fails. Print one line saying whether the scale reports were needed. Change `depends` to `["e2e:fixtures"]`. Update the description: the scale reports are built only when the selection includes `scale.spec.ts`, and how to build them by hand. Run `mise run --force gen`.

- [ ] **Step 2: A spec that does not need them.** `rm -rf e2e/.reports-scale && mise run test:e2e:chromium -- e2e/smoke.spec.ts`. Expected: PASS; `e2e/.reports-scale/` still does not exist; the task printed that the scale reports were not needed.

- [ ] **Step 3: Selections that need them.** Each of these builds `e2e/.reports-scale/` and passes; delete the folder before each:
  - `mise run test:e2e:chromium -- e2e/scale.spec.ts`
  - `mise run test:e2e:chromium -- -g "1M logs"` (Review Focus 1)
  - `mise run test:e2e:chromium -- --no-such-flag`: the scale reports are built (Review Focus 5), and the task fails on Playwright's own argument error.

- [ ] **Step 4: Freshness.** With the reports built:
  - Add a harmless change to a file under `src/viewer/` that changes the bundle (a string constant). Run `mise run test:e2e:chromium -- e2e/scale.spec.ts`. Expected: mise skips `e2e:fixtures:scale:data` and runs `e2e:fixtures:scale`, and `ls e2e/.reports-scale/scale/assets` matches `ls dist/viewer/assets` (Review Focus 2).
  - Revert it and make a harmless change under `src/writer/` that changes `dist/cli/main.js`. Expected: `e2e:fixtures:scale:data` runs (Review Focus 3).
  - Revert it and run the command again. Expected: both tasks are skipped as up to date.

  Record which tasks ran in each case and how long each took. Revert the probes before committing.

- [ ] **Step 5: Interrupted build.** Start `mise run --force e2e:fixtures:scale:data` and kill it during the converts. Then run `mise run e2e:fixtures:scale`. Expected: `:data` runs again rather than counting as up to date. If it does not, make `build-scale-fixtures.ts` write into a temporary folder and rename it into place (the pattern in `e2e/metrics-scale.ts`), and say so in the PR body.

- [ ] **Step 6: Measurements for the PR body.** From a clean checkout state (`rm -rf e2e/.reports e2e/.reports-scale`), record the wall time of:
  1. `mise run e2e:fixtures` (no scale)
  2. `mise run e2e:fixtures:scale` cold
  3. the same after a viewer-only edit
  4. `mise run test:e2e:chromium -- e2e/smoke.spec.ts`, compared with the same on `main`

- [ ] **Step 7: Verify and commit.** `pnpm exec biome check .`, `mise run typecheck`, `mise run check`, `mise run verify` (the full Chromium suite lists `scale.spec.ts`, so the scale reports are built). Commit `test(e2e): test:e2e builds the scale reports only when the selected tests include scale.spec`.
