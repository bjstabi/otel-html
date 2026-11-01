# Development loop and CI: assessment and plan (2026-11-01)

The CI run takes ~9 minutes, ~6 of them e2e, and the e2e jobs wait ~3 minutes for jobs whose results they do not use.
Locally, a one-spec e2e run costs 34 s of which the spec itself is under a second. Agents respond by pushing and
waiting for CI instead of testing locally, and bugs that a 30-second local check would catch surface a run later.
This document records what was measured, where the time goes, what mise offers for it, and the changes proposed.
Decisions the user has made are marked **decided**; nothing here has been built.

## What was measured

### CI (ubuntu-latest, 4 cores, AMD EPYC 7763), runs #93–#95 on main

| job | wall time | what it spends it on |
|---|---|---|
| `check` | 105–143 s | `mise run check` 114 s: unit main **102 s** (lint 6.5 s, knip 7.5 s, tsc 14.5 s run alongside and finish early), then unit perf 9.5 s. Setup 12 s, build 3 s. |
| `build` | 20–30 s | setup 13 s, build 3 s, `check:package` 2 s, upload 2 s. Exists to run publint/attw and to hand `dist/` to e2e. |
| `unit-os` (windows) | 142–185 s | the unit suite again; off the critical path. |
| `e2e (chromium)` | 298–307 s | container pull **26–34 s**, setup 10 s, **global setup 40 s, twice** (once per pass), main pass 138 tests on **2 workers** 2.8 min, perf pass 13 tests on 1 worker 1.3 min. |
| `e2e (firefox)` | 350–422 s | same shape, slower browser. |
| `e2e (webkit)` | 356–425 s | same shape, slowest; the run's last job. |
| `e2e-metrics-scale` | 102–132 s | container 32 s, test 49 s. |
| `binary` ×2 | 20–30 s | — |

Critical path: `check` (2.3 min) → `build` (0.5 min) → `e2e (webkit)` (6–7 min) ≈ **9–10 min**. The e2e jobs only need
`dist/`, which takes 3 s to build; they wait on `check` and `build` for nothing but ordering.

Vitest on CI reports `tests 42%, environment 28%, import 21%`: a quarter of the unit time is booting jsdom for the 88
viewer test files, and a fifth is module import. The same suite takes 13 s on a 20-core machine; it is CPU-bound.

### Local (20 cores)

| command | time |
|---|---|
| `mise run lint` / `typecheck` / `knip` / `gen:check` | 0 s / 2 s / 1 s / 1 s |
| `mise run build` | 1 s |
| `mise run test:unit:main` / `test:unit:perf` | 13 s / 4 s |
| **`mise run check`** | **≈ 20 s** |
| `pnpm exec vitest run --changed HEAD~2` (3 files changed) | 22 files, 360 tests, **3.4 s** |
| `mise run test:e2e:chromium` (full) | **81 s**: main 138 tests on 10 workers 46 s, perf 13 tests 33 s; each pass rebuilds 613 MB of fixture reports in global setup (~16 s each) |
| `mise run test:e2e:chromium -- e2e/smoke.spec.ts` | **34 s** for 4 tests that run in < 1 s: two global setups (2 × 16 s) plus build |
| `mise run test:e2e` (three browsers) | not timed; several minutes |

The fast gate is already fast. The expensive loop is e2e, and nearly all of its cost is fixed overhead that does not
depend on what changed: the fixture reports are rebuilt from scratch on every invocation, twice, and every spec runs
under both the `file` and the `http` project although only 3 of 17 specs look at the URL kind.

### History

