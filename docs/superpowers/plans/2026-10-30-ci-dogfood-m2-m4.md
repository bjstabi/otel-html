# CI dogfooding M2–M4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CI run's report is published to GitHub Pages and linked from the PR (M2); `main` and `load` accumulate into rolling reports with retention (M3); the whole pipeline ships as three reusable actions plus `otel-html upgrade` (M4).

**Architecture:** The CI logic moves out of `scripts/` into the CLI as an `otel-html ci` command group (`context`, `report`, `site`, `link`, `cleanup`) under `src/cli/ci/`, so the standalone binary carries it and the composite actions are shell around the binary. Site state is a `gh-pages` branch holding per-run reports, an `index.json` and a generated landing page; each publish rewrites the branch as one commit and deploys it with `actions/deploy-pages`. Rolling reports are `merge` over the retained per-run folders. New modules keep the pure/IO split of `src/cli/ci/publish.ts` + `publish-io.ts`: pure functions take data and return data or file plans; thin IO functions take an injected `fetch` or the writer's `FileSystem`.

**Tech Stack:** TypeScript (Node 24), commander, zod, vitest, the library API (`Report`, `merge`), GitHub REST API via `fetch`, git plumbing in bash, GitHub Actions (`workflow_run`, `pull_request_target`, `actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`), actionlint (in `mise run lint`).

**Spec:** `docs/superpowers/specs/2026-10-30-ci-dogfood-design.md` (§6.1, §6.4–6.7, §6.9, §7 M2–M4). M0 and M1 shipped in #82 (`docs/superpowers/plans/2026-10-30-ci-dogfood-m0-m1.md`). M5 (the built-in `ci` dashboard, a Cloudflare target) is not in this plan: it needs a viewer design pass of its own.

## Decisions this plan makes that the spec left open or said differently

Flag each to the owner before executing; the plan proceeds on them.

1. **The CI code lives in the CLI, not in `scripts/` or in the actions.** A composite action in another repo has the action's files but no `node_modules`, no `dist/` viewer and no bun, so TS scripts cannot run there; the binary already embeds the viewer and `fetch`. Hence `otel-html ci <sub>` and Part A (the move) comes first so M2 and M3 are built once, where they end up.
2. **`gh-pages` is rewritten as a single orphan commit on every publish**, pushed with `--force-with-lease` against the fetched tip (a rejected lease re-fetches, re-applies and retries once). The spec says "never force-pushed, one commit per publish"; that grows the branch by every run's data forever (a few MB per run → GBs within months) with no way back but a force push anyway. The tip holds the whole site, and the per-run folders are the durable store the spec wants; history adds nothing.
3. **Default-branch runs land in `/<workflow name>/`** (`/ci/`, `/load/`), not `/main/`: the same rule serves every workflow and every repo. The landing page labels `/ci/` as "main".
4. **PR channels keep the last 5 runs** (`pr-retention` input) in addition to deletion on close; `/pr/<n>/` and, until M3, `/<workflow>/` are a redirect stub to the latest run's folder rather than a second copy of it.
5. **`pull_request_target: closed`** (not `pull_request: closed`) triggers the cleanup: a fork PR's `pull_request` token cannot push. The cleanup job never checks out PR code.
6. **The floating action tag is `v<major>`**, moved by the release workflow: `v0` today, `v1` at 1.0. The README says `@v0`.
7. **Check runs conclude `neutral`**: the check is a link, not a second verdict on the run.

## Global Constraints

- Conventional commits; `mise run check` (biome, tsc on three tsconfigs, vitest, knip) passes on every commit. `mise run lint` runs actionlint on the workflows and actions.
- No new runtime dependencies. Everything new uses `node:*`, `fetch`, commander, zod and the library API.
- A report or publish failure never fails a job that otherwise passed; the publisher's own failures are `::error::` in its own run only.
- The publisher runs the default branch's code (a `workflow_run` workflow) and never checks out the triggering run's head.
- Secrets never reach a report or the site: only public run, job, step, log, PR and Pages API fields are read; the token is used for API calls and the `gh-pages` push only.
- Deterministic ids and resource attributes as in M0+M1's Global Constraints (`src/cli/ci/ids.ts`, `context.ts` after the move).
- Site layout: `/index.html` landing, `/index.json` site index, `/<workflow>/` and `/<workflow>/runs/<run_id>/`, `/pr/<number>/` and `/pr/<number>/runs/<run_id>/`. Retention defaults: 30 runs per workflow channel, 5 per PR channel.
- Publisher concurrency: `group: pages`, `cancel-in-progress: false`.
- No macOS runners.

## Review Focus

