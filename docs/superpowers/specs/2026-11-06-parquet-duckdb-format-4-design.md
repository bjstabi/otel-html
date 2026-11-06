# Format 4: Parquet partitions, one query engine, two hosts

Status: design, approved in conversation on 2026-11-06. Informed by the spike on branch `spike/duckdb-wasm-file`
(see §12) and the performance diagnosis of the rolling CI report (§1).

## 1. Intent

The rolling report of this repository's `main` branch holds the last 30 CI runs: 2.17 million spans, 1.02 GB decoded,
236 span chunks (247 MB). That is 13× `viewer.eagerBudgetBytes`, so the viewer scans chunks on demand, and every
filtered query reads all 236 chunks one at a time: the CI dashboard takes 12 s locally and 31 s on GitHub Pages
before its widgets fill, and the Services page takes two minutes with the CPU pegged because it runs one full scan
per service. The design document of 2026-10-30 (§6.8) named this exact situation as the trigger to revisit how the
viewer reads data.

Format 4 replaces the JSON data chunks, the writer's rollup files and the trace index with **Parquet partitions and a
manifest of file statistics**, and replaces the viewer's hand-written scan code with **one query engine, DuckDB, run
in two hosts**: DuckDB-WASM inside the browser for static hosting, and a DuckDB process behind a small HTTP endpoint
when a report is served. The viewer builds one query from one spec and does not know which host answers it. Data is
appended as partitions and is queryable as soon as it is written. Reports still open from disk by double-clicking
`index.html`.

## 2. Goals, non-goals, anti-goals

Goals

- A filtered query over a report of millions of spans answers in well under a second from a static host, reading
  kilobytes to a few megabytes, not the whole report.
- Opening a report from `file://` keeps working in Chromium, Firefox and WebKit, with no server and no gesture.
- New data lands as a partition and is queryable at once; retention drops a partition; nothing is re-encoded.
- One query spec serves every page and widget, present and future, so a new visualization is a new spec, not a new
  scan routine or a new index.
- One SQL generation path. The browser engine and the served engine run the same SQL over the same files.
- The served backend is pluggable: the browser speaks one protocol to `otel-html`, and `otel-html` can answer from
  DuckDB over the report folder today and from other stores later.
- Reports are smaller on disk than today (the spike: 58 MB of Parquet for 247 MB of JSON chunks, attributes included).

Non-goals

- Reading format 1 to 3 reports in the viewer. The writer reads them (`merge`, `upgrade`) and writes format 4.
- A live, following viewer. Reload still shows what the writer has committed.
- Supporting every OTTL converter in SQL. The translatable subset is defined in §7.3; the rest falls back.
- Non-DuckDB served backends in this project. The interface is designed for them (§8); none is built.

Anti-goals (a result that works but fails the design)

- A report that needs a server to open at all.
- Two data paths in the viewer (a JSON path and a Parquet path). Format 4 is a replacement, not an addition.
- Per-visualization indexes or materialized results that a future widget has to re-plumb.
- The gh-pages repository growing by the engine's size on every published run.
- The npm package or the single binaries losing their "no native dependency" property.

## 3. Constraints

- `file://` rules stay (design 2026-10-25 §7.4): no `fetch` of report files, no ES modules, no separate worker files
  loaded by URL. Workers come from blob URLs; the engine binary reaches the worker as a data: URL (§12).
- Bounded writer memory (512 MB RSS target on the CLI) and a report that is valid after every flush, as today.
- The three-browser e2e matrix, the `@perf` budgets and the load tests keep their shape; their budgets are re-baselined
  (§10).
- Engineering standards of design 2026-10-25 §11.1: strongly typed, fail fast, dependencies injected, declarative.
- DuckDB-WASM is the engine (`@duckdb/duckdb-wasm`, stable releases only; the `latest` npm tag points at dev builds and
  must be pinned past). Its binary is ~34 MB raw, ~8 MB gzipped, ~10 MB as base64 of gzip.
- Mosaic (`@uwdata/mosaic-core`, `@uwdata/mosaic-sql`) is 0.x: pinned exact, wrapped in `src/viewer/data/`, never
  imported by components, so an API change is one module's problem.

## 4. Approaches considered

