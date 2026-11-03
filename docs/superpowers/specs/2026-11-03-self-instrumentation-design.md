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

1. Every vitest test case and every Playwright test produces a span when an OTLP endpoint is configured, with the
   OTel test semantic conventions (`test.suite.name`, `test.case.name`, `test.case.result.status`) and the error
   message on failure.
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
- Instrumentation changes a test's outcome: a global tracer provider registered in a vitest worker would leak into
  the unit tests that exercise `src/api/telemetry.ts` and the exporters. Test instrumentation never calls
  `trace.setGlobalTracerProvider` (or `context.setGlobalContextManager`) in a test process.
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

### Shared: the test exporter (`test-support/otel/`)

One small module builds a tracer for test processes, or nothing:

- No `OTEL_EXPORTER_OTLP_ENDPOINT` (and no `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) → returns `undefined`; callers do
  nothing. `OTEL_SDK_DISABLED=true` also disables it.
- Otherwise a `BasicTracerProvider` (from `@opentelemetry/sdk-trace-base`, already a devDependency) with a
  `BatchSpanProcessor` and an OTLP trace exporter chosen by `OTEL_EXPORTER_OTLP_PROTOCOL`: `http/protobuf`
  (default) or `http/json`. `grpc` → a one-line warning and no export (designer's call: tests do not pull in a gRPC
  exporter for a protocol neither mise nor `run` defaults to). The exporter reads endpoint and headers from the
  environment as the OTLP exporters already do.
- Resource: `service.name` from `OTEL_HTML_TEST_SERVICE_NAME`, else `otel-html-tests` — **not** the inherited
  `OTEL_SERVICE_NAME`, which mise sets to `mise` (designer's call). Plus `service.version` from `package.json` and
  the runner (`vitest`/`playwright`) as `test.framework` (custom attribute; there is no semconv key).
- The parent context is `TRACEPARENT` parsed by the W3C propagator into a non-recording parent; malformed → fresh
  trace, no error.
- The provider is used directly (`provider.getTracer(...)`), never registered globally.
- `shutdown()` flushes with a 5 s cap; an export error is logged once to stderr and otherwise ignored.

**New dependency:** `@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/exporter-trace-otlp-http`
(devDependencies, pinned exact, versions matching the installed `sdk-trace-base` line). Called out in the plan and
the PR body as the conventions require. Also `@opentelemetry/core` for the W3C propagator (already a devDependency).

### Vitest: a reporter

A custom reporter (`test-support/otel/vitest-reporter.ts`, added to `reporters` in `vitest.config.ts` next to the
default) builds the spans in the main process after the fact, from vitest's results (start time and duration per
task). Reporter, not setup file, because it runs once in the main process, sees skipped tests, needs no global
state in workers, and cannot affect a test (designer's call).

Span tree:

- `vitest` run span (start = run start, end = run end), parent = `TRACEPARENT`.
  - one span per test file, name = the path relative to the repo, `test.suite.name` = the path, and the vitest
    project (`node`/`viewer`) as `vitest.project`.
    - one span per `describe`, name = the suite name.
      - one span per test, name = the test name, `test.case.name` = the full name (suites joined by ` > `),
        `test.case.result.status` = `pass`/`fail`, skipped tests get `test.case.result.status=skipped` (designer's
        call: the semconv enum has only pass/fail, a skipped test is still worth seeing) and zero duration. A
        failure sets span status ERROR with the first error's message, and an `exception` event with message and
        stack. Retries: one span per attempt if vitest exposes them, else one span with `test.case.retry.count`
        (builder's choice).

The perf pass (`OTEL_HTML_PERF_PASS=1`) gets the same reporter; its tests are just fewer.

### Playwright: a worker fixture

An automatic worker-scoped fixture owns the provider per worker; an automatic test-scoped fixture starts the
test's span before the test and ends it after, inside the worker, live. Fixture, not reporter, because the browser
spans must be parented to the test span, and that span must exist in the worker while the page runs (designer's
call).

- The span: name = the test title, `test.case.name` = the title path joined by ` > `, `test.suite.name` = the spec
  file, plus `playwright.project` (`chromium-file`, …), `test.case.retry` and the tags. Status from `testInfo`
  after the test: `passed` → pass, `failed`/`timedOut` → fail with ERROR and the error message,
  `skipped` → skipped. Parent = `TRACEPARENT` (the `test:e2e*` task span).
- No per-file spans for Playwright: a file's tests are spread over workers and the worker cannot know when the
  file ends. (Designer's call.)
- The worker fixture shuts its provider down at worker teardown.
- The fixtures go on the base `test` in `e2e/test.ts`, from which `hostileTest` also derives, so every spec already
  gets them. A regression guard: no value import from `@playwright/test` outside `e2e/test.ts`. `import type` stays
  allowed everywhere. The builder picks the mechanism; a Biome `noRestrictedImports` rule with `allowTypeImports`,
  with `e2e/test.ts` exempt, is the obvious one.
- Skipped tests (vitest and Playwright) start where their parent starts and have zero duration. (Designer's call.)

### Viewer: spans through `@opentelemetry/api`

`@opentelemetry/api` is already a runtime dependency. The viewer gets a tracer named `otel-html-viewer` (version =
the package version) and spans for:

- `viewer.load`: from script start until the data source is ready (manifest parsed, strategy chosen), with the
  manifest's totals and format version as attributes.
- `viewer.chunk.load`: each chunk script load (`src/viewer/data/script-loader.ts`), with signal, chunk number and
  bytes; errors and timeouts as ERROR.
- `viewer.query`: each span, log and metric query in `src/viewer/data/` (the `*-query.ts` entry points) with the
  signal, the query kind, and the result count.
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

- No recorder for `@perf`-tagged tests or for `scale.spec.ts` and `load.spec.ts`. They still get their test span;
  only the in-page recording is off, so their timing is what it was.
- Each test records at most 2,000 viewer spans. Spans past the cap are dropped and counted in
  `otel_html.viewer.spans.dropped` on the test span.
- The cost has to stay small in every remaining test, including the `-http` project. The plan measures the full
  Chromium e2e suite's wall time with and without an endpoint and puts both numbers in the PR body. More than 10%
  slower stops the work and goes back to the maintainer.

Registration happens only in the browser page, which is a test-controlled environment, so the anti-goal about
global providers in test processes does not apply.

Timestamps: the page and the worker share a machine clock; the in-page SDK's times are used as they are.

### CI

Nothing to wire: the job shell already exports `OTEL_EXPORTER_OTLP_ENDPOINT`, `MISE_OTEL_ENABLED` already makes
mise pass `TRACEPARENT` to tasks, and Playwright workers and vitest inherit both. The checks:

- The CI report of a PR run contains `test.case.name` spans under the `test:unit` and `test:e2e:chromium` task
  spans, and viewer spans under e2e test spans. The plan's final task opens a PR, downloads the job's report, and
  records span counts in the PR body.
- The existing `ci` dashboard's span toplist query (`instrumentation_scope.name == "otel-html-ci"`) is unaffected.

### Tests for the instrumentation

- Unit (vitest, node project): the exporter module returns `undefined` without an endpoint, honours
  `OTEL_SDK_DISABLED`, parses `TRACEPARENT`, ignores a malformed one, picks the exporter by protocol. The vitest
  reporter is fed synthetic task results and checked against an in-memory exporter (span names, nesting, status,
  attributes, times). The JSON → `ReadableSpan` mapping round-trips.
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
