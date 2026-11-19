# CI dashboard filters, durations and GitHub link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the CI dashboard the `main` and `pull requests` pills exclude each other and a pressed pill can be released (#359); every CI duration reads in the unit it needs, `4 min 12 s` and `1 h 5 min`, on round axis steps (#360); "Open on GitHub ↗" reaches the run's page without reading its whole trace (#361).

**Architecture:** Three independent viewer fixes in one PR. (1) `FilterBar` treats a click on a pressed pill as a release, and the CI configs give `main` and `pull requests` the `null` that clears the other's variable. (2) `durationText` in `src/viewer/cicd/format.ts` learns minutes and hours, a `durationAxis` helper built on the run charts' `niceAxis` gives the three ECharts y axes their `max` and `interval`, and the stat tiles and the Gantt use `durationText`. (3) The run actions read the report's repository url once per page with the existing `resourceValues` query (warmed when a run menu opens), build `<repository>/actions/runs/<run id>` and open it inside the click; the trace read of today stays as the fallback.

**Tech Stack:** TypeScript (strict), React, ECharts, vitest, Playwright, mise.

**Spec:** issues #359, #360 and #361 (the diagnosis is in each). PR process: **unattended** (`docs/agents/process-unattended.md`). The maintainer asked for the three fixes in the session ("Use unattended process").

## Global Constraints

- One PR, branch `fix/ci-dashboard-filters-durations-github-link`, title `fix(viewer): releasable quick filters, CI durations in minutes and hours, faster Open on GitHub`.
- No new dependency. Report format, public API and CLI flags unchanged. No new `DataSource` method (the query catalogue stays as it is).
- `.github/actions/otel-html-publish/otel-html-ci.yaml` changes only in its `quick:` block, the same edit as `.github/otel-html-ci.yaml`; it is a dashboard config the action ships, not a step of the action (ruling recorded in the PR body).
- The README is the product documentation: each behaviour change updates it in the task that makes it.
- Conventions (`docs/agents/conventions.md`): TDD per task; `pnpm exec biome check .` and `mise run typecheck` before each commit; `mise run check` after an edit; `mise run verify` before the PR. Commit trailers as the session supplies them.
- Never wait on a command with a `pgrep -f` loop; run long commands in the foreground with a timeout.

## Review Focus

- A click on a pressed pill clears exactly the variables its `set` names, nothing else (Task 1, filter-bar test).
- Pressing `main` after `pull requests` on the CI configs leaves the trigger unset and `main` alone pressed (Task 1, e2e on the CI report).
- `durationText(1_840e9)` is `30 min 40 s`, `durationText(3_900e9)` is `1 h 5 min`, `durationText(59.6e9)` is `59.6 s`, and seconds that round to 60 carry into the minute (Task 2, format test).
- The y axis of Runs, the job trend and Runs over time has `interval` on a 1-2-5-10-15-30 s/min or 1-2 h step and a `max` on that step at or above the data (Task 2, views tests).
- "Open on GitHub ↗" with a known repository opens `<repository>/actions/runs/<run id>` in the click, with no blank tab and no `getTrace`; with no unique repository the blank-tab path and `getTrace` run as today (Task 3, run-actions test).
- Opening a run menu starts the repository read once per page; a second menu does not read again (Task 3, run-actions test).

---

### Task 1: A pressed pill releases, and the CI pills exclude each other (#359)

