# Open issues #145–#188 — design

**Date:** 2026-11-05. **Process:** unattended (`docs/agents/process-unattended.md`). **Source:** the tier-two and
tier-three findings of the whole-repo review of 2026-11-05 (#145–#186) and the follow-up #188. The maintainer asked
for every open issue "that doesn't need input from me" to be addressed, with #90 and #125 ignored. Every design call
below is mine; each is marked **(call)**.

Left out on purpose, each needing the maintainer:

- **#133**, **#167**, **#173**: change `ci-report.yml`, `release.yml` or their cache scope, which run with a write
  token on `main`; the process says stop and ask.
- **#171**: changes the `otel-html-publish` action (`site-lease.sh`); same rule.
- **#141**: whether Traces mode gets a trace-duration condition or hides the Duration facet is a product decision.
- **#185**: the branch ruleset is the maintainer's to change; which of the two fixes the doc should describe depends
  on that.

## Intent

Thirty-six issues, grouped into nine pull requests by area so each PR has one reviewer-sized story. One PR (#150)
narrows a public type and carries `!`. The report `FORMAT_VERSION` stays 3; no on-disk shape changes. No CLI flag
changes.

## Goals / non-goals

Goals: every issue below gets a failing test first; every previously accepted input stays accepted unless the issue
says it is wrong (the one exception, #188, is called out); the README is updated where a behaviour it documents
changes.

Non-goals: the six issues above; a trace-duration condition; the `SpanRollups.add`/`GroupDurations` unification
from #181 (it changes how dropped groups are counted in the written rollups, a report-semantics change); the
`TopKBuffer` bullet of #181 (done in #190).

Anti-goals: a format version bump; loosening a test budget; a new dependency; a change to any workflow or action
that runs with a write token.

## PR 1 — `fix/writer-buffer` — #147, #184, #148

### #147 The two merge paths disagree on equal-time gauge points

`Columns.#mergeInto` (`src/writer/metric-buffer.ts:139`) keeps the later arrival on an equal `lastTime`; `mergeAgg`
keeps the larger `last`. **(call)** `#mergeInto` takes `mergeAgg`'s rule: on equal `lastTime` the larger `last`
wins, so the result does not depend on arrival order or on whether a spill happened between the points.

### #184 MetricBuffer has no direct tests; `test/query/` is a smoke test

A new `test/writer/metric-buffer.test.ts` pins the buffer's merge rule against `mergeAgg` (the #147 pair and a
counter pair give the same `BucketAgg` either way round). `MetricBuffer` has no spill of its own: spilling is
`MetricSeriesWriter.spill` and on-disk merges go through `mergeAgg` in `format/metric-files.ts`, so the "spilled
path" half of the comparison is a `MetricSeriesWriter` test (in `test/writer/metric-series.test.ts`) that spills
between the two points and reads the merged bucket back, asserting it equals the buffered result. **(call)** The tests of `src/query/*` modules that live under
`test/viewer/` move to `test/query/`, so the mirror AGENTS.md describes holds; nothing in them changes. No
`test/viewer` file tests only `src/query`, so it is the `describe` blocks for `parseFormula` and
`MetricPageStateSchema` that move, into files named after their `src/query` module.

### #148 A partial input into a `--replace` report holds the whole file in memory

**(call)** Documented, with one small change: the delayed wipe is the feature, and a staging directory is a larger
design than this plan carries. `AddOptions.partial`'s doc comment and the README's `--replace` paragraphs say that
while a partial input goes into a report being replaced, everything accepted stays in memory until the input ends,
so the first file into a replaced report should fit in memory (or the folder should be emptied first). **(call,
from the branch review)** The wipe used to happen at the first *write*, which a small first file can leave until a
later file, so a second large file was held whole too; `endInput` now wipes the replaced report as soon as the first
input has ended (it was read without error by then), so the hold is bounded by the first input as documented.

## PR 2 — `fix/api-surface` — #149, #150, #180

### #149 `Report` has `close()` but no `abort()`

`Report.abort(): Promise<void>` calls the session's `abort()` (what `convert`/`merge` already do on failure): it
releases the lock, leaves whatever was written, and makes the report closed (`add`/`close` after it throw the
existing "session … is closed" error; a second `abort()` resolves). The README's library section lists it next to
`close()`.

### #150 `Partial<WriterDeps>` is public but its port types are not

**(call)** The public surface narrows to the ports a user legitimately supplies:

- `export interface ReportDeps { logger: Logger; tracer: Tracer }` in `src/api/report.ts`; `Report.create`,
  `convert`, `merge` and `startReceiver` take `Partial<ReportDeps>`; `src/api/index.ts` exports `ReportDeps`,
  `Tracer`, `SpanHandle` and `SpanAttributeValue` (which the first two name; from `writer/ports.ts`) and stops
  exporting `WriterDeps`. `Report.createResolved`, a public static naming `WriterDeps`, moves off the class into
  the internal path. **(call)** `Clock`,
  `FileSystem` and `Timers` leave the public surface too unless another public signature still names them (the
  builder checks `dist/index.d.ts`); same `!`.
- The CLI and the tests keep full-deps access through a function exported from `src/api/report.ts` (and
  `convert.ts`/`receiver.ts` as needed) but not from `src/api/index.ts`; `CliDeps` keeps `Partial<WriterDeps>`.
- A passed `version` can no longer reach `loadCheckpoint`; a test pins that `Report.create(…, { version: 'x' })`
  is a type error (`test-d`) and that the runtime filter every public entry point applies keeps only `logger` and
  `tracer`, so the manifest stamps the real version.
- This is a breaking change to the public API: the PR title carries `!`
  (`fix(api)!: …`). The package is private (#173), so nobody is on the old type.

### #180 Viewer-bundle packages are runtime dependencies

The eleven packages the issue lists move to `devDependencies`. The PR body carries the check that `dist/index.js`,
`dist/receiver-*.js` and `dist/cli/*.js` import none of them (a grep over `dist/` after `mise run build`).

## PR 3 — `fix/model-config` — #174, #175, #176, #177, #182, #188

### #174 A kvlist key named `__proto__` disappears

`toJson`'s kvlist case builds its object with `Object.create(null)` and plain assignment, so `__proto__` is an own
key. Tests: `anyValueToJson` of a kvlist with `__proto__` has it as an own property, and `anyValueToDisplay` shows it.

### #175 An empty or comment-only `otel-html.yaml` fails

The config file loader treats a parse result of `null` as `{}`. Tests for `''` and `'# just a comment\n'`.

### #176 A key containing a dot is re-split into a nested path

**(call)** `resolveConfig` flattens by walking objects, carrying paths as `string[]`, and rebuilds the same way;
`setPath` takes the parts, never splits. A file key `'writer.chunkTargetBytes'` is therefore the unknown key
`writer.chunkTargetBytes` at the top level and is reported as `unrecognized key`. When a layer sets a nested path
through a non-object (file `viewer: 5` with `OTEL_HTML_EAGER_BUDGET_BYTES` set), the file's `viewer` is reported as
`expected object, got 5` instead of being replaced.

### #177 `MetricQuerySchema` skips `rejectPerPointPaths`

`MetricQuerySchema`'s `where` refinement runs `rejectPerPointPaths` over the condition's paths, the check
`compileSelector` makes at render time (`MetricWidgetQuerySchema` has no copy of its own; `perPointIssue` in
`dashboards/schema.ts` runs only on `failedWhen` and stays). Test: the issue's `safeParse` example fails with the
per-point message. **(call)** A dashboard or URL state whose `where` reads a per-point field now fails validation
instead of failing at render; it never rendered, so no working input is lost. The PR body says so.

### #182 Per-span hex id validation re-encodes and regex-checks bytes

`traceIdFromBytes`/`spanIdFromBytes` check the byte length and the all-zero case on the bytes, then build the hex
through a 256-entry table; no regex, no `toLowerCase`. `parseTraceId`/`parseSpanId` (string inputs) are unchanged.
**(call)** The table-based `bytesToHex` lives in a new `src/model/bytes.ts` (created here, so PR 8 only re-points
the other copies to it). Tests: wrong length and all-zero bytes still fail with the same error, and the hex equals
the old function's.

### #188 The nested-repetition threshold of 4 is unsafe on long subjects

**(call)** The threshold goes away. A quantifier with maximum above 1 applied to a group that contains a variable
quantifier (`min < max`, `max > 1`) is rejected **unless every variable quantifier inside that group is immediately
followed, inside the group, by a mandatory atom that the quantified atom cannot match**. "Mandatory" means not itself
quantified with a minimum of 0. "Cannot match" is decided exactly: the detector compiles the quantified atom's text
as `new RegExp('^(?:' + atom + ')$', 'u')` and tests the following atom's literal character; the following atom
must be a single literal character (plain or backslash-escaped punctuation), never a class, a class escape (`\d`,
`\w`, `\s` and their negations), `.` or a group. **(call)** The follower is looked for through group ends: a
variable quantifier that is the last thing in a subgroup is followed by whatever follows that subgroup's `)`
(so `((\d+)\.){3}` is safe). **(call)** The "cannot match" check compiles with the pattern's own flags
(`regexProblem(body, flags)`): under `(?i)`, `([a-z]+A){3}` is rejected.

Accepted (as before): `(\d+\.){3}\d+`, `([a-z]+-){2}`, `(\w+,){1,5}`, `(\d+\.)*`, `(a+b)+`, `(a|aa){2,}`,
`([0-9a-f]{2}:){5}[0-9a-f]{2}`, every pattern the current tests accept except the ones below. Newly accepted:
`((a+)b){5}` (a current test expects rejection; its expectation flips, with the reason in the test name).
Rejected (new): `(a+){2}`, `(a+){4}$`, `(\d+\.\d+){3}`, `(.+;){3}`, `(\d+\.?){3}`, `(a+){2,20}`, `(a+)+`.

Message: `nested repetition (e.g. "(a+)+" or "(a+){2}") can backtrack catastrophically; put a literal the repeated
part cannot match after it, like (\d+\.){3}, or repeat a class instead, like [a-z]{1,64}`. The README's IsMatch
sentence (if it states the rule) says the same. This is the one place a previously accepted input is rejected;
`(a+){2}`-style patterns can be written out (`a+a+`).

*Also*, found while planning: `templateToRegex` (`src/rollups/drain.ts`) escapes `-` as `\-`, which the `u` flag
`IsMatch` compiles with rejects, so a log pattern whose template holds `-` cannot be added as a filter. Fixed in
this PR (the escape set loses `-`).

## PR 4 — `fix/viewer-metrics` — #145, #146, #155, #156, #158

### #145 `seriesBaselines` rounds the fine-bucket cut

`fineTo = Math.ceil(cut / ladder.widthNs)`: the first fine bucket at or after `cut`, so the bucket straddling `cut`
(which `coarsenedTo` assigns before the window) counts in the baseline. Test: the issue's worked example through
`runMetricQueryAtWidth` with `show: 'sum'` at a width that is not a level width; the running total includes the
straddling bucket's delta.

### #146 A rollup ƒ reports the rollup interval as `widthNs` but heatmap cells stay at the source width

**(call)** The cell width is reported separately: `MetricQueryResult.heat` gains `widthNs` (the width the cells
were built at); `heatAxis`, the metric-chart-card click/zoom mapping for heatmaps and the metric export read it;
`MetricQueryResult.widthNs` keeps meaning the series' width (the rollup interval when a rollup ƒ applies). Test:
`display=heatmap` with `rollup(avg, 60000)` over 8.192 s buckets yields `heat.widthNs === 8.192e9` and
`widthNs === 60e9`, and `heatAxis` places ~7 cells per 60 s.

### #155 `levelOf` and the level-file cache never evict

**(call)** `once` (`metric-load.ts:117`) takes a `limit`; past it the least recently used entry is dropped (a
hit moves its key to the back). `levelOf` uses 4, the level-file and exemplar-file caches 32 each. Tests: after
five distinct windows the first window's `LevelData` is a new object (its pages may still come from the file cache);
a repeated window within the limit returns the same object; and with more than 32 distinct pages read, the first
page is requested from the loader again.

### #156 The run chart is O(runs × total series)

`runAtLevel` walks `m.series` (every series of the metric) and only looks each up in the level; `oneBucket`
already narrows the level. **(call)** The run chart passes, per run, a `LoadedMetric` view whose `series` is that
run's members (`{ ...m, series: run.members }`, built by a small exported helper), and `oneBucket` builds the
per-run level without copying the whole series map. Tests: the helper's `series` is the run's members and nothing
else; the run lines are unchanged for a two-run fixture.

### #158 `uniqueLabels` can still produce duplicate names

A label already used gets ` (n)` with the smallest `n ≥ 2` whose result is not used either; generated names count
as used. Tests: `['a', 'a', 'a (2)']` has no duplicates and the first `a` keeps its label; `['a', 'a']` →
`['a', 'a (2)']` as before.

## PR 5 — `fix/viewer-scan-2` — #151, #152, #153, #154, #157

### #151 A whole-run traces-mode scan still holds every visited span

**(call)** `SpanQueryRun` gains `endChunk(): void`: in traces mode it drops the rows of every trace that has not hit
yet (the group stays, marked seen, so a later hit still counts the trace once). `scanChunks` calls `run.endChunk?.()`
after each chunk; the eager source never calls it (its entries live in memory regardless). A trace that hits in a
later chunk is therefore built from the rows seen since; in a windowed report `TraceFacts` supplies start, duration,
counts and the root summary, as today when the root's chunk was not scanned (its `root` is null and its service
share reads as partial even after a whole-run scan; the README says so). The class comment says what is held:
hit traces' rows since their first chunk, and the current chunk's. Test: after `endChunk`, `heldRows` counts only
hit traces' rows; a trace hitting across two chunks is listed once.

### #152 `facetValueOf` re-walks every attribute per matched span

The measure facet is resolved once in the constructor (a core field reader, or an attribute key); per span it is one
`attributes.get(key)` and one `truncateFacetValue(anyValueToDisplay(v))`. Results are unchanged (existing tests);
a test pins that a non-facet key still yields no groups.

### #153 Traces-mode service/resource sort disagrees with the column

`TRACE_SORTS.service/resource` compare `root?.service ?? rootSummary?.service ?? ''` (same for resource), the
fallback the column renders. Test: a trace with `root = null` and a `rootSummary` sorts by the summary's service.

### #154 Eager and LRU-hit queries cannot be aborted mid-scan

**(call)** A `yieldToEvents(): Promise<void>` in `query-common.ts` (a `MessageChannel` round trip, `setTimeout(0)`
when `MessageChannel` is undefined). `scanChunks` awaits it after every chunk, before the next abort check; the two
eager sources visit their entries in blocks of 8192 (`EAGER_BLOCK`) through a run object, awaiting it between
blocks, and check the signal after each block. `querySpanEntries`/`queryLogEntries` stay synchronous for callers
that have no event loop to yield to (tests). The abort tests change: the abort comes from a timer scheduled before
the query (as a keystroke's cleanup does), the query rejects with the abort error, and fewer than all entries were
visited; the `target`-getter aborts go.

### #157 The log time tiebreak parses both refs on every comparison

`LogRow` gains `n: number` and `i: number` (set where rows are made, the parts of `ref`); the tiebreak compares
them. `refParts` stays for other callers. Test: the order over a time tie is unchanged.

## PR 6 — `fix/viewer-ui` — #159, #160, #161, #162, #163, #164, #165, #166

### #159 Changing Lines does not re-measure the virtualizer

`ResultsTable` calls `virtual.measure()` in an effect on `rowHeight`. Test: after a `rowHeight` change the rendered
rows are placed at multiples of the new height and the scroll height is `rows × newHeight`.

### #160 The Waterfall never scrolls the selection into view and can leave no row Tab-reachable

The Waterfall scrolls the selected index into view on mount and when it changes (`virtual.scrollToIndex`); in both
the Waterfall and `ResultsTable`, when the selected row is not rendered the first rendered row carries
`tabIndex=0`. Tests (jsdom): a selection at index 3000 asks the virtualizer to scroll there, and some rendered row has
`tabIndex=0` in both components. **(call)** An e2e assertion in the existing trace spec: open a trace at a deep
span, switch to Waterfall, press Tab from the tab bar, and the focused element is a tree item.

### #161 The flame graph rescans every bar on hover and rebuilds the option on click

**(call)** Three changes. The counts (`maxDepth`, `clipped`, `errorCount`, `dimmed`, `outlined`) are `useMemo`s on
`bars`. `barAt` takes a per-depth index built once per `bars` (`useMemo`): bars grouped by depth, sorted by start,
found by binary search. The selection leaves `mainOption`: `Chart` accepts an optional `patch: EChartsOption`
applied with `setOption(patch, { notMerge: false })` after the main option whenever it changes, and the flame graph
passes a one-item `custom` series (id `selection`) drawing the ring at the selected bar (empty data when nothing is
selected). Tests on the pure builders: the main option for a `bars` array is deep-equal for two different
`selectedSpanId`s; `barAt` through the index returns the same bar as the linear scan on a random fixture.

### #162 Bars past `FLAME_MAX_ROWS` draw over the time axis and stay clickable

`renderItem`, `renderBatch` and `barAt` skip bars with `depth >= FLAME_MAX_ROWS`. Tests on the pure functions.

### #163 A TokenChip's draft survives an external change to its token

`TokenChip` resets its draft in an effect on `[token.op, token.value]` (the pattern of `DraftInput`). Test: a
rerender with a new token value shows the new value, not the old draft.

### #164 Coarsened histogram columns share one-decimal labels

`seconds(ns, widthNs?)`: with a width, the decimals are the smallest `d` in 0..3 with `10^-d s ≤ width`; without,
today's rule. The category-label callers (`histogram-card`, `fusion-timeline`, `logs/views`, `traces/views`) pass the
column width; the value-axis formatters keep the one-argument form. Test: a 7 ms width labels `0.014s`, a 1 s width
`3s`, a 0.5 s width `1.5s`.

### #165 Duration-facet bin edges are raw float nanoseconds

`durationAxis` rounds every edge to an integer nanosecond (non-decreasing stays allowed, as #191 ruled), so the
condition carries integers. The slider text, `aria-valuetext` and the bar titles use `formatDuration`. Tests: every
edge is an integer; the text reads `from 1.9 µs` (whatever `formatDuration` gives), not `1873.8174228603844 ns`.

### #166 The facet-chart cap note is truncated with the full text only in `title`

`CapNote` gets `aria-label={full}` (as `PartialNote`), keeps `truncate` and `title`, uses `count(n, noun)` from
`./subtitle.js` for its plural, and `FacetBody` binds `groups` once. Test: the note's accessible name is the full
sentence.

## PR 7 — `fix/ci-cli` — #168, #170, #172, #186, #183, #169

### #168 The job-id fallback differs between the job side and the publisher

**(call)** The job side's fallback id becomes unique per leg and the publisher reuses it verbatim:

- `ci context` on a failed lookup writes `{ jobId: 'name:<hint>' + (runner ? '@' + runner : ''), approximate: true,
  jobName: <hint>, runner: RUNNER_NAME ?? null }`, where `<hint>` is `OTEL_HTML_JOB_NAME` or `GITHUB_JOB` as today.
- The publisher maps each API job that no exact context claimed to the approximate context whose `jobName`
  equals the job's display name or is its prefix before ` (` (a matrix leg), compared case-insensitively (a job
  `lint` shown as `Lint`), and whose `runner` is null or equals `job.runner_name` (`ApiJob` already carries it; a
  context that records a runner never matches a job on another runner, so a leg whose own context is missing
  cannot take a sibling's id); exactly one distinct id among the candidates is used verbatim, anything else keeps
  `name:<display name>`. The result is one `ReadonlyMap<number, JobId>` of
  approximate ids, built once in `report-main.ts` and used by both derivation sites, `jobIdFor` in `publish.ts`
  and the job-span id in `workflow-trace.ts` (which builds `name:${job.name}` itself today); the
  `approximate: Set<number>` parameter becomes that map.
- Old contexts without `jobName` keep today's behaviour. Two legs with one hint on one runner (sequential reuse)
  still share an id; the docstring says so, as it says today for same-named jobs.

Tests: a matrix leg (`e2e` hint, `e2e (chromium)` display, matching runner) parents its spans; a renamed job
(`name: Lint`, hint `lint`) does; a job with no context keeps `name:<display>`.

### #170 A published run that retention drops stays on gh-pages forever

**(call)** The run being published is never dropped by retention: `applyRetention` keeps it in the index in
addition to the `keep` newest (nothing else is evicted for it), so the folder it writes is indexed, the channel's
latest stays the newest run, and the next publish's retention removes it like any other old run. Test: publishing a
run older than the retention window keeps it listed alongside the `keep` newest; the next publish drops it.

### #172 Job and workflow names from a fork's workflow file are posted unescaped

**(call)** `cell()` wraps the text in a code span whose delimiter is one backtick longer than the longest backtick
run inside it, padded with one space on each side when the text starts or ends with a backtick, after replacing
newlines with spaces and `|` with `\|` as today. Inside a code span `@org/team` is not a mention and `![x](…)` is
not an image. Tests: the issue's name renders as a code span; a name containing backticks gets a longer delimiter.

### #186 `OTEL_HTML_REPORT_URL` is read but undocumented and never set

**(call)** Removed: `report-main.ts` no longer reads it and `summaryTable` loses the `reportUrl` parameter; the
run summary ends with the artifact pointer, and the sticky comment (which took its site link through that
parameter) appends its `Report: <url>` line itself, so the comment is unchanged.

### #183 install.sh's `@v0` / latest path is never exercised

The `release list | sort -V | tail` path runs only when `ACTION_REF` matches `^v\d+$` (a bare `latest` otherwise
goes through `gh release view`). A test runs `install.sh latest` with `ACTION_REF=v0` against a stubbed `gh` whose
`release list` prints tags including `otel-html-v0.10.0` and `otel-html-v0.9.0`, with the real `sort` and `tail`
on the stubbed PATH, and asserts `0.10.0` is installed; a second test covers the `gh release view` path without
`ACTION_REF`.

### #169 `test:unit:main`'s sources miss e2e helpers

**(call)** `sources` lists `e2e/*.ts` and `e2e/otel-page/**/*.ts` (plus any other `e2e/` subfolder holding
`.ts` the tests import) instead of `e2e/fixture.ts` — not `e2e/**/*.ts`, which would walk the generated
`e2e/.reports` and `e2e/.reports-scale` folders that `mise.toml:25–27` keeps out of sources. The task description is
unchanged, so no `gen`.

## PR 8 — `chore/dedupe-knip` — #181, #178

### #181 Duplicated helpers

**(call)** One copy each: `bytesToHex` (created by PR 3's #182) and `bytesToBase64` (a wrapper over protobuf's
`base64Encode`, already a dependency on both sides of the build, not a hand-rolled loop) in `src/model/bytes.ts`
(every listed site imports them); `sameBounds` exported from `src/rollups/metric-agg.ts` and used by `metric-streams.ts` and
`metric-buffer.ts`; `useThemeTick` in its own `src/viewer/components/theme-tick.ts`, used by `histogram-card`,
`fusion-timeline`, `run-chart-card` and `metric-chart-card`; the viewer-entry picker exported from
`src/writer/viewer-assets.ts` and used by `src/api/viewer-dir.ts`. The `SpanRollups.add` bullet is left out (see
non-goals) and the PR body says so.

### #178 knip never reports dead code in `src/`

**(call)** `knip.json`'s `entry` for `src/` narrows to the real entry points: the two tsdown entries (`index`,
`cli/main`) and the viewer's Vite entry (`dist/receiver-*.js` is a shared chunk reached through imports); the test,
e2e and script entries stay.
What knip then reports is cleaned: dead files are deleted (`src/viewer/index.ts`, `FORMATTERS` if nothing reads
it, `src/model/jsonl.ts` with its helper moved into the one test that uses it), exports used only in their own file
lose `export`, and exports used only by tests keep it (test files are entries). `mise run check` (which runs knip)
is the test. If the cleanup would remove something reached dynamically, keep it and say so in the PR body.

## PR 9 — `test/frozen-format-3` — #179

A frozen `fixtures/reports/format-3/` written by the `otel-html-v0.2.1` tag with the README's recipe (same inputs,
title `format 3 fixture`), added to `FROZEN`, `buildFrozenReports`, `ReportName`, the fixture list in
`test/viewer/frozen-reports.test.ts`, `e2e/global-setup.ts`'s mounted list and `e2e/frozen.spec.ts`'s loop;
`SHA256SUMS` regenerated. `fixtures/reports/README.md`'s table gains the row (written by `otel-html-v0.2.1`), the
sentence "Format 3 needs no frozen copy" goes, and the guidance there and in `README.md` (the sentence near line
539 saying frozen copies are added on a `FORMAT_VERSION` bump) becomes: a frozen report of every format a release
ships, added when the release is cut. **(call)** The current writer also writes 3, so
`compat.test.ts` merges it like the others; a later in-place change to a format-3 shape then fails here.

## Constraints

- Conventions in `docs/agents/conventions.md`: TDD per task, Biome strict, no `any`/non-null assertions, README
  updated with behaviour, one PR per section above, `Fixes #N` lines, decisions recorded in the PR body.
- The PRs are independent except that PR 8 re-points `bytesToHex` sites to the module PR 3 creates, so PR 8
  follows PR 3; it goes last anyway because it touches the most files.
- Reviewer models per CLAUDE.md: implementers and task reviewers on Sonnet 5.5, branch reviews on Opus 5.5.
- A viewer behaviour that needs a real browser is an e2e test (#160); logic is a unit test.

## Left to the builder

Private names; where `yieldToEvents` is awaited inside the eager log source; the shape of the per-depth bar index;
how the patch series draws the ring (a `custom` series or a `graphic` element — whichever `Chart` can merge without
redrawing the bars); which `test/viewer` files are `src/query` tests; the exact `once` LRU implementation; test
fixture plumbing for the run-chart and rollup-width tests.