1. **Keep JSON chunks, add indexes** (per-chunk value sets, posting lists, per-service rollups, prefetch): cheap and
   incremental, but every future widget needs its own rollup or index, and the scan code keeps growing. Rejected as
   the main path; the diagnosis's quick fixes are superseded by this design.
2. **Pagefind-style fragment index**: full-text search over pages; cannot express structured queries, needs `fetch`.
   Rejected.
3. **SQLite over an HTTP VFS**: row-oriented, slower scans over millions of rows, a second data path. Rejected.
4. **Parquet + DuckDB-WASM in the browser, DuckDB behind `otel-html` when served** (chosen): columnar, predicate
   pushdown from row-group statistics, SQL, the same engine in both hosts, and the spike proved `file://` works.
5. **Hyparquet (pure JS Parquet reader) + the existing JS query code**: the fallback if DuckDB-WASM cannot be made to
   run somewhere it must (§12 found no such place). Kept as the documented fallback for the `file://` tier only.

## 5. Report layout

```
report/
  index.html                      shell; classic <script> tags only
  .nojekyll
  assets/                         the viewer and the engine, or a reference to a shared copy (§5.3)
    viewer.<hash>.js, viewer.<hash>.css
    duckdb.<version>.wasm         engine binary (site format)
    duckdb.<version>.worker.js    engine worker (site format)
    duckdb.<version>.wasm.gz.b64.js, duckdb.<version>.worker.b64.js   (local format, §5.3)
  data/
    manifest.js                   format 4 manifest (§5.2); a classic script, as today
    partitions/<p6>/              one partition per flush or per merged input (§5.1)
      spans.parquet               one Parquet file per signal present in the partition
      logs.parquet
      points.parquet              metric data points
      traces.parquet              per-trace summary rows (replaces the trace index, §6.4)
      patterns.parquet            log pattern clusters (Drain output, §6.4)
      *.parquet.js                local format only: the same bytes as base64 in a classic script
    state/                        writer checkpoint (session.<n>.json), as today
```

No file or folder starts with `_`. Every path is relative. `data/` is the model, `assets/` and `index.html` the viewer.

### 5.1 Partitions

A partition is the unit of append, merge and retention. The writer closes a partition at every checkpoint that has
new records, so a report is queryable after every flush, and at `close()` it **compacts** the partitions written since
open into one partition per signal, sorted (§6.2), so a finished run is a few large files rather than many small ones
(the spike: one sorted file answered the Steps query from 174 KB in 21 range requests; the same data in 20 files took
412 requests and 3.9 MB, because each file's footer is read). Compaction is a rewrite of the run's own partitions only;
partitions that came from `merge` inputs are never rewritten.

`merge <reports…>` copies each input's partitions into the output (renumbered) and rewrites the manifest. No records
are decoded or re-encoded; merge is O(manifest). Inputs in format 1 to 3 are converted through the existing decoders
into partitions first (§9). `merge --compact` additionally rewrites the copied partitions into one sorted partition per
signal, for a report that will be read many times: the publisher's rolling report uses it, so the motivating report is
the spike's fast shape (one file per signal) rather than 30 small ones. The publisher keeps rebuilding the rolling
report from the retained per-run reports (now a copy plus a compaction, not a re-encode of every record); retention
stays "drop the run's folder and rebuild".

### 5.2 Manifest

`data/manifest.js` registers the manifest as today. It carries, besides the fields the current manifest has (format
version 4, otel-html version, title, epoch, created and updated times, `complete`, range, totals, config):

- `partitions[]`: `{ n, files: { spans?, logs?, points?, traces?, patterns? } }` where each file entry has `path`,
  `bytes`, `rows`, the time range, and **column statistics**: for the sort and prune columns (§6.2) the distinct values
  up to the facet value cap, or `null` past it, and min/max for time columns. The viewer prunes partitions with these
  before any Parquet footer is read; Parquet row-group statistics prune within a file.
- `statisticsKeys`: the attribute keys the statistics cover beyond the fixed columns: every resource attribute named
  by a dashboard's `variables` in the report's config, plus `writer.statisticsKeys` from config. The CI dashboard's
  `run` variable (`cicd.pipeline.run.id`) therefore prunes to the run's partitions. Changing the keys is a config
  change, not a format bump; a report's statistics cover the keys its manifest lists, and a key not listed prunes
  nothing.
- `engine`: `{ version, format: 'site' | 'local', assetsBase }` so the viewer knows how to start DuckDB (§5.3).
- `decodedBytes` and `viewer.eagerBudgetBytes` go away. There is one strategy.

The manifest schema stays a strict Zod object validated on read, with layout-path regexes as today.

### 5.3 Output formats

The writer takes a format option (config `writer.format`, CLI `--format`, API option): 

- `local` (default): Parquet files plus a `.parquet.js` base64 wrapper per file, and the engine as base64 scripts under
  `assets/`. Double-clicking `index.html` works in all three browsers (§12). Costs 1.33× the Parquet size on disk plus
  ~11 MB of engine scripts per report. There are no range reads at `file://`: every partition a query touches is
  decoded into memory, so `local` is for reports people open from disk, not for the largest ones. The writer warns
  (never refuses) when a `local` report's Parquet size passes `writer.localWarnBytes` (default 256 MB, a designer's
  call) and names `--format site`.