1. A workflow_run whose head is a fork PR: `workflow_run.pull_requests` is empty, so the PR number must come from `GET /repos/{r}/commits/{sha}/pulls`; with no open PR and a non-default branch the run is not published and `ci link` is skipped, with a notice. Test in Task 3 (`channelFor`) and Task 4.
2. A publish racing a PR-close cleanup: the lease is rejected, the second attempt must re-fetch and re-apply onto the cleaned tree, never resurrect the deleted PR folder. Test in Task 3 (applying a run to an index that no longer has the channel creates it; cleanup of a missing channel is a no-op) and the shell loop in Task 6.
3. A retained per-run report whose `formatVersion` the publisher's otel-html no longer reads: the rolling merge skips it with a warning and the run stays listed until retention drops it. Test in Task 8 (`mergeSkippingBad` with a bad input dir).
4. A re-run (attempt 2) of a run already on the site: `/runs/<run_id>/` is replaced, the index entry is updated in place, and retention counts the run once. Test in Task 3.
5. `otel-html upgrade` on a report another writer still has open, or on a folder with no report: usage error (exit 2), nothing written. Test in Task 11.

---

## Part A: the CI code moves into the CLI

### Task 1: `otel-html ci context` and `otel-html ci report`

**Files:**
- Move: `scripts/ci/*.ts` → `src/cli/ci/*.ts` (same names; `publish.ts` loses `parsePublishArgs`, commander parses now)
- Move: `scripts/ci-context.ts` → `src/cli/ci/context-main.ts`; `scripts/ci-report.ts` → `src/cli/ci/report-main.ts`
- Move: `test/scripts/ci/*.test.ts` → `test/cli/ci/*.test.ts` (imports updated)
- Create: `src/cli/commands/ci.ts`
- Modify: `src/cli/program.ts` (register), `.github/workflows/ci.yml`, `.github/workflows/ci-report.yml`, `README.md` (the two script paths in "This repo's CI")
- Test: `test/cli/ci/command.test.ts`, `test/cli/binary.test.ts`

**Interfaces:**
- Produces: `addCiCommand(program: Command, io: CliIo, deps: Partial<WriterDeps>): void` — `ci context [--job-name <name>]` and `ci report --run-id <n> --repository <owner/repo> --artifacts <dir> --out <dir> [--config <file>]`.
- Produces: `runContext(env: Record<string, string | undefined>, io: CliIo, fetchFn?: Fetch): Promise<void>` in `context-main.ts` (today's `main`, with `OTEL_HTML_JOB_NAME` also settable by `--job-name`), and `runReport(opts: ReportOptions, io: CliIo, deps: WriterDeps, fetchFn?: Fetch): Promise<void>` in `report-main.ts` where `ReportOptions = { runId: number; repository: string; artifacts: string; out: string; config?: string; token?: string }`. Both read `GITHUB_TOKEN` from `io.env`. `say`/`warning` in `github-api.ts` write through `io.stdout`.
- Later tasks add subcommands to `ci.ts` and modules beside these.

- [ ] **Step 1: Write the failing tests.** `test/cli/ci/command.test.ts`, with `runCli` as `test/cli/program.test.ts` uses it:

```ts
test('ci report without --run-id is a usage error', async () => {
  const io = fakeIo();
  expect(await runCli(['ci', 'report', '--repository', 'o/r', '--artifacts', 'a', '--out', 'o'], io, deps)).toBe(2);
  expect(io.err).toContain('--run-id');
});
test('ci context with no API writes a name-hashed TRACEPARENT to GITHUB_ENV', async () => {
  // GITHUB_* set, GITHUB_API_URL=http://127.0.0.1:9, GITHUB_ENV a temp file
  expect(await runCli(['ci', 'context'], io, deps)).toBe(0);
  expect(readFileSync(envFile, 'utf8')).toMatch(/^TRACEPARENT=00-[0-9a-f]{32}-[0-9a-f]{16}-01$/m);
  expect(io.out).toContain('::warning::');
});
```

In `test/cli/binary.test.ts` add the same `ci context` case against the compiled binary (the env file must get `TRACEPARENT`, exit 0).

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run test/cli/ci/command.test.ts` — FAIL (unknown command `ci`).
- [ ] **Step 3: Move the files** (`git mv`), fix imports (`../api/...` → `../../api/...`), replace `parsePublishArgs` with commander options in `ci.ts` (`.requiredOption('--run-id <n>')` parsed with the same positive-integer and `owner/repo` checks, as `OtelHtmlError('usage', …)`), and route `process.env`/`process.stdout` through `io`. Register `addCiCommand` in `program.ts` after `addConfigCommand`.
- [ ] **Step 4: Edit the workflows.** `ci.yml`: every `bun scripts/ci-context.ts` → `node dist/cli/main.js ci context`. `ci-report.yml`: `bun scripts/ci-report.ts …` → `node dist/cli/main.js ci report …` (same flags). README: the two paths.
- [ ] **Step 5: Run to verify pass.** `mise run check` (knip must not flag `src/cli/ci/*`; `test/scripts/ci` is gone) and `mise run lint`.
- [ ] **Step 6: Commit** `refactor(ci): the CI scripts become \`otel-html ci context\` and \`ci report\``.

---

## Part B: M2, publish to Pages and link from the PR

### Task 2: GitHub API writes and the PR lookup

**Files:**
- Modify: `src/cli/ci/github-api.ts`
- Test: `test/cli/ci/github-api.test.ts`

**Interfaces:**
- Produces: `sendJson<T>(method: 'POST' | 'PATCH', url: string, body: unknown, token: string | undefined, timeoutMs: number, fetchFn?: Fetch): Promise<T>` (throws naming the URL and status on non-2xx).
- Produces: `fetchPullsForSha(i: { apiUrl: string; repository: string; sha: string }, token, timeoutMs, fetchFn?): Promise<ApiPull[]>` over `GET /repos/{r}/commits/{sha}/pulls?per_page=100` (paged), `ApiPull = { number: number; title: string; state: string; head: { sha: string; ref: string } }`.
- Produces: `ApiRun` gains `head_repository: { full_name: string } | null`.

- [ ] **Step 1: Write the failing tests**: `sendJson` sends `Content-Type: application/json` and the `Bearer` header, returns the decoded body, throws `… answered 422` on 422; `fetchPullsForSha` follows `Link: rel="next"` and concatenates.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): API writes and the pull requests of a commit`.

### Task 3: the site index, layout and landing page (pure)

**Files:**
- Create: `src/cli/ci/site.ts`
- Test: `test/cli/ci/site.test.ts`

**Interfaces:**
- Produces:

```ts
export type SiteRun = { runId: number; attempt: number; conclusion: string; headSha: string; headBranch: string;
  completedAt: string; runUrl: string; reportPath: string /* `ci/runs/123` */ };