- Merged PRs carry 1–50 commits (median ≈ 5; #50, #82, #88, #93 had 26, 33, 50, 20). Each push restarts a 9-minute run;
  `cancel-in-progress` cancelled the previous one. 18 of the last 39 PR runs were not green, all but one of them cancelled
  by a newer push. The first green signal on a PR arrives ≥ 9 minutes after its last push.
- No e2e failure in the last 50 runs was a real failure (one `check` failure). The e2e matrix has been catching
  little at the PR stage recently while costing most of the wall time; the viewer bugs reported as "missed" were
  missed locally, before the push.
- Several merged commits touch only `README.md`/`docs/` and still ran the full matrix.

## Where the time goes, in one list

1. e2e waits ~3 min for `check` + `build`, whose output it does not use beyond a 3-second build.
2. e2e global setup runs twice per job (main and `@perf` pass): ~80 s on CI, ~32 s locally, per browser.
3. Every spec runs twice (`file` and `http`): 142 tests of which 71 are distinct.
4. 2 Playwright workers on a 4-core runner, and no `fullyParallel`, so `run-chart.spec.ts` (25 tests) runs serially
   in one worker per project.
5. Container image pull: 26–34 s per e2e job, four jobs.
6. Unit tests: 102 s on CI, dominated by jsdom boot and imports; only matters while e2e waits on it.
7. Locally, nothing tells an agent which 20-second command to run; the README lists `test:e2e` (three browsers) as the
   e2e task and `test:e2e:chromium` under "Other tasks". No task declares `sources`, so mise cannot skip anything.

## What mise offers (researched 2026-11-01, mise 2026.10.25)

Sources: `mise run --help` and `mise settings` on the installed version, the release notes (v2026.7.15 → v2026.10.25),
the workspace-graph, hooks, watch, bootstrap and git-pre-commit docs pages, and two experiments in a scratch repo.

**Task freshness (`sources` / `outputs`), stable.** A task with `sources` and `outputs` is skipped while its newest
source is older than its newest output *and* the recorded source set (paths, sizes, mtimes) is unchanged; editing
`mise.toml` counts as a source change; `--force` overrides. If a dependency with `sources` ran, its dependents run
too. `outputs = { auto = true }` is the default; `outputs = []` declares "no files". **Experiment:** a `build` task
with outputs ran once, then printed `sources up-to-date, skipping`. A `lint` task with `outputs = []` and no cache
ran every time: result-only skipping needs the artifact cache below. `task.source_freshness_hash_contents = true`
compares content hashes instead of mtimes, which CI needs after a checkout or cache restore resets timestamps.

**Artifact cache (`cache = { enabled = true }`), experimental.** Keyed on source contents, the task definition and
args, allow-listed env (`cache.env`), `command_inputs` (e.g. `node --version`), dependency artifact keys, resolved
tool versions and platform. Restores declared outputs and replays stdout/stderr on a hit. `outputs = []` gives
result-only caching for lint/typecheck/test. Controls: `--task-cache read-write|read-only|write-only|off|local-only`,
`--task-cache-explain`, `--task-cache-stats`, `mise cache task <name>`, `task.cache_dir` (`MISE_TASK_CACHE_DIR`),
`task.cache_max_size` / `cache_max_age`. A remote backend (HTTP, bearer token or GitHub OIDC) exists; not needed
here, `actions/cache` on `task.cache_dir` is enough. **Experiment:** `lintc` (`outputs = []`, cache on) ran once,
the second run was `sources up-to-date, skipping` with the output replayed, an edit to a source re-ran it,
`--task-cache-explain` listed the key inputs (sources, env, tools: 5 resolved versions, platform). Requires
`experimental = true`.

**Shared inputs.** `[task_config.input_groups]` named glob sets referenced as `@group:<name>` in `sources`, and
`task_config.global_inputs` applied to every task (lockfiles, toolchain files). `mise fmt` sorts them.

**`mise run --affected`** (no longer experimental; workspace graph from `pnpm-workspace.yaml`, Cargo, uv, Go,
Gradle). Selects the projects whose files changed between base and head (CI metadata picks `origin/$GITHUB_BASE_REF`
and `$GITHUB_SHA`; needs `fetch-depth: 0`), plus their dependents, plus everything on a `global_inputs` hit;
counts uncommitted and untracked work by default; `--affected-explain` and `--affected-json`. **Experiment:** this
repo works as a monorepo root with one project (`monorepo_root = true`, `config_roots = ["."]`, the Node provider
reads `pnpm-workspace.yaml`). With one project the answer is all-or-nothing: a `docs/d.md` change selected the
project. Project-level affected only pays once the repo has workspace packages; task-level `sources` give the
granularity until then.

**`mise watch <task>`** reruns a task when its `sources` change (needs the `watchexec` tool; `--once` waits for one
change, runs, exits). **`[[watch_files]]` hooks** run at the shell prompt, not a watcher. **`skip_if`** runs a shell
check and skips the task on exit 0. **`depends` / `depends_post` / `wait_for`**, optional deps, `:::` for several
tasks in one run, `--timeout`, `task.timings` (elapsed per task is printed by default).

**OpenTelemetry export of `mise run` (experimental, 2026.9.13).** One trace per run, a span per task with exit code
and redacted args; `TRACEPARENT` is read from the environment and passed to each task; `otel.logs = true` adds task
output as log records. Needs `experimental = true`, `otel.enabled = true` and `OTEL_EXPORTER_OTLP_ENDPOINT`. The
user's global config already has `otel.enabled` and `otel.logs` on (pointed at OpenObserve). This is the natural
way to count how often `verify` fails locally, and in CI it would put mise's task spans into the run's own
otel-html report, under the `otel-html run` span that already wraps each step.

**`mise bootstrap`** sets a machine up from config: host packages (apt/dnf/brew/winget/scoop/choco/snap), apt
sources, system files, services, Compose projects, repos, dotfiles, shell activation, `[tools]`, then a
`[tasks.bootstrap]` task and hooks; 20 ordered steps, idempotent parts, `--dry-run`, `plan` (`--detailed-exitcode`),
`status --missing` (exit 1 when anything differs: a doctor check), `--only`/`--skip`, `remote` over SSH, `--from` /
`--adopt` a repository. Opt-in only; project configs need `mise trust`. `jdx/mise-action@v5` runs `mise bootstrap`
instead of `mise install` with `bootstrap: true` (`bootstrap_skip`, `bootstrap_args`). For this repository it would
declare the host side of the toolchain that `[tools]` does not cover: Docker (for `test:load:receiver`), Playwright's
OS libraries, `watchexec`, and run `mise run setup` + `playwright install` as the `bootstrap` task, so a new machine,
an agent sandbox or a CI runner is one command and `mise bootstrap status --missing` says what is off.

**Also available.** `mise.lock` (pinned tool versions, checksums and URLs; `mise-action` adds `--locked` when the
lockfile exists; `lockfile_mode = "generate"` is now the default); `mise tasks validate` and `mise fmt --check` (lint
the task config); `mise generate task-docs` (Markdown from task `description`s), `git-pre-commit --hook pre-push`
(a hook that runs a task), `github-action`, `devcontainer`; `mise mcp` (an MCP server that lists and runs tasks with
read/write/destructive effect metadata) and `mise lsp`; task sandboxes (`deny_net`, `allow_write`); `mise daemons`;
`hk` (jdx's git-hook runner: parallel steps with file locks, `hk install --mise`, a lefthook migration guide; no
biome builtin, custom steps run any command).

## Proposals

Ranked by expected gain per unit of complexity. Numbers are estimates from the measurements above.

### Tier 1: the CI graph and the e2e fixed costs (cheap, large)

**P1. Make the jobs independent.** Drop `needs: check` from `build` and `unit-os`, and `needs: build` from `e2e`,
`e2e-metrics-scale` and `binary`; every job runs `mise run build` itself (3 s) as the `binary` jobs already do.
`build` keeps `check:package` and the `dist` artifact for anything that wants the exact bits. Critical path becomes
setup + build + the webkit e2e job. Cost: when lint fails, the e2e runners still spend their minutes; on free public
runners (20 concurrent jobs; we use 9) that is a queue, not a bill. Saves ≈ 2.5–3 min.

**P2. The e2e fixture reports become a mise task with `sources` and `outputs`.** Move the report building out of
`e2e/global-setup.ts` into `e2e/build-fixtures.ts`, run by

```toml
[tasks."e2e:fixtures"]
depends = ["build"]
sources = ["dist/**", "e2e/build-fixtures.ts", "e2e/fixture.ts", "test-support/scale-*.ts", "test-support/fixture-ids.ts", "fixtures/**"]
outputs = ["e2e/.reports/**"]
run = "node e2e/build-fixtures.ts"
```

and make `test:e2e*` depend on it. Playwright's global setup keeps the calibration and the http server and asserts
the reports exist. The second pass of every run finds them fresh (−40 s per CI job, −16 s locally), a re-run after
a spec-only or unrelated change costs nothing, and `mise run --force e2e:fixtures` (or deleting `e2e/.reports`)
rebuilds. A one-spec run drops from 34 s to ≈ 3 s. No hand-written stamp file: mise owns the freshness check, and
the same declaration drives `mise watch`. Do not put the 613 MB in a CI cache (10 GB per repo, LRU).
The alternative, one Playwright invocation with a `perf` project that `dependencies` on the others, does not work:
Playwright has no per-project worker count and the perf pass needs `--workers=1`.

**P3. Run `http` for a subset.** Only `scale`, `trace-panel` and `load` read the URL kind. Make `<browser>-file` the
project every spec runs under and give `<browser>-http` a grep on a tag (`@http`) carried by the specs that care plus
`smoke`, `hostile` and one spec per page, so a file-vs-http regression still shows. Halves both passes:
chromium main 2.8 → ≈ 1.5 min, perf 1.3 → ≈ 0.7 min; locally 46 s → ≈ 25 s. The tag list is the risk: a new page
whose spec forgets the tag is not checked over http until smoke catches it.

**P4. More workers, and `fullyParallel`.** `workers: process.env.CI ? 4 : undefined` and `fullyParallel: true` on the
main pass (the perf pass keeps `--workers=1`). Measure once; keep if flake-free. Expected 20–40% off the main pass.

Together: `e2e (chromium)` ≈ 250 s → ≈ 100 s; webkit ≈ 300 s → ≈ 150 s; CI wall ≈ 9 min → **≈ 4 min**, with
`check` (2.3 min) running alongside instead of in front.

### Tier 2: mise owns "what needs to run" (local and CI alike)

**P5. Every task declares its inputs; `check` becomes incremental.** `[task_config.input_groups]` holds the globs
once (`code`, `viewer`, `node`, `e2e`, `config`); each task references them:

```toml
[task_config.input_groups]
node   = ["src/**", "!src/viewer/**", "test/**", "!test/viewer/**", "test-support/**", "scripts/**", "tsconfig*.json", "vitest.config.ts"]
viewer = ["src/viewer/**", "src/model/**", "src/format/**", "src/semconv/**", "src/rollups/**", "src/ottl/**", "test/viewer/**", "tsconfig.viewer.json", "vite.config.ts"]

[task_config]
global_inputs = ["package.json", "pnpm-lock.yaml", "mise.toml"]

[tasks.typecheck]
sources = ["@group:node", "@group:viewer", "e2e/**", "tsconfig.e2e.json"]
outputs = []
cache = { enabled = true }

[tasks."build:lib"]
sources = ["@group:node", "tsdown.config.ts"]
outputs = ["dist/cli/**", "dist/index.js", "dist/index.d.ts", "dist/receiver-*.js"]
```

`build:lib`, `build:viewer`, `gen` get real `outputs`; `lint`, `typecheck`, `knip`, `gen:check`, `test:unit:main` get
`outputs = []` with the artifact cache so a passed result is remembered until an input changes. **Never cached:**
`test:unit:perf` (it measures), `test:load*`, `coverage` (only the whole suite is meaningful). `test:e2e` is cached
too, in P6, with every input a browser run reads in its key. On a docs-only edit, `mise run check` then
runs nothing; on a writer-only edit it skips the viewer typecheck and build. `tsdown`'s `clean: true` wipes
`dist/viewer`, so `build:viewer` depends on `build:lib` (mise re-runs dependents when a dependency ran) or `clean`
moves into the task. `experimental = true` and `task.source_freshness_hash_contents = true` go in `[settings]`
(honoured once the config is trusted; CI already sets `MISE_TRUSTED_CONFIG_PATHS`). Because the cache key includes
resolved tool versions and the task text, a `mise.toml` or Node bump invalidates everything, which is right.
Risk: the artifact cache is experimental; `MISE_TASK_CACHE=off` turns it off in one place and the plain
`sources`/`outputs` freshness still works.

**P6. The same semantics on CI, with nothing of our own.** `test:e2e` declares its inputs like the check tasks
(`dist/**`, the e2e group, `test-support/**`, `.github/workflows/ci.yml` for the browser image; `--browser` and the
tool versions are in the key by construction; `OTEL_HTML_PERF_*` and `CI` allow-listed; `playwright --version` as a
command input) and caches its result. Every CI job restores mise's two state directories (`task.cache_dir`, set to
`.mise/task-cache`, and the freshness records under `~/.local/state/mise/task-sources`) with `actions/cache`, then
runs the same task it runs today. A docs-only push still starts every job (≈ 1 min of container, setup and build
each) and then replays; a change to anything a browser run reads runs the browsers. Whole jobs are not skipped:
that needs project-level `mise run --affected`, which pays once the repository has workspace packages (P16), and
until then would mean either a script of our own re-implementing mise's input matching or a GitHub-only path rule.
Both were considered and dropped: the rule would live in one place only, and mise already owns the question.

