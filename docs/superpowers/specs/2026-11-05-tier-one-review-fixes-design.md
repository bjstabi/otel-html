# Tier-one review fixes — design

**Date:** 2026-11-05. **Process:** unattended (`docs/agents/process-unattended.md`). **Source:** the whole-repo
review of 2026-11-05, filed as #133–#186; this spec covers the tier-one bugs that need no maintainer decision.

The maintainer asked for every tier-one bug "that doesn't need input from me" to be fixed. Every design call below
is mine; each is marked **(call)**. Two tier-one items are left out on purpose:

- **#133** (ci-report's trust gate) changes `ci-report.yml`, which the unattended process says to stop and ask on.
- **#141** (Traces-mode duration histogram vs per-span filter) is a product decision: a trace-duration condition
  does not exist in the query language, and hiding the facet in Traces mode is a visible change.

## Intent

Ten verified bugs, grouped into four pull requests by area so each PR has one reviewer-sized story. No public API,
CLI flag or on-disk layout changes. The report `FORMAT_VERSION` stays 3.

## Goals / non-goals

Goals: fix #134–#140 and #142–#144 with a failing test first for each; keep every previously accepted input
accepted unless the issue says it is wrong; update the README where a behaviour it documents changes.

Non-goals: the tier-two and tier-three issues, except where a tier-one fix passes through the same lines (listed per
PR under *Also*); any change to traces-mode memory (#151) beyond keeping it capped; a `TopKBuffer` for traces mode.

Anti-goals: a format version bump; loosening a test budget; a new dependency.

## PR 1 — `fix/writer-metrics` — #134, #135, #136

### #134 Summary points are cumulative

OTLP summary data points carry `count` and `sum` cumulative since `start_time_unix_nano`. The stream rule
(`src/rollups/metric-streams.ts:87`) marks them `cumulative: false` and `mergeAgg` adds them.

**(call)** Summaries are differenced like counters and histograms, through the existing `#cumulative` path:

- Rule: `{ type: 'summary', temporality: '*', monotonic: '*', agg: 'summary', cumulative: true }`.
- `diffSummary(cur, prev)`: `null` (a reset) when `cur.count < prev.count`; otherwise
  `{ ...cur, count: cur.count - prev.count, sum: cur.sum - prev.sum }` — the quantiles and `lastTime` are the
  current point's. A sum that decreases without the count decreasing is not a reset (negative observations).
- Zero baseline for a point with no start time: `{ ...cur, count: 0, sum: 0 }`.
- The first point of a stream counts in full and is flagged `reset` only when its start is after the series' latest
  point, exactly as counters do. Out-of-order points skip. Stream state is the previous `SummaryAgg`, which
  `SerializedStreams.lasts` already accepts.
- `mergeAgg`'s summary case is unchanged: deltas add.

Old reports keep the values they stored; nothing on disk says whether a summary bucket was differenced. **(call)**
No format bump: the stored shapes do not change, and the old values were wrong at every level above 0 anyway. An
append to a report written before this fix treats the first new summary point as a first point (no stream state),
which is what a counter does whose state is missing. The PR body says so.

### #135 Spread-push overflows the stack

`src/format/metric-files.ts:316-317` (`mergePieces`) and `src/writer/metric-series-writer.ts:443` spread whole
series into `push`; V8 throws past roughly 125k arguments. Both become element loops (the pattern at
`metric-series-writer.ts:347`). *Also:* `src/rollups/time-buckets.ts:150` and `:190` have the same shape on count
rows and become loops too. Tests exercise 150 000 elements through `mergeBucketSeries` and through the exemplar
page reader that line 443 uses.

### #136 `close()` leaves the session open after a failed prune

Once the final checkpoint is committed the report is complete; a failed `prune()` only leaves stale segment files
behind. **(call)** `close()` marks the session closed (`#closed = summary`) before pruning, prunes inside a
`try/catch` that logs `logger.warn('stale metric segments left behind', { error })` and does not throw, and
releases the lock in `finally`. A second `close()` returns the summary without re-running anything; `add`/`flush`
after it throw "session … is closed" as they do today. A failure before the final checkpoint keeps today's
behaviour (lock held, retry allowed, covered by the existing test).

## PR 2 — `fix/ingest-edges` — #137, #138, #139

### #137 A no-signal document in a multi-document body drops everything and returns 200

`OtlpJsonStream.push` collects the documents' entries in a local array and loses them when a later document throws
`noSignal`; the receiver's `catch` then returns `[]` for the whole body. **(call)** The stream gets an option
`allowEmpty?: boolean` (default `false`): when set, a document with no signal key is accepted as an empty document
instead of throwing, in both `lines: true` and `lines: false` modes. The receiver passes `allowEmpty: true` and drops
its `catch`. So `{}` stays "0 records, 200" (the existing tests), and
`{"resourceSpans":[…]} {}` in either order writes the spans. A whitespace-only body still fails with "no JSON object
found" (400). The CLI's `convert` keeps the default and keeps failing on `{}` files, as its tests assert.

### #138 The ReDoS guard accepts bounded nesting

`regexProblem` (`src/ottl/converters.ts:29-99`) rejects an *unbounded* quantifier over a group that contains an
unbounded quantifier, so `(a+){2,20}` and the hint's own `{1,64}` pass and backtrack exponentially. **(call)** The
rule becomes: a quantifier whose maximum is **greater than 4** (`*`, `+`, `{n,}`, `{n}`/`{n,m}` with the upper bound
above 4) applied to a group that contains a *variable* quantifier (maximum greater than 1 and minimum below the maximum:
`*`, `+`, `{n,}`, `{n,m}` with m > n) is rejected. `?` and an exact count `{n}` are not repeats, so fixed-width forms
such as `([0-9a-f]{2}:){5}[0-9a-f]{2}` stay accepted. Up to 4 outer repetitions keeps the cost polynomial of low degree, so `(\d+\.){3}\d+` stays accepted. Every
pattern the current tests accept stays accepted; `(a+){2,20}` and `(a{1,64}){1,64}` are rejected (`(a|aa){2,}` has no inner quantifier; alternation overlap stays undetected, as the guard documents). The
message becomes: `nested repetition (e.g. "(a+)+" or "(a+){2,20}") can backtrack catastrophically; repeat a class
instead, like [a-z]{1,64}`.

### #139 snake_case OTLP JSON is half-supported

protobuf-es's `fromJson` accepts both the proto name and the JSON name, but the pre-pass that keeps int64 exact and
turns hex ids into base64 (`convertField`, `INT64_FIELDS`, `ID_FIELD_LENGTHS` in `src/model/otlp-json.ts`) and the
top-level `signalEntry` match lowerCamelCase only. **(call)** Support both spellings consistently rather than reject
one: the maps gain `time_unix_nano`, `start_time_unix_nano`, `end_time_unix_nano`, `observed_time_unix_nano`,
`as_int`, `int_value`, `zero_count`, `bucket_counts` (`count` is the same in both), `trace_id`, `span_id`,
`parent_span_id`; `signalEntry` gains `resource_spans`, `resource_logs`, `resource_metrics` (it serves both
`parseOtlpObject` and the stream). The plain-metrics fast path keeps returning `null` for snake_case (falls back,
as its header says). The README's OTLP/JSON sentence says both spellings are accepted.

## PR 3 — `fix/viewer-scan` — #142, #143, #144

### #142 "Scan entire run" keeps the list cap; a scan that matches exactly `cap` reads as partial

- **(call)** A shared `TopKBuffer<T>` in `src/viewer/data/top-k.ts` — `constructor(limit, compare)`, `push(item)`,
  `size`, `take(): T[]` — holds at most `limit + max(limit, 1024)` items, compacting to the best `limit` with `topK`
  when the bound is reached. `SpanQueryRun` (spans mode) and `LogQueryRun` (logs mode) use it; the `heldRows` test
  hook stays on both. The logs result's `total` becomes the match count, which it already equalled.
- **(call)** With the buffer bounding memory, `scanChunks` gets `cap: Infinity` whenever `q.scanAll` is set and the
  mode is not `traces`, in both windowed sources (today only `measureBy` lifts it). Traces modes keep the cap: their
  per-trace maps are unbounded (#151) and this spec does not change that.
- `scanChunks`'s `exact` becomes "every target was visited to its end": track whether the cap cut a chunk short or
  stopped the chunk loop with targets left, instead of `run.units < cap`. A run that read everything and matched
  exactly `cap` units is exact.

The second click of "Scan entire run" being a no-op (`use-query.ts:83`) is moot for spans, logs and patterns once the first click is exact. In Traces mode the cap stays, so a result with more than `listCap` matching traces still shows the partial note with a button that does nothing further (#151).

### #143 Span scans walk chunks oldest-first under a `start:desc` sort

`log-windowed.ts` already orders targets newest-first and forces `finishChunk` when the sort is `time desc`.
**(call)** `windowed.ts` does the same for spans and traces mode when `q.sort.column === 'start' && q.sort.dir ===
'desc'`: targets sorted by `end` descending (tiebreak `n` descending), `finishChunk` true (rows within a chunk are not
in time order). Other sorts keep the default order; a capped head under them is still a head, which `PartialNote`
already says.

### #144 Filtered facets use hard-coded caps

The serialized facets carry the writer's `valueCap`/`keyCap`; `load.ts:57` and `log-load.ts:49` override them with
`QUERY_FACET_CAPS`, and the query runs construct their rollups from the same constant. **(call)**

- `loadSpanRollups`/`loadLogRollups` stop passing caps, so the loaded rollups expose the writer's.
- A `FacetCaps` type `{ facetValueCap: number; facetKeyCap: number }` in `query-common.ts`; the constant is renamed
  `DEFAULT_FACET_CAPS` and remains the fallback for callers without a report (tests).
- `SpanQueryRun`/`LogQueryRun` constructors, `querySpanEntries`/`queryLogEntries`, `createEagerSource`,
  `createEagerLogSource`, `createWindowedSource` and `createWindowedLogSource` take the caps; `data-source.ts`
  derives them from the loaded rollups (`rollups.facets.valueCap/keyCap`; for logs through the lazy
  `getLogRollups`). The `GroupDurations` cap uses `facetValueCap` from the same object.

## PR 4 — `fix/viewer-duration-facet` — #140

The Duration facet's bins are rebuilt from the filtered rows on every result, and the committed range is found by
exact equality against those edges, so after any duration filter the range is lost and an arrow key clears it.

**(call)** The axis is stable while a duration filter is set:

- `src/viewer/traces/views.ts` splits `durationBins` into `durationAxis(rows, binCount, range?)` (log-spaced edges
  as today; when `range.lo`/`range.hi` are given they become the first/last edge exactly) and
  `binsOnAxis(rows, edges)` (counts rows into the edges, clamping rows outside into the first/last bin).
  `durationBins(rows, binCount)` stays as the composition.
- The Traces explorer keeps the axis in a ref. With no duration token in the condition it derives the axis from the
  rows and stores it. With a duration token it reuses the stored axis; if there is none (the page opened with the
  filter in its URL) it derives one with the tokens' values as `range`, stores it, and uses it from then on. Bins are
  always `binsOnAxis(rows, axis)`.
- `DurationFacet` finds the committed indexes tolerantly: the bin whose `fromNs` equals the `>=` value, else the bin
  containing the value, else 0; and the bin whose `toNs` equals the `<=` value, else the bin containing it, else the
  last. A hand-edited condition therefore lands on the right bins instead of resetting the strip.

The per-trace/per-span mismatch in Traces mode (#141) is untouched and still reads per span.

## Constraints

- Conventions in `docs/agents/conventions.md`: TDD per task, Biome strict, no `any`/non-null assertions, README
  updated with behaviour, one PR per section above, `Fixes #N` lines, decisions recorded in the PR body.
- The four PRs are independent; they may be developed in parallel worktrees and merged in any order.
- Reviewer models per CLAUDE.md: implementers and task reviewers on Sonnet 5.5, branch reviews on Opus 5.5.

## Left to the builder

Names of private fields and helpers; where in `metric-streams.ts` `diffSummary` sits relative to `diffHist`; whether
the explorer's axis ref is a `useRef` updated in the memo or a `useState` pair; test fixture plumbing for a
non-default `facetValueCap` (extend `test/viewer/report-fixture.ts` if needed).
