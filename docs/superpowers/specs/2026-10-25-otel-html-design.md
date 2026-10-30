# otel-html: design

Date: 2026-10-25 · Status: draft for approval

## 1. Intent

A lightweight, **OpenTelemetry-first** library and CLI that turns OTel traces, logs and metrics into a **static, self-contained HTML report**. The report is fast and well designed, and lets you drill down across the three signals.

Why: CI runs (and other short, bounded runs, such as local test sessions, batch jobs and load tests) emit rich telemetry, but viewing it today means standing up an observability backend. otel-html produces a folder you can attach as a CI artifact, publish to GitHub/GitLab Pages, or open from local disk, with no server.

The bar for the viewer is the depth and polish of the best commercial log, trace and metrics explorers, **in our own visual design language**. Grafana LGTM and SigNoz are the counter-examples ("clunky and watered down").

CI is one use case among several. **Nothing in the core model or the main views may be coupled to CI.** A CI-specific view can come later as an optional add-on.

## 2. Goals, non-goals, anti-goals

**Goals**
- Convert OTLP (JSON or protobuf; files, a live stream, or in-process SDK objects) into a static report.
- Three ways in: a **library API** (convert a file, or feed OTel models to a `Report` writer), **OTel SDK exporters**, and an **OTLP receiver** that writes the report incrementally as data arrives. A **CLI** and a **standalone binary** wrap all three.
- Explorers for Traces, Logs and Metrics, plus Dashboards (starting with the built-in **Fusion** dashboard), all linked so that any element drills into the others.
- Viewable from `file://`, GitHub Pages, GitLab Pages, and any static host or subpath.
- Optimized for runs up to about 100k spans and 1M logs; arbitrarily large runs still work, more slowly (§7.6).
- Reuse OTel itself, and popular existing libraries, wherever possible. Roll our own only for the product core.
- One set of mise tasks that runs identically locally and in GitHub Actions; GHA workflows for testing and packaging.

**Non-goals (v1)**
- Python or other language bindings. Non-JS users use the CLI, the binary or the receiver; a pip wrapper around the binary may come later.
- Live tail, alerting, authentication, multi-run comparison, a hosted service.
- The OTel **profiles** signal. Leave room in the model; don't build it.
- A CI/CD-specific view.
- Persisting edits made in the viewer, beyond the URL and optional `localStorage`.

**Anti-goals (failure even if it "works")**
- Looking like a clone of any vendor's product: copied branding, colors, icons, CSS, or trademarks.
- Inventing our own query or config language where an OTel or community standard exists.
- A report that needs a server, network access, or a specific host to open.
- A data model that reshapes OTel into something proprietary. OTLP is the model.
- Duplicated UI: an embedded view that looks or behaves differently from its top-level explorer.

## 3. Constraints

- **Language: TypeScript only** (v1) for library, writer, receiver, CLI and viewer.
- **Tooling: mise** defines tools and tasks; **GitHub Actions** runs the same tasks.
- **Release:** binaries attached to GitHub Releases now; npm publish once the repo is public.
- **The report must open from `file://`.** This rules out `fetch`/XHR, ES-module scripts, separate worker files, and network-loaded WASM (§7.4).
- **OTel fidelity:** follow the OTLP spec, the OTLP/HTTP receiver rules and the semantic conventions; use only OTel data. No vendor-specific concepts that OTel data can't populate (e.g. log indexes, log sources, network monitoring).
- **Size matters but loses to reuse:** prefer an existing library unless it is badly oversized for the job.

## 4. Approaches considered (and chosen)

