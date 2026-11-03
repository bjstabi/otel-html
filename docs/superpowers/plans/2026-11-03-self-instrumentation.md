# Self-instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one span per vitest and Playwright test under the mise task span, and viewer spans (through the no-op
`@opentelemetry/api`) that land under the e2e test's span.

**Architecture:** a shared test-side tracing module (`test-support/otel/`) builds a non-global
`BasicTracerProvider` from the OTLP environment, or nothing. A vitest reporter builds spans from the results after
the run; Playwright fixtures in `e2e/test.ts` keep a live test span per test. The viewer wraps its script loader and
data source in tracing decorators. In e2e, a test-only in-page recorder (bundled with `bun build`) registers a
provider in the page and hands finished spans over an exposed binding to the worker, which exports them.

**Tech Stack:** TypeScript, `@opentelemetry/api` 1.10.0, `@opentelemetry/sdk-trace-base` 2.12.0, new
`@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/exporter-trace-otlp-http` 0.300.0, vitest 5.0.5
(reporter API), Playwright 1.64.1, bun 1.4.4 (bundler).

**Spec:** `docs/superpowers/specs/2026-11-03-self-instrumentation-design.md`

**PR process:** unattended (`docs/agents/process-unattended.md`). One PR:

| branch               | title                                                           |
| -------------------- | --------------------------------------------------------------- |
| `feat/self-telemetry` | `feat: OpenTelemetry spans from the viewer and a span per test` |

## Global Constraints

- The shipped viewer bundle gains no SDK, exporter or network call; it imports `@opentelemetry/api` only.
- Test processes never call `trace.setGlobalTracerProvider`, `context.setGlobalContextManager` or
  `propagation.setGlobalPropagator`. Only the in-page recorder registers globally, inside the browser page.
