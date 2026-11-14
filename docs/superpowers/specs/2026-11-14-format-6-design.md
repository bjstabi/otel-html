# Format 6: stored service share, no epoch

**Status: approved 2026-11-14.** Written 2026-11-14 after the read-debt project closed (`2026-11-14-read-debt-design.md`:
its format 6, per-trace row ranges, was dropped at the Chromium gate). The maintainer chose this work next (#273, then
a batch of small bugs), skipped the brainstorming questions, chose the **unattended** process
(`docs/agents/process-unattended.md`), and decided the four points of §6. A builder check (Opus 5.5) read the first
draft against the code; its questions are answered in §6 and §9.

## 1. Why

**#273.** Each visible row of a trace list draws "Latency by service" by loading its whole trace
(`DataSource.serviceShare` → `readTrace`, every column of every span) and computing the exclusive time per service in
the page (`exclusiveTimeByService`, `src/viewer/data/trace-tree.ts`). On a mirror of the rolling `branch/main` report
six visible run traces of 97,000–145,000 spans cost 73.3 MB, 199 requests and 2.9 s of worker time, so #270 capped the
cell at 10,000 spans (`SERVICE_SHARE_SPAN_CAP`, `src/viewer/traces/columns.tsx:168`): the run traces, the ones people
open the CI dashboard for, show a dash. A 318-span trace in a 1.7 M-span partition still costs 41 requests and 7.8 MB.
This is most of #291's live cost (the catalogue's `trace.share` line in `KNOWN_DEBT`). The read-debt Chromium
measurements showed that reading spans more cleverly saves only 4–7 requests per trace; not reading them saves all of it.

**#216 and #294.** The Parquet formats store absolute int64 times, yet a writer still refuses data more than 2^53 ns
(~104 days) from the manifest's `epochUnixNano` (`toRelNanos`, `src/model/ids.ts:72`; the writer's records are numbers
relative to that epoch, `rel()` in `src/model/normalize.ts:135-142`), while `merge` by copy produces wider reports
without complaint; and the viewer refuses a report whose range or a bucket edge lies more than 2^53 ns past its epoch
(`manifestRange`, `toNumber`, `src/viewer/data/manifest-range.ts`). URLs carry times relative to the epoch, and the
rolling report's epoch moves on merge, so its shared links already drift.

## 2. Goals

1. **Format 6** adds a `service_share` column to `traces.parquet` and removes `epochUnixNano` from the manifest.
2. The writer computes a trace's share when it writes the traces rows of a partition (flush and compaction). A stored
   share equals `exclusiveTimeByService` over the trace's spans in that partition, duplicates resolved as the viewer
   resolves them.