**P7. Affected unit tests for free:** `test:unit:changed` = `vitest run --changed <ref>` runs the test files whose
import graph reaches a changed file (measured: 22 files, 3.4 s for a 3-file change). `mise watch check` once
`watchexec` is in `[tools]`, for a long session on one module.

**P8. The ladder, as a rule, not a hook (decided).** An `AGENTS.md` (the primary, tool-neutral instructions) and a
small `CLAUDE.md` that imports it with `@AGENTS.md` and holds only Claude-specific lines (models, skills). The
ladder:

| when | run | cost |
|---|---|---|
| after every edit | `mise run check` | ≈ 20 s cold, seconds when little changed (P5) |
| touched the viewer or a CLI/report path | `mise run test:e2e:chromium -- e2e/<spec>.spec.ts` | ≈ 3 s after P2 |
| before every push | `mise run check` (the pre-push hook runs it too) | ≈ 20 s |
| before opening a PR | `mise run verify` = `check` + `test:e2e:chromium` | ≈ 1 min after P2–P3 |
| never locally | the three-browser matrix, windows, metrics-scale, binaries | CI's job |

The pre-push hook **stays `mise run check`** (decided): `verify` before a PR is a documented rule, so a verify
failure that reaches CI is a measurable event, counted from the first-run outcome of each PR, and from mise's OTel
spans of `verify` where an endpoint is set (the user's shell already exports them). **Tasks document themselves
(decided):** every task gets a `description` (multi-line for the slow ones), the README's hand-written task table is
replaced by a section `mise generate task-docs --inject` regenerates from them (run by `gen`, checked by
`gen:check`), and `mise tasks info <task>` is the reference.

### Tier 3: CI shape, after Tier 1 is measured

**P9. Shard per browser** (`--shard=k/2`) only if a browser job is still over ≈ 3 min after P2–P4. Each shard pays the
≈ 45 s fixed cost (container + setup + fixtures) again.

**P10. Browser matrix: all three on every PR (decided).** The viewer is canvas + ECharts + CSS where engines differ;
after P1 the matrix is no longer what the run waits for.

**P11. Unit tests on CI (102 s).** Off the critical path after P1. When it matters again: split `check` into a
`node` and a `viewer` vitest project job, and try `happy-dom` for the viewer project behind a measurement (jsdom boot
is 28% of the run; testing-library compatibility is the risk).

**P12. Container pull (30 s × 4).** The chromium jobs could run outside the Playwright image with
`~/.cache/ms-playwright` in the GitHub cache and `playwright install-deps chromium` (a handful of packages; it is
webkit that needs ~190). Saves ≈ 20 s on two jobs. Low priority.

### Tier 4: visibility and structure

**P13. Coverage (decided: artifact + job summary now; Codecov is a separate ticket).** `@vitest/coverage-v8`,
`mise run coverage` (`vitest run --coverage`, reporters `lcov` + `json-summary` + `text`), a non-gating job on `main`
pushes that uploads `coverage/` as an artifact and writes the summary table to the job summary. Nothing in it
precludes Codecov later: the `lcov.info` is what Codecov reads, each job keeps its own `coverage/` folder with a
`flags`-shaped name (`unit-node`, `unit-viewer`, later `e2e-chromium`), and the upload is one extra step. Playwright
coverage (`page.coverage` on chromium → `v8-to-istanbul`, merged) is possible later; the viewer's unit tests are
dense enough (88 files, 19.5k lines over 23k of source) that unit coverage says most of what there is to say.
Coverage and the subsets of P5/P7: `coverage` is its own task with no `sources` and no cache, so it always runs the
whole suite; a cached `test:unit:main` or a `vitest --changed` run never feeds it (vitest does not merge an old
report with a partial run, so a partial report would simply be wrong).

**P14. Test effectiveness notes** (observations, not a plan):
- 2,496 unit tests over 634 files; 71 distinct e2e tests. The ratio is healthy; e2e should stay the layer that checks
  pages, not logic.
- The three `metrics-explorer` e2e tests take 12 s each on CI (4.5 s locally). The time is the `exemplarRings`
  sweep (a pointer probe at every spot of the plot), not the seven-step `p99ByRoute` UI sequence, which takes under
  1 s in most runs; a URL that encodes the query would not remove it.
- `test/receiver/http.test.ts` is 12 s of the unit run (one deliberate 100 ms `setTimeout` and real sockets); the
  next slowest unit file is 3.4 s.
- `run-chart.spec.ts` holds 25 of the 71 e2e tests, mostly interaction details that need a real canvas and so belong
  in e2e; `fullyParallel` (P4) is what makes that file cheap.

**P15. Measuring it.** The repo already dogfoods its own CI reports with per-job run charts (#93). The durations in
this document are the baseline to put next to the charts after each PR below. Locally, mise's OTel export is the
counterpart: one span per task with its exit code, into whatever `OTEL_EXPORTER_OTLP_ENDPOINT` names.

**P16. Splitting the repository into workspace packages: not now.** `tsc` takes 2 s, lint 0 s, build 1 s; the
tsconfig split (`node`, `viewer`, `e2e`) already draws the type boundary and P5's input groups draw the task
boundary. Packages would make `mise run --affected` project-aware, but e2e spans every package anyway (the CLI
converts the fixtures the viewer renders). Revisit when a part needs its own release cadence or the source passes
~100k lines; P6 is written so the switch is a one-line task change. Nx/turborepo likewise: mise's freshness check,
artifact cache, input groups and `--affected` cover the same ground with no second task runner, and are the tool the
project already standardises on.

## Suggested order

1. **PR A — the graph** (P1): `ci.yml` only. Expected: 9 → ≈ 6.5 min.
2. **PR B — e2e fixed costs** (P2, P3, P4): `e2e/build-fixtures.ts`, `e2e/global-setup.ts`, `playwright.config.ts`,
   tags on ~5 specs, `mise.toml`. Expected: CI ≈ 6.5 → ≈ 4 min; local one-spec 34 → ≈ 3 s; local chromium 81 → ≈ 35 s.
3. **PR C — mise inputs and the ladder** (P5, P7, P8): `mise.toml` (input groups, sources/outputs, descriptions,
   `verify`, `test:unit:changed`, `watchexec`), `AGENTS.md`, `CLAUDE.md`, README, `.gitignore`.
4. **PR D — the same semantics on CI** (P6): `test:e2e` caches its result; every job restores the mise task cache
   and freshness records. Expected: docs-only pushes ≈ 1.5 min with every job replaying; no script, no path rule.
5. **PR E — coverage** (P13).
6. Later, measured first: P9, P11, P12.

## Follow-up candidates (out of this task's scope; gathered for separate tickets)

- **Codecov** (ticket to be filed with this document): add the upload step to P13's job; PR comments and gates off
  at first.
- **mise OTel into the CI report.** `otel-html run` already wraps every CI step and owns the trace; with
  `experimental = true`, `otel.enabled = true` and `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at a receiver the job
  shell starts, every `mise run` task becomes a child span with its exit code and timing, and `otel.logs` carries
  task output. Depends on `run` exposing an endpoint to its child (today it sets `TRACEPARENT`; check what it binds).
- **`mise bootstrap` for this repository.** `[bootstrap.packages]` for Docker and Playwright's OS libraries (apt),
  `watchexec` in `[tools]`, `[tasks.bootstrap]` = `mise run setup` + `pnpm exec playwright install`;
  `mise bootstrap status --missing` as the doctor; `bootstrap: true` on `mise-action` where a job needs the host
  packages (the load workflow). Needs `mise trust` on the project.
- **`mise.lock`.** Run `mise lock`, commit it; `mise-action` then installs `--locked` with checksum verification.
  Renovate updates it with `mise.toml`.
- **`mise tasks validate` and `mise fmt --check` in `lint`;** `mise generate task-docs` to replace the hand-kept
  task table in the README.
- **`hk` instead of lefthook.** Same four hooks, parallel steps with file locks, `hk install --mise`; biome and
  commitlint as custom steps. Value is small today; worth it if the pre-commit set grows.
- **`mise mcp` in agent config** so agents discover and run tasks with mise's effect metadata instead of guessing
  commands from the README.
- **Unit tests under a task sandbox** (`deny_net`) to prove hermeticity, except the receiver suites, which use
  loopback sockets.
- **Remote task cache** (mise's HTTP backend with GitHub OIDC) if `actions/cache` on `task.cache_dir` turns out to
  evict too often.
- **`metrics-explorer` URL state** (P14) and the `http.test.ts` 12 s.