| Decision | Options considered | Chosen | Why |
|---|---|---|---|
| Implementation language | Go core + wrappers; Rust core + native bindings; **TypeScript everywhere** | TypeScript | The viewer is TS regardless. One language for writer and viewer; shared model and parser. A binary is still possible via Bun. The partner was unsure non-TS bindings are worth it. |
| Streaming ingestion | **Built-in OTLP receiver**; per-language in-process exporters; tail a Collector file | Receiver **plus** library API and SDK exporters | The receiver is language-agnostic and needs zero code; the API and exporters serve users who don't want a process. Tailing a Collector file is covered by `convert` on file-exporter output. |
| SDK→OTLP mapping | `@opentelemetry/otlp-transformer`; own mapping | Own mapping, tested against the transformer | The transformer package is marked "internal use only" and experimental. |
| Dashboard config | Perses spec; Grafana JSON/Foundation SDK; **own minimal schema** | Own minimal schema + **OTTL** conditions | Perses visuals are limiting and not OTel-first, and Perses is pre-1.0 with fresh breaking changes. Grafana has a large, shifting schema and three query languages. Our schema stays tiny, and conditions use OTel's own language. |
| Filter / condition language | TraceQL / LogQL / PromQL; **OTTL**; own | OTTL (conditions subset) | OTel-native, with paths matching the OTel data model; conditions can be pasted from Collector configs. The language belongs to OTel, not us. |
| Chart engine | **ECharts**, uPlot, Vega-Lite, Observable Plot | ECharts 6 | JSON-configured, good-looking defaults, brush/zoom/events, large-data modes, runtime themes. Proven in a spike (§12). |
| Flame graph | Custom canvas; **ECharts custom series** | ECharts custom series | Zoom/pan for free; 50k spans in about 120 ms in the spike. |
| Waterfall | ECharts; **virtualized HTML** | Virtualized HTML | It's a tree with text; exact design match; 50k rows in 4 ms. |
| UI framework | **React 19**; Preact | React | Ecosystem compatibility for every chosen library; Preact's compat layer risks friction for about 55 KB of savings. |
| Data loading for scale | All in memory; always on-demand; **one format, two strategies** | Chunked format; eager load under a budget, windowed on-demand above it | Optimizes the common case, scales arbitrarily, single format. |
| Packaging | **One package**; split packages | One package (`otel-html`) to start | Partner's call. Split later if needed. |

## 5. Architecture

```
            ┌────────────── inputs ───────────────┐
 OTLP files ─┤ convert(file)                        │
 SDK objects─┤ Report writer API ◄── SDK exporters │──► Writer core ──► report folder
 OTLP stream─┤ Receiver (HTTP+gRPC) ◄── run -- cmd │     (streaming:      ├ index.html
            └──────────────────────────────────────┘      chunks, rollups, ├ assets/ (prebuilt viewer)
                                                           trace index)     └ data/ (manifest, rollups, chunks)
```

**Package `otel-html`** (single npm package; internal modules):
- `model`: OTLP types (generated from `opentelemetry-proto` via protobuf-es), OTLP-JSON quirks (hex IDs, integer enums, int64 as string or number, unknown fields ignored), and normalized in-memory records.
- `ottl`: Lezer grammar and evaluator for OTTL conditions. Shared by writer and viewer.
- `writer`: streaming writer that produces chunks, rollups, trace index, manifest and dashboards. Bounded memory.
- `receiver`: OTLP/HTTP (built-in `node:http`) and OTLP/gRPC (`@grpc/grpc-js`) feeding the writer.
- `exporters`: `SpanExporter`, `LogRecordExporter` and `PushMetricExporter` implementations feeding the writer.
- `cli`: `convert`, `serve`, `run` (commander).
- `viewer`: React app built separately (Vite, classic non-module bundle), shipped inside the package as static assets and copied into each report.