- No endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` both unset or empty) or
  `OTEL_SDK_DISABLED=true` → no provider, no exporter import (dynamic `import()` only after the check).
- Protocol from `OTEL_EXPORTER_OTLP_PROTOCOL` (or `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`): `http/protobuf` (default),
  `http/json`; `grpc` → one stderr warning, no export.
- Resource `service.name` = `OTEL_HTML_TEST_SERVICE_NAME` or `otel-html-tests` (never the inherited
  `OTEL_SERVICE_NAME`); `service.version` = package.json version; `test.framework` = `vitest` | `playwright`.
  Browser spans: `service.name=otel-html-viewer`.
- Parent: `TRACEPARENT` (W3C, via `W3CTraceContextPropagator` from `@opentelemetry/core`); malformed or absent → root.
- Shutdown flush capped at 5 000 ms; export errors → one stderr line per process, never a thrown error.
- Attributes: `test.suite.name`, `test.case.name` (title path joined by ` > `), `test.case.result.status` =
  `pass` | `fail` | `skipped`; failures set span status ERROR with the first error's message and an `exception`
  event. Project-specific keys use the `otel_html.` prefix, except `vitest.project`, `playwright.project`.
- Skipped tests: start = parent's start, zero duration.
- Recorder off for `@perf`-tagged tests, `scale.spec.ts`, `load.spec.ts`. Cap 2 000 viewer spans per test; the
  overflow count goes on the test span as `otel_html.viewer.spans.dropped`.
- Stop and ask: viewer bundle growth > 5 KB gzipped; Chromium e2e suite > 10% slower with an endpoint than without.
- New devDependencies pinned exact (`save-exact`), named in the PR body.
- Conventions: strict TS, Biome, TDD, `pnpm exec biome check .` and `mise run typecheck` before each commit,
  `mise run check` before push, `mise run verify` before the PR. README updated (Development section text outside
  the generated block; task descriptions via `mise run gen`).

## Review Focus

1. **The developer's shell exports an endpoint that is down** (e.g. OpenObserve stopped): `mise run check` and the
   e2e suite must pass with no hang beyond the 5 s cap. Task 1 tests an unreachable endpoint.
2. **Tests that spawn `serve`/`run` inherit the endpoint**: the fixtures must not change what those tests see; they
   already unset `OTEL_EXPORTER_OTLP_*` (playwright.config.ts comment). Task 2's unit run under a receiver covers
   the receiver-spawning unit tests; Task 5's full Chromium run under a receiver covers the e2e ones.
3. **Unit tests of `src/api/telemetry.ts` and the exporters with the reporter active**: a global provider would leak
   into them. Task 2 runs the full unit suite with an endpoint set to a local `otel-html serve`.
4. **A page navigates or reloads mid-test**: the recorder is per-document; `context.addInitScript` reinstalls it,
   and spans from the old document already crossed the binding (SimpleSpanProcessor). Task 5 tests a reload.
5. **A test fails or times out**: the fixture's teardown still ends the span with ERROR and flushes; Task 3 tests
   a failing test's span status via the fixture helper.

---

### Task 1: Test tracing module

**Files:**
- Create: `test-support/otel/tracing.ts`
- Modify: `package.json` (devDependencies), `pnpm-lock.yaml`, `knip.json` (add `"test-support/**/*.ts"` to `project`)
- Test: `test/test-support/otel-tracing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TestFramework = 'vitest' | 'playwright';
  export interface TestTracing {
    readonly tracer: Tracer;              // from @opentelemetry/api; provider.getTracer('otel-html-tests')
    readonly parent: Context;             // TRACEPARENT context, or ROOT_CONTEXT
    /** Queue an already-finished span (e.g. from the browser) on the provider's processor. */
    record(span: ReadableSpan): void;
    shutdown(): Promise<void>;            // flush, capped at 5 000 ms, never rejects
  }
  export function createTestTracing(
    env: Readonly<Record<string, string | undefined>>,
    framework: TestFramework,
    options?: { exporter?: SpanExporter; processor?: 'batch' | 'simple' },
  ): Promise<TestTracing | undefined>;
  export const VIEWER_RESOURCE: Resource;  // service.name=otel-html-viewer, service.version
  ```
  An injected `exporter` bypasses the endpoint check (tests use `InMemorySpanExporter` with `processor: 'simple'`).

- [ ] **Step 1: Branch and add dependencies**

```bash
git switch feat/self-telemetry   # created with the spec and plan commit
pnpm add -D --save-exact @opentelemetry/exporter-trace-otlp-proto@0.300.0 @opentelemetry/exporter-trace-otlp-http@0.300.0
```

- [ ] **Step 2: Write the failing tests** in `test/test-support/otel-tracing.test.ts`:
  - `returns undefined without an endpoint` — `createTestTracing({}, 'vitest')` → `undefined`; also with
    `OTEL_EXPORTER_OTLP_ENDPOINT: ''`.
  - `returns undefined when OTEL_SDK_DISABLED is true` — with an endpoint set.
  - `returns undefined and warns once for grpc` — spy on `process.stderr.write`; one call matching `/grpc/`.
  - `parents spans to TRACEPARENT` — injected exporter, env `TRACEPARENT=00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`;
    a span started with `tracing.tracer.startSpan('x', {}, tracing.parent)` and ended, after `shutdown()`, has
    trace id `0af7651916cd43dd8448eb211c80319c` and `parentSpanContext?.spanId === 'b7ad6b7169203331'`.
  - `starts a fresh trace for a malformed TRACEPARENT` — `TRACEPARENT=garbage` → span has no parent, no throw.
  - `uses otel-html-tests unless OTEL_HTML_TEST_SERVICE_NAME is set` — with `OTEL_SERVICE_NAME=mise` in env,
    resource `service.name` is `otel-html-tests`; with `OTEL_HTML_TEST_SERVICE_NAME=x`, `x`; `test.framework` matches.
  - `record() exports a foreign span` — a hand-built `ReadableSpan` with `VIEWER_RESOURCE` passes through unchanged.
  - `shutdown resolves within the cap against an unreachable endpoint` — env endpoint `http://127.0.0.1:9`
    (no injected exporter), one span, `await shutdown()` resolves in < 6 000 ms and does not reject.

- [ ] **Step 3: Run to see them fail**