- `site`: Parquet files only, engine as plain `.wasm` and worker files. Requires HTTP with range requests (GitHub
  Pages, GitLab Pages and ordinary static hosts have them; a server that answers HEAD-with-Range with 200, as GitHub
  Pages does, works, §12).

Both formats write the Parquet files, so `merge`, `upgrade`, retention and the served engine read either. `upgrade`
can switch a report between formats (it rewrites `assets/` and `index.html` and adds or removes the wrappers).

`assetsBase` lets a site share one copy of the viewer and engine across reports: the publisher passes a site-relative
base (for example `../../assets/<otel-html version>/`), uploads that folder once per version, and each report's
`index.html` (the rolling report and every per-run report) references it. A report downloaded from such a site needs
`upgrade` to become self-contained. The default is the report's own `assets/`. This ships **with the format bump**,
not after it: without it every per-run report on the site carries a 34 MB engine, and forty retained runs exceed the
GitHub Pages site limit.

## 6. Data model in Parquet

### 6.1 Tables

One table per signal, denormalized: resource and scope columns are repeated on every row and dictionary-encoded by
Parquet, which costs little (the spike kept resource attributes as JSON text on every span and still reached 27
bytes per span). The schema follows the **OpenTelemetry Arrow** column naming where it has a name for the field, so
a reader that knows OTel Arrow recognizes the tables, and the builder documents every departure.