export type Channel = { kind: 'workflow' | 'pr'; title: string /* 'ci' | '#12 Fix the thing' */; headBranch: string; runs: SiteRun[] /* newest first */ };
export type SiteIndex = { version: 1; channels: Record<string, Channel> /* 'ci', 'load', 'pr/12' */ };
export const siteIndexSchema: z.ZodType<SiteIndex>;            // parseSiteIndex(text | undefined): SiteIndex, empty index when undefined
export function channelFor(run: ApiRun, pulls: ApiPull[], defaultBranch: string): { key: string; channel: Omit<Channel, 'runs'> } | undefined;
  // open pull whose head.sha === run.head_sha → 'pr/<number>'; else run.head_branch === defaultBranch && run.head_repository is the repo → slug(run.name); else undefined
export function placeRun(index: SiteIndex, key: string, channel: Omit<Channel, 'runs'>, run: SiteRun): SiteIndex;  // upsert by runId (attempt replaces), newest first
export function applyRetention(index: SiteIndex, keep: { workflow: number; pr: number }): { index: SiteIndex; remove: string[] /* report paths */ };
export function removeChannel(index: SiteIndex, key: string): { index: SiteIndex; remove: string[] };  // missing key: unchanged, []
export function renderLanding(index: SiteIndex, repository: string): string;   // static HTML, no script
export function renderRedirect(relativeTarget: string): string;                 // <meta http-equiv="refresh" content="0; url=runs/123/"> plus a link
export const slug = (name: string): string => …;  // lowercase, [a-z0-9-], 'ci' stays 'ci'
export const reportUrl = (baseUrl: string, reportPath: string): string;  // `${baseUrl}/${reportPath}/`
```

- [ ] **Step 1: Write the failing tests**:
  - `channelFor`: an open pull with the head sha → `{ key: 'pr/12', channel: { kind: 'pr', title: '#12 Fix the thing', headBranch: 'feat' } }`; no pull and head on `main` of the same repo → `{ key: 'ci', kind: 'workflow', title: 'ci' }`; a fork push with no pull → `undefined`; a closed pull is ignored.
  - `placeRun`: a second run goes first; the same `runId` with `attempt: 2` replaces the entry in place (length unchanged).
  - `applyRetention` with `{ workflow: 2, pr: 1 }` on three runs in `ci` and two in `pr/12` returns the two oldest report paths and keeps newest first.
  - `removeChannel('pr/99')` on an index without it → same index, `[]`.
  - `renderLanding` contains a link to `ci/` labelled "main", each PR's `#12` link, and no `<script`.
  - `renderRedirect('runs/123/')` contains `url=runs/123/`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): site index, channel placement, retention and the landing page`.

### Task 4: `otel-html ci site` and `ci cleanup`

**Files:**
- Create: `src/cli/ci/site-main.ts`, `src/cli/ci/site-io.ts`
- Modify: `src/cli/commands/ci.ts`
- Test: `test/cli/ci/site-io.test.ts`, `test/cli/ci/command.test.ts`

**Interfaces:**
- Consumes: Task 2 (`fetchPullsForSha`, `getJson` for the run and `GET /repos/{r}` → `default_branch`), Task 3.
- Produces: `ci site --site <dir> --report <dir> --run-id <n> --repository <o/r> --base-url <url> [--retention 30] [--pr-retention 5]`: reads `<site>/index.json`, resolves the channel, copies `<report>` to `<site>/<reportPath>`, writes `<site>/<channel>/index.html` as the redirect stub, applies retention (removing folders), writes `index.json` and `index.html`, then prints and appends to `$GITHUB_OUTPUT` (when set) `report-url=<url>`, `channel=<key>`, `published=true|false`. An unpublishable run prints `::notice::` and `published=false`, exit 0.
- Produces: `ci cleanup --site <dir> --pr <number>`: `removeChannel('pr/<n>')`, removes the folders, rewrites `index.json` and `index.html`.
- Produces in `site-io.ts`: `readSiteIndex(dir): Promise<SiteIndex>`, `writeSite(dir, index: SiteIndex, repository: string): Promise<void>` (index.json, index.html, `.nojekyll`), `copyReport(from, to): Promise<void>` (`fs.cp` recursive after `rm -rf to`), `removePaths(dir, rel: string[]): Promise<void>` (each must stay inside `dir`; a path escaping it throws).

- [ ] **Step 1: Write the failing tests**: `site-io`: `writeSite` then `readSiteIndex` round-trips; `removePaths(dir, ['../x'])` throws; `copyReport` replaces an existing target. `command.test.ts`: `ci site` with an injected fetch answering the run (`head_branch: 'main'`, same-repo head) and `[]` pulls, a fixture report dir (`createTestWriter` + `Report.create`, or `fixtures/reports/format-2`), a temp site: afterwards `<site>/ci/runs/42/data/manifest.js` exists, `<site>/ci/index.html` contains `url=runs/42/`, stdout has `report-url=https://x.test/otel-html/ci/runs/42/`, and a second call with `--retention 1` and run 43 removes `ci/runs/42`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): \`ci site\` places a run's report on the site; \`ci cleanup\` removes a PR`.