Run: `pnpm exec vitest run test/test-support/otel-tracing.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement `test-support/otel/tracing.ts`** — exporter chosen by protocol via dynamic import of
  `@opentelemetry/exporter-trace-otlp-proto` / `-http` (`OTLPTraceExporter` with no options reads endpoint and
  headers from the environment). `BatchSpanProcessor` by default. Wrap the exporter so a failed export result
  writes one stderr line per process. `shutdown` = `Promise.race([provider.shutdown(), timeout(5000)])` with errors
  caught. Version from `package.json` via `createRequire` or a JSON import.

- [ ] **Step 5: Run to see them pass**, then `pnpm exec biome check .`, `mise run typecheck`, `pnpm exec knip`.

- [ ] **Step 6: Commit** — `test: a tracer for test processes from the OTLP environment`

### Task 2: Vitest reporter

**Files:**
- Create: `test-support/otel/vitest-reporter.ts`
- Modify: `vitest.config.ts` (`reporters: ['default', new OtelReporter()]` — keep the default reporter first)
- Test: `test/test-support/otel-vitest-reporter.test.ts`

**Interfaces:**
- Consumes: `createTestTracing`, `TestTracing` (Task 1).
- Produces: `export class OtelReporter implements Reporter` with `constructor(options?: { tracing?: Promise<TestTracing | undefined> })`
  (default: `createTestTracing(process.env, 'vitest')`), using `onTestRunStart` (record wall-clock start) and
  `onTestRunEnd(testModules, unhandledErrors, reason)` (build all spans, then `shutdown()`). Also
  `export function spansOf(modules: readonly ReportedModule[], run: { start: number; end: number }, tracing: TestTracing): void`
  over a minimal structural type `ReportedModule` (moduleId, project name, children with `type: 'suite' | 'test'`,
  `name`, `fullName`, `result().state`, `result().errors`, `diagnostic()?.startTime/duration/retryCount/flaky`)
  so tests can feed synthetic trees.

Span tree: `vitest` (run) → file (name = path relative to repo root, `test.suite.name` = same,
`vitest.project`) → `describe` (name) → test (name; `test.case.name` = `fullName` with ` > `;
`test.case.result.status`; `otel_html.test.retry.count` = `retryCount`, `otel_html.test.flaky` when true).
File and suite spans span min(child start)..max(child end); a file with no timed child uses the run start, zero
duration. Start times: `startTime` ms → `[s, ns]` HrTime; end = start + duration.

- [ ] **Step 1: Write the failing tests** (InMemorySpanExporter tracing from Task 1):
  - `builds run, file, suite and test spans with parents` — synthetic module `test/a.test.ts` with suite `s`
    holding a passing test `t` (startTime 1000, duration 5) → four spans; `t`'s parent is `s`, `s`'s is the file,
    the file's is `vitest`; `t` has `test.case.name = 's > t'`, `test.case.result.status = 'pass'`.
  - `marks a failing test` — state `failed`, error message `boom` → status ERROR, message `boom`, one
    `exception` event with `exception.message = 'boom'`.
  - `gives a skipped test its parent's start and zero duration` — status `skipped`.
  - `nests the run under TRACEPARENT`.
  - `does nothing without tracing` — `tracing` resolves to `undefined`; `onTestRunEnd` resolves.

- [ ] **Step 2: Run to see them fail** — `pnpm exec vitest run test/test-support/otel-vitest-reporter.test.ts`

- [ ] **Step 3: Implement the reporter**, add it to `vitest.config.ts`.

- [ ] **Step 4: Run to see them pass**; then the Review Focus 3 check: start a receiver and run the whole unit
  suite under it:

```bash
node dist/cli/main.js run -o "$TMPDIR/otel-unit" -- pnpm exec vitest run
```
  Expected: the vitest run passes as it does without `run`; the report in `$TMPDIR/otel-unit` holds a `vitest`
  span with file and test children (inspect with `node dist/cli/main.js` or open `index.html`); record the test-span
  count for the PR body.

- [ ] **Step 5:** biome, typecheck, `mise run check`. Commit — `test: a span per vitest test`

### Task 3: Playwright test spans

**Files:**
- Create: `e2e/otel.ts` (fixture helpers)
- Modify: `e2e/test.ts` (auto fixtures on the base `test`; `hostileTest` derives from it instead of from `base`),
  `biome.json` (override for `e2e/**` except `e2e/test.ts`: `noRestrictedImports` on `@playwright/test` with
  `allowTypeImports: true`, message "take test from ./test.js")
- Test: `test/e2e-support/otel-fixture.test.ts` (vitest, node project — add `test/e2e-support/**` if the include
  pattern does not cover it)

