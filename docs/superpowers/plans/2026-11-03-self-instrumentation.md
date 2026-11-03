# Self-instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one span per vitest and Playwright test under the mise task span, and viewer spans (through the no-op
`@opentelemetry/api`) that land under the e2e test's span.

**Architecture:** one test-side module (`test-support/otel/`) starts `@opentelemetry/sdk-node`'s `NodeSDK` from the
OTLP environment, or nothing. Vitest uses its built-in OpenTelemetry support with that module as its `sdkPath`.
Playwright fixtures in `e2e/test.ts` start the same SDK per worker and keep a live span for each test. The viewer
wraps its script loader and data source in tracing decorators. In e2e, a test-only recorder runs in the page
(bundled with `bun build`). It registers a provider there and hands finished spans to the worker through an exposed
binding; the worker exports them.

**Tech Stack:** TypeScript, `@opentelemetry/api` 1.10.0, new `@opentelemetry/sdk-node` 0.300.0 (SDK 3.0 line; its
`tracing` and `resources` re-exports), `@opentelemetry/sdk-trace-base` 2.12.0 (page side only), vitest 5.0.5
(`test.experimental.openTelemetry`), Playwright 1.64.1, bun 1.4.4 (bundler).

**Spec:** `docs/superpowers/specs/2026-11-03-self-instrumentation-design.md`

**PR process:** unattended (`docs/agents/process-unattended.md`). One PR:

| branch                | title                                                           |
| --------------------- | --------------------------------------------------------------- |
| `feat/self-telemetry` | `feat: OpenTelemetry spans from the viewer and a span per test` |

## Global Constraints

- The shipped viewer bundle gains no SDK, exporter or network call; it imports `@opentelemetry/api` only.
- Global registration (provider, propagator, context manager) is allowed in vitest workers and Playwright workers,
  through `NodeSDK` only. A unit test that starts the SDK, or that registers anything globally itself, restores the
  globals in `afterEach` (`trace.disable()`, `context.disable()`, `propagation.disable()`).
- No endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` both unset or empty) or
  `OTEL_SDK_DISABLED=true` → no SDK started; vitest's `openTelemetry.enabled` is false.
- `NodeSDK` for traces only: no metric reader, no log processor, no instrumentations. Protocol, endpoint and headers
  come from the environment through the SDK (all three protocols work).
- Resource `service.name` = `OTEL_HTML_TEST_SERVICE_NAME` or `otel-html-tests` (never the inherited
  `OTEL_SERVICE_NAME`); `service.version` = package.json version; `test.framework` = `vitest` | `playwright`.
  Browser spans: `service.name=otel-html-viewer`.
- Parent: vitest reads `TRACEPARENT` itself; the Playwright fixture extracts it with the global W3C propagator;
  malformed or absent → root.
- Shutdown flush capped at 5 000 ms; export errors → one stderr line per process, never a thrown error.
- Playwright attributes: `test.suite.name`, `test.case.name` (title path joined by ` > `), `test.case.result.status`
  = `pass` | `fail` | `skipped`; failures set span status ERROR with the first error's message and an `exception`
  event. Vitest's spans keep vitest's own names and attributes. Project-specific keys use the `otel_html.` prefix,
  except `playwright.project`.
- Skipped Playwright tests: start = the fixture's start, zero duration.
- Recorder off for `@perf`-tagged tests, `scale.spec.ts`, `load.spec.ts`. Cap 2 000 viewer spans per test; the
  overflow count goes on the test span as `otel_html.viewer.spans.dropped`.
- Stop and ask: viewer bundle growth > 5 KB gzipped; Chromium e2e suite > 10% slower with an endpoint than without.
- New devDependency pinned exact (`save-exact`), named in the PR body. Test-side code imports SDK classes only via
  `@opentelemetry/sdk-node` (`tracing`, `resources`), never its transitive packages.
- Conventions: strict TS, Biome, TDD, `pnpm exec biome check .` and `mise run typecheck` before each commit,
  `mise run check` before push, `mise run verify` before the PR. README updated (Development section text outside
  the generated block; task descriptions via `mise run gen`).

## Review Focus

1. **The developer's shell exports an endpoint that is down** (e.g. OpenObserve stopped): `mise run check` and the
   e2e suite must pass with no hang beyond the 5 s cap. Task 1 tests an unreachable endpoint.
2. **Tests that spawn `serve`/`run` inherit the endpoint**: the fixtures must not change what those tests see; they
   already unset `OTEL_EXPORTER_OTLP_*` (playwright.config.ts comment). Task 1's unit run under a receiver covers
   the receiver-spawning unit tests; Task 4's full Chromium run under a receiver covers the e2e ones.
3. **Unit tests that use OTel while vitest's global provider is registered** (`test/api/report.test.ts`,
   `test/model/sdk-*.test.ts`, `test/exporters/*.test.ts`): they must pass unchanged. Task 1 runs the full unit
   suite under a local receiver.
4. **A page navigates or reloads mid-test**: the recorder is per-document; `context.addInitScript` reinstalls it,
   and spans from the old document already crossed the binding (SimpleSpanProcessor). Task 4 tests a reload.
5. **A test fails or times out**: the fixture's teardown still ends the span with ERROR and flushes; Task 2 tests
   a failing test's span status via the fixture helper.

---

### Task 1: Test SDK module and vitest's built-in OpenTelemetry

**Files:**
- Create: `test-support/otel/sdk.ts`, `test-support/otel/vitest-sdk.ts`
- Modify: `package.json` (devDependencies), `pnpm-lock.yaml`, `vitest.config.ts`, `knip.json` (add
  `"test-support/**/*.ts"` to `project`; `test-support/otel/vitest-sdk.ts` to `entry`), `biome.json`
  (`noDefaultExport` off for `test-support/otel/vitest-sdk.ts`)