### Task 5: `otel-html ci link`: sticky comment and check run

**Files:**
- Create: `src/cli/ci/link.ts` (pure), `src/cli/ci/link-main.ts`
- Modify: `src/cli/commands/ci.ts`, `src/cli/ci/summary.ts` (export `MARKER`)
- Test: `test/cli/ci/link.test.ts`, `test/cli/ci/command.test.ts`

**Interfaces:**
- Consumes: Task 2, `summaryTable` from `summary.ts`, Task 3's `SiteIndex` (for the previous run's link).
- Produces: `MARKER = '<!-- otel-html-report -->'`; `commentBody(run: ApiRun, jobs: ApiJob[], url: string, previous: { url: string; runId: number } | undefined): string` (marker first line, then `summaryTable`, then "Previous run: …" when given); `findStickyComment(comments: { id: number; body: string }[]): number | undefined`; `checkRunPayload(run: ApiRun, url: string): { name: 'otel-html report'; head_sha: string; status: 'completed'; conclusion: 'neutral'; details_url: string; output: { title: string; summary: string } }`.
- Produces: `ci link --run-id <n> --repository <o/r> --url <report url> --site <dir> [--no-comment] [--no-check]`: fetches run, jobs and pulls; for each open PR of the head sha, lists `GET /repos/{r}/issues/{n}/comments` (paged), `PATCH`es the sticky comment or `POST`s one; `POST /repos/{r}/check-runs` with the payload. Each write failure is a `::warning::`, exit 0. The previous run is the index entry after this run in its channel.

- [ ] **Step 1: Write the failing tests**: `commentBody` starts with `MARKER` and names the previous run; `findStickyComment` picks the one whose body contains the marker; `checkRunPayload` has `conclusion: 'neutral'` and the URL. `command.test.ts`: `ci link` with a fake fetch records a `PATCH` to the existing marker comment and a `POST /check-runs`; with `--no-comment` only the check run.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): \`ci link\` posts the sticky PR comment and the check run`.

### Task 6: the publisher publishes

