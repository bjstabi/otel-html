# One CI report with slim history and one shared assets folder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The site keeps one CI report at `branch/main/` holding every retained run of main and of every pull request,
full while recent and slim (CI spans only) for a long history, and every report loads its viewer and engine files from
one flat `assets/` folder pruned file by file.

**Architecture:** Part A replaces `assets/<version>/` by a flat `assets/` whose files are named by content hash or
engine version; pruning computes the referenced set from every report's page and manifest and defers the rest. Part B
makes the deployer the owner of the one report's manifest: a `run` update's partitions are copied in under
`run:<id>#<attempt>` sources, retention tiers are computed over the index, and a run that becomes slim is rewritten
from its own partition through a scratch writer session that keeps the `otel-html-ci` scope only. Rolling merges,
per-run folders and per-PR reports go; the index records each run's `detail` and its link.

**Tech Stack:** TypeScript (strict), zod, parquet-wasm (`readColumns`), the writer's partition session, vitest, mise.

**Spec:** `docs/superpowers/specs/2026-11-19-slim-history-shared-assets-design.md` (approved 2026-11-19). The spec
wins where they differ.

**PR process:** unattended (`docs/agents/process-unattended.md`), one PR.

| #   | branch              | PR title                                                                        | status |
| --- | ------------------- | ------------------------------------------------------------------------------- | ------ |
| 1   | `feat/slim-history` | `feat(ci): one CI report with full and slim runs on one shared assets folder`   | open   |

- **Models.** Implementers and task reviewers run on Sonnet 5.5. The branch review runs on Opus 5.5.
- **Bugs found on the way** are fixed in this PR and listed under **Also** in its body.
- **Write-token files.** This plan touches `src/cli/ci/`, `src/writer/`, `src/format/`, `src/cli/commands/ci.ts`,
  `test/`, `test-support/` and the README. It does **not** change `site.yml`, `pr-cleanup.yml`, `ci.yml` or the
  actions, with one exception the maintainer decides before execution (see Global Constraints): the `pr-retention`
  input default in `.github/actions/otel-html-deploy/action.yml`. Any other change there is a stop.
- **Commits** end with the session's trailers (`Co-Authored-By`, `Claude-Session`).

## Global Constraints

- Retention numbers (spec §5.3): `--retention` 30 full main runs; `--slim-retention` 100 main runs in all;
  `--pr-retention` 3 full runs per open pull request; `--pr-slim-retention` 100 slim pull request runs per workflow
  across all pull requests. All per workflow; code defaults.
- The deploy action passes `--pr-retention` from its `pr-retention` input, whose default is `"10"` (action.yml line
  31). **Maintainer decision, recorded 2026-11-19 before execution:** change that default to `"3"` (one line, plus
  its description). The maintainer approved this one write-token change ("yes and change it"); Task 7 makes it, and
  the PR body names it.
- Partition source of a run in the one report: `run:<run id>#<attempt>`; `SOURCE_RE` gains the `run` prefix.
- A slim run keeps only spans whose scope name is `otel-html-ci`; no logs, no points.
- Nothing a live page may still name is removed at once: replaced partition files, run folders and unreferenced asset
  files go through `scheduleDeletion` (D66, 15 minutes).
- The flat assets base of the one report is `../../assets/`; of a staging run folder `<channel>/runs/<id>/`,
  `../../../../assets/`. `ASSETS_BASE_RE` already accepts both.
- The one report's dashboard config gets a variable default `vcs.ref.head.name = <default branch>` injected by the
  deployer; `.github/otel-html-ci.yaml` does not change.
- The index (`index.json`) stays `version: 1`; new fields are optional: `SiteRun.detail`, `SiteRun.reportUrl`,
  `Channel.closedAt`.
- The `site / deploy` job stays under 8 minutes; no pass merges the whole history.
- No new dependency. No public API or format change beyond `SOURCE_RE`.
- Before each commit: `pnpm exec biome check .` and `mise run typecheck`; `mise run check` after each task;
  `mise run verify` before the PR.

## Review Focus

Inputs the spec implies but no task's tests exercise directly; each gets a test in the task named.

1. **A `run` update for a run id already slim** (a re-run of an old run): the new attempt's partitions replace the
   old attempt's and the run is full again (`detail: 'full'` set by the add, then tiers may trim it next pass) — Task 7.
2. **A trimming failure** (a partition whose spans file cannot be read): the pass warns, keeps the run full in the index
   and goes on; the next pass tries again — Task 7.
3. **A report folder with an `index.html` naming an asset outside `assets/`** (hand-edited, or `assets/../x`): the
   reference is ignored and nothing outside `assets/` is ever scheduled — Task 1.
4. **A manifest whose versioned base text appears twice or not at all** in its file: migration skips that report with a
   warning and its version folder stays referenced, so nothing of it is pruned — Task 1.
5. **A `merge:` partition whose `cicd` file has no run row, or names a run the index does not list**: dropped
   (deferred) with a warning; an indexed run with no partition stays in the index and trims to nothing — Task 6.

---

### Task 1: One flat `assets/` folder: write, reference, prune per file, migrate bases

**Files:**
- Create: `src/cli/ci/site-assets.ts`
- Modify: `src/cli/ci/site-io.ts` (remove `ensureSharedAssets`, `pruneAssets`, `reportFolders`, `assetsBaseOf`,
  `SHARED`; keep index, landing, badges, `removePaths`, `copyReport`, `placeRunReport`)
- Modify: `src/format/engine.ts:28` (`engineAssetNames` takes an optional version)
- Modify: `src/cli/ci/site.ts` (add `assetsBaseFor`)
- Modify: `src/cli/ci/site-main.ts:43-46` (`rollingAssetsBase`, `runAssetsBase` → `assetsBaseFor`), `:166`,
  `:184`, `:214` (new `ensureSharedAssets` and `pruneAssets` signatures: schedule what prune returns through `o.remove`)
- Modify: `src/cli/ci/deploy-apply.ts:343` (push path base), `:530` (`ensureSharedAssets(o.site, deps)`)
- Modify: `src/cli/ci/update-main.ts:328` (`assetsBaseFor(reportPath)`)
- Test: `test/cli/ci/site-assets.test.ts` (new), `test/cli/ci/site-main.test.ts:135-262` (adapt to the flat folder),
  `test/cli/ci/update-main.test.ts:441`, `test/cli/ci/deploy-apply.test.ts` (asset path expectations)

