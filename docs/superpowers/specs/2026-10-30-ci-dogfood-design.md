# CI dogfooding: one report per workflow run, published to GitHub Pages

Status: approved 2026-10-30 with the owner's answers in §9 folded in.

## 1. Intent

Every CI job instruments the commands it runs with otel-html itself, the per-job reports are merged into one
report per workflow run with the workflow run as the parent trace (run → jobs → steps → the commands' own
telemetry), and that report is published to GitHub Pages and linked from the PR. On `main`, runs accumulate
into a rolling report so regressions in CI time and test behaviour can be seen across runs.

The same machinery, packaged as a reusable GitHub Action, is the product's CI story for other projects: wrap
your steps, get a report, have it published at the end of the run.

Why now: M5 shipped `run`, `serve`, `merge` and the exporters, which is everything the pipeline needs except
trace-context inheritance and a publisher. CI is already half-dogfooded (the `e2e` jobs run under
`otel-html run` and upload `ci-report-<browser>` artifacts that nobody opens).

## 2. Goals, non-goals, anti-goals

Goals

- One report per workflow run: all jobs, the workflow run as the root trace, every job and step a span, the
  commands' own spans, logs and metrics under them.
- Published to Pages under a stable URL per PR, linked from the PR, and a rolling `main` report.
- Works for PRs from forks (the publisher runs in a trusted context).
- Reusable by other repos as `uses: bjstabi/otel-html/.github/actions/<name>@v1` with no other setup than
  enabling Pages.
- Reports survive otel-html upgrades: the data of old runs is re-rendered by the new viewer, never lost.

Non-goals (for this work)

- Hosting targets other than GitHub Pages. The design keeps the publish step behind one interface so Cloudflare
  Pages, S3 and friends can be added later without touching collection or merging.
- Changing the viewer to query a database (see §7, SQLite).
- Tracing inside tools that emit no telemetry (vitest, biome, tsc). They show up as steps and as `run` root
  spans with exit codes; richer instrumentation of our own test runners is separate work.

Anti-goals

- A CI pipeline that is slower or flakier because of the report. Collection must add seconds, not minutes, and
  a report failure must never fail a job that otherwise passed (the existing `run` exit-code contract already
  says this).
- Secrets or tokens reaching the published report. The publisher runs with the default token only, and the
  workflow trace is built from public API fields.
- A site that grows without bound. Retention is part of the design, not a follow-up.

## 3. Constraints found in the repo

- `otel-html run` always mints a fresh trace id and always sets `TRACEPARENT` for the child
  (`src/cli/commands/run.ts`, `src/run/child-env.ts`). To parent a job's telemetry under the workflow trace it
  has to accept an inherited trace context. This is the one product change the pipeline cannot do without.
- A report's `data/` is a versioned, viewer-independent format (`formatVersion` 3, readable 1–3). Chunks are a
  lossless columnar encoding of the normalized OTLP records (resources, scopes, dropped counts, schema URLs,
  links, events, exact int64/bytes), and the viewer already exports them back to OTLP JSON. `merge` replays
  chunks and works across otel-html versions that share a readable format version, and it always writes the
  current viewer. `--append` is stricter: it requires the same otel-html version.
- The report must work from `file://` with classic `<script>` tags only. Anything that needs `fetch`, range
  requests or workers breaks a product promise.
- `ci.yml` grants `contents: read` only; artifacts from `e2e` are uploaded with `include-hidden-files` (the
  report has `.nojekyll`). Pages is enabled on the repo with `build_type: workflow`.
- The `load` workflow runs on a schedule with its own jobs; it is a second producer of reports, not a special
  case.
- No macOS runners (cost). Nothing here needs one.

## 4. The existing actions: evaluate before rolling our own

Candidates: `dash0hq/otel-cicd-action` (fork of `inception-health/otel-export-trace-action`, MIT),
`ClickHouse/github-actions-opentelemetry` and `paper2/github-actions-opentelemetry` (MIT), and the
Collector's `githubreceiver` (webhook-driven, alpha).

What they do well: read the completed run from the API and emit run → job → step spans with timings and
conclusions, as a `workflow_run`-triggered workflow or a final `if: always()` job. They export over
OTLP/gRPC or OTLP/HTTP, so they could point at a local `otel-html serve` in the publisher job and the workflow
trace would land in our report with no code of ours.

