# CI dashboard load (issue #270) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The CI dashboard of the rolling report reads about a third of the bytes and settles in under half the time, and the test spans of a CI run stay inside the run's trace.

**Architecture:** Four independent query-shape fixes (variable values from distinct resource texts; a `buckets` span need without latency columns; a `total` span need that counts instead of reading a row; the Runs condition scoped to the CI instrumentation scope) and one test-infrastructure fix (tests that need their own OpenTelemetry globals swap them inside the test body without disabling vitest's context manager; the in-worker report write of the Playwright scale spec runs inside a span).

**Tech Stack:** TypeScript strict, the `Query` SQL builder in `src/query/sql/`, DuckDB (node in unit tests, WASM in the viewer), vitest 5 with `experimental.openTelemetry`, Playwright.

**Spec:** [docs/superpowers/specs/2026-11-11-ci-dashboard-load-design.md](../specs/2026-11-11-ci-dashboard-load-design.md) (the measured causes; read it first).

**PR process:** unattended ([docs/agents/process-unattended.md](../../agents/process-unattended.md)). One PR.

| branch | PR title |
| ------ | -------- |
| `fix/ci-dashboard-load` | `fix(viewer): dashboard variables and widgets read only what they draw` |

## Global Constraints

- [docs/agents/conventions.md](../../agents/conventions.md) applies: TDD per task (failing test first, see it fail), conventional commits with the session's trailers, no `any`, no non-null assertions, no new dependency.
- No change to the public API (`src/api/index.ts`), the report format or a CLI flag. `SpanNeed` is a viewer-internal type.
- Before each commit: `pnpm exec biome check .` and `mise run typecheck`, each run on its own; then `mise run check`.
- Never loosen a `@perf` budget. Never run locally: the three-browser matrix, metrics-scale, the binaries.
- The only files under `.github/` this plan touches are the two `otel-html-ci.yaml` copies (Task 4). The maintainer approved the publish action's copy explicitly.

## Review Focus

1. A resource attribute whose text appears as a scalar under one resource and as a list under another is listed once, with the scalar's kind (Task 1 pins it).
2. `needs: ['timeline', 'buckets']` runs one statement and still fills the latency series (Task 2 pins it).
3. A condition the browser evaluates (`Len(name) > 7`) gives the `total` need the same count the `rows` need reports (Task 3 pins it).
4. A root span of another instrumentation scope (`vitest`) is not a Runs row; a run whose root never arrived is still listed through its job spans (Task 4 pins both).
5. A test that throws inside `withOwnOtelGlobals` still gets the earlier globals back (Task 5 pins it).

---

### Task 1: Variable values from the distinct resource texts

**Files:**
- Modify: `src/query/sql/spans.ts` (`resourceValuesQuery`)
- Test: `test/query/sql/spans.test.ts`, `test/viewer-data/duckdb-source-logs.test.ts`

**Interfaces:**
- Produces: `resourceValuesQuery(key: string, cap: number): Query`, unchanged signature and result columns (`value`, `kind`).

- [ ] **Step 1: Write the failing tests**

In `test/query/sql/spans.test.ts`, beside the existing `resourceValuesQuery` test:

```ts
test('resourceValuesQuery reads each resource text once and has no predicate a scan could take', () => {
  const text = toSql(resourceValuesQuery('host.name', 5));
  // The conditions live in aggregate FILTERs and a HAVING: a WHERE is pushed below the distinct, back onto every row.
  expect(text.replaceAll('FILTER (WHERE', '')).not.toMatch(/\bWHERE\b/);
  expect(text).toMatch(/\bHAVING\b/);
  for (const table of ['spans', 'logs', 'points'])
    expect(text.split(`SELECT "resource_attributes" FROM "${table}"`)).toHaveLength(2);
  expect(text.split('json_extract_string(').length).toBeLessThan(6); // extracted once over the union, not once per table
});
```

In `test/viewer-data/duckdb-source-logs.test.ts`, in the test that builds its own source for `resourceValues('port')` (around line 540): give one resource `tag: '["a"]'` (a string) and another `tag: ['a']` (a list), and assert `await source.resourceValues('tag')` equals `{ values: ['["a"]'], kind: 'string', capped: false }`. If adding the attribute to that fixture changes other assertions of the same test, build a second small source the same way instead.

- [ ] **Step 2: Run them and see the first fail**

Run: `pnpm exec vitest run test/query/sql/spans.test.ts test/viewer-data/duckdb-source-logs.test.ts -t resourceValues`
Expected: the SQL-shape test FAILS (the statement has a `WHERE`). The mixed-kind test passes already; it pins the semantics the rewrite must keep.

- [ ] **Step 3: Rewrite `resourceValuesQuery`**

The statement, with `S` standing for `kind IN ('string', 'int', 'double', 'bool')` and the two expressions being the ones the function uses today (`jsonStringAt('resource_attributes', [key])`, `jsonKind(jsonAt('resource_attributes', [key]))`):

```sql
SELECT "value",
       CASE WHEN min(kind) FILTER (WHERE S) = max(kind) FILTER (WHERE S)
            THEN min(kind) FILTER (WHERE S) ELSE 'mixed' END AS "kind"
FROM (SELECT <value expr> AS "value", <kind expr> AS "kind"
      FROM (SELECT "resource_attributes" FROM "spans"
            UNION SELECT "resource_attributes" FROM "logs"
            UNION SELECT "resource_attributes" FROM "points") AS "r") AS "u"
GROUP BY "value"
HAVING count(*) FILTER (WHERE value IS NOT NULL AND S) > 0
ORDER BY "value"
LIMIT cap + 1
```

Update the doc comment: say that the distinct texts are taken first and why there is no `WHERE` (the optimizer pushes it below the distinct; issue #270).

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run test/query/sql/spans.test.ts test/viewer-data/duckdb-source-logs.test.ts test/viewer-data/refresh-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`fix(viewer): variable values are extracted from the distinct resource texts`

---

### Task 2: A `buckets` span need without the latency columns

**Files:**
- Modify: `src/viewer/data/results.ts` (`SpanNeed`), `src/query/sql/spans.ts` (`timelineQuery`), `src/viewer/data/span-results.ts` (`timeline`), `src/viewer/data/duckdb-source.ts` (`querySpans`, `AGGREGATE_NEEDS`), `src/viewer/dashboards/widgets/timeline.tsx`
- Test: `test/query/sql/spans.test.ts`, `test/viewer-data/duckdb-source-spans.test.ts`, `test/viewer/fusion-timeline.test.tsx`

**Interfaces:**
- Produces: `type SpanNeed = 'rows' | 'facets' | 'timeline' | 'buckets' | 'durations' | 'groups'` (Task 3 adds `'total'`); `timelineQuery(f: SqlFilter, spec: BucketSpec, latency = true): Query`.
- `buckets` fills `SpanQueryResult.buckets` only; `red` keeps its empty value. With `timeline` also asked, the `timeline` statement alone runs.

- [ ] **Step 1: Write the failing tests**

`test/query/sql/spans.test.ts`, in `describe('timeline and durations')`, same `window`/`spec` as the existing timeline test:

```ts
test('timelineQuery without latency gives the same counts and never reads duration_ns', () => {
  const q = timelineQuery(w, spec, false);
  expect(toSql(q)).not.toContain('duration_ns');
  const rows = run(q);
  expect(rows.map((r) => [r.bucket, r.n, r.errors])).toEqual([
    [15_000_000n, 2n, 0n],
    [19_000_000n, 1n, 1n],
    [60_000_000n, 1n, 0n],
  ]);
  expect(rows[0]).toMatchObject({ ok: 0n, error: 0n, unset: 2n });
  expect(Object.keys(rows[0] ?? {})).not.toContain('quantiles');
});
```

`test/viewer-data/duckdb-source-spans.test.ts` (uses the file's `query`, `counted`, `ds`):

```ts
test('needs ["buckets"] sends one statement and fills the buckets only; with "timeline" the latency comes too', async () => {
  const full = await ds.querySpans(query({ needs: ['timeline'] }));
  const only = await counted(() => ds.querySpans(query({ needs: ['buckets'] })));
  expect(only.arrow).toBe(1);
  expect(only.result.buckets).toEqual(full.buckets);
  expect(only.result.red.counts).toEqual([]);
  const both = await counted(() => ds.querySpans(query({ needs: ['timeline', 'buckets'] })));
  expect(both.arrow).toBe(1);
  expect(both.result.red).toEqual(full.red);
  const residual = { condition: 'Len(name) > 7' };
  expect((await ds.querySpans(query({ ...residual, needs: ['buckets'] }))).buckets).toEqual(
    (await ds.querySpans(query({ ...residual, needs: ['timeline'] }))).buckets,
  );
});
```

(Adapt `only.result` / `only.arrow` to what `counted` returns in that file.)

`test/viewer/fusion-timeline.test.tsx` line 385: the span query's needs are `['buckets']`; the log query's stay `['timeline']`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run test/query/sql/spans.test.ts test/viewer-data/duckdb-source-spans.test.ts test/viewer/fusion-timeline.test.tsx`
Expected: FAIL (typecheck or assertion: no third parameter, no `buckets` need).

- [ ] **Step 3: Implement**

- `timelineQuery(f, spec, latency = true)`: `quantiles` and `max_duration_ns` are selected only when `latency`.
- `timeline(t, spec)` in `span-results.ts` gains a sibling `timelineBuckets(t, spec): TimeBuckets<SpanStatusKey>` (or `timeline` shares its bucket half with it); the counts-only table has no latency columns to read.
- `querySpans`: `buckets` joins `AGGREGATE_NEEDS`; when `needs.has('buckets') && !needs.has('timeline')` it runs `timelineQuery(f, spec, false)` and sets `result.buckets`.
- `TimelineWidget`: the span query asks `['buckets']`; the log query keeps `['timeline']`. Fix the comment above `base`.
- Update the doc comments of `SpanNeed` and `timelineQuery`.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command, then `mise run test:e2e:chromium -- e2e/dashboards.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`fix(viewer): the dashboard timeline counts spans without their duration quantiles`

---

### Task 3: A `total` span need that counts instead of reading a row

**Files:**
- Modify: `src/viewer/data/results.ts` (`SpanNeed`), `src/query/sql/spans.ts` (new `spanCountQuery`), `src/viewer/data/duckdb-source.ts`, `src/viewer/dashboards/widgets/facet-chart.tsx` (`SpanFacets`)
- Test: `test/query/sql/spans.test.ts`, `test/viewer-data/duckdb-source-spans.test.ts`, `test/viewer/dashboard-facets.test.tsx`

**Interfaces:**
- Consumes: `SpanNeed` as Task 2 left it.
- Produces: `SpanNeed` gains `'total'`; `spanCountQuery(f: SqlFilter, mode: 'spans' | 'traces'): Query` with one row, one column `total` (`count(*)` in `spans` mode, `count(DISTINCT trace_id)` in `traces` mode).
- `total` fills `SpanQueryResult.total` with what the `rows` need would report, without reading a row. With `rows` also asked, the `rows` statement alone sets it.

- [ ] **Step 1: Write the failing tests**

`test/query/sql/spans.test.ts`:

```ts
test('spanCountQuery counts the filtered spans, or their traces', () => {
  const { filter: all } = filter();
  expect(run(spanCountQuery(all, 'spans'))).toEqual([{ total: 7n }]); // the fixture's span count, as durationSummaryQuery's n
  const traces = run(spanCountQuery(all, 'traces'))[0]?.total;
  expect(traces).toBe(BigInt(new Set(run(spanRowsQuery(all, SORT, 100)).map((r) => r.trace_id)).size));
});
```

(`SORT` is whatever sort the file's other `spanRowsQuery` tests pass.)

`test/viewer-data/duckdb-source-spans.test.ts`:

```ts
test('needs ["total"] counts in one statement what "rows" reports, in both modes and under a browser condition', async () => {
  const counted1 = await counted(() => ds.querySpans(query({ needs: ['total'], limit: 1 })));
  expect(counted1.arrow).toBe(1);
  expect(counted1.result.rows).toEqual([]);
  for (const over of [{}, { mode: 'traces' as const, sort: { column: 'start', dir: 'asc' as const } }, { text: 'select' }]) {
    const rows = await ds.querySpans(query({ ...over, needs: ['rows'] }));
    expect((await ds.querySpans(query({ ...over, needs: ['total'], limit: 1 }))).total).toBe(rows.total);
  }
  const residual = { condition: 'Len(name) > 7' };
  const kept = await ds.querySpans(query({ ...residual, needs: ['rows'] }));
  expect((await ds.querySpans(query({ ...residual, needs: ['total', 'facets'], limit: 1 }))).total).toBe(kept.rows.length);
});
```

`test/viewer/dashboard-facets.test.tsx` lines 415–431: a span widget asks `['total', 'facets']` for `count` and `['total', 'facets', 'groups']` for `duration.max`; the log widget assertion (line 451) stays `['rows', 'facets']`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run test/query/sql/spans.test.ts test/viewer-data/duckdb-source-spans.test.ts test/viewer/dashboard-facets.test.tsx`
Expected: FAIL (`spanCountQuery` and the `total` need do not exist).

- [ ] **Step 3: Implement**

- `spanCountQuery` beside `timelineQuery`, built from `Query.from('spans')` and `whereOf(f, 'spans')`.
- `querySpans`: `total` joins `AGGREGATE_NEEDS` (so a browser-evaluated condition narrows it through the id table); when `needs.has('total') && !needs.has('rows')` it runs `spanCountQuery(f, q.mode)` and sets `result.total`.
- `SpanFacets`: `needs` become `['total', 'facets']` / `['total', 'facets', 'groups']`; replace the comment "one row is read so the result carries the match count" with what happens now. `LogFacets` is not changed (the spec says why).

- [ ] **Step 4: Run the tests**

Run: the Step 2 command, then `mise run test:e2e:chromium -- e2e/dashboards.spec.ts`
Expected: PASS (the subtitles of the facet widgets show the same counts).

- [ ] **Step 5: Commit**

`fix(viewer): span facet widgets count their matches instead of reading a row`

---

### Task 4: The Runs condition names the CI scope

**Files:**
- Modify: `.github/otel-html-ci.yaml`, `.github/actions/otel-html-publish/otel-html-ci.yaml`, `fixtures/dashboards.otel-html.yaml` (the Runs widget's `query` and the comment above it)
- Test: `test/config/ci-dashboard.test.ts`

The new condition, identical in the three files:

```
instrumentation_scope.name == "otel-html-ci" and (IsRootSpan() or (attributes["cicd.pipeline.task.run.id"] != nil and attributes["cicd.pipeline.task.run.result"] != "skip"))
```

The comment above it gains one line: the scope term lets the scan skip the row groups that hold only test spans, and keeps the root spans of other instrumentation out of the list (#270).

- [ ] **Step 1: Write the failing test**

In `test/config/ci-dashboard.test.ts` (it reads the action's copy; `compileCondition` and `spanTarget` are imported already):

```ts
const RUNS =
  'instrumentation_scope.name == "otel-html-ci" and (IsRootSpan() or (attributes["cicd.pipeline.task.run.id"] != nil and attributes["cicd.pipeline.task.run.result"] != "skip"))';

test.each([
  '.github/actions/otel-html-publish/otel-html-ci.yaml',
  '.github/otel-html-ci.yaml',
  'fixtures/dashboards.otel-html.yaml',
])('%s: Runs lists CI roots and unskipped job spans, nothing of another scope', async (path) => {
  // resolve `path` as `resolved()` does, find the dashboard `ci` and its widget titled Runs
  expect(runs.query).toBe(RUNS);
  const matches = compileCondition(RUNS, 'span');
  // with spanTarget(...): a parentless span of scope otel-html-ci → true;
  // a job span (parent set, task.run.id set, result "success") of scope otel-html-ci → true (the run whose root never arrived);
  // the same job span with result "skip" → false;
  // a parentless span of scope "vitest" → false.
});
```

Write the four `spanTarget` cases out with the helper's real shape (`test/ottl/fixtures.ts`), and make `resolved()` take the path.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run test/config/ci-dashboard.test.ts`
Expected: FAIL on `runs.query` for all three files.

- [ ] **Step 3: Change the three YAML files**

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run test/config/ci-dashboard.test.ts`, then `mise run test:e2e:chromium -- e2e/dashboards.spec.ts`
Expected: PASS (the fixture's CI dashboard still lists its runs: `fixtures/ci.otlp.json` writes them under scope `otel-html-ci`).

- [ ] **Step 5: Commit**

`fix(ci): the Runs widget of the CI dashboard reads the CI spans only`

---

### Task 5: Test spans keep their parent

**Files:**
- Create: `test-support/otel/own-globals.ts`, `test/test-support/own-globals.test.ts`
- Modify: `test/test-support/otel-sdk.test.ts`, `test/viewer/open-report.test.ts`, `e2e/otel.ts`, `e2e/scale.spec.ts` (the metrics-scale `beforeAll`, around line 766)
- Test: `test/e2e-support/otel-fixture.test.ts` (or a new file beside it) for `withSpan`

**Interfaces:**
- Produces:
  - `withOwnOtelGlobals<T>(fn: () => T | Promise<T>): Promise<T>` in `test-support/otel/own-globals.ts`: runs `fn` with no global tracer provider, context manager or propagator registered, then unregisters what `fn` registered and puts the earlier three back, also when `fn` throws.
  - `withSpan<T>(tracing: TestTracing | undefined, name: string, fn: () => Promise<T>): Promise<T>` in `e2e/otel.ts`: without `tracing` it is `fn()`; with it, a span `name` under `tracing.parentFrom(process.env)` is the active span while `fn` runs, an error is recorded on it (status ERROR) and rethrown, and the span ends either way.

**Why the swap must not call `context.disable()`:** it calls `disable()` on the registered manager; vitest's is `AsyncLocalStorageContextManager`, whose `disable()` exits every in-flight context for good. And why it must be inside the test body, not in hooks: vitest starts its `test.callback` and `test.afterEach` spans between the hooks, through the global API. See the spec.

- [ ] **Step 1: Write the failing tests for `withOwnOtelGlobals`**

`test/test-support/own-globals.test.ts`. The tests must pass both with vitest's tracing on (an endpoint in the environment: globals are registered) and off (none are): where a test needs a registered manager and none is, it registers a small `AsyncLocalStorage`-backed `ContextManager` of its own whose `disable()` calls `als.disable()` (as the real one does) and removes it at the end.

```ts
test('the registered context manager keeps its in-flight context and comes back', async () => {
  const key = createContextKey('own-globals');
  await context.with(context.active().setValue(key, 1), async () => {
    await withOwnOtelGlobals(async () => {
      expect(context.active()).toBe(ROOT_CONTEXT); // nothing is registered inside
      expect(context.setGlobalContextManager(ownManager())).toBe(true); // so a test can register its own
      await Promise.resolve();
    });
    await Promise.resolve();
    expect(context.active().getValue(key)).toBe(1);
  });
});

test('the tracer provider and the propagator come back, also after a throw', async () => {
  const provider = new BasicTracerProvider();
  const propagator = new W3CTraceContextPropagator();
  // inside an outer withOwnOtelGlobals, so this test owns the three globals it registers
  await withOwnOtelGlobals(async () => {
    trace.setGlobalTracerProvider(provider);
    propagation.setGlobalPropagator(propagator);
    await expect(
      withOwnOtelGlobals(() => {
        expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).not.toBe(provider);
        expect(propagation.fields()).toEqual([]);
        trace.setGlobalTracerProvider(new BasicTracerProvider());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).toBe(provider);
    expect(propagation.fields()).toEqual(propagator.fields());
  });
});
```

Use the packages the neighbouring tests already import (`@opentelemetry/sdk-trace-base`, `@opentelemetry/core`); no new dependency.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run test/test-support/own-globals.test.ts`
Expected: FAIL (the module does not exist).

- [ ] **Step 3: Implement `withOwnOtelGlobals`**

The public API cannot read the registered context manager or propagator, so they are read from the API's global object, `globalThis[Symbol.for('opentelemetry.js.api.1')]` (fields `context`, `propagation`); say so in the doc comment, with the reason from "Why" above.

- Before `fn`: remember the provider delegate (`(trace.getTracerProvider() as ProxyTracerProvider).getDelegate()`, `undefined` when it is the no-op), the `context` and `propagation` fields; `trace.disable()`; `propagation.disable()`; **delete the `context` field** (no `context.disable()`).
- After `fn` (in `finally`): `trace.disable()`, `context.disable()`, `propagation.disable()` (these act on what `fn` registered), then `trace.setGlobalTracerProvider`, `context.setGlobalContextManager`, `propagation.setGlobalPropagator` for each remembered value.

Run: `pnpm exec vitest run test/test-support/own-globals.test.ts` → PASS.

- [ ] **Step 4: Use it in the two test files**

Both files replace the global handling in `beforeEach`/`afterEach` with a local `test` that wraps the body (their tests are all plain `test(name, fn)`):

```ts
// test/viewer/open-report.test.ts
const test = (name: string, fn: () => unknown) =>
  vitestTest(name, () =>
    withOwnOtelGlobals(async () => {
      context.setGlobalContextManager(asyncContextManager());
      exporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
      trace.setGlobalTracerProvider(provider);
      try {
        await fn();
      } finally {
        await provider.shutdown();
      }
    }),
  );
```

```ts
// test/test-support/otel-sdk.test.ts
const test = (name: string, fn: () => unknown) =>
  vitestTest(name, () =>
    withOwnOtelGlobals(async () => {
      try {
        await fn();
      } finally {
        await started?.shutdown();
        started = undefined;
      }
    }),
  );

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
```

Remove the now-unused `saved`/`savedProvider` variables and imports, and replace the comment that calls the lost parenting "acceptable" with one line on what the wrapper does.

In `otel-sdk.test.ts`, the test `shutdown resolves within the cap against an unreachable endpoint` passes its endpoint in `env`, but the exporter reads `process.env`; under CI its span `lost` reaches the real collector. Stub the process environment first, so the test does what its name says:

```ts
vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', ENDPOINT);
vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', `${ENDPOINT}/v1/traces`);
```

- [ ] **Step 5: Verify by capture that no test span is a root**

`dist/` must exist (`mise run build`). Run, from the repository root (not through `mise run`: the maintainer's mise config overrides the endpoint):

```bash
OUT=$(mktemp -d)
env -u OTEL_EXPORTER_OTLP_HEADERS -u OTEL_SERVICE_NAME node dist/cli/main.js run -o "$OUT" --replace --http 14318 --no-grpc -- \
  pnpm exec vitest run test/viewer/open-report.test.ts test/test-support/otel-sdk.test.ts test/test-support/own-globals.test.ts test/viewer/telemetry.test.ts test/query/sql/spans.test.ts
mise x duckdb@1.4.1 -- duckdb -c "SELECT name, count(*) AS n FROM read_parquet('$OUT/data/partitions/*/spans.parquet') WHERE parent_span_id IS NULL OR parent_span_id = '' GROUP BY 1 ORDER BY 2 DESC"
```

Expected: one row, the run's own root (`pnpm`, n = 1). On `main` the same command lists 158 roots besides it (`vitest.test.runner.*`, `vitest.runtime.*`, `lost`). Report the table you got.

- [ ] **Step 6: Commit**

`test(otel): tests that need their own OpenTelemetry globals no longer cut vitest's spans from the run`

- [ ] **Step 7: Write the failing test for `withSpan`**

In `test/e2e-support/` (follow `otel-fixture.test.ts` for imports). Inside `withOwnOtelGlobals`, start the SDK with an in-memory exporter (`startTestSdk({ TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, 'playwright', { exporter, processor: 'simple' })`; `withSpan` reads `process.env`, so stub `TRACEPARENT` with `vi.stubEnv` too) and assert:

- `await withSpan(tracing, 'metrics scale report', async () => { trace.getTracer('t').startSpan('child').end(); return 7; })` resolves to `7`;
- the exported `child` has the `metrics scale report` span as parent, and that span has trace id `0af7651916cd43dd8448eb211c80319c` and parent `b7ad6b7169203331`;
- a rejecting `fn` rejects `withSpan` with the same error and the span ends with status ERROR;
- `await withSpan(undefined, 'x', async () => 1)` is `1`.

Run: `pnpm exec vitest run test/e2e-support` → FAIL (`withSpan` is not exported).

- [ ] **Step 8: Implement `withSpan` and use it**

`e2e/otel.ts`: `context.with(trace.setSpan(parent, span), fn)` under the worker SDK's context manager. `e2e/scale.spec.ts`:

```ts
test.beforeAll(async ({ otelTracing }) => {
  test.setTimeout(METRICS_SCALE_SETUP_MS);
  await withSpan(otelTracing, 'metrics scale report', ensureMetricsScaleReport);
});
```

Run: `pnpm exec vitest run test/e2e-support` → PASS. Do not run the metrics-scale check locally; CI's `metrics-scale` job runs it.

- [ ] **Step 9: Commit**

`test(e2e): the metrics scale report is written inside a span of the job's trace`

### Task 6: The share cell does not read a large trace

Added on 2026-11-11 after the first whole-dashboard measurement of Tasks 1 to 4 (the spec's cause 5): with the Runs
list scoped to the CI runs, its visible rows are traces of 97,000 to 145,000 spans, and each row's "Latency by
service" cell loads its whole trace.

**Files:**
- Modify: `src/viewer/traces/columns.tsx` (the `ServiceShare` cell and the `share` column of `TRACE_COLUMNS_UI`)
- Modify: `README.md` (the Limits section)
- Test: `test/viewer/results-table.test.tsx` (the `the trace table service share cell` describe)

**Interfaces:**
- Produces: `export const SERVICE_SHARE_SPAN_CAP = 10_000` in `src/viewer/traces/columns.tsx`. The cell takes the
  row's span count; for a row with `spans > SERVICE_SHARE_SPAN_CAP` it never calls the loader and draws the column's
  dash with the title below. `DataSource.serviceShare` and its signature do not change.

- [ ] **Step 1: Write the failing tests**

In the existing describe, beside the two tests there (`t` is its trace row of 4 spans):

```ts
test('a trace over the span cap is not loaded and the cell says why', async () => {
  const serviceShare = vi.fn(() => Promise.resolve([{ service: 'web', ns: 70 }]));
  mount({ rows: [{ ...t, spans: SERVICE_SHARE_SPAN_CAP + 1 }], columns: TRACE_COLUMNS_UI, serviceShare });
  const cell = await screen.findByTitle(
    'Not computed for a trace of more than 10,000 spans: it reads every span of the trace',
  );
  expect(cell.textContent).toBe('-');
  await new Promise((r) => setTimeout(r, 0));
  expect(serviceShare).not.toHaveBeenCalled();
  expect(screen.queryByText('...')).toBeNull();
});

test('a trace at the span cap is loaded', async () => {
  const serviceShare = vi.fn(() => Promise.resolve([{ service: 'web', ns: 70 }]));
  mount({ rows: [{ ...t, spans: SERVICE_SHARE_SPAN_CAP }], columns: TRACE_COLUMNS_UI, serviceShare });
  expect(await screen.findByRole('img', { name: 'web 70 ns' })).toBeTruthy();
  expect(serviceShare).toHaveBeenCalledWith('aa', expect.any(AbortSignal));
});
```

- [ ] **Step 2: Run them and see the first fail**

Run: `pnpm exec vitest run test/viewer/results-table.test.tsx`
Expected: FAIL (`SERVICE_SHARE_SPAN_CAP` is not exported; once it is, the loader is called for the large trace).

- [ ] **Step 3: Implement**

`ServiceShare` gets a `spans: number` prop. Over the cap it passes a `null` key to `useKeyedAsync` (which then loads
nothing) and returns a muted `-` whose `title` is built from the constant (`toLocaleString('en-US')`), so the text
and the cap cannot drift apart. The `share` column passes `r.spans`. No change to the data source, the explorer or
the traces widget: both tables use this column.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run test/viewer/results-table.test.tsx test/viewer/dashboard-traces.test.tsx test/viewer/explorer.test.tsx`
Expected: PASS.

- [ ] **Step 5: README**

In `## Limits`, after the bullet that begins "Results are never partial", add:

`- The trace list's "Latency by service" bar is drawn for traces of at most 10,000 spans. Computing it reads every span of the trace, so a larger trace shows a dash there; its other columns are exact.`

- [ ] **Step 6: Check and commit**

Run: `mise run check`, then `mise run test:e2e:chromium -- e2e/dashboards.spec.ts`
Commit: `fix(viewer): the trace list does not read a large trace to draw its service share`

---

## Coordinator, after the tasks

1. Measure the dashboard on the local mirror of the live report with the branch's viewer and the scoped Runs condition (settle time, Parquet requests, Parquet MB, worker statements); the expectation is in the spec. Worse than that: stop and ask.
2. `mise run verify`.
3. Open the three follow-up issues the spec names.
4. Branch review on the review model; fix what blocks; PR with `Fixes #270`, the measurements, the span cap of Task 6 as a decision, the **Also** list (Task 5, and the note that the publish action's config copy changed with the maintainer's approval); merge when CI is green.
