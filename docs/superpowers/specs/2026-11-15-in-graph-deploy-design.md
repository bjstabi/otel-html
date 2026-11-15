# In-graph report and deploy — design

Date: 2026-11-15. Status: draft for the maintainer's review.

## Why

Today every job in `ci.yml` and `load.yml` wakes the Pages deployer with a `workflow_dispatch` (the pusher every 60 s,
collect at the end), ci-report wakes it again through `workflow_run`, and a five-minute schedule wakes it a third way.
Measured on 2026-11-15 between 12:54 and 15:55 UTC: 200 `pages-deploy` runs (187 dispatched), of which 96 were
cancelled, 51 failed and 30 ended in `startup_failure`; 13 succeeded. The failures sampled were the `plan` job hitting
"API rate limit exceeded for installation" in `configure-pages`: every run, even one that is about to be cancelled,
pays for a setup, a build and a round of artifact, run and deployment listings, and every dispatch polls the API for
up to 20 s afterwards.

Two things are wrong, in the maintainer's words: the cancelled runs make the Actions graph hard to follow, and the
API traffic is rate-limiting us. Dispatching is also invisible: a dispatched run is a separate workflow, not part of
the run that caused it, so the graph of a CI run never shows its report being built or deployed.

## Intent

A CI run's report and its deploy are jobs **in that run's own graph**. Nothing is dispatched. Reading a run's graph
shows the tests, then the report, then the deploy.

## Goals

- `ci.yml` and `load.yml` end with a `report` job and a `deploy` job (after every other job, `if: always()` so a
  failed or cancelled-by-failure run still reports, matching today's "a failed run is the most interesting report").
- One deploy per trusted run; no `workflow_dispatch`, no `workflow_run` wake-up, no schedule, no deployer GitHub App.
- No deploy job is ever cancelled to make way for another under normal load (see Concurrency).
- Re-running a run, all jobs or only the failed ones, is allowed and safe; so is a new push to the same PR
  superseding a run.
- Fewer GitHub API calls per push than today by a wide margin (target: the plan and deploy calls of one pass per
  run, instead of ~10 passes plus dispatch polling).
- The documented setup in the README's "Use in your CI" is replaced by the same shape, so this repo and the
  documented setup stay the same.

## Non-goals

- **A report that grows on GitHub Pages during a run.** The maintainer: the live report "isn't important for gh pages
  site". The site updates when a run ends.
- **Approving outside PRs.** Fork PRs and bot PRs (dependabot, release-please) do not contribute to the site. No
  approval path, no label, no manual "report this run" dispatch.
- Changing the report contents, the site layout, retention, or the viewer.

## Anti-goals

- Anything that lets a fork's code, or a fork run's artifacts, change what the site serves.
- Trading the cancelled runs for a different kind of noise in the graph (failed or cancelled deploy jobs as a
  normal occurrence).
- Shutting the door on live deploys: the maintainer wants live reports later for another target (Cloudflare). The
  pusher and `push` updates stay in the actions; only the Pages wake-up goes.

## Who writes to the site

| run | report job | deploy job |
| --- | --- | --- |
| push to `main`, nightly schedule, manual `workflow_dispatch` of ci/load | runs | runs |
| PR from a branch of this repo, run started by a person (`actor.type == 'User'`) | runs | runs |
| PR from a fork | skipped | skipped |
| run started by a bot (dependabot, release-please, …) on a non-default branch | skipped | skipped |

This is the rule `ci dispatch` and the plan apply today (same repository, a `User` actor, the default branch exempt
from the actor check); it moves from "who may wake the deployer" to the jobs' `if:` and to what the plan accepts.
Only people with write access can push branches here, so same-repository PR authors are maintainers.

## Constraints found during design

- **Environment branch rules.** `github-pages` allows deploys from `main` only (custom branch policy `main`). For
  `pull_request` events GitHub evaluates the rule against `refs/pull/<n>/merge`, not the head branch
  (GitHub changelog, 2025-11-07). The environment needs a second rule matching `refs/pull/*/merge`. That is safe
  because fork runs never reach the job (the `if:`), and a fork's token could not mint the OIDC token Pages needs
  anyway. Changing the environment is a repository setting; the plan says who does it and when.
- **Concurrency.** GitHub's default keeps one running and one pending job per group and cancels an older pending job
  when a newer one arrives: that is today's cancellations. Since May 2026 a group accepts `queue: max` (up to 100
  waiting) with `cancel-in-progress: false`. The deploy job uses group `pages` with `queue: max`.
