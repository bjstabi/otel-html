# One CI report with full and slim runs, and one shared assets folder — design

Date: 2026-11-19. Status: draft for the maintainer's approval. Process: unattended
(`docs/agents/process-unattended.md`), one PR.

## 1. Intent

The CI dashboard should answer "how is CI doing" for the whole repository, pushes to main and the pull requests that
feed it, over a longer history than today's 30 runs, from **one report**. Today the site splits a run's data three
ways: its own folder (`<channel>/runs/<id>/`), its channel's rolling report (`branch/main/`, `pr/<n>/`) and, for
pull requests, a folder that is deleted when the PR closes. The main dashboard holds only pushes and nightly runs
(0 `pull_request` run rows live, 28 `push`, 16 `schedule`), so its "pull requests" quick filter has nothing to match,
and every pass rebuilds the rolling report by merging all retained run reports again. Separately, `assets/` spends 294
of the site's 755 MB on six copies of the same 38.9 MB DuckDB 1.32.0 engine.

Two changes, one PR:

- **A. One shared assets folder.** Every report loads its viewer and engine files from the single flat `assets/`
  folder; files are pruned one by one when nothing references them. About 210 MB saved today.
- **B. One report, two levels of detail.** The site keeps one CI report at `branch/main/` that holds every finished
  run of main and of every pull request, open or closed. A run is **full** while recent (or while its PR is open and
  it is among the PR's newest few), **slim** (its CI spans and `cicd` rows only) for a long history, then removed.
  Finished runs no longer get a folder of their own and pull requests no longer get a report of their own; a run
  update's partitions are added to the one report, and tiers are applied by rewriting the partitions they touch.

## 2. Goals, non-goals, anti-goals

Goals

- The main dashboard shows pull request runs: in full (test spans, logs, metrics) while the PR is open, as CI-span
  history after it closes, merged or not.
- History: 100 runs per workflow of main (the newest 30 full, the rest slim) and the newest 100 pull request runs per
  workflow across all PRs (slim once their PR closes or they leave the PR's full tier).
- One copy of every run's data on the site, and one copy of every viewer and engine file.
- A deploy pass adds the new run's partitions instead of re-merging every retained report.
- The dashboard opens on main only; `pull requests` and `all` are one click away.
- No change to the report format, the public API, user-facing CLI commands, or any workflow or action file.

Non-goals

- Changing what the widgets compute (the Jobs table's three-point minimum stays).
- Branch channels other than the default branch (none exist).
- The `local` run artifact (`ci-run-report`) stays as it is.
- Live viewing of a running job through push updates (`push-every`), which this repository's workflows do not use.
  The machinery stays (§5.8); it is not extended.

Anti-goals

- A live page that stops opening because an asset or partition it names was deleted too early.
- A deploy pass that fails or grows markedly: the `site / deploy` job stays under 8 minutes (today 2 to 4.5 minutes,
  of which the Pages upload and two screenshots are fixed costs).
- A pull request's run history lost on close (today's behaviour).
- A dashboard that gets slower because the one report has many more small partitions (§5.9).

## 3. Constraints

- GitHub Pages: 1 GiB, 100,000 files. Budget after this change: about 360 MB (§6).
- The deployer (`site / deploy`) runs the default branch's code on every trusted run, with the write token. The files
  this spec changes live under `src/cli/ci/`, `src/writer/` and `src/format/`. `site.yml`, `pr-cleanup.yml`, `ci.yml`
  and the actions under `.github/actions/` are **not** changed; new deployer options get code defaults.
- The Pages CDN may serve an `index.html` or `manifest.js` up to ten minutes old. Anything a stale page may still
  name goes through the deferred deletion (D66, 15 minutes), never an immediate removal.
- The one report is a normal `site` report; the viewer does not change.

## 4. Part A: one shared assets folder

### 4.1 Layout

`<site>/assets/` is flat. It holds every viewer file of every version in use (`viewer.<hash>.js`,
`viewer.<hash>.css`) and every engine file of every DuckDB version in use (`duckdb.<v>.wasm`,
`duckdb.<v>.worker.js`, `parquet.<v>.duckdb_extension.wasm`, `json.<v>.duckdb_extension.wasm`). Every name is unique
to its content by construction (content hash, or pinned engine version), so versions never collide: two otel-html
versions with the same engine share one copy, and a viewer hash present in two versions is the same bytes.

The report's `engine.assetsBase` and page URLs point there: `../../assets/` for the report at `branch/main/`.
`ASSETS_BASE_RE` already accepts it. The version segment disappears from the deployer's base helpers.

### 4.2 Writing

`ensureSharedAssets(site)` writes into `assets/` the files of this build that are missing there, each to a temporary
name then renamed into place. It never rewrites an existing file and no longer creates version folders.

### 4.3 Pruning, per file

`pruneAssets` computes the referenced set over every report on the site (the one report, plus any in-progress run
folder of §5.8): the viewer files its `index.html` names under its base (one script, one stylesheet), and, when its
base is the shared folder, the engine files `engineAssetNames('site')` of its manifest's `engine.version`. Every file
under `assets/` (any depth) that is not referenced, and every version folder left empty, is **scheduled for
deletion** (D66), not removed at once. A report that cannot be read keeps everything, as today.

### 4.4 Migration of the reports already on the site

Idempotent, run on every pass before pruning, for each report whose base matches `^(\.\./)*assets/<version>/$`:
copy the files it references from `assets/<version>/` into `assets/` if absent, then rewrite its base: the page by
replacing the old base text in its asset URLs (it keeps its viewer files and version), the manifest by rewriting the
JSON text's `engine.assetsBase` and nothing else (a format-5 manifest must not be bumped to 8 under its old viewer).
After §5's migration only `branch/main/` remains to migrate, but the rule covers whatever folders exist in the pass.

### 4.5 What does not change

`convert`, `merge` and `upgrade` outside the deployer keep writing a report's own `assets/`. The viewer already
resolves engine files as `assetsBase + name`.

## 5. Part B: one report, two levels of detail

### 5.1 The report

`branch/main/` is the only finished-run report on the site: one `site`-format report whose partitions hold every
retained run of main and of every pull request, **one partition per run** (a finished run's report is already
compacted to one partition by `ci update run`, and today's rolling merge keeps each input's partition as it is: the
live report has 35 `merge:` partitions for its runs, seven of them on one day). The deployer owns the manifest: a run
is the partition(s) whose `source` names it, `run:<run id>#<attempt>` (within `SOURCE_RE`), so adding, slimming and
removing a run are operations on its own partition(s) and never touch another run's rows.

The index (`index.json`) still records every run (id, attempt, workflow, conclusion, start, sha, branch, channel
key) and now its level, `detail: 'full' | 'slim'`, and its link (§5.7); `reportPath` is `branch/main` for every
finished run. Channels remain as groupings of runs in the index (`branch/main`, `pr/<n>` with `closedAt` once
closed); they have no folder.

### 5.2 Full and slim

A **full** run is what `site / report` published: CI spans, job logs, queue and duration metrics, and the jobs' test
spans and logs. A **slim** run keeps only its spans of scope `otel-html-ci` (the workflow root, the jobs, their
`queued` spans and steps): no logs, no metric points, no `mise.tasks` or test spans. Its `cicd` run and job rows are
the same as the full run's; it has no `tasks` row, so the Cache tile counts only runs that have one (already how
`cached: null` is treated). A slim run is a few hundred spans.

### 5.3 Retention tiers

Per workflow, newest first by start:

| runs of                | full                                  | slim                                               | removed      |
| ---------------------- | ------------------------------------- | -------------------------------------------------- | ------------ |
| main (`branch/main`)   | newest 30                             | the next, up to 100 in all                          | the rest     |
| an open pull request   | its newest 3                          | its older ones, counted in the pull request pool    | by the pool  |
| a closed pull request  | none                                  | all of its runs, counted in the pool                | by the pool  |

The **pull request pool** is every slim PR run across all PR channels, newest 100 per workflow by start. A PR channel
left with no runs leaves the index. The run being published is kept whatever its rank (today's rule). Numbers:
`--retention` 30 and `--pr-retention` 3 (today 10; the one that changes) and two new options with code defaults,
`--slim-retention` 100 and `--pr-slim-retention` 100.

### 5.4 Adding a run

A `run` update carries the finished run's report. The deployer copies its partition files into the one report under
the report's next numbers and adds their manifest entries with `source: run:<id>#<attempt>`, normalising statistics
values to the report's keys, as `planSync`/`entryFrom` already do for push updates. No writer session is opened on
the one report: `openPartitionSession` in append mode prunes every partition folder the manifest does not list before
its first write, which would defeat the deferred deletion. Totals and range are recomputed; `complete` stays true.

A **re-run** (a higher attempt of a run id already in the index) replaces the run, as the run folder was replaced
today: the earlier attempt's partitions are dropped (deferred) and the new attempt's added, and the index entry keeps
the latest attempt. The Reruns tile keeps counting attempts from the `cicd` rows' `attempt` as it does now.

The index gets the run at `detail: 'full'`; tiers are then applied (§5.5).

### 5.5 Applying tiers: trimming partitions

After each pass's additions and index changes, the deployer computes every run's tier (§5.3) and compares it with the
index's `detail`.

- A run that becomes **slim** has its partition(s) **trimmed**: the spans file is streamed (`readColumns`), its rows
  decoded (`spanFromRow` with `sharedFromRow`, with the positional-to-named and absolute-to-relative conversion
  `widget-trace-rows.ts` shows) and only the spans of scope `otel-html-ci` fed through `addRecords` into a scratch
  `site` report created with the CI config; the scratch report's one partition is copied in under a new number with
  the run's `source`, and the old partition's files go to the deferred deletion. Logs and points are not copied. The
  writer derives the slim partition's `cicd`, trace share, rollups, patterns and widget index as for any input.
- A run that is **removed** has its partition(s) dropped from the manifest, their files deferred.

The index's `detail` is updated last. A pass normally trims one or two runs (the 31st main run, a closed PR's runs);
a quiet pass trims none. Trimming reads one run's spans (7 to 18 MB) and writes a few hundred spans.

### 5.6 A pull request closes or reopens

Update kinds, names and `pr-cleanup.yml` do not change. `remove-pr` now marks the channel `closedAt` and lets §5.5
slim its runs; `reopen-pr` clears `closedAt` (slim runs stay slim, new runs arrive full). A run update or push for a
closed PR is still rejected as `removed-pr` (D8). The landing page lists the one report and the open pull requests as
links into it with that PR's head branch selected (§5.7).

### 5.7 Links, badges, previews, default filter

- "This run's report" **opens the run** in the one report: the dashboard URL with the page window around the run,
  the run's trace selected (`traceIdOf(runKey)`, deterministic from repository, run id and attempt) and the run pane
  open from the Runs widget (`d.sel.trace`, `d.run.from`, `d.run.mode`, `d.sel.t` of the dashboard state). The
  widget id comes from the config, which `ci update run` has and `ci link` does not, so `ci update run` builds the
  URL, writes it to `report-url` as today (the publish action already hands that to `ci link --url`) and into
  `update.json`; the deployer records it on the index entry (`SiteRun.reportUrl`) so `ci link` can link the previous
  run from the index alone. "All runs on pull request #n" links the report with `vcs.ref.head.name` set to the
  PR's head branch and the window spanning the PR's indexed runs. A run outside the default 7-day window is reached
  through the URL's own window.
- Badges per workflow for `branch/main` are written as today from the index's newest main run.
- The preview screenshots are of the one report, which opens with its branch selected: the deployer passes the writer
  a variable default `vcs.ref.head.name = main` for the dashboard config (`dashboards[].variables[].default`), so the
  `main` quick filter renders pressed. `.github/otel-html-ci.yaml` does not change.

### 5.8 In-progress runs (push updates)

Push updates (`push-every`, unused by this repository's workflows) keep placing partitions into
`<channel>/runs/<id>/` as today, so a running job can be viewed live. That folder is a staging area only: when the
run's `run` update is applied, the folder is removed (deferred) and the finished report is added to the one report.
Such a folder is a report for §4.3's purposes while it exists.

### 5.9 Partition count

The one report at steady state holds about 230 partitions (100 main, 100 PR, the load runs), against 35 today, of
which about 50 are full and the rest slim and small. Partitions are per run today too, so the dashboard's default
window (7 days) prunes by partition time range to the same files it reads now; a 30-day or all window reads more,
mostly tiny, files. The PR measures the dashboard's request count and load time for the default and the all window
before and after. If the all window is markedly slower, the builder may compact runs of slim partitions into 7-day
groups during trimming (they are tiny, so one file a week is cheap); this is optional.

### 5.10 Migration of today's site

The current `branch/main/` rolling report already is the merge of every retained main run, one `merge:` partition
each, so it becomes the one report as it stands (its base rewritten by §4.4). On the first pass the deployer maps
each `merge:` partition to its run by the run row in its `cicd` file (a partition whose run is not indexed is
dropped), renames the `source` to `run:<id>#<attempt>`, marks every indexed main run `detail: 'full'`, rewrites
`reportPath` to `branch/main`, schedules the `branch/main/runs/<id>/` folders (and `pr/362/`, already pending) for
deletion, and applies §5.5 (nothing to slim today: 30 ci and 16 load runs are retained).

### 5.11 Deployer cost

A pass copies one run's partition files and edits the manifest, and trims at most a few runs, each a stream of one
run's spans into a few hundred. No pass merges the whole history again. The target in §2 holds with room.

## 6. Size budget

Today: 755 MB (per-run 239, rolling 194, assets 294, pr/362 29). After, at today's run sizes and the tiers' maxima:

| area                                                     | MB     |
| -------------------------------------------------------- | ------ |
| 30 full main ci runs (7.3 MB median) and the load runs   | ~225   |
| open PRs: 3 full runs each at ~16 MB, 3 open             | ~145   |
| 70 slim main and 100 slim PR runs, a few hundred KB each | ~20    |
| assets: one engine, the referenced viewers               | ~83    |
| in flight: one run update's partition files              | ~20    |
| total                                                    | ~495 worst case, ~360 typical (one open PR) |

The PR body carries the live `site-state/files.json` total before and after the first pass, a slim run's bytes, the
`site / deploy` duration of the first three passes, and the dashboard's request count and load time for the default
and the all window.

## 7. Decisions

Maintainer's (2026-11-19):

- Process unattended; the fewest PRs: one.
- One report, no separate per-run or per-PR reports, with the limits kept: main 30 full and 100 in all, PRs 100 slim,
  full while open.
- Pull requests closed without merging are kept like merged ones.
- The dashboard opens on main only.

Mine (overridable):

- D1 An open PR keeps its newest 3 runs per workflow full (today's folder retention was 10). A full PR run is about
  16 MB; with one copy on the site, 3 bounds a busy PR to ~50 MB. Raising it is one option value.
- D2 Tiers are applied by trimming partitions in place, derived by the deployer, so the runs already on the site get
  the long history too and the run update is unchanged.
- D3 A run is its own partition(s), named by `source`; no row-level key is needed (the `cicd.pipeline.run.id`
  resource attribute is on 0.4% of a run's spans, since the test SDK ignores `OTEL_RESOURCE_ATTRIBUTES`). Slim keeps
  scope `otel-html-ci` only.
- D4 One flat `assets/` folder rather than an engine folder beside per-version viewer folders: no manifest field, no
  viewer change, old viewer files prune away by themselves.
- D5 Migration rewrites a report's base only, never its viewer version.
- D6 Pruned assets and replaced partitions go through the deferred deletion.
- D7 The default branch filter is injected by the deployer, not written into the config file.
- D8 Late updates for a closed PR stay rejected.
- D9 Retention counts per workflow; the PR pool is per workflow across all PRs.
- D10 `runs/<id>/` folders remain only as staging for in-progress push updates.

## 8. Left to the builder

- Where tier application lives in `applyUpdates` (after additions and PR updates, before the rebuild of badges, the
  landing page and pruning) and the shape of the three-set retention result.
- How the manifest edits (add, drop, rename `source`) are factored with `planSync`/`entryFrom` and
  `writeRunReport`, which do the same for push updates.
- How `createReportWith` takes the variable default for the one report's dashboard config, and how the one report's
  `index.html` and manifest config are refreshed when the deployer's version changes (today the rolling rebuild
  rewrites them each pass; now only the manifest is edited, so the page's viewer version is refreshed when the
  deployer's differs from the manifest's).
- The exact dashboard URL for an open run and for a PR's branch, and where `ci update run` reads the Runs widget id.
- Test fixtures: a small run report with CI spans plus test spans, logs and points under one run id, and a second
  run id, to trim in a unit test.

## 9. Verification the PR must carry

- Unit: tiers (main, open PR, closed PR, pool, the publishing run's exemption); trimming keeps exactly the
  `otel-html-ci` spans and yields the same `cicd` run and job rows as the full partition; a removed run's and a
  re-run's earlier attempt's partitions are dropped; adding a run touches no other partition; the migration maps
  `merge:` partitions to indexed runs; per-file
  pruning keeps referenced files and schedules the rest; migration rewrites a versioned base once and is a no-op
  after; `remove-pr` closes and `reopen-pr` clears `closedAt`; the branch default is applied; `ci link` produces the
  run and branch links.
- `mise run verify` green; after the first live passes: the report opens, `files.json` total down (about 440 MB
  expected), `site / deploy` under 8 minutes, the "pull requests" filter shows runs once a PR run has published.
