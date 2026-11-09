# Incremental CI Publishing Implementation Plan (the publishing plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CI run's report on the GitHub Pages site grows while the run is going: each job uploads its format-4 partitions as *site updates* (at its end, and every minute from a detached pusher), one *deployer* workflow applies the pending updates to the last deployed site and deploys the result from a Pages artifact, the `gh-pages` branch goes away, the viewer shows an in-progress report's age and re-reads its manifest on Refresh, and the receiver can forward every accepted OTLP request to a collector.

**Architecture:** Three new pieces in `src/cli/ci/`, all behind `otel-html ci` subcommands. (1) *Updates*: `update.ts` is the update artifact's contract (`update.json`, names, the partition listing); `update-main.ts` writes `push`, `run`, `remove-pr` and `reopen-pr` update folders that `actions/upload-artifact` uploads; `run-report.ts` is the pure sync of one job's updates into a run report's manifest (immutable partitions, never-reused folder numbers, deferred deletion). (2) *The deployer*: `deploy-plan.ts` asks the Actions API what is pending and which deployment is the base and writes `pending.json`; `deploy-apply.ts` is a pure function of (base directory, pending updates) that applies them in the spec's order, keeps `site-state/`, and reuses today's placement, retention, rolling-report and badge code (refactored out of `site-main.ts`); `deploy-prune.ts` deletes old artifacts. The workflow steps around them (`pages-deploy.yml`, the new `otel-html-deploy` action) download and unpack artifacts, so the CLI never reads a zip. (3) *The pusher*: `artifact-client.ts` is a 150-line upload client for the Actions artifact service (Twirp JSON, a block-blob PUT, a stored zip), `pusher.ts` the detached loop. The viewer gains `refreshReport` beside `openReport`, and the receiver an OTLP/HTTP forwarder.

**Tech Stack:** TypeScript (strict), zod 4, commander, `node:*` only; vitest; Playwright; GitHub Actions (`actions/download-artifact` v8, `actions/upload-artifact` v7, `actions/upload-pages-artifact` v5, `actions/deploy-pages` v5, `actions/github-script` v8, all pinned by SHA). **No new dependency** (D51).

**Spec:** `docs/superpowers/specs/2026-11-06-incremental-ci-publishing-design.md`, with §10 (the maintainer's decisions) and §11 (the designer's calls) binding, and §12 ("Left to the builder") answered by the builder check below. It builds on the format-4 spec and plans: `docs/superpowers/plans/2026-11-06-format-4-writer.md` (R50, R51, R57), `2026-11-07-format-4-viewer.md` (R88: the shared assets base per channel depth, R92: `ci report` writes `local`), `2026-11-09-format-4-host.md` (R127: the epoch window). The dogfood design `2026-10-30-ci-dogfood-design.md` §6.1 is the publisher-never-runs-PR-code rule this plan keeps.

**Process:** unattended (`docs/agents/process-unattended.md`); PRs target `main`, the next PR branches from the updated `main`. Implementers and task reviewers on Sonnet 5.5, the branch review on Opus 5.5; each review's summary names its model. **Stop-and-ask tasks**, as the process requires for anything that runs with a write token: every task of PR 3 (`ci-report.yml`, the new `pages-deploy.yml`, `otel-html-publish`, the new `otel-html-deploy`, `ci.yml`, `load.yml`), Tasks 4.1, 4.4 and 4.5 of PR 4 (`actions-smoke.yml`, `otel-html-setup`, `ci.yml`), and the maintainer's own step of deleting `gh-pages` (Task 7.1). The coordinator stops before each of those tasks, shows the diff it intends, and waits.

## Builder check (2026-11-09, against the live site and API)

The spec's §12 items, checked before this plan was written. Each finding is applied in the decisions below.

