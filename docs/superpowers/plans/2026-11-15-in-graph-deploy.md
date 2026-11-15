# In-graph report and deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ci.yml` and `load.yml` build their own report and deploy the Pages site as jobs at the end of their own
run; nothing dispatches the deployer.

**Architecture:** One PR (the maintainer's choice), in three parts. Part 1 makes the deployer's plan trust uploads
from trusted `ci`/`load` runs, tell run attempts apart, and lets `ci report` report a run from inside it. Part 2
switches the workflows (a reusable `site.yml` called from both, `queue: max`), deletes `pages-deploy.yml`, shrinks
`ci-report.yml` to `pr-cleanup.yml`. Part 3 removes dispatching from the product and rewrites the README's "Use in
your CI". Because the deploy job runs the default branch's code, the PR's own `site / deploy` runs the *old* plan,
which rejects the new uploads: the live checks happen after merge (Task 7).

**Tech Stack:** TypeScript (strict), vitest, GitHub Actions composite actions and workflows, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-11-15-in-graph-deploy-design.md`

**PR process:** unattended (`docs/agents/process-unattended.md`). This plan states the changes to `ci-report.yml`,
`pages-deploy.yml`, `otel-html-publish` and `otel-html-deploy`, so touching them is not a stop. Implementers on
Sonnet 5.5, branch review on Opus 5.5.

## PRs

| PR | branch | title | tasks |
| --- | --- | --- | --- |
| 1 | `feat/in-graph-deploy` | `feat(ci)!: report and deploy run as jobs of the CI run; no deployer dispatch` | 1–8 |

Order on the branch: Tasks 1–4, 5, 6, 8, then the PR, then Task 7 after merge.

## Global Constraints

- Trusted run (the one rule, everywhere): `head_repository.full_name == repository` AND (`head_branch == default
  branch` AND `event != 'pull_request'` OR `actor.type == 'User'`). In workflow `if:` terms: not a fork PR and
  `github.event.sender.type == 'User'`, or a non-PR event on the default branch.
- Fork and bot PR runs never upload anything the plan accepts; a forged name in such a run is rejected.
- No dispatch, no `workflow_run` wake-up, no schedule for the deployer after the PR.
- Deploy job concurrency: `group: pages`, `cancel-in-progress: false`, `queue: max`.
- Legacy acceptance (90 days, then a follow-up issue removes it): site states from `pages-deploy.yml` runs on the
  default branch; run updates from `ci-report.yml` runs on the default branch; the names `github-pages` and
  `otel-html-site-state-<run>` / `-base-<deployment>` read as attempt 1.
- Report contents and site layout do not change (the in-run report must equal what `ci-report` would have built).
- If `queue: max` or the `refs/pull/*/merge` environment rule do not behave as described, stop and report; do not
  fall back to cancelling.
- Conventions: `docs/agents/conventions.md` (TDD, biome + typecheck before each commit, README updated with
  behaviour, `mise run verify` before each PR).

## Review Focus

1. A re-run (attempt 2) after attempt 1 deployed: the base is attempt 1's deployment (not skipped as "our own run"),
   attempt 2's run update supersedes attempt 1's, the redeploy succeeds. → Task 2 and Task 3 tests.
2. A deploy cancelled after uploading its full state but before `deploy-pages` finished: the next plan never uses
   that state, because no successful deployment names that run attempt. → Task 3 test.
3. A fork PR run that uploads `otel-html-update-run-<trusted run>-1` or `otel-html-site-state-<n>-1`: rejected. → Task
   2 test.
4. The first new-style deploy sees only legacy artifacts (`pages-deploy.yml` state, `ci-report.yml` run updates):
   it builds on them. → Task 2 test.
5. In-run report of a run with one failed and one skipped job: result `failure`, the `site / *` jobs absent, report
   identical to a post-run one otherwise. → Task 4 test.

---

## Part 1 — the deployer trusts ci runs

### Task 1: The trust rule

**Files:**
- Create: `src/cli/ci/trust.ts`
- Test: `test/cli/ci/trust.test.ts`

**Interfaces:**
- Produces: `isTrustedRun(run: ApiRun, repository: string, defaultBranch: string): boolean`

- [ ] **Step 1: Write the failing tests** — `isTrustedRun` is true for: a `push` on `main` by a `Bot` actor; a
  `schedule` on `main`; a same-repo `pull_request` by a `User`. False for: a fork `pull_request` by a `User`; a
  same-repo `pull_request` by a `Bot`; a same-repo `pull_request` whose head branch is named `main` by a `Bot`; a run
  with no `head_repository`.
- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/trust.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** per Global Constraints.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ci): one rule for which runs may write the site`.

### Task 2: The plan accepts trusted ci runs' run updates and states

**Files:**
- Modify: `src/cli/ci/deploy-plan.ts` (`PlanOptions`, `isDeployerRun`, `check`), `src/cli/ci/deploy-main.ts`,
  `src/cli/commands/ci.ts` (flag parsing)
- Test: `test/cli/ci/deploy-plan.test.ts`

**Interfaces:**
- Consumes: `isTrustedRun` (Task 1).
- Produces: `PlanOptions.reportWorkflows: string[]` and `PlanOptions.deployerWorkflows: string[]` (replacing the
  singular fields). CLI `--report-workflow` and `--deployer-workflow` take comma lists.

Rules after this task:
- A **run update** is accepted when its uploader is (a) a run of a `ciWorkflows` file, trusted, with
  `uploader.id === parsed.runId`, event in `PUSH_EVENTS`; or (b) legacy: a run of a `reportWorkflows` file on the
  default branch with event in `RUN_EVENTS` (today's rule).
- **remove-pr / reopen-pr** keep today's checks, the uploader's path in `reportWorkflows`.
- A **site state** (full or consumed) counts when its uploader is a run of a `deployerWorkflows` file that is either
  a trusted run of a `ciWorkflows` file, or legacy: on the default branch with event in `DEPLOYER_EVENTS`.

- [ ] **Step 1: Write the failing tests** (the existing fake-API helpers in `deploy-plan.test.ts`):
  `accepts a run update uploaded by the trusted ci run it names`; `rejects a run update a ci run uploaded for another
  run`; `rejects a run update uploaded by a fork pull_request run` (reason contains `not trusted`);
  `rejects a site state uploaded by a fork pull_request run of ci.yml`; `accepts a consumed state from a trusted
  ci.yml pull_request run`; `still accepts ci-report.yml run updates and pages-deploy.yml states on the default branch`
  (Review Focus 4).
- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/deploy-plan.test.ts` — the new tests FAIL.
- [ ] **Step 3: Implement** the rules above; update the existing tests' options for the plural fields.
- [ ] **Step 4: Run** — PASS; `mise run check` green.
- [ ] **Step 5: Commit** `feat(ci): the deploy plan accepts run updates and states from trusted ci runs`.

### Task 3: Attempts are told apart

**Files:**
- Modify: `src/cli/ci/site-state.ts` (`StateForm`, `stateArtifactName`, `parseStateName`),
  `src/cli/ci/deploy-plan.ts` (`successfulDeployments`, base, `hasSite`, consumed-state ordering, outputs),
  `src/cli/ci/deploy-main.ts`, `src/cli/ci/github-api.ts` (a `fetchJob(id)` if none exists),
  `.github/actions/otel-html-deploy/action.yml`
- Test: `test/cli/ci/site-state.test.ts`, `test/cli/ci/deploy-plan.test.ts`

**Interfaces:**
- Produces: `StateForm = { kind: 'full'; runId: number; runAttempt: number } | { kind: 'consumed'; base: number;
  runAttempt: number }`. Names: full `otel-html-site-state-<run>-<attempt>`, consumed
  `otel-html-site-state-base-<deployment>-<attempt>`; the legacy names parse with `runAttempt: 1`. The Pages artifact
  is `github-pages-<attempt>` (legacy `github-pages` = attempt 1). `successfulDeployments` yields
  `{ id, runId, runAttempt, liveAt }`, the attempt read from the success status's `log_url` job id through
  `GET /repos/{repo}/actions/jobs/{id}` (`run_attempt`). `PlanOptions.currentRunId` becomes
  `current?: { runId: number; runAttempt: number }` (from `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`); only the current
  attempt's deployments are skipped. New plan output `base_artifact_name`. Consumed-state ordering compares
  `(runId, runAttempt)` pairs.

- [ ] **Step 1: Write the failing tests:** name round-trips for both forms and the legacy names; `a re-run builds on
  its own run's earlier attempt's deployment` (Review Focus 1); `a full state whose attempt never went live is not
  used` (Review Focus 2); `a consumed state of attempt 2 outranks attempt 1's for the same base`.
- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement.** In the deploy action: `upload-pages-artifact` `name: github-pages-${{ github.run_attempt }}`,
  `deploy-pages` `artifact_name` the same, state uploads with the attempt suffix, the base download by
  `steps.plan.outputs.base_artifact_name`, `GITHUB_RUN_ATTEMPT` passed to plan.
- [ ] **Step 4: Run** — PASS; `mise run check` green.
- [ ] **Step 5: Commit** `feat(ci): the deployer tells run attempts apart`.

### Task 4: `ci report` reports a run from inside it

**Files:**
- Modify: `src/cli/ci/report-main.ts`, `src/cli/commands/ci.ts`, `.github/actions/otel-html-publish/action.yml`
  (new input `exclude-jobs`, passed through), README (`ci report` row and publish inputs)
- Test: `test/cli/ci/report-main.test.ts` (or the existing report test file)

**Interfaces:**
- Produces: `ci report --exclude-jobs <prefix>`; `finishedView(run: ApiRun, jobs: ApiJob[], excludePrefix: string):
  { run: ApiRun; jobs: ApiJob[] }` — drops jobs whose name starts with the prefix; when the run is not `completed`,
  sets `status: 'completed'`, `updated_at` to the latest remaining `completed_at`, and `conclusion` to `failure` if any
  remaining job is `failure` or `timed_out`, else `cancelled` if any is `cancelled`, else `success` (my call; it
  mirrors GitHub's run conclusion for these cases).

- [ ] **Step 1: Write the failing tests:** `finishedView` for (success + skipped) → `success`; (failure + skipped) →
  `failure` (Review Focus 5); (success + cancelled) → `cancelled`; excluded `site / report` and `site / deploy` absent;
  a completed run passes through unchanged. A `runReport` test with an in-progress run and `excludeJobs` produces the
  same spans as the completed-run fixture.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; apply `finishedView` right after fetching run and jobs, before logs are fetched (so the
  excluded jobs' logs are not fetched either).
- [ ] **Step 4: Run** — PASS. `mise run verify` green.
- [ ] **Step 5: Commit** `feat(ci): ci report can report a run from one of its own jobs`.


---

## Part 2 — the workflows

### Task 5: The environment rule

Done before the PR opens, so its run's `site / deploy` can enter the environment (that deploy runs the old plan and is
expected to place nothing new; it must not fail).

- [ ] **Step 1:** Record the current rules: `gh api repos/bjstabi/otel-html/environments/github-pages/deployment-branch-policies`.
- [ ] **Step 2:** Add the rule: `gh api -X POST repos/bjstabi/otel-html/environments/github-pages/deployment-branch-policies -f name='refs/pull/*/merge' -f type=branch`. If the API refuses that pattern, try `type=tag`-free alternatives the API documents; if none works, stop and report.
- [ ] **Step 3:** List the rules again; expected: `main` and `refs/pull/*/merge`. Note the result for the PR body.

### Task 6: `site.yml`, ci.yml, load.yml, the old workflows

**Files:**
- Create: `.github/workflows/site.yml` (`on: workflow_call`), `.github/workflows/pr-cleanup.yml`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/load.yml`, `.github/workflows/actions-smoke.yml`,
  `README.md` ("This repo's CI"), `docs/agents/process-unattended.md`, `docs/agents/process-spike.md`
- Delete: `.github/workflows/pages-deploy.yml`, `.github/workflows/ci-report.yml`

Decisions:
- `site.yml` has two jobs. `report`: today's ci-report `report` job (same checkout rule, same permissions), running
  `otel-html-publish` with `run-id: ${{ github.run_id }}`, `exclude-jobs: 'site / '`, no dispatch inputs. `deploy`:
  `needs: report`, `if: always() && !cancelled()`, today's pages-deploy `deploy` job (default-branch checkout, same
  permissions, environment `github-pages`), concurrency `{ group: pages, cancel-in-progress: false, queue: max }`, no
  re-run guard, `ci-workflows: ci.yml,load.yml`, `report-workflow: ci-report.yml,pr-cleanup.yml`,
  legacy deployer `pages-deploy.yml` added to the deployer list. No separate plan job.
- In `ci.yml` and `load.yml`: a final job `site` that `needs:` every other job, `if:` = `!cancelled()` and the trust
  rule (Global Constraints), `uses: ./.github/workflows/site.yml`, granting the union of the two jobs' permissions.
- Every test job: drop `push-every`, `publish: true`, `dispatch-app-*`; `actions: write` becomes `actions: read`
  unless the job needs write for another reason (say which in a comment).
- `pr-cleanup.yml`: ci-report's `cleanup` job alone, without dispatch inputs.
- `actions-smoke.yml`: drop its dispatch; keep the `ci deploy apply` check.

- [ ] **Step 1:** Write the files. `actionlint` (in `mise run check:static`) green.
- [ ] **Step 2:** README "This repo's CI" rewritten: the run graph, the `site` job, who writes, permissions, no
  dispatch, re-runs safe, superseded runs absent.
- [ ] **Step 3:** `mise run verify` green. Commit `ci: report and deploy inside the ci and load runs`.

### Task 7: Prove it live (after merge)

Before merge, on the PR's own run: the graph ends `site / report → site / deploy`, `site / report` builds and uploads
the run update (in-run report works), `site / deploy` enters the environment and ends green (the old plan rejecting
the new uploads is expected). Put that in the PR body. After merge, as the coordinator:

- [ ] **Step 1:** The `main` push's run: `site / deploy` succeeds and `/branch/main/` shows the run;
  `pages-deploy` no longer runs. Open a throwaway PR (a docs whitespace change) for Steps 2–4; its `/pr/<n>/`
  preview shows its run.
- [ ] **Step 2:** Push an empty commit while the first run's deploy is queued or running: the older run is
  cancelled as a whole; no deploy job is cancelled by the queue.
- [ ] **Step 3:** Two PR runs whose deploys overlap (re-run one): the second waits in the queue (job shows
  "waiting"), then succeeds.
- [ ] **Step 4:** Re-run failed jobs (or all jobs) of a finished run: `site / report` and `site / deploy` re-run and
  succeed; the preview shows the new attempt.
- [ ] **Step 5:** Post the observations, the environment rule, and a count of Actions runs and API rate used
  (`gh api rate_limit`) over one push, against today's ~10 deployer runs per push, as a comment on the merged PR.
  Close the throwaway PR. Any failure: fix on a new branch at once (or revert the merge if the site cannot deploy).
- [ ] **Step 6:** Open an issue to remove the legacy acceptance after 2027-02-13 (90 days).

---

## Part 3 — no deployer dispatch in the product

### Task 8: Remove dispatching; document the in-graph setup

**Files:**
- Delete: `src/cli/ci/dispatch.ts`, `test/cli/ci/dispatch.test.ts`
- Modify: `src/cli/commands/ci.ts` (drop `ci dispatch`), `src/cli/ci/pusher.ts` / `pusher-main.ts` (drop the
  wake-up and `--deployer-workflow`), `test/cli/ci/pusher.test.ts`, `test/actions/collect.test.ts`,
  `.github/actions/otel-html-setup|collect|publish/action.yml` (drop `deployer-workflow`, `dispatch-app-id`,
  `dispatch-app-private-key` and their steps), `README.md`

- [ ] **Step 1:** Update the tests that assert dispatching to assert it is gone (the pusher uploads and never calls a
  `/dispatches` URL); run — FAIL.
- [ ] **Step 2:** Remove the code and inputs; `knip` finds what is left over. Run — PASS.
- [ ] **Step 3:** README: "Use in your CI" shows the test job, then a `site` job calling a reusable workflow with
  `report` and `deploy` (as `site.yml`), the permissions per job, the environment's two branch rules, `queue: max`,
  and the trust `if:`; delete "Dispatch token" and the `workflow_run`/`pages-deploy.yml` examples; the CLI table
  loses `ci dispatch`.
- [ ] **Step 4:** `mise run verify` green. Commit `feat(actions)!: no deployer dispatch`.

Then: branch review (Opus 5.5) of the whole branch, the PR (body: per part what changed, the in-PR observations,
that the `DEPLOYER_APP_ID` variable, `DEPLOYER_APP_PRIVATE_KEY` secret and the App can now be deleted — the agent
does not delete them), merge on green, Task 7.