**Interfaces:**
- Consumes: `createTestTracing`, `TestTracing` (Task 1).
- Produces (in `e2e/otel.ts`):
  ```ts
  export interface TestSpanInfo {
    titlePath: readonly string[];   // testInfo.titlePath without the file
    file: string;                   // repo-relative spec path
    project: string;
    retry: number;
    tags: readonly string[];
  }
  export function startTestSpan(tracing: TestTracing, info: TestSpanInfo): Span;
  export function endTestSpan(
    span: Span,
    outcome: { status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'; error?: { message?: string; stack?: string } },
  ): void;
  /** Whether the in-page recorder runs for this test (Task 5). */
  export function recordsViewer(info: TestSpanInfo): boolean;  // false for @perf tags, scale.spec.ts, load.spec.ts
  ```
  `e2e/test.ts` gains a worker fixture `otelTracing: TestTracing | undefined` (auto, scope `worker`, created from
  `process.env` with `'playwright'`, shut down at teardown) and a test fixture `otelTestSpan: Span | undefined`
  (auto). Skipped tests: `startTestSpan` at fixture start, so start = the fixture's start; `endTestSpan` with
  `skipped` uses the start as end. `interrupted` maps to `fail`.

- [ ] **Step 1: Write the failing tests** for `startTestSpan`/`endTestSpan`/`recordsViewer` with in-memory tracing:
  name = last title, `test.case.name = 'describe > title'`, `test.suite.name = 'e2e/x.spec.ts'`,
  `playwright.project`, `otel_html.test.retry`, `otel_html.test.tags`; `failed` and `timedOut` → ERROR with the
  message and an `exception` event; `skipped` → zero duration; `recordsViewer` false for tag `@perf`, for
  `e2e/scale.spec.ts` and `e2e/load.spec.ts`, true otherwise.

- [ ] **Step 2: Run to see them fail**, **Step 3: implement**, **Step 4: run to see them pass.**

- [ ] **Step 5: Wire the fixtures in `e2e/test.ts`**, add the Biome rule, and check it: temporarily add
  `import { test } from '@playwright/test'` to a spec → `pnpm exec biome check e2e` fails; revert.

- [ ] **Step 6: Run** `mise run test:e2e:chromium -- e2e/smoke.spec.ts` (no endpoint: passes as before), then under
  a receiver:

```bash
node dist/cli/main.js run -o "$TMPDIR/otel-e2e" -- mise run test:e2e:chromium -- e2e/smoke.spec.ts
```
  Expected: passes; the report holds one span per smoke test under the `test:e2e:chromium` task span.

- [ ] **Step 7:** biome, typecheck, `mise run check`. Commit — `test(e2e): a span per Playwright test`

### Task 4: Viewer spans

**Files:**
- Create: `src/viewer/telemetry.ts`, `src/viewer/data/traced.ts`
- Modify: `src/viewer/main.tsx`
- Test: `test/viewer/telemetry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/viewer/telemetry.ts
  export const viewerTracer: () => Tracer;   // trace.getTracer('otel-html-viewer', <package version>), looked up per call
  export function traced<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T>;
  //  startActiveSpan; on rejection recordException + ERROR + rethrow; always end
  export function watchNavigation(win: Window): () => void;  // hashchange → zero-duration `viewer.navigate`
  // src/viewer/data/traced.ts
  export function tracedLoader(loader: ScriptLoader): ScriptLoader;       // `viewer.chunk.load`
  export function tracedDataSource(ds: DataSource): DataSource;           // `viewer.query`
  ```
  The viewer has no build-time version define; the tracer takes no version, and `viewer.load` carries the manifest's
  `otelHtmlVersion` as `otel_html.report.version`.

