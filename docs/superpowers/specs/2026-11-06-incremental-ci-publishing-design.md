# Incremental CI publishing: a run's report grows while the run is going

Status: design, direction approved in conversation on 2026-11-06; revised on 2026-11-07 to drop the `gh-pages` branch
(§1a). Builds on the format-4 design (`2026-11-06-parquet-duckdb-format-4-design.md`): partitions, the "immutable
partitions, live set in the manifest" rule, the `source` field, `assetsBase` and the `site` output format are assumed,
and nothing here ships before the format-4 bump release.

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

## 1a. Revision 2026-11-07: the site leaves git

The `gh-pages` branch is the site's store today: one orphan commit replaced on every publish. It is about 149 MiB
compressed against `main`'s 3.7 MiB of history, so a plain `git clone` of the repository is 155 MB instead of 4 MB, and
every publish or cleanup spends about a minute fetching it (60 s in a cleanup that found nothing to remove, run
42338822201). The maintainer chose (2026-11-07) to deploy Pages from a build artifact and delete the branch, to keep
the site in this repository's Pages rather than a second repository, to stay on GitHub Pages for now (the object store
target, §5.8, stays planned), and to build the change into this design rather than retrofit the current publisher
first.

What that changes:

- A Pages deployment replaces the whole site; there is no "add these files" operation. So no job writes the site.
  Jobs upload **site updates** as artifacts, and one **deployer** (§5.3) is the only writer: it takes the last
  deployed site, applies every pending update, and deploys the result.
- The deployer's starting point is the **artifact of the last successful Pages deployment**, which is byte for byte
  what Pages serves. It is not the live site over HTTPS: Pages serves `cache-control: max-age=600` through Fastly, and
  a unique query string still returned `x-cache: HIT` with the same `age` (checked 2026-11-07), so a download can be
  up to ten minutes stale with no sign of it, and building on it would silently drop the previous deployment's
  updates. The live site is read only on a cold start (§5.3), when nothing has deployed for longer than the cache can
  hold. Accepted by the maintainer on 2026-11-07.
- The lease, `site-lease.sh`, `site-branch.sh`, the per-run branch-or-artifact destination choice and the
  `contents: write` token on report-producing jobs all go away.

