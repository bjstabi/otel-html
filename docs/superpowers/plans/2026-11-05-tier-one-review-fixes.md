# Tier-one review fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ten tier-one review bugs (#134–#140, #142–#144) in four independent PRs.

**Architecture:** Each PR is one area of the codebase: the writer's metric pipeline, the ingest pre-pass, the
viewer's windowed scan, the Traces explorer's duration facet. No format, API or CLI change; every fix starts with
a failing test next to the existing tests for the same module.

**Tech Stack:** TypeScript strict, vitest, React (viewer), Biome, mise tasks.

**Spec:** `docs/superpowers/specs/2026-11-05-tier-one-review-fixes-design.md`

**PR process:** unattended (`docs/agents/process-unattended.md`). Implementers and task reviewers on Sonnet 5.5;
branch reviews on Opus 5.5.

## PR table

| section | branch                      | PR title                                                                                      | fixes            |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| PR 1    | `fix/writer-metrics`        | `fix(writer): cumulative summaries, long-series merges without spread, close() after a failed prune` | #134 #135 #136 |
| PR 2    | `fix/ingest-edges`          | `fix(model): empty documents in a receiver body, nested bounded repetition, snake_case OTLP JSON` | #137 #138 #139 |
| PR 3    | `fix/viewer-scan`           | `fix(viewer): a whole-run scan covers the run, scans follow the sort, facet caps come from the report` | #142 #143 #144 |
| PR 4    | `fix/viewer-duration-facet` | `fix(viewer): the Duration facet keeps its axis while a duration filter is set`               | #140             |

The PRs are independent: branch each from `main`, merge in any order. This plan and its spec land with PR 1.

## Global Constraints

- Before each commit: `pnpm exec biome check .` and `mise run typecheck`, run by hand. Before a push: `mise run check`.
  Before opening a PR: `mise run test:e2e:chromium` (the full Chromium suite).
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_013XfRWyLoGAw9kVjfvDerRv`.
- No `any`, no non-null assertions, no new dependency, no change to `src/api/index.ts` or `FORMAT_VERSION`.
- A behaviour the README documents changes in the same PR (grep the README in each task that says so).
- PR body: one `Fixes #N` line per issue; per issue what changed and what was decided against (copy the spec's
  **(call)** text); an **Also** list.

## Review Focus

1. A summary stream whose `sum` decreases while `count` grows (negative observations) must not be treated as a reset
   — pinned in Task 1.1.
2. A level-2 bucket that merges four differenced summary points must chart the sum of four deltas, not 4× a
   cumulative value — pinned in Task 1.1 (the `mergeAgg` assertion).
3. A receiver body of only whitespace must still be a 400, not an empty success — pinned in Task 2.1.
4. A span query sorted `start:desc` whose newest chunk has fewer than `limit` rows must keep scanning into the next
   newest chunk, not stop at the first chunk — pinned in Task 3.3.
5. Opening the Traces explorer from a URL whose condition already has a duration filter must show the committed range
   highlighted, not the whole strip — pinned in Task 4.2.

---

## PR 1 — `fix/writer-metrics`

### Task 1.1: Summaries are differenced like counters (#134)

**Files:**
- Modify: `src/rollups/metric-streams.ts` (RULES row for `summary` ~line 87; `prepare()` summary case ~451; a
  `diffSummary` beside `diffHist` ~312; an `asSummary` recall and `zeroSummary` baseline beside `asHist`/`emptyHist`)
- Test: `test/rollups/metric-streams.test.ts`
- Check: `README.md` — grep `summary`; if it describes summary `count`/`sum` as per-point values, say they are
  deltas per bucket like counters.

**Interfaces:**
- Produces: `diffSummary(cur: SummaryAgg, prev: SummaryAgg): SummaryAgg | null` (exported for the test).

- [ ] **Step 1: Write the failing tests** in `test/rollups/metric-streams.test.ts`, next to 'makes summaries from the point' (~line 234), using the file's `pt()` helper with `type: 'summary'`:

```ts
it('differences cumulative summaries and flags a reset', () => {
  // points at rel(1..4) with count 1000,1010,1020,1030 and sum 10,11,12,13, same start
  // expect deltas: first point count 1000 sum 10 (reset false), then {count:10,sum:1}, {count:10,sum:1}, {count:10,sum:1}
  // a fifth point with count 5 (< 1030) -> ok with count 5, reset: true
});
it('a summary sum that falls while count grows is a delta, not a reset', () => {
  // count 10 -> 20, sum 5 -> 3 : delta {count:10, sum:-2}, reset false
});
it('a summary with no start time starts from a zero baseline', () => {
  // start null, first point count 7 -> delta count 0 sum 0; second point count 9 -> count 2
});
it('continues a summary stream after toJSON and from', () => {
  // mirror the existing 'continues a stream after toJSON and from' test with summary points
});
it('merged summary deltas add', () => {
  // mergeAgg of two differenced summary aggs {count:10,sum:1} twice -> count 20 sum 2 (import mergeAgg from metric-agg)
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/rollups/metric-streams.test.ts` — expected: the new tests FAIL (the delta equals the cumulative value).

- [ ] **Step 3: Implement** per the spec: rule `cumulative: true`; `prepare()` summary case returns the `#cumulative` closure with `diffSummary`, `asSummary`, `zeroSummary`; `wrap` returns a summary agg as-is (like hist). `diffSummary` returns `null` iff `cur.count < prev.count`; otherwise `{ ...cur, count: cur.count - prev.count, sum: cur.sum - prev.sum }`. `zeroSummary(cur)` is `{ ...cur, count: 0, sum: 0 }`.

