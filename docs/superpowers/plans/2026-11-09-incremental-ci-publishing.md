# Incremental CI Publishing Implementation Plan (the publishing plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CI run's report on the GitHub Pages site grows while the run is going: each job uploads its format-4 partitions as *site updates* (at its end, and every minute from a detached pusher), one *deployer* workflow applies the pending updates to the last deployed site and deploys the result from a Pages artifact, the `gh-pages` branch goes away, the viewer shows an in-progress report's age and re-reads its manifest on Refresh, and the receiver can forward every accepted OTLP request to a collector.

**Architecture:** Three new pieces in `src/cli/ci/`, all behind `otel-html ci` subcommands. (1) *Updates*: `update.ts` is the update artifact's contract (`update.json`, names, the partition listing); `update-main.ts` writes `push`, `run`, `remove-pr` and `reopen-pr` update folders that `actions/upload-artifact` uploads; `run-report.ts` is the pure sync of one job's updates into a run report's manifest (immutable partitions, never-reused folder numbers, deferred deletion). (2) *The deployer*: `deploy-plan.ts` asks the Actions API what is pending and which deployment is the base and writes `pending.json`; `deploy-apply.ts` is a pure function of (base directory, pending updates) that applies them in the spec's order, keeps `site-state/`, and reuses today's placement, retention, rolling-report and badge code (refactored out of `site-main.ts`); `deploy-prune.ts` deletes old artifacts. `deploy-fetch.ts` downloads the update and state artifacts through the REST API and a 100-line zip reader (`zip.ts`); the workflow steps around them (`pages-deploy.yml`, the new `otel-html-deploy` action) download only the Pages tarball, with `actions/download-artifact` and `tar`. (3) *The pusher*: `artifact-client.ts` is a 150-line upload client for the Actions artifact service (Twirp JSON, a block-blob PUT, a stored zip from `zip.ts`), `pusher.ts` the detached loop. The viewer gains `refreshReport` beside `openReport`, and the receiver an OTLP/HTTP forwarder.

**Tech Stack:** TypeScript (strict), zod 4, commander, `node:*` only; vitest; Playwright; GitHub Actions (`actions/download-artifact` v8, `actions/upload-artifact` v7, `actions/upload-pages-artifact` v5, `actions/deploy-pages` v5, `actions/github-script` v8, all pinned by SHA). **No new dependency** (D51).

**Spec:** `docs/superpowers/specs/2026-11-06-incremental-ci-publishing-design.md`, with §10 (the maintainer's decisions) and §11 (the designer's calls) binding, and §12 ("Left to the builder") answered by the builder check below. It builds on the format-4 spec and plans: `docs/superpowers/plans/2026-11-06-format-4-writer.md` (R50, R51, R57), `2026-11-07-format-4-viewer.md` (R88: the shared assets base per channel depth, R92: `ci report` writes `local`), `2026-11-09-format-4-host.md` (R127: the epoch window). The dogfood design `2026-10-30-ci-dogfood-design.md` §6.1 is the publisher-never-runs-PR-code rule this plan keeps.

**Process:** unattended (`docs/agents/process-unattended.md`); PRs target `main`, the next PR branches from the updated `main`. Implementers and task reviewers on Sonnet 5.5, the branch review on Opus 5.5; each review's summary names its model. **Stop-and-ask tasks**, as the process requires for anything that runs with a write token: every task of PR 3 (`ci-report.yml`, the new `pages-deploy.yml`, `otel-html-publish`, the new `otel-html-deploy`, `ci.yml`, `load.yml`), Tasks 4.1, 4.4 and 4.5 of PR 4 (`actions-smoke.yml`, `otel-html-setup`, `ci.yml`), and the maintainer's own step of deleting `gh-pages` (Task 7.1). The coordinator stops before each of those tasks, shows the diff it intends, and waits.

## Builder check (2026-11-09, against the live site and API)

The spec's §12 items, checked before this plan was written. Each finding is applied in the decisions below.

