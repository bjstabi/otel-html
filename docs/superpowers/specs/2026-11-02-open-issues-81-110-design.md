# Open issues #81–#110: triage and design (2026-11-02)

Fifteen issues were open on 2026-11-02. This document records what each one still means now that #106 (nightly run
without the task cache) and the coverage job have landed, which ones are closed without code, the decisions the
maintainer took in the brainstorm, and the calls left to the builder. The process is **unattended**
(`docs/agents/process-unattended.md`): the plan written from this document is executed and merged without waiting for
the maintainer, except where this document says to stop.

## Intent

Clear the backlog in as few pull requests as is practical, each closing its issues whole, and fix on the way whatever
small thing the work turns up (listed under **Also** in the PR body). Nothing here is a new product direction; it is
the follow-up list of the CI dogfooding and dev-loop work, plus two viewer fixes and one viewer feature the CI
dashboard has been waiting for.

## Triage

| issue | disposition | where |
| --- | --- | --- |
| #83 `run` fails a passing step when the report cannot be finished | fix; **the default changes** (maintainer) | PR 1 |
| #87 toplist can only count | feature: a span `measure` on toplist and table widgets | PR 2 |
| #86 points at the range end; unknown `groupBy` | fix both | PR 2 |
| #84 render the frozen format-1/2 reports; checksum; zero-width delta interval | all three | PR 3 |
| #81 perfFactor guard; V8 flags test; broad-filter budget evidence | all three | PR 3 |
| #107 skip the jobs a docs-only change cannot affect | do | PR 4 |
| #109 mise tasks as spans in the CI report | do; smaller than written (spike below) | PR 4 |
| #96 Codecov | do; unblocked (`CODECOV_TOKEN` exists since 2026-11-02) | PR 4 |
| #98 README misstates ci-report's checkout rule | do | PR 4 |
| #102 what the task cache trusts | item 2 landed as #106; item 1: **accept and record** (maintainer) | PR 4 |
| #91 unpublished github-pages run has no job summary | do; pre-authorized to touch `otel-html-publish` (maintainer) | PR 4 |
| #110 stricter mise checks, bootstrap, `mise mcp` | checks and mcp: do; bootstrap: config and task only (maintainer); sandbox: **dropped** (builder, below) | PR 4 |
| #108 remote mise task cache if `actions/cache` evicts | **not applicable now**: close with the measurement | PR 4 body |
| #89 drop the actions-smoke capability gate after a release with `ci context` | do **only once release 0.2.0 exists** (the maintainer merges release-please PR #12) | PR 5 |
| #90 acceptance test from a second repository | **deferred** (maintainer): needs a repository under the owner's account; stays open, out of scope | — |

Measurements behind the "not applicable" and "smaller than written" rows:

- **#108.** The repository holds 138 Actions cache entries, 22 of them `mise-tasks-*`, 1.3 GB of the 10 GB limit. The
  six most recent `ci` runs on 2026-11-02 every one restored a `mise-tasks-*` key (`Cache restored from key:
  mise-tasks-Linux-<job>-<previous run>`); no `Cache not found` on a mise key. The trigger the issue names has not
  happened. It is closed with these numbers and the sentence "reopen when a `mise-tasks` key misses for a reason other
  than a fresh job name".
- **#109.** `otel-html run` already hands its child `OTEL_EXPORTER_OTLP_ENDPOINT` (`http://127.0.0.1:4318`, or the
  gRPC address), `OTEL_EXPORTER_OTLP_PROTOCOL` and a `TRACEPARENT` for `run`'s own root span
  (`src/run/child-env.ts`). A local spike (`MISE_OTEL_ENABLED=1 node dist/cli/main.js run -o … -- mise run --force
  lint`, mise 2026.10.25) produced a report with 7 spans and 1 log: mise exported over OTLP/HTTP to the receiver,
  flushed before exiting, and every mise span's parent is `run`'s root span. With OTel on and **no** endpoint set, a
  task costs nothing extra and prints nothing; with a dead endpoint it costs ≈ 1.7 s at exit and prints nothing. No
  change to `run` is needed, so nothing from #109 reaches the README's product section.

## Goals

- Every issue above except #90 is closed by a merged PR or, for #108, by the measurement.
- `otel-html run` under the CI job shell can no longer fail a step whose command passed.
- The CI dashboard gets its "Slowest steps" widget back, ranked by duration.
- A docs-only pull request's `ci` run finishes in about 40 s instead of ≈ 2 min.
- The repository's own checks get stricter where it is free: `mise tasks validate`, `mise fmt --check`, a checksum on
  the frozen fixtures, a loud failure when the perf factor is missing.