3. The trace list's share cell reads no spans when the trace's share is stored and exact. Run traces get their bar back.
4. Writers accept data at any time: no ±104-day window. The viewer opens a report of any width (#294).
5. Format-6 URLs carry absolute times, so a link survives merges, appends, deploys and Refresh.
6. Readers keep reading format 5. Readers land on `main` before any writer writes format 6.
7. A batch PR fixes #241, #193, #212 and `run`'s exit code on a refused append (#216's second point).

## 3. Non-goals

- `trace.get` (opening a trace) still reads its spans as today; #291 stays open for it with this work's numbers.
- No recompute of a share across partitions that `merge` copies without compacting; such a trace falls back (§5).
- No threaded engine (#306), no change to rollups.
- The writer's records stay numbers relative to an anchor (no move to bigint records).

## 4. Anti-goals

- A share bar that is wrong. A trace whose stored share could miss a parent–child pair falls back to today's read
  rather than drawing an overcount.
- A viewer that refuses a format-5 report, or a released 0.4.x pusher that breaks against what `main` deploys.
- A writer memory regression the share does not need (#210 is already over budget; §8 bounds it).

## 5. Design

**The column.** `service_share` is VARCHAR holding JSON: an array of `[service, ns]` pairs, largest first, ties by
service name, `ns` as a decimal string (the format's int64-in-JSON convention). The codec has no list-of-string type,
and attribute columns are JSON already. An empty array for a trace with no spans in the partition; null only where the
share is unknown (§ compaction).

**One computation.** The duplicate rule (`trace-tree.ts:16-39`: one row per span id, the non-provisional CI copy
preferred by `otel_html.ci.provisional`) and the exclusive-time algorithm (`exclusiveNs`, `exclusiveTimeByService`)
move to a module both the writer and the viewer import. It works on a minimal span shape: span id, parent id, service,
start and end relative to the trace's own earliest start (so both sides compare exact times, however far the
trace lies from the report's anchor), duration, provisional flag. Per-service totals are summed as exact integers
(bigint) before encoding. The viewer's fallback
and the writer call the same code on the same inputs, so their results are equal by construction; a test asserts it on
traces with duplicates, overlaps and orphans.

**Flush.** `traceRows` (`src/writer/trace-summaries.ts`) computes each trace's share from the partition's spans batch.

**Compaction.** `aggregateTraces` (`src/writer/compaction.ts`) folds traces rows. A trace with spans in exactly one
input keeps that input's share. A trace with spans in several inputs gets its share recomputed from the merged spans
(a session's `close()` compacts its flushes and the rolling report is a `merge --compact`, so a run trace is usually
split across inputs). Only the minimal shape of those traces' spans is held in memory. A trace whose only spans input
lacks the column (a format-5 copy) stays null. The column-set check that refuses mixed inputs
(`src/format/parquet/stream.ts:50-63`) accepts a traces file without `service_share` and reads it as null.

**Merge by copy, append and upgrade.** `merge` copies partitions byte for byte, so a copied format-5 traces file has no
column; the output is format 6 whenever the build writes 6, or (before then) whenever any input is format 6. A format-6 writer appending to a format-5 report upgrades
its manifest in place (as `upgrade` does) and appends format-6 partitions. `upgrade` 5 → 6 rewrites the manifest only:
it drops `epochUnixNano` and rewrites no file.

**The views.** The `traces` view reads files with and without the column (`union_by_name = true`, or a typed
`NULL AS service_share` per file; the builder picks after measuring both at open).

**The trace list.** The list query returns, per trace, the stored share and whether it is exact: exact when the trace
has spans in exactly one traces row and that row's share is not null. An exact share draws without a load. Otherwise
the cell calls `serviceShare` as today, with today's 10,000-span cap.

**Writer times.** Each write session (convert, run, append, compaction, merge's conversions) picks its own anchor from
its own data: its first record's time, never stored. Records stay numbers relative to it, so a session whose own data
spans less than 2^53 ns (~104 days) loses nothing, and the report it appends to can be any width. A session whose own
data is wider still refuses, with a message naming the session's span, not the report's epoch. `merge`'s conversion of
chunk (format 3) inputs keeps its window (`src/writer/rebase.ts:17`).

**Viewer times.** For a format-5 report the anchor is `epochUnixNano`, as today. For a format-6 report it is the
report's range start at page load, frozen for the page's life (a Refresh that finds older data does not move it).
Where a range or bucket edge lies more than 2^53 ns from the anchor, the viewer rounds to the nearest double instead of
refusing; durations stay int64-exact. A report spanning three years opens, its timeline draws, and a span's position in
the trace panel is off by at most a few ns.

**URLs.** On a format-6 report, every time in the URL (the `t` window, selections, anything `url-state.ts` and
`selection.ts` encode relative to the anchor) is absolute unix nanoseconds. On a format-5 report URLs stay relative to
its epoch, so existing links keep working. A link made on a report before its upgrade to 6 points elsewhere after it
(accepted: no external users).

**Rollout.** PR A (readers) merges first. Before PR B (writers) merges, the plan checks the CI publishing path:
`pages-deploy.yml` runs `main`, the pushers run the released action. If a released component would read a report or
update that `main` wrote in format 6, PR B waits for a release containing PR A (merging the release PR is the
maintainer's decision: that is a stop).

## 6. Maintainer decisions (2026-11-14)

1. Format 6 holds the stored share and drops `epochUnixNano` (#216: "remove it in format 6").
2. Format-6 URLs carry absolute times; the viewer's anchor is frozen at page load.
3. `otel-html run --append` exits non-zero when the append is refused (#216).
4. #212: a session opening with the default `assetsBase` when `assets/` points outside the report fails with
   `invalid-report`, as `upgrade` does; the message says to pass `--assets-base` or replace the link.

## 7. The PRs

- **A, read format 6:** manifest V6, the views, merge and the CI path accept format 6; the viewer's anchor and wide
  reports (#294); absolute URLs; the shared share module; the trace list uses an exact stored share. Tests write
  format-6 fixtures through a test helper, as the writer does not yet.
- **B, write format 6:** the share at flush and compaction, writer times (#216), append and upgrade, the frozen
  format-6 fixture, docs. Merges after A and after the rollout check.
- **C, the bug batch:**
  - **#241:** histogram and exponential-histogram `min`/`max`, and summary `sum` and quantile values, filter non-finite
    values per field in the cell aggregates (`src/query/sql/points.ts`), as the number cells do; a unit test per kind.
  - **#193:** `abort()` counts the session aborted only once the lock is released; a second `abort()` retries.
  - **#212:** as §6.4, for the partition session and `merge`'s output (no chunk writer session exists any more).
  - **#216 (2):** as §6.3.

## 8. Success

- On the scaling catalogue, `trace.share` leaves `KNOWN_DEBT`: on a format-6 report with exact shares it reads no
  spans. `trace.get` stays on the debt list under #291.
- `mise run predict:queries` on PR A's branch: the trace list's requests before (main) and after, in its body.
- Live, on the rolling `branch/main` report (the CI dashboard's), after the deployer writes format 6 and a compaction
  has folded the run traces: the trace list draws bars for run traces; the record gives requests and seconds for
  `#/dashboards/ci` and `#/traces?mode=traces` before and after. Per-run reports, whose traces are split over job
  updates, may keep falling back; that is accepted.
- Write cost, in PR B's body: a flush and a compaction of the e2e scale inputs, and a `merge --compact` of the
  `branch/main` mirror, wall and peak RSS before and after. The share may add up to 10 % to wall time; a peak-RSS rise
  above 25 % on the `branch/main` merge is a stop.

## 9. My calls, and what is left to the builder

My calls, from the builder check: the per-session writer anchor (no bigint records); the provisional flag in the shared
shape; compaction recomputes only traces split across inputs, format-5-only traces stay null; append upgrades a
format-5 manifest in place; the PR split of §7; #212 covers the partition session and `merge` only.

Left to the builder: the shared module's location and the minimal shape's name; how the list query exposes "exact";
whether the views use `union_by_name`; the empty-report anchor; how absolute times are spelled in the URL; the frozen
format-6 fixture's contents (as `fixtures/reports/README.md` describes); test names.