1. **A deployment's run and artifact.** `GET /repos/{o}/{r}/deployments?environment=github-pages&per_page=30` lists deployments newest first with an empty `payload`; `GET /repos/{o}/{r}/deployments/{id}/statuses` lists its states (`waiting`, `queued`, `in_progress`, `success`), and every status's `log_url` is `https://github.com/{o}/{r}/actions/runs/<run id>/job/<job id>`. Verified: deployment 7667742413 → status `success` at 2026-11-09T22:25:30Z → run 42711121901 → `GET /repos/{o}/{r}/actions/runs/42711121901/artifacts?name=github-pages` → one artifact (13715193873, 1-day expiry). The artifacts endpoints take an exact-match `name` query (the spec's "no name filter" holds only for prefixes), and the repository listing (`/actions/artifacts`, 100 per page, newest first) had 3,283 artifacts, so the creation-time floor of §5.3 is needed.
2. **The Pages CDN ignores request cache directives.** `index.json` fetched with `Cache-Control: no-store` or `no-cache` answered `x-cache: HIT`, the same `etag`, `cache-control: max-age=600`. A Refresh cannot force a fresh manifest; it can only say how old the one it read is (D55).
3. **The artifact service protocol** (`actions/toolkit`, `packages/artifact`, main on 2026-11-09): `ACTIONS_RUNTIME_TOKEN` is a JWT whose `scp` claim holds `Actions.Results:<workflow run backend id>:<workflow job run backend id>`; `ACTIONS_RESULTS_URL` is the service origin. `POST <origin>/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact` with JSON `{ workflowRunBackendId, workflowJobRunBackendId, name, version, mimeType: { value: 'application/zip' }, expiresAt? }` (`version` is the client version the toolkit sends, 7 on main today; `expiresAt` an RFC 3339 string) answers `{ ok, signedUploadUrl }`; the zip is uploaded to that URL as an Azure block blob (the toolkit streams 8 MiB blocks with `blobHTTPHeaders.blobContentType`); `FinalizeArtifact` with `{ workflowRunBackendId, workflowJobRunBackendId, name, size: '<bytes>', hash: { value: 'sha256:<hex>' } }` answers `{ ok, artifactId }`. Retryable statuses 429, 500, 502, 503, 504. Both variables reach JavaScript actions only (the spec's constraint stands).
4. `zlib.crc32` exists in Node 24.22.1 and Bun 1.4.4 (the stored-zip writer needs it; checked here).
5. `actions/download-artifact` v8 (its `src/download-artifact.ts`, checked by the plan's branch review) lists **one run's** artifacts (`listArtifacts({ latest: true, findBy: { workflowRunId: run-id } })`) and filters `artifact-ids` against that list, so ids from other runs are "not found"; a single matched artifact is extracted into `path` itself, several into `path/<name>/`. It does download one named artifact of another run (`name` + `run-id` + `github-token`). So the action uses it for the `github-pages` tarball only, and the CLI downloads updates and states itself: `GET /repos/{o}/{r}/actions/artifacts/{id}/zip` answers 302 to a signed URL (followed without the Authorization header, https only, as `fetchJobLog` does), and the zip is read by `zip.ts`.
7. `otel-html run` flushes every `writer.flushIntervalMs` (default 5,000); a session compacts at close only when it has two or more flush partitions (`#compactGroup`, `picks.length < 2` returns). The smoke's job must therefore produce at least two flushes (Task 4.4).
6. `cicd` resource attributes, deterministic ids (`src/cli/ci/ids.ts`), the channel mapping (`channelFor`, `pullsOfRun`) and the shared assets base (`runAssetsBase`, R88) exist and are reused unchanged.

## Decisions this plan makes

Numbering continues the format-4 plans (D35 to D50). The maintainer can object at review; the spec's §10 decisions are not re-decided.

- **D51 No new dependency.** The upload client is written here: the Twirp calls of builder check 3 over `fetch`, one `PUT` of the whole zip to the signed URL with `x-ms-blob-type: BlockBlob` and `x-ms-blob-content-type: application/zip` (an update is a few MB; a zip above 256 MiB is refused with a clear error rather than block-uploaded), and a stored (uncompressed, method 0) zip writer with `zlib.crc32`: partitions are ZSTD Parquet already. `@actions/artifact` (14 transitive dependencies, among them the Azure SDK) is not added. `zip.ts` also reads zips: the central directory (zip64 fields honoured), methods 0 and 8 (`zlib.inflateRawSync`), entries rejected when their name has `..` or starts with `/`, when the unix mode in the external attributes marks a symlink, or when the inflated size disagrees with the directory; a tar reader is not written, so the `github-pages` tarball is downloaded by `actions/download-artifact` (`name` + `run-id`, builder check 5) and unpacked with `tar -xf` in the action. The upload path is proven on a Linux and a Windows runner before the pusher is built on it (Task 4.1, the spec's rule).
- **D52 The deploy pass is split into an API half and a pure half.** `ci deploy plan` talks to the API (deployments, artifacts, runs, jobs, pull requests), downloads the (small) site-state artifacts it needs, and writes `pending.json`: every candidate update with its artifact id, name, the facts of the run that uploaded it and (for a `run` update) of the run it reports, its channel, and `accepted` or a rejection reason (§7). `ci deploy fetch` downloads the accepted updates into `<out>/<name>/`. `ci deploy apply` reads the base directory, the chosen `site-state/`, the unpacked updates and `pending.json`, and never calls the API, so it is a pure function of (base, pending) tested over fixture directories. `ci deploy prune` is the API step with `continue-on-error`; `ci deploy scan` rewrites `files.json` after the preview step.
- **D53 Run-report bookkeeping lives in `site-state/runs.json`, not in the run manifest.** The manifest schema is strict (a new field is a format change). Per run report path: the next partition number (the high-water mark, never reused), the attempt the report shows, and per job the display name, the newest applied sequence and the sources it lists. Spec §5.1 ("kept in the run manifest") is deviated from and recorded.
- **D54 A `run` update is placed with renumbered partitions, in a scratch copy first.** The deployer copies the update's report to a scratch folder, upgrades it there (`site`, the channel's shared base, R57), then renumbers its partitions to start at the run's high-water mark (paths and `n` only; statistics unchanged; the wrappers are gone by then, so none is orphaned), then copies the files into the run folder **without removing it**: the provisional partitions keep their paths until their deferred deletion falls due and no path ever names two files (§5.1). The old manifest's files go into `deletions.json`. `runSite`'s own path keeps today's behaviour (remove, copy, upgrade) until PR 3 removes it.
- **D64 A `run` update is compacted and in `site` format.** `ci update run` writes the update's report with `mergeWithConfig(deps, config, { format: 'site', assetsBase: runAssetsBase(reportPath, version), compact: true })` over the `ci report` output (§5.4 step 3's `merge --compact`), removes `data/state/`, and carries `report/index.html`, `report/.nojekyll`, `report/data/manifest.js` and `report/data/partitions/<p6>/<table>.parquet`: no `assets/`, no wrappers (about half the size of the `local` artifact). The deployer re-upgrades the copy with its own version's base.
- **D65 State artifacts carry their form in their name.** A pass that deploys uploads `otel-html-site-state-<its run id>`; a consumed-only pass uploads `otel-html-site-state-base-<deployment id>`. So `plan` finds the full state of the base deployment by exact name in the base run, and the consumed-only states built on it in the listing walk (they are newer than the full state's floor: the floor is at least an hour before that pass, and a consumed-only pass comes after it), downloads each candidate (a few KB) and keeps the newest counting one. The spec's single name `otel-html-site-state` is deviated from and recorded.
- **D66 Retention and `remove-pr` deletions are deferred too** (§5.3 step 4). The functions extracted from `site-main.ts` take a `remove: (site, paths) => Promise<void>` collaborator: `runSite` passes `removePaths` (today's behaviour, unchanged until PR 3), the deployer passes `scheduleDeletion`, which lists a folder's files into `deletions.json` and leaves them in place. The channel's badges and rolling report skip runs whose `conclusion` is `in_progress` (`channelBadges`, `rollingInputs`): a provisional run has duplicate roots and no verdict.
- **D67 The smoke builds the branch for the new steps.** `actions-smoke.yml` keeps its `smoke` job on the released binary (its purpose) and gains a `publish` job on Linux and Windows that checks out, runs `./.github/actions/setup` and `mise run build`, and uses the actions with `command: node dist/cli/main.js`: the `ci update`, `ci upload`, `ci pusher` and `ci deploy` commands exist only on the branch until a release ships them.
- **D55 Refresh re-reads `data/manifest.js` through the script loader with a cache-busting query** (`?r=<ms>`), takes the payload from the registry, and the in-progress line shows the manifest's `updatedAt` as "updated <n> min ago" (builder check 2: the CDN may still serve the old one; the age says so). Refresh replaces the registered file set against the new manifest (new files registered, dropped files `dropFile`d), re-runs the view statements, clears the Mosaic cache (`QueryEngine.clearCache()`, new on the seam) and builds a new `DataSource` over the same engine; the app swaps it and every page re-queries. A served report (`otel-html host`) shows the line without Refresh (#246: the host serves one manifest). Polling is a checkbox on the line, every 60 s, remembered in `sessionStorage` (per tab), off by default.
- **D56 A 404 on a listed partition reads "this report has changed; Refresh".** DuckDB-WASM's message for a registered URL that answers 404 is measured in a unit test (Task 5.1) and matched by `isGoneFile(error)`; the pages' error alerts offer Refresh when it matches.
- **D57 `ci site` and `ci cleanup` are removed (in PR 3); `ci link` reads the live index.** Their only caller was the publish action; their logic moves into the deployer (`site-main.ts` keeps `placeFinishedRun`, `removePullRequest`). `ci link` gains `--index-url <base>/index.json` in PR 2 beside `--site`, and PR 3 removes `--site` with the action that passed it. The channel page's URL comes from `channelFor` (the API, as `ci update run` computes it), not the index; the "previous run" is the index's newest run of the channel that is not this run and not `in_progress` (preferring the same workflow), so a run the live index does not list yet (its own `run` update deploys a minute later; the index may be ten minutes stale) still gets both lines. The README's "stable flags" table changes accordingly.
- **D58 Inputs move to where the work is.** `otel-html-publish` keeps `run-id`, `version`, `command`, `config`, `target`, `comment`, `check`, `cleanup-pr`, `token`; gains `reopen-pr` and `deployer-workflow` (default `pages-deploy.yml`); drops `deploy`, `preview`, `retention` and `pr-retention`. The new `otel-html-deploy` takes `version`, `command`, `token`, `config`, `retention` (30), `pr-retention` (10), `preview` (false), `ci-workflows` (default `ci.yml`, comma-separated workflow file names), `report-workflow` (`ci-report.yml`), `keep-deployments` (3), `update-retention-days` (90). `otel-html-collect` gains `publish` (false) and `deployer-workflow`; `otel-html-setup` gains `push-every` (empty) and `config`.
- **D59 Updates are authenticated by the uploading run (workflow file path, event, branch) and by their name.** The artifact's `workflow_run.id` names the uploader; `GET /actions/runs/{id}` gives `path` (`.github/workflows/ci.yml`), `event`, `head_branch`, `head_repository`, `run_attempt`, `actor.type`. The artifact **name** carries the facts §7 trusts from `update.json` (`parseUpdateName` returns them all): a `push` is `otel-html-update-push-<job key>-<sequence>`, uploaded by a run whose `path` is one of `ci-workflows` with event `push`, `pull_request`, `schedule` or `workflow_dispatch`; its run and attempt are the uploader's, its channel `channelFor(run, pulls, defaultBranch)` with the pull requests of `run.head_sha` (as `ci site` maps it today), and a numeric job key must be a job id of that run and attempt (`fetchJobs`; a hashed key of an approximate job cannot be checked and is accepted: §7's "a forged value can only misplace the uploader's own run's data", recorded). A `run` is `otel-html-update-run-<run id>-<attempt>`, uploaded by a `report-workflow` run with event `workflow_run` or `workflow_dispatch` on the default branch; the named run is fetched, must be a `ci-workflows` run of this repository, and gives the channel and the `SiteRun` facts. `remove-pr` and `reopen-pr` are `otel-html-update-<kind>-<pr>-<run id>`, uploaded by a `report-workflow` run with event `pull_request_target` on the default branch; the pull request number comes from the name. `apply` rejects an update whose `update.json` disagrees with its name (kind, run, attempt, job key, sequence, pull request) and any update over 256 MiB, and a `push` that would take a run report past 512 MiB of partitions ("too large", a rejection like any other, so a fork cannot fill the 1 GB Pages site). A run with no channel is rejected ("no channel").
- **D60 The pusher's protocol with the collect step.** The pusher writes `.otel-html/publish/pusher.pid`, logs to `.otel-html/publish/pusher.log`, keeps the ledger `.otel-html/publish/uploads.json` (`{ sequence, shipped: string[], uploads: [{ name, sequence, sources, finishedAt }] }`; written atomically, read by both). A sequence is **reserved before** its upload starts (`sequence` is bumped and written first) and never reused: an upload whose `FinalizeArtifact` succeeded but whose answer was lost would otherwise collide with its own name on the retry, and a job's names must be unique. `ci update push --final` writes `.otel-html/publish/pusher.stop`, waits up to 90 s for the pid file to vanish (the pusher checks the stop file every second and after each upload, exits 0 and removes its pid file), then kills the pid if it is still alive, then builds the final update with sequence `ledger.sequence + 1`. The pusher detaches itself: invoked without `--detached` it spawns its own executable with `--detached`, `detached: true`, `stdio: ['ignore', log, log]`, `unref()`, and exits 0 at once; `io.spawn` and `process.execPath`/`process.argv` give the command. The wait strategy (§12) is a manifest poll: every tick reads `data/manifest.js` and compares the sorted `source` list with the ledger's `shipped` plus the last listing; `complete` is ignored.
- **D61 The CI-spans partition is a real report.** The uploader writes `jobTraceRequest(...)` through `createReportWith` into a scratch folder with the CI config (`--config`, default the action's `otel-html-ci.yaml`) and `format: 'site'`, closes it, and carries its one partition (`spans.parquet`, `traces.parquet`) in the update as `ci` with source `ci:<job key>`. `jobSourceKey(jobId, attempt)` is the numeric API id as text, or `h` plus the first 12 hex of the sha256 of `<attempt>:<approximate id>` (`name:<hint>@<runner>` holds `@`, which `SOURCE_RE` refuses, and the attempt keeps a re-run's hashed key, and so its artifact names, distinct). A job's own partitions list as `job:<job key>#<source>` (`job:12345#compact:3..7`). The job's display name (`jobName`, §5.4's re-run matching) comes from the jobs API when `GITHUB_TOKEN` is set, else from the `OTEL_HTML_JOB_NAME`/`GITHUB_JOB` hint; the deployer prefers the name the API gave `plan` for a numeric key.
- **D62 Fan-out is OTLP/HTTP, as received.** `--export-otlp <base url>` (config `receiver.exportOtlp`, default none) on `run` and `serve`: after a request is accepted (answered 200 or partial success) its decoded body is POSTed to `<base>/v1/<traces|logs|metrics>` with the content type it arrived with (`application/x-protobuf` or `application/json`; a gRPC-received request is forwarded as protobuf over HTTP, the same message bytes) and the headers of `OTEL_EXPORTER_OTLP_HEADERS` (parsed by the CLI; `key=value,key2=value2`, URL-decoded). `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` is a usage error naming the follow-up issue (gRPC fan-out, §12) only when forwarding is configured; `http/protobuf` and `http/json` both mean this path. Bounded queue: 64 requests or 64 MiB, whichever first; a full queue drops and counts (`stats().forwardDropped`); one `warn` per process on the first failure; 10 s per request, no retry; `close()` waits up to 5 s for the queue. The endpoint never comes from a request.
- **D63 Test-only flags for the smoke.** `ci deploy apply --trust-updates --channel <key>` accepts every update folder under `--updates` without `pending.json`, into the named channel, for `actions-smoke.yml`'s deployer leg against a scratch base; the README marks both as test flags.

## Plans for this spec

This plan covers milestones 1 to 3 (§9). Milestone 4, the object store target, "stays planned" (§5.8): a later plan, written when the maintainer picks a store. The `gh-pages` branch is deleted by the maintainer after PR 3's first deploy (Task 7.1).

## Global Constraints

- No new runtime or dev dependency (`test/scaffold.test.ts`'s list is unchanged). `src/cli/ci/` imports `node:*`, `zod`, `commander` (through `commands/ci.ts`) and the project's own modules only.
- The site index (`index.json`, `SiteIndex` version 1), the channel keys (`branch/<slug>`, `pr/<n>`), the run folder (`<channel>/runs/<run id>/`), retention (30 and 10 per workflow), the rolling report, the badges and the landing page keep their shapes (§3).
- The manifest schema (`ManifestV4Schema`) does not change; the format version stays 4; `SOURCE_RE` already admits `job:` and `ci:` sources.
- `update.json` is validated with a strict zod schema reusing `SOURCE_RE` and the `PartitionFile` shape; `readUpdate` walks the **whole** update tree with `entryKind` and rejects anything that is not a plain file or folder (a symlink would be dereferenced by `upload-pages-artifact` into the deployed site), and every file must be a layout path of its kind: a `push` has `update.json`, `partitions/<i>/<table>.parquet`, `ci/<table>.parquet`; a `run` has `update.json`, `report/index.html`, `report/.nojekyll`, `report/data/manifest.js`, `report/data/partitions/<p6>/<table>.parquet` (D64); `remove-pr`/`reopen-pr` have `update.json` alone. No `..`, no absolute path. A `push` writes only under its run's folder (§7). Every manifest the deployer writes is validated with `parseAnyManifest` first.
- Every GitHub Actions `uses:` is pinned by SHA with a version comment, as the repository does; composite action inputs have `description` and `default`.
- The public API (`src/api/index.ts`) does not change; the config schema gains exactly `receiver.exportOtlp` (string, optional). The CLI gains `ci update`, `ci dispatch`, `ci deploy`, `ci upload`, `ci pusher` and `--export-otlp`; `ci site` and `ci cleanup` go; `ci link --site` becomes `--index-url` (D57).
- Engineering standards: strict TS, no `any`, typed `OtelHtmlError`s, injected deps (`fetch`, `fs`, `clock`, `spawn`), Biome clean, README in the PR that changes behaviour, TDD per task, `mise run check` before every push, the Chromium e2e suite before every PR; a workflow or action change is validated with `actionlint` if available (`mise x actionlint -- actionlint` or the pinned binary) and otherwise by the smoke run.
- Writes of `site-state/*.json`, `update.json`, the ledger and `pending.json` are atomic (`writeTextAtomic` or a temp file and rename).

## Review Focus

1. **A listed partition whose file is nowhere** (a `push` update that lists `job:7#compact:3..5` while the update carrying its files is still uploading): the job's updates stay pending, the run manifest is unchanged and valid, and the next pass with the carrier applies both. (Task 1.2, Task 2.3)
2. **A deploy that fails after the Pages artifact was uploaded** (or a `deploy` job cancelled while pending): nothing is marked consumed, the next pass finds the same base and the same pending set, and applying twice gives the same site (`applied.json` idempotence). (Task 2.3, Task 2.4)
3. **A forged `update.json`** (a fork run's `push` naming another run id or another job; a `run` update from a run that is not `ci-report`; a file path `../../index.html`; a symlink inside the update): the channel and run come from the API, the job must belong to that run and attempt, the others are rejected and recorded, and a rejection never stops the rest of the pass. (Task 2.2, Task 1.1)
4. **A reader holding an old manifest** after a step's compaction or a `run` update: every file the old manifest listed is still on the site 14 minutes after the drop went live, and gone after 15; the viewer that meets the 404 offers Refresh. (Task 2.3, Task 5.1)
5. **The pusher must never fail a job**: no `ACTIONS_RUNTIME_TOKEN`, no results URL, a 503 from the service, a report folder that does not exist yet, a partition file removed between the manifest read and the copy (a compaction), Windows: each is a log line in `pusher.log`, the tick is retried, the step's exit code is 0, and the collect step turns the log into one notice. (Task 4.3, Task 4.4)

---

## PR 1: Updates, the run-report sync and provisional CI spans

Branch `feat/publish-updates` from `main`. Title: `feat(ci): site updates, the run-report sync and provisional CI spans`.

Pure library code and its tests; no workflow, action or CLI change. Test files are knip entries, so the new modules should pass `mise run knip` on their own; if knip still flags an export nothing but a test uses, list it in a knip ignore entry with a comment naming PR 2, removed there.

### Task 1.1: The update contract

**Files:**
- Create: `src/cli/ci/update.ts`
- Test: `test/cli/ci/update.test.ts`

**Interfaces:**
- Consumes: `PartitionFile`, `PartitionEntry` (`src/format/manifest.ts`), `Table`, `TABLES` (`src/format/parquet/columns.ts`), `JobId` (`src/cli/ci/ids.ts`), `FileSystem` (`src/writer/ports.ts`), `parseWith` (`src/format/validate.ts`).
- Produces:
  ```ts
  export const UPDATE_PREFIX = 'otel-html-update-';
  export const UPDATE_FILE = 'update.json';
  export type UpdateKind = 'push' | 'run' | 'remove-pr' | 'reopen-pr';
  /** One partition the update lists: its site `source`, its manifest entry's files (paths update-relative: `partitions/<i>/<table>.parquet`), and whether this update carries those files. */
  export interface UpdatePartition { source: string; files: Partial<Record<Table, PartitionFile>>; carried: boolean }
  export interface UpdateJson {
    version: 1; kind: UpdateKind; runId: number; runAttempt: number; createdAt: string;
    jobId?: number | string; jobName?: string; sequence?: number;         // push
    partitions?: UpdatePartition[]; ci?: UpdatePartition;                 // push (ci: source `ci:<job key>`, always carried, files `ci/<table>.parquet`)
    pr?: number;                                                           // remove-pr, reopen-pr
  }
  export const UpdateJsonSchema: z.ZodType<UpdateJson>; // strict; `push` requires jobId, jobName, sequence, partitions; `remove-pr`/`reopen-pr` require pr; `run` allows none of them
  /** `otel-html-update-push-<job key>-<sequence>`, `-run-<run>-<attempt>`, `-remove-pr-<pr>-<run>`, `-reopen-pr-<pr>-<run>`. */
  export function updateName(u: UpdateJson): string;
  export type ParsedName =
    | { kind: 'push'; jobKey: string; sequence: number }
    | { kind: 'run'; runId: number; runAttempt: number }
    | { kind: 'remove-pr' | 'reopen-pr'; pr: number; runId: number };
  export function parseUpdateName(name: string): ParsedName | undefined; // D59: the facts the deployer trusts come from here
  /** The name's facts and the json's agree (kind, run, attempt, job key from `jobSourceKey(jobId, runAttempt)`, sequence, pr). */
  export function nameMatches(parsed: ParsedName, u: UpdateJson): boolean;
  export function jobSourceKey(jobId: JobId, runAttempt: number): string; // D61
  export const MAX_UPDATE_BYTES = 256 * 1024 * 1024;
  /** Reads and validates `<dir>/update.json`, then walks the whole tree: every entry is a plain file or folder (`entryKind`), every file a layout path of the update's kind (Global Constraints), carried partitions' files exist and match `bytes`, the total is at most MAX_UPDATE_BYTES. Failures are `invalid-report` naming the path. */
  export async function readUpdate(fs: FileSystem, dir: string): Promise<UpdateJson>;
  ```

- [ ] **Step 1: Write the failing tests**: `updateName` for each kind equals the spec's names (`push` with `jobId: 7, sequence: 3` → `otel-html-update-push-7-3`; `jobId: 'name:build@r1'` → `otel-html-update-push-h<12 hex>-3`, `jobSourceKey` of that id is stable across calls and differs between attempts 1 and 2); `parseUpdateName('otel-html-update-remove-pr-5-42')` → `{ kind: 'remove-pr', pr: 5, runId: 42 }`, `parseUpdateName('otel-html-update-push-h0123456789ab-3')` → the key and sequence, `parseUpdateName('ci-run-report')` → undefined, a malformed tail (`-push-7-x`) → undefined; `nameMatches` false when the json's `runId` or `sequence` differs; `UpdateJsonSchema` rejects an unknown key, a `push` without `sequence`, a `remove-pr` without `pr`, `runId: '42'`, a source `job:7#bad source` (`SOURCE_RE`); `readUpdate` over a temp directory (real `createNodeFileSystem`, so symlinks exist) accepts a valid `push` folder, rejects a file path `../x.parquet`, a path `data/partitions/000000/spans.parquet` (not a `push` layout path), an extra file `notes.txt`, a symlink anywhere in the tree (`fs.symlinkSync`; the test is skipped on Windows if the link cannot be made), a carried partition whose file is missing, one whose `bytes` differs from the file, and a total over `MAX_UPDATE_BYTES` (a sparse file or a stubbed size); a `run` folder with `report/assets/` is rejected.
- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/update.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** `update.ts`.
- [ ] **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): the site update contract: update.json, artifact names, validated paths`

### Task 1.2: The run report and the sync

**Files:**
- Create: `src/cli/ci/run-report.ts`
- Test: `test/cli/ci/run-report.test.ts`

**Interfaces:**
- Consumes: `ManifestV4`, `PartitionEntry` (`src/format/manifest.ts`), `partitionFilePath`, `partitionDir`, `MANIFEST_PATH`, `MANIFEST_KEY` (`src/format/paths.ts`), `wrapDataFile`, `unwrapDataFile`, `reviveDataJson` (`src/format/data-file.ts`), `statisticsKeysFor` (`src/format/parquet/stats.ts`), `ENGINE_VERSION` (`src/format/engine.ts`), `renderIndexHtml` (`src/writer/html.ts`), `WriterDeps`, `ResolvedConfig`, `UpdateJson`, `UpdatePartition` (Task 1.1). The manifest's `config` field is built the way `buildManifest` in `src/writer/partition-checkpoint.ts` builds it: `viewer` (with the facet caps), `dashboards`, `views` of the resolved config.
- Produces:
  ```ts
  /** D53: the deployer's bookkeeping for one run report (`site-state/runs.json` entry). */
  export interface RunReportState { next: number; attempt: number; jobs: Record<string, { name: string; sequence: number; sources: string[] }> }
  export const emptyRunState = (attempt: number): RunReportState;
  export interface NewManifestOptions { title: string; epochUnixNano: string; createdAt: string; assetsBase: string; config: ResolvedConfig; version: string }
  /** An empty, `complete: false` v4 manifest in `site` format with `statisticsKeysFor` each table from `config`. */
  export function newRunManifest(o: NewManifestOptions): ManifestV4;
  export interface JobUpdate { dir: string; update: UpdateJson } // one unpacked push update of the job
  export interface SyncInput {
    manifest: ManifestV4; state: RunReportState; jobKey: string; jobName: string; attempt: number;
    updates: readonly JobUpdate[]; // this job's pending updates, any order
    now: string; // updatedAt
  }
  export interface FileMove { fromDir: string; from: string; to: string } // copy `<fromDir>/<from>` to `<site>/<run>/<to>`
  export interface SyncPlan { manifest: ManifestV4; state: RunReportState; copies: FileMove[]; drops: string[]; pending: boolean }
  /**
   * §5.1 as a pure function. The listing is the highest-sequence update's `partitions` plus its `ci`; sequences at or
   * below `state.jobs[jobKey].sequence` are ignored (`pending: false`, no change) and an older attempt than
   * `state.attempt` too. A listed partition's files come from the manifest (same `source`), else from any update that
   * carries them; when neither has one, `pending: true` and nothing else changes. New partitions take numbers from
   * `state.next` upward; their `values` are normalised to the manifest's `statisticsKeys` (`values[k] ?? null` per
   * listed key, other keys dropped, as `copyPartitions` does); the job's partitions whose `source` is no longer
   * listed, and its previous `ci:` partition, are dropped (`drops`: their site-relative paths). Totals and range are
   * recomputed from the entries; `complete` false; `updatedAt` now; the result passes `parseAnyManifest` (asserted).
   */
  export function planSync(input: SyncInput): SyncPlan;
  /** The manifest with partitions renumbered from `from` (ascending, paths rewritten) and the file moves that realise it (D54). */
  export function renumbered(manifest: ManifestV4, from: number): { manifest: ManifestV4; moves: { from: string; to: string }[] };
  /** Writes `data/manifest.js` (`wrapDataFile`), `index.html` (`renderIndexHtml(entry, title, { assetsBase })`) and `.nojekyll` into `dir`. */
  export async function writeRunReport(deps: Pick<WriterDeps, 'fs' | 'viewerAssets'>, dir: string, manifest: ManifestV4): Promise<void>;
  export async function readRunManifest(fs: FileSystem, dir: string): Promise<ManifestV4 | null>; // null when `data/manifest.js` is absent
  ```

- [ ] **Step 1: Write the failing tests** (manifest entries from `test-support/format4-fixture.ts`'s `buildFormat4Report` or hand-built `PartitionFile`s with `values: {}`):
  - `newRunManifest` validates with `parseAnyManifest`, has `complete: false`, `engine: { version: ENGINE_VERSION, format: 'site', assetsBase }`, `statisticsKeys.spans` containing `resource:cicd.pipeline.run.id` for the CI config;
  - `planSync` on an empty manifest with one update (sequence 1, two carried partitions and a `ci`) gives three entries numbered 0, 1, 2 with sources `job:7#flush:0`, `job:7#flush:1`, `ci:7`, three copy sets, no drops, `state.next` 3, `state.jobs['7'].sequence` 1, totals the sum of rows, `range` the min and max of `timeMin`/`timeMax`, and each entry's `values` has exactly the manifest's `statisticsKeys` (an update file with an extra key loses it, a missing key is `null`);
  - a second update (sequence 2) listing `job:7#compact:0..1` (carried) and `ci` (carried) drops the two flush partitions and the old `ci` (`drops` has their paths), adds entries 3 and 4, and `state.next` is 5;
  - applying sequence 2 again, or sequence 1 after 2, is `pending: false` with the same manifest (idempotent, out-of-order converges);
  - an update listing a partition carried by none and absent from the manifest is `pending: true` with the manifest unchanged; the same with an older update carrying it applies and copies from the older update's dir;
  - two updates of different jobs leave each other's entries alone (call `planSync` twice);
  - an update with `runAttempt` below `state.attempt` is `pending: false`; one above it sets `state.attempt`, drops only the sources of jobs whose `name` in `state.jobs` equals this update's `jobName`, and resets `complete` (the manifest passed in has `complete: true`);
  - `renumbered(m, 10)` on a two-partition manifest gives `n` 10 and 11, paths `data/partitions/000010/...`, validates, and `moves` map old to new paths;
  - `writeRunReport` then `readRunManifest` round-trips, and `index.html` references `assetsBase` and no `otel-html-host` meta.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): the run report on the site: a pure sync of one job's updates, renumbering, never-reused folders`

### Task 1.3: Provisional CI spans

**Files:**
- Modify: `src/cli/ci/workflow-trace.ts`
- Test: `test/cli/ci/workflow-trace.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const PROVISIONAL_ATTR = 'otel_html.ci.provisional';
  /**
   * §5.5: the provisional workflow root (start = the run's start, end = `now`, `otel_html.ci.provisional: true`), this
   * job's span (start known, end = `now`, provisional) with its `queued` span and the steps that have `completed_at`
   * (final), under the same resources, ids and attributes as `workflowTraceRequest`.
   */
  export function jobTraceRequest(key: string, run: ApiRun, job: ApiJob, now: number, approximate: ReadonlyMap<number, JobId>): object;
  ```

- [ ] **Step 1: Tests**: over the fixture `run`/`job` of `test/cli/ci/publish-e2e.test.ts`'s shape with one completed and one running step, `jobTraceRequest(key, run, job, now, new Map())` has: a root span with `spanId === runSpanIdOf(key)`, `endTimeUnixNano === ns(now)` and attribute `otel_html.ci.provisional` true; the job span with `jobSpanIdOf(key, 7)`, parent the root, provisional; the completed step with its final end and no provisional attribute; the running step absent; the `queued` span present; `workflowTraceRequest`'s spans carry no `otel_html.ci.provisional` attribute (unchanged).
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): a job's provisional workflow root and job span from the jobs API`

### PR 1 close

- [ ] `mise run verify`; PR; body notes D53, D54 (the renumbering), D61. Branch review on Opus 5.5. Merge.

---

## PR 2: The deployer and the update writers as CLI commands

Branch `feat/publish-deployer` from `main`. Title: `feat(ci): otel-html ci deploy plans, applies and prunes site updates; ci update writes them; ci link reads the live index`.

No workflow or action changes yet (PR 3): after this PR the commands exist, the publish action still runs `ci site` through the lease until PR 3 switches it. `ci site` and `ci cleanup` are removed from the CLI **in PR 3**, with the action; here they stay and share the refactored functions.

### Task 2.1: Site state and the zip reader

**Files:**
- Create: `src/cli/ci/site-state.ts`, `src/cli/ci/zip.ts` (the reader; Task 4.1 adds the writer)
- Test: `test/cli/ci/site-state.test.ts`, `test/cli/ci/zip.test.ts`

**Interfaces:**
```ts
// zip.ts
/** D51: entries of a zip (central directory, zip64 fields, methods 0 and 8); rejects `..`/absolute names, symlink entries (unix mode in the external attributes), a size that disagrees with the directory, and a total over `maxBytes`. */
export function readZip(bytes: Uint8Array, maxBytes: number): Map<string, Uint8Array>;
// site-state.ts
export const SITE_STATE_DIR = 'site-state';
/** D65: `otel-html-site-state-<run id>` (full) or `otel-html-site-state-base-<deployment id>` (consumed-only). */
export const STATE_PREFIX = 'otel-html-site-state-';
export type StateForm = { kind: 'full'; runId: number } | { kind: 'consumed'; base: number };
export function stateArtifactName(form: StateForm): string;
export function parseStateName(name: string): StateForm | undefined;
export interface AppliedJson {
  version: 1;
  form: StateForm;
  /** Consumed update artifact ids with their outcome, the artifact's `created_at` and the deployer run (`pass`) that consumed them; entries whose `createdAt` is older than `floor` are dropped on write. */
  updates: Record<string, { outcome: 'applied' | 'superseded' | 'removed-pr' | 'complete' | 'rejected'; createdAt: string; pass: number }>;
  /** The creation-time floor for the next listing: the oldest still-pending update's `created_at` (or this pass's start) minus one hour. */
  floor: string;
  writtenAt: string;
}
export interface RemovedJson { version: 1; prs: Record<string, { runId: number; at: string }> }
export interface FilesJson { version: 1; files: Record<string, number> }           // every site path and its size
export interface DeletionsJson { version: 1; files: { path: string; pass: number; liveAt?: string }[] } // pass: the deployer run that dropped it
export interface RunsJson { version: 1; runs: Record<string, RunReportState> }      // by run report path
export interface SiteState { applied: AppliedJson; removed: RemovedJson; files: FilesJson; deletions: DeletionsJson; runs: RunsJson }
export function emptyState(now: string): SiteState;
export const DELETION_GRACE_MS = 15 * 60_000;
export async function readSiteState(fs: FileSystem, dir: string, warn: (m: string) => void): Promise<SiteState>; // a missing file is its empty form; a malformed one warns and is empty
export async function writeSiteState(fs: FileSystem, dir: string, state: SiteState): Promise<void>; // atomic per file, `files.json` last
/** Walks `site` (skipping `site-state/`) into `FilesJson`. */
export async function scanFiles(fs: FileSystem, site: string): Promise<FilesJson>;
```

- [ ] **Step 1: Tests**: round trip of each file; a missing `site-state/` reads as `emptyState`; a malformed `applied.json` warns and reads empty; `writeSiteState` drops `applied.updates` entries whose `createdAt` is before `floor`; `scanFiles` over a memory-fs site lists `index.json` and `branch/main/data/manifest.js` with sizes and not `site-state/applied.json`; `stateArtifactName`/`parseStateName` round-trip both forms. `readZip`: a zip made by the system `zip` (skipped when absent) and one made by Python's `zipfile` with `ZIP_DEFLATED` (skipped when absent) both read back byte-identical; a hand-built zip with a `../x` name, with a symlink entry (external attributes `0xA1FF0000`), with a wrong size, and one over `maxBytes` are each rejected naming the entry; a zip64 end record (built by hand or with `zip -fz`) reads.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): the site's state files and a zip reader for update and state artifacts`

### Task 2.2: `ci deploy plan`

**Files:**
- Create: `src/cli/ci/deploy-plan.ts`, `src/cli/ci/deploy-fetch.ts`, `src/cli/ci/deploy-main.ts` (`runDeployPlan`, `runDeployFetch`)
- Modify: `src/cli/ci/github-api.ts` (`ApiRun` gains `path: string`, `actor: { type: string } | null`; new `ApiArtifact` (`id`, `name`, `size_in_bytes`, `created_at`, `expires_at`, `workflow_run: { id }`), `ApiDeployment`, `ApiDeploymentStatus` types; `fetchArtifacts(i, token, timeoutMs, stop: (createdAt: string) => boolean, fetchFn)` paging `/actions/artifacts?per_page=100` until `stop` or the end; `deleteJson(url, token, timeoutMs, fetchFn)`), `src/cli/commands/ci.ts` (`ci deploy plan`, `ci deploy fetch`)
- Test: `test/cli/ci/deploy-plan.test.ts`, `test/cli/ci/deploy-fetch.test.ts`

**Interfaces:**
```ts
// deploy-fetch.ts
/** `GET /actions/artifacts/<id>/zip` → 302 → the signed URL (https only, no Authorization), read with `readZip(bytes, maxBytes)` and written under `out` (each entry a plain file; folders made). */
export async function downloadArtifact(o: { apiUrl: string; repository: string; id: number; out: string; maxBytes: number }, fs: FileSystem, token: string | undefined, fetchFn: Fetch): Promise<{ files: number; bytes: number }>;
// deploy-plan.ts
export interface PlanOptions { repository: string; ciWorkflows: string[]; reportWorkflow: string; pagesUrl: string; stateOut: string /* where the chosen state's files are written */; now: string }
export type BaseKind = 'artifact' | 'live' | 'gh-pages' | 'empty' | 'wait';
export interface BaseInfo { kind: BaseKind; deploymentId?: number; runId?: number; artifactId?: number; liveAt?: string /* the success status's created_at */ }
export interface PendingUpdate {
  id: number; name: string; parsed: ParsedName; createdAt: string; sizeBytes: number;
  uploader: { runId: number; path: string; event: string; headBranch: string | null; sameRepo: boolean };
  /** The run the update is about: the uploader for push/remove/reopen, the named run for `run`. */
  run: (SiteRun & { event: string }) | null;
  channel: { key: string; channel: Omit<Channel, 'runs'> } | null;
  jobName?: string; // push: the API's display name of a numeric job key
  accepted: boolean; reason?: string;
}
export interface PendingPlan { version: 1; base: BaseInfo; state: StateForm | null /* the state written to stateOut, null when none counted */; updates: PendingUpdate[]; deletionsDue: number; floor: string; now: string }
/** §5.3 step 1, "the base, in order", and D59/D65, through `fetchFn`; downloads state artifacts only, never a site. */
export async function planDeploy(o: PlanOptions, deps: Pick<WriterDeps, 'fs'>, token: string | undefined, fetchFn: Fetch): Promise<PendingPlan>;
```
`runDeployPlan(opts, io, deps, fetchFn)` writes `pending.json` to `--out`, the chosen state to `--state-out`, prints a summary, and sets `GITHUB_OUTPUT`s: `pending` (`true` when any accepted update exists or `deletionsDue > 0`), `base_kind`, `base_run_id`, `base_artifact_id`, `wait` (`true` for `BaseKind` `wait`). Flags: `--repository`, `--out`, `--state-out`, `--pages-url`, `--ci-workflows` (default `ci.yml`), `--report-workflow` (default `ci-report.yml`). `runDeployFetch(opts, io, deps, fetchFn)` downloads every accepted update of `--pending` into `--out/<name>/` (`MAX_UPDATE_BYTES` each); a download that fails marks the update `rejected: 'download failed: ...'` in a rewritten `pending.json` and goes on (the next pass retries it).

The pass, in order. (1) The last successful deployment: deployments of `github-pages` newest first, the first whose statuses hold `success`; its run id from the `success` status's `log_url` (`/actions/runs/(\d+)/`), `liveAt` that status's `created_at`; `GET /actions/runs/<run>/artifacts?name=github-pages` (the base tarball) and `?name=otel-html-site-state-<run>` (the full state, D65). (2) The state: download the full state when it exists (`downloadArtifact`), read its `applied.json` for the floor; without one, the live `<pagesUrl>/site-state/applied.json` (a 404 is "everything pending", floor `now - 1 h`). (3) The listing walk: `fetchArtifacts` with `stop = created_at < floor`; names with `STATE_PREFIX` whose form is `consumed` with `base === deploymentId` are downloaded (newest first, the first that parses wins) and replace the state; names with `UPDATE_PREFIX` not in `applied.updates` are candidates. (4) Authentication (D59): one `GET /actions/runs/<id>` per distinct run (cached); for a `push` the uploader's pulls (`fetchPullsForSha`) and jobs (`fetchJobs` of its attempt) once per run; for a `run` the named run and its pulls. (5) `deletionsDue`: entries of the state's `deletions.json` whose `pass === base.runId` get `liveAt` and count when `liveAt + 15 min <= now`. Base kinds: `live` when no tarball but the live site serves `site-state/files.json`; `wait` when so and the newest deployment is younger than 10 minutes; `gh-pages` when neither and `GET /repos/{o}/{r}/branches/gh-pages` is 200; else `empty`. The new `floor` is `min(created_at of the candidates still pending) - 1 h`, or `now - 1 h` when none.

- [ ] **Step 1: Write the failing tests** with a fake `fetchFn` keyed by URL (the `site-main.test.ts` pattern; zip bodies from Task 2.1's test helper): a repository with two deployments (the newest without `success`, the older with `success` → `log_url` run 11, whose artifacts are `github-pages` 100 and `otel-html-site-state-11` 101 holding an `applied.json` with a floor and one consumed id) and artifacts, newest first: `otel-html-site-state-base-<that deployment>` 102 (newer than 101, holding two more consumed ids → it is the state written to `stateOut`), `otel-html-update-push-7-1` (uploader run 21, `path: .github/workflows/ci.yml`, event `pull_request`, head sha with an open PR 5, jobs of attempt 1 include id 7 named `check` → accepted, channel `pr/5`, `jobName: 'check'`), `otel-html-update-push-9-1` (run 21, no job 9 → rejected "not a job of run 21 attempt 1"), `otel-html-update-push-h0123456789ab-1` (run 21 → accepted, hashed key), `otel-html-update-run-22-1` (uploader run 30, `ci-report.yml`, `workflow_run`, head branch `main`; run 22 is a `ci.yml` run on `main` → accepted, channel `branch/main`, `run.conclusion` from run 22), `otel-html-update-run-22-2` (uploader run 31 on branch `feat` → rejected "not the default branch"), `otel-html-update-run-23-1` (uploader run 23 is `ci.yml`, `push` → rejected "not the report workflow"), `otel-html-update-push-8-1` (uploader with event `pull_request_target` → rejected), `otel-html-update-remove-pr-5-24` (`ci-report.yml`, `pull_request_target`, `main` → accepted, `pr` 5), `ci-run-report` (ignored), one consumed id (skipped), one older than the floor (page 2 is never requested: the fake asserts). Assert the `PendingPlan` (base `artifact` 100, state `consumed`, the accepted set, the reasons, the channels, `floor`). Then: no `success` anywhere + live `files.json` 200 + newest deployment 2 minutes old → `wait`; 12 minutes old → `live`; no live `files.json` + branch 200 → `gh-pages`; branch 404 → `empty`; a `deletions.json` entry with `pass` 11 and `liveAt` 16 minutes before `now` → `deletionsDue` 1 and `pending=true` with no updates. `runDeployPlan` writes `pending.json`, the state files and the outputs. `downloadArtifact`: a 302 to `https://blob.test/x` whose second request carries no `Authorization` header and answers a zip → the files on disk; a 302 to `http://` is rejected; a zip over `maxBytes` is rejected; `runDeployFetch` writes `<out>/<name>/` per accepted update and marks a 404 download `rejected`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): ci deploy plan finds the base, the newest site state and the pending updates, authenticated by their runs and names; ci deploy fetch downloads them`

### Task 2.3: `ci deploy apply`

**Files:**
- Create: `src/cli/ci/deploy-apply.ts`
- Modify: `src/cli/ci/site-main.ts` (extract `placeFinishedRun(site, placed: { key, channel }, siteRun: SiteRun, report: string, o: { retention, prRetention, config, deps, io, remove: (site: string, paths: string[]) => Promise<void>; renumberFrom?: number }): Promise<{ rolling: 'built' | 'stub' }>` and `removePullRequest(site, pr, repository, deps, io, remove): Promise<boolean>` from `runSite`/`runCleanup`, which call them with `removePaths` and no `renumberFrom`, so their behaviour and tests are unchanged; D66), `src/cli/ci/site.ts` (`channelBadges` and `rollingInputs` skip runs with `conclusion: 'in_progress'`, D66), `src/cli/ci/site-io.ts` (`placeRunReport(deps, from, to, assetsBase, opts?: { renumberFrom: number })`: with `renumberFrom` it works in a scratch copy, upgrades, renumbers with `renumbered` and moves, then copies into `to` without removing it, D54; without, today's path), `src/cli/ci/deploy-main.ts` (`runDeployApply`), `src/cli/commands/ci.ts` (`ci deploy apply`)
- Test: `test/cli/ci/deploy-apply.test.ts`, `test/cli/ci/site.test.ts` (badges and rolling inputs skip in-progress runs), `test/cli/ci/deploy-plan.test.ts` (one more test: with no accepted update and no deletion due, `runDeployPlan` writes `pending=false`, so the action downloads nothing)

**Interfaces:**
```ts
export interface ApplyOptions { site: string /* the unpacked base, edited in place */; state?: string /* the state `plan` chose; overwrites <site>/site-state/ first (§5.3 step 1) */; updates: string /* <dir>/<artifact name>/ per update */; pending: PendingPlan; repository: string; retention: number; prRetention: number; config?: string; passRunId: number; now: string; trust?: { channel: string } /* D63 */ }
export interface ApplyResult { changed: boolean; consumed: number; deployed: boolean /* = changed */; previews: string[] /* branch channels whose rolling report was rebuilt */; pendingJobs: string[]; rejected: number }
export const MAX_RUN_PARTITION_BYTES = 512 * 1024 * 1024; // D59
/** §5.3 steps 3 to 5 over directories: remove-pr and reopen-pr by time, then push (one sync per run and job), then run; deletions due; state written; never deploys. */
export async function applyUpdates(o: ApplyOptions, deps: WriterDeps, io: CliIo): Promise<ApplyResult>;
/** D66: lists the files under each path (a folder's files recursively) into `deletions.json` with `pass`; removes nothing. */
export function scheduleDeletion(state: SiteState, site: string, paths: string[], pass: number): Promise<void>;
```
Rules the tests pin: `readUpdate` and `nameMatches` gate every update (a mismatch or a bad tree is `rejected`); a `push` for a run whose manifest in the base is `complete` for that attempt is `superseded`; a `push` for a pull request in `removed.json` is `removed-pr` until a `reopen-pr`; a `push` that would take the run's partition bytes past `MAX_RUN_PARTITION_BYTES` is `rejected: 'too large'`; a `run` update replaces the run folder through `placeFinishedRun` with `renumberFrom` from `runs.json` (D54; `next` of a run the state does not know is one above the highest partition folder on disk, 0 for a new run), schedules the old manifest's files, applies retention (through `scheduleDeletion`), rebuilds the rolling report and badges, writes the index and landing, `ensureSharedAssets` + `pruneAssets`; a `push` creates the run folder and the channel's `index.json` entry with `conclusion: 'in_progress'` and no rolling rebuild; `deletions.json` entries whose `pass` equals `pending.base.runId` get `liveAt = pending.base.liveAt`, and those with `liveAt` at least 15 min before `now` are deleted; a pass that consumed nothing and changed nothing writes no state (`changed: false`); a pass that only consumed (every update superseded or rejected) writes the consumed-only form naming `pending.base.deploymentId`.

- [ ] **Step 1: Write the failing tests** over a temp directory site with `resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' })` and update folders built from `buildFormat4Report` partitions (write a helper `test-support/update-dir.ts`: `writePushUpdate(dir, u: UpdateJson, files)`); a `pending.json` built by hand:
  - one `push` (job 7, sequence 1) on an empty base, and the same on a base without `site-state/` that holds an old-publisher site (an `index.json` with a channel and a run folder: the `gh-pages` tree or the old deploy job's artifact): `<channel>/runs/<run>/data/manifest.js` lists the partitions and the `ci:7` entry, `index.json` has the run with `conclusion: 'in_progress'`, `assets/9.9.9/` exists, `site-state/runs.json` has `next`, `applied.updates[id] === 'applied'`, `changed: true`;
  - the same pending again on the result: `changed: false`, `consumed: 0`;
  - sequence 2 listing a compacted source: the flush files are still on disk, listed in `deletions.json` with `pass`, and absent from the manifest; a third pass whose `pending.base` is that pass's deployment with `liveAt` 16 min before `now` deletes them; at 14 min it does not (Review Focus 4);
  - a `push` whose listed partition's files are nowhere: the job in `pendingJobs`, the manifest unchanged, the update not in `applied` (Review Focus 1); a `push` whose `update.json` names another run than its artifact name, and one whose tree holds a symlink: `rejected`, the rest of the pass applied;
  - a `run` update (a `site`, compacted report with no `assets/`, D64, under `report/`) over a run with provisional partitions numbered 0 to 2: the final report's partitions start at 3, the provisional files are byte-identical on disk after the pass (D54's order), their paths are in `deletions.json`, `complete` is true, the rolling report folder has `data/manifest.js`, a `badge-ci.json` exists and names no in-progress run, `previews` is `['branch/main']` for the default branch's channel and `[]` for `pr/5`; a run the state does not know but whose folder holds `000000` to `000004` gets `renumberFrom` 5;
  - retention over a channel with 31 `ci` runs: the dropped run's files are in `deletions.json`, still on disk; the same for `remove-pr`'s folder (D66);
  - a `push` arriving after that `run` for the same attempt: `superseded`; for attempt 2 with the same job name: applied and `complete` false again, the attempt-1 partitions of that job name dropped, the other job's kept (§5.4 re-runs);
  - `remove-pr` for `pr/5` then a `push` for it: the folder gone, the push `removed-pr`; then `reopen-pr` then the push: applied;
  - a rejected update in `pending.json` is recorded `rejected` and the rest of the pass runs (Review Focus 3); an update folder whose `update.json` fails `readUpdate` (a `..` path) is recorded `rejected` with a warning;
  - a pass with every update superseded: `changed: false`, `consumed: 2`, `applied.json` in the consumed-only form naming `pending.base.deploymentId`;
  - `files.json` after a pass lists every file written and no `site-state/` entry; `trust: { channel: 'branch/smoke' }` applies two update folders without `pending.json` entries.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** (`deploy-apply.ts` orchestrates; `planSync` and the extracted site functions do the work; the CLI flags: `--site`, `--state`, `--updates`, `--pending`, `--repository`, `--retention`, `--pr-retention`, `--config`, `--pass-run-id`, `--trust-updates`, `--channel`; outputs `changed`, `consumed`, `deploy`, `previews`, `pending_jobs`). **Step 4: Run**; PASS; the existing `site-main.test.ts` and `site.test.ts` still pass unchanged (the live `ci-report` runs this code with a write token until PR 3: `runSite` and `runCleanup` behave exactly as before). `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): ci deploy apply applies pending updates to a site in the spec's order with deferred deletion and site state`

### Task 2.4: `ci deploy prune`, `ci deploy fetch-live` and `ci deploy scan`

**Files:**
- Create: `src/cli/ci/deploy-prune.ts`
- Modify: `src/cli/ci/deploy-main.ts` (`runDeployPrune`, `runDeployFetchLive`, `runDeployScan`: `scan` rewrites `<site>/site-state/files.json` with `scanFiles`, for the action to run after the preview step wrote new `preview-*.png` files, so a cold start never meets a size mismatch), `src/cli/commands/ci.ts`
- Test: `test/cli/ci/deploy-prune.test.ts`

**Interfaces:**
```ts
/**
 * §5.3 step 6: keeps the `github-pages` and `otel-html-site-state-*` artifacts of the newest `keep` successful deployments
 * and deletes older ones (a failed pass's too); deletes the update artifacts whose `applied.updates[id].pass` is at or
 * below the oldest kept deployment's run id (deployer run ids grow with time, and that deployment's own applied.json
 * lists everything consumed at or before its pass, so falling back to it never meets an update that is gone). Returns
 * what it deleted; a failed delete is a warning.
 */
export async function pruneArtifacts(o: { repository: string; keep: number; applied: AppliedJson; token?: string; now: string }, fetchFn: Fetch, warn: (m: string) => void): Promise<{ deleted: number[] }>;
// state artifacts are found by STATE_PREFIX in the listing (D65); the kept deployments' runs come from the deployments API as in plan
/** Cold start (§5.3 base 2): GETs `<pagesUrl>/site-state/files.json` and every listed path into `out`; fails `invalid-report` when a file is missing or its size differs. */
export async function fetchLiveSite(o: { pagesUrl: string; out: string }, fs: FileSystem, fetchFn: Fetch): Promise<{ files: number; bytes: number }>;
```
- [ ] **Step 1: Tests**: with five successful deployments (runs 10, 20, 30, 40, 50) and `keep: 3`, the `github-pages` and state artifacts of runs 10 and 20 are deleted (the fake records `DELETE /actions/artifacts/<id>`), a failed pass's artifacts (run 25) too, and of the `applied` updates those with `pass` 10, 20 or 30 are deleted while `pass` 40 and 50 stay; a 403 on one delete is a warning and the rest proceed. `fetchLiveSite` over a local `node:http` server serving a fixture site writes every file and rejects on a size mismatch. `runDeployScan` after a new `preview-light.png` was written lists it in `files.json` with its size.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): ci deploy prune keeps three deployments; fetch-live rebuilds a base from the live site; scan refreshes files.json`

### Task 2.5: `ci update` and `ci dispatch`

**Files:**
- Create: `src/cli/ci/update-main.ts`, `src/cli/ci/dispatch.ts`
- Modify: `src/cli/commands/ci.ts`, `src/cli/ci/report-main.ts` (exports `resolveChannel(run, pulls, defaultBranch)` or reuses `channelFor` directly)
- Test: `test/cli/ci/update-main.test.ts`, `test/cli/ci/dispatch.test.ts`

**Interfaces:**
```ts
// update-main.ts
/** `ci update push`: the job's live set from `--report`'s manifest and the ledger (D60), the job id from `.otel-html/context.json` (`parseJobContext`) and the run from `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT`/`GITHUB_REPOSITORY`, the CI-spans partition (D61) from the API when GITHUB_TOKEN is set, written to `--out/<name>/`; `--final` stops the pusher first and uses `ledger.sequence + 1`. Outputs `name`, `sequence`, `partitions`; `name=` empty when the report has no partitions yet. Never throws: a failure is a `::warning::` and `name=` empty. */
export async function runUpdatePush(o: { report: string; out: string; final: boolean; config?: string; publishDir?: string /* default <report>/../publish */ }, io: CliIo, deps: WriterDeps, fetchFn?: Fetch): Promise<void>;
/** `ci update run` (D64): merges the `ci report` output, compacted, into `--out/<name>/report/` in `site` format on the channel's shared base (`runAssetsBase(reportPath, deps.version)`, R88), removes `report/data/state/`, writes `update.json`; outputs `name`, `channel`, `report-url` (`<base-url>/<channel>/runs/<run>/`, or empty and `published=false` when the run has no channel). */
export async function runUpdateRun(o: { report: string; out: string; runId: number; repository: string; baseUrl: string; config?: string }, io: CliIo, deps: WriterDeps, fetchFn?: Fetch): Promise<void>;
/** `ci update remove-pr` / `reopen-pr`: `update.json` alone; outputs `name`. */
export async function runUpdatePr(o: { kind: 'remove-pr' | 'reopen-pr'; pr: number; out: string }, io: CliIo): Promise<void>;
/** `ci update done`: records a finished upload in the ledger (`--name`), and prints the pusher log's failures as one `::notice::` when `--log` is given. */
export async function runUpdateDone(o: { name: string; publishDir: string; log?: string }, io: CliIo): Promise<void>;
// dispatch.ts
/** §5.2: dispatches `--workflow` on the default branch when GITHUB_RUN_ID's run is a same-repository run whose `actor.type` is `User`; any failure (403 included) is one log line; exit 0 always. */
export async function runDispatch(o: { workflow: string; repository: string; runId: number }, io: CliIo, fetchFn?: Fetch): Promise<void>;
```
- [ ] **Step 1: Tests**: `runUpdatePush` over a `local` job report written by `createReportWith` with two flushes (`close: false` then a flush) lists two `flush:` sources carried, `update.json` validates, the files are under `partitions/0/`, `partitions/1/`; with a ledger whose `shipped` names one source, that partition is listed `carried: false` and its files absent; after `close()` the listing is one `compact:` source; `--final` with a pid file of a dead pid proceeds (no wait); with `GITHUB_TOKEN` and a fake jobs API the update has a `ci` partition whose `spans.parquet` holds the provisional root (decode with `test-support/duckdb-node.ts` or `parquet-metadata.ts`: rows = root + job + queued + completed steps); without a token no `ci` and a warning. `runUpdateRun` over a two-partition `local` report writes `name=otel-html-update-run-42-1`, `channel=pr/5`, `report-url=https://x/pr/5/runs/42/`, and `<out>/<name>/report/` holds one compacted partition per signal, a manifest with `engine.format` `site` and `assetsBase` `../../../../assets/<version>/`, no `assets/`, no `.parquet.js`, no `data/state/`, and `readUpdate` accepts the folder. `runUpdatePush` with a token: `jobName` is the API's display name; without: the hint. `runUpdatePr` names. `runDispatch`: `actor.type: 'User'` same repo → `POST /actions/workflows/pages-deploy.yml/dispatches` with `{ ref: '<default branch>' }`; `Bot` → no POST, one line; a 403 → one line, resolves.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): ci update writes push, run, remove-pr and reopen-pr updates; ci dispatch wakes the deployer`

### Task 2.6: `ci link --index-url`; README

**Files:**
- Modify: `src/cli/ci/link.ts` (`previousRunOf(index, key, runId, baseUrl, workflow)`: the channel `key`'s newest run that is not `runId` and not `in_progress`, preferring `workflow`; `channelPageOf(key, channel, baseUrl)`), `src/cli/ci/link-main.ts` (`--index-url` beside `--site`, one of the two required: with `--index-url` the index is `parseSiteIndex(await fetch(indexUrl).text())` (a failure is a warning and no previous-run line) and the channel comes from `channelFor` with the run's pulls, D57; with `--site` today's path, unchanged until PR 3 removes it), `src/cli/commands/ci.ts`, `README.md` ("This repo's CI" table: `ci link` flags; new rows for `ci update`, `ci dispatch`, `ci deploy plan|fetch|apply|prune|fetch-live|scan` with their flags and outputs, the D63 test flags marked)
- Test: `test/cli/ci/link.test.ts` (`previousRunOf` skips this run and an in-progress run and prefers the same workflow; `--index-url` with an index that does not list this run still yields the channel page and the previous run)

- [ ] **Step 1 to 4**; **Step 5: Commit** `feat(ci): ci link reads the previous run from the live site index`

### PR 2 close

- [ ] `mise run verify`; PR; body notes D52, D57, D59, D63 and the §5.1 deviation (D53). Branch review on Opus 5.5. Merge.

---

## PR 3: The deployer workflow, the actions and the cutover (stop and ask)

Branch `ci/pages-deployer` from `main`. Title: `feat(ci)!: the site deploys from a Pages artifact through one deployer; jobs publish updates; gh-pages retired`.

Every task here changes files that run with a write token: the coordinator stops before **each** task with the intended diff and waits for the maintainer. `!`: the publish action's inputs change (D58).

### Task 3.1: The `otel-html-deploy` action and `pages-deploy.yml`

**Files:**
- Create: `.github/actions/otel-html-deploy/action.yml`, `.github/workflows/pages-deploy.yml`
- Move: `.github/actions/otel-html-publish/preview.mjs` → `.github/actions/otel-html-deploy/preview.mjs` (unchanged)

The action (composite; inputs per D58; `token` default `github.token`; it runs on Linux: `tar` and the paths below): resolve the command as `otel-html-publish` does; `ci deploy plan` (`id: plan`, `--pages-url` from `actions/configure-pages`'s `base_url`, `--out $RUNNER_TEMP/otel-html-deploy/pending.json`, `--state-out $RUNNER_TEMP/otel-html-deploy/state`; it downloads the state artifacts itself, D65); every later step `if: steps.plan.outputs.pending == 'true'`; the base by kind: `actions/download-artifact` (`name: github-pages`, `run-id: ${{ steps.plan.outputs.base_run_id }}`, `github-token`, `path: $RUNNER_TEMP/otel-html-deploy/tarball`) then `mkdir base && tar -xf tarball/artifact.tar -C base` for `artifact`; `actions/checkout` (`ref: gh-pages`, `fetch-depth: 1`, `path: base`, `persist-credentials: false`) + `rm -rf base/.git` for `gh-pages`; `ci deploy fetch-live --out base` for `live`; `mkdir base` for `empty`; `wait` ends the pass (`echo "::notice::..."`, every later step also conditioned on `wait != 'true'`); `ci deploy fetch --pending ... --out $RUNNER_TEMP/otel-html-deploy/updates` (the CLI's REST download, builder check 5); `ci deploy apply --site base --state <state-out> --updates <updates> --pending ... --pass-run-id $GITHUB_RUN_ID` (`id: apply`); the preview browser install and `node preview.mjs base <channel>` for each of `previews` when `preview == 'true'` (as the publish action did), then `ci deploy scan --site base`; `if: steps.apply.outputs.deploy == 'true'`: `actions/upload-pages-artifact` (`path: base`, `retention-days: 90`), `actions/upload-artifact` (`name: otel-html-site-state-${{ github.run_id }}`, `path: base/site-state/`, `retention-days: 90`), `actions/deploy-pages` (`id: deployment`); `else if consumed > 0`: `actions/upload-artifact` of `base/site-state/` as `otel-html-site-state-base-${{ steps.plan.outputs.base_deployment_id }}` alone; `ci deploy prune` with `continue-on-error: true`. Outputs: `deployed`, `page_url`. `plan` also outputs `base_deployment_id`.

`pages-deploy.yml`: triggers `workflow_dispatch`, `workflow_run: { workflows: [ci-report], types: [completed] }`, `schedule: '*/5 * * * *'`; `permissions: {}`; the first step of each job is `if: github.run_attempt > 1` → `exit 1` with the spec's reason (a re-run of a deploying workflow is never allowed); job `plan` (`actions: read`, `deployments: read`, `pages: read`, `contents: read` for the checkout; `mise run build`; `ci deploy plan` with `command: node dist/cli/main.js`; output `pending`); job `deploy` (`needs: plan`, `if: needs.plan.outputs.pending == 'true'`, `concurrency: { group: pages, cancel-in-progress: false }`, `environment: github-pages`, permissions `contents: read`, `actions: write`, `deployments: read`, `pages: write`, `id-token: write`; checkout `main`, setup, build, `./.github/actions/otel-html-deploy` with `command: node dist/cli/main.js`, `config: .github/otel-html-ci.yaml` when present, `preview: true`, `ci-workflows: ci.yml,load.yml`).

- [ ] **Step 1: Stop and ask** with the two files' text. **Step 2**: write them; `actionlint` clean if available. **Step 3: Commit** `ci: the otel-html-deploy action and the pages-deploy workflow`

### Task 3.2: `otel-html-publish` and `ci-report.yml`

**Files:**
- Modify: `.github/actions/otel-html-publish/action.yml` (D58: after `ci report`, `ci update run --base-url` from `configure-pages`; `actions/upload-artifact` of `$RUNNER_TEMP/otel-html-update/<name>` as `<name>` with `retention-days: 90` and `overwrite: true` (a re-run of `ci-report` reuses the name) when `name` is set; `ci dispatch --workflow <deployer-workflow>`; `ci link --index-url <base_url>/index.json --url <report-url>`; `cleanup-pr` and `reopen-pr` through `ci update remove-pr|reopen-pr` + upload + dispatch; no lease, no deploy, no preview; `token` needs `actions: write` (dispatch), `pages: read`, `pull-requests: write`, `checks: write`), `.github/workflows/ci-report.yml` (`report`: permissions `actions: write`, `contents: read`, `pages: read`, `pull-requests: write`, `checks: write`; `cleanup` on `pull_request_target: [closed, reopened]` passing `cleanup-pr` or `reopen-pr`, permissions `actions: write`; the `deploy` job removed; comments updated)
- Delete: `.github/actions/otel-html-publish/site-lease.sh`, `site-branch.sh`, `site-publish.sh`, `test/actions/site-branch.test.ts`, `test/actions/site-publish.test.ts`
- Modify: `test/actions/preview-version.test.ts` (reads the Playwright version from `otel-html-deploy/action.yml` now), `src/cli/commands/ci.ts` (remove `ci site`, `ci cleanup`, `ci link --site`), `src/cli/ci/site-main.ts` (remove `runSite`, `runCleanup`; keep the extracted functions), `src/cli/ci/link-main.ts` (`--index-url` required), `test/cli/ci/site-main.test.ts` (tests move to the extracted functions), `README.md` (D57 rows removed)

- [ ] **Step 1: Stop and ask** with the diff, and tell the maintainer the rollout facts: (a) pull requests opened before this PR run the old `otel-html-publish` from their head (ci-report checks out a person's PR head), which needs the `contents: write` this PR removes, so their reports fail until they rebase; (b) `release.yml` moves `@v0` at the next release, so other repositories using `otel-html-publish@v0` stop deploying until they add the deploy job (the README's migration paragraph); (c) rollback is `git revert` of this PR, which brings the lease publisher back and needs `gh-pages` to still exist, so the branch should be deleted only after a few days of passes. **Step 2**: apply; `mise run check` PASS. **Step 3: Commit** `feat(ci)!: otel-html-publish uploads a run update and links; ci-report no longer writes or deploys the site`

### Task 3.3: Jobs publish at their end; the README and release notes

**Files:**
- Modify: `.github/actions/otel-html-collect/action.yml` (inputs `publish` default `false`, `deployer-workflow` default `pages-deploy.yml`, `command` default `otel-html`, `config`, `token` default `github.token`; when `publish`: `ci update push --final --out $RUNNER_TEMP/otel-html-update` (`id: update`, `GITHUB_TOKEN` from `inputs.token`), `actions/upload-artifact` of the update folder as `${{ steps.update.outputs.name }}` with `retention-days: 90` `if: steps.update.outputs.name != ''`, `ci update done --name ... --log .otel-html/publish/pusher.log`, `ci dispatch`; the existing `.otel-html/` upload unchanged), `.github/workflows/ci.yml` and `load.yml` (every report-producing job: `permissions: { contents: read, actions: write }`; the collect step gains `publish: true` and `command: node dist/cli/main.js`), `.github/workflows/actions-smoke.yml` (D67: a new `publish` job on `ubuntu-latest` and `windows-latest` that checks out, runs `./.github/actions/setup` and `mise run build`, uses `otel-html-setup` and `otel-html-collect` with `command: node dist/cli/main.js` and `publish: true`; the `smoke` job on the released binary is unchanged), `README.md` ("This repo's CI": the deployer, the site's life cycle (updates, passes, deferred deletion, `site-state/`), the permissions, `pages-deploy.yml`; "Use in your CI": the publisher example rewritten with the `deploy` job on `otel-html-deploy`, the inputs tables of D58, "Pages setup", the migration paragraph (add the deploy job, Pages source "GitHub Actions", delete `gh-pages` after the first pass), the security paragraph on `actions: write` from §7; the `--single-branch` paragraph stays until Task 7.1), `docs/agents/process-unattended.md` (the stop-and-ask list names `pages-deploy.yml` and `otel-html-deploy` too)

- [ ] **Step 1: Stop and ask**. **Step 2**: apply; `mise run check`; `mise run gen:check`. **Step 3: Commit** `feat(ci): jobs upload a push update at their end and wake the deployer; README for the deployer`

### PR 3 close

- [ ] `mise run verify`; PR (the e2e suite as always). The PR's own CI exercises `ci.yml`'s collect step (`publish: true`: the uploads use the runtime token every job has, so `otel-html-update-push-*` artifacts appear on the PR's run; its `ci dispatch` logs a 404, since `pages-deploy.yml` does not exist on `main` yet, and nothing is deployed until the merge) and `actions-smoke.yml`'s `publish` job. Branch review on Opus 5.5. Merge.
- [ ] **After the merge**: the push to `main` runs `ci`, then `ci-report` uploads a `run` update and dispatches; watch `pages-deploy.yml`'s first pass (base kind, duration, the site size in the uploaded tarball), download that run's `github-pages` artifact and check the tarball holds `site-state/applied.json` (§8: `upload-pages-artifact` drops dotfiles, not `site-state/`), and record the figures in the PR's merged body (edit) and in Task 7.2's record. If the first pass fails, fix forward in a `fix(ci):` PR (stop and ask applies).
- [ ] Tell the maintainer the first pass deployed, so they can delete `gh-pages` (Task 7.1 records it).

---

## PR 4: The pusher

Branch `feat/publish-pusher` from `main`. Title: `feat(ci): a detached pusher uploads a job's partitions while it runs`.

### Task 4.1: The upload client, proven on the runners (stop and ask: `actions-smoke.yml`)

**Files:**
- Create: `src/cli/ci/artifact-client.ts`, `src/cli/ci/upload-main.ts`
- Modify: `src/cli/ci/zip.ts` (the writer beside Task 2.1's reader), `src/cli/commands/ci.ts` (`ci upload --name <n> --path <dir> [--retention-days <d>]`), `.github/workflows/actions-smoke.yml` (in the branch-built `publish` job of D67, a step after the collect: `actions/github-script` pinned, `env: { CMD: node dist/cli/main.js }`, script: split `CMD` on whitespace, `spawnSync(exe, [...args, 'ci', 'upload', '--name', 'otel-html-smoke-upload-<os>', '--path', '.otel-html/'], { stdio: 'inherit', env: { ...process.env } })` (the runtime variables are in a JavaScript action's environment), `core.setFailed` on a non-zero exit; then a `bash` step `gh api repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts --jq '.artifacts[].name' | grep -qx otel-html-smoke-upload-<os>`)
- Test: `test/cli/ci/zip.test.ts`, `test/cli/ci/artifact-client.test.ts`

**Interfaces:**
```ts
// zip.ts
/** A stored (method 0) zip of `files` (`name` → bytes), UTF-8 names, DOS times from `mtime`, CRC32 via node:zlib; no zip64 (refuses a total above 4 GiB with `usage`). `readZip(storedZip(files))` gives `files` back. */
export function storedZip(files: readonly { name: string; bytes: Uint8Array; mtime: Date }[]): Uint8Array;
// artifact-client.ts
export interface ArtifactEnv { ACTIONS_RUNTIME_TOKEN?: string; ACTIONS_RESULTS_URL?: string }
export function backendIds(token: string): { workflowRunBackendId: string; workflowJobRunBackendId: string }; // the JWT's scp claim (builder check 3); `usage` when absent
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024; // D51
/** CreateArtifact → PUT → FinalizeArtifact; retries 429/5xx up to 5 times with 1 s, 2 s, 4 s, 8 s, 16 s backoff; returns the artifact id. */
export async function uploadArtifact(o: { name: string; zip: Uint8Array; retentionDays?: number; env: ArtifactEnv; now: () => number; fetchFn?: Fetch; sleep?: (ms: number) => Promise<void> }): Promise<{ id: number; size: number }>;
/** The files under `dir` (recursive, relative names with `/`) as a stored zip. */
export async function zipDirectory(fs: FileSystem, dir: string): Promise<Uint8Array>;
```
- [ ] **Step 1: Write the failing tests**: `storedZip` of two files reads back with `readZip` and unzips with the system `unzip -l` or Python's `zipfile` when available; the CRC of a known string (`crc32('hello')` is `0x3610a686`); `backendIds` of a JWT built in the test with `scp: 'Actions.GenericRead:00000000 Actions.Results:run-id:job-id'` gives both ids and rejects `usage` without the scope; `uploadArtifact` against a `node:http` server in the test answering the two Twirp routes and the blob `PUT` (asserting method, `x-ms-blob-type: BlockBlob`, body size, then JSON `{ ok: true, signedUploadUrl }` and `{ ok: true, artifactId: '77' }`) returns `{ id: 77 }` and sent `size: '<bytes>'`, `hash: { value: 'sha256:<hex of the zip>' }`, `version` a number, `mimeType: { value: 'application/zip' }`; a first 503 then 200 succeeds after one backoff (`sleep` recorded); a 400 rejects at once; `MAX_UPLOAD_BYTES + 1` rejects `usage` without a request.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**; `ci upload` prints the id. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Stop and ask** with the `actions-smoke.yml` diff. **Step 6**: commit `feat(ci): an artifact upload client (Twirp, block blob, stored zip) and ci upload`, push the branch, run `gh workflow run actions-smoke.yml --ref feat/publish-pusher` and wait: the three legs' upload step must pass (Linux x64, Windows, Linux arm64) and the artifact appear. If the Windows or Linux upload fails for a protocol reason that one fix does not cure, **stop and ask**: approach C waits and the PR ships Tasks 4.1's client alone with the smoke step removed (the spec's rule). Record the three legs' upload times in the PR body.

### Task 4.2: The pusher loop

**Files:**
- Create: `src/cli/ci/pusher.ts`
- Test: `test/cli/ci/pusher.test.ts`

**Interfaces:**
```ts
export interface PusherDeps { fs: FileSystem; clock: Clock; sleep: (ms: number) => Promise<void>; upload: typeof uploadArtifact; fetchFn: Fetch; log: (line: string) => void; deps: WriterDeps /* for the CI partition's scratch report */ }
export interface PusherOptions { report: string; publishDir: string; everyMs: number; config?: string; env: Readonly<Record<string, string | undefined>>; deployerWorkflow: string }
/** One tick (D60): read the manifest (absent: nothing), diff sources against the ledger and the last listing, reserve the next sequence in the ledger, build the update folder under `<publishDir>/tick-<n>/` (`runUpdatePush`'s builder, shared), zip, upload, record the finished upload in the ledger (`shipped`, `uploads`), dispatch, remove the folder. Every failure is one log line and `'retry'`; a retry takes a fresh sequence. */
export async function tick(o: PusherOptions, d: PusherDeps, last: string[] | null): Promise<{ outcome: 'uploaded' | 'unchanged' | 'retry'; listing: string[] }>;
/** Writes the pid file, loops `tick` every `everyMs` until the stop file exists (checked each second and after an upload) or SIGTERM, removes the pid file, resolves. */
export async function runPusher(o: PusherOptions, d: PusherDeps, signals: CliIo['signals']): Promise<void>;
```
- [ ] **Step 1: Tests** (memory fs or a temp dir; a fake `upload` recording names; fake `sleep` driving time): a report with one partition → the first tick uploads `otel-html-update-push-<key>-1` carrying it, the ledger has `shipped` and `sequence: 1`; a tick with no change → `unchanged`, no upload; a new flush → sequence 2 carrying only the new partition; a compaction (the manifest now lists one `compact:` source, the flush files deleted) → sequence 3 listing `compact:` carried, and the ledger's `shipped` holds all three; an upload that throws → `retry`, a log line containing the message, the ledger's `sequence` advanced but `shipped` unchanged, the next tick uploads the same listing under the next sequence (never a name twice); a partition file missing between the manifest read and the copy → `retry`; `runPusher` with the stop file created after two ticks resolves, the pid file is gone, and `everyMs` was respected (the fake `sleep` saw 60,000 or the remainder); no `ACTIONS_RUNTIME_TOKEN` in `env` → each tick logs once and `retry` (Review Focus 5).
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): the pusher loop: upload on change, a ledger of shipped partitions, a stop file`

### Task 4.3: `ci pusher` detaches itself

**Files:**
- Create: `src/cli/ci/pusher-main.ts`
- Modify: `src/cli/commands/ci.ts` (`ci pusher --report <dir> --every <duration> [--config <file>] [--deployer-workflow <file>] [--detached]`), `src/cli/io.ts` only if `spawn`'s typing needs `detached` (it is `typeof spawn`: no change expected)
- Test: `test/cli/ci/pusher-main.test.ts`

- [ ] **Step 1: Tests**: `runCli(['ci','pusher','--report','r','--every','60s'], io, deps)` with a fake `io.spawn` records one spawn of `process.execPath` with `process.argv[1]` (or, under Bun's binary, `process.execPath` alone: `'bun' in process.versions`) and the same arguments plus `--detached`, `detached: true`, `stdio` `['ignore', <fd>, <fd>]` of `.otel-html/publish/pusher.log`, `env` the io env, and `unref` called; exits 0 within the test without running a tick; `--every 5x` is a usage error; `--every 60s`, `2m`, `500ms` parse. The `--detached` path with a report that never changes and the stop file pre-created exits 0 after writing and removing the pid file (real fs in a temp dir, `everyMs` small).
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): ci pusher detaches itself and runs the loop under the job`

### Task 4.4: `otel-html-setup` starts the pusher (stop and ask)

**Files:**
- Modify: `.github/actions/otel-html-setup/action.yml` (inputs `push-every` default empty, `config` default empty, `deployer-workflow` default `pages-deploy.yml`; `if: inputs.push-every != ''` an `actions/github-script` step after `ci context`: split `CMD` on whitespace (`node dist/cli/main.js` is three words), `spawnSync(exe, [...args, 'ci', 'pusher', '--report', '.otel-html/report', '--every', <push-every>, ...])` with the two runtime variables in the child's env only, `stdio: 'inherit'`, `core.warning` on a non-zero exit, never `core.setFailed`; the `GITHUB_TOKEN` of `inputs.token` in the child's env as `GITHUB_TOKEN`), `.github/workflows/actions-smoke.yml` (in the `publish` job of D67: setup with `push-every: 3s`; one step **under the job shell** with `env: { OTEL_HTML_CONFIG: smoke.yaml }` where `smoke.yaml` sets `writer.flushIntervalMs: 1000`, which for 12 s posts a fixture span every second to `$OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces` with `curl` (the endpoint `run` exports to its child), so the job report gets several flush partitions mid-step and one compacted partition at the step's end (builder check 7); then a `bash` step asserts `.otel-html/publish/uploads.json` lists at least one upload and `pusher.pid` exists; after the collect (`publish: true`) a step downloads this run's `otel-html-update-push-*` artifacts (`actions/download-artifact` with `pattern` and no `merge-multiple`: several artifacts land in `downloaded/<name>/`; one would land in `downloaded/` itself, so the step moves it into a folder named by `update.json`'s name if `downloaded/update.json` exists) and runs `node dist/cli/main.js ci deploy apply --trust-updates --channel branch/smoke --site scratch --updates downloaded --repository "$GITHUB_REPOSITORY" --retention 30 --pr-retention 10 --pass-run-id "$GITHUB_RUN_ID"` and asserts `scratch/branch/smoke/runs/$GITHUB_RUN_ID/data/manifest.js` lists a `compact:` source for this job and no `flush:` one, and that the lowest-sequence update's `update.json` listed a `flush:` source (§8's two assertions); on Linux and Windows), `README.md` ("Use in your CI": `push-every`, what the pusher does, the log and ledger files, the notice; "This repo's CI": 60 s)

- [ ] **Step 1: Stop and ask** with the diffs. **Step 2**: apply; dispatch `actions-smoke.yml` on the branch; all legs green (Linux, Windows, arm64); record the ticks' upload durations from `pusher.log` (printed by the smoke) in the PR body. **Step 3: Commit** `feat(ci): otel-html-setup starts the pusher with push-every; the smoke proves a job publishes before it ends`

### Task 4.5: This repo pushes every minute (stop and ask)

**Files:**
- Modify: `.github/workflows/ci.yml`, `load.yml` (every `otel-html-setup` step gains `push-every: 60s` and `config: .github/otel-html-ci.yaml`; the setup step already runs after `mise run build` with `command: node dist/cli/main.js`, so the pusher runs the built CLI)

- [ ] **Step 1: Stop and ask**. **Step 2**: apply. **Step 3: Commit** `ci: every job pushes its partitions every minute`

### PR 4 close

- [ ] `mise run verify`; PR; body: D51, D60, D61, the smoke's upload times, the `update` artifact counts of one `ci` run (stay far below 500 per job). Branch review on Opus 5.5. Merge. After the merge, measure on the next `main` run: the time from a partition's `createdAt` in a `push` update to its appearance in the live manifest (`updatedAt` of `branch/main/runs/<run>/data/manifest.js`), three samples; record in Task 7.2 (the spec's table in §6: about 1 to 3 minutes).

---

## PR 5: The viewer: in progress, Refresh, polling

Branch `feat/viewer-refresh` from `main`. Title: `feat(viewer): in-progress reports show their age, Refresh re-reads the manifest, polling is opt-in`.

### Task 5.1: `refreshReport`, `clearCache`, the gone-file predicate

**Files:**
- Create: `src/viewer/data/refresh-report.ts`
- Modify: `src/viewer/data/query-engine.ts` (`clearCache(): void`), `src/viewer/data/mosaic.ts` (`clearCache` = `coordinator.clear({ clients: false, cache: true })` or the Coordinator API's equivalent; the REST engine the same), `src/viewer/data/engine/files.ts` (`registerFiles(engine, entries, deps, onProgress)` and `dropFiles(engine, paths)` extracted; `registerPartitions` = `registerFiles` of all + the views; `createViews(engine, manifest)`), `src/viewer/data/open-report.ts` (`OpenedReport`, `openReportRefreshable`), `test-support/duckdb-node.ts` and the fake engines in tests (`clearCache() {}`)
- Test: `test/viewer-data/refresh-report.test.ts`, `test/viewer-data/open-report.test.ts`

**Interfaces:**
```ts
// open-report.ts
export interface OpenedReport { dataSource: DataSource; /** D55: null on a served report. */ refresh: (() => Promise<DataSource>) | null }
export async function openReportRefreshable(rawManifest: unknown, deps: OpenDeps, onProgress: (p: LoadProgress) => void): Promise<OpenedReport>;
// openReport(...) stays and returns `(await openReportRefreshable(...)).dataSource`
// refresh-report.ts
export interface RefreshDeps { loader: ScriptLoader; registry: Pick<Registry, 'take'>; baseUrl: string; logger: Logger }
/** D55: loads `data/manifest.js?r=<now>` through the loader, takes `manifest` from the registry, validates (format 4), registers the files the new manifest lists and the old did not, drops the ones gone, recreates the views, clears the engine cache and returns a DataSource over the new manifest and the same engine. */
export async function refreshReport(engine: Engine, queryEngine: QueryEngine, previous: ManifestV4, deps: RefreshDeps, now: () => number): Promise<{ dataSource: DataSource; manifest: ManifestV4 }>;
/** A query failure caused by a registered file the site no longer serves: the browser engine's message for an HTTP 404 (matched broadly: /\b404\b|Not Found|HTTP error/i; the exact wording is measured in Task 5.3's e2e and recorded). */
export function isGoneFile(error: unknown): boolean;
```
- [ ] **Step 1: Write the failing tests** (the Node engine cannot register HTTP URLs, so the refresh logic is tested over a **fake** `Engine`/`QueryEngine` pair that records `registerFileURL`, `registerFileBuffer`, `dropFile`, the statements run through `query`, and `clearCache` calls; the data-source construction is checked by type and by one call that reaches the fake's `query`): `refreshReport` with a loader that registers a manifest listing partitions 0 and 1 over a previous manifest listing 0 → registers partition 1's files by their URLs (site) and nothing else, drops nothing, runs the five view statements of the new manifest, calls `clearCache` once, returns a data source whose `manifest` is the new one; a new manifest listing only partition 2 (a compaction) → registers 2, drops partition 0's and 1's paths; a `local` manifest → registers buffers from the wrappers through the loader; a manifest of format 3 rejects with the D12 message and nothing was registered or dropped; the loader is asked for `data/manifest.js?r=<now>`; `isGoneFile` matches `new Error('HTTP error 404 Not Found: data/partitions/000000/spans.parquet')` and not a parser error. `openReportRefreshable` with `host` set gives `refresh: null`; without, a function; `QueryEngine.clearCache` exists on the fakes and `test-support/duckdb-node.ts`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(viewer): refreshReport re-reads the manifest and replaces the registered partitions; the query engine clears its cache`

### Task 5.2: The in-progress line and the gone-file alert

**Files:**
- Create: `src/viewer/shell/in-progress.tsx`
- Modify: `src/viewer/main.tsx` (`openReportRefreshable`; `load` returns `OpenedReport`), `src/viewer/root.tsx`, `src/viewer/app.tsx` (state `ready: { dataSource, refresh }`; `onRefresh` swaps `dataSource`; a failed refresh is an inline error on the line, not a page failure), `src/viewer/shell/shell.tsx` (`refresh` prop → `PageChrome`), `src/viewer/shell/page-chrome.tsx` (the line under the header when `manifest.complete === false`), the pages' query-error alerts (`grep -rn "role=\"alert\"" src/viewer/traces src/viewer/logs src/viewer/metrics src/viewer/dashboards`: where a `DataSource` failure is shown, `isGoneFile(error)` → "This report has changed. Refresh." with the Refresh button), `src/viewer/data/trace-tree.ts` (§5.5's display rule: when two rows share a span id, `buildTraceTree` keeps the one without the `otel_html.ci.provisional` attribute set to true, else the one with the later end; today it keeps the first)
- Test: `test/viewer/in-progress.test.tsx` (testing-library: renders "In progress · updated 3 min ago" for `updatedAt` 3 minutes before a fixed now, a Refresh button that calls the prop, an "Auto-refresh" checkbox off by default that, once checked, calls refresh after 60 s of fake timers and is remembered in `sessionStorage` (`otel-html.poll`), no button when `refresh` is null, nothing rendered when `complete` is true), `test/viewer-data/trace-tree.test.ts` (two root rows with one span id, one provisional: the tree has one root, the non-provisional; two provisional: the later end; a span's attributes are read as `SpanRecord` carries them, see `src/model/`)

- [ ] **Step 1: Tests**; **Step 2 to 4**; **Step 5: Commit** `feat(viewer): an in-progress report shows its age with Refresh and an opt-in 60 s poll; a gone partition offers Refresh`

### Task 5.3: e2e: Refresh over HTTP; README

**Files:**
- Create: `e2e/refresh.spec.ts`
- Modify: `e2e/build-fixtures.ts` and `e2e/fixture.ts` (a `refresh` fixture: a two-flush `site` report written with `close: false` so `complete` is false; its `data/manifest.js` saved beside as `manifest.step1.js` listing only the first partition, and the full one as `manifest.step2.js`; the served copy starts at step 1), `README.md` ("Viewing" or "Report layout and hosting": the in-progress line, Refresh, polling, the CDN note from builder check 2)

- [ ] **Step 1: Tests** (serial, one worker, HTTP project only: the `HTTP` tag; the http project runs in Chromium only, so the 404 wording is measured there and Firefox's and WebKit's go to the record as unverified): open the `refresh` report, the Traces explorer shows the first partition's count and the line "In progress"; copy `manifest.step2.js` over the served `data/manifest.js`; click Refresh; the count is the full one and the line's age is fresh; the page's requests include the second partition's `spans.parquet` only after Refresh. Second test: with step 2 live, rename the served `data/partitions/000000/spans.parquet` away, open a trace that lives in it (or filter so the query reads it): the alert reads "This report has changed" and offers Refresh; record the engine's raw message (log it from the page's console in the test) in the test's comment and check `isGoneFile`'s pattern against it. `afterEach` restores the served files.
- [ ] **Step 2**: `mise run test:e2e:chromium -- e2e/refresh.spec.ts`; PASS. **Step 3: Commit** `test(e2e): Refresh picks up a new partition over HTTP; a gone partition offers Refresh`

### PR 5 close

- [ ] `mise run verify`; PR; body notes D55, D56, the measured 404 wording. Branch review on Opus 5.5. Merge.

---

## PR 6: OTLP fan-out

Branch `feat/receiver-export-otlp` from `main`. Title: `feat(receiver): --export-otlp forwards every accepted OTLP request to a collector over HTTP`.

### Task 6.1: The forwarder

**Files:**
- Create: `src/receiver/forward.ts`
- Modify: `src/receiver/receiver.ts` (`ReceiverOptions.forwarder?: Forwarder`; after `process` resolves (accepted or partial), `forwarder.enqueue(signal, body, encoding)`; `stats()` gains `forwarded`, `forwardDropped`, `forwardFailed`; `close()` awaits `forwarder.close()`), `src/config/schema.ts` (`receiver.exportOtlp: z.string().url().optional()`; README's config table), `src/receiver/http.ts` and `grpc.ts` (no change: the body reaches `receive` decoded already)
- Test: `test/receiver/forward.test.ts`, `test/receiver/receiver.test.ts` (one test)

**Interfaces:**
```ts
export interface ForwarderOptions { endpoint: string; headers: Record<string, string>; maxQueued?: number /* 64 */; maxQueuedBytes?: number /* 64 MiB */; timeoutMs?: number /* 10_000 */; fetchFn?: Fetch; logger: Logger }
export interface Forwarder { enqueue(signal: OtlpSignal, body: Uint8Array, encoding: BodyEncoding): void; stats(): { forwarded: number; dropped: number; failed: number }; close(): Promise<void> }
export const SIGNAL_PATH: Record<OtlpSignal, string>; // traces → /v1/traces, logs → /v1/logs, metrics → /v1/metrics
/** `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values URL-decoded) → headers; malformed pairs are `usage`. */
export function parseOtlpHeaders(text: string | undefined): Record<string, string>;
export function createForwarder(o: ForwarderOptions): Forwarder;
```
- [ ] **Step 1: Tests**: `enqueue` of a protobuf body posts to `<endpoint>/v1/traces` with `content-type: application/x-protobuf` and the configured headers, body identical; a JSON body with `application/json`; 65 enqueues with a `fetchFn` that never resolves → `dropped` 1 (the 65th), and bytes over 64 MiB drop too; a failing endpoint logs `warn` once for two failures and `failed` 2; `close()` resolves within 5 s with a stuck request (the stuck one counts `failed`); the receiver with a forwarder forwards an accepted request and not a refused one (`receiver.test.ts`), `stats().forwarded` 1.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(receiver): an OTLP/HTTP forwarder with a bounded queue behind the receiver`

### Task 6.2: `--export-otlp` on `run` and `serve`; README

**Files:**
- Modify: `src/cli/io.ts` (`ReceiverFlags.exportOtlp?: string`; `configInputOf` maps it to `receiver.exportOtlp`), `src/cli/commands/receive.ts` (`addReceiverOptions` gains `--export-otlp <url>`; `openReceiver` builds the forwarder when `config.receiver.exportOtlp` is set, with `parseOtlpHeaders(io.env.OTEL_EXPORTER_OTLP_HEADERS)`; `io.env.OTEL_EXPORTER_OTLP_PROTOCOL === 'grpc'` is `usage` naming the issue; `finishReceiver` prints `forwarded <n>, dropped <n>, failed <n>` when a forwarder ran), `README.md` (`serve` and `run` flag tables; a "Forwarding to a collector" paragraph; Limits: HTTP only, no retry, the queue; Configuration table `receiver.exportOtlp`)
- Test: `test/cli/serve.test.ts` or `run.test.ts` (one test each: `--export-otlp http://127.0.0.1:<port>` against a local server receives the request the test sends to the receiver; `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` exits 2 with the hint)

- [ ] **Step 1 to 4**; file the gRPC fan-out issue (`gh issue create`) and name it in the hint and the PR body. **Step 5: Commit** `feat(cli): --export-otlp on run and serve; OTEL_EXPORTER_OTLP_HEADERS honoured`

### PR 6 close

- [ ] `mise run verify`; PR; body notes D62 and the issue. Branch review on Opus 5.5. Merge.

---

## PR 7: Record, the branch deletion, the kickoff prompts

Branch `docs/publishing-record` from `main`. Title: `docs(plan): publishing plan record, measured latencies, kickoff prompts`.

### Task 7.1: `gh-pages` is gone (the maintainer's step)

- [ ] Ask the maintainer to delete the `gh-pages` branch once a `pages-deploy.yml` pass has deployed from a Pages artifact (PR 3 close), the site is intact and a few days of passes have run (the rollback in Task 3.2 needs the branch). When they confirm (`git ls-remote --heads origin gh-pages` is empty): remove the README's `--single-branch` paragraph (line "Clone with `git clone --single-branch ...`", §1a) and, **stop and ask first** (the process names `release.yml`), the `release.yml` comment naming the publisher's force push; `mise run gen:check`. Commit `docs: the gh-pages branch is gone; clone normally`. If the maintainer has not deleted it yet, leave the paragraph and say so in the summary.

### Task 7.2: The record

- [ ] Append to this plan a "Record: rulings and notes" section in the earlier plans' format: rulings `R<n>` continuing from R130 (from the PR bodies: D51 to D63 as applied, with what changed on the way), spec deviations with line numbers (§5.1 line 153 "kept in the run manifest" → D53; §5.1 the `otel-html ci push` command → the sync is `ci deploy apply`'s, no command of that name; §5.3 step 1 "no name filter" → builder check 1; §5.3 the one state name → D65; §5.6 gRPC → D62 and the issue; §5.7 `no-store` → builder check 2 and D55; §5.9 the `otel-html-deploy` inputs → D58; §7 the job-membership check for hashed job keys → D59; §8 the e2e "provisional CI spans render with one root" → a unit test of `buildTraceTree` (Task 5.2); the rolling report rewriting `data/partitions/000000/...` in place on every rebuild (pre-existing, the CDN hazard §5.1 names) → out of this plan's scope, an issue if the maintainer wants the never-reuse rule there too; Firefox's and WebKit's 404 wording → unverified, Task 5.3), the measured figures (PR 3: the first pass's base kind, duration, tarball size; PR 4: the three upload times per OS, the partition-to-live latency samples; PR 5: the Refresh e2e timing), and open follow-ups (gRPC fan-out, the object store target plan, #246's effect on Refresh over a host).

### Task 7.3: Kickoff prompts

- [ ] In `docs/superpowers/plans/2026-11-06-format-4-writer.md`, "Kickoff prompts": mark rule 8 done ("the publishing plan is merged") and add rule 9: "Plans 1 to 4, the release and the publishing plan merged → the format-4 work is complete; `/format-4` reports that and stops." Commit `docs: kickoff prompts after the publishing plan`.

### Plan close-out

- [ ] `mise run check`; PR; merge. Post the summary the unattended process asks for: each PR's number, title and measurements (PR 3's first pass, PR 4's upload times and latency samples, PR 5's e2e timing); the issues opened (gRPC fan-out; any from the way); anything stopped on (every stop-and-ask and the maintainer's answer; whether `gh-pages` is deleted).

## Record: rulings and notes

Written after PRs 1 to 6 merged (#256, #257, #258, #260, #262, #266, with the fix #265), because the rulings lived
only in a git-ignored ledger. It continues the format-4 host record's numbering (R115 to R130). Where this record and
the spec disagree, this record wins; where it and the plan's decisions disagree, this record wins for what it names.
Decisions D51 to D67 above stand except where a ruling here says otherwise.

### Rulings

Format: `R<n>`: what was decided; why. The source is named in the row when it is not a plain implementation choice.

| R    | Decision                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R131 | The execution order is PR 1, PR 2, PR 5 and PR 6, then the stop at PR 3 (every task there asks first), then PR 4 and PR 7.                                                                                                                                                                       | PR 4 extends the smoke job PR 3 creates. PR 5 and PR 6 touch no shared file, so landing them before PR 3 costs no rework.                                                                                                                |
| R132 | Task 2.1's test-support zip builder (stored and deflated entries, hand-built headers, a zip64 option) is reused by Task 2.2's tests. Task 4.1's `storedZip` may replace its stored path later.                                                                                                    | The plan asks for "Task 2.1's test helper" without naming one.                                                                                                                                                                           |
| R133 | In Task 2.3, `applied.updates[id] === 'applied'` means `applied.updates[id].outcome === 'applied'`.                                                                                                                                                                                              | `AppliedJson` (Task 2.1) stores objects.                                                                                                                                                                                                 |
| R134 | D53 as applied: the run report's bookkeeping (`RunReportState`: the high-water mark, the attempt, per job the name, attempt, sequence and sources) lives in `site-state/runs.json`. `planSync` also reads a job's previous partitions and the high-water mark from the manifest, whichever is higher. | The manifest schema is strict. A base without `runs.json` (a `live`, `gh-pages` or `empty` base, or a malformed state file) then cannot reuse a folder number or duplicate a source. Found by the PR 1 branch review on Opus 5.5.        |
| R135 | The re-run attempt gate is per job name, not run-wide: an update is stale only when a job of the same name has a newer attempt recorded (`RunReportState.jobs[key]` gains `attempt`). The plan's Task 1.2 gates on `state.attempt`.                                                              | Spec §5.4 keeps the data of jobs a re-run did not repeat. A run-wide gate makes the result depend on processing order and drops a late update from a job that was not re-run. The plan's "older attempt is stale" test still holds.      |
| R136 | The deployer compares a push's `u.runId` with the artifact's `workflow_run.id` and accepts `u.runAttempt <= run_attempt`. It copies only files an update references, never by directory listing, groups updates by job key before `planSync`, and keeps the high-water mark for pushes read from disk. | `nameMatches` cannot check a push, whose name has no run id. `planSync` does not check kind, job id or attempt against the job key. Carried from the Task 1.1 and 1.2 reviews.                                                          |
| R137 | D59 as applied: `remove-pr` and `reopen-pr` are authenticated by the uploader's path (the report workflow), event `pull_request_target`, `parsed.runId` equal to the uploader's id, and `GET /pulls/{pr}` with base ref the default branch, head ref equal to the uploader's `head_branch`, and head repository equal to the uploader's. D59's "uploader `head_branch` is the default branch" is dropped. The `run` check stands. | Checked on live runs on 2026-11-10: `pull_request_target` runs report the pull request's head branch, so D59's check would reject every real `remove-pr` and `reopen-pr`. `workflow_run` runs report `main`. Costs one API call per update. |
| R138 | Typed retry: `PendingUpdate` gains `retry: true` instead of a reason prefix. An unreadable download is rejected for good; only network and HTTP failures retry next pass. A plan with only rejected updates still runs `apply`, so the rejections are recorded once.                          | A reason-string prefix is fragile and Task 2.3 builds on it. Without the record a rejected update would be examined on every pass. Review minor 4, promoted.                                                                           |
| R139 | After a `run` update the run folder holds the final compacted report, whose sources (`compact:`, `merge:`) belong to no job. A re-run push at a newer attempt keeps those partitions and adds its own; `complete` goes false. The re-run job's older data shows twice until the new attempt's `run` update replaces the folder. The per-job drop stays on runs still in progress. | The plan's Task 2.3 test (attempt-1 partitions of that job dropped after a `run` update) cannot hold with a real compacted report. The test asserts this behaviour over a realistic one. Spec §5.4's aim, no lost data of jobs not re-run, holds. |
| R140 | The rolling report rewritten in place, with its old files removed at once, is parked. `state.runs` entries are cleared on `remove-pr` and on retention, and a `run` update needs `u.runAttempt <= run.attempt`.                                                                                  | The first is pre-existing and out of scope (see the spec deviations). The second pair came from the PR 2 review: without the clearing, a reopened pull request's resent job update is recorded applied with nothing written, which loses data. |
| R141 | A forged consumed state is refused. A consumed-only site state counts only when the deployer workflow uploaded it: the default branch of this repository, event `workflow_dispatch`, `schedule` or `workflow_run`, and a run newer than the base. `ci deploy plan` gains `--deployer-workflow` (default `pages-deploy.yml`). | The PR 2 branch review's Critical: a fork's run could upload an artifact under the state name and steer which updates count as consumed and which files are deleted.                                                                     |
| R142 | On a cold start (no state artifact, the live site serves `site-state/`), `ci deploy plan` downloads all five live state files (`applied`, `removed`, `files`, `deletions`, `runs`; a 404 is that file's empty form) into `--state-out` and reports that state, so `apply --state` restores them. | Otherwise `apply` starts from an empty state, and pending deletions and the applied record are lost across the switch away from `gh-pages`. Four extra small GETs on a cold start.                                                    |
| R143 | The pusher's ledger `shipped` holds raw manifest sources (`flush:0`, `compact:0..1`), not `job:<key>#...`. `ci update push` writes a sidecar `<publishDir>/<name>.sources.json` that `ci update done --name` reads. Task 4.2 uses the same form.                                                  | D60 compares the manifest's own source list with `shipped`, and `done` receives only a name. One extra small file per update.                                                                                                            |
| R144 | Tasks 6.1 and 6.2 went to one implementer with a commit each and one task review over both. `ReceiverStats` gaining `forwarded`, `forwardDropped` and `forwardFailed` is an additive public-type change, acceptable in a `feat` PR.                                                              | 6.2 only wires 6.1's forwarder into the CLI and README. A consumer constructing `ReceiverStats` literals must add the fields.                                                                                                            |
| R145 | D62 as applied: forwarding is OTLP/HTTP only, 10 s per request with no retry, a queue of 64 requests or 64 MiB, one warning per process on the first failure and on the first oversized body, and `close()` waiting up to 5 s on every finish and start-failure path. The forwarder is closed in a caught `finally`, in start-failure cleanup too. A config-level `exportOtlp` that is not http(s), or has a query, fragment or userinfo, is a config schema error (exit 1), not a usage error. | The forwarder was left open when a finish step threw (a process that did not exit); the Opus 5.5 re-review found it. Config errors are reported as schema errors for every other bad value.                                              |
| R146 | `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` (or any value other than unset, `http/protobuf`, `http/json`) with forwarding configured is a usage error naming #259. For `run`, the same variable selects the child's exporter, so a gRPC-only child needs `--grpc <port>` and the per-signal protocol and endpoint variables; the README says so. D62 is kept as approved. | The Opus 5.5 branch review flagged the consequence for the maintainer; the kickoff binds D51 to D63 without re-deciding. Flagged in the final summary.                                                                                  |
| R147 | PR 6 minors 1, 2, 4, 5, 6, 7, 9 and 10 were fixed (user-visible). Parked: the per-request body copy (defensive against buffer reuse; needs a measurement), header-value validation (`fetch` validates at send) and the test gaps beyond what the fixes need. Credential headers sent over plain `http:` to a non-loopback collector print a warning on stderr (975eaaa0). | The parked items cost a small copy per forwarded request at most. CodeRabbit flagged the credentials risk.                                                                                                                              |
| R148 | The viewer's Refresh of an unchanged manifest (`updatedAt` equal) skips the catalog swap. A reader's click still clears Mosaic's result cache and re-runs the current queries (spec §5.7). A poll tick with an unchanged manifest does nothing. | The click is a request to see current data; a poll "polls only the manifest". Reverses the first PR 5 ruling in part. Clearing the cache clears only Mosaic's result cache, because `coordinator.clear()` also aborted queued and in-flight queries with "Cleared". |
| R149 | `refreshReport` takes no registry: `RefreshDeps.registry` is dropped. The script loader's `load()` already resolves with the registered payload, so a second `registry.take` would hang.                                                                                                       | The plan's interface named the registry by assumption.                                                                                                                                                                                   |
| R150 | Spec §5.5's display rule (one copy per span id, the final one preferred) applies to the whole trace detail: `getTrace` dedupes rows by span id before it builds `spans`, the counts and the tree. The plan's Task 5.2 names only `buildTraceTree`.                                                | A span count or table showing both copies contradicts "provisional CI spans render with one root". The raw provisional rows are not visible, which is acceptable: they are superseded data.                                              |
| R151 | The gone-partition e2e deletes a partition the page has not read yet (partition 1 after a load without a refresh), not partition 0 after load as the plan wrote. A failed-refresh assertion (M3) checks the re-run query's gone-file failure, not a refresh failure.                              | DuckDB-WASM reads a registered partition whole on first touch and keeps it, so a file already read never answers 404 (the better outcome), and deleting one before load fails the page load. In Chromium `CREATE VIEW` does not open files, so the refresh itself succeeds. |
| R152 | Parked in PR 5: a gone file that reappears is not registered again by a second Refresh (refresh diffs by path); a pre-swap query writing its result to the cache after `clearCache`; a timed-out load's late script resolving the next same-key wait. M1 to M4 are folded into the PR 5 fix wave; M5 (cosmetic) is parked. | The real sequence (compaction drops X, X is deleted 15 minutes later, Refresh loads the manifest without X) never needs X again. The races need a query over 30 s, or a 30 s script timeout, to coincide with a refresh; the next refresh corrects them. |
| R153 | The deployer counts a Pages deployment as a base only when it is not the current run and its run uploaded `github-pages` or its state artifact. The wait age is measured from that deployment's `liveAt`. The fix is in the CLI (`ci deploy plan` and `prune`), and `pages-deploy.yml` keeps its approved shape. | The PR 3 branch review's Critical (Opus 5.5, "do not merge"): GitHub records a successful `github-pages` deployment for every job in the environment before the job starts, whether or not `deploy-pages` runs (confirmed on deployment 7673945861). The deployer took such a run as its base and waited from then on. |
| R154 | The `otel-html-publish` output `published` stays false for cleanup and reopen. It means a report was published, not that an update was uploaded. The release.yml lease comment (minor 6) is skipped until Task 7.1.                                                                              | A caller gating on `published` skips a step after a cleanup (a one-line change if wrong). `release.yml` is edited only at Task 7.1, a maintainer stop.                                                                                    |
| R155 | The smoke `publish` job keeps its `ci dispatch` although the deployer refuses `actions-smoke` updates ("not a ci workflow").                                                                                                                                                                    | D67 asks for the collect publish path end to end. The cost is one wasted deployer pass per smoke run.                                                                                                                                    |
| R156 | Maintainer (2026-11-10), after #264: `ci dispatch` uses a GitHub App token, not `GITHUB_TOKEN`. The settings are `vars.DEPLOYER_APP_ID` and `secrets.DEPLOYER_APP_PRIVATE_KEY`. The mint step runs only when `github.event.sender.type == 'User'` and the run is not a fork, and the token is scoped to the current repository (`owner` and `repositories` dropped, `permission-actions: write`). A failed mint falls back to the job token. | Renovate branch code never holds the key, and the empty-name risk of an explicit repository list is removed. Applied in #265. `ci dispatch` also prints a warning when the run it started ended in `startup_failure`, within one 20 s deadline. |
| R157 | `actions/create-github-app-token` v3.3.0 keeps `app-id` despite its deprecation.                                                                                                                                                                                                                | The maintainer stored the App ID as `DEPLOYER_APP_ID`; client-id needs a new variable. Cost: a deprecation annotation per mint until a later switch.                                                                                    |
| R158 | #264's cause: the repository's Actions policy 9660 (`restrict_actions_actors`, Admin only). The maintainer installed the App and added the App (5703430) and its bot (355089021) to the policy; the App alone was not enough. The App is also on the main ruleset's bypass list, which is not needed. | The first mint failed with 404 ("get a repository installation for the authenticated app"): the App was not installed on the repository. Dispatched run 42921182161 then deployed. #264 is closed.                                      |
| R159 | `actions/github-script` is pinned at v9.0.0 (3a2844b7, tag verified to the commit), not the plan's v8.                                                                                                                                                                                           | v9.0.0 is the latest release (node24). Cost if wrong: one line to re-pin.                                                                                                                                                                |
| R160 | The plan's builder check 3 (the Twirp protocol) was wrong twice: the `StringValue` fields `mimeType` and `hash` must be plain strings in proto3 JSON (95c9bb88), and replies may use proto field names (`signed_upload_url`, `artifact_id`) (eba7400e). The second fix had the maintainer's approval after the plan's one-fix limit. | Found by smoke runs on the runners (42923685354 showed CreateArtifact accepted but no `signedUploadUrl`). Proven on Linux x64, Linux arm64 and Windows.                                                                                  |
| R161 | The maintainer approved the arm64 smoke leg, so the `publish` job runs on Linux x64, Linux arm64 and Windows.                                                                                                                                                                                   | The maintainer's request while approving Task 4.1's smoke step.                                                                                                                                                                          |
| R162 | The §8 smoke assertion compares the site's sources with the job's final report sources, instead of requiring that no `flush:` source remains (39ae2334).                                                                                                                                         | A step that flushed once keeps its single flush partition (smoke 42935253513). The check is weaker, but it still catches flush partitions that were not replaced.                                                                       |
| R163 | Maintainer (2026-11-10), the PR 4 branch review's I1: single-flight dispatch. The pusher skips its dispatch while a `pages-deploy` run is queued, pending, waiting or requested, and looks up CI spans at most every 5 minutes (37643479). The pusher stops with SIGKILL after 90 s (SIGTERM is caught by the CLI), its tick folders live under `$RUNNER_TEMP`, and `ci update stop` runs in every collect step with `continue-on-error`. | About ten deployer passes a minute put the repository's `GITHUB_TOKEN` API limit at risk. I2 and I3 (205369ee): the SIGTERM stop did not work, and a pusher was never stopped when `publish` was false. The re-review reverted four fixes one at a time and each revert failed its new test. |
| R164 | Shared timers are unref'd. The detached pusher and `ci update push --final` (while it waits for the pusher to stop) hold referenced timers (3f4aff6b, 8a9cc799). The launcher writes the pusher's PID file (b7d6e98b).                                                                           | Without referenced timers Node exited mid-wait. With the launcher writing the PID file, a collect that runs before the pusher is up still stops it.                                                                                      |
| R165 | The CI-spans refresh alternates between two folders (`ci-a`, `ci-b`) and has no unit test of the alternation. The Windows zip test runs Python with `-X utf8`.                                                                                                                                   | A failed report creation after the wipe cannot be simulated without new seams; the alternation keeps the cached report whole if a refresh fails. The Windows zip test failed on the stdout code page.                                    |
| R166 | Task 4.4's pusher dispatches with the App token: `otel-html-setup` mints it (only on runs a person started) and passes it as `OTEL_HTML_DISPATCH_TOKEN`. An App token lasts one hour, so a longer job's later dispatches fail and the failure is logged. The job-end dispatch and the deployer's schedule still run. | The controller found the gap while reading the Task 4.4 draft: the pusher's dispatch would use `GITHUB_TOKEN`, which the policy refuses (#264).                                                                                        |
| R167 | The Refresh e2e measured the Chromium 404 wording of DuckDB-WASM: the first read says "Invalid Error: Opening file '<path>' failed with error: Failed to open file: <path>", later reads say "IO Error: No files found that match the pattern \"<path>\"". `isGoneFile` matches both and an explicit HTTP 404. | Neither message contains "404". The wording in Firefox and WebKit is not measured.                                                                                                                                                      |

### Spec deviations

Spec file: `docs/superpowers/specs/2026-11-06-incremental-ci-publishing-design.md`. Each was checked against its text.

- Lines 152-153 (§5.1, "a per-run high-water mark kept in the run manifest"): kept in `site-state/runs.json`, and read from the manifest too (D53, R134). The manifest schema is strict, and a new field would be a format change.
- Lines 140-144 (§5.1, `otel-html ci push --updates ... --site ...`): there is no command of that name. The sync is `ci deploy apply`'s (PR 2), a pure function of the base folder and `pending.json`; `planSync` in `src/cli/ci/run-report.ts` is its core.
- Line 240 (§5.3 step 1, "has no name filter"): builder check 1 found that the artifacts endpoints take an exact-match `name` query; only a prefix filter is missing. The deployer finds a state artifact by exact name, lists updates by prefix with the creation-time floor in `applied.json`, and a cold start reads the five live state files (R142).
- Lines 222, 238 and 270-272 (§5.3, one state artifact name `otel-html-site-state`): two forms (D65). A pass that deploys uploads `otel-html-site-state-<run id>`; a consumed-only pass uploads `otel-html-site-state-base-<deployment id>`. A consumed-only state counts only from the deployer workflow (R141).
- Lines 368-371 (§5.6, "OTLP/HTTP or gRPC client"): HTTP only (D62, R145, R146). A gRPC-only `OTEL_EXPORTER_OTLP_PROTOCOL` is a usage error naming #259, which tracks the gRPC fan-out. Line 548 (§12) leaves "whether gRPC fan-out ships with HTTP or after" to the builder; it ships after.
- Lines 378-383 (§5.7, "fetches it with `cache: 'no-store'`"): Refresh loads `data/manifest.js?r=<ms>` through the script loader, because the manifest is a script, not JSON (builder check 2, D55). The line shows the manifest's age so a CDN that answers old content is visible. Line 546 (§12) asks whether a `no-store` fetch gets past the CDN; the cache-busting query makes that moot, and the CDN's behaviour was not measured.
- Lines 396-410 (§5.9, `otel-html-publish` inputs): D58. `otel-html-publish` keeps `run-id`, `version`, `command`, `config`, `target`, `comment`, `check`, `cleanup-pr`, `token`, gains `reopen-pr` and `deployer-workflow`, and drops `deploy`, `preview`, `retention` and `pr-retention`. `otel-html-deploy` takes `version`, `command`, `token`, `config`, `retention` and `pr-retention`. After #265 both `otel-html-collect` and `otel-html-publish` also take `dispatch-app-id` and `dispatch-app-private-key`, and `otel-html-setup` takes `push-every`, `config`, `deployer-workflow` and the two dispatch inputs.
- Lines 440-443 (§7, a pull request's job id and attempt must be a job and attempt of the run, with hashed job keys): D59 checks job membership for numeric keys; a hashed key (`h` plus 12 hex characters of `sha256("<attempt>:<id>")`, D61) cannot be matched to an API job id, so the update is accepted unchecked (D59), and a forged value can only misplace the uploader's own run's data. Lines 446-456 (§7, `remove-pr` and `reopen-pr` "accepted only from a run of ... `pull_request_target`"): also checked against `GET /pulls/{pr}` (R137).
- Line 478 (§8, e2e "a fixture report with provisional CI spans renders the trace with one root"): a unit test of `buildTraceTree` and `getTrace` (Task 5.2, R150). The e2e covers the in-progress line, Refresh and the gone-partition notice.
- Line 153 and lines 331 (§5.1 and §5.4, the rolling report rebuilt by copy): the rolling report still rewrites `data/partitions/000000/...` in place on every rebuild (pre-existing, the CDN hazard §5.1 names). It is out of this plan's scope. File an issue if the maintainer wants the never-reuse rule there too.
- Lines 378-385 (§5.7, the 404 wording): the Chromium wording is measured (R167). Firefox's and WebKit's wording is unverified: CI's three-browser matrix runs the e2e spec, and `isGoneFile` matches only the Chromium messages and an explicit 404.
- Lines 440-456 (§7, dispatch): the deployer is woken by `workflow_dispatch` with a GitHub App token (R156). The spec assumed `GITHUB_TOKEN`, which the repository's Actions policy refuses (#264, closed by #265). The pusher's dispatch is single-flight (R163), and an App token's one-hour life means a longer job's later dispatches fail and are logged (R166).
- Builder check 3 (§12 and the plan, the Twirp protocol): corrected twice (R160).
- Line 478 and §8 (the smoke test): the assertion compares sources instead of requiring no `flush:` source (R162).

### Measured figures

| what                                                                                       | figure                                                                                                                                 | where                |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| PR 3, the first deployer pass after the merge (run 42818144301, started by `ci-report`)     | base kind `artifact`; `plan` 36 s, `deploy` 1 min 59 s, about 2 min 40 s from the run's start to the end of the deploy                 | PR #262              |
| PR 3, the site artifact of that pass                                                       | `github-pages` 277.8 MB compressed; tarball 778 MB, 5275 entries; the separate state artifact 25.7 kB                                   | PR #262              |
| PR 3, updates in that pass                                                                 | 68 consumed, 64 rejected (54 "no channel", 10 "not a ci workflow")                                                                      | PR #262              |
| PR 3, the first dispatched pass (run 42921182161, after the App token)                     | base `artifact`; `plan` 30 s, `deploy` 7 min 32 s; 2 updates consumed                                                                   | ledger               |
| PR 4, `ci upload` of `.otel-html/` (about 14.7 MB), smoke run 42931179332                   | Linux x64 2095 ms; Linux arm64 1511 ms; Windows 1394 ms                                                                                | PR #266              |
| PR 4, pusher ticks, smoke run 42936112421 (update 1, update 2)                              | Linux x64 701 ms (72 kB) and 772 ms (100 kB); Linux arm64 871 ms and 811 ms; Windows 1037 ms and 1049 ms (113 kB). Other sizes not recorded | PR #266              |
| PR 4, update artifacts in `ci` run 42957289406 (`push-every: 60s`)                          | 23 in all, at most 6 for one job (e2e chromium, 8 min: 6; unit-os windows, 7 min: 5; e2e webkit, 7 min: 5; check, 6 min: 4; e2e firefox, 5 min: 3); the limit is 500 per job | PR #266              |
| PR 5, Refresh e2e (Chromium), click to the new row count                                   | 117 to 140 ms; the whole Chromium suite passed (119 e2e and 10 perf-http tests)                                                          | ledger, Task 5.3     |

- Partition to live manifest (spec §6: about 1 to 3 minutes), `main` run 42958410187 after #266 merged (2026-11-11): the time from a `push` update artifact's `created_at` to the first 15 s poll of `branch/main/runs/42958410187/data/manifest.js?x=<random>` whose `updatedAt` is later. Three samples, one per deployer pass: 49 s (`…914571-1`, created 04:19:26), 103 s (`…914419-1`, 04:20:19), 149 s (`…914419-2`, 04:21:20). Over all 36 updates of the run: 41 s to 149 s for the 34 seen while the poll ran every 15 to 30 s, median about 100 s. The last two (`…947976-7` and `-8`, 221 s and 203 s) are upper bounds: the poll had a two-minute gap (04:28:41 to 04:30:44) as the pass that applied them deployed, so they lie between 98 s and 221 s. The method counts an update as live at the first manifest applied after it was created, which is an approximation: an update created between a pass's `plan` and its `apply` is credited to that pass but shipped by the next.
- Deployer passes in that run: the pusher's single-flight check (R163) did not keep the dispatches to one per pass. Nine jobs check within seconds of each other, so about one `pages-deploy` run started every 30 s, and the `pages` concurrency group cancelled the extra ones (5 of the first 8 runs). The cost is run starts, not wrong results: #268.

### Open follow-ups

- gRPC fan-out for `--export-otlp`: #259, open. Until it ships, `run --export-otlp` with a gRPC-only child needs the workaround in R146.
- The object store target: spec §9 milestone 4. It has no plan yet. Write it when the maintainer wants it; the target interface's operations are left to the builder (§12).
- #246 (open): serving a report that is still being written. The host's views would have to follow the manifest at every flush. Its effect on Refresh over a host is not yet known: Refresh re-reads `data/manifest.js?r=<ms>` by script, and no test covers that over `otel-html host`.
- #261 (open): `test(host)`, the engine-limits test "a hung first worker is replaced by a fresh real one" flakes on Windows CI. It failed twice on a commit that did not touch the host.
- #263 (open): `ci deploy plan` should bound the API calls when no deployment counts, and take the artifact retention (now a hard-coded 90 days) as input.
- #267 (open): the pusher PR's Minors from the Opus 5.5 re-review. Two were fixed in #266 before it merged (a late pusher is stopped, R164; the CI-spans report is never rewritten in place, R165); skipping `ci update stop` in a job without a pusher, and three nits, remain.
- #264 (closed): `ci dispatch` ended in `startup_failure`; fixed by the App token and the repository's Actions policy (R156, R158).
- The `gh-pages` branch still exists on `origin`. Task 7.1 waits on the maintainer, who was told to wait a few days of passes before deleting it. Rollback of PR 3 needs the branch.
- #268 (open): the pushers' dispatches still start a deployer run about every 30 s.
- Parked review items: PR 6 minors (R147), PR 5 races (R152), the container-jobs smoke coverage (a README note), and the rolling report rewrite in place.