**Public API (shape; final names are the builder's call):**
```ts
await convert({ input: 'run.otlp.json' | ['a.json', 'b.pb'], out: './report', config?: ConfigObject | 'otel-html.yaml' });

const report = await Report.create({ out: './report', title?, config? });
report.addSpans(readableSpans | otlpTraceRequest);
report.addLogs(readableLogRecords | otlpLogsRequest);
report.addMetrics(resourceMetrics | otlpMetricsRequest);
await report.close();   // flush chunks, finalize rollups and manifest

new OtelHtmlSpanExporter({ report }) / OtelHtmlLogRecordExporter / OtelHtmlMetricExporter
```

**CLI**
- `otel-html convert <files…> -o <dir> [--config f]` accepts OTLP JSON, OTLP protobuf, and Collector file-exporter JSON-lines.
- `otel-html serve -o <dir> [--http 4318] [--grpc 4317]` receives and writes until SIGINT/SIGTERM, then finalizes.
- `otel-html merge <reports…> -o <dir>` combines reports (§7.5).
- `otel-html run -o <dir> -- <cmd…>` starts the receiver, creates a root span for the command, and launches the child with `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` and `TRACEPARENT` (W3C traceparent via the env-carrier spec, which is Release Candidate; best-effort). The child's exit code and duration become root-span attributes. The CLI exits with the child's exit code.
- Standard `OTEL_*` env vars and default ports are honored. Resource detectors (env, host, process) populate the root span's resource.

**Self-telemetry:** the library instruments itself with `@opentelemetry/api` only, a no-op unless the host app registers an SDK.

## 6. Ingestion and OTel fidelity

- **Receiver** follows the OTLP spec: JSON and protobuf, gzip and uncompressed request bodies; response Content-Type matches the request; partial-success responses with `rejected_*` counts; retryable statuses only 429/502/503/504 (with `Retry-After` when throttling); a 64 MiB post-decompression limit returning 413; CORS allowed for localhost browser telemetry.
- **Data kept verbatim:** resource, scope, attributes (full AnyValue, including maps, arrays and bytes), events, links, status, dropped counts, flags, observed timestamps, exemplars, metric temporality, monotonicity, and all point kinds (gauge, sum, histogram, exponential histogram, summary).
- **Semantic conventions drive presentation, never the model:** attribute grouping by namespace (`http.*`, `url.*`, `server.*`, `db.*`, `exception.*`, …), the Service column (`service.name`), the Resource column (`http.route` + method, else span name), severity, exceptions, and `event.name`. Incubating convention constants are **copied**, not imported, per the OTel JS guidance.
- **Signal links use OTel's own fields:** log↔span via `trace_id`/`span_id`, metric→trace via exemplars, trace↔trace via span links, grouping via resource attributes.
- **"Service entry span":** a span whose parent is absent or has a different `service.name`.

## 7. Report format

### 7.1 Folder layout
```
report/
  index.html                 # tiny shell; classic <script> tags only
  .nojekyll                  # GitHub Pages: don't hide anything
  assets/viewer.<hash>.js    # prebuilt viewer (classic IIFE bundle), css, fonts if any
  data/
    manifest.js              # run metadata, chunk list (signal, time range, size), budgets, dashboards
    rollups/*.js             # time buckets, facet values+counts, percentile histograms, metric series at N resolutions, log patterns
    chunks/<signal>/<n>.js   # detail records, a few MB each, time-partitioned
    traces/<shard>.js        # trace index: trace_id → chunk refs (+ small per-trace summaries)
```
No file or folder starts with `_`. Paths are relative; the viewer works under any subpath.

### 7.2 Encoding
- Every data file is a **classic script** that calls a registration global, e.g. `__OH__.push("chunks/logs/12", payload)`. That is what makes `file://` work.
- Payloads are **columnar**: per-chunk string dictionaries, delta-encoded timestamps, numeric columns. Readable enough to debug; compact without relying on server gzip.
- Optional later: gzip+base64 payloads decoded with `DecompressionStream`; `.gz` siblings for GitLab Pages.
- The exact encoding is the builder's call, subject to the rules above and to the load-test budgets.

### 7.3 Rollups (precomputed by the writer)
- Time buckets per signal: spans by status, logs by severity, metric point counts. These feed every histogram and the Fusion timeline.
- Facet values and counts per attribute key, per signal; top-N with an "other" count for high cardinality.
- Duration percentiles per (service, resource), stored as OTel **exponential histograms** (the same math as metric percentiles). These power the `p97` badges.
- RED summaries for the trace list (requests, errors, latency percentiles over time).
- Metric series at several resolutions, so the browser never charts more than a few thousand points per series. The spike showed 3×1M raw points costs about 1 s.
- Log patterns (Drain algorithm, implemented in-house, about 200 lines).

### 7.4 file:// and static-host rules
- No `fetch`/XHR/ES modules/separate worker files/network WASM. Workers, if used, come from inline blob URLs.
- Hash routing; all state lives in the URL (`#/traces?q=…&t=…&sel=…`).
- `localStorage` is optional (saved views); everything works without it.
- **e2e tests open sample reports from `file://` and from a static server in Chromium, Firefox and WebKit.**

### 7.5 Writer sessions, append and merge (one code path)
- **Every input uses the same writer session:** open → `add*` (streaming) → periodic flush → close. That covers `convert`, the `Report` API, the SDK exporters (open at construction, add per export batch, close on `shutdown()`), and the receiver, `serve` and `run` (open at start, add per OTLP request, close on exit).
- **Rollups are mergeable by design:** counts, time buckets, exponential histograms, multi-resolution metric series, facet counts (exact up to a cardinality cap, then "other"), Drain state, and the dedupe ID set.
- **Session state is checkpointed at every flush** to `data/state/`, a versioned format. The report stays valid if the writer is killed mid-run.
- **Append = reopen:** load the checkpoint and continue the session. Allowed only with the same otel-html version; otherwise it errors and points to `merge`.
- **`otel-html merge <reports…> -o <dir>`** combines reports by reading their **data chunks** (not state) and using the same merge functions. It works across versions and covers parallel CI jobs or multi-process producers.
- **One writer per folder:** a lock file blocks a second concurrent writer and points to the receiver (one writer, many senders) or to `merge`.

### 7.6 Scale: one format, two loading strategies
- **Under a decoded-size budget (initially about 50–100 MB; tunable):** the viewer eager-loads all chunks. Filters, facets and drill-downs are exact and in-memory. This is the optimized, CI-tested path.
- **Above budget:** landing views render from rollups. Filtered lists scan only chunks in the selected time window, with progress ("scanned 12 of 340 chunks") and a result cap; chunks outside the window are evicted. Trace and log jumps use the trace index, so they load one shard.
- **Writer:** streaming with bounded memory. Buffer, write chunk, update rollups and indexes incrementally. Spans of one trace far apart in time land in different chunks and are joined via the trace index.
- **Receiver live mode:** the writer rewrites `manifest.js` atomically as chunks land, so a report opened mid-run shows data up to that point. A live "following" indicator and auto-reload is **deferred** (§15).

## 8. Viewer

Reference mockups are in [`2026-10-25-otel-html-mockups/`](2026-10-25-otel-html-mockups/). The fragments there were rendered inside the brainstorming frame, so page chrome may differ when opened standalone. The **functionality and design language** in them is what's approved.

### 8.1 Design language (our own)
- Warm off-white page (`#f6f6f3`), white surfaces, ink text (`#16181d`), hairline borders, rounded cards (10–12px).
- **Teal accent** (`#0f766e`). The selected state is a solid **ink** pill; no blue segmented controls.
- System UI font; monospace with tabular numbers for times, durations, IDs and attribute keys and values.
- Categorical series and service colors and the status palette come from the **validated dataviz palette** (`#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #6250d6`; dark-mode steps defined). Status: critical `#d03b3b`, warning `#fab219`. Color follows the entity (a service keeps its color everywhere); never cycle hues. Errors always pair color with an icon, label or hatch, never color alone.
- Light and dark modes, both designed and validated. Tokens are CSS variables; ECharts themes are generated from the same tokens and switched at runtime (`setTheme`, ECharts 6).
- Charts follow the dataviz skill rules: thin 2px lines, a single y-axis, recessive grid, a legend for 2+ series, hover crosshair and tooltip.

### 8.2 Navigation and shell
- **Left sidebar** (light, labeled): a run card (title, time span, per-signal totals); **Dashboards**, **Logs** (Explorer, Patterns), **Metrics** (Explorer, Catalog), **Traces** (Explorer, Services); keyboard shortcuts (`g d/l/m/t`); theme toggle.
- Shared page chrome: a **Views ▾** menu (config-defined plus local saved views), a **time range** control (defaults to the entire run, ◀ ▶ step, zoom out; dragging on any chart narrows it; no live/pause), **Copy link**, **Export**.

### 8.3 Shared components (the reuse rule)
Embedded views **are** the explorer components with filters pre-applied. One implementation each:
- **Query bar with filter tokens** (key / operator / value; compiles to OTTL; free text searches all attributes; `+ Query` adds a second query).
- **Facet panel** (Core / Resource / Attributes groups; "N of M shown" + Add; per-value share bar and count; hover only/exclude; value search; duration as a histogram with a draggable range).
- **Histogram card**, **Results table** (column picker, sort, Export as CSV, JSON or OTLP JSON), **Trace list**, **Log list** (lines-per-row option), **Flame graph**, **Waterfall**, **Chart card** (S/M/L), **Attribute groups** (semconv namespaces, pinned attributes, nested tree, filter/exclude/copy per value), **Fusion timeline**.
- **Selection store** (Zustand): time range, trace_id, span_id, and filters. Every component reads and writes it; links never live in config. Library events (ECharts brush, click, zoom) are forwarded into the store; libraries never own selection state.
- "Open in … Explorer" always carries current filters and selection.

### 8.4 Traces (mockups 01, 02)
- **Explorer:** Spans / Traces toggle; query bar; Group by; View: List, Timeseries, Top list, Bar, Table, Point plot, Treemap, Pie (no Flow Map); collapsible **Requests / Errors / Latency** strip (p50–p99, max) with "Analyze" shortcuts; facets; results table with Time, Status (labeled dot), Service, Resource, Duration, Method, Code (class-tinted pill), Spans, **Latency by service** (stacked bar), any attribute column.
- **Trace panel** (opens on row click; slides over the list, leaving a narrow column of it visible; `j/k` move between traces, `Esc` closes, Full page / Copy link / Export trace):
  - Header: service › resource › trace ID; percentile badge, duration, method + URL, status code, error state, time, and counts.
  - Trace tabs: **Flame graph** (filter spans, errors only, color by service/host/scope, minimap, % exec-time legend), **Waterfall**, **Span list**, **Services** (a per-service table; no node map in v1, see §13), **Logs**, **Errors**.
  - A resizable split, then the **span section**: header with percentile badge, duration and share of trace. Tabs: **Overview** (exceptions first, then pinned, then attribute groups), **Events**, **Logs**, **Metrics**, **Links**, **Resource** (resource + scope attributes). Only tabs OTel data can fill; no Database, Infrastructure, Processes, Network or Profiles.

### 8.5 Logs (mockup 03)
- **Explorer:** same frame as Traces. Group into **Logs / Patterns / Traces** (by trace_id). View: List, Timeseries, Top list, Bar, Table, Treemap, Pie, Scatter. Severity-stacked histogram.
- Facets: **Severity** (from SeverityNumber, shown with SeverityText), Service, `host.name`, Scope, `event.name`, Has trace, attributes.
- Body rendered by AnyValue type: string as raw/wrapped with key=value and JSON highlighting; map or array as a tree.
- **Log detail panel:** severity with number, timestamp and observed timestamp, and Surrounding logs / Copy link / Export actions; fact cards for Service, Host, Scope and Trace (linked trace and span IDs); body. Tabs: **Attributes**, **Trace** (only when trace_id exists; the shared flame graph with the emitting span outlined and a "this log" marker), **Metrics**, **Surrounding logs**, **Resource**.

### 8.6 Metrics (mockup 04)
- **Explorer** (default for Metrics). Query rows a, b, c…: **metric** (type badge and unit from OTLP), **where** (filter tokens → OTTL), **show** (choices depend on type: Sum → rate/increase/sum; Gauge → avg/min/max/last; Histogram/ExpHistogram → p50–p99/count/sum/avg from buckets; Summary → its quantiles), **by** (group by any resource or point attribute), **ƒ** (rate, increase, rollup, top-N), alias. `+ Formula` (`a / c`). Temporality handled automatically.
- Display: Lines, Area, Bars, Heatmap, Distribution (the last two for histograms); linear or log scale; exemplars toggle; one chart per query.
- **Chart click** pins a menu: exemplar → trace, traces in window, logs in window, zoom to time.
- **"Copy as dashboard widget"** copies the widget's config for the dashboard config file (a static report can't save to a dashboard).
- **Catalog:** every metric with type, unit, temporality, scope, attribute keys, series count and sparkline. Click opens it in the Explorer.
- **Embedded grid** (log, span and trace Metrics tabs): charts grouped by semconv namespace, filtered to the originating resource, with a "this log/span" marker and highlighted matching exemplars.