Why they do not fit the goal:

- Random ids. Dash0's tracer uses the SDK's random id generator (a seeded generator exists only for its tests).
  The job-side telemetry runs before the action and cannot learn the trace id, so job reports can never be
  children of the workflow span. Linking is the whole point of "the job itself as the parent trace".
- They run after the fact and emit only what the API knows. Our job reports carry the real telemetry; the
  action would duplicate the step layer with different ids.
- Attribute vocabulary: Dash0 uses `github.*` keys throughout; semconv's `cicd.pipeline.*` is the vocabulary
  the viewer should grow facets and a dashboard around.
- The `githubreceiver` needs a webhook endpoint and a running collector. Not a static-host story.

Decision: roll our own workflow tracer, small by design (one GitHub API call for the run, one for its jobs,
deterministic ids, `cicd.*` plus a few `github.*` extras, written straight into a report with the library API,
no OTLP exporter in the loop). Dash0's action remains useful as a one-day spike to see a workflow trace in the
viewer before any of ours exists (point it at `otel-html serve` on `127.0.0.1:4318`), and its attribute list is
a reference for the extras.

## 5. Approaches considered

### A. Final job in `ci.yml` merges and publishes

A last job with `needs: [all]` and `if: always()` downloads the job artifacts, builds the workflow trace,
merges, deploys to Pages and comments on the PR.

Trade-offs: simplest to read, shows on the PR checks list. But a PR from a fork runs with a read-only token, so
it cannot deploy Pages or comment, and the last job cannot see its own timings (it is still running). Every
workflow that wants a report needs the job duplicated.

### B. Separate `workflow_run` publisher (recommended)