**Files:**
- Modify: `src/viewer/dashboards/filter-bar.tsx` (the quick pill `onClick`, ~line 196)
- Modify: `.github/otel-html-ci.yaml`, `.github/actions/otel-html-publish/otel-html-ci.yaml`, `fixtures/dashboards.otel-html.yaml` (the CI dashboard's `quick:` block in each)
- Modify: `README.md` (the **Quick filters** bullet, ~line 298; the CI dashboard paragraph, ~line 416)
- Test: `test/viewer/filter-bar.test.tsx`, `e2e/dashboards.spec.ts` (the Checkout quick filter test), `e2e/ci-dashboard.spec.ts`

**Behaviour:**
- A click on a pill that is not pressed applies its `set` (today's behaviour).
- A click on a pressed pill (`aria-pressed=true`) sets every key of its `set` to `null` through `withVariable`, so a null equal to the default is no override. A pressed `all` pill (every key already null) is therefore a no-op.
- The three CI configs: `main` gets `cicd.pipeline.trigger: null` beside `vcs.ref.head.name: main`; `pull requests` gets `vcs.ref.head.name: null` beside `cicd.pipeline.trigger: pull_request`; `all` is unchanged.
- README, Quick filters bullet: add "Pressing a pressed pill clears the variables its `set` names." README, CI dashboard paragraph: the quick filters are `main` (branch `main`, no trigger), `pull requests` (trigger `pull_request`, no branch) and `all` (which clears both).

**Steps:**
- [ ] Unit test (`test/viewer/filter-bar.test.tsx`): "pressing a pressed pill clears its variables": start with `vars: { [REF]: 'dev' }`, press `pull requests` (vars become `{ [REF]: 'dev', [TRIGGER]: 'pull_request' }` with this test file's dashboard, whose `pull requests` sets only the trigger), press it again, expect `currentD()?.vars` to equal `{ [REF]: 'dev' }` and the pill `aria-pressed=false`. Run it, see it fail.
- [ ] Implement the release in `filter-bar.tsx`; run the test, see it pass.
- [ ] Edit the three yaml files. Run `pnpm exec vitest run test/cli/ci test/dashboards` (the config tests) and fix any expectation that encodes the old `set`s.
- [ ] e2e, `e2e/dashboards.spec.ts`, the Checkout quick filter test: after the × clears the chip, press Production again and then press it once more; expect `aria-pressed` false and the chip back to `+ environment`.
- [ ] e2e, `e2e/ci-dashboard.spec.ts`, a new test "main and pull requests exclude each other and release": open the CI report, press `pull requests`, then `main`; expect `main` pressed, `pull requests` not pressed, the `trigger` combobox reading `+ trigger` and the `branch` one `branch = main`; press `main` again; expect it released and `branch` reading `+ branch`. Run `mise run test:e2e:chromium -- e2e/dashboards.spec.ts e2e/ci-dashboard.spec.ts`.
- [ ] README. `pnpm exec biome check .`, `mise run typecheck`, `mise run check`. Commit `fix(viewer): a pressed quick filter releases, and the CI pills exclude each other`.

---

### Task 2: Durations in minutes and hours, on round axis steps (#360)

**Files:**
- Modify: `src/viewer/cicd/format.ts` (`durationText`; new `durationAxis`)
- Modify: `src/viewer/cicd/derive.ts` (`stat`'s `median-run` and `queue-p95` text, ~line 167)
- Modify: `src/viewer/cicd/run-gantt.tsx` (two `formatDuration` calls, ~lines 104 and 392)
- Modify: `src/viewer/cicd/views/runs.tsx` (`yAxis`, ~line 48), `src/viewer/cicd/views/jobs.tsx` (`yAxis`, ~line 155), `src/viewer/cicd/views/runs-trend.tsx` (`yAxis[0]`, ~line 91)
- Modify: `README.md` (the `cicd` widget section, near the views table ~line 380-400)
- Test: `test/viewer/cicd/format.test.ts`, `test/viewer/cicd/derive.test.ts`, `test/viewer/cicd/views-runs.test.tsx`, `test/viewer/cicd/views-jobs.test.tsx`, `test/viewer/cicd/run-gantt.test.tsx`

**Interfaces:**
- `durationText(ns: number): string`: `0` → `0 s`; negative → `-` + the text of the magnitude; under 60 s → `formatDuration(ns)` as today (`312 ms`, `1.5 s`, `59.6 s`); from 60 s to under 1 h → `<m> min` with ` <s> s` appended when the rounded seconds are not 0 (`4 min 12 s`, `5 min`); from 1 h → `<h> h` with ` <m> min` appended when the rounded minutes are not 0 (`1 h 5 min`, `2 h`); seconds that round to 60 carry into the minute (`4 min 59.7 s` → `5 min`), minutes that round to 60 into the hour. Whole numbers, no decimals past a minute.
- `durationAxis(maxNs: number, maxTicks = 5): { max: number; interval: number }`: the y axis for durations in ns, from `niceAxis(maxNs / 1e9, 's', maxTicks)` of `src/viewer/components/run-chart-format.ts` with both values scaled back by 1e9 (so the steps are 1, 2, 5, 10, 15, 30 s, 1, 2, 5, 15, 30 min, 1, 2 h, doubling after); `maxNs <= 0` gives `{ max: 1e9, interval: 1e9 }`, what `niceAxis` gives for a non-positive max (one unit). Ticks are then `durationText(0)`, `durationText(interval)`, …: `0 s`, `5 min`, `10 min`.

**Behaviour:**
- The three y axes set `max` and `interval` from `durationAxis` over their data: Runs over the runs' durations (replacing `max: maxDuration * 1.08`), the job trend over its points' durations, Runs over time over every non-null p50 and p95. The `axisLabel.formatter` stays `durationText`.
- `stat`: `median-run` and `queue-p95` values go through `durationText` (the derive tests expecting `60 s` become `1 min`; `11.4 s` stays).
- The Gantt's run summary and bar titles use `durationText`.
- README: one sentence in the `cicd` widget section: durations read in the unit they need (`312 ms`, `1.5 s`, `4 min 12 s`, `1 h 5 min`), and the duration axes step by 1, 2, 5, 10, 15 or 30 seconds or minutes, or 1 or 2 hours.

**Steps:**
- [ ] Format tests first (`test/viewer/cicd/format.test.ts`): the `durationText` cases of the interface above, including the carries, and `durationAxis`: `durationAxis(1_840e9)` → `{ max: 2_700e9, interval: 900e9 }` (`stepDuration` takes the first step of its list that covers 1840 s in at most 5 ticks: 300 s needs 7, 900 s needs 3, so 15 min, and the max is 3 × 15 min), `durationAxis(0)` → `{ max: 1e9, interval: 1e9 }`, `durationAxis(7_300e9)` → `{ max: 9_000e9, interval: 1_800e9 }` (30 min, 5 ticks). Run, see them fail.
- [ ] Implement `durationText` and `durationAxis` in `format.ts`; run the format tests, see them pass.
- [ ] Derive and Gantt: update `test/viewer/cicd/derive.test.ts` expectations (`'60 s'` → `'1 min'`) first, see them fail, switch `derive.ts` and `run-gantt.tsx` to `durationText`, see them pass; run `test/viewer/cicd/run-gantt.test.tsx` too.
- [ ] Views: in `views-runs.test.tsx` (the Runs widget and the Runs over time widget) and `views-jobs.test.tsx`, assert the y axis option has `interval` and `max` that are multiples of the step and `max >= interval` and the max of the data, then set them from `durationAxis`; see the tests pass. Keep the existing `formatter(0)` → `0 s` assertion.
- [ ] README. `pnpm exec biome check .`, `mise run typecheck`, `mise run check`. `mise run test:e2e:chromium -- e2e/ci-dashboard.spec.ts`. Commit `fix(viewer): CI durations read in minutes and hours on round axis steps`.

---

### Task 3: Open on GitHub from the repository url (#361)

**Files:**
- Modify: `src/viewer/cicd/run-actions.tsx` (`RunActionsProvider`, `Shared`, `openOnGithub`, `runMenu`)
- Modify: `src/viewer/dashboards/dashboard-page.tsx` (the `RunActionsProvider` mount, ~line 548: pass the page window)
- Modify: `README.md` (the **Interaction** paragraph of the `cicd` section, ~line 403)
- Test: `test/viewer/cicd/run-actions.test.tsx`, `e2e/ci-dashboard.spec.ts`

**Interfaces:**
- `RunActionsProvider` takes `window: TimeWindow | null` (the page window `dashboard-page.tsx` already holds as `page`, from `useSelection((s) => s.window)`; confirm the provider is mounted where that value is in scope).
- Repository lookup, in the provider's shared context: `repository(): Promise<string | null>`, created on the first call and cached for the page's life (a ref; the window at the time of the first call is used; the repository of a report does not change with the window). It calls `dataSource.resourceValues('vcs.repository.url.full', { window })` and resolves to the single value when `values.length === 1` and it matches `/^https?:\/\//`, else `null`; a rejection resolves to `null` too (and is not retried). The settled value is also kept synchronously (`repositoryValue: string | null | undefined`, undefined until settled).
- The run url of a run: `${repository}/actions/runs/${run.runId}` when `run.runId` is all digits (`/^\d+$/`; `CiRun.runId` falls back to the trace id when the run has no `cicd.pipeline.run.id`); otherwise the url comes from the trace as today.

**Behaviour:**
- `runMenu` calls `repository()` when it opens (fire and forget), so the value is usually known by the time an item is clicked.
- `openOnGithub(run)`: when `repositoryValue` is a string and the run id is numeric, `window.open(url, '_blank', 'noopener')` synchronously inside the click, no blank tab, no `getTrace`. Otherwise today's path: open the blank tab inside the click, then `await repository()`; with a repository and a numeric run id go to the derived url, else read the trace as today (`runUrl`), with the same refusal of non-http(s) urls and the same notice.
- The Failures view's ↗ and the run menu item share `openOnGithub`, so both benefit.
- README, Interaction paragraph: "Open on GitHub" builds the run's url from the report's repository url (`vcs.repository.url.full`, read once per page) and the run id, and reads it from the run's trace when the report holds several repositories or the run has no id.

**Steps:**
- [ ] Unit tests first (`test/viewer/cicd/run-actions.test.tsx`; the fake data source gains a `resourceValues` `vi.fn`): (a) opening a run menu calls `resourceValues('vcs.repository.url.full', { window })` once, and a second menu does not call it again; (b) with the repository settled to `https://github.com/o/r`, "Open on GitHub" opens `https://github.com/o/r/actions/runs/<runId>` with `('_blank', 'noopener')` in the click and never calls `getTrace`; (c) with the repository still pending, the blank tab opens in the click and goes to the derived url once the repository resolves; (d) with two values (or a rejection) the existing `getTrace` path runs and the existing tests still pass; (e) a run whose `runId` is not numeric uses `getTrace` even with a repository. Run, see them fail.
- [ ] Implement; run the file, see it pass. Keep every existing test of the file green (they model the fallback; give their fake a `resourceValues` that resolves to two values or rejects).
- [ ] e2e (`e2e/ci-dashboard.spec.ts`), "Open on GitHub goes to the run's page": `await page.context().route('https://github.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }))`; open the CI report; right-click a run mark (a status-grid cell or a Runs bar; see the existing menu tests in the spec for how); click "Open on GitHub ↗"; `const popup = await page.waitForEvent('popup')`; `await popup.waitForURL(/^https:\/\/github\.com\/example\/otel-html\/actions\/runs\/\d+$/)` (the fixture's repository is `https://github.com/example/otel-html`). Run `mise run test:e2e:chromium -- e2e/ci-dashboard.spec.ts`.
- [ ] README. `pnpm exec biome check .`, `mise run typecheck`, `mise run check`. Commit `fix(viewer): Open on GitHub builds the run url from the repository, read once per page`.

---

## PR

| branch | title | body |
| --- | --- | --- |
| `fix/ci-dashboard-filters-durations-github-link` | `fix(viewer): releasable quick filters, CI durations in minutes and hours, faster Open on GitHub` | `Fixes #359`, `Fixes #360`, `Fixes #361`, one line each; per issue what changed and what was decided against (a viewer-level exclusive pill group; a new `DataSource` method and catalogue entry for the root span's resource; a url column in the `cicd` table); the ruling on the action's config file; **Also** for anything fixed on the way |

Before the PR: `mise run verify`. After the merge: the live CI dashboard (the next deploy) shows `main`/`pull requests` excluding each other, durations in minutes, and an "Open on GitHub" that opens in the click.