1. **A deployment's run and artifact.** `GET /repos/{o}/{r}/deployments?environment=github-pages&per_page=30` lists deployments newest first with an empty `payload`; `GET /repos/{o}/{r}/deployments/{id}/statuses` lists its states (`waiting`, `queued`, `in_progress`, `success`), and every status's `log_url` is `https://github.com/{o}/{r}/actions/runs/<run id>/job/<job id>`. Verified: deployment 7667742413 → status `success` at 2026-11-09T22:25:30Z → run 42711121901 → `GET /repos/{o}/{r}/actions/runs/42711121901/artifacts?name=github-pages` → one artifact (13715193873, 1-day expiry). The artifacts endpoints take an exact-match `name` query (the spec's "no name filter" holds only for prefixes), and the repository listing (`/actions/artifacts`, 100 per page, newest first) had 3,283 artifacts, so the creation-time floor of §5.3 is needed.
2. **The Pages CDN ignores request cache directives.** `index.json` fetched with `Cache-Control: no-store` or `no-cache` answered `x-cache: HIT`, the same `etag`, `cache-control: max-age=600`. A Refresh cannot force a fresh manifest; it can only say how old the one it read is (D55).
3. **The artifact service protocol** (`actions/toolkit`, `packages/artifact`, main on 2026-11-09): `ACTIONS_RUNTIME_TOKEN` is a JWT whose `scp` claim holds `Actions.Results:<workflow run backend id>:<workflow job run backend id>`; `ACTIONS_RESULTS_URL` is the service origin. `POST <origin>/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact` with JSON `{ workflowRunBackendId, workflowJobRunBackendId, name, version, mimeType: { value: 'application/zip' }, expiresAt? }` (`version` is the client version the toolkit sends, 7 on main today; `expiresAt` an RFC 3339 string) answers `{ ok, signedUploadUrl }`; the zip is uploaded to that URL as an Azure block blob (the toolkit streams 8 MiB blocks with `blobHTTPHeaders.blobContentType`); `FinalizeArtifact` with `{ workflowRunBackendId, workflowJobRunBackendId, name, size: '<bytes>', hash: { value: 'sha256:<hex>' } }` answers `{ ok, artifactId }`. Retryable statuses 429, 500, 502, 503, 504. Both variables reach JavaScript actions only (the spec's constraint stands).
4. `zlib.crc32` exists in Node 24.22.1 and Bun 1.4.4 (the stored-zip writer needs it; checked here).
5. `actions/download-artifact` v8 downloads by `artifact-ids` (comma-separated, across runs of the repository) and by `name` + `run-id` + `github-token` from another run; `path` is the destination and each artifact lands in its own folder.
6. `cicd` resource attributes, deterministic ids (`src/cli/ci/ids.ts`), the channel mapping (`channelFor`, `pullsOfRun`) and the shared assets base (`runAssetsBase`, R88) exist and are reused unchanged.

## Decisions this plan makes

Numbering continues the format-4 plans (D35 to D50). The maintainer can object at review; the spec's §10 decisions are not re-decided.

- **D51 No new dependency.** The upload client is written here: the Twirp calls of builder check 3 over `fetch`, one `PUT` of the whole zip to the signed URL with `x-ms-blob-type: BlockBlob` and `x-ms-blob-content-type: application/zip` (an update is a few MB; a zip above 256 MiB is refused with a clear error rather than block-uploaded), and a stored (uncompressed, method 0) zip writer with `zlib.crc32`: partitions are ZSTD Parquet already. `@actions/artifact` (14 transitive dependencies, among them the Azure SDK) is not added. Downloads are the workflow's: `actions/download-artifact` by `artifact-ids` for the updates and by `name` + `run-id` for the base and the state artifact, `tar -xf` for the Pages tarball, so no zip or tar reader exists in the CLI. The upload path is proven on a Linux and a Windows runner before the pusher is built on it (Task 4.1, the spec's rule).
- **D52 The deploy pass is split into an API half and a pure half.** `ci deploy plan` talks to the API (deployments, artifacts, runs, pull requests) and writes `pending.json`: every candidate update with its artifact id, name, the facts of the run that uploaded it, its channel, and `accepted` or a rejection reason (§7). `ci deploy apply` reads a base directory, a `site-state/` directory, the unpacked updates and `pending.json`, and never calls the API, so it is a pure function of (base, pending) tested over fixture directories. `ci deploy prune` is the API step with `continue-on-error`.
- **D53 Run-report bookkeeping lives in `site-state/runs.json`, not in the run manifest.** The manifest schema is strict (a new field is a format change). Per run report path: the next partition number (the high-water mark, never reused), the attempt the report shows, and per job the display name, the newest applied sequence and the sources it lists. Spec §5.1 ("kept in the run manifest") is deviated from and recorded.
- **D54 A `run` update is placed with renumbered partitions.** The final report's partitions are rewritten to start at the run's high-water mark (paths and `n` only; statistics unchanged) before `placeRunReport` upgrades the copy to `site`, so the provisional partitions keep their paths until their deferred deletion falls due and no path ever names two files (§5.1). `placeRunReport` no longer `rm`s the run folder; the deployer moves the old manifest's files into `deletions.json`.
- **D55 Refresh re-reads `data/manifest.js` through the script loader with a cache-busting query** (`?r=<ms>`), takes the payload from the registry, and the in-progress line shows the manifest's `updatedAt` as "updated <n> min ago" (builder check 2: the CDN may still serve the old one; the age says so). Refresh replaces the registered file set against the new manifest (new files registered, dropped files `dropFile`d), re-runs the view statements, clears the Mosaic cache (`QueryEngine.clearCache()`, new on the seam) and builds a new `DataSource` over the same engine; the app swaps it and every page re-queries. A served report (`otel-html host`) shows the line without Refresh (#246: the host serves one manifest). Polling is a checkbox on the line, every 60 s, remembered in `sessionStorage` (per tab), off by default.
- **D56 A 404 on a listed partition reads "this report has changed; Refresh".** DuckDB-WASM's message for a registered URL that answers 404 is measured in a unit test (Task 5.1) and matched by `isGoneFile(error)`; the pages' error alerts offer Refresh when it matches.
- **D57 `ci site` and `ci cleanup` are removed; `ci link` reads the live index.** Their only caller was the publish action; their logic moves into the deployer (`site-main.ts` keeps `placeFinishedRun`, `removePullRequest`). `ci link --index-url <base>/index.json` replaces `--site`: the previous run and the channel page come from the live `index.json` (up to ten minutes stale, which at worst links the run before the previous one). The README's "stable flags" table changes accordingly.
- **D58 Inputs move to where the work is.** `otel-html-publish` keeps `run-id`, `version`, `command`, `config`, `target`, `comment`, `check`, `cleanup-pr`, `token`; gains `reopen-pr` and `deployer-workflow` (default `pages-deploy.yml`); drops `deploy`, `preview`, `retention` and `pr-retention`. The new `otel-html-deploy` takes `version`, `command`, `token`, `config`, `retention` (30), `pr-retention` (10), `preview` (false), `ci-workflows` (default `ci.yml`, comma-separated workflow file names), `report-workflow` (`ci-report.yml`), `keep-deployments` (3), `update-retention-days` (90). `otel-html-collect` gains `publish` (false) and `deployer-workflow`; `otel-html-setup` gains `push-every` (empty) and `config`.
- **D59 Updates are authenticated by workflow file path and event.** `GET /actions/runs/{id}` gives `path` (`.github/workflows/ci.yml`), `event`, `head_branch`, `head_repository`, `pull_requests`, `run_attempt`, `actor.type`. A `push` is accepted from a run whose `path` is one of `ci-workflows` with event `push`, `pull_request`, `schedule` or `workflow_dispatch`; a `run` from a `report-workflow` run with event `workflow_run` or `workflow_dispatch`; `remove-pr` and `reopen-pr` from a `report-workflow` run with event `pull_request_target`. The channel of a `push` is `channelFor(run, pulls, defaultBranch)` with the pull requests of `run.head_sha` (as `ci site` maps it today); a run with no channel is rejected ("no channel"). Nothing in `update.json` chooses a channel or a run.
- **D60 The pusher's protocol with the collect step.** The pusher writes `.otel-html/publish/pusher.pid`, logs to `.otel-html/publish/pusher.log`, keeps the ledger `.otel-html/publish/uploads.json` (`{ sequence, shipped: string[], uploads: [{ name, sequence, sources, finishedAt }] }`; written atomically, read by both). `ci update push --final` writes `.otel-html/publish/pusher.stop`, waits up to 90 s for the pid file to vanish (the pusher checks the stop file every second and after each upload, exits 0 and removes its pid file), then kills the pid if it is still alive, then builds the final update with sequence `ledger.sequence + 1`. The pusher detaches itself: invoked without `--detached` it spawns its own executable with `--detached`, `detached: true`, `stdio: ['ignore', log, log]`, `unref()`, and exits 0 at once; `io.spawn` and `process.execPath`/`process.argv` give the command. The wait strategy (§12) is a manifest poll: every tick reads `data/manifest.js` and compares the sorted `source` list with the ledger's `shipped` plus the last listing; `complete` is ignored.
- **D61 The CI-spans partition is a real report.** The uploader writes `jobTraceRequest(...)` through `createReportWith` into a scratch folder with the CI config (`--config`, default the action's `otel-html-ci.yaml`) and `format: 'site'`, closes it, and carries its one partition (`spans.parquet`, `traces.parquet`) in the update as `ci` with source `ci:<job key>`. `jobSourceKey(jobId)` is the numeric API id as text, or `h` plus the first 12 hex of the sha256 of an approximate id (`name:<hint>@<runner>` holds `@`, which `SOURCE_RE` refuses). A job's own partitions list as `job:<job key>#<source>` (`job:12345#compact:3..7`).
- **D62 Fan-out is OTLP/HTTP, as received.** `--export-otlp <base url>` (config `receiver.exportOtlp`, default none) on `run` and `serve`: after a request is accepted (answered 200 or partial success) its decoded body is POSTed to `<base>/v1/<traces|logs|metrics>` with the content type it arrived with (`application/x-protobuf` or `application/json`; a gRPC-received request is forwarded as protobuf over HTTP, the same message bytes) and the headers of `OTEL_EXPORTER_OTLP_HEADERS` (parsed by the CLI; `key=value,key2=value2`, URL-decoded). `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` is a usage error naming the follow-up issue (gRPC fan-out, §12); `http/protobuf` and `http/json` both mean this path. Bounded queue: 64 requests or 64 MiB, whichever first; a full queue drops and counts (`stats().forwardDropped`); one `warn` per process on the first failure; 10 s per request, no retry; `close()` waits up to 5 s for the queue. The endpoint never comes from a request.
- **D63 Test-only flags for the smoke.** `ci deploy apply --trust-updates --channel <key>` accepts every update folder under `--updates` without `pending.json`, into the named channel, for `actions-smoke.yml`'s deployer leg against a scratch base; the README marks both as test flags.

## Plans for this spec

This plan covers milestones 1 to 3 (§9). Milestone 4, the object store target, "stays planned" (§5.8): a later plan, written when the maintainer picks a store. The `gh-pages` branch is deleted by the maintainer after PR 3's first deploy (Task 7.1).

## Global Constraints

- No new runtime or dev dependency (`test/scaffold.test.ts`'s list is unchanged). `src/cli/ci/` imports `node:*`, `zod`, `commander` (through `commands/ci.ts`) and the project's own modules only.
- The site index (`index.json`, `SiteIndex` version 1), the channel keys (`branch/<slug>`, `pr/<n>`), the run folder (`<channel>/runs/<run id>/`), retention (30 and 10 per workflow), the rolling report, the badges and the landing page keep their shapes (§3).
- The manifest schema (`ManifestV4Schema`) does not change; the format version stays 4; `SOURCE_RE` already admits `job:` and `ci:` sources.
- `update.json` is validated with a strict zod schema; every path in an update is a layout path (`partitions/<i>/<table>.parquet`, `ci/<table>.parquet`, or the `run` report's own `data/...` and `index.html`), no `..`, no absolute path, no symlink (`entryKind` is `file`); a `push` writes only under its run's folder (§7).
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

Pure library code and its tests; no workflow, action or CLI change. knip reaches the new modules only from tests until PR 2: list `src/cli/ci/update.ts` and `src/cli/ci/run-report.ts` in a knip ignore entry with a comment naming PR 2, removed there.

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
  export function parseUpdateName(name: string): { kind: UpdateKind } | undefined; // the kind by prefix; everything else comes from update.json
  export function jobSourceKey(jobId: JobId): string; // D61
  /** Reads and validates `<dir>/update.json`; every listed path must be a layout path inside `dir` and a plain file (no `..`, no absolute, `entryKind` 'file'); carried partitions' files must exist and match `bytes`. Failures are `invalid-report` naming the path. */
  export async function readUpdate(fs: FileSystem, dir: string): Promise<UpdateJson>;
  ```

- [ ] **Step 1: Write the failing tests**: `updateName` for each kind equals the spec's names (`push` with `jobId: 7, sequence: 3` → `otel-html-update-push-7-3`; `jobId: 'name:build@r1'` → `otel-html-update-push-h<12 hex>-3` and `jobSourceKey` of that id is stable across calls); `parseUpdateName('otel-html-update-remove-pr-5-42')` → `remove-pr`, `parseUpdateName('ci-run-report')` → undefined; `UpdateJsonSchema` rejects an unknown key, a `push` without `sequence`, a `remove-pr` without `pr`, `runId: '42'`; `readUpdate` over a memory fs (`test-support/memory-fs.ts`) accepts a valid `push` folder, rejects a file path `../x.parquet`, a path `data/partitions/000000/spans.parquet` (not update-relative), a carried partition whose file is missing, and one whose `bytes` differs from the file.
- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/update.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** `update.ts`.
- [ ] **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): the site update contract: update.json, artifact names, validated paths`

### Task 1.2: The run report and the sync

**Files:**
- Create: `src/cli/ci/run-report.ts`
- Test: `test/cli/ci/run-report.test.ts`

**Interfaces:**
- Consumes: `ManifestV4`, `PartitionEntry` (`src/format/manifest.ts`), `partitionFilePath`, `partitionDir`, `MANIFEST_PATH`, `MANIFEST_KEY` (`src/format/paths.ts`), `wrapDataFile`, `unwrapDataFile`, `reviveDataJson` (`src/format/data-file.ts`), `statisticsKeysFor` (`src/format/parquet/stats.ts`), `ENGINE_VERSION` (`src/format/engine.ts`), `renderIndexHtml` (`src/writer/html.ts`), `WriterDeps`, `ResolvedConfig`, `UpdateJson`, `UpdatePartition` (Task 1.1). The manifest's `config` field is built the way `partition-session.ts`'s commit builds it (`grep -n "config:" src/writer/partition-session.ts` around the `updatedAt: iso(...)` commit): `viewer` (with the facet caps), `dashboards`, `views` of the resolved config.
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
   * `state.next` upward; the job's partitions whose `source` is no longer listed, and its previous `ci:` partition, are
   * dropped (`drops`: their site-relative paths). Totals and range are recomputed from the entries; `complete` false;
   * `updatedAt` now.
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
  - `planSync` on an empty manifest with one update (sequence 1, two carried partitions and a `ci`) gives three entries numbered 0, 1, 2 with sources `job:7#flush:0`, `job:7#flush:1`, `ci:7`, three copy sets, no drops, `state.next` 3, `state.jobs['7'].sequence` 1, totals the sum of rows, `range` the min and max of `timeMin`/`timeMax`;
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

### Task 2.1: Site state

**Files:**
- Create: `src/cli/ci/site-state.ts`
- Test: `test/cli/ci/site-state.test.ts`

**Interfaces:**
```ts
export const STATE_DIR = 'site-state';
export const STATE_ARTIFACT = 'otel-html-site-state';
export interface AppliedJson {
  version: 1;
  /** full: the run that wrote it; consumed-only: the deployment it was built on (§5.3 step 1). */
  form: { kind: 'full'; runId: number } | { kind: 'consumed'; base: number };
  /** Consumed update artifact ids with their outcome and the deployer run (`pass`) that consumed them; ids older than `floor` are dropped on write. */
  updates: Record<string, { outcome: 'applied' | 'superseded' | 'removed-pr' | 'complete' | 'rejected'; pass: number }>;
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

- [ ] **Step 1: Tests**: round trip of each file; a missing `site-state/` reads as `emptyState`; a malformed `applied.json` warns and reads empty; `scanFiles` over a memory-fs site lists `index.json` and `branch/main/data/manifest.js` with sizes and not `site-state/applied.json`.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): the site's state files: applied, removed, files, deletions, runs`

### Task 2.2: `ci deploy plan`

**Files:**
- Create: `src/cli/ci/deploy-plan.ts`, `src/cli/ci/deploy-main.ts` (`runDeployPlan`)
- Modify: `src/cli/ci/github-api.ts` (`ApiRun` gains `path: string`, `pull_requests: { number: number }[]`, `actor: { type: string } | null`; new `ApiArtifact`, `ApiDeployment`, `ApiDeploymentStatus` types; `fetchArtifacts(i, token, timeoutMs, fetchFn)` paging `/actions/artifacts?per_page=100` until `stop(created_at)`; `deleteJson(url, token, timeoutMs, fetchFn)`), `src/cli/commands/ci.ts` (`ci deploy plan`)
- Test: `test/cli/ci/deploy-plan.test.ts`

**Interfaces:**
```ts
// deploy-plan.ts
export interface PlanOptions { repository: string; defaultBranch?: string; ciWorkflows: string[]; reportWorkflow: string; pagesUrl: string; stateDir?: string /* a downloaded otel-html-site-state, else the live site's applied.json */; now: string }
export type BaseKind = 'artifact' | 'live' | 'gh-pages' | 'empty' | 'wait';
export interface BaseInfo { kind: BaseKind; deploymentId?: number; runId?: number; artifactId?: number; stateArtifactId?: number; liveAt?: string }
export interface PendingUpdate {
  id: number; name: string; kind: UpdateKind; createdAt: string; runId: number; runAttempt: number;
  run: SiteRun & { event: string; path: string }; channel: { key: string; channel: Omit<Channel, 'runs'> } | null;
  accepted: boolean; reason?: string;
}
export interface PendingPlan { version: 1; base: BaseInfo; updates: PendingUpdate[]; floor: string; now: string }
/** §5.3 step 1 and "the base, in order", through `fetchFn`; never downloads a site. */
export async function planDeploy(o: PlanOptions, token: string | undefined, fetchFn: Fetch): Promise<PendingPlan>;
```
`runDeployPlan(opts, io, fetchFn)` writes `pending.json` to `--out`, prints a summary, and sets `GITHUB_OUTPUT`s: `pending` (`true` when any accepted update exists or a deletion is due), `base_kind`, `base_run_id`, `base_artifact_id`, `state_artifact_id`, `update_ids` (comma-separated accepted ids), `wait` (`true` for `BaseKind` `wait`). Flags: `--repository`, `--out`, `--pages-url`, `--ci-workflows` (default `ci.yml`), `--report-workflow` (default `ci-report.yml`), `--state <dir>`.

The last successful deployment: deployments of `github-pages` newest first, the first whose statuses hold `success`; its run id from the `success` status's `log_url` (`/actions/runs/(\d+)/`); `GET /actions/runs/<id>/artifacts?name=github-pages` and `?name=otel-html-site-state`. State: `--state` when given and its form counts (full: `runId === base run`; consumed: `base === deployment id`), else the live `<pagesUrl>/site-state/applied.json` (a 404 is "everything pending"). `live` when no artifact but the live site serves `site-state/files.json`; `wait` when so and the newest deployment is younger than 10 minutes; `gh-pages` when neither and `GET /repos/{o}/{r}/branches/gh-pages` is 200; else `empty`. Listing: `fetchArtifacts` with `stop = created_at < floor`, keeping names with `UPDATE_PREFIX` not in `applied.updates`; one `GET /actions/runs/<id>` per distinct run (cached), pulls of `head_sha` for `push` runs; D59 decides `accepted`/`reason`. `floor` for the next pass: the oldest accepted-but-not-applied update's `created_at` is not known here, so the plan sets `floor = min(created_at of listed pending) - 1 h` or `now - 1 h` when none.

- [ ] **Step 1: Write the failing tests** with a fake `fetchFn` keyed by URL (the `site-main.test.ts` pattern): a repository with two deployments (the newest without `success`, the older with `success` → `log_url` run 11, whose artifacts are `github-pages` 100 and `otel-html-site-state` 101) and artifacts `otel-html-update-push-7-1` (run 21, `path: .github/workflows/ci.yml`, event `pull_request`, head sha with an open PR 5), `otel-html-update-run-22-1` (run 22, `ci-report.yml`, event `workflow_run`), `otel-html-update-run-23-1` (run 23, `ci.yml`, event `push` → rejected "not the report workflow"), `otel-html-update-push-8-1` (a run with event `pull_request_target` → rejected), `otel-html-update-remove-pr-5-24` (`ci-report.yml`, `pull_request_target` → accepted), `ci-run-report` (ignored), one older than the floor (not fetched: the fake asserts page 2 is never requested); `applied.updates` from a fake state dir marks one id consumed. Assert the `PendingPlan`: base `artifact` with ids 100 and 101, the accepted set, the reasons, the `push`'s channel `pr/5`, `floor`. Then: no `success` anywhere + live `files.json` 200 + newest deployment 2 minutes old → `wait`; 12 minutes old → `live`; no live `files.json` + branch 200 → `gh-pages`; branch 404 → `empty`. `runDeployPlan` writes `pending.json` and the outputs (`update_ids` is `<id>,<id>,<id>`).
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): ci deploy plan finds the last deployed site and the pending updates and authenticates each by its run`

### Task 2.3: `ci deploy apply`

**Files:**
- Create: `src/cli/ci/deploy-apply.ts`
- Modify: `src/cli/ci/site-main.ts` (extract `placeFinishedRun(site, placed: { key, channel }, siteRun: SiteRun, report: string, o: { retention, prRetention, config, deps, io, nextPartition: number }): Promise<{ rolling: 'built' | 'stub'; previousFiles: string[] }>` and `removePullRequest(site, pr, repository, deps, io): Promise<boolean>` from `runSite`/`runCleanup`, which call them), `src/cli/ci/site-io.ts` (`placeRunReport` gains `opts: { renumberFrom?: number }` and no longer removes `to` first: the caller passes the old manifest's files to deletions), `src/cli/ci/deploy-main.ts` (`runDeployApply`), `src/cli/commands/ci.ts` (`ci deploy apply`)
- Test: `test/cli/ci/deploy-apply.test.ts`, `test/cli/ci/deploy-plan.test.ts` (one more test: with no accepted update and no deletion due, `runDeployPlan` writes `pending=false`, so the action downloads nothing)

**Interfaces:**
```ts
export interface ApplyOptions { site: string /* the unpacked base, edited in place */; updates: string /* <dir>/<artifact name>/ per update */; pending: PendingPlan; repository: string; retention: number; prRetention: number; config?: string; passRunId: number; deploymentLiveAt?: string /* the base deployment's success time, for deferred deletions */; now: string; trust?: { channel: string } /* D63 */ }
export interface ApplyResult { changed: boolean; consumed: number; deployed: boolean /* = changed */; previews: string[] /* branch channels whose rolling report was rebuilt */; pendingJobs: string[]; rejected: number }
/** §5.3 steps 3 to 5 over directories: remove-pr and reopen-pr by time, then push (one sync per run and job), then run; deletions due; state written; never deploys. */
export async function applyUpdates(o: ApplyOptions, deps: WriterDeps, io: CliIo): Promise<ApplyResult>;
```
Rules the tests pin: a `push` for a run whose manifest in the base is `complete` for that attempt is `superseded`; a `push` for a pull request in `removed.json` is `removed-pr` until a `reopen-pr`; a `run` update replaces the run folder through `placeFinishedRun` with `nextPartition` from `runs.json` (D54), schedules the old files, applies retention, rebuilds the rolling report and badges, writes the index and landing, `ensureSharedAssets` + `pruneAssets`; a `push` creates the run folder and the channel's `index.json` entry with `conclusion: 'in_progress'` and no rolling rebuild; `deletions.json` entries whose `pass` equals the base deployment's run get `liveAt = deploymentLiveAt`, and those with `liveAt` at least 15 min before `now` are deleted; a pass that consumed nothing and changed nothing writes no state (`changed: false`); a pass that only consumed (every update superseded or rejected) writes the consumed-only form.

- [ ] **Step 1: Write the failing tests** over a temp directory site with `resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' })` and update folders built from `buildFormat4Report` partitions (write a helper `test-support/update-dir.ts`: `writePushUpdate(dir, u: UpdateJson, files)`); a `pending.json` built by hand:
  - one `push` (job 7, sequence 1) on an empty base, and the same on a base without `site-state/` that holds an old-publisher site (an `index.json` with a channel and a run folder: the `gh-pages` tree or the old deploy job's artifact): `<channel>/runs/<run>/data/manifest.js` lists the partitions and the `ci:7` entry, `index.json` has the run with `conclusion: 'in_progress'`, `assets/9.9.9/` exists, `site-state/runs.json` has `next`, `applied.updates[id] === 'applied'`, `changed: true`;
  - the same pending again on the result: `changed: false`, `consumed: 0`;
  - sequence 2 listing a compacted source: the flush files are still on disk, listed in `deletions.json` with `pass`, and absent from the manifest; a third pass with `deploymentLiveAt` 16 min before `now` deletes them; at 14 min it does not (Review Focus 4);
  - a `push` whose listed partition's files are nowhere: the job in `pendingJobs`, the manifest unchanged, the update not in `applied` (Review Focus 1);
  - a `run` update (a `local` report from `createReportWith` + `ci report`'s shape) over a run with provisional partitions numbered 0 to 2: the final report's partitions start at 3, the old paths are in `deletions.json`, `complete` is true, the rolling report folder has `data/manifest.js`, a `badge-ci.json` exists, `previews` is `['branch/main']` for the default branch's channel and `[]` for `pr/5`;
  - a `push` arriving after that `run` for the same attempt: `superseded`; for attempt 2 with the same job name: applied and `complete` false again, the attempt-1 partitions of that job name dropped, the other job's kept (§5.4 re-runs);
  - `remove-pr` for `pr/5` then a `push` for it: the folder gone, the push `removed-pr`; then `reopen-pr` then the push: applied;
  - a rejected update in `pending.json` is recorded `rejected` and the rest of the pass runs (Review Focus 3); an update folder whose `update.json` fails `readUpdate` (a `..` path) is recorded `rejected` with a warning;
  - a pass with every update superseded: `changed: false`, `consumed: 2`, `applied.json` in the consumed-only form naming `pending.base.deploymentId`;
  - `files.json` after a pass lists every file written and no `site-state/` entry; `trust: { channel: 'branch/smoke' }` applies two update folders without `pending.json` entries.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** (`deploy-apply.ts` orchestrates; `planSync` and the extracted site functions do the work; the CLI flags: `--site`, `--updates`, `--pending`, `--repository`, `--retention`, `--pr-retention`, `--config`, `--pass-run-id`, `--deployment-live-at`, `--trust-updates`, `--channel`; outputs `changed`, `consumed`, `deploy`, `previews`, `pending_jobs`). **Step 4: Run**; PASS; the existing `site-main.test.ts` and `site.test.ts` still pass. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(ci): ci deploy apply applies pending updates to a site in the spec's order with deferred deletion and site state`

### Task 2.4: `ci deploy prune` and `ci deploy fetch-live`

**Files:**
- Create: `src/cli/ci/deploy-prune.ts`
- Modify: `src/cli/ci/deploy-main.ts`, `src/cli/commands/ci.ts`
- Test: `test/cli/ci/deploy-prune.test.ts`

**Interfaces:**
```ts
/**
 * §5.3 step 6: keeps the `github-pages` and `otel-html-site-state` artifacts of the newest `keep` successful deployments
 * and deletes older ones (a failed pass's too); deletes the update artifacts whose `applied.updates[id].pass` is at or
 * below the oldest kept deployment's run id (deployer run ids grow with time, and that deployment's own applied.json
 * lists everything consumed at or before its pass, so falling back to it never meets an update that is gone). Returns
 * what it deleted; a failed delete is a warning.
 */
export async function pruneArtifacts(o: { repository: string; keep: number; applied: AppliedJson; token?: string; now: string }, fetchFn: Fetch, warn: (m: string) => void): Promise<{ deleted: number[] }>;
/** Cold start (§5.3 base 2): GETs `<pagesUrl>/site-state/files.json` and every listed path into `out`; fails `invalid-report` when a file is missing or its size differs. */
export async function fetchLiveSite(o: { pagesUrl: string; out: string }, fs: FileSystem, fetchFn: Fetch): Promise<{ files: number; bytes: number }>;
```
- [ ] **Step 1: Tests**: with five successful deployments (runs 10, 20, 30, 40, 50) and `keep: 3`, the `github-pages` and state artifacts of runs 10 and 20 are deleted (the fake records `DELETE /actions/artifacts/<id>`), a failed pass's artifacts (run 25) too, and of the `applied` updates those with `pass` 10, 20 or 30 are deleted while `pass` 40 and 50 stay; a 403 on one delete is a warning and the rest proceed. `fetchLiveSite` over a local `node:http` server serving a fixture site writes every file and rejects on a size mismatch.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): ci deploy prune keeps three deployments; ci deploy fetch-live rebuilds a base from the live site`

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
/** `ci update run`: copies the `ci report` output to `--out/<name>/` beside `update.json`; outputs `name`, `channel`, `report-url` (`<base-url>/<channel>/runs/<run>/`, or empty and `published=false` when the run has no channel). */
export async function runUpdateRun(o: { report: string; out: string; runId: number; repository: string; baseUrl: string }, io: CliIo, deps: WriterDeps, fetchFn?: Fetch): Promise<void>;
/** `ci update remove-pr` / `reopen-pr`: `update.json` alone; outputs `name`. */
export async function runUpdatePr(o: { kind: 'remove-pr' | 'reopen-pr'; pr: number; out: string }, io: CliIo): Promise<void>;
/** `ci update done`: records a finished upload in the ledger (`--name`), and prints the pusher log's failures as one `::notice::` when `--log` is given. */
export async function runUpdateDone(o: { name: string; publishDir: string; log?: string }, io: CliIo): Promise<void>;
// dispatch.ts
/** §5.2: dispatches `--workflow` on the default branch when GITHUB_RUN_ID's run is a same-repository run whose `actor.type` is `User`; any failure (403 included) is one log line; exit 0 always. */
export async function runDispatch(o: { workflow: string; repository: string; runId: number }, io: CliIo, fetchFn?: Fetch): Promise<void>;
```
- [ ] **Step 1: Tests**: `runUpdatePush` over a `local` job report written by `createReportWith` with two flushes (`close: false` then a flush) lists two `flush:` sources carried, `update.json` validates, the files are under `partitions/0/`, `partitions/1/`; with a ledger whose `shipped` names one source, that partition is listed `carried: false` and its files absent; after `close()` the listing is one `compact:` source; `--final` with a pid file of a dead pid proceeds (no wait); with `GITHUB_TOKEN` and a fake jobs API the update has a `ci` partition whose `spans.parquet` holds the provisional root (decode with `test-support/duckdb-node.ts` or `parquet-metadata.ts`: rows = root + job + queued + completed steps); without a token no `ci` and a warning. `runUpdateRun` writes `name=otel-html-update-run-42-1`, `channel=pr/5`, `report-url=https://x/pr/5/runs/42/`. `runUpdatePr` names. `runDispatch`: `actor.type: 'User'` same repo → `POST /actions/workflows/pages-deploy.yml/dispatches` with `{ ref: '<default branch>' }`; `Bot` → no POST, one line; a 403 → one line, resolves.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(ci): ci update writes push, run, remove-pr and reopen-pr updates; ci dispatch wakes the deployer`

### Task 2.6: `ci link --index-url`; README

**Files:**
- Modify: `src/cli/ci/link-main.ts` (`site` → `indexUrl`; `readSiteIndex` → `parseSiteIndex(await (fetch(indexUrl)).text())`, a failure is a warning and no previous-run line), `src/cli/commands/ci.ts`, `README.md` ("This repo's CI" table: `ci link` flags; new rows for `ci update`, `ci dispatch`, `ci deploy plan|apply|prune|fetch-live` with their flags and outputs, the D63 test flags marked)
- Test: `test/cli/ci/link.test.ts` (one test: the previous run comes from the fetched index)

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

The action (composite; inputs per D58; `token` default `github.token`): resolve the command as `otel-html-publish` does; `ci deploy plan` runs twice: a first step (`id: locate`) with `--pages-url` from `actions/configure-pages`'s `base_url` and no `--state`, to learn `state_artifact_id`; `actions/download-artifact` of that artifact (`name: otel-html-site-state`, `run-id: base_run_id`, `github-token`) when the id is set; then the real plan (`id: plan`) with `--state <that folder>` when it was downloaded (without a state artifact the plan reads the live `applied.json`, §5.3 step 1); every later step `if: steps.plan.outputs.pending == 'true'`; base by kind: `actions/download-artifact` (`name: github-pages`, `run-id`, `github-token`) + `tar -xf artifact.tar -C base`; `actions/checkout` (`ref: gh-pages`, `fetch-depth: 1`, `path: base`, `persist-credentials: false`) + `rm -rf base/.git` for `gh-pages`; `ci deploy fetch-live` for `live`; nothing for `empty`; `wait` ends the pass (`echo "::notice::..."`); `actions/download-artifact` with `artifact-ids: ${{ steps.plan.outputs.update_ids }}` + `github-token` into `updates/`; `ci deploy apply` (`id: apply`); the preview browser install and `node preview.mjs base <channel>` for each of `previews` when `preview == 'true'` (as the publish action did); `if: steps.apply.outputs.deploy == 'true'`: `actions/upload-pages-artifact` (`path: base`, `retention-days: 90`), `actions/upload-artifact` (`name: otel-html-site-state`, `path: base/site-state/`, `retention-days: 90`), `actions/deploy-pages` (`id: deployment`); `else if consumed > 0`: the state upload alone; `ci deploy prune` with `continue-on-error: true`. Outputs: `deployed`, `page_url`.

`pages-deploy.yml`: triggers `workflow_dispatch`, `workflow_run: { workflows: [ci-report], types: [completed] }`, `schedule: '*/5 * * * *'`; `permissions: {}`; the first step of each job is `if: github.run_attempt > 1` → `exit 1` with the spec's reason (a re-run of a deploying workflow is never allowed); job `plan` (`actions: read`, `deployments: read`, `pages: read`, `contents: read` for the checkout; `mise run build`; `ci deploy plan` with `command: node dist/cli/main.js`; output `pending`); job `deploy` (`needs: plan`, `if: needs.plan.outputs.pending == 'true'`, `concurrency: { group: pages, cancel-in-progress: false }`, `environment: github-pages`, permissions `contents: read`, `actions: write`, `deployments: read`, `pages: write`, `id-token: write`; checkout `main`, setup, build, `./.github/actions/otel-html-deploy` with `command: node dist/cli/main.js`, `config: .github/otel-html-ci.yaml` when present, `preview: true`, `ci-workflows: ci.yml,load.yml`).

- [ ] **Step 1: Stop and ask** with the two files' text. **Step 2**: write them; `actionlint` clean if available. **Step 3: Commit** `ci: the otel-html-deploy action and the pages-deploy workflow`

### Task 3.2: `otel-html-publish` and `ci-report.yml`

**Files:**
- Modify: `.github/actions/otel-html-publish/action.yml` (D58: after `ci report`, `ci update run --base-url` from `configure-pages`; `actions/upload-artifact` of `$RUNNER_TEMP/otel-html-update/<name>` as `<name>` with `retention-days: 90` when `name` is set; `ci dispatch --workflow <deployer-workflow>`; `ci link --index-url <base_url>/index.json --url <report-url>`; `cleanup-pr` and `reopen-pr` through `ci update remove-pr|reopen-pr` + upload + dispatch; no lease, no deploy, no preview; `token` needs `actions: write` (dispatch), `pages: read`, `pull-requests: write`, `checks: write`), `.github/workflows/ci-report.yml` (`report`: permissions `actions: write`, `contents: read`, `pages: read`, `pull-requests: write`, `checks: write`; `cleanup` on `pull_request_target: [closed, reopened]` passing `cleanup-pr` or `reopen-pr`, permissions `actions: write`; the `deploy` job removed; comments updated)
- Delete: `.github/actions/otel-html-publish/site-lease.sh`, `site-branch.sh`, `site-publish.sh`, `test/actions/site-branch.test.ts`
- Modify: `src/cli/commands/ci.ts` (remove `ci site`, `ci cleanup`), `src/cli/ci/site-main.ts` (remove `runSite`, `runCleanup`; keep the extracted functions), `test/cli/ci/site-main.test.ts` (tests move to the extracted functions), `README.md` (D57 rows removed)

- [ ] **Step 1: Stop and ask** with the diff. **Step 2**: apply; `mise run check` PASS. **Step 3: Commit** `feat(ci)!: otel-html-publish uploads a run update and links; ci-report no longer writes or deploys the site`

### Task 3.3: Jobs publish at their end; the README and release notes

**Files:**
- Modify: `.github/actions/otel-html-collect/action.yml` (inputs `publish` default `false`, `deployer-workflow` default `pages-deploy.yml`, `command` default `otel-html`, `config`; when `publish`: `ci update push --final` (`id: update`), `actions/upload-artifact` of the update folder as `${{ steps.update.outputs.name }}` with `retention-days: 90` `if: steps.update.outputs.name != ''`, `ci update done --name ... --log .otel-html/publish/pusher.log`, `ci dispatch`; the existing `.otel-html/` upload unchanged), `.github/workflows/ci.yml` and `load.yml` (every report-producing job: `permissions: { contents: read, actions: write }`; the collect step gains `publish: true` and `command: node dist/cli/main.js`), `.github/workflows/actions-smoke.yml` (collect with `publish: true`: the smoke uploads an update too), `README.md` ("This repo's CI": the deployer, the site's life cycle (updates, passes, deferred deletion, `site-state/`), the permissions, `pages-deploy.yml`; "Use in your CI": the publisher example rewritten with the `deploy` job on `otel-html-deploy`, the inputs tables of D58, "Pages setup", the migration paragraph (add the deploy job, Pages source "GitHub Actions", delete `gh-pages` after the first pass), the security paragraph on `actions: write` from §7; the `--single-branch` paragraph stays until Task 7.1), `docs/agents/process-unattended.md` (the stop-and-ask list names `pages-deploy.yml` and `otel-html-deploy` too)

- [ ] **Step 1: Stop and ask**. **Step 2**: apply; `mise run check`; `mise run gen:check`. **Step 3: Commit** `feat(ci): jobs upload a push update at their end and wake the deployer; README for the deployer`

### PR 3 close

- [ ] `mise run verify`; PR (the e2e suite as always). The PR's own CI exercises `ci.yml`'s collect step (`publish: true`: the uploads use the runtime token every job has; a same-repository person's pull request run holds `actions: write` as declared, so its collect step dispatches the deployer, and the PR's `push` updates land under `pr/<n>/` through the deployer running `main`'s code) and `actions-smoke.yml`. Branch review on Opus 5.5. Merge.
- [ ] **After the merge**: the push to `main` runs `ci`, then `ci-report` uploads a `run` update and dispatches; watch `pages-deploy.yml`'s first pass (base kind, duration, the site size in the uploaded tarball), download that run's `github-pages` artifact and check the tarball holds `site-state/applied.json` (§8: `upload-pages-artifact` drops dotfiles, not `site-state/`), and record the figures in the PR's merged body (edit) and in Task 7.2's record. If the first pass fails, fix forward in a `fix(ci):` PR (stop and ask applies).
- [ ] Tell the maintainer the first pass deployed, so they can delete `gh-pages` (Task 7.1 records it).

---

## PR 4: The pusher

Branch `feat/publish-pusher` from `main`. Title: `feat(ci): a detached pusher uploads a job's partitions while it runs`.

### Task 4.1: The upload client, proven on the runners (stop and ask: `actions-smoke.yml`)

**Files:**
- Create: `src/cli/ci/zip.ts`, `src/cli/ci/artifact-client.ts`, `src/cli/ci/upload-main.ts`
- Modify: `src/cli/commands/ci.ts` (`ci upload --name <n> --path <dir> [--retention-days <d>]`), `.github/workflows/actions-smoke.yml` (a step after the collect: `actions/github-script` pinned, `env: { CMD: otel-html }`, script: `spawnSync` of `CMD ci upload --name otel-html-smoke-upload-<os> --path .otel-html/` with `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL` in the child's env, `core.setFailed` on a non-zero exit; then a `bash` step `gh api repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts --jq '.artifacts[].name' | grep -qx otel-html-smoke-upload-<os>`)
- Test: `test/cli/ci/zip.test.ts`, `test/cli/ci/artifact-client.test.ts`

**Interfaces:**
```ts
// zip.ts
/** A stored (method 0) zip of `files` (`name` → bytes), UTF-8 names, DOS times from `mtime`, CRC32 via node:zlib; no zip64 (refuses a total above 4 GiB with `usage`). */
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
- [ ] **Step 1: Write the failing tests**: `storedZip` of two files unzips with the system `unzip -l` or Python's `zipfile` when available, else assert the local header signature, the central directory count and the CRC of a known string (`crc32('hello')` is `0x3610a686`); `backendIds` of a JWT built in the test with `scp: 'Actions.GenericRead:00000000 Actions.Results:run-id:job-id'` gives both ids and rejects `usage` without the scope; `uploadArtifact` against a `node:http` server in the test answering the two Twirp routes and the blob `PUT` (asserting method, `x-ms-blob-type: BlockBlob`, body size, then JSON `{ ok: true, signedUploadUrl }` and `{ ok: true, artifactId: '77' }`) returns `{ id: 77 }` and sent `size: '<bytes>'`, `hash: { value: 'sha256:<hex of the zip>' }`, `version` a number, `mimeType: { value: 'application/zip' }`; a first 503 then 200 succeeds after one backoff (`sleep` recorded); a 400 rejects at once; `MAX_UPLOAD_BYTES + 1` rejects `usage` without a request.
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
/** One tick (D60): read the manifest (absent: nothing), diff sources against the ledger and the last listing, build the update folder under `<publishDir>/tick-<n>/` (`runUpdatePush`'s builder, shared), zip, upload, record the ledger, dispatch, remove the folder. Every failure is one log line and `'retry'`. */
export async function tick(o: PusherOptions, d: PusherDeps, last: string[] | null): Promise<{ outcome: 'uploaded' | 'unchanged' | 'retry'; listing: string[] }>;
/** Writes the pid file, loops `tick` every `everyMs` until the stop file exists (checked each second and after an upload) or SIGTERM, removes the pid file, resolves. */
export async function runPusher(o: PusherOptions, d: PusherDeps, signals: CliIo['signals']): Promise<void>;
```
- [ ] **Step 1: Tests** (memory fs or a temp dir; a fake `upload` recording names; fake `sleep` driving time): a report with one partition → the first tick uploads `otel-html-update-push-<key>-1` carrying it, the ledger has `shipped` and `sequence: 1`; a tick with no change → `unchanged`, no upload; a new flush → sequence 2 carrying only the new partition; a compaction (the manifest now lists one `compact:` source, the flush files deleted) → sequence 3 listing `compact:` carried, and the ledger's `shipped` holds all three; an upload that throws → `retry`, a log line containing the message, the ledger unchanged, the next tick re-uploads under the same sequence; a partition file missing between the manifest read and the copy → `retry`; `runPusher` with the stop file created after two ticks resolves, the pid file is gone, and `everyMs` was respected (the fake `sleep` saw 60,000 or the remainder); no `ACTIONS_RUNTIME_TOKEN` in `env` → each tick logs once and `retry` (Review Focus 5).
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
- Modify: `.github/actions/otel-html-setup/action.yml` (inputs `push-every` default empty, `config` default empty, `deployer-workflow` default `pages-deploy.yml`; `if: inputs.push-every != ''` an `actions/github-script` step after `ci context`: `spawnSync` of `CMD ci pusher --report .otel-html/report --every <push-every> [--config] --deployer-workflow ...` with the two runtime variables in the child's env only, `stdio: 'inherit'`, `core.warning` on a non-zero exit, never `core.setFailed`; the `GITHUB_TOKEN` of `inputs.token` in the child's env as `GITHUB_TOKEN`), `.github/workflows/actions-smoke.yml` (setup with `push-every: 5s`; after the `echo hello` step a `bash` step sleeps 12 s then asserts `.otel-html/publish/uploads.json` lists at least one upload and `pusher.pid` exists; after the collect (`publish: true`) a step downloads this run's `otel-html-update-push-*` artifacts (`actions/download-artifact`, `pattern`) and runs `otel-html ci deploy apply --trust-updates --channel branch/smoke --site scratch --updates downloaded --repository "$GITHUB_REPOSITORY" --retention 30 --pr-retention 10 --pass-run-id "$GITHUB_RUN_ID"` and asserts `scratch/branch/smoke/runs/$GITHUB_RUN_ID/data/manifest.js` lists a `compact:` source and no `flush:` one, and that the earliest update's `update.json` (lowest sequence) listed a `flush:` source (§8's two assertions); the Windows leg included), `README.md` ("Use in your CI": `push-every`, what the pusher does, the log and ledger files, the notice; "This repo's CI": 60 s)

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
/** DuckDB-WASM's wording for a registered HTTP file that answers 404 (measured in the test). */
export function isGoneFile(error: unknown): boolean;
```
- [ ] **Step 1: Write the failing tests** (the Node engine of `test-support/duckdb-node.ts` over `writeReportDir` fixtures served by a `node:http` static server in the test, so `format: 'site'` URLs are real): open a one-partition report, then write a second partition and a new manifest listing both into the served folder; `refreshReport` returns a data source whose span count is the sum, and `querySpans` on the old data source would have returned the old count (the cache was cleared: assert through a count query before and after); then a manifest listing only a compacted partition (write it) → the dropped file is unregistered (`engine.db.globFiles` or a query on the old filename fails) and the count is right; a manifest of format 3 rejects with the D12 message and the old data source still answers; delete the served `spans.parquet` of a listed partition and query → the error satisfies `isGoneFile` (record the message in the test's comment). `openReportRefreshable` with `host` set gives `refresh: null`; without, a function; `QueryEngine.clearCache` exists on the fakes.
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

- [ ] **Step 1: Test** (serial, one worker, HTTP project only: the `HTTP` tag): open the `refresh` report, the Traces explorer shows the first partition's count and the line "In progress"; copy `manifest.step2.js` over the served `data/manifest.js`; click Refresh; the count is the full one and the line's age is fresh; restore step 1 in `afterEach`; the page's requests never include a `.parquet` of the dropped... (no drop in this fixture) include the second partition's `spans.parquet` only after Refresh.
- [ ] **Step 2**: `mise run test:e2e:chromium -- e2e/refresh.spec.ts`; PASS. **Step 3: Commit** `test(e2e): Refresh picks up a new partition over HTTP`

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

- [ ] Ask the maintainer to delete the `gh-pages` branch once a `pages-deploy.yml` pass has deployed from a Pages artifact (PR 3 close) and the site is intact. When they confirm (`git ls-remote --heads origin gh-pages` is empty): remove the README's `--single-branch` paragraph (line "Clone with `git clone --single-branch ...`", §1a) and the `release.yml` comment naming the publisher's force push; `mise run gen:check`. Commit `docs: the gh-pages branch is gone; clone normally`. If the maintainer has not deleted it yet, leave the paragraph and say so in the summary.

### Task 7.2: The record

- [ ] Append to this plan a "Record: rulings and notes" section in the earlier plans' format: rulings `R<n>` continuing from R130 (from the PR bodies: D51 to D63 as applied, with what changed on the way), spec deviations with line numbers (§5.1 line 153 "kept in the run manifest" → D53; §5.6 gRPC → D62 and the issue; §5.7 `no-store` → builder check 2 and D55; §5.9 the `otel-html-deploy` inputs → D58; §5.3 step 1 "no name filter" → builder check 1), the measured figures (PR 3: the first pass's base kind, duration, tarball size; PR 4: the three upload times per OS, the partition-to-live latency samples; PR 5: the Refresh e2e timing), and open follow-ups (gRPC fan-out, the object store target plan, #246's effect on Refresh over a host).

### Task 7.3: Kickoff prompts

- [ ] In `docs/superpowers/plans/2026-11-06-format-4-writer.md`, "Kickoff prompts": mark rule 8 done ("the publishing plan is merged") and add rule 9: "Plans 1 to 4, the release and the publishing plan merged → the format-4 work is complete; `/format-4` reports that and stops." Commit `docs: kickoff prompts after the publishing plan`.

### Plan close-out

- [ ] `mise run check`; PR; merge. Post the summary the unattended process asks for: each PR's number, title and measurements (PR 3's first pass, PR 4's upload times and latency samples, PR 5's e2e timing); the issues opened (gRPC fan-out; any from the way); anything stopped on (every stop-and-ask and the maintainer's answer; whether `gh-pages` is deleted).