- Test: `test/test-support/otel-sdk.test.ts`

**Interfaces:**
- Produces (`test-support/otel/sdk.ts`):
  ```ts
  import { type resources, tracing } from '@opentelemetry/sdk-node';
  export type TestFramework = 'vitest' | 'playwright';
  export interface TestTracing {
    readonly tracer: Tracer;               // @opentelemetry/api, trace.getTracer('otel-html-tests')
    /** The context TRACEPARENT names (global W3C propagator), or ROOT_CONTEXT. */
    parentFrom(env: Readonly<Record<string, string | undefined>>): Context;
    /** Queue an already-finished span (from the browser) on the SDK's span processor. */
    record(span: tracing.ReadableSpan): void;
    shutdown(): Promise<void>;             // flush, capped at 5 000 ms, never rejects
  }
  export function tracingEnabled(env: Readonly<Record<string, string | undefined>>): boolean;
  export function startTestSdk(
    env: Readonly<Record<string, string | undefined>>,
    framework: TestFramework,
    options?: { exporter?: tracing.SpanExporter; processor?: 'batch' | 'simple' },
  ): TestTracing | undefined;
  export const VIEWER_RESOURCE: resources.Resource;  // service.name=otel-html-viewer, service.version
  /** A non-global TestTracing over an in-memory exporter (simple processor), for tests of code that takes one. */
  export function inMemoryTracing(): { tracing: TestTracing; exporter: tracing.InMemorySpanExporter };
  ```
  `inMemoryTracing` registers nothing globally: it uses a `tracing.BasicTracerProvider` directly, so it is safe in
  a Playwright worker whose SDK is already running. `parentFrom` on it uses a local `W3CTraceContextPropagator`
  (from sdk-node's `core` re-export).
  An injected `exporter` bypasses the endpoint check (tests use `tracing.InMemorySpanExporter` with
  `processor: 'simple'`). Without one, the module builds no exporter itself: it passes
  `spanProcessors: [new tracing.BatchSpanProcessor(<the SDK's env-configured OTLP trace exporter>)]`. If `NodeSDK`
  cannot take a processor and still configure the exporter from the environment, construct the exporter with
  sdk-node's env helper (check `@opentelemetry/sdk-node`'s exports at 0.300.0). Record which way it went in the
  commit message.
- Produces (`test-support/otel/vitest-sdk.ts`): `export default startTestSdk(process.env, 'vitest') ?? { shutdown: () => Promise.resolve() };`
- `vitest.config.ts`: `test.experimental.openTelemetry = { enabled: tracingEnabled(process.env), sdkPath: <path of vitest-sdk.ts> }`.
  Check whether vitest resolves `sdkPath` against the root or needs an absolute path.

- [ ] **Step 1: Add the dependency**

```bash
git switch feat/self-telemetry   # created with the spec and plan commit
pnpm add -D --save-exact @opentelemetry/sdk-node@0.300.0
```

- [ ] **Step 2: Write the failing tests** in `test/test-support/otel-sdk.test.ts`. `afterEach` shuts the SDK down
  and disables the API globals.
  - `starts nothing without an endpoint` — `startTestSdk({}, 'vitest')` → `undefined`, also with
    `OTEL_EXPORTER_OTLP_ENDPOINT: ''`; `tracingEnabled` agrees.
  - `starts nothing when OTEL_SDK_DISABLED is true` — with an endpoint set.
  - `parents to TRACEPARENT` — injected exporter; `parentFrom({ TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' })`;
    a span started in that context and ended has trace id `0af7651916cd43dd8448eb211c80319c` and
    `parentSpanContext?.spanId === 'b7ad6b7169203331'`.
  - `a malformed TRACEPARENT starts a fresh trace` — `TRACEPARENT=garbage` → no parent, no throw.
  - `uses otel-html-tests unless OTEL_HTML_TEST_SERVICE_NAME is set` — with `OTEL_SERVICE_NAME=mise` in the env
    passed and in `process.env` (stub with `vi.stubEnv`), resource `service.name` is `otel-html-tests`; with
    `OTEL_HTML_TEST_SERVICE_NAME=x`, `x`; `test.framework` matches.
  - `inMemoryTracing registers nothing globally` — after creating one, `trace.getTracerProvider()` is still the
    API's proxy with no delegate (a span from `trace.getTracer('x')` is non-recording).
  - `record() exports a foreign span` — a hand-built `ReadableSpan` with `VIEWER_RESOURCE` arrives unchanged.
  - `shutdown resolves within the cap against an unreachable endpoint` — endpoint `http://127.0.0.1:9`, no
    injected exporter, one span; `await shutdown()` resolves in < 6 000 ms and does not reject.