**Files:**
- Create: `.github/actions/otel-html-publish/site-branch.sh`
- Modify: `.github/workflows/ci-report.yml`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces: `site-branch.sh checkout <dir>` — `git init -b gh-pages <dir>`, `remote add origin $GITHUB_SERVER_URL/$GITHUB_REPOSITORY`, `config http.<server>/.extraheader "AUTHORIZATION: basic <base64 x-access-token:$GITHUB_TOKEN>"`, `fetch --depth 1 origin gh-pages` and `reset --hard FETCH_HEAD` when the branch exists (else an empty tree); writes the fetched SHA (or empty) to `<dir>/.lease` (gitignored by an `info/exclude` line). `site-branch.sh push <dir> <message>` — `git checkout --orphan publish`, `add -A`, `commit -m`, `push --force-with-lease=refs/heads/gh-pages:$(cat .lease) origin HEAD:refs/heads/gh-pages`; exit 1 on a rejected lease.

- [ ] **Step 1: Write the script** with `set -euo pipefail`; `git config user.name "github-actions[bot]"` and the matching noreply email inside `<dir>`.
- [ ] **Step 2: Edit the workflow**:
  - `permissions: { contents: write, actions: read, pages: write, id-token: write, pull-requests: write, checks: write }`; `concurrency: { group: pages, cancel-in-progress: false }`; `environment: { name: github-pages, url: ${{ steps.site.outputs.report-url }} }` on the `report` job.
  - After the report is built and uploaded as the `ci-run-report` artifact (unchanged): `- id: pages uses: actions/configure-pages@<pinned sha>`; then a `shell: bash` step "Publish to the site branch" with `GITHUB_TOKEN: ${{ github.token }}`:
    ```bash
    for attempt in 1 2; do
      rm -rf site && .github/actions/otel-html-publish/site-branch.sh checkout site
      node dist/cli/main.js ci site --site site --report ci-run-report --run-id "$RUN_ID" --repository "$GITHUB_REPOSITORY" --base-url "$BASE_URL" --retention 30 --pr-retention 5
      if .github/actions/otel-html-publish/site-branch.sh push site "ci-report: $GITHUB_WORKFLOW run $RUN_ID"; then break; fi
      [ "$attempt" = 1 ] || exit 1
    done
    ```
    (`BASE_URL: ${{ steps.pages.outputs.base_url }}`; the step has `id: site` and the outputs come from `$GITHUB_OUTPUT` written by `ci site`.)
  - `if: steps.site.outputs.published == 'true'`: `rsync -a --exclude .git site/ public/`, `actions/upload-pages-artifact` (`path: public`), `actions/deploy-pages`, then "Link" `node dist/cli/main.js ci link --run-id "$RUN_ID" --repository "$GITHUB_REPOSITORY" --url "${{ steps.site.outputs.report-url }}" --site site`.
  - Pass `OTEL_HTML_REPORT_URL: ${{ steps.site.outputs.report-url }}` is not available to `ci report` (it runs first): instead `ci link` appends its comment body to `$GITHUB_STEP_SUMMARY` too, so the summary carries the URL.
  - A second job `cleanup`: `on: pull_request_target: { types: [closed] }`, `if: github.event_name == 'pull_request_target'`, same `concurrency`, `permissions: { contents: write, pages: write, id-token: write }`, checkout of the default branch only (`ref: ${{ github.event.repository.default_branch }}`), setup, build, the same `for attempt` loop around `ci cleanup --site site --pr "${{ github.event.pull_request.number }}"`, deploy. The `report` job gets `if: github.event_name != 'pull_request_target' && (<existing condition>)`.
  - All new actions pinned to a SHA with a version comment, as the file does.
- [ ] **Step 3: Verify**: `mise run lint`. Before merging, dispatch from the branch against a past `ci` run (`gh workflow run ci-report.yml --ref <branch> -f run_id=<id>`): the `gh-pages` branch appears with `index.json`, `index.html`, `pr/<n>/runs/<id>/` (or `ci/runs/<id>/`), the Pages site serves the report on its CI dashboard, the PR has the sticky comment and the `otel-html report` check with the link. Dispatch twice: one commit on `gh-pages`, the comment updated not duplicated. Close a test PR: its folder and index entry are gone.
- [ ] **Step 4: Commit** `ci: publish each run's report to GitHub Pages and link it from the PR`.

### Task 7: README for M2

**Files:**
- Modify: `README.md` ("This repo's CI" and "Report layout and hosting")

- [ ] **Step 1**: Document the site layout, the `gh-pages` branch as the store (one commit, rewritten), retention, the sticky comment and check run, the cleanup on close, and the `ci site` / `ci link` / `ci cleanup` subcommands in one short table (they are "for the actions; stable flags, output format not guaranteed").
- [ ] **Step 2: Commit** `docs: how CI reports are published`.

---

## Part C: M3, rolling `ci` and `load` reports

