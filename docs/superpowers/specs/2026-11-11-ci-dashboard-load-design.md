# The CI dashboard on branch/main: what it reads and why (issue #270)

Issue #270: `https://bjstabi.github.io/otel-html/branch/main/#/dashboards/ci` (rolling `site` report, viewer 0.2.1,
3,061,991 spans, 293,545 logs, 747 metric points, 13 partitions) takes about 25 s and reads 114 MB. Measured on
2026-11-11 against the live page (24.0 s, 1,113 requests, 114.1 MB) and against a byte-for-byte local mirror served
over HTTP with range requests (11.1 s, 1,150 Parquet requests, 118.3 MB, 132 worker statements). The per-cause numbers
below are cold, isolated statements in the page's own DuckDB worker on the local mirror.

## Causes

| # | cause | today | fix | after |
| - | ----- | ----- | --- | ----- |
| 1 | The three variable-value statements each JSON-extract `resource_attributes` for every span, log and point, and no widget query starts before they finish (the worker runs statements serially). | 5.8 s of worker time (2.3 s + 1.6 s + 1.6 s), 2.7 MB | Take the distinct `resource_attributes` texts first (1,422 over the 3.06 M spans), extract from those. | 0.29 s + 0.05 s + 0.05 s, the same 2.7 MB |
| 2 | The timeline widget's span statement computes `quantile_cont(duration_ns)` and `max(duration_ns)` per bucket; the widget draws only the counts by status. | 44.9 MB, 418 requests, 1.0 s | A `buckets` need that leaves the latency columns out. | 24.4 MB, 295 requests, 0.64 s |
| 3 | Steps and Slowest steps read one full span row (every column, `limit 1`) only to learn the match count for their subtitle. | 15.1 MB, 103 requests, 0.30 s | A `total` need: one `count(*)`. | 3.8 MB, 77 requests, 0.18 s |
| 4 | The Runs condition is a top-level `or`, so no term can prune: `attributes`, `parent_span_id` (and `span_id` by read-ahead) are read for all spans. | 66.1 MB, 397 requests, 3.2 s | Prefix `instrumentation_scope.name == "otel-html-ci" and`: in every partition the CI spans sit in one row group, and the row groups that hold only test spans are skipped by their `scope_name` statistics. | 7.8 MB, 151 requests, 0.32 s |
| 5 | Found by the first whole-dashboard measurement of fixes 1 to 4. Each visible row of a trace list loads its whole trace, every column, to draw "Latency by service". Before fix 4 the Runs list showed orphan test traces of one span; scoped to the CI runs, six of its visible rows are traces of 97,000 to 145,000 spans, spread over nearly every row group of their partition. | 73.3 MB, 199 requests and 2.9 s of worker time for six rows (the dashboard as a whole: 116.5 MB, 926 requests, 6.4 to 10.4 s) | The cell does not load a trace of more than 10,000 spans and says so in its title. | 0 |

The optimizer note behind fix 1: with DuckDB-WASM 1.32 an outer `WHERE value IS NOT NULL AND kind IN (...)` is pushed
below a per-table `SELECT DISTINCT resource_attributes` (and into a `MATERIALIZED` CTE), which puts the JSON extraction
back on every row. The statement therefore carries no `WHERE` at all: the two conditions move into `FILTER` clauses of
the final aggregates and a `HAVING`, which cannot be pushed below the distinct.

## What the Runs widget listed (and the orphan test spans)

92 % of the spans (2,825,778) are inside the 38 CI-run traces. The widget listed 8,623 rows: the 38 runs and 8,585
single-span traces of service `otel-html-tests`, 379 to 537 per run. Reproduced locally (`otel-html run -- pnpm exec
vitest run <four files>`: 158 roots beside the run's own):

- **vitest**: `test/test-support/otel-sdk.test.ts` and `test/viewer/open-report.test.ts` call `context.disable()` on
  the worker's OpenTelemetry globals in `beforeEach`/`afterEach`. That calls `disable()` on vitest's own
  `AsyncLocalStorage` context manager, which exits every in-flight context for good, so every later vitest span in
  that worker starts a trace of its own. Vitest also starts its `test.callback` and `test.afterEach` spans between the
  hooks, so a swap done in hooks leaves roots even when it is not destructive. Fix: swap the globals inside the test
  body, without disabling the manager that was registered (take it out of the API's global slot, put the same
  instance back). Prototype: 158 roots → 1.
- **`lost`** (the 1 left): the "unreachable endpoint" test passes its endpoint in the `env` argument, but the OTLP
  exporter reads `process.env`, so under CI the span is exported to the real collector. Fix in the test: stub the
  process environment.
- **Playwright**: `e2e/scale.spec.ts` writes the metrics scale report in the worker process (`ensureMetricsScaleReport`
  in `beforeAll`). The worker has a global SDK, no span is active, so the writer's `otel-html.flush` (62 per run) and
  `otel-html.compact` spans are roots. Fix: run the write inside a span parented to the job's `TRACEPARENT`.

Two traces have no root because the run span never arrived (86,250 and 141,378 spans); that is not a test defect and
stays as it is.

## Decisions (maintainer, 2026-11-11)

- PR process: unattended. One PR.
- Scope: viewer fixes only; the Runs condition is scoped in `.github/otel-html-ci.yaml` and in the publish action's
  copy (`.github/actions/otel-html-publish/otel-html-ci.yaml`, approved explicitly), and the orphan test spans are
  fixed in the same PR.
- Coordinator's decision on cause 5 (2026-11-11, under the unattended process; the maintainer was not asked): the
  span cap. This report's traces are either under 1,200 spans or over 97,000 (28 of 8,625 are over 5,000), and a row
  group holds 50,000 spans, so 10,000 separates the two without touching ordinary traces. Narrowing the read to the
  five columns the computation needs was measured from the column attribution and would still read about 70 % of
  the bytes (the ids and times of every span). Follow-up issue: the writer can store the per-trace share in
  `traces.parquet`, which gives large traces their bar back without a read.
- Follow-up issues, not this PR: the test-span volume of the rolling report and its default window (the unfiltered
  span timeline still reads about 24 MB to count 3 M spans, 96 % of them vitest's; a window can prune spans files
  only by `timeMin`, there is no end-time statistic); the `null` `resource:cicd.pipeline.*` statistics on merged
  spans files (`run-report.ts` normalises with `?? null`), so a workflow, run or job selection prunes no spans file.

## Not done, on purpose

- Widgets stay gated on the variable values (they take 0.4 s now).
- Log facet widgets keep reading one row for their total: the CI dashboard has none, and the log result's
  `total`/`matched` pair needs its own look.
- One statement per variable stays (the second and third cost 50 ms on cached buffers).

## Expected result (local mirror, the dashboard settled)

At most 60 MB of Parquet (118.3 MB today), at most 750 Parquet requests (1,150), at most 5 s (11.1 s).
