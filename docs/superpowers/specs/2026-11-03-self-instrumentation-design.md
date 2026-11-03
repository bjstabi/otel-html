# Self-instrumentation: viewer spans and a span per test

## Intent

otel-html turns telemetry into reports, and CI already dogfoods it: every job step runs under
`otel-html run`, and every `mise run` task exports its span to that receiver (`MISE_OTEL_ENABLED=1`,
`.github/workflows/ci.yml`). Below a task span the trace stops. A slow `test:unit` or `test:e2e` shows as one bar
with nothing inside it, and nothing says what the viewer spent its time on while a test waited.

This project extends the trace downwards:

- **Tests:** one span per test (vitest and Playwright), nested under the file and suite, parented to the mise task
  span that ran them.
- **Viewer:** the browser app emits spans for its own work (loading the report, loading chunks, running queries,
  navigating). In an e2e test those spans land under the test's span, so a test's span shows what the viewer did.

The maintainer asked for exactly these two things and skipped the design questions; everything below beyond them is
the designer's call, marked as such where it matters.

## Goals

1. Every vitest test case and every Playwright test produces a span when an OTLP endpoint is configured. Vitest
   spans come from vitest's built-in support, under vitest's own names. Playwright spans carry the OTel test semantic
   conventions (`test.suite.name`, `test.case.name`, `test.case.result.status`) and, on failure, the error message.
2. The spans join the ambient trace: `TRACEPARENT` from the environment is the parent (mise sets it to the task
   span; `otel-html run` sets it for the job shell). No `TRACEPARENT` → a fresh trace.
3. The viewer is instrumented through `@opentelemetry/api` only. Shipped reports carry no SDK and no exporter; with
   nothing registered the API is a no-op.
4. In e2e tests the viewer's spans are recorded and exported as children of the test's span.
5. In CI the spans reach the job's report (the existing `.otel-html/report`), so the CI dashboards can show them.

## Non-goals

- Telemetry from users' reports. The shipped viewer never sends anything anywhere (anti-goal below).
- Metrics or logs from tests. Spans only. (Designer's call; a `test` duration histogram can come later from the
  spans themselves.)
- Spans for Playwright's internal steps (`page.goto`, `expect`, actions). Playwright has no worker-side hook for
  them; the reporter process does, but joining reporter-side step spans to worker-side test spans is a second
  project. (Designer's call.)
- Instrumenting the writer/CLI further. It already has a self-telemetry port (`src/writer/ports.ts`,
  `src/api/telemetry.ts`); this project does not change it.
- New CI dashboard widgets. The existing timeline shows the new spans; a tests dashboard is a follow-up issue.

## Anti-goals (a failure even if it works)

- The shipped viewer bundle gains an SDK, an exporter, a network call, or any behaviour change when nothing is
  registered.
- A test run without an endpoint gets slower or noisier, or a run with an unreachable endpoint fails or hangs.
  Export failures are swallowed (a single warning at most); shutdown has a bounded timeout.
- Instrumentation changes a test's outcome. Vitest's built-in support registers a global provider in each worker;
  that is accepted because every unit test that uses OTel builds its own provider and none asserts on the global
  one; the library's own spans (`src/api/report.ts` uses the global tracer) are exported under vitest's spans, which
  is harmless (checked: `test/api/report.test.ts`, `test/model/sdk-*.test.ts`, `test/exporters/*.test.ts`). A new unit test
  that needs the global API must save and restore it.
- Telemetry goes somewhere the developer did not choose. It goes only to the endpoint in the environment.

## Facts the design rests on

- `mise run` with `MISE_OTEL_ENABLED=1` hands each task process `TRACEPARENT` set to that task's span (checked
  locally with mise 2026.10.25: an inherited `TRACEPARENT` comes back with the same trace id and a new span id),
  plus `OTEL_EXPORTER_OTLP_ENDPOINT`/`_PROTOCOL` (and `_HEADERS`, `OTEL_SERVICE_NAME=mise` when the developer's
  config sets them).
- The maintainer's local mise config exports to an OpenObserve instance (endpoint and auth headers in the
  environment), so local runs would export there too. That is the developer's chosen endpoint, so it is in scope;
  `OTEL_EXPORTER_OTLP_HEADERS` must be honoured.
- `otel-html run` defaults the child to `http/protobuf`; `grpc` is possible if the user sets it.
- `playwright.config.ts` already warns that workers inherit `OTEL_EXPORTER_OTLP_*` and that a test which spawns
  `serve`/`run` must unset them. That stays true.