`spans`: trace_id, span_id, parent_span_id, trace_state, flags, name, kind, start_time_unix_nano, end_time_unix_nano,
duration_ns, status_code, status_message, dropped counts, `attributes` (JSON text, §6.3), `events` (JSON text),
`links` (JSON text), `resource.attributes` (JSON text), `resource.schema_url`, `scope.name`, `scope.version`,
`scope.attributes` (JSON text), and promoted columns `service_name`, `resource_name` (the viewer's resource label).

`logs`: time_unix_nano, observed_time_unix_nano, severity_number, severity_text, body (JSON text of the AnyValue),
attributes, trace_id, span_id, flags, dropped count, the resource and scope columns, `service_name`, `host_name`.

`points`: one row per data point, long form: metric_name, metric_description, metric_unit, point_type (gauge, sum,
histogram, exp_histogram, summary), aggregation_temporality, is_monotonic, start_time_unix_nano, time_unix_nano,
attributes, the resource and scope columns, series_id (a hash of the series identity of design 2026-10-27 §5.1),
and value columns per type: value_double, count, sum, min, max, explicit bounds and bucket counts (lists),
exponential histogram scale, zero count and positive/negative buckets (lists), summary quantiles (list of pairs),
exemplars (JSON text), flags. Temporality normalization (deltas for cumulative streams, reset counting) stays a
writer concern and is written as `delta_value`/`delta_count` columns beside the raw values, with `reset` and
`out_of_order` boolean columns, so SQL sums deltas without re-deriving them.

`traces`: trace_id, start, end, span_count, error_count, root_service, root_name, root_resource, partitions (list of
partition numbers that hold its spans), log_count. Maintained by the writer across flushes as the trace index is today
(a trace split across partitions has one row per partition that touched it; the viewer aggregates).

`patterns`: cluster_id, template, count, first/last time, severity counts, sample. The Drain state stays writer
checkpoint state; its output is written per partition and merged by template at read time.

### 6.2 Sort order and pruning

Within a signal's file the writer sorts rows by `scope.name`, `service_name`, then time. The manifest statistics
(§5.2) carry distinct values for `scope.name`, `service_name`, `name` (spans) or `severity_number` (logs) or
`metric_name` (points), and min/max time. Row groups are 50k to 100k rows (builder's call within that range,
measured). A condition that constrains one of these columns, or the time window, prunes partitions in the viewer
and row groups in DuckDB. Anything else scans the pruned set, which is still columnar and only the columns named.

### 6.3 Attributes

Attributes are JSON text in the tagged encoding the chunk format uses today (strings, bools and finite numbers plain;
int64 beyond 2^53, bytes, non-finite doubles and maps tagged), so no fidelity is lost and `JSON.parse` on the viewer
side gives the same AnyValue model. In SQL, `attributes["k"]` becomes `json_extract_string(attributes, '$."k"')` (or
`json_extract` for typed comparisons), which the spike measured at 250 ms over 2.17 million rows unpruned and 40 ms
warm; with pruning the cost is proportional to the rows left. The writer may **promote** attribute keys to real
columns in a later format revision; the design leaves the hook (promoted columns are listed in the manifest) without
using it beyond `service_name`, `resource_name`, `host_name`.

### 6.4 What replaces the rollups and the trace index

- Facet values and counts, time buckets, RED series, duration percentiles, service tables: **SQL at query time** over
  the pruned set (`GROUP BY`, `count(*) FILTER`, `quantile_cont` or `approx_quantile`, `time_bucket`). The spike
  answered the full Services table (count, errors, p95 per service over 2.17 million spans) in 80 to 300 ms in every
  mode. The unfiltered landing pages run the same queries with no filter.
- Metric levels (`l0`–`l3`) and segments: **gone**. Metric queries aggregate `points` by `time_bucket` at the
  resolution the chart asks for. If the metrics-scale e2e budget (72M points) cannot be met this way, the builder adds
  a writer-produced `points_1m`-style downsampled table per partition, listed in the manifest like any other file,
  and the query generator picks the coarsest table that satisfies the requested resolution. Exemplars live on the
  point rows.
- Trace index shards: the `traces` table (§6.1), filtered by `trace_id`, which is a Parquet dictionary column with
  statistics; DuckDB reads only the row groups whose min/max covers the id.
- Log patterns: the `patterns` table.

## 7. The viewer

### 7.1 Mosaic inside the data layer

The viewer adopts **Mosaic** (`@uwdata/mosaic-core`, `@uwdata/mosaic-sql`; UW Interactive Data Lab, BSD, pinned exact)
as its query layer, confined to `src/viewer/data/` and `src/query/sql/`:

- A Mosaic **Coordinator** owns the connection: the `wasmConnector` over DuckDB-WASM in the page (both output formats),
  or the REST connector to a host (§8). It consolidates concurrent queries, caches results, and runs its
  pre-aggregation for clients that opt in (the timeline brush).
- Every page and widget is a **MosaicClient** behind a small React hook (`useMosaicQuery(build, { filterBy })`):
  `build` returns a mosaic-sql `Query`, the hook delivers the Arrow result mapped into the result types the components
  consume today (facet counts, time buckets, RED series, histograms, rows). Components never import Mosaic.
- Shared filters are Mosaic **Selections**: the explorer's filter (condition, text, window), a dashboard scope's
  condition, window and trace filter, and the brush. A client declares `filterBy`, and the Coordinator re-queries the
  whole filter group when a Selection changes. Selection clauses are mosaic-sql predicates produced by the OTTL
  translator (§7.3).

`DataSource` stays the boundary pages see for everything that is not a query (manifest, trace detail loading, metric
catalog); its two implementations differ only in the connector they hand the Coordinator. The eager and windowed
strategies, `chunk-window.ts`, `eager.ts`, `windowed.ts`, the log equivalents, `load.ts` and the span/log scan runs are
deleted. `partial` results and "Scan entire run" disappear from the UI: every answer is exact.

### 7.2 Query construction

There is no home-grown spec-to-SQL string generator. `src/query/sql/` holds typed builders on mosaic-sql for the
shapes the product needs (facet counts with caps and "other", time buckets at a width, RED series, duration
percentiles, trace rows, row lists with sort and limit, metric queries with `by`, `where`, `fn` and formulas) and the
OTTL translator. Builders return mosaic-sql `Query` objects, so escaping and dialect belong to the library. Metric
`fn`s (rate, increase, …) become window functions where SQL expresses them and post-processing where it does not,
the builder's call per function.

### 7.3 OTTL to SQL

The viewer's OTTL parser already yields an AST. A translator emits mosaic-sql expression nodes for: comparisons on
paths (`name`, `kind`, `status.code`, `severity_number`, `attributes[...]`, `resource.attributes[...]`,
`instrumentation_scope.name`, span duration, trace and span ids), string and numeric literals, `and`/`or`/`not`,
`IsMatch` (to `regexp_matches`), `nil` checks, `IsRootSpan()`, and the converters the UI's filter tokens emit today.
A condition that uses a converter outside this set is not rejected: the translatable part becomes the predicate, and
the whole condition is re-evaluated in JS over the rows that come back (row lists) or the query falls back to fetching
the matching rows' ids first (aggregates). The translator reports which path it took, and the UI shows a small
"evaluated in the browser" note so a slow query explains itself.

### 7.4 The schema contract: views

Queries name only five **views**: `spans`, `logs`, `points`, `traces`, `patterns`, never files. The viewer creates them
after registering the report's files, as `read_parquet([...])` over the partitions the manifest lists (after pruning,
a query may use a narrower temporary view over the pruned files; the builder decides whether pruning is a view per
query or a `WHERE` on a `filename` column). A host creates the same views server-side. Column names follow
OpenTelemetry Arrow where it has a name (§6.1). The `spans` view also resolves **span versions**: for one
`(trace_id, span_id)` it keeps the latest row whose `provisional` attribute is unset, else the latest provisional row
(`QUALIFY row_number() OVER (PARTITION BY trace_id, span_id ORDER BY provisional, time_unix_nano DESC) = 1`), so a
span re-emitted with better information supersedes the earlier one without rewriting a partition (used by incremental
CI publishing, separate design). Compaction drops superseded rows for good.