### Task 8: `ci site` rebuilds the workflow channel's rolling report

**Files:**
- Modify: `src/cli/ci/site-main.ts`, `src/cli/ci/site.ts`
- Test: `test/cli/ci/command.test.ts`, `test/cli/ci/site.test.ts`

**Interfaces:**
- Consumes: `merge` (`src/api/convert.ts`), `mergeSkippingBad` (`publish-io.ts`).
- Produces: `ci site` gains `--config <file>`; for a `kind: 'workflow'` channel, after retention, `<site>/<key>/` is rebuilt by `mergeSkippingBad` over the channel's retained `runs/*` folders, oldest first (`replace: true`, the config), replacing the M2 redirect stub; `rollingInputs(channel: Channel): string[]` in `site.ts` returns the report paths oldest first. PR channels keep the redirect. A merge that fails with no bad input to blame is a `::warning::` and the redirect stub is written instead (the per-run report is still published).

- [ ] **Step 1: Write the failing tests**: `rollingInputs` orders oldest first; `command.test.ts`: two `ci site` calls on the `ci` channel with two fixture reports → `<site>/ci/data/manifest.js` exists and its chunk totals equal the sum of both runs' (read with `manifestOf` from `test/writer/helpers.ts`); a third call where one retained run folder is replaced by garbage still produces `<site>/ci/` and prints `::warning::otel-html report: skipping`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): the workflow channel is one rolling report merged over its retained runs`.

### Task 9: `load` feeds the site

**Files:**
- Modify: `.github/workflows/load.yml`, `.github/workflows/ci-report.yml`, `src/cli/ci/report-main.ts`

- [ ] **Step 1: Edit `load.yml`**: top-level `defaults.run.shell` as in `ci.yml`; the `changed` job's step gets `shell: bash` (it runs before any build and is not worth a report); `load` and `receiver` jobs get "Build otel-html" (`shell: bash`, `mise run build`), "otel-html context" (`shell: bash`, `node dist/cli/main.js ci context`, `GITHUB_TOKEN`), keep `lscpu` under the default shell (it runs after the build now), and the `if: always()` `otel-html-${{ github.job }}` upload with `include-hidden-files`. `test:load` already builds; `--skip-deps` is not needed since `mise run test:load` rebuilding `dist/` under the running shell is the same hazard `check:package` had: use `mise run --skip-deps test:load` after the explicit build.
- [ ] **Step 2: Edit `ci-report.yml`**: `workflow_run: workflows: [ci, load]`. In `report-main.ts`: when `discoverArtifacts` finds nothing, print `::notice::otel-html report: run <id> has no job reports; nothing to publish`, write nothing and set `published=false` in `$GITHUB_OUTPUT` (the `load` run that skipped its jobs); the workflow's site/deploy/link steps are already conditional on `published`. Give the "Build the run report" step `id: report` and condition the site step on `steps.report.outputs.published != 'false'`.
- [ ] **Step 3: Verify**: `mise run lint`; `gh workflow run load.yml` on the branch after merge of Task 6 (or dispatch `ci-report.yml` with a past `load` run id): `/load/` exists with the receiver and load jobs; a `load` run with `changed=false` publishes nothing and the publisher ends green. On `/ci/` after a few `main` merges, the CI dashboard's "Job duration" shows one line per job across runs.
- [ ] **Step 4: Commit** `ci(load): the load workflow reports to the site; runs with no job reports publish nothing`.

### Task 10: README for M3

**Files:**
- Modify: `README.md`

- [ ] **Step 1**: Rolling reports: how `/ci/` and `/load/` are rebuilt, what distinguishes runs inside them (trace id per attempt, `cicd.pipeline.run.id` variable), retention, and that a per-run report whose format the publisher no longer reads is skipped until retention removes it.
- [ ] **Step 2: Commit** `docs: rolling CI reports`.

---

## Part D: M4, the reusable actions and `otel-html upgrade`

### Task 11: `otel-html upgrade <report>`

**Files:**
- Create: `src/cli/commands/upgrade.ts`, `src/writer/upgrade.ts`
- Modify: `src/cli/program.ts`, `src/writer/merge.ts` (export the manifest reader at lines 60–85 as `readReportManifest(fs, dir): Promise<{ dir; manifest; epoch }>`), `README.md` (CLI section)
- Test: `test/writer/upgrade.test.ts`, `test/cli/program.test.ts`