### 8.7 Dashboards and Fusion (mockup 05)
- **List:** built-in Fusion (default) plus config-defined dashboards, with source shown.
- **Fusion:** a 12-column grid (react-grid-layout). Widgets: full-width **Timeline** (spans by status, logs by severity, metric points, all on one time axis; drag to brush), **Traces** (list + mini flame graph of the selected trace), **Logs** (with **Only matches / Show context**), and **Metrics** (chart cards following the selected trace's resources, with the window marked).
- **Variables** (dropdowns, e.g. `service.name`, environment, `host.name`) apply to all widgets. **Selection chips** (time, trace_id) come from interaction, each with ✕, plus Clear all. Each widget has a **⛓ follows selection** toggle.
- Edit layout (drag/resize) → **Copy config**. There is no in-report persistence beyond the URL and localStorage.

## 9. Query and config model

- **Conditions: OTTL**, conditions subset only (boolean expressions over paths, literals, comparisons, `and/or/not`, and a minimal set of converters to be chosen by the builder, e.g. `IsMatch`). Paths follow OTTL contexts: `resource.attributes["…"]`, `attributes["…"]`, `name`, `status.code`, `severity_number`, `body`, and so on. One grammar (Lezer) shared by viewer and writer. Filter tokens in the UI are a structured editor over OTTL; the raw OTTL is viewable and editable.
- **Free text** is a separate, simple contains-match across body, name and attribute values. It is not OTTL.
- **Metric query:** `{ metric, show, by[], where (OTTL), fn[] }` plus formulas over query IDs. OTel vocabulary only.
- **Config file** (`otel-html.yaml` or an object passed to the API), validated by Zod 4 with a generated JSON Schema for editor autocomplete:
  - `dashboards[]`: `id, title, variables[], widgets[]`, where each widget has `type (timeline|traces|logs|metric|…), x, y, w, h`, a type-specific `query`/`queries`, and a few display options.
  - An optional, explicitly **unstable `echarts:`** pass-through on chart widgets. Its compatibility is ECharts', not ours.
  - `views[]` (saved explorer views), `title`, budgets and other writer options (builder's call).
- **One schema for everything configurable** (§11.1): the same Zod schema validates the file, the API object, env vars and CLI flags, and Fusion ships as a config document in that schema.
- **Compatibility stance:** keep our schema minimal. Most expressive power lives in OTTL (owned by OTel) and in the optional ECharts pass-through.

## 10. Libraries

| Layer | Library |
|---|---|
| Viewer | React 19, ECharts 6 (tree-shaken), react-grid-layout 2, Base UI 1.x (`@base-ui/react`), TanStack Virtual, TanStack Table, wouter (hash routing), Zustand, Tailwind 4 (tokens as theme), Lucide, react-json-view-lite |
| Shared | Lezer (OTTL grammar), Zod 4 |
| Node side | protobuf-es (`@bufbuild/protobuf`) + generated `opentelemetry-proto`, `@grpc/grpc-js`, built-in `node:http`, commander, yaml, `@opentelemetry/api` (+ SDK packages for exporter types) |
| Tooling | TypeScript 7, Vite 8 (viewer, classic bundle), tsdown (library), Bun `build --compile` (binaries), Biome, knip, publint, arethetypeswrong, lefthook, commitlint, Vitest, Playwright, telemetrygen, release-please |

**Built in-house (the product core):** flame graph drawing code, waterfall, writer chunking/rollups/trace index, OTTL grammar and evaluator, Drain log patterns, exponential-histogram percentile math, semconv-driven rendering, the metric query engine.

Viewer weight is estimated at about 350 KB gzipped (ECharts is about half). A shared-viewer-assets option across reports is deferred.

**Early risk to verify:** `@grpc/grpc-js` inside a Bun-compiled binary. Fallback: the binary ships OTLP/HTTP only, and gRPC is available via npm/Node.

## 11. Tooling, CI and release

### 11.1 Engineering standards: strongly typed, fail fast, injected, declarative
- **Modern TypeScript everywhere** (TypeScript 7, the native compiler, for fast type checks). ESM source; the viewer is bundled to a classic script only at build time.
- **Strictest compiler settings:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, and `isolatedDeclarations` for the public API.
- **Strongly typed everything:**
  - no `any` (lint error); no non-null assertions; `unknown` at boundaries.
  - Exhaustive `switch`es checked with `never`.
  - Branded types for IDs (TraceId, SpanId) and units (nanoseconds vs milliseconds).
  - Typed errors carrying actionable messages.
  - The public API's types are tested (`expectTypeOf`).
- **Fail fast at every boundary:** OTLP input, config, CLI args, URL state and report data files are all parsed and validated at the edge (generated protobuf types, Zod). Bad input is rejected immediately with a precise message (path, field, expected vs actual). No silent fallbacks or best-effort guessing; internal invariants are asserted.
- **Dependency injection (plain TypeScript, no DI framework):**
  - Components receive their collaborators through constructor or factory parameters typed as small interfaces. Examples: `Clock`, `FileSystem`/`ChunkSink`, `IdSource`, `Logger`, OTel `Tracer`/`Meter` (self-telemetry), `HttpServerFactory`, `DataSource` (viewer).
  - No module-level singletons or hidden global state.
  - Each entry point (CLI command, `Report` API, receiver, exporters, viewer bootstrap) has one **composition root** that wires concrete implementations. Tests wire fakes, such as an in-memory file system, a fixed clock and a scripted data source, for fast, deterministic unit tests.
  - In the viewer, services come in through React context providers set up at the root; components never import concrete services directly.
  - No decorator- or reflection-based containers (no `reflect-metadata`), to keep the bundle small and the types sound.
- **Declarative and configuration-driven where practical:**
  - All runtime behavior comes from one **resolved config object** described by a single Zod schema: writer options, budgets, drop conditions, receiver ports, dashboards, saved views, theme and display defaults.
  - CLI flags and API options are derived from, and validated against, the same schema.
  - Precedence: defaults < config file < env vars < CLI flags / API arguments. Where a setting already exists in OTel (`OTEL_*` env vars, resource attributes, OTLP endpoint and protocol), the OTel name and semantics are used, never a duplicate of our own.
  - `otel-html config print` shows the resolved config, with each value's source.
  - Domain rules are **data tables, not branching code**, so extending them is a table edit:
    - semantic-convention attribute groups and formatters;
    - the default facets per signal;
    - the aggregations allowed per metric type;
    - the severity mapping;
    - the span tabs shown per available data;
    - the built-in Fusion dashboard, which is itself a config document using the same schema as user dashboards.
- **Strict linting and formatting:**
  - Biome with recommended plus strict rules, all as **errors**; formatting enforced, so any formatter diff fails.
  - **knip** catches unused files, exports and dependencies.
  - **publint** and **arethetypeswrong** check that the published package is correct.
- **Fast feedback loop:**
  - **lefthook** pre-commit runs format, lint and typecheck on staged files in seconds; pre-push runs `mise run check`.
  - **`mise run check`** (lint, format check, typecheck, unit tests) is the inner-loop gate and targets **under 60 s** on a laptop.
  - Vitest watch mode and incremental type checks during development.
  - Commit messages are linted (conventional commits, required by release-please).
- **CI is ordered fail-fast:**
  - A quick `check` job runs first; build, e2e and binary jobs depend on it and never start if it fails.
  - Matrix jobs use `fail-fast: true`.
  - A new push cancels in-progress runs of the same branch.
  - Slow suites (cross-browser e2e, binaries for every platform, load) run only after the fast gates pass, or nightly.
- **Dependencies:** lockfile committed; pinned versions; automated update PRs (Renovate or Dependabot).

### 11.2 Tools, tasks and workflows

- **mise tools:** Node (LTS), Bun, telemetrygen, lefthook.
- **mise tasks** (CI calls exactly these): `setup`, `check` (fast gate: lint, format check, typecheck, unit tests), `lint`, `typecheck`, `test:unit`, `test:e2e`, `test:load`, `build` (viewer, then library), `build:binaries`, `fixtures` (OTel-SDK-generated samples), `demo`.
- **GitHub Actions:**
  - `ci.yml` (pull requests and main): **`check` first** (`mise run check`: lint, format, typecheck, unit tests on Linux). Only then: unit tests on macOS and Windows, build, and e2e (Linux; Chromium/Firefox/WebKit; `file://` + static server). The suite itself runs under `otel-html run --`, and the resulting report is uploaded as an artifact (dogfooding).
  - `release.yml` (main): release-please. On a tag, build binaries (linux-x64/arm64, darwin-x64/arm64, windows-x64) with checksums and attach them to the GitHub Release. npm publish is gated behind a repo variable, off until public.
  - `load.yml` (nightly or manual): telemetrygen → receiver at about 1M spans and 10M logs. Asserts bounded writer memory and large-report viewer open time.
- **Tests:**
  - Unit: OTLP JSON quirks, OTTL parsing and evaluation, rollups, percentile math, SDK→OTLP mapping (compared with `otlp-transformer` output).
  - Receiver conformance: partial success, status codes, gzip, size limit.
  - e2e: explorers, drill-downs, selection linking, `file://`.
  - Load: as above.
  - Fixtures come from the OTel SDK in-memory exporters; the OTel Demo dataset is optional for realism.

## 12. Spike results (ECharts, our tokens)

Headless Chrome, no console errors, light and dark:

| Part | 5k spans / 600k points | 50k spans / 3M points |
|---|---|---|
| Flame graph (custom series) | 65 ms | 119 ms |
| Minimap (second instance, synced zoom) | 16 ms | 65 ms |
| Re-render on selection | 17 ms | n/a |
| Chart card (LTTB) | 230 ms | 1,015 ms |
| Timeline (3 grids, shared brush) | 16 ms | 10 ms |
| Waterfall (virtualized HTML) | 1 ms | 4 ms |

Confirmed: design-language fidelity (rounded bars, dual labels with truncation, error hatch and outline, selection ring), store-driven linking across flame graph, waterfall, chart and timeline, and runtime theme switching. The spike is `06-echarts-spike.html`; it is throwaway code.

## 13. Legal and branding

- Borrow common **interaction patterns and information architecture** from the observability tool space; use our own visual identity. No other vendor's colors, logos, icons, CSS, copy or trademarks.
- **No node-graph service map in v1**; the trace panel uses a Services table instead. Revisit with care (including IP review) if a map is ever added.
- The name "otel-html" follows community practice (otel-tui, otel-desktop-viewer). The README states it is **not an official OpenTelemetry project**. Not legal advice; get counsel review before any commercial use.

## 14. Milestones (each usable on its own)

1. **M1:** repo scaffolding with the §11.1 engineering standards (strict tsconfig, Biome, knip, lefthook, `mise run check`), writer sessions and report format (§7, including checkpoint/append/merge), library API and `convert`, the viewer shell and design system, **Traces** explorer and trace panel, `ci.yml`, release workflow and binaries.
2. **M2:** **Logs** explorer and log panel; log↔trace cross-linking (log tabs in trace and span panels, Trace tab in log panel).
3. **M3:** **Metrics** explorer and Catalog; embedded metric grids in all panels.
4. **M4:** **Dashboards** and **Fusion**; config file (Zod/JSON Schema), variables, selection chips, layout copy.
5. **M5:** **Receiver** (OTLP/HTTP, then gRPC), `serve` and `run`, SDK exporters, `load.yml`.

The OTTL grammar and evaluator land in M1, since Traces filters use it.

## 15. Deferred and open

- Live "following" mode in the viewer for reports still being written by the receiver.
- Shared viewer assets across many reports.
- gzip+base64 data payloads and `.gz` siblings.
- Vega-Lite custom widget (lazy-loaded).
- A CI/CD view (pipeline → tasks → tests) using `cicd.*`/`test.*` conventions, as an optional dashboard.
- Python wrapper (pip package bundling the binary).
- Profiles signal; a Collector exporter (Go).

## 16. Decisions settled during review (designer's calls)

- **Accuracy above the budget.** Unfiltered landing views are exact (from rollups). Once an OTTL filter or free text is applied on a large report, facets, histograms, the RED strip and result lists are computed from the **scanned chunks in the selected time window** and labeled **partial** ("from 12 of 340 chunks"), with a "scan entire run" action. Percentile badges always use the unfiltered per-(service, resource) rollup. Log patterns are computed over loaded chunks (exact under budget, partial above). Metric queries run on the multi-resolution rollup series; `where`/`by` on any attribute work because the series keep their point attributes. No extra filter indexes in v1.
- **What the writer does with OTTL and config.** It validates config and dashboard queries at write time, failing fast with good errors, and applies optional write-time **drop** conditions (`writer.drop: [OTTL…]`, Collector-filter-processor semantics). Dashboards are computed live in the browser from rollups and chunks; nothing is pre-rendered per widget.
- **Duplicates.** Spans are deduplicated on (trace_id, span_id) using a bounded recent-ID set in the receiver and writer, which covers exporter retries. Logs and metric points are not deduplicated; their identity isn't well-defined in OTLP.
- **Initial targets** (enforced by `load.yml` and an e2e perf check, measured on a GitHub-hosted `ubuntu-latest` runner):
  - A 100k-span / 1M-log report opens to the interactive Trace Explorer in under **3 s**, and filters/facet toggles respond in under **150 ms**.
  - Above budget, landing views open in under **3 s**, and a one-window filtered scan completes in under **5 s**.
  - Writer peak RSS stays under **512 MB** regardless of input size, measured on the CLI (`otel-html convert` and `merge`), which switches V8 to `--optimize-for-size` when metric points arrive. The library sets no V8 flags, so the same metric workload fed to `Report.addMetrics` peaks higher (about 770 MB on 72M points; V8 grows its heap to several times the live data, which stays about 100 MB); that figure is measured and reported by the same test, not held to the target. A library caller that needs the CLI's figure starts Node with `--optimize-for-size`. Trace and log conversions meet the target on both paths.
  - Report size on disk is about **300 bytes/span** and **200 bytes/log** or less (uncompressed).

  If the size target can't be met without compression, gzip payloads move out of §15 into v1.
- **Dashboard widget types in v1:** `timeline`, `traces`, `logs`, `metric` (display: lines/area/bars/heatmap), `toplist`, `table`. Treemap, pie and point plot exist as explorer views only. Every explorer view takes its query through the same config-shaped object internally, so promoting one to a widget later costs only the schema.
- **Dogfooding.** The CI report contains the `run` root span, plus whatever the test tooling emits through standard OTel. No additional test instrumentation is required in v1.

## 17. Left to the builder

- Exact public API names and options; CLI flag names beyond those listed.
- Internal module boundaries inside the single package; repo folder layout.
- Columnar encoding details, chunk sizes, budget thresholds (validated by the load test).
- Which OTTL converters to support in v1.
- Visual polish details not fixed in the mockups (spacing, empty states, loading and error states), staying within §8.1.