**Interfaces:**
- Produces, in `site-assets.ts`:
  - `export async function ensureSharedAssets(site: string, deps: WriterDeps): Promise<void>` — every file of
    `deps.viewerAssets.files('site')` lands at `<site>/assets/<name>` (name = path without `assets/`), written to
    `<dest>.tmp-<pid>` then renamed; an existing file is left as it is; `.tmp-` leftovers (files or folders) under
    `assets/` are removed first.
  - `export async function referencedAssets(site: string, deps: WriterDeps, warn: (m: string) => void): Promise<Set<string> | null>`
    — site-relative paths (`assets/viewer.<hash>.js`, `assets/duckdb.1.32.0.wasm`, …) every report folder under
    `site` references: the `src`/`href` values of its `index.html` resolved against the folder (kept only when the
    normalised path starts with `assets/` and holds no `..`), plus, when its manifest's `engine.assetsBase` resolves to
    the site's `assets/`, `engineAssetNames('site', manifest.engine.version)`; when the base resolves to
    `assets/<version>/`, the folder prefix `assets/<version>/` is referenced whole. `null` (after `warn`) when a report
    cannot be read: nothing may be pruned then. Report folders are found as today's `reportFolders` did (a folder
    holding `data/manifest.js`, depth ≤ 4, `assets/` skipped).
  - `export async function pruneAssets(site: string, deps: WriterDeps, warn?: (m: string) => void): Promise<string[]>`
    — the site-relative paths of files under `assets/` (any depth) that `referencedAssets` does not reference (by
    path or by a referenced folder prefix). Removes nothing. `[]` when the referenced set is `null`.
  - `export async function migrateAssetsBases(site: string, deps: WriterDeps, warn: (m: string) => void): Promise<string[]>`
    — for each report folder whose manifest base matches `/^(?:\.\.\/)*assets\/([^/]+)\/$/`: copies each file the
    report references under `assets/<version>/` (page hrefs and engine names as above) to `assets/<name>` when absent
    (tmp + rename), then rewrites the page by replacing every `src="…"`/`href="…"` value prefix `<old base>` by the
    flat base (`'../'.repeat(depth) + 'assets/'`), and the manifest file text by replacing the exactly-one occurrence of
    `"assetsBase":"<old base>"` with the flat one, both through `fs.writeTextAtomic`. A report with a referenced file
    missing from the version folder, or with zero or several occurrences of the base text, is skipped with `warn` and
    left untouched. Returns the migrated folders (site-relative). Idempotent: a flat base matches nothing.
- Produces, in `site.ts`: `export const assetsBaseFor = (reportPath: string): string` — `'../'.repeat(segments) + 'assets/'`.
- Produces, in `engine.ts`: `export function engineAssetNames(format: 'local' | 'site', version: string = ENGINE_VERSION): string[]`.

- [ ] **Step 1: Write the failing tests** in `test/cli/ci/site-assets.test.ts` (site in a temp dir, `deps` from
  `resolveDeps({ viewerAssets: fakeViewerAssets(), version: '9.9.9' })`; reports written with `createReportWith({ out, format: 'site', assetsBase })`
  as `test/cli/ci/site-main.test.ts` does, then `upgradeReport(deps, dir, { format: 'site', assetsBase })` for a base):

```ts
test('ensureSharedAssets writes the viewer and site engine files flat, once, and sweeps .tmp- leftovers', ...)
// assets/viewer.abc123.js, assets/viewer.abc123.css and the four engineAssetNames('site') exist; no assets/9.9.9/;
// a pre-existing assets/viewer.abc123.js with other bytes keeps its bytes; assets/.x.tmp-1 folder and
// assets/viewer.abc123.js.tmp-1 are gone afterwards
test('referencedAssets: the page hrefs and the manifest engine names of a report on the flat base', ...)
// a report at branch/main with assetsBase ../../assets/ → the set equals {assets/viewer.abc123.js, assets/viewer.abc123.css, ...engineAssetNames('site').map(n => `assets/${n}`)}
test('referencedAssets: a versioned base references its folder whole; an href outside assets/ is ignored', ...)
// base ../../assets/0.7.0/ → 'assets/0.7.0/' in the set; an index.html edited to add <script src="../../x.js"> and
// <script src="../../assets/../y.js"> adds nothing (Review Focus 3)
test('referencedAssets is null, with a warning, when a report manifest is unreadable', ...)
test('pruneAssets lists the unreferenced files under assets/ at any depth and removes nothing', ...)
// extra files assets/viewer.old.js and assets/0.6.0/viewer.z.js are listed; referenced ones are not; all still exist
test('migrateAssetsBases copies the referenced files flat, rewrites the page and the manifest base text once, and is a no-op after', ...)
// a report on ../../assets/9.9.9/ (folder filled by hand) → afterwards index.html hrefs start with ../../assets/viewer.,
// the manifest file text contains "assetsBase":"../../assets/" and still contains its formatVersion unchanged;
// assets/viewer.abc123.js exists; second call returns []
test('migrateAssetsBases skips a report whose manifest text holds the base twice or whose version folder lacks a file', ...)
// Review Focus 4: the manifest file is unchanged, the return excludes the folder, warn was called once
test('assetsBaseFor: branch/main → ../../assets/, pr/5/runs/7 → ../../../../assets/', ...)
test('engineAssetNames names another version on request', ...)
```

- [ ] **Step 2: Run them to see them fail**: `pnpm exec vitest run test/cli/ci/site-assets.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/cli/ci/site-assets.ts` with the signatures above (move `reportFolders` and
  `assetsBaseOf` from `site-io.ts` into it; href parsing with `/(?:src|href)="([^"]*)"/g` on the page text; path
  resolution with `node:path/posix` `normalize(join(folderRel, href))`). Add `assetsBaseFor` to `site.ts`, the
  `version` parameter to `engineAssetNames`, and update the callers listed above (`site-main.ts` schedules
  `await pruneAssets(...)` through `o.remove`; `removePullRequest` likewise).