**Interfaces:**
- Produces: `upgradeReport(deps: WriterDeps, dir: string): Promise<{ title: string; formatVersion: number }>` — `readReportManifest` (usage error when there is no report; `version-mismatch` when unreadable), refuses with `OtelHtmlError('usage', { hint: 'another otel-html has the report open' })` when `data/state/lock.json` names a live session (reuse the writer's lock check in `src/writer/lock.ts`), then `writeViewerAssets`, `renderIndexHtml(entry, manifest.title)`, `.nojekyll`, and removes files under `assets/` that the new set did not write. `data/` is not touched.
- Produces: `otel-html upgrade <report>` prints `upgraded <dir>: viewer <pkg.version>, format <n>`.

- [ ] **Step 1: Write the failing tests**: on `fixtures/reports/format-2` copied to a temp dir, `upgradeReport` leaves every `data/**` byte identical (hash before/after), rewrites `index.html` to reference the current entry, removes a planted stale `assets/old.js`; on an empty dir it throws `code: 'usage'`; `runCli(['upgrade', emptyDir])` returns 2.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(cli): \`upgrade\` rewrites a report's viewer and leaves its data alone`.

### Task 12: `otel-html-setup` and `otel-html-collect`

**Files:**
- Create: `.github/actions/otel-html-setup/action.yml`, `.github/actions/otel-html-setup/install.sh`
- Create: `.github/actions/otel-html-collect/action.yml`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/load.yml`
- Create: `.github/workflows/actions-smoke.yml`

**Interfaces:**
- Produces `otel-html-setup` (composite) inputs: `version` (release version such as `0.2.0`, or `latest`; default `latest`), `command` (an executable to use instead of a download, for example `node dist/cli/main.js`; default empty), `job-name` (default empty → `ci context` uses `GITHUB_JOB`), `token` (default `${{ github.token }}`). Outputs: `command` (what to put in the job shell), `report` (always `.otel-html/report`). Steps: when `command` is empty, `install.sh "$VERSION"` downloads `otel-html-<target>[.exe]` and `SHA256SUMS` from release `otel-html-v<version>` with `gh release download`, verifies with `sha256sum -c --ignore-missing` (git-bash on Windows has it), installs to `$RUNNER_TEMP/otel-html/bin` and appends it to `$GITHUB_PATH`; target from `$RUNNER_OS`/`$RUNNER_ARCH` (`Linux/X64 → linux-x64`, `Linux/ARM64 → linux-arm64`, `macOS/X64|ARM64 → darwin-*`, `Windows/X64 → windows-x64`; anything else fails with a message). Then `$CMD ci context` (`--job-name` when given) with `GITHUB_TOKEN`.
- Produces `otel-html-collect` (composite) inputs: `name` (artifact name, default `otel-html-${{ github.job }}`), `path` (default `.otel-html/`). One `actions/upload-artifact` step with `include-hidden-files: true`, `if-no-files-found: ignore`. Documented as the job's last step with `if: always()`.

- [ ] **Step 1: Write `install.sh`** and the two `action.yml`s with `description`s and the input docs above.
- [ ] **Step 2: Rewrite the jobs in `ci.yml` and `load.yml`** to `- uses: ./.github/actions/otel-html-setup with: { command: node dist/cli/main.js }` after "Build otel-html" (replacing the "otel-html context" step; the matrix jobs pass `job-name`), and `- if: always() uses: ./.github/actions/otel-html-collect with: { name: otel-html-<the same expression as today> }` replacing the upload step. The shell line stays as it is (`command` is what it names).
- [ ] **Step 3: Write `actions-smoke.yml`**: `on: { pull_request: { paths: ['.github/actions/**'] }, workflow_dispatch }`, matrix `ubuntu-latest`, `windows-latest`, `ubuntu-24.04-arm`; `permissions: { contents: read, actions: read }`; `defaults.run.shell: otel-html run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}`; steps: checkout, `uses: ./.github/actions/otel-html-setup` (released `latest`), `run: otel-html --version`, `run: echo hello`, `shell: bash` step asserting `.otel-html/report/data/manifest.js` exists, `otel-html-collect`. No macOS leg.
- [ ] **Step 4: Verify**: `mise run lint`; `ci` on the PR still uploads every `otel-html-*` artifact; `actions-smoke` passes on all three legs (it needs a release that has `ci context`, so it is `continue-on-error: true` with a comment until the first release after Task 1 exists, then the flag is removed in the release's follow-up).
- [ ] **Step 5: Commit** `feat(actions): otel-html-setup installs the CLI and joins the run's trace; otel-html-collect uploads the job report`.

### Task 13: `otel-html-publish`

**Files:**
- Create: `.github/actions/otel-html-publish/action.yml`
- Modify: `.github/workflows/ci-report.yml` (becomes two `uses:` steps plus checkout/build)