- **Workflow-level cancellation.** `ci.yml` cancels a run when a newer one for the same ref and event starts
  (`cancel-in-progress: true`). That cancels the run's report and deploy jobs too, possibly mid-deploy. The deploy
  must be safe to cancel at any step: the next deploy (the newer run's) must produce a correct site, losing nothing.
- **Re-runs.** "Re-run failed jobs" re-runs the jobs that need the failed ones, so `report` and `deploy` re-run with
  `run_attempt > 1`. Today's deployer refuses re-runs because "the artifact API does not say which attempt uploaded
  an artifact". That refusal goes; instead:
  - a run update is named per attempt already (`otel-html-update-run-<run>-<attempt>`); the plan takes the newest
    attempt's run update for a run and treats older attempts' as superseded;
  - a site state is used as the base only when the deployment it describes actually went live (a state left by a
    deploy that was cancelled or failed after uploading it must not be trusted);
  - repeating a deploy that already applied everything is a no-op or an identical deploy, never an error.
- **Trust in artifacts.** A fork PR's run can upload artifacts with any name to its own run. Today only the deployer
  workflow on the default branch may upload a consumed site state, and only ci-report on the default branch a run
  update. Both rules change: run updates and site states are now uploaded by `ci.yml`/`load.yml` runs, so the plan
  accepts them only from runs that pass the table above (same repository; a `User` actor unless on the default
  branch), and a site state only from the deploy job of such a run.
- **Permissions.** The workflow default stays `contents: read` (and `actions: read` where needed). Each job asks for
  its own:
  - test jobs: `contents: read` and whatever `ci context` needs to read the run's jobs; they no longer upload site
    updates or dispatch, so no `actions: write` (their `otel-html-<job>` artifact upload uses the runtime token);
  - `report`: `actions: write` (download the run's artifacts, upload the run update), `contents: read`,
    `pages: read`, `pull-requests: write`, `checks: write`;
  - `deploy`: `contents: read`, `actions: write` (download updates, prune artifacts), `deployments: read`,
    `pages: write`, `id-token: write`, environment `github-pages`.
  The README's permissions paragraph is rewritten to match.

## Decided (the maintainer)

- Report and deploy are jobs inside the CI run, not separate workflows.
- Fork and bot PRs do not contribute; no approval path.
- Re-runs and new pushes to a PR are both normal and safe.
- No live report on Pages; keep the door open for live deploys elsewhere later.
- The README's documented setup is replaced too, not only this repo's CI.
- A run cancelled because a newer run superseded it (same ref and event, `main` included) is absent from the site;
  the newer run covers its branch. No end-of-job uploads are kept to place a partial report of it.
- Write access is the trust boundary: a same-repository PR can change its own deploy job, and that is accepted.
- A PR's changes to the deploy code (plan, apply, the deploy action) are checked by unit tests and `actions-smoke.yml`
  only, as today; they first touch the live site after merge. No dry run of the PR's deploy code.
- The `refs/pull/*/merge` rule on the `github-pages` environment is added by the agent through the API when the PR
  that introduces the jobs is ready to run them, before that PR's first deploy.

## My calls (the maintainer can override)

- **Code each job runs.** `report` keeps today's rule (the run's own commit for a same-repository run by a person).
  `deploy` checks out the default branch's code, as `pages-deploy` does now. This guards against a PR's *bugs*
  breaking the site, not against a malicious author: the job's definition lives in the PR's own `ci.yml`, so a
  same-repository PR author can change its steps. That is accepted — the trust boundary is write access (see "Who
  writes to the site"), and the `refs/pull/*/merge` environment rule is what admits those runs. The README says so.
- **The `if:` on report and deploy** is exactly `ci dispatch`'s rule: the default branch, or (same repository and
  `actor.type == 'User'`). Nightly and manual runs on `main` pass whatever their actor.
- **What the plan trusts.** An artifact's name (kind, run, attempt) plus the uploading run passing the rule above.
  The plan does not check which job uploaded it: a fork or bot run cannot upload under a trusted run's id, and every
  job of a trusted run is trusted.
- **Cutover.** The first deploys after the switch must find today's base: the plan keeps accepting site states from
  `pages-deploy.yml` runs on the default branch, and run updates from `ci-report.yml` runs on the default branch, for
  as long as such artifacts can exist (90 days' retention), then that acceptance is removed in a follow-up. Updates
  pending at cutover are applied by the first new deploy. The live-site cold start stays as the fallback. A unit test
  covers a plan that sees only legacy artifacts.
- **If `queue: max` or the merge-ref rule do not behave as the changelogs say,** the builder stops and reports
  rather than falling back to the cancelling behaviour; both are verified on the PR that introduces the jobs, before
  merge.
- **The pusher.** This repo's CI stops starting it (`push-every` unset): without a live deploy its uploads only cost
  API calls and artifacts. The pusher, `push` updates and their handling in the plan stay in the product.
- **Collect's `publish: true`.** Off in this repo for the same reason: the run update the `report` job uploads
  carries the finished run. Stays available in the action.
- **Dispatch goes.** `ci dispatch`, the `dispatch-app-id`/`dispatch-app-private-key`/`deployer-workflow` inputs of
  setup, collect and publish, the pusher's wake-up and the README's "Dispatch token" section are removed. The
  `DEPLOYER_APP_*` variable and secret, and the App, can be deleted by the maintainer afterwards. This is a breaking
  change to the actions' inputs (we are at 0.x); the PR title marks it (`!`).
- **pages-deploy.yml and ci-report.yml.** `pages-deploy.yml` is deleted. `ci-report.yml` keeps only the PR-closed and
  -reopened cleanup (`pull_request_target`, default branch code); it uploads its removal update and no longer wakes
  anything. The next deploy (any trusted run's, typically the merge's push to `main`) applies it. The workflow is
  renamed to say what it is (for example `pr-cleanup.yml`), and the plan's `--report-workflow` becomes that file.
- **One deploy job, not plan + deploy.** The separate `plan` job existed so a cheap check could run outside the
  concurrency group; with a queue and one wake-up per run that saving is gone, and a second job is a second setup and
  build. The deploy job plans, and ends early when nothing is pending.

## Left to the builder

- Whether `ci.yml` and `load.yml` share the two jobs through a local reusable workflow (`workflow_call`) or repeat
  them; the README's example for other repos shows plain jobs either way.
- How the plan narrows its listings now that it knows the run it is deploying for (it must still pick up anything
  pending from other runs: another run's update left by a cancelled or failed deploy, a PR cleanup, legacy artifacts).
- How a site state is tied to the deployment it describes, and how the plan proves that deployment went live.
- How `ci link`'s report URL and comment behave when the run's deploy has not happened yet (today they are also
  posted before the deployer runs).
- Verifying `queue: max` and the `refs/pull/*/merge` environment rule on the live repository before relying on
  them (see "My calls" for what to do if they differ).
- `actions-smoke.yml`: drop its `ci dispatch` use, keep what it checks of `ci deploy apply`.
- Test strategy: the plan's acceptance rules and re-run handling are unit-testable; the workflow wiring is checked by
  watching real runs (one `main` push, one PR push, one PR re-run, one superseding push, one fork-like refusal if
  practical).

## Success looks like

- A PR push's run graph ends `… → report → deploy`, and the PR's preview appears when that deploy finishes.
- Over a busy hour: zero dispatched runs, zero cancelled deploy jobs (other than ones whose whole run was superseded),
  zero rate-limit failures.
- Re-running a failed shard of a PR run redeploys that PR's preview with the new attempt's results.
