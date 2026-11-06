# Incremental CI publishing: a run's report grows while the run is going

Status: design, direction approved in conversation on 2026-11-06. Builds on the format-4 design
(`2026-11-06-parquet-duckdb-format-4-design.md`): partitions, the "immutable partitions, live set in the manifest"
rule, the `source` field, `assetsBase` and the `site` output format are assumed, and nothing here ships before the
format-4 bump release.

## 1. Intent

Today a CI run's report exists only after the run completes: each job uploads its report folder as an artifact, a
`workflow_run` publisher downloads them all, re-encodes them into one report, pushes it to gh-pages under a lease and
deploys Pages. A slow run is invisible until it ends, and the publisher's cost grows with the run.

With format 4 a report is a set of immutable partitions and a manifest, so "publish what this job has written so far"
is a copy of new files plus a manifest append, with no decoding and no conflict between jobs. This design makes each
job publish its own partitions, first when the job ends and then periodically while it runs from a background process
that does not slow the job's steps, and makes the workflow trace visible while the run is going, the way an
OpenTelemetry trace is visible before its root span ends. Every integration point stays OpenTelemetry: OTLP in, W3C
trace context across jobs, CI/CD semantic conventions, OTLP out to a collector of the user's choice.

## 2. Goals, non-goals, anti-goals

Goals

- A job's partitions reach the site within about a minute of being written, without adding time to the job's steps.
- The run's report on the site is valid and openable at every moment, and complete and compacted after the run.
- Jobs that finish early are in the report while the others run; the workflow trace shows them under a provisional
  root.
- Fork pull requests, which have no write token, still get today's end-of-run report.
- The end-of-run pass becomes reconciliation and compaction rather than the only publishing path.
- OTLP fan-out: what the receiver accepts can be forwarded unchanged to a collector or backend.

Non-goals

- Seconds-level liveness on GitHub Pages. Pages deploys one site at a time and takes about a minute; the design works
  within that and names the targets where seconds are possible (§6).
- A viewer that follows a run by itself. A Refresh affordance is in scope (§5.7); polling is left optional.
- In-progress span records in OTLP. There are none; the provisional root is a real span re-emitted in a replaced
  partition (§5.5).

Anti-goals

- Slowing a step by even a second: publishing is another process's I/O.
- A second data path: the same partitions, manifest and views as any format-4 report.
- Racing Pages deployments: the single `pages` concurrency group stays the only deployer.
- Widening what a fork pull request's run can do.

## 3. Constraints

- `ci.yml` runs jobs with a read-only token (`permissions: contents: read, actions: read`). Pushing gh-pages from a job
  needs `contents: write` on that job, and a fork pull request never has it (§5.2 decides what to do with that).
- gh-pages is a git branch; concurrent pushes go through `site-lease.sh`, which retries on the new tip up to five
  times. Pages deploys the gh-pages tip in the `pages` concurrency group, one at a time, about a minute each.
- GitHub Actions kills a job's processes when the job ends and keeps a detached process (`setsid`) alive across steps
  until then; steps within a job run sequentially.
- The publisher must not run a pull request's code with a write token (dogfood design §6.1); the per-job pusher runs
  the job's own otel-html with the job's token, so that rule is unchanged: the pusher only ever has the job's rights.
- The site index (`index.json`), channels, retention and the rolling report keep their shapes.
- Under the job shell every `run:` step is its own `otel-html run` process, so `close()` compacts a step's flush
  partitions at the end of every step, and a job report's manifest flips `complete` once per step.
- Pages is deployed only by the `deploy` job of `ci-report.yml`, on `workflow_run: completed` from the default branch;
  nothing deploys on a push to `gh-pages` today. The `github-pages` environment's branch policy decides which refs may
  deploy. Windows runners exist in `ci.yml` and `actions-smoke.yml`.

## 4. Approaches considered

- **A. End of run only** (today). Simple; nothing visible until the end; cost grows with the run. Kept as the
  fallback path for fork pull requests and as the final reconciliation.
- **B. Each job publishes at its end.** The collect step pushes the job's partitions under the lease. The report grows
  as jobs finish. Needs a write token on the job.
- **C. A background pusher during the job.** A detached process started by `otel-html-setup` pushes new partitions
  every minute, batched, under the lease. Needs the same token as B plus a process the steps do not wait for.