The views, their columns and the version rule are **the contract between the viewer and any backend**: a store that
holds telemetry differently satisfies it by defining the same views. They are documented in a generated page under
`docs/format/`, checked by a golden test, and versioned with the format version.

### 7.5 Starting the engine

Site format: the worker is created from the worker file's URL and the engine from the `.wasm` URL. Local format: the
base64 scripts register through `__OH__.push` like data files; the page gunzips the engine with
`DecompressionStream`, hands it to the worker as a **data: URL** (a blob URL made by the page is not fetchable from the
worker at `file://`, §12), and creates the worker from a blob URL of its text. The database is opened with
`filesystem: { forceFullHTTPReads: false }` in site format. Base64 strings and decoded buffers are released once
registered (the spike held them and sat at 240 MB of JS heap).

### 7.6 Pages and widgets

Every page and widget is a client with a query and a `filterBy`. Specifically: the Services page becomes one grouped
query plus one time-bucketed query (today it issues one scan per service); the dashboard's toplist, table, traces and
logs widgets share the scope Selection; the trace panel reads the `traces` row and then the spans with that
`trace_id`; the Logs explorer's patterns view reads `patterns`. Sharing between concurrent clients is the
Coordinator's job; no bespoke code.

## 8. Serving: SQL on the wire, a locked-down engine