**Interfaces:**
- Consumes: Task 6's `site-branch.sh` (already in the folder), Tasks 4, 5, 8, 12.
- Produces (composite) inputs: `run-id` (default `${{ github.event.workflow_run.id || github.run_id }}`: the `workflow_run` publisher, or the "final job" mode inside the workflow itself), `version` / `command` (as setup), `config` (default: the action's own `otel-html-ci.yaml`, moved from `.github/otel-html-ci.yaml` and referenced through `${{ github.action_path }}`), `target` (`github-pages` | `artifact`, default `github-pages`), `retention` (30), `pr-retention` (5), `comment` (true), `check` (true), `token`. Outputs: `report-url`, `published`. Steps: install (as setup, skipped with `command`), `actions/download-artifact` (`run-id`, `pattern: otel-html-*`, `path: ${{ runner.temp }}/otel-html-artifacts`), `ci report`, `upload-artifact ci-run-report`; and when `target == 'github-pages'`: `configure-pages`, the site-branch loop, `rsync`, `upload-pages-artifact`, `deploy-pages`, `ci link` (with `--no-comment` / `--no-check` from the inputs). Final-job mode is the same steps; its README note says the publishing job's own timings are incomplete and the token needs the write permissions on the workflow.
- `ci-report.yml` becomes: checkout (default branch), `./.github/actions/setup`, `mise run build`, `uses: ./.github/actions/otel-html-publish with: { command: node dist/cli/main.js }`; the `cleanup` job keeps its loop (cleanup is not an action input: it is the one thing a consumer's workflow has to write, two lines documented in Task 14).

- [ ] **Step 1: Write `action.yml`** and move the dashboard config into the action folder (update `test/config/ci-dashboard.test.ts`'s path).
- [ ] **Step 2: Rewrite `ci-report.yml`** to use it.
- [ ] **Step 3: Verify**: `mise run lint`; dispatch `ci-report.yml` from the branch on a past run: same site result as Task 6; `target: artifact` on a dispatch (temporarily) uploads only `ci-run-report`.
- [ ] **Step 4: Commit** `feat(actions): otel-html-publish builds, publishes and links the run report`.

### Task 14: the floating major tag and "Use in your CI"

**Files:**
- Modify: `.github/workflows/release.yml`, `README.md`

- [ ] **Step 1: `release.yml`**: a job `actions-tag` with `needs: [release-please, binaries, checksums]`, `if: release_created == 'true'`, `permissions: { contents: write }`: checkout the tag, `major=$(printf '%s' "$TAG" | sed -E 's/^otel-html-v([0-9]+)\..*/\1/')`, `git tag -f "v$major" "$TAG"`, `git push -f origin "refs/tags/v$major"` (the only force push in the repo; a tag that only ever moves forward to a release).
- [ ] **Step 2: README "Use in your CI"** (new section after "This repo's CI"): the three `uses: bjstabi/otel-html/.github/actions/otel-html-<name>@v0` lines, the job shell line, the `shell: bash` rule for steps before setup, the publisher workflow (`workflow_run` + the `cleanup` job, ~30 lines), the permissions each needs, Pages setup (`build_type: workflow`), the inputs table, final-job mode, `target: artifact`, and that `v0` becomes `v1` at 1.0 with a note to pin a release tag for reproducibility. Also `otel-html upgrade` under CLI.
- [ ] **Step 3: Verify**: `mise run lint`; a second repository (a scratch repo of the owner's) adopts the two `uses:` lines and the publisher workflow against `@<this branch>` and gets a linked report. This is the acceptance test of M4.
- [ ] **Step 4: Commit** `feat(actions): a floating v<major> tag; README: use otel-html in your CI`.

---

## Self-review notes

- Spec coverage: §6.4 layout/retention/concurrency → Tasks 3, 4, 6 (with decisions 2–4); §6.5 rolling report → Task 8; §6.6 comment, check run, summary → Task 5–6; §6.7 `upgrade` → Task 11; §6.1 actions, binary install by version with checksum, `command` for this repo, final-job fallback (§5 A) → Tasks 12–13; §6.9 `target` with `github-pages` and the "artifact only" value → Task 13; `load` as a second producer → Task 9; `v1` tag and README → Task 14 (as `v<major>`). §6.10 second form and the Cloudflare target are M5, out of scope.
- Types: `SiteIndex`/`Channel`/`SiteRun` are defined once in Task 3 and consumed by Tasks 4, 5, 8; `ApiPull` in Task 2 feeds `channelFor` (Task 3) and `ci link` (Task 5); `published`/`report-url` outputs are named the same in Tasks 4, 6, 9, 13.
- Proportion: the plan decides layout, names, flags and the shell mechanics; bodies are left to the implementer except the retry loop and the lease, which the tests cannot pin.
- Open to the builder: pinned SHAs for the Pages actions; the landing page's styling; whether `ci link` also edits the comment when the run is a `main` push (it does not: no PR); the exact `info/exclude` handling of `.lease`.