A `ci-report.yml` workflow triggers on `workflow_run: workflows: [ci, load], types: [completed]`. It runs on
`main`'s code with a write-capable token regardless of where the PR came from, downloads the completed run's
`otel-html-*` artifacts, builds the workflow trace from the API (which now has every job's final timing), merges,
publishes and links.

Trade-offs: a second workflow and a delay of a minute or so after `ci` completes; the report link is not on the
PR's checks list by itself, so the publisher posts a sticky comment and a check run. Fork PRs, timing
completeness and reuse by other repos all work. This is also the shape the existing actions converged on.

### C. Each job publishes its own report

No merging; each job deploys its own report to Pages. Rejected: Pages has one deployment per repo at a time and
each deployment replaces the site, so concurrent jobs would race, and the cross-job trace would not exist.

Choice: B. A is kept as a documented fallback mode of the action for private repos that do not want a second
workflow and never take fork PRs.

## 6. Design

### 6.1 Pieces

Three composite actions in this repo under `.github/actions/`, usable by other repos through
`uses: bjstabi/otel-html/.github/actions/<name>@v1` (GitHub resolves `{owner}/{repo}/{path}@{ref}` for public
repos, so no separate action repo is needed to ship this):

| Action | Runs in | Does |
|---|---|---|
| `otel-html-setup` | each job | Installs the otel-html binary (release download by version, or `dist/` for this repo), resolves the job's deterministic trace context and exports `TRACEPARENT`, `OTEL_HTML_REPORT` and related variables to `GITHUB_ENV`. |
| `otel-html-collect` | each job, `if: always()` as the last step | Closes nothing (every `run` closes its own report), uploads the job's report folder as artifact `otel-html-<job id>`. |
| `otel-html-publish` | the `workflow_run` publisher | Downloads `otel-html-*` artifacts of the triggering run, writes the workflow trace, merges, publishes, links. |

Inside a job, commands are wrapped with `otel-html run -o $OTEL_HTML_REPORT -- <cmd>`. Two ways to do that,
both supported:

- Explicit: `run: otel-html run -o "$OTEL_HTML_REPORT" -- mise run check` (what `e2e` does today).
- Job-wide, with a custom shell: `defaults: run: shell: otel-html run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}`.
  Every `run:` step becomes a root span appended to the job report with no per-step edits. (Proposal: the
  first `run` creates the report, later ones append; this is the current default behaviour when `-o` already
  holds a report by the same version.)

The shell form is the default for our own workflows. Steps that are `uses:` actions (checkout, setup, upload)
are not wrapped; they still appear as steps in the workflow trace. Two mechanics to respect:

- A job-level `defaults.run.shell` is evaluated with the `env` context of the workflow file, not with values a
  step wrote to `GITHUB_ENV`, and the shell line is split on whitespace, not run by a shell. So the report path
  is a fixed relative path (`.otel-html/report`), not a variable, and `TRACEPARENT` reaches `run` through the
  process environment (which `GITHUB_ENV` does feed), which is why `run` reads the variable and not only the flag.
- The executable must be on `PATH` when a step runs. `otel-html-setup` adds it through `GITHUB_PATH`; any
  `run:` step before that one sets `shell: bash` explicitly (in `load.yml` that is the `lscpu` step).

Which otel-html does the collecting: in this repo, always the code at the SHA under test. Every job builds
it (`mise run build`, or the `dist` artifact in the jobs that already download it) and wraps with
`node dist/cli/main.js`, so a change to `run`, the writer or the viewer is exercised by the very run that
proposes it. Other repos have no build of otel-html, so for them `otel-html-setup` downloads a release
binary pinned by a `version` input (checksum-verified against `SHA256SUMS`); a `command` input lets a repo
point at its own build instead, which is what this repo uses. Nested `run`s are avoided on purpose: the outer
`run` would set `OTEL_EXPORTER_OTLP_ENDPOINT` and the inner one would warn and receive nothing.

The publisher is the one place that runs `main`'s otel-html rather than the PR's: a `workflow_run` workflow
checks out the default branch, and checking out a fork PR's code under a token that can write Pages and
comments is the classic privilege escalation. `merge` reads every readable format version, so the PR's reports
are merged and rendered by `main`'s build; a PR that changes the viewer is seen through its own build in the
per-job artifacts and through `main`'s in the published report, and a PR that bumps the format version shows up
in the publisher's log as skipped until it merges. That is accepted.

### 6.2 Trace identity (the product change)

`run` learns to join an existing trace:

- A new `--traceparent <w3c>` flag, and when it is absent, the `TRACEPARENT` environment variable. When
  present, the root span takes its trace id and uses its span id as parent. The flag/env is validated as a
  W3C `traceparent`; a malformed value is a usage error (exit 2), not a silent fresh trace.
- The child still receives `TRACEPARENT` pointing at `run`'s root span, as today. The `tracestate` is passed
  through untouched if set.
- Library equivalent: `Report`-level nothing changes; the root span builder (`src/run/root-span.ts`) takes an
  optional parent.

Deterministic ids, computed identically on both sides from public facts:

```
run key    = "github.com/<owner>/<repo>/actions/runs/<run_id>/attempts/<run_attempt>"
trace id   = sha256(run key)[0:16]
run span   = sha256(run key + "#run")[0:8]
job span   = sha256(run key + "/jobs/" + <job id>)[0:8]
step span  = sha256(run key + "/jobs/" + <job id> + "/steps/" + <step number>)[0:8]
```

The job id is the numeric id from the jobs API, which is not in the job's environment. `otel-html-setup`
resolves it with one call to `GET /repos/{r}/actions/runs/{run_id}/attempts/{attempt}/jobs`, picking the
in-progress job whose `runner_name` equals `RUNNER_NAME` (the established pattern; needs `actions: read`, which
`ci.yml` has to add). Fallback when the call fails or is ambiguous: a `job-name` input, hashed instead of the
id, with a warning in the step log and a span attribute saying the parent was approximated. The publisher uses
the same fallback rule for a job whose id lookup is marked approximate, so the two sides still agree.

Step spans from the API are siblings of the `run` root spans under the job span (the API knows step numbers
and `uses:` steps; `run` knows the command and exit code). The publisher does not try to nest one in the other.

### 6.3 The workflow trace

Written by `otel-html-publish` with the library API (`Report.create` + `addSpans` with an OTLP request object),
no SDK, no exporter. One span per run, job and step, times from the API, `cicd.pipeline.*`,
`cicd.pipeline.task.*`, `cicd.worker.*` and `vcs.*` attributes from semconv, plus `github.run_id`,
`github.run_attempt`, `github.job.id`, `github.event`, `github.html_url` and the conclusion fields as extras.
The run span's status is `ERROR` when the run's conclusion is not `success`; the same for jobs and steps. A
queued span per job covers `created_at → started_at` (Dash0 does this for the run; per job is more useful).

Resource: `service.name = <workflow name>`, `service.namespace = <owner>/<repo>`,
`service.instance.id = <run id>/<attempt>`, plus `cicd.pipeline.name`, `cicd.pipeline.run.id`,
`cicd.pipeline.run.url.full`, `vcs.ref.head.name`, `vcs.ref.head.revision` and `vcs.repository.url.full`. Job
reports carry the same `cicd.*` and `vcs.*` resource attributes: `otel-html-setup` exports them through
`OTEL_RESOURCE_ATTRIBUTES` (merged with any the workflow set), and `cicd.pipeline.task.name = <job name>` on
top, so every record in a job report says which run and job it belongs to. `service.name` is set per job
through `OTEL_SERVICE_NAME` so facets read `ci/e2e` rather than `mise`. In the rolling `main` report these
attributes are what tell runs apart: each run is its own trace (deterministic trace id per attempt), and the
dashboard variables and explorer facets are `cicd.pipeline.run.id` and `cicd.pipeline.task.name`.

Logs. Step output is not captured anywhere today: `run` hands the child the inherited stdio, so the GitHub job
log is the only copy. The publisher fetches each job's log (`GET /repos/{r}/actions/jobs/{id}/logs`, plain
text with a UTC timestamp per line and `##[group]`/`##[endgroup]` markers) and writes one log record per line
into the workflow-trace report: `time` from the line's timestamp, `body` the text with the timestamp stripped,
`trace_id`/`span_id` of the step whose time range contains the line (steps from the API), severity from the
`##[error]`/`##[warning]`/`##[debug]` prefixes else INFO, and `cicd.pipeline.task.run.id` as an attribute.
Groups become a `log.group` attribute so Patterns can fold them. The size concern from the proposal is
accepted: logs are the bulk of a run's data and they are exactly what the Logs explorer is for.