`otel-html host <report> [--port]` (new command; name is the designer's call) serves a report folder over HTTP with:

- the static files (so the viewer loads as from any host), and
- **Mosaic's REST connector protocol**: a JSON request carrying SQL, an Arrow IPC (or JSON) response, exactly as
  Mosaic's own servers answer it, so the viewer uses the stock connector and `otel-html host` is interchangeable with
  Mosaic's Python, Rust or Go servers given the same views over the same files.

The **engine policy** is part of the contract: DuckDB opened read-only, `enable_external_access = false` and the
configuration locked, a statement timeout, a result-size cap, and no `exec` requests from clients (the views are
created by the server at startup from the manifest, and that is the only DDL). SQL on the wire is acceptable only
under this policy, and the tests assert it (a query that reads a local file or writes is refused).

Backend plurality is DuckDB's: `ATTACH` reaches Postgres, MySQL, SQLite, Iceberg, Delta and object stores, and the
views over an attached store are a configuration matter, not viewer code. `host --attach` is out of scope here;
the views make it possible. The engine in `host` is the same WASM build run in Node by default (no native
dependency), with the native `@duckdb/node-api` as an optional peer dependency for speed; the builder measures and
picks the default. The receiver (`serve`, `run`) may expose the same endpoint over the report it is writing, reading
committed partitions only; optional, deferred to the plan if it costs more than a flag.

The viewer picks the REST connector when `index.html` carries a `<meta name="otel-html-host">` tag that `host` writes
into the page it serves, otherwise it runs the engine itself.

## 9. Writer

- `openSession` keeps its shape (open, add, flush, close, abort, lock, checkpoint, dedupe, drop conditions). The
  chunker, rollup accumulators, trace index and metric series writer are replaced by a **partition writer** that
  buffers rows per signal, writes them as Parquet at checkpoint (sorted within the partition), appends manifest
  entries with statistics, and keeps cumulative-stream state and Drain state in the checkpoint as today.
- The Parquet encoder must have **no native dependency**. Candidates, for the builder to measure in order: the DuckDB
  WASM build in Node (one engine everywhere; a first attempt in the spike raised a WebAssembly exception on a 216k-row
  `COPY`, so it needs investigating), `parquet-wasm` with Arrow IPC input, `hyparquet-writer`. ZSTD compression is
  required; the spike's sizes assume it.
- `convert`, `serve`, `run`, the SDK exporters and the `Report` API change nothing in their interfaces beyond the
  `format` option.
- `merge` copies partitions (§5.1). Inputs in formats 1 to 3 are read with the existing decoders (`decodeColumns`,
  the rollup and shard readers stay as read-only compatibility code) and written as format-4 partitions; this is the
  only place the old format is read, and the frozen-fixture compat tests move to exercising it.
- `upgrade` rewrites `assets/` and `index.html`, and converts between `local` and `site`.
- Config: `writer.format`, `writer.rowGroupRows`; `viewer.eagerBudgetBytes` is removed (unknown keys are rejected,
  so its removal is a documented breaking change in the config schema); `viewer.listCap` stays as the row-list bound.

## 10. Tests, fixtures, budgets

- Unit: the query generator (spec → SQL, golden files), the OTTL translator (translatable, fallback), the partition
  writer (statistics, sort, compaction), manifest schema, merge by copy, format 1–3 conversion against the frozen
  fixtures, and `host`'s endpoint.
- e2e: the fixture reports are written in both formats; the suite opens `local` reports from `file://` and `site`
  reports from the static server with range support (the e2e static server must implement `Range` and `HEAD`), in
  Chromium, Firefox and WebKit. The scale fixtures (100k spans, 1M logs, the metrics-scale 72M points) keep their
  specs but **move to the `site` format over the static server** (a Playwright project beside `chromium-perf-file`);
  their `@perf` budgets are re-baselined on the new path and the CI dashboard's open time becomes a budget. Decided
  by the maintainer on 2026-11-06: the largest reports need not open from disk.
- A frozen format-4 report is added when the first release with it is cut, as the compat rule requires.
- Load tests (`test:load`, `test:load:receiver`) keep their memory targets; the partition writer is measured against
  them.

## 11. Milestones

1. **Partition writer and format 4 on disk** for spans and logs, local and site formats, manifest statistics
   (including `statisticsKeys`), merge by copy and `--compact`, `assetsBase`, format 1–3 conversion. The old viewer
   cannot read it; this milestone is tested through the writer and the compat fixtures only.
2. **DuckDB viewer for spans and logs**: engine start in both formats, data source, query generator, OTTL
   translation, Traces and Logs explorers, Services, trace panel, dashboards' span and log widgets. Delete the scan
   code. e2e re-baselined.
3. **Metrics**: `points` table, metric query compilation, Metrics explorer, catalog and dashboard metric widgets;
   downsampled tables only if the scale budget demands them.
4. **`host` and `RemoteDataSource`**, the `QueryBackend` interface. The publisher switches to format 4 and `site`
   with the bump release, passing `assetsBase`.

Milestones 1 to 3 land on one long-lived branch (`feat/format-4`, PRs target it, `main` keeps shipping format 3
meanwhile) and ship together as the format bump; 4 may follow as its own release. PR process: **unattended**
(docs/agents/process-unattended.md) for every PR, decided by the maintainer on 2026-11-06.

## 12. Spike results (branch `spike/duckdb-wasm-file`, 2026-11-06)

Real CI report, 2.17M spans, `@duckdb/duckdb-wasm` 1.32.0, headless browsers on the development machine.

- Parquet, ZSTD, attributes as JSON text, sorted by scope, service, time: **58 MB** for 247 MB of JSON chunks.
- `file://` with base64-of-gzip engine (9.8 MB script) and 20 base64 Parquet wrappers (78 MB): page open to all eight
  test queries answered in **3.0 s Chromium, 3.0 s Firefox, 3.6 s WebKit**; engine instantiate 0.7 to 1.0 s; Steps
  toplist 17 to 32 ms; Services table 80 to 90 ms. Plain base64 engine (44 MB) costs 0.3 s more.
- `file://` with a user-picked folder (File handles): works in Chromium and Firefox, ~10× slower per query, **fails
  in WebKit** (NotReadableError). Not used by this design.
- HTTP: duckdb-wasm **defaults to whole-file reads**; `forceFullHTTPReads: false` enables range reads. Steps query
  over one sorted 58 MB file: **21 range requests, 174 KB, 45 ms**; over 20 partitions: 412 requests, 3.9 MB,
  257 ms. A server answering HEAD-with-Range with 200 (GitHub Pages) still range-reads. A whole-table aggregate
  (services) read 48 MB.
- A blob URL created by the page cannot be fetched by the worker at `file://`; a data: URL can. Worker from a blob
  URL works in all three browsers.
- Spike heap in Chromium with base64 scripts retained: 240 MB.

## 13. Decisions settled in conversation

- Unattended PR process; one long-lived `feat/format-4` branch for milestones 1–3.
- The scale and metrics-scale e2e specs run in `site` format over HTTP; `local` warns past a size, never refuses.

- Format 4 **replaces** the JSON chunks, rollups and trace shards; the viewer does not read older formats.
- Opening from disk stays supported. The user chooses the output format: base64 scripts for local use and
  development, plain Parquet with range reads for GitHub Actions and static sites.
- DuckDB-WASM in the browser, DuckDB behind `otel-html` when served, one SQL generation path.
- Mosaic (core and sql) is the viewer's query layer; SQL travels on the wire to a locked-down engine; the five views
  are the schema contract; vendor plurality is DuckDB `ATTACH` behind the same views (2026-11-06).
- Partitions per flush, append-only, retention by deletion; merge by copy.

## 14. Designer's calls (flag if wrong)

- `local` is the default format; the publisher passes `site`.
- Attributes as tagged JSON text, with only `service_name`, `resource_name`, `host_name` promoted.
- `traces` and `patterns` as writer-maintained tables rather than derived at query time.
- Metric levels dropped unless the scale budget forces a downsampled table.
- `host` as the command name; it speaks Mosaic's REST connector protocol under the engine policy of §8.
- The span version rule lives in the `spans` view (query time), not in the writer.
- OTTL conditions outside the translatable subset fall back to browser evaluation rather than erroring.
- Milestones 1–3 ship together as one format bump.
- The publisher keeps rebuilding the rolling report from the retained runs (merge by copy, then `--compact`) rather
  than appending and deleting partitions in place.
- Statistics keys come from the dashboards' variables plus `writer.statisticsKeys`, in milestone 1.
- `assetsBase` ships with the bump and applies to per-run reports too.

## 15. Left to the builder

- The Parquet encoder library (§9) and the row-group size within 50k–100k rows.
- The exact OTel Arrow column names adopted and the documented departures.
- Pruning as a per-query temporary view or a `filename` predicate; the shape of the React hook over `MosaicClient`;
  which clients opt into pre-aggregation.
- Which metric `fn`s become SQL and which post-process.
- The e2e static server's range implementation and the re-baselined budgets.