Span content:
- `viewer.load` (in `main.tsx`'s `load()`): attributes `otel_html.format_version`, `otel_html.spans.total`,
  `otel_html.logs.total`, `otel_html.metrics.total`, `otel_html.strategy.spans`, `otel_html.strategy.logs`.
- `viewer.chunk.load`: `otel_html.path`, `otel_html.key`; failures as ERROR.
- `viewer.query`: for `querySpans`, `queryLogs`, `getTrace`, `traceLogs`, `surroundingLogs`, `metric`,
  `metricsForResources`; `otel_html.query.kind` = the method name; result size as `otel_html.query.result_count`
  where the result has one obvious count (rows length, trace span count); an abort is not an error (status unset,
  `otel_html.query.aborted = true`). The other methods pass through untraced.
- `viewer.navigate`: `otel_html.route` (the path before `?`) and `otel_html.route.params` (sorted parameter names,
  comma-joined) — never parameter values.

- [ ] **Step 1: Record the baseline bundle size:** `mise run build:viewer && gzip -c dist/viewer/assets/*.js | wc -c`
  (note the number for the PR body).

- [ ] **Step 2: Write the failing tests** in `test/viewer/telemetry.test.ts`. Register a `BasicTracerProvider` with
  an `InMemorySpanExporter` and `SimpleSpanProcessor` in `beforeEach` via `trace.setGlobalTracerProvider`, and call
  `trace.disable()` in `afterEach` (this is a viewer unit test standing in for the page, not test instrumentation).
  Use `test-support/scripted-loader.ts` for loaders.
  - `tracedLoader records a chunk load span` — name, `otel_html.path`.
  - `tracedLoader marks a failed load as an error` and rethrows the same error.
  - `tracedDataSource records querySpans with its kind and count`.
  - `an aborted query is not an error`.
  - `watchNavigation records the route and parameter names but not values` — hash `#/logs?q=secret&sort=time` →
    `otel_html.route='/logs'`, `otel_html.route.params='q,sort'`, and no attribute value contains `secret`.
  - `without a provider nothing is recorded and nothing is fetched` — `trace.disable()`, stub `fetch` and
    `XMLHttpRequest.prototype.open` to throw; run a traced query; nothing throws, the exporter is empty.

- [ ] **Step 3: Run to see them fail** — `pnpm exec vitest run --project viewer test/viewer/telemetry.test.ts`

- [ ] **Step 4: Implement**, wire into `main.tsx` (`tracedLoader` around the DOM loader, `traced('viewer.load', …)`
  in `load()`, `tracedDataSource` on its result, `watchNavigation(window)` once).

- [ ] **Step 5: Run to see them pass**; rebuild and measure the bundle again. Growth > 5 KB gzipped → stop and ask.

- [ ] **Step 6:** biome, typecheck, `mise run check`, `mise run test:e2e:chromium` (viewer behaviour unchanged).
  Commit — `feat(viewer): spans for loading, chunk loads, queries and navigation`

### Task 5: In-page recorder and browser spans under the test span

**Files:**
- Create: `e2e/otel-page/recorder.ts` (bundled), `e2e/otel-page/span-json.ts` (shared JSON shape and the Node-side
  mapping), `e2e/otel.spec.ts`
- Modify: `e2e/otel.ts`, `e2e/test.ts` (override `context`), `mise.toml` (new task `e2e:otel-recorder`;
  `e2e:fixtures` depends on it), `knip.json` (entry `e2e/otel-page/recorder.ts`), `biome.json` if the bundle output
  path needs ignoring (put it in `e2e/.cache/`, already ignored)
- Test: `test/e2e-support/span-json.test.ts`, `e2e/otel.spec.ts`

**Interfaces:**
- Consumes: `TestTracing.record`, `VIEWER_RESOURCE` (Task 1); `recordsViewer`, the test span (Task 3); the viewer
  spans (Task 4).
- Produces:
  ```ts
  // e2e/otel-page/span-json.ts
  export interface SpanJson {
    traceId: string; spanId: string; parentSpanId?: string; traceFlags: number;
    name: string; kind: number; start: [number, number]; end: [number, number];
    attributes: Record<string, string | number | boolean | string[] | number[] | boolean[]>;
    status: { code: number; message?: string };
    events: { name: string; time: [number, number]; attributes: SpanJson['attributes'] }[];
    scope: { name: string; version?: string };
  }
  export function toSpanJson(span: ReadableSpan): SpanJson;            // used in the page
  export function fromSpanJson(json: SpanJson, resource: Resource): ReadableSpan;  // used in the worker
  export const RECORDER_BINDING = '__otelHtmlSpans';
  export const RECORDER_PATH = 'e2e/.cache/otel-recorder.js';
  // e2e/otel.ts
  export function instrumentContext(
    context: BrowserContext, tracing: TestTracing, parent: Span, limit?: number,  // default 2000
  ): Promise<{ settle(): Promise<{ dropped: number }> }>;
  ```
  The recorder, given `{ traceId, spanId, traceFlags }` as the init-script argument, registers (with its own
  bundled `@opentelemetry/api` 1.10.0, same as the viewer's) a `BasicTracerProvider` with a `SimpleSpanProcessor`
  whose exporter calls `window[RECORDER_BINDING](toSpanJson(span))`, and a stack-based context manager (about 30
  lines, written in the recorder) whose base context is `trace.setSpanContext(ROOT_CONTEXT, parentSpanContext)`, so
  `active()` returns it whenever no `with()` is running. The Node binding
  counts spans; beyond `limit` it drops and counts; `settle()` awaits in-flight binding calls and returns the
  dropped count, which the fixture sets as `otel_html.viewer.spans.dropped` (only when > 0) before ending the span.

`mise.toml` task:
```toml
[tasks."e2e:otel-recorder"]
description = "Bundle the e2e in-page span recorder into e2e/.cache/otel-recorder.js (skipped while up to date)"
sources = ["@group:deps", "e2e/otel-page/**"]
outputs = ["e2e/.cache/otel-recorder.js"]
run = "bun build e2e/otel-page/recorder.ts --target browser --format iife --minify --outfile e2e/.cache/otel-recorder.js"
```
When the file is missing at test time the fixture writes one stderr warning per worker and records no browser spans.

- [ ] **Step 1: Write the failing unit test** `span-json.test.ts`: a span from an in-memory provider →
  `toSpanJson` → `fromSpanJson(…, VIEWER_RESOURCE)` keeps ids, parent, name, kind, times, attributes, status,
  events and scope; `resource.attributes['service.name'] === 'otel-html-viewer'`.

- [ ] **Step 2: Fail, implement `span-json.ts`, pass.**

- [ ] **Step 3: Write the failing spec** `e2e/otel.spec.ts`, first test tagged `HTTP`. It builds its own tracing
  with an `InMemorySpanExporter` and `processor: 'simple'`, starts a parent span, opens
  `browser.newContext()`, calls `instrumentContext`, loads the `small` report (`reportUrl`), waits for the traces
  table, calls `settle()`, and asserts:
  - `browser spans join the test span` — a `viewer.load` span with the parent's trace id and
    `parentSpanContext.spanId` equal to the parent's span id, resource `service.name=otel-html-viewer`; at least
    one `viewer.chunk.load`.
  - `a reload keeps recording` — `page.reload()`, wait, settle → two `viewer.load` spans.
  - `the cap drops and counts` — `limit: 1` → one span recorded, `dropped >= 1`.

- [ ] **Step 4: Run to see it fail** — `mise run test:e2e:chromium -- e2e/otel.spec.ts`

- [ ] **Step 5: Implement** the recorder, the task, `instrumentContext`, and the `context` override in
  `e2e/test.ts` (instrument only when `otelTracing` and `recordsViewer(info)`); wire `settle()` and the dropped
  count into the test-span teardown.

- [ ] **Step 6: Run to see it pass**; then the whole Chromium suite without and with a receiver, timing each:

```bash
mise run e2e:fixtures   # warm first, so neither timing includes the build
time OTEL_EXPORTER_OTLP_ENDPOINT= mise run test:e2e:chromium
time node dist/cli/main.js run -o "$TMPDIR/otel-e2e-all" -- mise run test:e2e:chromium
```
  (If mise replays the cached task, add `--force`.) Record both wall times and the test/viewer span counts from the
  report. More than 10% slower with the receiver → stop and ask.

- [ ] **Step 7:** biome, typecheck, `mise run check`, `mise run gen` (new task description). Commit —
  `test(e2e): viewer spans under each test's span`

### Task 6: Documentation, verification, PR

**Files:**
- Modify: `README.md` (Development section, hand-written part: where test and viewer spans go — set an OTLP
  endpoint or run under `otel-html run`; `OTEL_HTML_TEST_SERVICE_NAME`; the shipped viewer sends nothing and records
  nothing unless a page registers a provider; the spans' names), `playwright.config.ts` (update the comment: an
  SDK is now registered per worker, non-globally, and still exports to the inherited endpoint)

- [ ] **Step 1:** Write the README text; `mise run gen`; `mise run check`.
- [ ] **Step 2:** `mise run verify`. Expected: green.
- [ ] **Step 3:** Branch review (Opus 5.5, whole diff + this plan), fix blocking findings.
- [ ] **Step 4:** `gh pr create` with the title above. The body has: what changed per area, what was decided against
  (Playwright step spans, test metrics, gRPC export, file spans for Playwright), **New dependencies** (the two
  exporters, why), the measurements (bundle gzip before/after; e2e wall time without/with endpoint; span counts
  from Tasks 2, 3 and 5), and an **Also** list.
- [ ] **Step 5:** When CI is green, download the PR run's `check` and `e2e` job reports (`gh run download`), confirm
  `test.case.name` spans under the `test:unit` and `test:e2e:chromium` task spans and `viewer.*` spans under e2e test
  spans; add the counts to the PR body. Then `gh pr merge <n> --squash --delete-branch`.
- [ ] **Step 6:** Open a follow-up issue: "CI dashboard: tests (slowest, failing) from the test spans".