- [ ] **Step 4: Adapt the existing tests** in `site-main.test.ts` (the shared folder is flat: `assets/viewer.abc123.js`,
  not `assets/9.9.9/…`; "a version no report references is pruned" becomes "a viewer file no report references is
  scheduled"), `update-main.test.ts:441` (`../../../../assets/`) and `deploy-apply.test.ts` (`assets/<name>`).
- [ ] **Step 5: Run** `pnpm exec vitest run test/cli/ci` → PASS; `mise run check` → green.
- [ ] **Step 6: Commit** `feat(ci): one flat assets folder on the site, pruned per file`.

---

### Task 2: Run partitions in the one report: source, add, drop

**Files:**
- Modify: `src/format/manifest.ts:246` (`SOURCE_RE` gains `run`)
- Modify: `src/cli/ci/run-report.ts` (export `entryFrom` and `totalsAndRange`; `entryFrom`'s second parameter typed
  `Pick<UpdatePartition, 'source' | 'files' | 'cicd'>`)
- Modify: `src/cli/ci/deploy-apply.ts:179-186` (`diskNext` moves to `main-report.ts`, exported, imported back)
- Create: `src/cli/ci/main-report.ts`
- Test: `test/format/manifest.test.ts` (one case), `test/cli/ci/main-report.test.ts` (new)

**Interfaces:**
- Consumes: `newRunManifest`, `readRunManifest`, `writeRunReport`, `entryFrom`, `totalsAndRange` (run-report.ts);
  `assetsBaseFor` (Task 1).
- Produces, in `main-report.ts`:
  - `export const runSource = (runId: number, attempt: number): string` → `run:<id>#<attempt>`.
  - `export const runSourcePrefix = (runId: number): string` → `run:<id>#`.
  - `export function sourceRun(source: string): { runId: number; attempt: number } | undefined`.
  - `export async function diskNext(reportDir: string): Promise<number>` (as today's).
  - `export async function ensureMainReport(deps: WriterDeps, dir: string, config: ResolvedConfig, o: { now: string; assetsBase: string }): Promise<string[]>`
    — creates the report when `data/manifest.js` is absent: `newRunManifest({ title: config.title ?? 'CI', createdAt: now, assetsBase, config, version: deps.version })`
    with `complete: true`; otherwise patches an existing manifest's `config` (as `newRunManifest` derives it),
    `otelHtmlVersion`, `engine.assetsBase`, and `formatVersion` to 8 when lower, writing it only when something
    differs. Rewrites `index.html` when its text would differ, `.nojekyll` when absent. Returns the report-relative
    paths written (`data/manifest.js`, `index.html`, `.nojekyll` as applicable).
  - `export async function replaceRunPartitions(deps: WriterDeps, dir: string, from: { dir: string; manifest: ManifestV4 } | null, run: { runId: number; attempt: number }, o: { now: string; next: number }): Promise<{ written: string[]; dropped: string[]; next: number }>`
    — drops every partition of `dir`'s manifest whose `source` starts with `runSourcePrefix(run.runId)` (any attempt)
    and, when `from` is given, adds each of `from.manifest.partitions` under numbers from `max(o.next, diskNext(dir), highest n + 1)`
    upward with `source: runSource(run.runId, run.attempt)`, values normalised through `entryFrom`, the files copied
    (`copyFile` after `mkdir`). Totals and range are recomputed, `complete: true`, `updatedAt: now`; the manifest is
    validated with `parseAnyManifest(manifestForWrite(m))` and written with `writeRunReport`. `written` is the copied
    files plus the three shell files; `dropped` is the dropped partitions' file paths (all report-relative); `next` is one
    past the highest number used. Throws `OtelHtmlError('invalid-report')` when `dir` has no manifest.
  - `export const addRunReport = (deps, dir, fromDir: string, run, o) => replaceRunPartitions(deps, dir, { dir: fromDir, manifest: await readRunManifest(...) }, run, o)`
    (throws `invalid-report` when `fromDir` has no manifest) and
    `export const removeRun = (deps, dir, runId: number, o: { now: string }) => replaceRunPartitions(deps, dir, null, { runId, attempt: 0 }, { ...o, next: 0 })`.

- [ ] **Step 1: Write the failing tests** (`test/format/manifest.test.ts`: `SOURCE_RE` accepts `run:12345#2` and
  still rejects `foo:1`; `test/cli/ci/main-report.test.ts`, reports built with `createReportWith` in `site` format
  from `spansOnlyRequest(n)` of `test-support/format4-fixture.ts`):

```ts
test('runSource / sourceRun round-trip; sourceRun rejects other prefixes', ...)
test('ensureMainReport creates a complete format-8 site report with the config, then only patches what differs', ...)
// first call returns the three files; a second call with the same config returns []; a call with another config
// (title changed) returns ['data/manifest.js']; the manifest's config.dashboards equals the resolved config's
test('addRunReport copies the partitions in under run:<id>#<attempt>, renumbered from next, touching no other partition', ...)
// main holds run 1 (partition 0); adding run 2 with next 5 gives partition 5 with source run:2#1, run 1's entry byte-identical,
// totals = sum, range spans both, complete true, next 6; the copied file exists and equals the source bytes
test('a higher attempt replaces the earlier one: its partitions are dropped and listed, numbers never reused', ...)
// Review Focus 1 groundwork: add run 2 attempt 2 → source run:2#2, dropped lists partition 5's files, the file still exists
test('removeRun drops every partition of the run and nothing else', ...)
test('replaceRunPartitions throws invalid-report without a main manifest or a source manifest', ...)
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/main-report.test.ts test/format/manifest.test.ts` → FAIL.
- [ ] **Step 3: Implement** `main-report.ts`, the `SOURCE_RE` change (`/^(flush|compact|job|ci|merge|run):…/`), the
  exports in `run-report.ts`, and move `diskNext`.
- [ ] **Step 4: Run** the two files → PASS; `mise run check` → green.
- [ ] **Step 5: Commit** `feat(ci): run partitions added to and dropped from the one report by source`.

---

### Task 3: Trimming a run to its CI spans

**Files:**
- Create: `src/cli/ci/trim-run.ts`
- Create: `test-support/ci-run-fixture.ts`
- Test: `test/cli/ci/trim-run.test.ts` (new)

**Interfaces:**
- Consumes: `replaceRunPartitions`, `runSourcePrefix` (Task 2); `readColumns` (src/format/parquet/stream.ts),
  `TABLE_COLUMNS` (columns.ts), `spanFromRow`, `sharedFromRow`, `SharedInterner` (decode.ts);
  `createResolvedReport`, `sessionOf` (src/api/report.ts); `readRunManifest`.
- Produces:
  - `export const CI_SCOPE = 'otel-html-ci'` (trim-run.ts).
  - `export async function trimRun(deps: WriterDeps, dir: string, run: { runId: number; attempt: number }, config: ResolvedConfig, o: { now: string; next: number }): Promise<{ written: string[]; dropped: string[]; next: number }>`
    — for the partitions of `dir`'s manifest whose source starts with `runSourcePrefix(run.runId)`: opens a scratch
    report (`mkdtemp` under `tmpdir()`, `createResolvedReport({ out, replace: true }, config, deps)`), streams each
    `spans` file with `readColumns('spans', blob, path)` (blob from `fs.openBlob` when present, else
    `new Blob([bytes])`), turns each positional batch into named rows (`TABLE_COLUMNS.spans[i].name`), keeps the rows
    whose `scope_name` is `CI_SCOPE`, makes the two time columns relative to `epoch = BigInt(files.spans.timeMin)`,
    decodes with `spanFromRow(row, epoch, sharedOf)` (a `sharedFromRow` memo per batch as `widget-trace-rows.ts` has), interns
    resource and scope with one `SharedInterner` for the run and sets the refs on the span, and feeds each batch's rows
    through `sessionOf(report).addRecords({ signal: 'spans', rows, resources: interner.resources, scopes: interner.scopes, epoch })`.
    Logs and points are not read. After `report.close()`, the scratch manifest's partitions replace the run's through
    `replaceRunPartitions(deps, dir, { dir: scratch, manifest }, run, o)`; the scratch folder is removed in `finally`.
    A run with no partition returns `{ written: [], dropped: [], next: o.next }`.
  - `test-support/ci-run-fixture.ts`: `export async function writeCiRunReport(deps: WriterDeps, out: string, o: { repository: string; runId: number; attempt: number; branch?: string; startMs: number }): Promise<void>`
    — a `site` report (`createReportWith({ out, format: 'site', assetsBase: 'assets/' }, deps)`) holding, in trace
    `traceIdOf(runKey(o))`: a root span (`spanId: runSpanIdOf(key)`, no parent, scope `otel-html-ci`, resource
    `cicd.pipeline.run.id`, `cicd.pipeline.name: 'ci'`, `vcs.ref.head.name`, `cicd.pipeline.trigger: 'push'`,
    attributes `github.run_attempt: <attempt>`, `cicd.pipeline.result: 'success'`); a job span under it (scope
    `otel-html-ci`, attributes `cicd.pipeline.task.run.id: '7'`, `cicd.pipeline.task.name: 'check'`,
    `cicd.pipeline.task.run.result: 'success'`); a `queued` span under the job (attributes `cicd.pipeline.task.name`
    only); a test span under the job in scope `vitest`; a `mise.tasks`-scope span under the job with
    `mise.task.name: 'lint'`; one log record; one metric point (a gauge). All times from `startMs`.

- [ ] **Step 1: Write the failing tests** in `test/cli/ci/trim-run.test.ts` (main report: `ensureMainReport` then
  `addRunReport` of a `writeCiRunReport` output; `config` = `resolveApiConfig(deps, undefined, undefined, { format: 'site', assetsBase: '../../assets/' })`;
  a `cicdRows(path)` helper reading the file with `readColumns('cicd', …)` into named rows):

```ts
test('trimRun keeps exactly the otel-html-ci spans and writes no logs or points file', ...)
// the run's new partition: files.spans.rows === 3 (root, job, queued), files.logs and files.points undefined,
// files.cicd defined; the old partition's files are in dropped and still exist; written holds the new files
test("trimRun's cicd run and job rows equal the full partition's; the tasks row is gone", ...)
// compare the run and job rows (every column but span_id order) of old and new cicd files; new has no kind 'tasks'
test('trimRun numbers from next and leaves other runs untouched', ...)
test('trimRun of a run with no partition changes nothing', ...)
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/trim-run.test.ts` → FAIL.
- [ ] **Step 3: Implement** `trim-run.ts` and the fixture.
- [ ] **Step 4: Run** → PASS; `mise run check` → green (knip: the fixture is used by a test).
- [ ] **Step 5: Commit** `feat(ci): trim a run in the one report to its CI spans`.

---

### Task 4: The index model: detail, closed pull requests, tiers, landing links

**Files:**
- Modify: `src/cli/ci/site.ts` (types, schemas, `applyTiers`, `closePullRequest`, `reopenPullRequest`,
  `renderLanding`; nothing is removed here: `applyRetention`, `rollingInputs`, `removeChannel`, `renderRedirect` and
  `reportUrl` go with `site-main.ts` in Task 7)
- Create: `src/cli/ci/report-links.ts` (the window and branch-link half; Task 5 adds the rest)
- Modify: `src/cli/ci/site-io.ts:33` (`writeSite` takes the landing links)
- Test: `test/cli/ci/site.test.ts`, `test/cli/ci/report-links.test.ts` (new)

**Interfaces:**
- Produces, in `report-links.ts`:
  - `export const BRANCH_KEY = 'vcs.ref.head.name'` (the semantic-convention key; this is a CI module and may know it).
  - `export type Window = { start: bigint; end: bigint }` (unix nanoseconds).
  - `export function windowText(w: Window): string` → `<start>~<end>`.
  - `export function branchLink(base: string, dashboard: string, branch: string, window: Window | null): string` —
    `${base}#/dashboards/${dashboard}?` + `URLSearchParams` of (`t` = `windowText(window)` when given) and `d` = JSON
    of `{ vars: { [BRANCH_KEY]: branch } }`, `%7E` turned back into `~`.
  - `export function runsWindow(runs: readonly SiteRun[]): Window | null` — from the earliest `startedAt ?? completedAt`
    minus 1 hour to the latest `completedAt` plus 1 hour (`BigInt(Date.parse(iso)) * 1_000_000n`); `null` for no runs.
- Produces, in `site.ts`:
  - `SiteRun` gains `detail?: 'full' | 'slim'` and `reportUrl?: string`; `Channel` gains `closedAt?: string`;
    the zod schemas accept them (`exactOptional`).
  - `export type Detail = 'full' | 'slim'`.
  - `export interface Tiers { full: number; slim: number; prFull: number; prSlim: number }`.
  - `export interface TierChange { key: string; run: SiteRun }`.
  - `export function applyTiers(index: SiteIndex, tiers: Tiers, publishing?: ReadonlySet<number>): { index: SiteIndex; trim: TierChange[]; drop: TierChange[] }`
    — per channel and per workflow (`run.workflow`, undefined counting as one more), in the channel's order (newest
    completed first, as `placeRun` sorts): a branch channel's runs rank ≤ `full` are full, ≤ `slim` are slim, the rest
    drop; an open pull request's (no `closedAt`) rank ≤ `prFull` are full and the rest slim; a closed pull request's
    are all slim. Slim pull request runs of every channel then form one pool per workflow, newest first by
    `completedAt` then `runId`: rank > `prSlim` drops. A run in `publishing` is never dropped and keeps its current
    detail; it counts in its tally. A run whose `detail` is already `slim` stays slim whatever its rank. `trim` lists
    the runs whose `detail` was `full` or absent and is now slim; `drop` the removed runs. The returned index carries
    the new `detail` on every run (absent → `full` for full runs); a pull request channel left without runs leaves it.
  - `export function closePullRequest(index: SiteIndex, pr: number, now: string): { index: SiteIndex; changed: boolean }`
    — sets `closedAt: now` on `pr/<n>` (unchanged when absent or already closed);
    `export function reopenPullRequest(index: SiteIndex, pr: number): { index: SiteIndex; changed: boolean }` clears it.
  - `export interface LandingLinks { dashboard: string }`.
  - `renderLanding(index: SiteIndex, repository: string, links?: LandingLinks): string` — Branches as today (`<key>/`);
    the Pull requests section lists **open** pull request channels, each linking into the one branch report with the
    PR's head branch selected: `branchLink(\`${branchKey}/\`, links.dashboard, ch.headBranch, runsWindow(ch.runs))`.
    Without `links` the href is `<branchKey>/`; with no branch channel the section is omitted. The meta line keeps the
    run count.
  - `writeSite(dir: string, index: SiteIndex, repository: string, links?: LandingLinks): Promise<void>`.

- [ ] **Step 1: Write the failing tests** in `test/cli/ci/site.test.ts` and `test/cli/ci/report-links.test.ts`:

```ts
// report-links.test.ts
test('branchLink selects the branch, with and without a window', ...)
// decode `d` with parseDashboardParam (src/viewer/state/dashboard-state.ts) → ok, vars[BRANCH_KEY] is the branch; `t` is windowText
test('runsWindow spans the runs with an hour each side; null for none', ...)
// site.test.ts
test('applyTiers on a branch channel: full, then slim, then dropped, per workflow', ...)
// 6 ci runs + 2 load runs, tiers {full:2, slim:4, prFull:1, prSlim:10}: ci r1,r2 full; r3,r4 slim (in trim); r5,r6 in drop;
// load runs both full
test('applyTiers keeps a slim run slim when it ranks among the full', ...)
test('applyTiers: an open pull request keeps prFull full, the rest slim; a closed one is all slim', ...)
test('applyTiers: the pull request pool keeps prSlim slim runs per workflow across channels and removes emptied channels', ...)
// pr/1 (closed, 3 runs) and pr/2 (open, 2 runs), prFull 1, prSlim 2 → the newest 2 slim PR runs stay; pr/1 may vanish
test('applyTiers never drops the publishing run and leaves its detail', ...)
test('closePullRequest marks closedAt once; reopenPullRequest clears it; an unknown channel is unchanged', ...)
test('renderLanding links open pull requests into the branch report with their branch selected, and skips closed ones', ...)
// href contains `branch/main/#/dashboards/ci?` and `vcs.ref.head.name` and the PR's branch; a closed PR is absent
test('siteIndexSchema round-trips detail, reportUrl and closedAt, and still reads an index without them', ...)
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/site.test.ts test/cli/ci/report-links.test.ts` → FAIL.
- [ ] **Step 3: Implement** `report-links.ts` (its first half) and the `site.ts` additions. `site-main.ts` keeps
  calling `applyRetention` until Task 7 replaces it.
- [ ] **Step 4: Run** → PASS; `mise run check` → green.
- [ ] **Step 5: Commit** `feat(ci): index records each run's detail, closed pull requests and retention tiers`.

---

### Task 5: Links: the run link from `ci update run`, the branch link, `ci link`

**Files:**
- Modify: `src/cli/ci/report-links.ts` (Task 4 created it; add the run link, the config helpers and `dashboardIdOf`)
- Modify: `src/cli/ci/update.ts` (`UpdateJson.reportUrl?: string`, allowed for `run` only; schema `z.string().max(2048)`)
- Modify: `src/cli/ci/update-main.ts:266-347` (`runUpdateRun`: `--report-url` and `update.reportUrl` are the run link)
- Modify: `src/cli/ci/link.ts` (`previousRunOf` uses `reportUrl`; `channelPageOf` builds the branch link),
  `src/cli/ci/link-main.ts:103-110` (passes the one-report context)
- Test: `test/cli/ci/report-links.test.ts`, `test/cli/ci/update-main.test.ts:409-500`, `test/cli/ci/link.test.ts`,
  `test/cli/ci/update.test.ts` (reportUrl allowed on `run`, refused on `push`)

**Interfaces:**
- Consumes: `traceIdOf`, `runKey` (ids.ts); `branchLink`, `runsWindow`, `Window`, `windowText` (Task 4);
  `parseDashboardParam` (src/viewer/state/dashboard-state.ts) in tests only; `slug`.
- Produces, in `report-links.ts`:
  - `export function dashboardIds(config: ResolvedConfig): { dashboard: string; runsWidget: string | undefined }` —
    `config.viewer.defaultDashboard` and, in that dashboard, the id of the first widget with `type === 'cicd'` and
    `view === 'runs'` (ids are `w<i+1>` when the config gives none: `.github/otel-html-ci.yaml` yields `w8`).
  - `export function withBranchDefault(config: ResolvedConfig, branch: string): ResolvedConfig` — every dashboard's
    variable with key `BRANCH_KEY` gets `default: branch`; others untouched.
  - `export function runLink(base: string, ids: { dashboard: string; runsWidget: string | undefined }, run: { traceId: string; range: Window }): string`
    — `${base}#/dashboards/${dashboard}?` + `URLSearchParams` of `t` = `windowText` of `range.start − 7 days` to
    `range.end + 1 hour` and `d` = JSON of `{ sel: { trace }, run: { from: runsWidget, mode: 'panel' } }` (`run` omitted
    when `runsWidget` is undefined), `%7E` turned back into `~`.
  - `export function dashboardIdOf(url: string): string | undefined` — the `<id>` of `#/dashboards/<id>` in `url`.
- Produces, in `update-main.ts`: `runUpdateRun` reads the merged report's manifest (`readRunManifest`) for its `range`
  (a null range → the API run's `run_started_at ?? created_at` to `updated_at`), builds
  `runLink(\`${baseUrl}/branch/${slug(defaultBranch)}/\`, dashboardIds(resolved), { traceId: traceIdOf(runKey({ repository, runId: run.id, runAttempt: run.run_attempt })), range })`
  with `resolved = await resolveApiConfig(deps, o.config, undefined)`, writes it as `update.reportUrl` and the
  `report-url` output. Output `channel` stays `placed.key`.
- Produces, in `link.ts`:
  - `previousRunOf` returns `url: prev.reportUrl ?? \`${baseUrl}/${prev.reportPath}/\``.
  - `export type OneReport = { reportPath: string; dashboard: string }`.
  - `channelPageOf(key: string, channel: Omit<Channel, 'runs'>, baseUrl: string, one: OneReport | undefined, window: Window | null): ChannelPage | undefined`
    — a branch channel: `${baseUrl}/${key}/`; a pull request with `one`:
    `branchLink(\`${baseUrl}/${one.reportPath}/\`, one.dashboard, channel.headBranch, window)`; without `one`, the
    legacy `${baseUrl}/${key}/`.
- Produces, in `link-main.ts`: `one = { reportPath: \`branch/${slug(defaultBranch)}\`, dashboard }` when
  `dashboardIdOf(opts.url)` is defined; `window = runsWindow(index.channels[placed.key]?.runs ?? [])` when the index was
  read, else `null`.

- [ ] **Step 1: Write the failing tests**:

```ts
// report-links.test.ts
test('dashboardIds of .github/otel-html-ci.yaml is ci / w8; of the built-in config the runs widget is undefined', ...)
test('withBranchDefault sets the branch variable default and nothing else', ...)
test('runLink opens the run: window start-7d to end+1h, the trace selected, the run pane from the runs widget', ...)
// decode `d` with parseDashboardParam → ok, sel.trace equals the id, run = {from:'w8', mode:'panel'}; `t` text as expected;
// without a runs widget `d` has no run
test('dashboardIdOf reads the id from a run link and is undefined for a plain report url', ...)
// update-main.test.ts (runUpdateRun)
test('report-url and update.reportUrl open the run in branch/main with the CI dashboard config', ...)
// with config `.github/otel-html-ci.yaml`: starts with `https://x/branch/main/#/dashboards/ci?t=`, contains `w8`; the update.json reportUrl equals it
// link.test.ts
test('previousRunOf prefers the indexed reportUrl', ...)
test('channelPageOf: a pull request links the one report with its branch selected and the runs window; without the one report, the legacy page', ...)
// update.test.ts
test('reportUrl is allowed in a run update and refused in a push update', ...)
```

- [ ] **Step 2: Run** the four files → FAIL.
- [ ] **Step 3: Implement** as specified (the `README` row for `ci link` and `ci update run` is Task 8's).
- [ ] **Step 4: Run** → PASS; `mise run check` → green.
- [ ] **Step 5: Commit** `feat(ci): run and branch links into the one report`.

---

### Task 6: Migrating today's site

**Files:**
- Create: `src/cli/ci/site-migrate.ts`
- Test: `test/cli/ci/site-migrate.test.ts` (new)

**Interfaces:**
- Consumes: `readRunManifest`, `writeRunReport`; `readColumns('cicd', …)`, `TABLE_COLUMNS.cicd`; `runSource`
  (Task 2); `IN_PROGRESS`, `SiteIndex` (site.ts).
- Produces:
  - `export async function migrateToOneReport(o: { site: string; index: SiteIndex; reportPath: string; deps: WriterDeps; warn: (m: string) => void; remove: (site: string, paths: string[]) => Promise<void> }): Promise<{ index: SiteIndex; changed: boolean }>`
    1. The manifest at `<site>/<reportPath>` (none → skip this step): for each partition whose `source` starts with
       `merge:`, read its `files.cicd` file and take the first row with `kind === 'run'`: `run_id` (text → number) and
       `attempt` (null → the index entry's attempt). When some channel's run has that `runId`, the source becomes
       `runSource(runId, attempt)`; otherwise (no cicd file, no run row, or unindexed) the partition is dropped and its
       files go through `o.remove`, with `warn` (Review Focus 5). Rewrite the manifest (`totalsAndRange`, `updatedAt`
       unchanged) when anything changed.
    2. Every run of every channel: `reportPath` set to `o.reportPath` and `detail` to `'full'` when absent.
    3. Folders: every directory under `<site>/pr/` and every directory under `<site>/<branch key>/runs/` for each branch
       channel, except a `runs/<id>` folder whose indexed run is `IN_PROGRESS` (a push staging area, §5.8), goes through
       `o.remove`.
    `changed` is true when any of the three did something. Idempotent.

- [ ] **Step 1: Write the failing tests** (a site built with `writeCiRunReport` reports merged by `mergeResolved`
  into `branch/main` as the rolling merge did — `mergeWithConfig(deps, undefined, { format: 'site', assetsBase: '../../assets/', compact: true })([a, b], out, false)`
  — so its partitions carry `merge:` sources and `cicd` files; a legacy index with `reportPath: 'branch/main/runs/<id>'`
  and folders `branch/main/runs/1/`, `pr/362/`):

```ts
test('merge: partitions are renamed to run:<id>#<attempt> by their cicd run row; runs get detail full and the one reportPath', ...)
test('a merge: partition with no cicd run row, or naming an unindexed run, is dropped through remove with a warning', ...)
test('run folders and pr folders go through remove; an in-progress staging folder stays', ...)
test('a second call changes nothing', ...)
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/site-migrate.test.ts` → FAIL.
- [ ] **Step 3: Implement** `site-migrate.ts`.
- [ ] **Step 4: Run** → PASS; `mise run check` → green.
- [ ] **Step 5: Commit** `feat(ci): migrate the rolling report and the index to the one report`.

---

### Task 7: The deployer applies runs, tiers, close and reopen to the one report

**Files:**
- Modify: `src/cli/ci/deploy-apply.ts` (options; steps 3.5, 4, 6, 6b, 8), `src/cli/ci/deploy-main.ts:30-45`,
  `src/cli/commands/ci.ts:416-443` (flags), `src/cli/ci/deploy-plan.ts:93-102` (`PendingPlan.defaultBranch?: string`,
  set by `planDeploy` from its `defaultBranchOf()`)
- Delete: `src/cli/ci/site-main.ts`, `test/cli/ci/site-main.test.ts`; remove `placeRunReport`, `copyReport`,
  `folderNames`, `finishRunReport` from `site-io.ts`; remove `applyRetention`, `rollingInputs`, `removeChannel`,
  `renderRedirect`, `reportUrl` and their tests from `site.ts`/`site.test.ts`; `mergeSkippingBad`/`mergeWithConfig`
  stay (report-main.ts uses them); drop `test/cli/ci/publish-e2e.test.ts:95` (the rolling-merge case) if it depends on
  `placeFinishedRun`.
- Modify (approved by the maintainer, see Global Constraints): `.github/actions/otel-html-deploy/action.yml:29-31`
  (`pr-retention` default `"3"`, description "Runs kept in full per workflow for each open pull request").
- Test: `test/cli/ci/deploy-apply.test.ts` (`run`, `pull requests`, `removed runs`, `the pass` describes), `test/cli/ci/deploy-plan.test.ts` (defaultBranch in the plan)

**Interfaces:**
- Consumes: Tasks 1–6.
- `ApplyOptions` gains `slimRetention: number; prSlimRetention: number`; `DeployApplyOptions` likewise; the CLI adds
  `--slim-retention <n>` (default `'100'`, "runs kept per workflow in the branch report, full or slim") and
  `--pr-slim-retention <n>` (default `'100'`, "slim pull request runs kept per workflow across all pull requests");
  `--pr-retention` default becomes `'3'` with the help "runs kept in full per workflow for each open pull request".
- `mainReportPath(pending: PendingPlan, trust: ApplyOptions['trust'], index: SiteIndex): string` (module-private):
  `branch/${slug(pending.defaultBranch)}` when set; else `trust.channel` when it starts with `branch/`; else the index's
  only branch channel key; else `branch/main`.
- The pass, in order:
  - (3.5) after the index is read: `resolved = withBranchDefault(await resolveApiConfig(deps, o.config, undefined, { format: 'site', assetsBase: assetsBaseFor(mainPath) }), branch)`
    with `branch = pending.defaultBranch ?? mainPath.slice('branch/'.length)`; `links = { dashboard: dashboardIds(resolved).dashboard }`;
    `migrateAssetsBases(o.site, deps, warn)`; `migrateToOneReport({ site, index, reportPath: mainPath, deps, warn, remove: scheduleRemoval })`
    → `index`, `changed ||= …`. Every `commitIndex` passes `links`.
  - (4) `remove-pr`: `state.removed.prs[...]` as today, then `index = closePullRequest(index, pr, o.now).index`; a legacy
    `pr/<n>` folder still on disk goes through `scheduleRemoval`. `reopen-pr`: `delete state.removed.prs[...]`, then
    `reopenPullRequest`. Commit the index after each.
  - (5) push: unchanged but the staging folder's base is `assetsBaseFor(reportPath)`.
  - (6) run, by time: `removed-pr` and `superseded` checks as today (the staging path is still
    `<channel>/runs/<id>`, the state key for attempts). Then: `mainDir = join(site, ...mainPath.split('/'))`;
    `written = await ensureMainReport(deps, mainDir, resolved, { now, assetsBase: assetsBaseFor(mainPath) })`;
    `next = max(state.runs.runs[mainPath]?.next ?? 0, …)` kept by `replaceRunPartitions`;
    `added = await addRunReport(deps, mainDir, \`${c.dir}/report\`, { runId, attempt: c.u.runAttempt }, { now, next })`;
    `scheduleDeletion(added.dropped as site paths)`; `scheduleRemoval(site, [stagingPath])` when that folder exists;
    `unschedule(written ∪ added.written)`; `state.runs.runs[mainPath] = { next: added.next, attempt: 0, jobs: {} }`;
    `index = placeRun(index, c.channel.key, c.channel.channel, { ...c.run, reportPath: mainPath, detail: 'full', ...(c.u.reportUrl === undefined ? {} : { reportUrl: c.u.reportUrl }) })`;
    `published.add(runId)`; `mainChanged = true`; record `applied`. A failure before the manifest write restores
    `state.deletions.files` and `state.runs` as today's step 6 does, and records `rejected`.
  - (6b) tiers, every pass: `tiers = applyTiers(index, { full: o.retention, slim: o.slimRetention, prFull: o.prRetention, prSlim: o.prSlimRetention }, published)`;
    for each `drop`: `removeRun(deps, mainDir, runId, { now })` → schedule `dropped`; for each `trim`:
    `trimRun(deps, mainDir, { runId, attempt }, resolved, { now, next })` → schedule `dropped`, unschedule `written`,
    keep `next`; an `OtelHtmlError` from `trimRun` is a `warn` and that run's entry keeps `detail: 'full'` (Review
    Focus 2). `index = tiers.index` (patched), `commitIndex()`; `mainChanged ||= trim or drop did anything`.
  - After (6b): `writeBadges(site, mainPath, index.channels[mainPath])` when that channel exists; `previews.push(mainPath)`
    when `mainChanged`; `changed ||= mainChanged`.
  - (7) due deletions: unchanged.
  - (8) `if (changed) await ensureSharedAssets(o.site, deps)`; then `scheduleDeletion(state, site, await pruneAssets(site, deps, warn), passRunId)`.
    Record as today.
- `deploy-plan.ts`: `PendingPlan.defaultBranch` set from the repository's default branch the plan already fetches.

- [ ] **Step 1: Write the failing tests** in `test/cli/ci/deploy-apply.test.ts` (keep the push and pass describes;
  rewrite `run`, `pull requests`, `removed runs`; run reports from `writeCiRunReport`; `ApplyOptions` get
  `slimRetention`/`prSlimRetention`; `pending.defaultBranch: 'main'`):

```ts
describe('run', () => {
  test('a run update adds its partitions to branch/main under run:<id>#<attempt>, indexes it full with its reportUrl, and previews main', ...)
  // index.channels['branch/main'].runs[0] = {reportPath:'branch/main', detail:'full', reportUrl:<from update.json>}; the main manifest
  // has a partition with that source; no branch/main/runs/<id>/ folder is created; previews = ['branch/main']; badge-ci.json written
  test('a pull request run goes into the same report under its pr channel', ...)   // index pr/5 entry, reportPath 'branch/main'
  test('a re-run replaces the earlier attempt: its partitions are scheduled, numbers go up', ...)
  test('a re-run of a run already slim comes back full and its slim partition is scheduled', ...)   // Review Focus 1
  test('tiers: the 31st main run of a workflow is trimmed (spans only), the 101st is dropped; the index says so', ...)
  // small numbers: retention 1, slimRetention 2; three runs → newest full, middle slim (its partition's files.logs undefined), oldest gone
  test('a trimming failure warns, keeps the run full and the pass goes on', ...)   // Review Focus 2: corrupt the spans file bytes
  test('a staging folder of the run (push updates) is scheduled when the run update applies', ...)
  test('a run update older than the indexed attempt is superseded', ...)
});
describe('pull requests', () => {
  test('remove-pr marks the channel closed; the next pass trims its runs; a push or run for it is removed-pr until reopen-pr', ...)
  test('reopen-pr clears closedAt; a new run arrives full while the old ones stay slim', ...)
  test('the pool drops the oldest slim pull request runs across channels and removes an emptied channel', ...)
});
describe('migration', () => {
  test('the first pass renames merge: partitions, schedules the run and pr folders and migrates the assets base', ...)
  // a site in today's layout: branch/main rolling (merge: sources, base ../../assets/9.9.9/), branch/main/runs/1/, pr/362/
});
test("the one report's manifest config carries the branch variable default and the deployer's version", ...)
// after a pass with .github/otel-html-ci.yaml as --config: dashboards[0].dashboard.variables[BRANCH_KEY].default === 'main';
// otelHtmlVersion === deps.version; a second pass with the same config rewrites nothing (files.json sizes equal)
test('planDeploy records the default branch in pending.json', ...)   // deploy-plan.test.ts
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/deploy-apply.test.ts test/cli/ci/deploy-plan.test.ts` → FAIL.
- [ ] **Step 3: Implement** the pass as specified; delete `site-main.ts` and its test; adjust `site-io.ts`; the CLI
  flags; `deploy-plan.ts`; `action.yml` only per the recorded decision.
- [ ] **Step 4: Run** `pnpm exec vitest run test/cli/ci` → PASS; `mise run check` → green (knip clean: no dead exports left in `site-io.ts`, `site.ts`, `run-report.ts`).
- [ ] **Step 5: Commit** `feat(ci): the deployer keeps one report with full and slim runs`.

---

### Task 8: README, verification, PR

**Files:**
- Modify: `README.md:488-558` ("This repo's CI": the layout list, the retention paragraph, the rolling-report paragraph,
  the `ci link` paragraph, the subcommand table rows for `ci link`, `ci update run`, `ci update remove-pr`,
  `ci deploy apply`), `README.md:416-421` (the dashboard opens on `main`: the deployer sets the branch default)
- Modify: `docs/superpowers/plans/2026-11-19-slim-history-shared-assets.md` (status, measurements)

- [ ] **Step 1: Rewrite the README's site layout** as the spec has it: `/assets/` flat (one copy of each viewer and
  engine file, pruned per file, deferred); `/branch/<name>/` the one report holding main's and every pull request's runs,
  no `runs/<id>/` and no `/pr/<n>/`; full vs slim and the four retention numbers; a closed pull request's runs stay
  slim; "This run's report" opens the run in the report; the pull request comment's "All runs on pull request #n"
  selects its branch; the dashboard opens on `main`. Remove the format-3 size estimate paragraph and the rolling-report
  paragraph. Update the `ci deploy apply` flags row (`--retention` 30, `--pr-retention` 3, `--slim-retention` 100,
  `--pr-slim-retention` 100), the `ci update run` outputs (`report-url` is the run link) and `ci link`'s description.
- [ ] **Step 2: `mise run gen:check`** (the README's generated Development section is untouched) and
  `pnpm exec biome check .`.
- [ ] **Step 3: `timeout 900 mise run verify`** → green. Paste the tail of its output into the PR body's checks line.
- [ ] **Step 4: Commit** `docs: the site keeps one CI report with slim history on one assets folder`.
- [ ] **Step 5: Branch review** (Opus 5.5) over the whole diff with the spec and this plan; fix blocking findings on the
  branch and re-review.
- [ ] **Step 6: Open the PR** (`gh pr create`) with the title in the table and a body carrying: what changed per spec
  section; the decisions recorded during execution; **Also**; the before measurements (live `files.json` total
  755.3 MB on 2026-11-19, `site / deploy` 129–265 s); the placeholders for the after measurements (filled by Task 9);
  the verify output line; the session trailer.
- [ ] **Step 7: Merge** on green CI (`gh pr merge <n> --squash --delete-branch`), per the unattended process (a
  CodeRabbit rate limit is not a reason to wait).

---

### Task 9: After the first live passes

- [ ] **Step 1:** Watch the first `site / deploy` pass after the merge (`gh run list --workflow ci.yml`,
  `gh run view <id> --log` for the `deploy` job): the migration log lines, duration, no `::error::`. A failed pass is a
  stop (report what the log says).
- [ ] **Step 2:** Verify live: `https://bjstabi.github.io/otel-html/branch/main/` opens on `main`; `index.json` runs
  carry `reportPath: "branch/main"` and `detail`; `site-state/files.json` total (sum of sizes) and count; no
  `assets/<version>/` folder referenced; after 15 minutes and the next pass, the old folders gone.
- [ ] **Step 3:** After the first pull request run publishes (open a trivial PR if none is in flight): the "pull
  requests" quick filter shows its run; the PR comment's "Report:" link opens the run pane; "All runs on pull request"
  selects the branch.
- [ ] **Step 4:** Measure the dashboard with `mise run measure:live -- --out <scratch>/live` (request count and settled
  time, default window) and, by hand in a browser, the `all` window's requests and load time; compare with the
  2026-11-18 record (63 requests, 1.32 s). If the `all` window is markedly slower, open an issue for the optional 7-day
  compaction of slim partitions (spec §5.9) rather than extending this PR.
- [ ] **Step 5:** Record in the PR body and in this plan's status: `files.json` total before and after, a slim run's
  bytes, the `site / deploy` duration of the first three passes, the dashboard numbers. A deploy pass over 8 minutes or
  a total above 500 MB is a stop.
- [ ] **Step 6:** Post the unattended process's summary in the session.