## Non-goals

- A second repository adopting the actions (#90). A remote task cache (#108). Pinning mise (#100 was closed
  "not planned": `min_version` stays the floor).
- A per-task sandbox for the unit tests (#110's last bullet). mise 2026.10.25 has sandboxing only as global settings
  (`sandbox.deny_net`) or as `mise run` / `mise exec` flags; a task cannot declare one, and `test:unit:main` also runs
  on Windows (`unit-os`), where the sandbox does not exist. Recorded in #110 when it closes; worth a new issue when mise
  gains a task-level `sandbox`.
- `otel.logs` from mise in CI: the publisher already turns each job's Actions log into log records on the step spans,
  so mise's own log records would be the same text twice. Spans only.
- Playwright coverage, Codecov PR comments or status checks (off at first, as #96 says).
- A `mise-action` `bootstrap: true` input: that edits `.github/actions/setup`, which `release.yml` uses.

## Anti-goals

- Loosening a `@perf` budget without evidence from CI's `PERF calibration:` lines (conventions).
- Merging a red or probe-less CI change: #107 and #109 are "done" only with the probe runs in the PR body.
- A dashboard config that validates today and fails tomorrow: `measure` is optional and defaults to the current
  behaviour (`count`), so every existing config keeps working.

## Constraints

- Process: `docs/agents/process-unattended.md` and `docs/agents/conventions.md`. Implementers and per-task reviewers on
  Sonnet 5.5, the whole-branch review on Opus 5.5 (CLAUDE.md); each review summary names its model.
- **Pre-authorized (maintainer, 2026-11-02):** the changes this document names that run under `ci-report`'s write
  token: the `otel-html-publish` action for #91, the dashboard config copy under `.github/actions/otel-html-publish/`
  for #87, and `src/cli/ci/metrics.ts` for #84. The coordinator stops for any write-token change this document does
  not name.
- Squash-merge; the PR title is the conventional commit. `Fixes #N` per issue; what was decided against, per issue;
  **Also** for the way-side fixes; the measurements each PR must carry are listed below.
- No new runtime dependency. One new CI action (`codecov/codecov-action`, pinned by SHA like every other action here).
- The README is the product documentation and changes in the same PR as the behaviour (#83, #87, #86.2, #98/#102).
  The README's Development section is generated from `mise.toml` task descriptions (`mise run gen`).
- Public API (`src/api/index.ts`) does not change. The report format does not change. The **config schema** changes
  once, additively (PR 2: `measure`), and `mise run gen` regenerates `schema/`.

## Pull requests

Order: 1 → 2 → 3 → 4 → 5, each branched from `main` after the previous one merged. They are independent in code; the
order puts the smallest product change first and the probe-heavy CI PR after the code PRs, which also gives release
0.2.0 time to ship before PR 5 asks whether it exists.

### PR 1 — `fix(cli)!: run exits with the command's exit code; a report failure is printed and never fails a passing command` (#83)

**Decided (maintainer): change the default, no flag.** Today `run` exits 1 when the command exited 0 but the report
could not be finished, and refuses to run the command at all when the receiver cannot bind or the report is locked.
After this PR:

- A failure to **start** the report (receiver bind, `report-locked`, a disk or config error while creating the
  report) prints the error with its hints to stderr, then runs the command anyway, with the environment it inherited
  (no `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` or `TRACEPARENT` added), and exits with the
  command's exit code. No report is kept.
- A failure to **finish** the report after the command ran prints the error and exits with the command's exit code,
  whatever it was.
- Usage errors stay usage errors (exit 2): an empty command, a malformed `--traceparent`, an unknown protocol, a
  disabled transport. They are the caller's mistake, not the report's.
- Signals keep their codes (130 during start-up or finishing; `128 + n` for the command).

The README paragraph on exit codes (line ≈ 93) is rewritten to this rule; the CI dogfooding spec §2's anti-goal now
holds and its "mitigation" note (removing the job-shell line) goes. Tests in `test/cli/run.test.ts` pin: exit 0 +
finish failure → 0 with the error on stderr; a taken port → the command runs, exit 0, stderr names the port and the
`--http`/`--no-http` hint; a lock held by a live pid → the command runs; the existing "non-zero exit is kept when the
report fails" case stays. Breaking: `!` in the title; the PR body says why (the CI job shell's anti-goal) and names
the old behaviour.

Decided against: an opt-in `--report-failure warn|fail` flag (two contracts to document for one caller), and amending
the spec instead of the code.

### PR 2 — `feat(dashboards): toplist and table widgets rank spans by a duration measure; the timeline counts points at the range end; an unknown groupBy names the report's facets` (#87, #86)

**#87, `measure`.** Toplist and table widgets gain an optional `measure`, a string enum, default `count`:
`count | duration.sum | duration.avg | duration.max | duration.p95 | duration.p99`. Any value but `count` is valid
for `signal: spans` only; the schema's `superRefine` rejects it for logs with a message naming the widget. The groups
are the `groupBy` facet values as today; the measure is computed over the spans the widget's query matches in the
window, per group, from `durationNs`, capped at the same number of groups the count path keeps. The toplist's x axis
is a duration (the viewer's existing duration formatter; `minInterval: 1` only for `count`); the table shows a
column named after the measure instead of Count, and keeps Share only for `count` and `duration.sum` (a share of a
max or a percentile means nothing). The percentiles come from the rollups' `ExpHistogram` where one exists per group,
else from the row scan; the builder picks and says so in the PR body. "Copy as dashboard widget" is unchanged
(`count`). The CI dashboard (`.github/otel-html-ci.yaml` and its identical copy under
`.github/actions/otel-html-publish/`, which a test compares) gets its "Slowest steps" widget back, `measure:
duration.max` over the publisher's step spans, next to the existing count widget; spec §6.10 of the CI dogfooding
design is updated to say the first form exists. README documents `measure` in the dashboards section; `mise run gen`
regenerates `schema/otel-html.schema.json`.

**#86.1, the range end.** `pointsWithin` in `src/viewer/dashboards/widgets/timeline.tsx` drops a bucket that starts
exactly at the window's end (`t >= w.end`); the window is inclusive at both ends everywhere else (spans, logs, metric
runs). The comparison becomes `t > w.end`, and `alignLanes` in `fusion-timeline.tsx` gets a column for that bucket
(today `columns = ceil((end − floor(start/w)·w) / w)` leaves the bucket at an aligned `end` with no column, for every
lane). Unit tests pin a metric point stamped at `range.end` in the lane total and in the drawn columns; a spans and a
logs bucket at the end are drawn too.

**#86.2, `groupBy`.** Static validation cannot know a report's attribute keys, so the check runs in the viewer: when
`facets.total(groupBy)` is 0 **and** `groupBy` is not among the report's facet keys (`landing().facets.keys()` plus
the resource keys), the widget says so instead of "No `name` values in this window": "`name` is not a facet of this
report" followed by up to three known keys that end with or contain the typed key (so `name` suggests `span.name`,
`service.name`). When the key is a facet but has no values in the window, today's message stays. A unit test in
`test/viewer/dashboard-facets.test.tsx` covers both. Decided against: validating `groupBy` against the fixed
`DEFAULT_*_FACETS` lists in the schema (attribute keys are valid and unknowable there).

### PR 3 — `test: render the frozen format-1 and format-2 reports in a browser; checksum the fixtures; a loud perfFactor; the V8 flags decision under test` (#84, #81)

**#84.** `e2e/build-fixtures.ts` copies each `fixtures/reports/format-N/data/` into `e2e/.reports/frozen-format-N/`
and puts the current viewer next to it with the existing `upgrade` path (`upgradeReport` rewrites `index.html` and
`assets/`, leaves `data/` alone, and reads formats 1–3; it needs only `data/manifest.js`). `e2e/frozen.spec.ts` opens each one and checks the overview totals, one
trace's flame graph and one metric chart render with no console errors; its first test carries the `HTTP` tag so the
pair is also served over http. `fixtures/reports/SHA256SUMS` lists every file under `format-*/data/`, and
`test/format/frozen-checksums.test.ts` recomputes and compares, with a failure message that says the fixtures are
byte-for-byte and how to regenerate the list on purpose. The publisher's `cicd.pipeline.run.errors` delta points
(`src/cli/ci/metrics.ts`) get the run's interval (`run_started_at` → `updated_at`) instead of start == time; the test
at `test/cli/ci/metrics.test.ts` adjusts. The frozen fixtures' README "Not covered" paragraph is updated.

**#81.** (a) A helper, `test-support/perf-inject.ts` or a function in `perf-factor.ts`, reads `inject('perfFactor')`
and throws unless it is a finite number ≥ 1, with a message naming `test-support/perf-global-setup.ts`; the seven
call sites in six files use it; a unit test covers the guard with good and bad values. (b) The decision in
`src/cli/main.ts` ("`serve` or `run`, under Node, not Bun → `--optimize-for-size --heap-growing-percent=40`") moves
to a pure function (`v8FlagsFor(argv, versions)` or similar) that `main.ts` applies, with unit tests for each branch.
The builder records in the PR body that the flags' *effect* is not observable from outside the process without a
debug switch, so this is the test #81 gets; adding a debug switch to the CLI for a test was decided against. (c) The
builder pulls the `PERF calibration:` line and the broad-filter test's outcome from the last ten `check` and `unit-os`
job logs on `main` (`gh run view --log`), puts the table in the PR body, and either leaves the 150 ms budget (no
failure since #80) or, with a failure in that sample, raises it to the measured need and says so. No change without
the table.

### PR 4 — `ci: skip the jobs a docs-only change cannot affect; mise task spans in the CI report; Codecov; stricter mise checks; the publisher's summary when nothing was published` (#107, #109, #96, #98, #102, #91, #110, closes #108)

**#107.** A `changes` job (ubuntu, no setup, no build) lists the files the event changed and outputs
`docs_only=true` when every one is under `docs/**` or ends in `.md`. Pull requests compare the base SHA to the head;
pushes to `main` compare `github.event.before` to `github.sha`; `schedule` and `workflow_dispatch` never set it;
any error in the comparison (a force-push whose `before` is gone, an API failure) sets `false`, so the failure mode
is running everything. `git diff --name-only` over a shallow fetch of the two commits is the first choice; the compare
API is the fallback; no third-party action. `unit-os`, `e2e`, `e2e-metrics-scale`, `binary` and `coverage` take
`needs: changes` and `if: needs.changes.outputs.docs_only != 'true'`; `check` and `build` always run (`check` lints
`AGENTS.md`/`CLAUDE.md` and `gen:check` compares the README). The builder greps `e2e/` and `test/` for `.md` reads
first and names the result in the body. **Probes:** PR 4's own diff always holds `ci.yml`, so its runs can never be
docs-only. The two `pull_request` probes come from a throwaway pull request whose *base* is PR 4's branch (it runs
the branch's `ci.yml`, and its diff is only its own commits): first a docs-only commit, then one touching a non-docs
file. That PR is closed without merging once both runs are linked (its `pr/<n>/` site page is removed by the cleanup
job). The `push` path cannot be probed before the merge; the first docs-only push to `main` afterwards confirms it,
and the final summary says whether one has happened. Done when the body links the docs-only run that skipped those
jobs in about 40 s and the mixed run that ran everything, and says how `ci-report` rendered the skipped jobs.

**#109.** `MISE_OTEL_ENABLED: "1"` in the workflow-level `env` of `ci.yml` and `load.yml`. Steps outside the job
shell (`mise run build`, which runs before `dist/` exists) have no endpoint and are unaffected (spike above); steps
under the job shell inherit `run`'s endpoint and `TRACEPARENT`, and mise honours `OTEL_SERVICE_NAME` and
`OTEL_RESOURCE_ATTRIBUTES` from `ci context` (a second spike with both set: every mise span carried
`service.name=ci/check` and `cicd.pipeline.task.name` as resource attributes), so the spans select under the
dashboard's `job` variable like the step's own. Done when the body links a run of this branch whose published report
shows `mise run` task spans (`lint`, `typecheck`, …) under the step's `run` root span with their exit codes, visible
with that job selected, and names which tasks replayed from the cache. If the Windows `unit-os` job misbehaves with the variable set
(the spike was Linux only), that job unsets it and the body says so.

**#96.** Two `codecov/codecov-action` (v5, pinned by SHA) steps in the `coverage` job after the artifact upload, one
per folder (`coverage/unit-node/lcov.info` with `flags: unit-node`, `coverage/unit-viewer/lcov.info` with `flags:
unit-viewer`), `token: ${{ secrets.CODECOV_TOKEN }}`, `fail_ci_if_error: true` (the job runs on `main` pushes only and
gates nothing, so a failed upload may as well be visible). A root `codecov.yml` turns the PR comment and the project
and patch status checks off. The job's `if:` also admits `workflow_dispatch`, so the upload is proven from the branch
with `gh workflow run ci --ref <branch>` before the PR merges; the body links that run and Codecov's page for the
commit. The Codecov repository page shows the project as inactive until the first upload; nothing else to set up.

**#98 and #102.** The README's CI paragraph (line ≈ 354) states the actual rule: `ci-report` runs the default branch's
copy of the workflow, and builds the report with the triggering commit's own code when that commit is in this
repository and a person started the run; forks, bots and dispatches use the default branch's code. The same paragraph
records #102's accepted risk: such a run executes under `main`'s cache scope and could write a `mise-tasks-*` entry
that later runs replay as a pass. Only people with write access can do that; `main`'s ruleset requires a pull request
with an approving review and requires no status check, so a forged pass can make a later run look green but cannot
merge anything a reviewer would not see. Accepted (maintainer, 2026-11-02). #102's second item is answered by #106
(the nightly run with the cache off); the body says so.

**#91.** In `otel-html-publish/action.yml`, when `target` is `github-pages` the `ci report` step keeps its summary
table in a scratch file instead of passing `--no-summary` (`GITHUB_STEP_SUMMARY` pointed at `$RUNNER_TEMP/...` for
that step only), and a new step after the site push appends that file to the job's real summary when
`steps.site.outputs.published != 'true'` (a run with no channel, or a push that gave up). `ci link` still writes the
linked table on a published run. `actionlint` and `shellcheck` cover the YAML and the shell; the body says whether a
dispatch of `ci-report` on a run without a channel could be used as a probe, and if not, why not.

**#110.** `[tasks.lint].run` gains `mise tasks validate` and `mise fmt --check`; `mise fmt` is run once (the
reformat of `mise.toml`, ≈ 200 lines, is its own commit so the review can skip it; comments survive, the builder
diffs to confirm). `mise.toml` gains a `[bootstrap]` section (`packages` keyed `apt:<pkg>`: Docker for
`test:load:receiver` and Playwright's Ubuntu 24.04 libraries from `pnpm exec playwright install-deps --dry-run`, with
`os` filters so other platforms are untouched) and a `[tasks.bootstrap]` that runs `mise run setup` and `pnpm exec
playwright install`; `mise bootstrap status --missing` is the doctor and AGENTS.md's setup line says so. The body
carries the output of `mise bootstrap --dry-run` (or `plan`) on the builder's machine. A root `.mcp.json` registers
`mise mcp` for Claude Code, and AGENTS.md says agents that can use MCP get the tasks and their effect metadata from
it. Dropped from #110, with the reasons in the body: the task sandbox (non-goal above) and `bootstrap: true` on
`mise-action`. Risk accepted knowingly: mise is unpinned (#100), so a `mise fmt` format change in a release turns PRs
red until `mise fmt` is re-run, the same class of event as `gen:check` on `mise generate task-docs`.

**#108.** `Closes #108` in the body with the measurement above.

### PR 5 — `ci(actions-smoke): run the job shell on every leg now that the release has run and ci context` (#89)

Only if `gh release list` shows `otel-html-v0.2.0` or later when PR 4 has merged: remove the `cap` step and its
`if:`s from `.github/workflows/actions-smoke.yml`, run the workflow (`gh workflow run actions-smoke --ref <branch>`),
confirm the three legs write `.otel-html/context.json` and the report with no setup warning, and link the run in the
body. If the release does not exist yet, the coordinator leaves #89 open, says so in the final summary and does not
wait for it.

## What is left to the builder

- Per-group duration aggregation for `measure` (histogram per group in the query rollups, or a row scan), the group
  cap, and the exact duration formatting on the axis and in the table.
- The suggestion rule for an unknown `groupBy` (suffix match first, then substring; at most three).
- The `changes` job's exact git commands and its fallback; the Codecov action's current v5 SHA; the Playwright apt
  package list and its `os` filter syntax; the `.mcp.json` shape Claude Code reads.
- Everything else the conventions already settle (TDD per task, what runs before a commit, the PR body).

## Stop and ask

Beyond the unattended process's own list: PR 5 is the only conditional, and it does not block. If #107's probe shows
`ci-report` failing (not merely sparser) on skipped jobs, or if mise's spans in #109 do not appear in a real CI run
although the spike showed them locally, the builder stops and reports with the run links rather than working around
it.