Metrics. The publisher also writes the semconv CI/CD metrics from the same API data, one data point per run at
the run's completion time, with the resource above: `cicd.pipeline.run.duration` (histogram, by
`cicd.pipeline.name` and `cicd.pipeline.result`), `cicd.pipeline.task.run.duration` (histogram, by
`cicd.pipeline.task.name` and result; this is the job-duration-over-time series), a queue-time histogram
`cicd.pipeline.task.run.queue.duration` (`created_at → started_at`, not in semconv yet, named in its style),
and `cicd.pipeline.run.errors` (counter, by `error.type`). One observation per histogram per run is enough for
the charts (`avg` or `p99` of a bucket holding one sample is the value); if the histogram form charts badly in
practice, the builder adds a gauge alongside it rather than changing the semconv names. The runner itself is
not observable from the API, so no `cicd.worker.*` metrics; if runner CPU and memory are wanted later, the
`otel-html-setup` action can start a tiny sampler, which is separate work.

### 6.4 Merging and site layout

The publisher merges the workflow trace report and every job report into one:

```
otel-html merge workflow-trace/ otel-html-check/ otel-html-build/ otel-html-e2e-chromium/ ... -o run/
```

`merge` de-duplicates spans by id, so a `run` root span and the publisher never collide, and it rewrites the
viewer, so the published report is always rendered by the publisher's otel-html version.

Site state lives in an orphan `gh-pages` branch, deployed with `actions/upload-pages-artifact` +
`actions/deploy-pages` after each change (the branch is the durable store; the deployment is a projection of
it). Pages replaces the whole site on each deploy and has no API to read it back, so a branch is the only
honest way to publish incrementally. Layout:

```
/                      index.html: a generated landing page listing main and open PRs
/main/                 the rolling main report (see 6.5)
/main/runs/<run_id>/   per-run reports that feed the rolling report (the sources of truth)
/pr/<number>/          the PR's latest run
/pr/<number>/runs/<run_id>/
/load/                 the load workflow, same shape as main
```

Retention: a PR's folder is deleted by a `pull_request: closed` trigger in the publisher; `main` keeps the
last 30 per-run reports; `load` the last 30. Both counts are publisher inputs. Concurrency on the publisher is `group: pages,
cancel-in-progress: false` so deploys queue instead of racing. The branch is force-pushed never; each publish
is one commit, and a push rejected by a concurrent publish is rebased and retried once.