Until this ships, the README tells contributors to clone with `--single-branch`, which skips `gh-pages` (4.2 MB)
(PR #218). That paragraph is removed in the PR that deletes the branch.

## 2. Goals, non-goals, anti-goals

Goals

- A job's partitions reach the site within about a minute of being written, without adding time to the job's steps.
- The run's report on the site is valid and openable at every moment, and complete and compacted after the run.
- Jobs that finish early are in the report while the others run; the workflow trace shows them under a provisional
  root.
- Fork pull requests, which have no write token, still get today's end-of-run report.
- The end-of-run pass becomes reconciliation and compaction rather than the only publishing path.
- OTLP fan-out: what the receiver accepts can be forwarded unchanged to a collector or backend.
- No site content in git: a clone of the repository is its source and history only, and no job fetches the site
  with git.

Non-goals

- Seconds-level liveness on GitHub Pages. Pages deploys one site at a time and takes about a minute; the design works
  within that and names the targets where seconds are possible (§6).
- A viewer that follows a run by itself. A Refresh affordance is in scope (§5.7); polling is left optional.
- In-progress span records in OTLP. There are none; the provisional root is a real span re-emitted in a replaced
  partition (§5.5).
- A second repository for the site.

Anti-goals

- Slowing a step by even a second: publishing is another process's I/O.
- A second data path: the same partitions, manifest and views as any format-4 report.
- Racing Pages deployments: the single `pages` concurrency group stays the only deployer.
- Widening what a fork pull request's run can do.
- Treating a CDN copy, or a cache that can evict, as the site's state.
- An update lost because a deploy was cancelled, failed or ran concurrently with a job's upload.

## 3. Constraints

- `ci.yml` runs jobs with a read-only token (`permissions: contents: read, actions: read`). A fork pull request's
  token is read-only whatever the workflow asks for.
- A Pages deployment (`actions/upload-pages-artifact` + `actions/deploy-pages`) replaces the whole site with one
  tarball artifact named `github-pages`; it needs `pages: write`, `id-token: write` and the `github-pages`
  environment, whose branch policy admits the default branch. Today's artifacts are about 179 MB with the default
  one-day retention; `retention-days` goes up to 90. It leaves out hidden files unless `include-hidden-files: true`.
  An artifact is an opaque archive: the API lists artifacts but not the files inside one. The published site limit
  is 1 GB.
- Pages deploys one at a time in the `pages` concurrency group, about a minute each. GitHub keeps one pending run per
  group and cancels an older pending one when a newer one queues (`cancel-in-progress: false` protects only the
  running one).
- The live site is served with `max-age=600` and the CDN ignores query strings (§1a).
- A workflow run started by `GITHUB_TOKEN` creates no new run, except `workflow_dispatch` and `repository_dispatch`;
  dispatching needs `actions: write` on the token.
- GitHub Actions kills a job's processes when the job ends and keeps a detached process (`setsid`) alive across steps
  until then; steps within a job run sequentially.
- The publisher must not run a pull request's code with a write token (dogfood design §6.1). The deployer runs the
  default branch's code only and treats every update artifact as untrusted data (§7).
- The site index (`index.json`), channels, retention and the rolling report keep their shapes.
- Under the job shell every `run:` step is its own `otel-html run` process, so `close()` compacts a step's flush
  partitions at the end of every step, and a job report's manifest flips `complete` once per step.
- Windows runners exist in `ci.yml` and `actions-smoke.yml`.

## 4. Approaches considered

- **A. End of run only** (today). Simple; nothing visible until the end; cost grows with the run. Kept as the
  fallback path for fork pull requests and as the final reconciliation.
- **B. Each job publishes at its end.** The collect step uploads the job's partitions as a site update. The report
  grows as jobs finish.
- **C. A background pusher during the job.** A detached process started by `otel-html-setup` uploads new partitions
  every minute as site updates. Same mechanism as B plus a process the steps do not wait for.
- **D. A scheduled publisher tick.** Before the 2026-11-07 revision this was the fallback for runs without a write
  token. It is now the backstop for every update whose dispatch did not happen (§5.2).
- **E. Object store or `otel-html host` as the target.** Seconds-level liveness, no deploy step. The right answer
  where that infrastructure exists; out of scope for GitHub Pages, in scope as a target (§6).
- Rejected on 2026-11-07: jobs deploying Pages themselves (a deploy replaces the whole site, so each job would need
  the whole site, two concurrent deploys lose one job's partitions, and pull request runs cannot pass the environment
  gate); the live site over HTTPS as the deployer's base (stale for up to ten minutes, §1a); the Actions cache as the
  store (it evicts); a second repository for the site (the maintainer's call).

Choice: B first, C on top of it, A kept, D as the backstop, all through one deployer; E through the target interface.

## 5. Design

### 5.1 Site updates and `otel-html ci push`

A **site update** is an artifact a job or the end-of-run pass uploads and only the deployer applies. It holds a small
`update.json` (kind, run id, run attempt, job id, sequence number, created-at) beside the files it carries. Names are
unique per run, as `upload-artifact` v4 requires: `otel-html-update-push-<job id>-<sequence>`,
`otel-html-update-run-<run id>-<attempt>`, `otel-html-update-remove-pr-<number>-<run id>`,
`otel-html-update-reopen-pr-<number>-<run id>`. Kinds:

- `push`: one job's live partition set and its CI-spans partition (§5.5), from a collect step or the pusher. It
  **lists** the job's whole live set (sources and manifest entries) and **carries** the files of the partitions it is
  the first to ship; partitions are immutable, so an earlier update or the site already has the rest.
- `run`: the end-of-run reconciliation for one run (§5.4), self-contained.
- `remove-pr` and `reopen-pr`: a pull request closed or reopened (today's `cleanup-pr`).

`otel-html ci push` keeps its meaning but runs **in the deployer**, against the site directory the deployer is
assembling, with one job's pending `push` updates as input:

```
otel-html ci push --updates <unpacked update dirs> --site <site dir> --channel <channel> --run <run id> --job <job id>
```

It is a **sync**, not an append: after it, the site's run report lists, for this job, exactly the partitions the
newest of those updates (highest sequence) lists, plus the job's CI-spans partition. Each listed partition's files
come from the site if it has them, otherwise from any of the job's updates, older ones included. When a listed
partition's files are in neither, the job's updates stay **pending** and are not applied in this pass (an older
update still uploading, §5.2); nothing is ever listed without its files. New partitions go into
`<channel>/runs/<run id>/data/partitions/<p6>/`, where `<p6>` comes from a per-run high-water mark kept in the run
manifest and is never reused, so no path ever names two different files (a CDN can hold an old file at a reused path,
§5.7). The sync drops from the run manifest every partition of this job whose `source` the newest update no longer
lists (a step's `close()` compacted its flush partitions), writes the manifest, and schedules the dropped files for
**deferred deletion** (§5.3). It refreshes the run report's `index.html` and the channel's `index.json` entry
(conclusion `in_progress`) and writes nothing else: no compaction across jobs, no rolling report, no link, no
preview. Matching on `source` makes applying updates idempotent, and taking the listing from the highest sequence makes
out-of-order arrival converge on the newest.

The run report's manifest while the run is going has `complete: false` and an `updatedAt` per push; the viewer shows
"in progress, updated <time>" from it.

### 5.2 When jobs upload, and how the deployer hears about it

- **At job end (approach B):** `otel-html-collect` gains a `publish` input. When set, it first stops the pusher (if
  one runs) and waits for its in-flight upload to finish, then uploads a final `push` update whose sequence is above
  any the pusher used. Every step's `close()` has compacted by then, so the final sync leaves the job's compacted
  partitions and removes any flush partitions an earlier update shipped mid-step. "The first to ship" a partition
  (§5.1) means the first update whose upload **finished**; the pusher and the collect step record finished uploads
  in one file under `.otel-html/` in the job's workspace, so a failed upload's partitions ship again in the next
  update. The collect step also reads the
  pusher's log file and turns its failures into one job notice.
- **During the job (approach C):** `otel-html-setup` gains a `push-every` input (default off; `60s` in this repo).
  When set, it starts `otel-html ci pusher --every 60s …`, which detaches itself (`child_process.spawn` with
  `detached: true` and its stdio on a file under `.otel-html/` in the job's workspace, so it works on Linux, macOS and
  Windows runners), waits for the job report's manifest to list a partition set that differs from the last uploaded
  one (mid-step: new flush partitions; at a step's end: the compacted one replacing them; `complete` toggling per step
  is not a signal), then uploads one `push` update. Uploading only on change keeps a job under the 500-artifacts-per-job
  limit (a six-hour job at 60 s would otherwise come close). It dies with the job; the collect step's final update
  covers what it missed. A failing upload is logged to the pusher's file and retried on the next tick, never to the
  job's step output, so the steps are unaffected and a broken pusher cannot fail a job. The artifact upload needs
  `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL`, which the runner gives only to JavaScript actions, not to `run:`
  steps or the composite `otel-html-setup`. So `otel-html-setup` gains one pinned JavaScript step
  (`actions/github-script`) that starts the pusher with those two values in the pusher's environment only (never
  `GITHUB_ENV`), and the CLI carries the artifact client in its bundle and binaries. This is milestone 2's first task,
  proven on a Linux and a Windows runner before anything is built on it; if it fails, approach C waits and B alone
  ships.
- **Waking the deployer.** After an upload, the uploader dispatches the deployer (`workflow_dispatch` on the workflow
  the `deployer-workflow` input names, `pages-deploy.yml` in this repo) when the run is a same-repo run and its actor
  is a person: the run's `actor.type` from the Actions API is `User`, the rule `ci-report.yml` already uses for
  `workflow_run.actor.type` (so Renovate, `[bot]` actors and merge-queue bots never dispatch). A job cannot inspect
  its token's permissions, so it tries; a 403 or any other failure is a log line, never a failed step. Every other
  run, fork pull requests and bot branches included, only uploads; the deployer's schedule tick and the end-of-run pass
  pick those updates up. In this repo the report-producing jobs declare
  `permissions: { contents: read, actions: write }`.

Uploading needs no repository permission (the runtime token every job has), so every run, forks included, takes the
same path; only the wake-up differs. `publish` and `push-every` need a deployer workflow in the repository (§5.9); a
repository with only the single-job `deploy: true` publisher gets its updates applied at the next run's end.

### 5.3 The deployer

`pages-deploy.yml` runs from the default branch's code. Triggers: `workflow_dispatch` (from jobs, §5.2),
`workflow_run: completed` on `ci-report` (the end-of-run pass, §5.4), and a `schedule` every five minutes. It has two
jobs:

- **`plan`**, outside any concurrency group, with `actions: read` and `deployments: read`: lists pending updates (step 1 below) and outputs
  whether there are any. It is cheap and never cancelled by a burst.
- **`deploy`**, `needs: plan`, only when something is pending, in the `pages` concurrency group
  (`cancel-in-progress: false`), with `contents: read` (its own checkout, the migration's `gh-pages` read),
  `deployments: read` (finding the last successful deployment), `actions: write` (downloading artifacts, pruning),
  `pages: write`, `id-token: write` and the `github-pages` environment. It lists pending again (the listing may have
  grown while it waited) and runs the pass. A pending `deploy` that GitHub cancels in favour of a newer one loses
  nothing: the newer one lists everything pending, the cancelled one's updates included.

The site's state lives in **`site-state/`** at the site root, not a dot folder (`upload-pages-artifact` drops hidden
files unless told otherwise): `applied.json` (the ids of every **consumed** update artifact, whether it was applied,
dropped as superseded, dropped for a removed pull request or a complete attempt, or rejected by §7; plus the newest
sequence applied per job), `removed.json` (closed pull requests), `files.json` (every path in the site with its size), and `deletions.json`
(dropped files with the time they were dropped). Every deploy also uploads `site-state/` alone as a small artifact,
`otel-html-site-state`, in the same run as its `github-pages` artifact. A pass:

1. **Pending.** Find the last successful deployment (below) and download the **current site state**. A state file has
   one of two forms:
   - **full**, uploaded by a pass that deploys, before `deploy-pages` runs, so it cannot know its own deployment's
     id: it records only its run id, and it counts only if that run made the last successful deployment;
   - **consumed-only**, uploaded by a pass that consumed updates without deploying (step 5): it carries a `base`
     field, the id of the deployment it was built on, and it counts only if that is the last successful deployment.

   The current state is the newest counting one; a failed pass's full state never counts, because its run made no
   successful deployment. The deployer workflow is never re-run (the first step of each of its jobs, `deploy`
   included, fails when `github.run_attempt` is above 1, since "re-run failed jobs" re-runs `deploy` alone with
   `plan`'s old outputs; a dispatch or the tick starts a fresh run), because the artifact API does not say which attempt uploaded
   an artifact, and a failed re-run of a run that once deployed would otherwise leave state and a site that never went
   live inside a run that "made the deployment". The `deploy` job does its own lookup when it starts, never reusing
   `plan`'s (another pass may have deployed while it waited), and overwrites the base tarball's `site-state/` with the
   current state before applying. If the state artifact is missing (pruned or deleted) while the `github-pages`
   artifact exists, `deploy` uses the base tarball's `site-state/`. Then list the repository's `otel-html-update-*` artifacts and keep those not in `applied.json`. The listing is paginated
   and has no name filter, so it stops at a creation-time floor kept in `applied.json`: the `created_at` of the oldest
   update still pending after the previous pass (or that pass's own start when none was), minus one hour. An
   artifact's `created_at` is when its upload started, and it is listed only once the upload finishes, so the margin
   must be longer than any upload takes; a floor set at the newest `created_at` seen would skip a slow upload for
   good. When the deployment has no `otel-html-site-state` artifact (the old publisher's last deploy, or a cold start),
   `plan` reads `site-state/applied.json` from the live site (possibly up to ten minutes stale, which costs at most a
   no-op pass), and if that is missing too, everything is pending.
   **Nothing pending: the pass exits** without downloading the site, uploading or deploying. An idle tick, or a
   dispatch whose update an earlier pass consumed, costs the listing and one small download.
2. **Base.** Download the `github-pages` artifact of the last successful deployment and unpack it. Pages serves exactly
   that artifact, so the base is the live site without the CDN in between. The last successful deployment is the
   repository's newest `github-pages` environment deployment that has a `success` status anywhere in its status
   history (GitHub marks a deployment `inactive` once a newer one succeeds), whichever workflow made it; its workflow
   run's `github-pages` artifact is the base (one per run, since the deployer is never re-run, step 1). Every workflow that
   deploys the site uses the `pages` concurrency group, so two deploying workflows (§5.9) still run one pass at a time.
3. **Apply.** In order: `remove-pr` and `reopen-pr` updates (by creation time), then `push` updates (one `ci push` per
   run and job), then `run` updates. A pull request in `removed.json` stays removed: an update for it is dropped, so a
   cleaned-up pull request is never brought back, until a `reopen-pr` update clears the entry. Whether a run is
   `complete` is read from the base's run manifest, not from the update. Retention, the rolling report and previews
   run only in a pass that applies a `run` update, for that update's channel (§5.4); a pass of `push` updates touches
   only the runs' own folders.
4. **Delete what is due.** A file dropped from a manifest goes into `deletions.json` with the pass that dropped it,
   and gets its time when that pass's deploy goes live (the base's deployment time, read by the next pass). Files whose
   drop went live at least 15 minutes ago (longer than the CDN's 600 s) are deleted; newer ones stay. A reader still
   holding the previous manifest therefore never requests a file the site has already lost. Retention and `remove-pr`
   delete through the same list.
5. **Record and deploy.** If the pass changed nothing in the site and consumed nothing (every pending update is still
   waiting for files, and no deletion fell due), it records nothing and does not deploy: an update that waits costs a
   full base download per tick, never a deploy. The wait is short, lasting only until the earlier update that carries
   the files finishes uploading and is listed. If the site changed, write `site-state/`, upload the site with
   `actions/upload-pages-artifact` (`retention-days: 90`) and `site-state/` as `otel-html-site-state` (same
   retention), and deploy. A pass that only consumed updates without changing the site uploads
   `otel-html-site-state` alone, naming the unchanged deployment as its `base`, so those updates stop being pending
   without a deploy.
6. **Prune**, in a step with `continue-on-error`, so a pruning failure never marks a live deployment failed: delete
   `github-pages` and `otel-html-site-state` artifacts older than the newest three **successful** deployments (a failed
   pass's artifacts are deleted too, and never count as kept), and delete update artifacts that the oldest kept
   successful deployment's `applied.json` lists (so falling back to an older base never meets an update that is
   gone), removing their ids from `applied.json` on the next pass.

Why nothing is lost:

- Only the deployer deploys, and the `pages` group runs one `deploy` at a time, so a pass's base is always the previous
  pass's output.
- A pass is a pure function of (base, pending updates). A pass cancelled while pending, or a deploy that failed, left
  the deployed site unchanged and the updates still pending; the next pass applies them. Nothing is marked consumed
  until a successful deployment's full state, or a consumed-only state naming that deployment, records it.
- An update uploaded while a pass runs is not in that pass's listing, or is listed but incomplete (§5.1); either way it
  stays pending for the next pass, which its own dispatch (or the tick) queues.

**The base, in order:**

1. a successful deployment's `github-pages` artifact exists: use it;
2. otherwise the live site serves `site-state/files.json`: **cold start**, fetching every listed path over HTTPS.
   Nothing has deployed for at least ten minutes at that point, so the CDN cannot be stale; a cold start that finds a
   deployment younger than ten minutes waits until it is older;
3. otherwise the site was built by the old publisher: **migration**, which reads the `gh-pages` branch tip (shallow,
   once) as the base. No `gh-pages` branch either: start from an empty site.

This repository's Pages source is already "GitHub Actions" (today's `deploy` job uses `actions/deploy-pages`), so its
first pass normally takes case 1, the old deploy job's last artifact (which has no `site-state/`: everything is then
pending once, and applying is idempotent); case 3 covers that artifact having expired (one-day retention today). The
maintainer deletes `gh-pages` after the first pass on this design deploys. Reports on the site in formats 1 to 3 stay
as they are: each report folder carries its own viewer, so they keep opening. A rolling report rebuild that meets one
converts it with `merge`, which reads formats 1 to 3 (format-4 plan 1).

GitHub disables a public repository's scheduled workflows after 60 days without activity, and runs schedules late
under load (often 10 to 30 minutes). Neither loses an update: the next dispatch or end-of-run pass applies everything
pending. The 90-day cold start does not depend on ticks.

Cost per pass that deploys: download and upload of the whole site (about 179 MB today; smaller in format 4) plus the
deploy. Passes coalesce under the `pages` group, so a burst of job updates costs one or two passes, not one per update.

### 5.4 The end-of-run pass

`ci-report.yml` keeps its trigger (`workflow_run: completed`) and its `report` job, which no longer touches the site.
Its permissions drop `contents: write` and keep `actions: read`, `pages: read`, `pull-requests: write` and
`checks: write`; the `deploy` job and the lease comments go. The `report` job:

1. Downloads the run's job artifacts (the only source for a fork pull request, and the fallback for a job whose
   updates failed) and the run's jobs from the API.
2. Writes the **definitive CI spans** (workflow, jobs, steps) from the API, which now has final timings (§5.5).
3. Builds the run report, `merge --compact`s it into one sorted partition per signal, marked `complete`, and uploads
   it as a `run` update.
4. Links (sticky comment, check run): the report URL is deterministic, so the link is posted as today, before the
   deploy that makes it live, about a minute later.

The `cleanup` job (`pull_request_target: closed`, and now `reopened`) uploads a `remove-pr` or `reopen-pr` update and
needs no repository permission.

The deployer applies a `run` update by replacing the run report (scheduling every `push` partition and CI-spans
partition for that run for deferred deletion), then applies retention, rebuilds the channel's rolling report by copy
and compaction as the format-4 design says, and on a default-branch channel takes the README previews. Those need the
whole channel, which only the deployer has. A `run` update for a run whose `push` updates arrive later (a slow tick)
wins: `push` updates for an attempt whose run manifest in the base is `complete` are dropped.

**Re-runs.** A run report shows the newest attempt, as the site index does today (`attempt` per run). Every update
carries its run attempt. The first update for a newer attempt reopens the report (`complete: false`) and drops only
the partitions of the jobs that attempt runs again. Job ids are new on every attempt, so "the same job" is matched by
job name (with its matrix values) from the jobs API, for both its `job:<id>` and `ci:<job id>` sources; jobs that passed and are not re-run keep theirs, so a "re-run
failed jobs" does not empty the report. Updates for an older attempt than the report's are dropped. "Complete" above
means complete for the update's attempt, so a re-run after the run was complete is published, not dropped.

### 5.5 The workflow trace while the run is going

`ci context` already fixes the run's trace id and each job's span id at job start and exports `TRACEPARENT`, so every
span a job emits is a child of the workflow trace from the first second. What arrives late is the parent rows, and
OTLP has no in-progress span. So:

- Each `push` update carries this job's **CI-spans partition** from the jobs API: this job's span (start known, end
  `now` while the job runs, final at the collect upload) and its steps that have completed, plus a **provisional
  workflow root** (start = the run's start, end = now). Rows that are not final carry
  `otel_html.ci.provisional = true`.
- Applying a push **replaces** the job's previous CI-spans partition (`source: ci:<job id>`): the new one is written,
  the manifest swaps it in, the old file goes to deferred deletion (§5.3). No row is ever versioned inside the data, and the views carry no
  dedupe rule (format-4 §7.4). Several jobs each write a provisional root with the same span id; the viewer shows a
  trace with duplicate root rows only until the `run` update replaces every job's CI-spans partition with the one
  definitive partition, and the trace panel prefers a non-provisional row when ids collide, which is a display rule,
  not a query rule.
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
button that re-reads the manifest, **replaces** the registered partition set with the manifest's list (registering
new partitions and unregistering dropped ones, so a step's compaction never counts rows twice), and re-runs the
current queries through the Coordinator; no page reload. A 404 on a listed partition (a tab left open past the
deferred deletion, §5.3) shows "this report has changed: Refresh", not an error. Automatic polling is a per-session toggle on that line, off by default, and it polls
only the manifest. The manifest is served with Pages' `max-age=600`, so Refresh fetches it with `cache: 'no-store'`;
whether the CDN then answers fresh is the open question the builder checks (§12), and the line says how old the
manifest it read is. Nothing else in the viewer knows about publishing.

### 5.8 Targets

The dogfood design's publisher `target` interface (fetch current site, write files, delete paths) becomes the
deployer's: **base** (§5.3 step 2), **apply** (the site directory operations `ci push` and the `run` update need),
**commit** (deploy). `github-pages` is the one target built here. An **object store** target (S3, R2, GCS) is the
designed-for follow-up and stays planned: base and commit become per-key reads and writes, no whole-site upload, no
deploy step, the manifest written last, and a viewer in `site` format reading over range requests sees an update
within seconds; the deployer then has nothing to coalesce. `otel-html host` over a folder updates are applied to is
the third shape and needs no target code at all.

### 5.9 The published action

`otel-html-publish` keeps its inputs where they still mean something. `target: github-pages` builds the run report,
uploads a `run` update and links it; it no longer deploys, so its `deploy` input goes. The deploy pass is a new
action, **`otel-html-deploy`**, used by a job of its own: the `deploy` job of `pages-deploy.yml` here, or, in a user's
single workflow, a job that `needs:` the publishing job and sits in the `pages` concurrency group with the deploy
permissions and environment. A deploy pass never runs in the job that builds the report: a job in the `pages` group
waits as pending before its first step, and GitHub cancels an older pending run when a newer one queues, which would
lose a report that was never built. A cancelled pending deploy job loses nothing (§5.3). Every deploy job finds its
base the same way (§5.3), so a repository with several deploys correctly. `cleanup-pr` uploads a `remove-pr` update,
and a new `reopen-pr` input uploads a `reopen-pr` one. The `gh-pages` branch, `site-lease.sh` and `site-branch.sh`
are removed; a user's first pass migrates as in §5.3, and the release notes tell them to add the deploy job, set
Pages' source to "GitHub Actions" if it was "Deploy from a branch", and then delete the branch. This is part of the
format-4 bump release.

## 6. Latency, from a partition being written to it being visible

| Path | Latency | Bound by |
| --- | --- | --- |
| Today | the rest of the run plus 2 to 5 min | the end-of-run publisher |
| B, job end, dispatched | the rest of the job plus about 1 to 2 min | one deployer pass (download, apply, upload, deploy) |
| C, pusher, dispatched | about 1 to 3 min | the push interval plus one deployer pass |
| B or C, not dispatched (forks, bots) | about 5 to 30 min | GitHub's best-effort schedule plus one deployer pass |
| E, object store | seconds | the push interval |
| E, `host` | the flush interval (5 s default) | nothing else |

Add up to ten minutes to any Pages row for a reader whose CDN edge still holds the previous manifest (§5.7).

## 7. Security

- Report-producing jobs hold `actions: write` (to dispatch the deployer) instead of `contents: write`. That token can
  also cancel runs and delete artifacts and caches in this repository. The actions use it only to dispatch, and only
  for a person's same-repo run; bot branches (Renovate) never dispatch. Job-level `permissions` cannot be
  conditional, so the token exists on bot runs too; the design guarantees otel-html does not use it there, not that
  the dependency code could not. Fork runs get a read-only token whatever is declared.
- No job can write the site. Only the deployer can, running the default branch's code.
- A fork pull request's `push` updates go live while its run is going, as the 2026-11-06 design's artifact
  destination already had them do (applied by the publisher tick). Today a fork's data reaches the site at the end of
  its run; only the timing changes, and the data passes the same validation.
- Every update artifact is untrusted data, a fork's included. The deployer authenticates an update by the workflow
  run that uploaded it (the artifact's `workflow_run`, read from the API), and trusts `update.json` only as far as
  that run allows:
  - `push`: accepted only from runs of the configured CI workflows (`ci` and `load` here; a run started by
    `workflow_run`, `schedule` or `pull_request_target` runs on the default branch and would otherwise land in its
    channel). The run id and channel come from the API, never `update.json`. The channel is the run's branch, or for a
    pull request run the pull request found by head repository and branch, as `ci-report` maps it today (a fork run's
    `pull_requests` list is empty). The job id and attempt come from `update.json` but must be a job and attempt of
    that run; a forged value can only misplace the uploader's own run's data.
  - `run`: accepted only from a run of the default branch's `ci-report` workflow with event `workflow_run` or
    `workflow_dispatch`. Its `update.json` run id is trusted, then cross-checked against that run's branch and
    repository from the API. The `report` job builds a same-repository person's pull request with that pull request's
    code (as today): pushing such a branch already takes write access, so that code gains nothing.
  - `remove-pr` and `reopen-pr`: accepted only from a run of the default branch's `ci-report` workflow with event
    `pull_request_target`. That job runs only the default branch's code, so the pull request number in `update.json`
    is trusted once the run checks out (an artifact's run does not name the pull request, and a fork's run has an
    empty `pull_requests`). An artifact cannot be tied to a job, only to a run, so that is the check.

  Every `push` writes only under `<channel>/runs/<run id>/` for its run, every path is validated as the manifest's
  layout regexes do, and symlinks and anything outside the update's own tree are rejected.
- Provisional spans are plain spans; a consumer that ignores the attribute sees duplicates, not corruption.
- OTLP fan-out sends telemetry to an endpoint the operator configured; the endpoint is never taken from a request.

## 8. Tests

- Unit: `ci push` idempotency (applying the same update twice changes nothing), out-of-order updates converging on the
  newest sequence, manifest append with statistics, deterministic partition folder names, provisional span emission
  from a jobs-API fixture, the trace panel preferring a non-provisional row when span ids collide, the fan-out
  client's bounded queue.
- Unit, `ci push`: a newest update that lists a partition whose files are in no update and not on the site leaves the
  job pending; an older update supplies files the newest lists; partition folder numbers are never reused.
- Unit, deployer: a pass is a pure function of (base, pending) over a fixture site and update set; `applied.json`
  makes a second pass a no-op; an empty pending set exits before the base is downloaded; a `remove-pr` beats a later
  `push` for that pull request and a `reopen-pr` lifts it; a `run` update replaces the run's push partitions; a
  re-run of one job keeps the other jobs' partitions; dropped files survive until 15 minutes after their drop; a
  forged `update.json` channel, a `run` update from a non-`ci-report` run, or a path outside the run is rejected;
  cold start from a `site-state/files.json` site served by a local static server; migration from a fixture
  `gh-pages` tree.
- The deployed tarball contains `site-state/applied.json` (a check on the real `upload-pages-artifact` step, which
  drops dotfiles by default).
- `actions-smoke.yml` gains a leg, on a Linux and a Windows runner, that runs a job with `push-every` and a deployer
  pass against a scratch site (a local base instead of a real deployment), and asserts the site's run report lists the
  job's partitions before the job ends, and lists only the compacted ones after a step ends.
- e2e: a fixture report with provisional CI spans renders the trace with one root and shows the in-progress line and
  Refresh; after a second manifest is served, Refresh shows the new partition's rows.

## 9. Milestones

1. The deployer and site updates replacing `gh-pages` (§5.3, §5.9), `ci push`, the collect-step `push` update
   (approach B), provisional and definitive CI spans, `ci site` as the `run` update, the dispatch and the tick. The
   `gh-pages` branch is deleted after this milestone's first deploy.
2. The detached pusher (approach C), the in-progress line and Refresh.
3. OTLP fan-out.
4. The object store target.

## 10. Decisions settled in conversation

- Direction approved on 2026-11-06: per-job incremental publishing, during the run from a background process, with
  OpenTelemetry at every integration point.
- The workflow trace is "opened" at run start as OTel does it (ids fixed and propagated); parent spans are emitted
  provisionally and superseded by replacing the partition that holds them.
- 2026-11-07: Pages deploys from a build artifact and the `gh-pages` branch is deleted; the site stays in this
  repository's Pages, not a second repository; GitHub Pages for now, object store still planned; the change is built
  into this design, not done first on the current publisher.
- 2026-11-07: no cache semantics for the site's state. The base is the last successful deployment's artifact
  (90-day retention), with the live site as the fallback after 90 idle days.
- Superseded on 2026-11-07: the per-run branch-or-artifact destination (2026-11-06) and the maintainer action to admit
  `gh-pages` in the `github-pages` environment's branch policy. The environment keeps admitting the default branch.

## 11. Designer's calls (flag if wrong)

- Jobs wake the deployer with `workflow_dispatch`, which needs `actions: write` on report-producing jobs (§7);
  without it every update waits for the five-minute tick.
- The site's state lives in `site-state/` (`applied.json`, `removed.json`, `files.json`, `deletions.json`), served
  publicly like the rest of the site, and is also uploaded as the small `otel-html-site-state` artifact so a pass can
  tell whether anything is pending without downloading the site.
- The deployer is two jobs: `plan` outside any concurrency group, `deploy` in `pages` only when something is pending.
  The deploy pass is a new `otel-html-deploy` action; `otel-html-publish` no longer deploys.
- Dropped files are deleted 15 minutes after they are dropped, so a reader holding a CDN-cached manifest never meets
  a missing file; partition folder numbers are never reused.
- A `push` update carries only the files it is the first to ship; a pass leaves a job's updates pending while a listed
  partition's files are missing; the collect step stops the pusher before its final update.
- A reopened pull request is published again (`reopen-pr`).
- Retention, the rolling report and the README previews move into the deployer, since only it has the whole channel.
- The end-of-run job links the report before it is live, as today.
- The migration pass reads `gh-pages` once; deleting the branch is the maintainer's step after it deploys.
- A pass with nothing pending exits before downloading anything.
- The base is the newest successful `github-pages` deployment, whichever workflow made it; every deploying workflow
  is in the `pages` group. A deploying workflow is never re-run (it fails on `run_attempt > 1`); site state comes in a
  full form (matched by run) and a consumed-only form (matched by `base`).
- The deployer keeps the newest three deployments' artifacts and deletes older ones, and update artifacts the oldest
  kept deployment already applied, in a `continue-on-error` step (storage is free for this public repository, not for
  a private one using the action).
- A run report shows the newest attempt; a newer attempt's first update reopens it.
- "A person's run" is the run's `actor.type == 'User'`, the rule `ci-report.yml` already uses.
- The pusher gets the artifact runtime token from a pinned `actions/github-script` step in `otel-html-setup`, proven
  first in milestone 2.
- Old-format reports on the site are left as they are.
- The pusher detaches itself from the CLI, so Windows runners are covered.
- A pusher or dispatch failure never fails the job; the pusher logs to a file under `.otel-html/` in the job's
  workspace, and the collect step turns that log's failures into one job notice.
- `push-every` defaults off; this repo sets 60 s.
- The provisional attribute name `otel_html.ci.provisional`.
- Refresh is manual by default; polling is an opt-in toggle.

## 12. Left to the builder

- The exact API calls from a `github-pages` deployment to its workflow run's artifacts (§5.3 states the rule; a
  failed deploy's artifact must never be the base).
- The update artifacts' retention (long enough that a broken deployer can be fixed before any expire; 90 days is the
  suggestion).
- Whether a `no-store` fetch of a manifest gets past Pages' CDN (§5.7), and what Refresh says when it does not.
- The pusher's wait strategy (manifest mtime poll versus filesystem watch) and its log format.
- The fan-out client's queue size and retry policy, and whether gRPC fan-out ships with HTTP or after.
- The target interface's exact operations once the object store target is attempted.