- Every spec already takes its runtime `test` from `e2e/test.ts` (`test` or `hostileTest`). The seven
  `@playwright/test` imports in specs, plus those in `e2e/clipboard.ts` and `e2e/metric-chart.ts`, are type-only.

## Design

### Shared: the test SDK (`test-support/otel/`)

Both runners start the same SDK, `@opentelemetry/sdk-node`'s `NodeSDK` (the OTel JS SDK 3.0 line, which the
repo's `@opentelemetry/otlp-transformer` 0.300.0 already belongs to). One module builds it, or nothing:

- No `OTEL_EXPORTER_OTLP_ENDPOINT` (and no `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), or `OTEL_SDK_DISABLED=true` →
  no SDK; callers do nothing.
- Otherwise a `NodeSDK` with traces only (no metric reader, no log processor, no auto-instrumentations). Our module
  chooses the exporter from the protocol variables (`http/protobuf`, `http/json` and `grpc` all work); the exporter
  reads endpoint and headers from the environment itself. The SDK registers the global provider, the W3C propagator
  and the async-hooks context manager in that process.
- The module creates the `BatchSpanProcessor` itself and passes it in, so it can also queue finished spans from
  the browser (below).
- Resource: `service.name` from `OTEL_HTML_TEST_SERVICE_NAME`, else `otel-html-tests`, **not** the inherited
  `OTEL_SERVICE_NAME`, which mise sets to `mise` (designer's call). Plus `service.version` from `package.json` and
  the runner (`vitest`/`playwright`) as `test.framework` (custom attribute; there is no semconv key).
- Parent: vitest reads `TRACEPARENT` itself. The Playwright fixture extracts it with the global W3C propagator;
  malformed → fresh trace, no error.
- Shutdown flushes with a 5 s cap; an export error is logged once to stderr and otherwise ignored.

**New dependencies** (devDependencies, pinned exact): `@opentelemetry/sdk-node` 0.300.0 (`NodeSDK`: the global
provider, the W3C propagator, the async-hooks context manager); `@opentelemetry/sdk-trace` 3.0.0 (processors, the
in-memory exporter, `ReadableSpan`; sdk-node 0.300.0 has no `tracing`/`resources`/`core` re-exports);
`@opentelemetry/exporter-trace-otlp-{proto,http,grpc}` 0.300.0, chosen by protocol, because passing our own span
processor turns off NodeSDK's environment-built exporter. `@opentelemetry/resources` and `@opentelemetry/core`
2.12.0 were already present. Called out in the plan and the PR body as the conventions require.

### Vitest: built-in OpenTelemetry

Vitest has OpenTelemetry built in (`test.experimental.openTelemetry`: `enabled`, `sdkPath`, `browserSdkPath`;
<https://vitest.dev/guide/open-telemetry>). `vitest.config.ts` sets `enabled` only when the shared module says an
endpoint is configured, and `sdkPath` to `test-support/otel/vitest-sdk.ts`. Vitest imports that file in the main
process and in each worker. It default-exports the started SDK; vitest needs an object with `shutdown()` to flush at
the end, so with no endpoint the export is an inert `{ shutdown }`. That file needs a Biome `noDefaultExport`
override.

What vitest emits, as of 5.0.5: `vitest.test_run`; per worker the runtime and environment setup and teardown;
module transforms and imports; and, prefixed `vitest.test.runner.`, `collect_spec`, `run.suite` and `run.test` (attributes `vitest.test.name`,
`vitest.test.id`, `vitest.test.mode`, `vitest.suite.name`, …); hook spans (`test.beforeEach`, `suite.beforeAll`, …)
and `test.callback`. It reads `TRACEPARENT` itself, so the run nests under the mise task span.

**Accepted trade-offs (designer's call):** the feature is experimental, so span names may change in a vitest minor
release. Its attributes are vitest's own (`vitest.test.name`), not the semconv `test.case.*` keys used for
Playwright. Nothing in this project depends on the names except the CI check at the end, which looks for
`vitest.test.runner.run.test` and the vitest attributes.

The perf pass (`OTEL_HTML_PERF_PASS=1`) runs with the same config.

### Playwright: a worker fixture

Playwright has no built-in OpenTelemetry. The third-party `@playwright-labs/reporter-otel` (1.4.1) was considered
and rejected (designer's call). It runs in the reporter process, so its test spans do not exist while the page runs
in the worker, and the browser spans need a live parent there. It also pins `@opentelemetry/sdk-node` 0.217, which
would put a second SDK line next to 0.300.

An automatic worker-scoped fixture starts the shared SDK per worker. An automatic test-scoped fixture starts the
test's span before the test and ends it after, inside the worker, while the test runs.

- The span: name = the test title, `test.case.name` = the title path joined by ` > `, `test.suite.name` = the spec
  file, plus `playwright.project` (`chromium-file`, …), `otel_html.test.retry` and `otel_html.test.tags`. Status from `testInfo`
  after the test: `passed` → pass, `failed`/`timedOut` → fail with ERROR and the error message,
  `skipped` → skipped. Parent = `TRACEPARENT` (the `test:e2e*` task span).
- No per-file spans for Playwright: a file's tests are spread over workers and the worker cannot know when the
  file ends. (Designer's call.)
- The worker fixture shuts its provider down at worker teardown.
- The fixtures go on the base `test` in `e2e/test.ts`, from which `hostileTest` also derives, so every spec already
  gets them. A regression guard: no value import from `@playwright/test` outside `e2e/test.ts`. `import type` stays
  allowed everywhere. The builder picks the mechanism; a Biome `noRestrictedImports` rule with `allowTypeImports`,
  with `e2e/test.ts` exempt, is the obvious one.
- Skipped tests start when the fixture starts and have zero duration. (Designer's call.)

### Viewer: spans through `@opentelemetry/api`

`@opentelemetry/api` is already a runtime dependency. The viewer gets a tracer named `otel-html-viewer` (no version; `viewer.load` carries `otel_html.report.version`)
and spans for:

- `viewer.load`: from script start until the data source is ready (manifest parsed, strategy chosen), with the
  manifest's totals and format version as attributes.
- `viewer.chunk.load`: each chunk script load (`src/viewer/data/script-loader.ts`), with `otel_html.path` and
  `otel_html.key`; errors and timeouts as ERROR.
- `viewer.query`: each span, log and metric query in `src/viewer/data/` (the `*-query.ts` entry points) with
  `otel_html.query.kind`, `otel_html.query.result_count` and `otel_html.query.aborted` (no signal attribute).
- `viewer.navigate`: each hash-route change (`src/viewer/state/hash-history.ts`), with the route (no query values:
  filter text could be large; the route name and which parameters are set is enough). Ends when the new route's
  first data is ready if that is cheaply knowable, else it is a zero-duration marker span (builder's choice).

Exact span placement inside the data layer is the builder's choice; the list above is the coverage, not the line
numbers. Nesting is best-effort: browsers have no async context, so spans started inside an active span's
synchronous callback nest, and the rest attach to the page's base context (the test span, below). Attributes use
the `otel_html.` prefix for project-specific keys.

**Cost when unregistered:** the no-op API. A unit test asserts that rendering a report with no provider registered
makes no network request and registers nothing on `window` beyond what it does today. The bundle grows by the API
facade only. The plan records the before/after gzipped size of `dist/viewer` and puts it in the PR body. Growth over
5 KB gzipped stops the work and goes back to the maintainer, with a thin internal wrapper as the alternative.
(Designer's call.)

### Delivery

One PR under the unattended process (`docs/agents/process-unattended.md`); the maintainer chose the process,
and one PR is the designer's call, following the maintainer's fewest-PRs preference. Its title is
`feat: OpenTelemetry spans from the viewer and a span per test`.

### Collecting browser spans in e2e

In the test-scoped fixture, when the worker has a provider and the test is eligible (see the limits below):

1. A small in-page recorder is installed on the test's `context` (`context.addInitScript` and
   `context.exposeBinding`, overriding the `context` fixture), so every page the test opens is covered, popups
   included. (Designer's call.) It is a test-only bundle
   (`e2e/otel-page/`), built from TypeScript into one IIFE file next to the fixture reports by the `e2e:fixtures`
   task (builder's choice of bundler among the repo's existing ones; the output is not shipped). It contains a
   minimal `BasicTracerProvider` with a `SimpleSpanProcessor` and an exporter that hands each finished span, as
   plain JSON (ids, parent id, name, kind, start/end, attributes, status, events), to a binding exposed with
   `page.exposeBinding('__otelHtmlSpans', …)`. It registers itself with `trace.setGlobalTracerProvider` from its own
   copy of the API, which the viewer's copy shares through the API's global slot (the API's supported multi-copy
   mechanism; the versions must be compatible, so the bundle pins the same `@opentelemetry/api` as the viewer).
2. It also sets a context manager whose base context holds the test span's context (trace id, span id, flags passed
   into the init script as arguments), so the viewer's root spans are children of the test span.
3. The Node side turns each JSON span back into a `ReadableSpan` with resource `service.name=otel-html-viewer`
   and hands it to the worker's exporter, so headers, protocol and batching are configured once.
4. Before the test span ends, the fixture lets pending binding calls settle (the in-page processor is synchronous,
   so this is a short await on in-flight bindings, not a sleep).

**Limits (designer's call):**

- No recorder for `@perf`-tagged tests, for `scale.spec.ts` and `load.spec.ts`, or for `hostileTest` (the hostile
  report; the recorder's binding would take input from hostile content). They still get their test span;
  only the in-page recording is off, so their timing is what it was.
- Each test records at most 2,000 viewer spans. Spans past the cap are dropped and counted in
  `otel_html.viewer.spans.dropped` on the test span.
- The cost has to stay small in every remaining test, including the `-http` project. The plan measures the full
  Chromium e2e suite's wall time with and without an endpoint and puts both numbers in the PR body. More than 10%
  slower stops the work and goes back to the maintainer.

The recorder's page-side SDK is `@opentelemetry/sdk-trace-base` 2.12.0, which is already installed and runs in a
browser; it talks to the viewer only through the API. On the worker side, spans are rebuilt as the SDK 3.0
`ReadableSpan` that `sdk-node`'s `tracing` exports.

Timestamps: the page and the worker share a machine clock; the in-page SDK's times are used as they are.

### CI

Nothing to wire: the job shell already exports `OTEL_EXPORTER_OTLP_ENDPOINT`, `MISE_OTEL_ENABLED` already makes
mise pass `TRACEPARENT` to tasks, and Playwright workers and vitest inherit both. The checks:

- The CI report of a PR run contains `vitest.test.runner.run.test` spans under the `test:unit` task span and `test.case.name` spans
  under the `test:e2e:chromium` task span, and viewer spans under e2e test spans. The plan's final task opens a PR, downloads the job's report, and
  records span counts in the PR body.
- The existing `ci` dashboard's span toplist query (`instrumentation_scope.name == "otel-html-ci"`) is unaffected.

### Tests for the instrumentation

- Unit (vitest, node project): the SDK module starts nothing without an endpoint, honours `OTEL_SDK_DISABLED`,
  sets the resource (not `OTEL_SERVICE_NAME`), and queues a foreign span. The JSON → `ReadableSpan` mapping
  round-trips. Vitest's own spans are checked end to end: the unit suite runs under an `otel-html run` receiver and
  the report must hold `vitest.test.runner.run.test` spans under `vitest.test_run`.
- Unit (viewer project): with an in-memory provider registered in that test only (and unregistered after), loading a
  scripted report produces `viewer.load` and `viewer.chunk.load` spans; a query produces `viewer.query`. With
  nothing registered, no requests.
- E2E: one spec, run against a local `otel-html serve` receiver started by the spec (port 0, endpoint unset from the
  inherited environment first, as the config comment requires), runs a child Playwright test… — **builder's
  choice** whether this end-to-end check is a nested Playwright run or a unit-level test of the fixture with a real
  browser page; it must prove that a viewer span arrives with the test span as parent.

## Constraints

- Conventions in `docs/agents/conventions.md`: strict TypeScript, Biome, TDD per task, pinned exact versions, new
  dependencies named in the plan and PR body, README updated for any behaviour change. The README gets a short
  section in Development on where test and viewer spans go (and that the shipped viewer sends nothing).
- `knip` must stay clean: the test-support modules and the page bundle entry must be reachable from configs.
- `mise run check` time must not grow noticeably without an endpoint (the module returns before importing the
  exporters: dynamic import).
- The task cache: an endpoint in the environment must not change cache keys; with the cache replaying a task, no
  test spans are produced for it, which is correct (nothing ran).

## Left to the builder

- Bundler for the in-page recorder; where its output lives under the fixture output.
- Exact span boundaries in the viewer data layer and router.
- Retry representation in vitest.
- The mechanism of the import guard for e2e specs.
- The shape of the end-to-end proof of browser-span parenting.