- [ ] **Step 4: Run** the file again — expected: PASS, including the existing 'makes summaries from the point' (adjust its expectation only if it asserted a second point's cumulative value).

- [ ] **Step 5:** README check per **Files**; `pnpm exec biome check .`; `mise run typecheck`; commit
  `fix(rollups): summary count and sum are cumulative and are differenced like counters`.

### Task 1.2: No spread-push over series-sized arrays (#135)

**Files:**
- Modify: `src/format/metric-files.ts:316-317`; `src/writer/metric-series-writer.ts:443`;
  `src/rollups/time-buckets.ts:150` and `:190`
- Test: `test/format/metric-files.test.ts`; `test/writer/metric-series.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
// test/format/metric-files.test.ts, next to 'mergeBucketSeries unions parts by series and bucket' (~228)
it('mergeBucketSeries merges a 150 000-bucket series without a stack overflow', () => {
  const n = 150_000;
  const piece = { id: 1, t: Array.from({ length: n }, (_, i) => i), a: Array.from({ length: n }, () => counterAgg(1)) };
  const out = mergeBucketSeries([[piece]], 'x');
  expect(out[0]?.t.length).toBe(n);
});
```

```ts
// test/writer/metric-series.test.ts, beside the demotion tests (~279-312): write an exemplar page holding
// 150_000 exemplars with the writer's own exemplar writer into the memory fs, then read it back through the
// same reader line 443 uses (find the function; it is the one called in the demotion loop).
it('reads an exemplar page of 150 000 exemplars without a stack overflow', async () => { /* … */ });
```

- [ ] **Step 2: Run** both files — expected: FAIL with `RangeError: Maximum call stack size exceeded`.

- [ ] **Step 3: Implement:** replace each `x.push(...y)` at the four sites with `for (const v of y) x.push(v)` (or a typed-array `set` where the target is one). Keep the comment at `metric-series-writer.ts:346`.

- [ ] **Step 4: Run** both files — expected: PASS in under 2 s each.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; commit
  `fix(writer): merge long bucket and exemplar lists without spreading into push`.

### Task 1.3: `close()` stays closed when prune fails (#136)

**Files:**
- Modify: `src/writer/session.ts:523-542`
- Test: `test/writer/session.test.ts` (next to 'a close that fails writing …' ~934)

**Interfaces:**
- Consumes: `createTestWriter()` from `test-support/writer-deps.ts` (`w.fs` is the memory fs; `w.logger` records
  calls — check the helper; if the fake logger does not record, add a `warns` array to it).

- [ ] **Step 1: Write the failing test.**

```ts
it('a close whose prune fails still closes the session and releases the lock', async () => {
  const w = createTestWriter();
  const s = await openSession(w /* as the neighbouring tests do */);
  await s.add(/* one metric request so data/metrics exists */);
  // leave an unlisted file under data/metrics/000000/ so prune has something to remove
  const remove = w.fs.remove.bind(w.fs);
  let failed = false;
  w.fs.remove = async (p) => { if (!failed && p.includes('data/metrics')) { failed = true; throw new Error('EBUSY'); } return remove(p); };
  const summary = await s.close();                       // resolves
  expect(w.logger.warns /* or equivalent */).toContainEqual(expect.objectContaining({ msg: expect.stringMatching(/stale metric segments/) }));
  await expect(s.add(/* anything */)).rejects.toThrow(/closed/);
  expect(await s.close()).toBe(summary);                  // no second run
  expect(await w.fs.exists(`${out}/.lock` /* the lock path the lock tests use */)).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/writer/session.test.ts -t "prune fails"` — expected: FAIL (`close()` rejects with EBUSY).

- [ ] **Step 3: Implement** per the spec: after `#checkpoint(true)`, set `this.#closed = this.#summary()`; then `try { await this.#series.prune(); } catch (e) { this.#deps.logger.warn('stale metric segments left behind', { error: … }); } finally { await this.#lock.release(); }`; return `this.#closed`. Match how the existing `logger.error` calls at ~802/837 shape their context object.

- [ ] **Step 4: Run** the file — expected: PASS, including the existing close-retry test.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; `mise run check`; commit
  `fix(writer): a close whose prune fails is still closed and logs the stale segments`.

### Task 1.4: Open PR 1

- [ ] Add this plan and its spec to the branch (`git add docs/superpowers/...`; commit `docs: tier-one review fixes spec and plan`).
- [ ] `mise run check`, then `mise run test:e2e:chromium`; both green.
- [ ] Branch review (Opus 5.5) over `git diff main...HEAD` with the spec's PR 1 section; fix anything blocking.
- [ ] `gh pr create` with the table's title; body per Global Constraints, plus: "Old reports keep their stored summary values; an append treats the first new summary point as a first point." Also list: time-buckets spread sites.
- [ ] CI green → `gh pr merge <n> --squash --delete-branch`.

---

## PR 2 — `fix/ingest-edges`

### Task 2.1: Empty documents in a receiver body (#137)

**Files:**
- Modify: `src/model/otlp-json-stream.ts` (options type; `#endDocument` ~314); `src/receiver/receiver.ts:89-106`
- Test: `test/model/otlp-stream.test.ts`; `test/receiver/receiver.test.ts`

**Interfaces:**
- Produces: `new OtlpJsonStream(source, { lines: boolean; allowEmpty?: boolean })`.

- [ ] **Step 1: Write the failing tests.**

```ts
// test/model/otlp-stream.test.ts, next to the `{}\n{}` cases (~216)
it('allowEmpty accepts a document with no signal as empty', () => {
  const s = new OtlpJsonStream('in.json', { lines: false, allowEmpty: true });
  const out = s.push('{"resourceSpans":[]}\n{}');  s.end();
  expect(out.length).toBe(/* the entries of the first document, as the ~220 test counts them */);
  const e = new OtlpJsonStream('in.json', { lines: false, allowEmpty: true });
  expect(e.push('{}')).toEqual([]); expect(() => e.end()).not.toThrow();
});
it('without allowEmpty a no-signal document still throws', () => { /* `{}` throws /expected at least one of/ */ });
```

```ts
// test/receiver/receiver.test.ts, next to 'empty and signal-less bodies' (~185); build bodies with encode(string)
it('keeps the entries of the other documents when one document has no signal', async () => {
  // '{"resourceLogs":[…one record…]} {}'  -> accepted 1, errorMessage null
  // '{} {"resourceLogs":[…one record…]}'  -> accepted 1
});
it('a whitespace-only body is a refusal', async () => { /* '  \n' -> failure(...) matches /no JSON object/ */ });
```

- [ ] **Step 2: Run** both files — expected: new tests FAIL.

- [ ] **Step 3: Implement:** the option; `#endDocument` skips `noSignal` when `allowEmpty`; the receiver constructs the stream with `allowEmpty: true` and removes the `try/catch` (keep the signal-mismatch check).

- [ ] **Step 4: Run** both files — expected: PASS, including the existing `{}` tests.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; commit
  `fix(receiver): a no-signal document in a multi-document body no longer drops the others`.

### Task 2.2: Nested bounded repetition is rejected (#138)

**Files:**
- Modify: `src/ottl/converters.ts:29-99`
- Test: `test/ottl/compile.test.ts` (the `test.each` lists at ~84 and ~90)

- [ ] **Step 1: Extend the tests:** add to the rejected list `(a+){2,20}`, `(a{1,64}){1,64}`,
  `(a+){5}`; add to the accepted list `(\d+\.){3}\d+`, `(a+){4}`, `(ab){2,5}`, `(a?){20}`. Add one assertion that
  the error message for `(a+){2,20}` matches `/nested repetition/` and `/\[a-z\]\{1,64\}/`.

- [ ] **Step 2: Run** `pnpm exec vitest run test/ottl/compile.test.ts` — expected: the three new rejects FAIL (accepted today).

- [ ] **Step 3: Implement:** frames record `repeats` (the group contains a quantifier with max > 1); a quantifier's max is `Infinity` for `*`, `+`, `{n,}`, `n` for `{n}`, `m` for `{n,m}`, `1` for `?`; on `)` a repeating group marks its parent and sets `lastAtomRepeatGroup`; a quantifier with max > 4 after such an atom returns the new message from the spec.

- [ ] **Step 4: Run** the file — expected: PASS.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; commit
  `fix(ottl): the regex guard rejects bounded repetition over a repeating group`.

### Task 2.3: snake_case OTLP JSON (#139)

**Files:**
- Modify: `src/model/otlp-json.ts` (`INT64_FIELDS` ~30, `ID_FIELD_LENGTHS` ~46, `signalEntry` ~77); `README.md`
  (the OTLP/JSON sentence: both lowerCamelCase and snake_case field names are accepted)
- Test: `test/model/otlp-json.test.ts`; `test/model/otlp-stream.test.ts`

- [ ] **Step 1: Write the failing tests** (mirror the camelCase ones at ~76 and ~109):

```ts
it('keeps a snake_case int64 above 2^53 exact', () => { /* time_unix_nano: 1700000000000000123 -> record time 1700000000000000123n (or the string the camel test compares) */ });
it('normalises a snake_case hex trace id', () => { /* trace_id uppercase hex -> same record as traceId */ });
it('accepts snake_case top-level signal keys', () => { /* {"resource_spans":[…]} through parseOtlpObject -> one request with signal 'traces' */ });
// otlp-stream.test.ts: '{"resource_logs":[…]}' yields the logs entry instead of noSignal
```

- [ ] **Step 2: Run** both files — expected: FAIL.

- [ ] **Step 3: Implement** the map/set additions and `signalEntry`'s three extra keys (both spellings map to the same `OtlpSignal`).

- [ ] **Step 4: Run** `pnpm exec vitest run test/model` — expected: PASS, including `otlp-json-metrics.test.ts` parity.

- [ ] **Step 5:** README; `pnpm exec biome check .`; `mise run typecheck`; `mise run check`; commit
  `fix(model): snake_case OTLP JSON keeps int64 exact and reads hex ids`.

### Task 2.4: Open PR 2

- [ ] `mise run check`; `mise run test:e2e:chromium`.
- [ ] Branch review (Opus 5.5) with the spec's PR 2 section; fix blocking findings.
- [ ] `gh pr create` (table title; body per Global Constraints). CI green → squash-merge.

---

## PR 3 — `fix/viewer-scan`

### Task 3.1: `TopKBuffer` shared by spans and logs (#142, part)

**Files:**
- Modify: `src/viewer/data/top-k.ts`; `src/viewer/data/span-query.ts` (`#rows`, `#bound`, `visit` ~287, `finish` ~309, `heldRows` ~254); `src/viewer/data/log-query.ts` (`#matched` ~302, `visit` ~336, `finish` ~384)
- Test: `test/viewer/top-k.test.ts` (create if absent); `test/viewer/span-query.test.ts` (~183); `test/viewer/log-query.test.ts`

**Interfaces:**
- Produces: `class TopKBuffer<T> { constructor(limit: number, compare: (a: T, b: T) => number); push(item: T): void; get size(): number; take(): T[] }` with bound `limit + Math.max(limit, 1024)`; `take()` returns the best `limit` in order (equivalent to `topK(all, limit, compare)`), and `LogQueryRun.heldRows` (test-only, like the span one).

- [ ] **Step 1: Write the failing tests.**

```ts
// test/viewer/top-k.test.ts
it('TopKBuffer.take equals topK over everything pushed', () => { /* 5000 random numbers, limit 7, compare asc; and limit 0 -> [] */ });
it('TopKBuffer holds at most limit + max(limit, 1024)', () => { /* limit 1: push 10_000, size <= 1025 throughout */ });
// test/viewer/log-query.test.ts
it('logs mode holds at most limit plus the compaction slack', () => { /* mirror span-query.test.ts:183 with queryLogEntries, heldRows <= 1 + 1024, total === 10_000 */ });
```

- [ ] **Step 2: Run** — expected: top-k tests FAIL (no export); log test FAIL (`heldRows` undefined / 10_000 held).

- [ ] **Step 3: Implement** `TopKBuffer`; replace the span run's `#rows`/`#bound`/compaction with it (spans mode only; `#order !== null`); replace `LogQueryRun.#matched` with a buffer built from `ordered(dir, sort.compare, byTimeThenRef)` in logs mode; `finish` logs case: `rows = buffer.take()`, `total = this.#count`.

- [ ] **Step 4: Run** `pnpm exec vitest run test/viewer/top-k.test.ts test/viewer/span-query.test.ts test/viewer/log-query.test.ts` — expected: PASS.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; commit
  `refactor(viewer): a TopKBuffer bounds the matched rows of span and log queries`.

### Task 3.2: A whole-run scan is exact and uncapped outside traces mode (#142)

**Files:**
- Modify: `src/viewer/data/chunk-window.ts:110-135`; `src/viewer/data/windowed.ts:69`; `src/viewer/data/log-windowed.ts:94`; `src/viewer/components/explorer-states.tsx` only if its copy mentions rows
- Test: `test/viewer/data-source.test.ts` (~218-251); `test/viewer/log-data-source.test.ts` (~557)

- [ ] **Step 1: Write the failing tests** (use the files' `windowed()`, `query()`, `listCap` override patterns):

```ts
// data-source.test.ts
it('scanAll without a measure lists the best rows over the whole run and is exact', async () => {
  // listCap 4, no window, sort duration desc, scanAll: partial null; rows.length 4; rows equal the eager source's top 4; total === totals.spans
});
it('a run that matches exactly listCap units over every chunk is exact', async () => {
  // listCap 2, ERRORS condition (2 matches), no window, no scanAll: partial null
});
// log-data-source.test.ts
it('scanAll in logs mode is not cut at listCap', async () => {
  // listCap 3, scanAll, severity >= 0: partial null, matched === manifest.totals.logs, rows.length 3
});
```

- [ ] **Step 2: Run** — expected: FAIL (partial non-null).

- [ ] **Step 3: Implement:** in `scanChunks`, a `cut` flag set when the per-entry cap check breaks a chunk or when the chunk loop stops with targets remaining; `exact = scanned.size === total && !cut`. In both windowed sources: `cap: q.scanAll && q.mode !== 'traces' ? Number.POSITIVE_INFINITY : cap` (keeps the `measureBy` case covered).

- [ ] **Step 4: Run** both files — expected: PASS, including the existing scanAll and `listCap 4` tests.

- [ ] **Step 5:** grep README for "Scan entire run"; update if it says the list stays a head. `pnpm exec biome check .`; `mise run typecheck`; commit
  `fix(viewer): a whole-run scan lists the best rows over the run and is exact when it read everything`.

### Task 3.3: Span scans follow a `start:desc` sort (#143)

**Files:**
- Modify: `src/viewer/data/windowed.ts:59-75`
- Test: `test/viewer/data-source.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
it('a start:desc head scans the newest chunks first', async () => {
  // listCap 4, sort {column:'start', dir:'desc'}, no filter, windowed(): rows equal the eager source's 4 newest spans;
  // loader.calls[0] is chunkPath(5) (the last chunk)
});
it('a start:desc head keeps reading into older chunks until the cap', async () => {
  // listCap larger than the newest chunk's span count (e.g. 3 when each trace chunk has 2 spans): rows come from chunks 5 and 4
});
```

- [ ] **Step 2: Run** — expected: FAIL (rows are the oldest chunks').

- [ ] **Step 3: Implement:** `const newest = q.sort.column === 'start' && q.sort.dir === 'desc';` targets sorted by `end` desc then `n` desc when `newest`; `finishChunk: q.mode === 'traces' || newest`.

- [ ] **Step 4: Run** the file — expected: PASS.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; commit
  `fix(viewer): a start-descending span scan reads the newest chunks first`.

### Task 3.4: Facet caps come from the report (#144)

**Files:**
- Modify: `src/viewer/data/query-common.ts`; `src/viewer/data/load.ts:57`; `src/viewer/data/log-load.ts:49`; `src/viewer/data/span-query.ts` (constructor, `#rollups`, `#groups` ~207/230, `querySpanEntries`); `src/viewer/data/log-query.ts` (constructor ~311, `queryLogEntries`); `src/viewer/data/eager.ts`; `src/viewer/data/log-eager.ts`; `src/viewer/data/windowed.ts`; `src/viewer/data/log-windowed.ts`; `src/viewer/data/data-source.ts` (~277-300); the two test imports of `QUERY_FACET_CAPS` (`test/viewer/logs-explorer.test.tsx:23`, `test/writer/helpers.ts:16`)
- Test: `test/viewer/load.test.ts` (or where `loadSpanRollups` is tested); `test/viewer/span-query.test.ts`; `test/viewer/data-source.test.ts`

**Interfaces:**
- Produces: `export interface FacetCaps { facetValueCap: number; facetKeyCap: number }`, `export const DEFAULT_FACET_CAPS: FacetCaps`; `new SpanQueryRun(q, signal, caps)`, `new LogQueryRun(q, signal, caps)`, `querySpanEntries(entries, q, signal, caps = DEFAULT_FACET_CAPS)`, `queryLogEntries(…, caps = DEFAULT_FACET_CAPS)`, `createEagerSource(loader, manifest, caps)`, `createEagerLogSource(loader, manifest, caps: () => Promise<FacetCaps>)`, `createWindowedSource(loader, manifest, rollups, index)` reads caps from `rollups.facets`, `createWindowedLogSource` reads them from the lazy rollups.

- [ ] **Step 1: Write the failing tests.**

```ts
// where loadSpanRollups is tested: a report written with writer.facetValueCap 2 (extend test/viewer/report-fixture.ts buildReport with a config override if it has none) loads rollups whose facets.valueCap === 2
// span-query.test.ts: querySpanEntries(entries, q, undefined, { facetValueCap: 2, facetKeyCap: 500 }) over spans with 3 distinct service names -> result.facets.valueCap === 2 and the third value is folded as the FacetCounts tests describe
// data-source.test.ts: a filtered windowed query on the facetValueCap-2 report has result.facets.valueCap === 2
```

- [ ] **Step 2: Run** — expected: FAIL (1000).

- [ ] **Step 3: Implement** per the Interfaces block; `data-source.ts` builds `caps` from `rollups.facets.valueCap/keyCap` once rollups are loaded and passes them to the eager source (the `Promise.all` at ~296 becomes: load rollups, then create the eager source with the caps) and the log equivalents through `getLogRollups`.

- [ ] **Step 4: Run** `pnpm exec vitest run test/viewer` — expected: PASS.

- [ ] **Step 5:** grep README for `facetValueCap`; its row should say the cap also bounds filtered facets in the viewer. `pnpm exec biome check .`; `mise run typecheck`; `mise run check`; commit
  `fix(viewer): filtered facets and measure groups use the report's facet caps`.

### Task 3.5: Open PR 3

- [ ] `mise run check`; `mise run test:e2e:chromium`.
- [ ] Branch review (Opus 5.5) with the spec's PR 3 section; fix blocking findings.
- [ ] `gh pr create` (table title; body per Global Constraints; state that traces modes keep the cap, #151). CI green → squash-merge.

---

## PR 4 — `fix/viewer-duration-facet`

### Task 4.1: A duration axis separate from its counts (#140, part)

**Files:**
- Modify: `src/viewer/traces/views.ts` (~187-215)
- Test: the test file that covers `durationBins` (grep `durationBins` under `test/viewer`; create `test/viewer/traces-views.test.ts` if none)

**Interfaces:**
- Produces: `durationAxis(rows: readonly { durationNs: number }[], binCount: number, range?: { lo?: number; hi?: number }): number[]` (edges, length `binCount + 1`; `range.lo` becomes `edges[0]` and `range.hi` becomes `edges[binCount]` exactly when given; the rest log-spaced between them as today); `binsOnAxis(rows, edges: readonly number[]): DurationBin[]` (`[from, to)` per bin; a row below the first edge counts in bin 0, at or above the last edge in the last bin); `durationBins(rows, binCount)` unchanged in signature, now `binsOnAxis(rows, durationAxis(rows, binCount))`.

- [ ] **Step 1: Write the failing tests.**

```ts
it('durationAxis with a range puts lo and hi on the first and last edge exactly', () => { /* rows 2e6..9e6, range {lo: 1e6, hi: 1e7}: edges[0] === 1e6, edges.at(-1) === 1e7, length 25 */ });
it('binsOnAxis counts rows into given edges and clamps outliers', () => { /* edges [0,10,100], rows 5, 50, 500, -1 -> counts [2,2] */ });
it('durationBins equals binsOnAxis over durationAxis', () => { /* same rows, deep-equal */ });
```

- [ ] **Step 2: Run** — expected: FAIL (no export).

- [ ] **Step 3: Implement** per Interfaces; keep `edges[0] = min(floor, lo)` only when no `range.lo`.

- [ ] **Step 4: Run** — expected: PASS, and the existing duration-bin tests unchanged.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; commit
  `refactor(viewer): durationAxis and binsOnAxis split the duration histogram's edges from its counts`.

### Task 4.2: The explorer keeps the axis; the facet finds its committed bins (#140)

**Files:**
- Modify: `src/viewer/traces/explorer.tsx` (~236); `src/viewer/components/facet-panel.tsx` (`DurationFacet` ~281-369: `committedLo`/`hiIndex`)
- Test: `test/viewer/facet-panel.test.tsx` (~113); `test/viewer/traces-explorer.test.tsx` (grep for the explorer's existing test file; create next to `logs-explorer.test.tsx` if none, using its render helpers)

**Interfaces:**
- Consumes: Task 4.1's `durationAxis`, `binsOnAxis`; the token parser `FacetPanel` already uses from `src/viewer/components/filter-tokens.ts` and `DURATION_KEY`.

- [ ] **Step 1: Write the failing tests.**

```ts
// facet-panel.test.tsx
it('a committed value inside a bin selects that bin', () => {
  // bins [0,1e6) [1e6,1e7) [1e7,1e8); condition '… >= 5000000 and … <= 50000000' (not edges):
  // Minimum slider aria-valuenow 1, Maximum slider aria-valuenow 2
});
// traces-explorer.test.tsx
it('the duration axis stays put while a duration filter is set', async () => {
  // render the explorer on a fixture with varied durations; read the Minimum slider; ArrowRight twice;
  // the condition ends with '>= <edges[2]>' (the second press moved on the same axis), and the bar titles' first bin
  // still starts at the pre-filter first edge
});
it('a page opened with a duration filter in its condition highlights the committed range', async () => {
  // initial condition '… >= A and … <= B' where A/B are not edges: the Minimum slider's aria-valuenow is > 0
  // or the Maximum's is < last (the strip is not fully highlighted), and ArrowLeft on Minimum does not remove the '<=' token
});
```

- [ ] **Step 2: Run** — expected: FAIL (second press writes a re-binned edge; strip fully highlighted).

- [ ] **Step 3: Implement:** in the explorer, `const durationTokens = tokens.filter(t => t.key === DURATION_KEY)` from the parsed condition; an `axisRef`; `bins = useMemo(...)`: no duration tokens → `axis = durationAxis(rows, N)`, store; duration tokens and a stored axis → reuse; duration tokens and none stored → `durationAxis(rows, N, { lo: >= value, hi: <= value })`, store; return `binsOnAxis(rows, axis)`. In `DurationFacet`, the tolerant lookups from the spec (equal edge, else containing bin, else 0 / last).

- [ ] **Step 4: Run** `pnpm exec vitest run test/viewer/facet-panel.test.tsx test/viewer/traces-explorer.test.tsx` — expected: PASS, including the existing 'duration range writes span duration tokens' test.

- [ ] **Step 5:** `pnpm exec biome check .`; `mise run typecheck`; `mise run check`; commit
  `fix(viewer): the Duration facet keeps its axis while a duration filter is set`.

### Task 4.3: Open PR 4

- [ ] `mise run check`; `mise run test:e2e:chromium` (the traces explorer specs exercise the facet panel).
- [ ] Branch review (Opus 5.5) with the spec's PR 4 section; fix blocking findings.
- [ ] `gh pr create` (table title; body per Global Constraints; note #141 is untouched). CI green → squash-merge.

---

## Final summary (coordinator)

One message: each PR's number and title; the issues closed; #133 and #141 left for the maintainer with the reason;
anything stopped on.
