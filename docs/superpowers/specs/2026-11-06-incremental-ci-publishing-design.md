# Incremental CI publishing: a run's report grows while the run is going

Status: design, direction approved in conversation on 2026-11-06. Builds on the format-4 design
(`2026-11-06-parquet-duckdb-format-4-design.md`): partitions, the `spans` view's version rule, `assetsBase` and the
`site` output format are assumed, and nothing here ships before milestone 1 of that design.

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
- A viewer that follows a run by itself. A Refresh affordance is in scope (§5.6); polling is left optional.
- In-progress span records in OTLP. There are none; the provisional root is a real span re-emitted (§5.4).

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

It copies every partition of the job's report that the site's run report does not list yet into
`<channel>/runs/<run id>/data/partitions/<job id>-<n6>/`, appends their manifest entries (statistics included, copied
from the job report's manifest), writes or refreshes the run report's `index.html` and the channel's `index.json`
entry for the run (conclusion `in_progress`), and writes one small partition of **CI spans** (§5.4). It writes nothing
else: no compaction, no rolling report, no link, no preview. Partition folders are named deterministically from the
job id and the job report's partition number, so a push is idempotent and a retry under the lease starts from the
tip and skips what is already there. A push with nothing new prints `pushed=false` and the lease script does not
push (its existing `push-when` mechanism).

The run report's manifest while the run is going has `complete: false` and an `updatedAt` per push; the viewer shows
"in progress, updated <time>" from it.

### 5.2 When pushes happen, and with what token

- **At job end (approach B):** `otel-html-collect` gains a `publish` input. When set, after the artifact upload it
  checks out gh-pages under the lease and runs `ci push`. Partitions written by `run` are already closed and sorted,
  so the job's report is in its final per-job shape.
- **During the job (approach C):** `otel-html-setup` gains a `push-every` input (default off; `60s` in this repo). When
  set, it starts `otel-html ci pusher --every 60s …` detached (`setsid`, output to a file under `.otel-html/`), which
  waits for the report's manifest to list new partitions, then runs one leased `ci push`. It dies with the job; the
  collect step's final push covers what it missed. A failing push is logged to the pusher's file and retried on the
  next tick, never to the job's step output, so the steps are unaffected and a broken pusher cannot fail a job.
- **Token:** both need `contents: write` on the job. In this repo the jobs that produce reports declare
  `permissions: { contents: write, actions: read }`; every other job keeps read-only. A fork pull request's run has a
  read-only token whatever the workflow declares, the actions detect that (no write permission on the repository) and
  skip pushing with a notice; its report arrives from the end-of-run publisher as today. This is a widening of what a
  same-repo CI job may do (push to gh-pages) and is the designer's call to flag first (§10).

### 5.3 The end-of-run pass

`ci-report.yml` keeps its trigger (`workflow_run: completed`) and its write token, and `ci site` becomes a
reconciliation:

1. Download the run's artifacts (the only source for a fork pull request, and the fallback for a job whose pushes
   failed) and push any partition the run report does not list yet, as `ci push` would.
2. Write the **definitive CI spans** (workflow, jobs, steps) from the API, which now has final timings, replacing the
   provisional ones (§5.4).
3. `merge --compact` the run report into one sorted partition per signal, mark it `complete`, and rebuild the
   channel's rolling report by copy and compaction as the format-4 design says.
4. Link, preview, retention, deploy: unchanged.

### 5.4 The workflow trace while the run is going

`ci context` already fixes the run's trace id and each job's span id at job start and exports `TRACEPARENT`, so every
span a job emits is a child of the workflow trace from the first second. What arrives late is the parent rows, and
OTLP has no in-progress span. So:

- Each `ci push` writes a CI-spans partition from the jobs API: this job's span (start known, end `now` while the job
  runs, final at the collect push) and its steps that have completed, plus a **provisional workflow root** (start =
  the run's start, end = now). All carry `otel_html.ci.provisional = true` except a job span written at job end and
  steps that have completed.
- The format-4 `spans` view keeps, per `(trace_id, span_id)`, the latest non-provisional row, else the latest
  provisional one, so each push supersedes the previous provisional rows without touching earlier partitions, and the
  end-of-run pass's definitive rows win over everything. Compaction drops superseded rows.
- Span ids are the deterministic ones `ci context` and `ci site` derive today, so a job's `run` root spans parent
  correctly under the job span whichever row of it is current.

Every row is a legitimate OTLP span with the `cicd.*` resource and attributes the workflow trace uses today; the only
addition is the `otel_html.ci.provisional` attribute, and a reader that ignores it sees a trace with duplicate spans
rather than a broken one.

### 5.5 OTLP fan-out

`run` and `serve` gain `--export-otlp <endpoint>` (config `receiver.exportOtlp`, with protocol from
`OTEL_EXPORTER_OTLP_PROTOCOL` semantics). Every accepted OTLP request is forwarded unchanged, as received, to that
endpoint over a standard OTLP/HTTP or gRPC client with a bounded queue; a full queue drops with a counter, a failure
is logged once per process, and nothing about forwarding affects what is written to the report or the answer to the
sender. This is the standards hook: a team with a collector or backend gets live data there while otel-html writes
the static report beside it, and otel-html is a pass-through, not a sink.

### 5.6 Viewer

A manifest with `complete: false` shows an "in progress, updated <time>" line in the page chrome with a **Refresh**
button that re-reads the manifest, registers partitions not yet registered, and re-runs the current queries through
the Coordinator; no page reload. Automatic polling is a per-session toggle on that line, off by default, and it polls
only the manifest. Nothing else in the viewer knows about publishing.

### 5.7 Targets

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
| C, pusher | about 1 to 2 min | the push interval plus the Pages deploy |
| E, object store | seconds | the push interval |
| E, `host` | the flush interval (5 s default) | nothing else |

## 7. Security

- The job token widening (§5.2) is the one new right: a same-repo job can push gh-pages. Fork runs cannot, and the
  publisher never runs their code with a write token, as today.
- Provisional spans are plain spans; a consumer that ignores the attribute sees duplicates, not corruption.
- OTLP fan-out sends telemetry to an endpoint the operator configured; the endpoint is never taken from a request.
- `ci push` writes only under `<channel>/runs/<run id>/` and the run's `index.json` entry; paths are validated as the
  manifest's layout regexes validate them.

## 8. Tests

- Unit: `ci push` idempotency (a second push with the same report changes nothing), manifest append with statistics,
  deterministic partition folder names, provisional span emission from a jobs-API fixture, the `spans` view's version
  rule against provisional and definitive rows, the fan-out client's bounded queue.
- `actions-smoke.yml` gains a leg that runs a job with `push-every` against a scratch gh-pages checkout and asserts the
  run report lists the job's partitions before the job ends.
- e2e: a fixture report with provisional CI spans renders the trace with one root and shows the in-progress line and
  Refresh; after a second manifest is served, Refresh shows the new partition's rows.

## 9. Milestones

1. `ci push`, the collect-step push (approach B), provisional and definitive CI spans, `ci site` as reconciliation.
2. The detached pusher (approach C), the in-progress line and Refresh.
3. OTLP fan-out.
4. The object store target.

If write tokens on jobs are refused (§10), milestone 1 is rebuilt as approach D (mid-run artifact uploads from the
pusher and a `schedule`d publisher tick) with the latency that implies.

## 10. Decisions settled in conversation

- Direction approved on 2026-11-06: per-job incremental publishing, during the run from a background process, with
  OpenTelemetry at every integration point.
- The workflow trace is "opened" at run start as OTel does it (ids fixed and propagated); parent spans are emitted
  provisionally and superseded, resolved by the `spans` view.

## 11. Designer's calls (flag if wrong)

- Same-repo report-producing jobs get `contents: write`; fork runs fall back to the end-of-run path.
- `ci push` is a CLI subcommand invoked by the actions under the existing lease script, not a new action.
- A pusher failure never fails the job; it is logged to a file under `.otel-html/` and surfaced as a job notice.
- `push-every` defaults off; this repo sets 60 s.
- The provisional attribute name `otel_html.ci.provisional`.
- Refresh is manual by default; polling is an opt-in toggle.

## 12. Left to the builder

- How `ci push` knows which partitions are new (manifest diff by deterministic folder name is the suggestion).
- The pusher's wait strategy (manifest mtime poll versus filesystem watch) and its log format.
- The fan-out client's queue size and retry policy, and whether gRPC fan-out ships with HTTP or after.
- The target interface's exact operations once the object store target is attempted.