### 6.5 Main: append, or merge and republish?

Decision: `/main/` is one merged rolling report, rebuilt from the retained per-run reports; runs are told
apart by their trace ids and the `cicd.*` resource attributes (§6.3). The reasoning:

- Per-run reports are kept as written (`/main/runs/<id>/`). They are the raw data: lossless chunks, re-readable
  by any later otel-html that still reads their format version, exportable back to OTLP JSON from the viewer.
- The rolling `/main/` report is rebuilt by `merge` over the retained per-run reports on each publish. Merge
  cost is linear in retained data and CI reports are small (the `e2e` reports are a few MB), so a rebuild is
  seconds. This is what makes viewer upgrades free: the next publish re-renders every retained run with the new
  viewer, no migration step.
- `--append` is not used on `main`. It requires the same otel-html version, cannot drop the oldest run, and
  would make the rolling report the only copy of old data. It stays the right tool inside a job (many `run`s
  into one report on one machine).
- When a per-run report's format version falls out of `READABLE_FORMAT_VERSIONS`, the publisher logs it and
  skips it; retention will age it out. The alternative, a stored OTLP export next to each run, is not needed
  while the chunk format is the lossless source and the reader keeps old versions readable, which is the
  format's stated policy (`src/format/version.ts`).

"Render on the fly" in the sense of the viewer loading new chunks into an old report is possible (the manifest
is the only file the viewer trusts, and append already rewrites it), but it buys nothing over a rebuild at this
size and would couple the publisher to one viewer version.

### 6.6 Linking from the PR

- A sticky PR comment (find-or-update by a hidden marker) with the report URL, run conclusion, per-job
  duration table and a link to the previous run's report. Needs `pull-requests: write` on the publisher.
- A check run named `otel-html report` on the head SHA with the URL as `details_url`, so the link is on the
  checks list even though the report workflow is not a PR check (`checks: write`).
- The linked URL opens the report on its CI dashboard (§6.10), which is what a reader coming from a PR wants
  first; the explorers are one click away in the sidebar.
- The job summary (`GITHUB_STEP_SUMMARY`) of the publisher mirrors the comment, which is the only output
  available when a repo disables comments.

### 6.7 Decoupling the model from the HTML

It is already decoupled on disk: `data/` is the model (versioned, validated by `parseManifest`, with a
compatibility policy) and `assets/` + `index.html` are the viewer (content-hashed, rewritten on every write).
What is missing is to make that a promise rather than a fact:

- Document `data/` as the stable contract: `formatVersion` semantics, the reader's compatibility window and
  the rule that a new viewer must read every version in `READABLE_FORMAT_VERSIONS`. This is a README section
  and a test that opens a frozen fixture report of each readable version in the viewer (M0).
- Add `otel-html upgrade <report>` (proposal, M4): rewrites `index.html` and `assets/` only, leaving `data/`
  untouched, for reports that are not going through `merge`. Cheap, and it is the user-facing name for the
  decoupling.
- Keep the self-describing files: every data file registers under `__OH__` with its path as key, so a report
  is readable with no index other than the manifest. No change.

### 6.8 SQLite in the static front end

Recommendation: no, not now.

- `file://` and classic scripts are product promises. SQLite in the browser means WASM plus the database bytes;
  from `file://` there are no range requests and no `fetch`, so the whole database would ship inline as base64
  in a script and be decoded into memory. That is strictly worse than today's chunks, which are plain JSON
  payloads the engine parses natively and the viewer loads by time window.
- On HTTP hosting a range-request VFS (sql.js-httpvfs style) would give real lazy querying of very large
  reports. It is a second data path and a second viewer code path, and nothing in CI reports is large enough
  to need it. The writer's rollups, trace shards and metric levels are the answer to "what does the viewer
  need without reading everything", and they exist.
- The revisit trigger: reports routinely over `viewer.eagerBudgetBytes` on static HTTP hosts where interactive
  query latency is the complaint. At that point an HTTP-only, opt-in `data/index.sqlite` built by the writer
  next to the chunks (never instead of them) is the shape to prototype.

### 6.9 Other hosting targets