- [ ] **Step 3: Run to see them fail** — `pnpm exec vitest run test/test-support/otel-sdk.test.ts` → FAIL (module
  not found)

- [ ] **Step 4: Implement `sdk.ts` and `vitest-sdk.ts`; wire `vitest.config.ts`.**

- [ ] **Step 5: Run to see them pass**; then `pnpm exec vitest run` with no endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT=`,
  since the maintainer's shell sets one) → passes, and no vitest warning about the SDK.

- [ ] **Step 6: The Review Focus 3 check** — the whole unit suite under a receiver:

```bash
mise run build
node dist/cli/main.js run -o "$TMPDIR/otel-unit" -- pnpm exec vitest run
```
  Expected: passes as it does without `run`. The report in `$TMPDIR/otel-unit` holds `vitest.test_run` under
  `run`'s root span, with `run.test` spans below it (open `index.html` with the Playwright MCP or query the data
  files). Record the `run.test` count for the PR body. Repeat with `OTEL_HTML_PERF_PASS=1`, which must also pass.

- [ ] **Step 7:** biome, typecheck, `mise run check`, `pnpm exec knip`. Commit —
  `test: vitest's built-in OpenTelemetry spans, exported when an OTLP endpoint is set`
### Task 2: Playwright test spans

**Files:**
- Create: `e2e/otel.ts` (fixture helpers)
- Modify: `e2e/test.ts` (auto fixtures on the base `test`; `hostileTest` derives from it instead of from `base`),
  `biome.json` (override for `e2e/**` except `e2e/test.ts`: `noRestrictedImports` on `@playwright/test` with
  `allowTypeImports: true`, message "take test from ./test.js")
- Test: `test/e2e-support/otel-fixture.test.ts` (vitest, node project — add `test/e2e-support/**` if the include
  pattern does not cover it)

**Interfaces:**
- Consumes: `startTestSdk`, `TestTracing` (Task 1).
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
  /** Whether the in-page recorder runs for this test (Task 4). */
  export function recordsViewer(info: TestSpanInfo): boolean;  // false for @perf tags, scale.spec.ts, load.spec.ts
  ```
  `e2e/test.ts` gains a worker fixture `otelTracing: TestTracing | undefined` (auto, scope `worker`,
  `startTestSdk(process.env, 'playwright')`, shut down at teardown; test spans start in `parentFrom(process.env)`) and a test fixture `otelTestSpan: Span | undefined`
  (auto). Skipped tests: `startTestSpan` at fixture start, so start = the fixture's start; `endTestSpan` with
  `skipped` uses the start as end. `interrupted` maps to `fail`.

- [ ] **Step 1: Write the failing tests** for `startTestSpan`/`endTestSpan`/`recordsViewer` with `inMemoryTracing()`:
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

### Task 3: Viewer spans

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

### Task 4: In-page recorder and browser spans under the test span

**Files:**
- Create: `e2e/otel-page/recorder.ts` (bundled), `e2e/otel-page/span-json.ts` (shared JSON shape and the Node-side
  mapping), `e2e/otel.spec.ts`
- Modify: `e2e/otel.ts`, `e2e/test.ts` (override `context`), `mise.toml` (new task `e2e:otel-recorder`;
  `e2e:fixtures` depends on it), `knip.json` (entry `e2e/otel-page/recorder.ts`), `biome.json` if the bundle output
  path needs ignoring (put it in `e2e/.cache/`, already ignored)
- Test: `test/e2e-support/span-json.test.ts`, `e2e/otel.spec.ts`

**Interfaces:**
- Consumes: `TestTracing.record`, `VIEWER_RESOURCE` (Task 1); `recordsViewer`, the test span (Task 2); the viewer
  spans (Task 3).
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
  // page side: ReadableSpan from @opentelemetry/sdk-trace-base 2.12.0
  export function toSpanJson(span: ReadableSpan): SpanJson;
  // worker side: SDK 3.0 types from @opentelemetry/sdk-node's `tracing` and `resources`
  export function fromSpanJson(json: SpanJson, resource: resources.Resource): tracing.ReadableSpan;
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

- [ ] **Step 3: Write the failing spec** `e2e/otel.spec.ts`, first test tagged `HTTP`. It uses `inMemoryTracing()`
  (never `startTestSdk`, which would clash with the worker's SDK), starts a parent span, opens
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

### Task 5: Documentation, verification, PR

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
  from Tasks 1, 2 and 4), and an **Also** list.
- [ ] **Step 5:** When CI is green, download the PR run's `check` and `e2e` job reports (`gh run download`), confirm
  `test.case.name` spans under the `test:unit` and `test:e2e:chromium` task spans and `viewer.*` spans under e2e test
  spans; add the counts to the PR body. Then `gh pr merge <n> --squash --delete-branch`.
- [ ] **Step 6:** Open a follow-up issue: "CI dashboard: tests (slowest, failing) from the test spans".