- **D. Jobs upload partitions as artifacts mid-run; a scheduled publisher ticks.** Keeps job tokens read-only, but
  GitHub schedules run every five minutes at best with jitter, and a mid-run upload from a detached process relies on
  the artifact runtime token being inherited. Latency and fragility rule it out as the main path; it is the shape to
  reach for if write tokens on jobs are refused (§9).
- **E. Object store or `otel-html host` as the target.** Seconds-level liveness, no git, no deploy step. The right
  answer where that infrastructure exists; out of scope for GitHub Pages, in scope as a target (§6).

Choice: B first, C on top of it, A kept, D documented, E through the target interface.

## 5. Design

### 5.1 `otel-html ci push`

A new CLI subcommand, run inside a job with the gh-pages checkout the lease script provides:

```
otel-html ci push --report .otel-html/report --site <checkout> --channel <channel> --run <run id> --job <job id>
```

It is a **sync**, not an append: after it, the site's run report lists, for this job, exactly the partitions the
job's report lists right now, plus one small partition of **CI spans** this job writes (§5.5). Concretely it copies
each job partition whose `source` (`job:<id>#<n>`) the run report does not list into the next free
`<channel>/runs/<run id>/data/partitions/<p6>/` with that `source` and its manifest entry (statistics included),
drops from the run manifest every partition of this job whose `source` the job report no longer lists (a step's
`close()` compacted its flush partitions), writes the manifest, then deletes the dropped partitions' files, and
refreshes the run report's `index.html` and the channel's `index.json` entry (conclusion `in_progress`). It writes
nothing else: no compaction across jobs, no rolling report, no link, no preview. Matching on `source` makes a push
idempotent and a retry under the lease start from the tip and change nothing already there. A push with nothing to
change prints `pushed=false` and the lease script does not push (its existing `push-when` mechanism). Because the
manifest is written before files are deleted, a reader with an older manifest can at worst miss a file and must
re-read the manifest, which is the format-4 rule.

The run report's manifest while the run is going has `complete: false` and an `updatedAt` per push; the viewer shows
"in progress, updated <time>" from it.

### 5.2 When pushes happen, and with what token

- **At job end (approach B):** `otel-html-collect` gains a `publish` input. When set, after the artifact upload it
  checks out gh-pages under the lease and runs `ci push`. Every step's `close()` has compacted by then, so the final
  sync leaves the job's compacted partitions and removes any flush partitions the pusher shipped mid-step.
- **During the job (approach C):** `otel-html-setup` gains a `push-every` input (default off; `60s` in this repo). When
  set, it starts `otel-html ci pusher --every 60s …`, which detaches itself (`child_process.spawn` with
  `detached: true` and its stdio on a file under `.otel-html/`, so it works on Linux, macOS and Windows runners), waits
  for the job report's manifest to list a partition set that differs from the last synced one (mid-step: new flush
  partitions; at a step's end: the compacted one replacing them; `complete` toggling per step is not a signal), then
  runs one leased `ci push`. It dies with the job; the collect step's final push covers what it missed. A failing push is logged to the pusher's file and retried on the
  next tick, never to the job's step output, so the steps are unaffected and a broken pusher cannot fail a job.
- **Destination, chosen per run.** The pusher has two destinations with one sync behind them. **Branch**: check out
  gh-pages under the lease and push (needs `contents: write` on the job). **Artifact**: upload the batch of new
  partitions as a run artifact (`otel-html-push-<job id>-<n>`; needs no repository permission, only the runtime token
  every job has) and let the publisher apply it (§5.3a). The actions pick the branch destination only when the job's
  token has write permission on the repository **and** the run's actor is a person (not a bot such as Renovate); every
  other run, fork pull requests and bot branches included, uses the artifact destination. In this repo the
  report-producing jobs declare `permissions: { contents: write, actions: read }`; because bot runs never take the
  branch path, the code those tokens run beside is the repository's own. Decided by the maintainer on 2026-11-06.

### 5.3a The publisher tick (artifact destination)

`ci-report.yml` gains a second trigger beside `workflow_run: completed`: `workflow_run: in_progress` (one early tick
when a run starts) and a `schedule` every five minutes. A tick lists the runs in progress for the configured
workflows, downloads their `otel-html-push-*` artifacts not yet applied (the run report's manifest `source` entries say
which), runs the same `ci push` sync for each job, and pushes once under the lease. With nothing in progress it exits
in seconds. Its latency is GitHub's schedule (five minutes nominal, often delayed) plus the Pages deploy; the branch
destination's is the push interval plus the deploy. The end-of-run pass applies whatever the ticks missed, so the
artifact path can only be late, never lossy.