`otel-html-publish` takes a `target` input. `github-pages` is the only value in this work. The target interface
is three operations: fetch the current site (or the paths it will touch), write a set of files, delete a set of
paths. Cloudflare Pages (wrangler, direct upload of a folder), S3/R2 (sync) and "artifact only" (no hosting,
for people who want the folder) fit the interface. The landing page generator and retention are target-agnostic
because they operate on the branch checkout before publishing.

### 6.10 The CI dashboard

The report a CI link opens lands on a CI-specific dashboard, not the Traces explorer. In its first form it is a
config dashboard: the publisher passes a `--config` with `viewer.home: dashboards`,
`viewer.defaultDashboard: ci`, variables `cicd.pipeline.run.id` and `cicd.pipeline.task.name`, and widgets
built from what the writer already supports: a `metric` widget charting `cicd.pipeline.task.run.duration` by
`cicd.pipeline.task.name` as lines over time (the multi-line job-duration chart), one for queue time, a
`toplist` of spans by name for the slowest steps, the `traces` list filtered to run root spans, and the `logs`
widget on warnings and errors. The current dashboard schema can express all of that, so no viewer change is
needed to ship it; the YAML lives in the publish action as its default config and a repo can override it.

The second form, later, is a built-in `ci` dashboard in the viewer (like `fusion`), seeded automatically when a
report carries `cicd.*` resources, with widgets the config form cannot express yet: a run timeline that draws
jobs as bars with queue time hatched, a run-over-run comparison for the same job, and a failure-rate tile.
That is the M5 item.

## 7. Milestones

Each milestone is shippable on its own and has a visible result.

M0: trace context inheritance (product). `run --traceparent` / `TRACEPARENT` in, parent set on the root span,
validated; README and tests; the format-contract README section and the frozen-fixture viewer test. Small.

M1: dogfood `ci.yml` by hand. `actions: read` added; a `setup` step computes the deterministic context
(script in `scripts/`, not yet an action) and exports it with the `cicd.*` resource attributes; every job uses
the custom shell; every job uploads `otel-html-<job>`. A `ci-report.yml` on `workflow_run` downloads the
artifacts, writes the workflow trace, the job logs and the CI metrics with a script using the library API,
merges with the CI dashboard config, uploads the merged report as an artifact and prints the per-job table in
its summary. No Pages yet. Result: one downloadable report per run with the full trace, logs, metrics and the
CI dashboard as its home.

M2: publish. `gh-pages` branch, per-PR and per-run folders, landing page, sticky comment, check run,
retention on PR close, concurrency. Result: links in PRs.

M3: `main` and `load`. Rolling report by re-merge over retained runs (30 each), retention counts, the `load`
workflow feeding `/load/`. Result: the job-duration-over-time chart on `main`'s CI dashboard.

M4: the reusable actions. Extract M1–M3 scripts into `.github/actions/otel-html-setup`, `-collect`,
`-publish` with inputs (version, report path, job name override, target, retention, comment on/off), the
"final job" fallback mode, `otel-html upgrade`, a `v1` tag, and a README section "Use in your CI". Result:
another repo can adopt it with two `uses:` lines and one workflow file.

M5 (later): the built-in `ci` dashboard in the viewer (§6.10, second form); Cloudflare Pages target.

## 8. Left to the builder

- Exact attribute list and span names for the workflow trace (follow semconv where it has a name, Dash0's list
  for extras).
- The landing page's look; it is a plain static HTML list written by the publisher.
- Artifact naming and the `include-hidden-files` detail (the report has `.nojekyll`).
- How `otel-html-setup` installs the binary in other repos (release asset by `version` input, checksum
  verified against `SHA256SUMS`), and `dist/` in this repo.
- Whether the custom shell wrapping is applied per workflow via `defaults` or per job; both are fine.

## 9. Decisions taken with the owner (2026-10-30)

1. Retention: 30 `main` runs to start; PR reports deleted on close.
2. The actions live in this repo under `.github/actions/` to start.
3. Job logs from the API are collected as log records, and every metric or trace the API can yield is
   derived (§6.3). They overlap with nothing collected inside the jobs.
4. `main` is one merged rolling report; runs are distinguished by trace id and the CI semantic conventions. A
   CI-specific dashboard is the landing page of a report opened from a CI link, starting as a config dashboard
   and later built into the viewer (§6.10).