### 5.3 Deploying Pages after a push

Today only `ci-report.yml`'s `deploy` job deploys Pages, after the run completes, so a mid-run push would reach the
branch and not the site. A new `pages-deploy.yml` on `push: branches: [gh-pages]` deploys the tip in the existing
`pages` concurrency group, which keeps one pending deploy and replaces it, so a burst of pushes from several jobs
coalesces into one deploy at a time (about a minute each). The `deploy` job leaves `ci-report.yml`; the end-of-run
pass pushes and the new workflow deploys. This needs the `github-pages` environment's deployment branch policy to
admit `gh-pages` (a repository setting the maintainer changes; noted in §10). Rejected: GitHub's "deploy from branch"
build (a soft limit of ten builds an hour, which a 60 s tick across jobs would hit) and each job deploying itself
(`pages: write` and the environment gate on every report-producing job, which pull request runs cannot pass).

### 5.4 The end-of-run pass

`ci-report.yml` keeps its trigger (`workflow_run: completed`) and its write token, and `ci site` becomes a
reconciliation:

1. Download the run's artifacts (the only source for a fork pull request, and the fallback for a job whose pushes
   failed) and push any partition the run report does not list yet, as `ci push` would.
2. Write the **definitive CI spans** (workflow, jobs, steps) from the API, which now has final timings, replacing the
   provisional ones (§5.5).
3. `merge --compact` the run report into one sorted partition per signal, mark it `complete`, and rebuild the
   channel's rolling report by copy and compaction as the format-4 design says.
4. Link, preview, retention, deploy: unchanged.

### 5.5 The workflow trace while the run is going

`ci context` already fixes the run's trace id and each job's span id at job start and exports `TRACEPARENT`, so every
span a job emits is a child of the workflow trace from the first second. What arrives late is the parent rows, and
OTLP has no in-progress span. So:

- Each `ci push` writes this job's **CI-spans partition** from the jobs API: this job's span (start known, end `now`
  while the job runs, final at the collect push) and its steps that have completed, plus a **provisional workflow
  root** (start = the run's start, end = now). Rows that are not final carry `otel_html.ci.provisional = true`.
- A push **replaces** the job's previous CI-spans partition (`source: ci:<job id>`): the new one is written, the
  manifest swaps it in, the old file is deleted. No row is ever versioned inside the data, and the views carry no
  dedupe rule (format-4 §7.4). Several jobs each write a provisional root with the same span id; the viewer shows a
  trace with duplicate root rows only until the end-of-run pass replaces every job's CI-spans partition with the one
  definitive partition it writes, and the trace panel prefers a non-provisional row when ids collide, which is a
  display rule, not a query rule.
- Span ids are the deterministic ones `ci context` and `ci site` derive today, so a job's `run` root spans parent
  correctly under the job span whichever row of it is current.

Every row is a legitimate OTLP span with the `cicd.*` resource and attributes the workflow trace uses today; the only
addition is the `otel_html.ci.provisional` attribute, and a reader that ignores it sees, at worst, duplicate root rows
while the run is going rather than a broken trace.

### 5.6 OTLP fan-out

`run` and `serve` gain `--export-otlp <endpoint>` (config `receiver.exportOtlp`, with protocol from
`OTEL_EXPORTER_OTLP_PROTOCOL` semantics). Every accepted OTLP request is forwarded unchanged, as received, to that
endpoint over a standard OTLP/HTTP or gRPC client with a bounded queue; a full queue drops with a counter, a failure
is logged once per process, and nothing about forwarding affects what is written to the report or the answer to the
sender. This is the standards hook: a team with a collector or backend gets live data there while otel-html writes
the static report beside it, and otel-html is a pass-through, not a sink.

### 5.7 Viewer

A manifest with `complete: false` shows an "in progress, updated <time>" line in the page chrome with a **Refresh**
button that re-reads the manifest, registers partitions not yet registered, and re-runs the current queries through
the Coordinator; no page reload. Automatic polling is a per-session toggle on that line, off by default, and it polls
only the manifest. Nothing else in the viewer knows about publishing.

### 5.8 Targets

The dogfood design's publisher `target` interface (fetch current site, write files, delete paths) gains the
operations `ci push` needs (copy partition files, rewrite one manifest, rewrite `index.json`). `github-pages` is the
one target built here. An **object store** target (S3, R2, GCS) is the designed-for follow-up: the same operations,
no lease (object writes are atomic per key and the manifest is written last), no deploy step, and a viewer in `site`
format reading over range requests sees a push within seconds. `otel-html host` over a folder the pusher writes to
is the third shape and needs no target code at all.

## 6. Latency, from a partition being written to it being visible

| Path | Latency | Bound by |
| --- | --- | --- |
| Today | the rest of the run plus 2 to 5 min | the end-of-run publisher |
| B, job end | the rest of the job plus about 1 min | the Pages deploy |
| C, pusher, branch destination | about 1 to 2 min | the push interval plus the Pages deploy |
| C, pusher, artifact destination | about 5 to 10 min | GitHub's schedule plus the Pages deploy |
| E, object store | seconds | the push interval |
| E, `host` | the flush interval (5 s default) | nothing else |

## 7. Security

- The job token widening (§5.2) is the one new right: a same-repo job can push gh-pages. Fork runs cannot, and the
  publisher never runs their code with a write token, as today.
- Bot branches (Renovate) are same-repo and would otherwise run third-party dependency code under the job's write
  token. They never take the branch destination (§5.2): the actor check routes them to artifacts, so the token is held
  only while the repository's own code runs. Job-level `permissions` cannot be conditional, so the token exists on bot
  runs too; what the design guarantees is that otel-html never uses it there, not that the dependency code could not.
  The maintainer accepted that residual on 2026-11-06, with `main` protected by its ruleset.
- Provisional spans are plain spans; a consumer that ignores the attribute sees duplicates, not corruption.
- OTLP fan-out sends telemetry to an endpoint the operator configured; the endpoint is never taken from a request.
- `ci push` writes only under `<channel>/runs/<run id>/` and the run's `index.json` entry; paths are validated as the
  manifest's layout regexes validate them.

## 8. Tests

- Unit: `ci push` idempotency (a second push with the same report changes nothing), manifest append with statistics,
  deterministic partition folder names, provisional span emission from a jobs-API fixture, the `spans` view's version
  rule against provisional and definitive rows, the fan-out client's bounded queue.
- `actions-smoke.yml` gains a leg, on a Linux and a Windows runner, that runs a job with `push-every` against a scratch
  gh-pages checkout and asserts the run report lists the job's partitions before the job ends, and lists only the
  compacted ones after a step ends.
- e2e: a fixture report with provisional CI spans renders the trace with one root and shows the in-progress line and
  Refresh; after a second manifest is served, Refresh shows the new partition's rows.

## 9. Milestones

1. `ci push`, the collect-step push (approach B), provisional and definitive CI spans, `ci site` as reconciliation.
2. The detached pusher (approach C), the in-progress line and Refresh.
3. OTLP fan-out.
4. The object store target.

Milestone 1 includes both destinations and the publisher tick (§5.3a), since the per-run choice is what makes the
token decision acceptable.

## 10. Decisions settled in conversation

- Direction approved on 2026-11-06: per-job incremental publishing, during the run from a background process, with
  OpenTelemetry at every integration point.
- The workflow trace is "opened" at run start as OTel does it (ids fixed and propagated); parent spans are emitted
  provisionally and superseded by replacing the partition that holds them.
- Maintainer action: admit `gh-pages` in the `github-pages` environment's deployment branch policy (§5.3).
- Destination per run: branch push for a person's same-repo run, artifact plus publisher tick for everything else
  (2026-11-06).

## 11. Designer's calls (flag if wrong)

- Report-producing jobs declare `contents: write`; the actions use it only for a person's same-repo run.
- `ci push` is a CLI subcommand invoked by the actions under the existing lease script, not a new action; it syncs a
  job's live partition set rather than appending (builder check: a step's `close()` compaction would otherwise double
  every row the pusher shipped mid-step).
- A `pages-deploy.yml` on `push: branches: [gh-pages]` in the `pages` group deploys; the `deploy` job leaves
  `ci-report.yml`.
- The pusher detaches itself from the CLI, so Windows runners are covered.
- A pusher failure never fails the job; it is logged to a file under `.otel-html/` and surfaced as a job notice.
- `push-every` defaults off; this repo sets 60 s.
- The provisional attribute name `otel_html.ci.provisional`.
- Refresh is manual by default; polling is an opt-in toggle.

## 12. Left to the builder

- How `ci push` knows which partitions are new (manifest diff by deterministic folder name is the suggestion).
- The pusher's wait strategy (manifest mtime poll versus filesystem watch) and its log format.
- The fan-out client's queue size and retry policy, and whether gRPC fan-out ships with HTTP or after.
- The target interface's exact operations once the object store target is attempted.
