# otel-html

[![ci report](https://img.shields.io/endpoint?url=https://bjstabi.github.io/otel-html/branch/main/badge-ci.json&logo=opentelemetry)](https://bjstabi.github.io/otel-html/branch/main/)

otel-html turns OpenTelemetry data into a static, self-contained HTML report. You give it OTLP files (or feed it spans from your own code) and it writes a folder you can open from disk, attach to a CI run, or publish on any static host. No server and no network access are needed to view it.

<a href="https://bjstabi.github.io/otel-html/branch/main/"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://bjstabi.github.io/otel-html/branch/main/preview-dark.png">
  <img alt="This repository's own CI, as an otel-html report" src="https://bjstabi.github.io/otel-html/branch/main/preview-light.png">
</picture></a>
<sub>Live: this repository's own CI, reported by otel-html. Click to open.</sub>

Milestone 1 covers traces: a Traces explorer with a trace panel (flame graph, waterfall, span list, services, span details). Milestone 2 adds logs: a Logs explorer with log patterns and a log panel, linked to traces both ways. Milestone 3 adds metrics: a Metrics explorer with exemplars, a metrics catalog, and metric charts in the log, span and trace panels. Milestone 4 adds dashboards: the built-in Fusion dashboard, which puts every signal on one timeline, and dashboards you define in config. Milestone 5 adds the OTLP receiver (`serve` and `run`) and the SDK exporters.

> otel-html is not an official OpenTelemetry project. It is not affiliated with or endorsed by the OpenTelemetry project or the CNCF.

## Install

npm: planned. The package is not published yet (`package.json` is still marked `"private": true`). Until then, build from source (see [Development](#development)) or use a binary.

Binaries: download from the GitHub Releases page. Each release has one standalone executable per platform, plus a `SHA256SUMS` file:

| Platform | File |
|---|---|
| Linux x64 | `otel-html-linux-x64` |
| Linux arm64 | `otel-html-linux-arm64` |
| macOS x64 | `otel-html-darwin-x64` |
| macOS arm64 | `otel-html-darwin-arm64` |
| Windows x64 | `otel-html-windows-x64.exe` |

```sh
shasum -a 256 -c --ignore-missing SHA256SUMS
```

The binaries are built by `.github/workflows/release.yml` when a release is created. From source, Node 24 or newer is required.

## CLI

Commands: `convert` (OTLP files to a report), `serve` (receive OTLP over HTTP and gRPC), `run` (wrap a command and report its telemetry), `merge`, `upgrade` and `config print`.

```sh
otel-html convert fixtures/small.otlp.json -o ./report
```

### `convert [files...]`

Turns OTLP files into a report. Inputs can be OTLP JSON (field names in lowerCamelCase or snake_case), JSON lines (such as Collector file-exporter output) or protobuf.

| Option | Meaning |
|---|---|
| `-o, --out <dir>` | Report folder. |
| `--config <file>` | Config file. Default: `$OTEL_HTML_CONFIG`, else `./otel-html.yaml`. |
| `--title <title>` | Report title. |
| `--append` | Require a report at `-o` and add to it (fails when there is none; useful in CI to catch a wrong path). |
| `--replace` | Start the report over. Without either flag, `-o` is appended to when it already holds a report written by the same otel-html version and created otherwise. An existing report is wiped only once the first input file has been read without error, so that file is held in memory until then (see Limits). |
| `--format <format>` | Report format: `chunks` (default), `local` or `site` (format 4: Parquet partitions; see [Report layout and hosting](#report-layout-and-hosting)). Sets `writer.format`. The viewer cannot open format-4 reports yet. Appending needs the report's own format. |
| `--assets-base <path>` | Only with `--format local` or `site` (an error with `chunks`). Where the report loads its viewer files from: `assets/` (default; the report carries them) or a relative path such as `../../assets/0.3.0/` (`../` segments, then `assets/` and at most one more folder), in which case no `assets/` is written beside the report. Sets `writer.assetsBase`. A report that carries its own `assets/` cannot move to a shared base on append. |
| `--signal <signal>` | `traces`, `logs` or `metrics`. Needed for protobuf (`.pb`) inputs, which do not say what they hold. |

### `serve`

Receives OTLP over HTTP and gRPC and writes a report until you press Ctrl-C.

```sh
otel-html serve -o ./report
# listening on http://127.0.0.1:4318 (OTLP/HTTP) and 127.0.0.1:4317 (OTLP/gRPC), writing ./report; press Ctrl-C to finish
```

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | Report folder (required). |
| `--host <addr>` | Address to listen on. Default `127.0.0.1`. |
| `--http <port>`, `--no-http` | OTLP/HTTP port (default 4318), or turn it off. |
| `--grpc <port>`, `--no-grpc` | OTLP/gRPC port (default 4317), or turn it off. Port 0 picks a free port. |
| `--append` | Require a report at `-o` and add to it (fails when there is none; useful in CI to catch a wrong path). |
| `--replace` | Start the report over. Without either flag, `-o` is appended to when it already holds a report written by the same otel-html version and created otherwise. The same applies here: the existing report is wiped only once the first request has been read without error, so that request is held in memory until then (see Limits). |
| `--format <format>`, `--assets-base <path>` | As for `convert`. |
| `--config <file>`, `--title <title>` | As for `convert`. |

Turning off both transports is a usage error (exit 2). A port that is already in use exits 1 with the system's `EADDRINUSE` message and a hint to pass `--http <port>` or `--grpc <port>`, or to turn that transport off (other bind errors get a hint for their cause: privileges for ports below 1024, `--host` for an address that is not this machine's).

On Ctrl-C (SIGINT) or SIGTERM, `serve` finishes the requests in progress, then stops listening (a request arriving meanwhile is answered 503 and retried by the client), completes the report and prints `wrote <out>: ...` and `received <N> requests (<K> refused); <M> records rejected`. A request is refused when it fails outright (it could not be decoded, has an unsupported content type or path, is too large (over gRPC, see Limits), or arrives while the receiver is busy); records are rejected when a request is otherwise accepted but an entry in it is dropped. When K is not zero, a second line breaks the refusals down, for example `refused: 3 invalid, 1 unsupported`, and a warning on stderr names the first refusal of each kind, so a misconfigured exporter shows up while `serve` runs. A second Ctrl-C while it finishes prints `interrupted; the report is at its last checkpoint` and exits 130; the report is then viewable and resumable from its last checkpoint but is not marked complete.

### `run`

Runs a command with its OpenTelemetry SDK pointed at a receiver, wraps the run in a root span, and writes the report when the command exits.

```sh
otel-html run -o ./report -- pytest -q
```

Everything before `--` is an `otel-html` flag: the `serve` flags (`-o`, `--host`, `--http`, `--no-http`, `--grpc`, `--no-grpc`, `--config`, `--title`, `--append`, `--replace`, `--format`, `--assets-base`). `run` binds only the transport the command's protocol needs: OTLP/HTTP on 4318 by default, or OTLP/gRPC on 4317 when `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`; an explicit `--http <port>` or `--grpc <port>` binds that transport as well (a transport enabled only in the config file is not bound by `run`). A local collector on 4317 therefore does not get in the way. The receiver starts first, then the command runs with its stdio inherited and these variables added to its environment:

| Variable | Value |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The receiver's `http://host:port`, or the gRPC address when the protocol is `grpc`. Kept if you already set it (a warning is printed, and the command will not send to this receiver). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Your value if set to `grpc`, `http/protobuf` or `http/json`, else `http/protobuf`. Any other value is a usage error, as is a protocol whose receiver is turned off. |
| `TRACEPARENT` | `00-<trace id>-<root span id>-01`, always set to `run`'s own root span, so the command's own spans become its children (whatever `TRACEPARENT` `run` itself inherited). `TRACESTATE` passes through untouched. |

`--traceparent <value>` (default `$TRACEPARENT`) makes the root span a child of that W3C trace context, so a `run` inside a traced CI job joins the job's trace instead of starting its own. An empty `TRACEPARENT` counts as unset. A malformed value (uppercase hex, a version other than `00`, all-zero ids) is a usage error (exit 2) that names where it came from, `--traceparent` or `TRACEPARENT`.

The root span is named after the command's basename (`.exe` stripped), has kind `INTERNAL`, and runs from spawn to exit. Its attributes are `process.command_args` (the full command line), `process.executable.name`, `process.pid` and, when the command exited, `process.exit.code`. A non-zero exit sets the status to `ERROR` with `exit code N`; a command killed by a signal sets `ERROR` with `killed by SIGTERM` (for example) and has no exit code; a zero exit leaves the status unset. The resource comes from the OpenTelemetry environment (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`), host and process detectors, and `service.name` defaults to the command's basename. The `process.*` resource attributes from the process detector describe `otel-html` itself, not the command.

`run` exits with the command's exit code, or `128 + n` when it was killed by signal `n` (143 for SIGTERM; signal numbers are Linux's, and a signal outside the table counts as 128). A report that cannot be started (the receiver cannot bind, the folder is locked by a live process, `--config` is missing or invalid, a disk error) is printed and the command still runs, without `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` or `TRACEPARENT` added, and no report is kept; a report that cannot be finished is printed and the exit code is still the command's. Usage errors (an empty command, a malformed `--traceparent`, an unknown protocol, a disabled transport, `-o` at a non-empty folder that is not a report, `--append` with no report) exit 2 before anything runs. A command that cannot be started (not found, not executable) exits 1 with the system's message, and no report is kept. SIGINT and SIGTERM sent to `run` are forwarded to the command, and `run` keeps waiting for it (in a terminal, Ctrl-C also reaches the command directly from the tty, so it sees the signal twice); a signal while the report is finishing exits 130, as for `serve`.

`run` does not wait after the command exits: the receiver stops accepting, drains the requests in progress and closes the report. An SDK that has not flushed by then loses its tail, so make sure the command shuts its SDK down before it exits. On Windows the executable must be a real binary or a script `run` can start directly; no shell is involved, so a `.cmd` file needs `cmd /c` in front of it.

### `merge <reports...>`

Combines report folders into one, for example the reports of parallel CI jobs. It reads each report's data chunks, so it works across otel-html versions (see [Report format compatibility](#report-format-compatibility)). A cumulative metric series that appears in two reports is two runs: the second report's stream starts from its own start time and is not counted as a counter reset.

```sh
otel-html merge ./job-1 ./job-2 -o ./combined
```

Options: `-o, --out <dir>`, `--config <file>`, `--append`, `--replace` (as for `convert`), and `--format` and `--assets-base`, which the CLI accepts but which are not usable with merge yet: merge writes `chunks`, merging into a `local` or `site` report is not supported yet, and `--assets-base` applies to format 4 only. When `-o` already holds a report, `merge` adds its inputs to it.

### `upgrade <report>`

Rewrites a report's viewer (`index.html` and `assets/`) with the one in this otel-html, so an old report opens with the current viewer. The report's `data/` is not touched, and viewer files in `assets/` that this version does not use are removed. It fails with exit 2, writing nothing, when the folder holds no report or another otel-html has the report open.

```sh
otel-html upgrade ./report
```

### `config print`

Prints the resolved configuration and where each value came from (default, file, environment or flag).

```sh
otel-html config print --config otel-html.yaml
```

Options: `--config <file>`, `--title <title>`, `--format` and `--assets-base` (as for `convert`).

## Library API

The package exports `convert`, `merge`, `Report` and `OtelHtmlError`, plus types (`ConfigInput`, `ConvertOptions`, `MergeOptions`, `ReportOptions`, `ReportSummary`, `AddResult` and others).

`Report.create` also takes `format` (`chunks`, `local` or `site`) and `assetsBase`, which override `config.writer.format` and `config.writer.assetsBase`.

`Report.create`, `convert` and `merge` append when `out` already holds a report written by the same otel-html version; `replace: true` starts over (and, as with `--replace`, holds the first input in memory until it has been read without error; see Limits), `append: true` requires the report to be there. A report from another version fails with a message naming `--replace` and `merge`.

```ts
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { convert, Report } from 'otel-html';

// Convert OTLP files.
await convert({ input: ['run.otlp.json'], out: './report-a', config: { title: 'From files' } });

// Or stream SDK spans into a report.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.getTracer('example').startActiveSpan('work', (span) => {
  span.end();
});

const report = await Report.create({ out: './report-b', title: 'From the SDK' });
await report.addSpans(exporter.getFinishedSpans());
const summary = await report.close(); // flushes chunks and finalizes the manifest
console.log(summary.totals); // { spans: 1, logs: 0, metrics: 0 }
```

### SDK exporters

`OtelHtmlSpanExporter`, `OtelHtmlLogRecordExporter` and `OtelHtmlMetricExporter` plug into the OpenTelemetry JS SDK and write into a `Report`. They can share one report. `shutdown()` flushes the report but does not close it: the caller closes the report.

```ts
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  OtelHtmlLogRecordExporter,
  OtelHtmlMetricExporter,
  OtelHtmlSpanExporter,
  Report,
} from 'otel-html';

const report = await Report.create({ out: './report-c' });

const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new OtelHtmlSpanExporter({ report }))],
});
const loggerProvider = new LoggerProvider({
  processors: [new SimpleLogRecordProcessor(new OtelHtmlLogRecordExporter({ report }))],
});
const meterProvider = new MeterProvider({
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OtelHtmlMetricExporter({ report, temporality: 'delta' }), // default 'cumulative'
    }),
  ],
});

// ... instrument your code ...

await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown(), meterProvider.shutdown()]);
await report.close(); // shutdown() flushes, it never closes the report
```

### Receiving OTLP in-process

`startReceiver(report, overrides?, deps?)` binds the OTLP/HTTP and OTLP/gRPC receivers over a report, the same receivers `serve` uses. `overrides` takes `http` and `grpc` (each `false` to disable, or `{ host?, port? }` to enable; port `0` picks a free one), plus `maxBodyBytes` and `inflightBudgetBytes`; anything left out comes from the report's `receiver.*` config. `deps` (`{ logger?, tracer? }`) defaults to the report's own. It returns `{ http, grpc, stats(), close() }`. `close()` stops listening and finishes requests in progress; the report stays open, so the caller closes it.

```ts
import { Report, startReceiver } from 'otel-html';

const report = await Report.create({ out: './report-d' });
const receiver = await startReceiver(report, { http: { port: 0 }, grpc: false });
console.log(receiver.http); // http://127.0.0.1:<port>
// ... point exporters at it ...
await receiver.close();
await report.close();
```

`Report` also has `addLogs`, `addMetrics` (an SDK `ResourceMetrics`, or OTLP request objects, JSON or protobuf-es messages) and `flush()`. `abort()` gives up instead: it releases the folder's lock without a final checkpoint and leaves what earlier checkpoints wrote; the report is closed afterwards. An `add*` still pending when `abort()` is called resolves normally, but its records are kept only if a checkpoint covered them. Call it when `close()` keeps failing (a full disk), so a later `Report.create` on the folder is not refused with `report-locked` while the process lives. Interval checkpoints (every `writer.flushIntervalMs`, and after that long idle) are written in the background, so after `add*` resolves the report on disk may lag; `flush()` (or `close()`) is the only point at which the report on disk is known to be current. Crash safety does not depend on it: a report is always readable at its last checkpoint. `addMetrics` reads an OTLP JSON object in place rather than copying it: leave it unchanged until the returned promise settles (`addSpans` and `addLogs` copy). `addSpans` accepts SDK `ReadableSpan` arrays, OTLP trace requests, or OTLP JSON objects. `config` takes an object or the path of a YAML/JSON file. Environment variables are not read by the library. `Report.create`, `convert`, `merge` and `startReceiver` take an optional last argument `deps: Partial<ReportDeps>`: a `logger` (`Logger`) for otel-html's messages and a `tracer` (`Tracer`) for its own spans. Nothing else is injectable.

## Viewing logs

Open a report and choose Logs in the sidebar (or press `g l`). The Logs explorer is built like the Traces explorer: a query bar, a severity histogram, facets on the left and results on the right. Everything you set lives in the URL, so a link reproduces the view.

- **Filters.** Type free text or an OTTL condition over the log record (for example `log.severity_number >= SEVERITY_NUMBER_WARN`), or use the facets: Severity, Service, `host.name`, Scope, `event.name`, Has trace, and any attribute. Severity rows offer Only and "And above". Brushing the histogram sets the time window.
- **Group into.** Logs lists records. Patterns groups them by message template. Traces groups them by trace, so you can see which traces are noisy. Group by and the chart views (time series, top list, bar, table, treemap, pie and a severity scatter) work as in the Traces explorer.
- **Patterns.** The writer clusters every log message with an in-house Drain implementation (numbers, IDs and similar tokens are masked into placeholders) and stores the clusters in `data/rollups/logs.js`. The unfiltered Patterns view is therefore exact. With a filter or free text, the viewer runs the same clustering over the matching logs. Choosing a pattern adds a filter token that matches its template with `IsMatch(log.body.string, ...)`, which stays editable in the query bar. `IsMatch` patterns are RE2-like (no backreferences, no lookaround, no inline flag groups such as `(?i:...)`; a leading `(?i)` or `(?s)` is fine), and a repeated group with a variable part inside is accepted only when a literal the repeated part cannot match ends each variable part, like `(\d+\.){3}`.
- **Log panel.** Click a log to open its panel. The body is shown above the tabs, rendered by type (text, JSON-like maps and lists, bytes). Attributes lists the log's attributes and its record fields. Trace shows the trace's flame graph with the span that emitted the log outlined. It is hidden when the log's trace is not in the report. Surrounding logs lists the logs before and after it from the same stream. Resource shows the resource and scope. A very long body shows its first 16,384 characters with a control to show all.
- **Cross-links.** A span or trace panel has a Logs tab that lists its logs, and "Open in Logs Explorer" jumps to the Logs explorer with the matching `trace_id` or `span_id` condition. A log with trace context links back to its trace and span: the log panel's Trace fact, its Trace tab ("Open trace →") and the log list's trace column open the trace.

### What carries between explorers

When you move between explorers (the sidebar, `g l` and `g t`, or an "Open in ... Explorer" link), only the time window (`t`), the free text (`text`) and a query (`q`) that compiles in the target explorer's OTTL context come along. Everything else resets: group, view, sort, selected trace, span or log, and panel tabs. A query that does not compile there (such as `span.name == "x"` carried to Logs) is dropped, and the page shows a dismissible notice naming it. Inside one explorer everything is kept.

## Viewing metrics

Choose Metrics → Explorer in the sidebar (or press `g m`). Like the other explorers, everything you set lives in the URL.

- **Explorer.** Each query row picks a metric (with its type badge and unit), a `where` filter (an OTTL condition over the data point: `resource.attributes[...]`, `attributes[...]`, `metric.name`), what to show, a `by` grouping and functions (`ƒ`: rate, increase, rollup, top/bottom N). What you can show depends on the type: a monotonic sum shows rate, increase or sum; a gauge or other sum shows avg, min, max or last; a histogram shows p50 to p99, count, sum or avg; a summary shows its quantiles, count or sum. Series inside one group are combined by type: counters add, histograms merge their buckets, and gauges use the chosen aggregation (`last` adds the series' last values, so `process.memory.usage` by everything is the total). Up to 10 queries, plus formulas over them (`a / b`). Displays: Lines, Area, Bars, and for histograms Heatmap and Distribution, on a linear or log y-axis. A chart shows one unit; queries with different units are split into one chart per query. Export writes the charted series as CSV or JSON.
- **Exemplars and the click menu.** With Exemplars on, the exemplars stored with the series are drawn as rings. Clicking a chart opens a menu: open the exemplar's trace (or say that the report does not hold it), Traces or Logs in this window (the clicked bucket's time window, with the query's `where` carried as between explorers), or zoom. Dragging across a chart zooms to that span.
- **Catalog.** Metrics → Catalog lists every metric definition: type, unit, temporality, scope, attribute keys, series count and a sparkline over the run. A text filter matches name, unit and scope. Clicking a row opens the metric in the Explorer with its type's default display.
- **Metrics tabs.** The log panel, the span section and the trace panel have a Metrics tab when the log's, span's or trace's resources report metrics. It charts every metric of those resources over the moment ± 5 minutes, grouped by namespace (`process.*`, `http.*`, ...). Only the first group starts expanded, and charts render as they scroll into view. A dashed line marks the log, the span or the trace start, and exemplars of the same trace are highlighted. Size S/M/L changes the chart height, and "Open in Explorer →" opens the expanded group's metrics with the same resource filter and window.
- **Never silently wrong.** A chart says so in a note when its numbers need a caveat: series folded into "other" by the series cap, counter resets, summary quantiles at a coarse resolution, a name with several definitions, histograms with different bucket bounds, or a chart built from an unfinished report's segments. The click menu says when an exemplar's trace is not in the report.
- **Unfinished reports.** The writer adds each metric's buckets to a segment file at every flush and compacts the segments into resolution levels at close. A report whose writer was killed, or one opened before `close`, has segments only; its charts are built from the segments, more slowly on very long runs.

## Viewing dashboards

Choose Dashboards in the sidebar (or press `g d`, which opens the default dashboard). The list shows every dashboard in the report: **Fusion** (built in) and the ones from config, with the default marked ★. A dashboard lives at `#/dashboards/<id>`, and everything you set on it is in the URL (the `d` key), so a link reproduces the view.

- **Fusion.** A timeline of spans, logs and metric points, with Traces, Logs and Metrics below it. They follow what you select: brushing the timeline narrows the Traces and Logs lists to that time ("in selected time"), and clicking a trace narrows Logs to its logs ("for the selected trace") and Metrics to the metrics of the trace's resources. Its variables are `service.name`, `deployment.environment.name` and `host.name`.
- **Variables.** Each variable is a dropdown of the values of a resource attribute. A choice filters every widget except the timeline's metric-point lane, which is run-wide and never filtered (`resource.attributes["k"] == "v"` for records and data points; the Metrics grid keeps the resources whose attribute equals the value), and a config dashboard can set a default. A variable with no values in the report is hidden, and the bar counts the hidden ones.
- **Selection chips.** The time window and the trace you selected show as removable chips (`time ∈ …`, `trace_id = …`) with Clear all. The page's own time range stays separate from the selection.
- **Follow.** Each widget except the timeline has a "follows selection" toggle (⛓). Turned off, the widget ignores the selection and lists everything in the page's time range.
- **Show context.** The Logs widget has Only matches and Show context. Show context lists every log in the window (variables still apply) and marks the ones that match.
- **Open in …** A widget's "Open in Traces / Logs / Metrics" jumps to the explorer with the widget's effective filter and window.
- **Edit layout → Copy config.** Edit layout lets you drag and resize widgets. Copy config copies the dashboard as YAML with its current layout, ready to paste into a config file. Copying Fusion gives `id: fusion-copy` and `title: Fusion (copy)`, because `fusion` is reserved. Where the clipboard is not available, the text opens in a dialog.
- **Views ▾.** The Traces, Logs and Metrics explorers have a Views menu. It lists the `views` from config and the views you saved in this browser, and "Save current view…" stores the current query, grouping and view (not the time range) in `localStorage`. Applying a view keeps the time range.
- **Copy as dashboard widget.** The explorers' Export menu copies the current List, Top list, Table or metric chart as YAML for one dashboard widget, ready to paste into a dashboard's `widgets`. Views that cannot become a widget (Patterns, the Distribution display) say why.

A config dashboard looks like this:

```yaml
viewer:
  defaultDashboard: checkout
  home: dashboards

dashboards:
  - id: checkout
    title: Checkout
    variables:
      - service.name
      - key: deployment.environment.name
        label: environment
        default: production
    widgets:
      - type: timeline
        x: 0
        y: 0
        w: 12
        h: 6
      - type: traces
        x: 0
        y: 6
        w: 6
        h: 10
      - type: logs
        x: 6
        y: 6
        w: 6
        h: 10
        query: severity_number >= 13
      - type: metric
        x: 0
        y: 16
        w: 12
        h: 8
        queries:
          - id: a
            metric: http.server.request.duration
            show: p95
        echarts:
          legend:
            show: false
```

The grid has 12 columns. A widget is `timeline`, `traces`, `logs`, `metric`, `toplist` or `table`; `toplist` and `table` take `signal` (`spans` or `logs`), `groupBy` and an optional `measure`: `count` (the default), or `duration.sum`, `duration.avg`, `duration.max`, `duration.p95` or `duration.p99` for spans. A duration measure keeps the first 1,000 values of `groupBy`; the widget says how many spans had other values. A `groupBy` that is not a facet of the report says so in the widget and suggests the closest known keys. A `metric` widget without `queries` is a grid of the metrics of the selected trace's resources.

A `metric` widget with `runBy` is a run chart: one point per CI run instead of one per time bucket. `runBy` is a data point path whose value identifies a run, `failedWhen` an OTTL condition (data point context) that marks a point as failed, and `controls` sets the starting state of the chart's toggles (`slider`, `evenSpacing`, `split` and `legend`; the values below are the defaults and can be left out). `failedWhen` and `controls` need `runBy`, and `runBy` needs exactly one query with no `fn`, no `formulas`, `display: lines` and `scale: linear`. `failedWhen` can't read per-point fields such as `flags`.

```yaml
- type: metric
  title: Job duration
  x: 0
  y: 6
  w: 12
  h: 20
  runBy: resource.attributes["cicd.pipeline.run.id"]
  failedWhen: attributes["cicd.pipeline.task.run.result"] == "failure" or attributes["cicd.pipeline.task.run.result"] == "timeout" or attributes["cicd.pipeline.task.run.result"] == "error"
  controls:
    slider: true
    evenSpacing: true
    split: true
    legend: false
  queries:
    - id: a
      metric: cicd.pipeline.task.run.duration
      show: avg
      by: ['attributes["cicd.pipeline.task.name"]']
```

[`fixtures/dashboards.otel-html.yaml`](fixtures/dashboards.otel-html.yaml) has one widget of each type on its Checkout dashboard, and the CI dashboard of `.github/otel-html-ci.yaml`; `mise run demo` includes both, on made-up data.

## Report layout and hosting

### Format 3 (`--format chunks`, the default)

```
report/
  index.html            shell; classic <script> tags only
  .nojekyll             stops GitHub Pages from hiding files
  assets/               the viewer: viewer.<hash>.js and viewer.<hash>.css
  data/
    manifest.js         run metadata and chunk list
    rollups/            spans.js, logs.js, metrics.js
    chunks/             spans/, logs/, metrics/  (000000.js, ...)
    metrics/            per metric (<id6>/): series.js (definitions, point gaps, a summary's quantiles), l<k>.js resolution levels and ex.js / ex<k>.js
                        exemplars (a level or exemplar file over more than 2,048 buckets is one file per page:
                        l<k>-<p6>.js, ex-<p6>.js, ex<k>-<p6>.js), or seg-<n6>.js segments until the writer closes
    traces/             trace index shards (<xx>.js)
    state/              writer checkpoint (session.<n>.json)
```

Every data file is a classic script that registers its payload with a global, so the report works without `fetch`, ES modules or workers. All paths are relative and navigation uses the URL hash.

### Format 4 (`--format local` or `site`)

The viewer cannot open format-4 reports yet; the layout below is what the writer produces so far. It sits beside the format-3 layout above until the viewer reads it.

```
report/
  index.html
  .nojekyll
  assets/                 viewer.<hash>.js and .css, plus the DuckDB engine files for this format (omitted when assetsBase is shared)
  data/
    manifest.js           run metadata, the partition list with per-file statistics, and `engine` (version, format, assetsBase)
    partitions/<p6>/      <table>.parquet for spans, logs, points, traces and patterns (000000/, 000001/, ...)
                          and, for `local`, <table>.parquet.js beside each: the same bytes as a base64 script
    state/                writer checkpoint
```

- `site` is for a report served over http: the viewer reads the `.parquet` files and loads `assets/duckdb.<v>.wasm` and `duckdb.<v>.worker.js`.
- `local` opens from `file://`, where nothing can be fetched: every `.parquet.js` wrapper and the engine's `duckdb.<v>.wasm.gz.b64.js` and `duckdb.<v>.worker.b64.js` are classic scripts that register their bytes. Wrappers are a third larger than the Parquet, so a large report is better served as `site` (the writer warns past `writer.localWarnBytes`).
- Closing a report compacts its flush partitions into one sorted partition when there are two or more.
- `assetsBase` (default `assets/`) names where the viewer and engine files load from. A site that publishes them once for many reports sets it to a shared relative path such as `../../assets/0.3.0/`, and the report then carries no `assets/` of its own.

### Hosting

- Format 3 and `local` reports: open `index.html` directly from disk (`file://`). A `site` report needs a web server, since the viewer fetches its Parquet files and engine.
- GitHub Pages and GitLab Pages: publish the folder as it is. It works under a subpath such as `https://user.github.io/repo/report/`.
- Any other static host or subpath works the same way.
- CI: upload the folder as a build artifact.

The report is exercised in Chromium, Firefox and WebKit by the end-to-end tests: every test loads it from `file://`, a tagged subset also from a static server, and the `@perf` budgets run on `file://` only.

### This repo's CI

This repo's CI reports on itself with `otel-html`. Every job in [ci.yml](.github/workflows/ci.yml) builds the CLI first, then uses it as the job's shell, so each `run:` step is a traced command:

```yaml
shell: node dist/cli/main.js run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}
```

The `otel-html ci context` step ([src/cli/ci/context-main.ts](src/cli/ci/context-main.ts)) looks the job up in the Actions API and sets `TRACEPARENT` and the resource attributes for later steps. The trace id is derived from the run, and the span ids from the run and job, so the job reports nest under the run → job spans without the jobs talking to each other. If the job lookup fails, the job id falls back to a hash of its name and runner (with a warning), and `context.json` records both; the publisher matches it to the job (its display name, or a matrix leg `<name> (…)`, on that runner), so matrix legs no longer need `OTEL_HTML_JOB_NAME`. Set it when the job's `name:` differs from its id beyond case, or when two legs of one name ran one after another on one runner. Each job uploads its `.otel-html/` folder as an `otel-html-*` artifact.

When the `ci` or `load` workflow completes, [ci-report.yml](.github/workflows/ci-report.yml) runs `otel-html ci report` ([src/cli/ci/report-main.ts](src/cli/ci/report-main.ts)). The workflow is the default branch's copy, and it builds the report with the triggering commit's own code when that commit is in this repository and a person started the run; a fork's or a bot's run, or a dispatched `ci` run, uses the default branch's code (a manual dispatch of `ci-report` uses the code of the ref it was dispatched on). A person's same-repository commit executes under `main`'s Actions cache scope and could save a `mise-tasks-*` entry that later runs replay as a pass. Only people with write access can do that, and `main`'s ruleset requires a pull request with an approving review and requires no status check, so a forged pass can make a run look green but cannot merge anything a reviewer would not see. This risk is accepted. The report job writes the run → job spans from the Actions API, turns each job's log into log records, adds queue-time and duration metrics, and merges these with the job artifacts into one report, uploaded as `ci-run-report`. Run it by hand with `workflow_dispatch` and a `run_id` to rebuild a past run. The report opens on the [CI dashboard](.github/actions/otel-html-publish/otel-html-ci.yaml): job duration, queue time, step counts, runs, and warnings and errors, with `workflow` (`cicd.pipeline.name`, to tell `ci` and `load` runs apart on a shared page), `run` and `job` variables. The run-level span lives on the run's own resource, so selecting a job in `job` hides it from the widgets that list spans; the Runs list still shows each run that job ran in, through its job span. A job skipped by its `if:` gets no duration or queue-time point. The run key includes the run attempt, so after a partial re-run the artifacts of jobs that did not re-run (still attempt 1) show up as separate traces without a job span.

The run's report is then published to the site at <https://bjstabi.github.io/otel-html/>. The layout is:

- `/index.html` (landing page) and `/index.json` (site index).
- `/branch/<name>/` and `/branch/<name>/runs/<run_id>/` for pushes to the default branch of this repo: [`/branch/main/`](https://bjstabi.github.io/otel-html/branch/main/). `<name>` is the branch lower-cased with each run of other characters as one `-`.
- `/pr/<number>/` and `/pr/<number>/runs/<run_id>/` for any other run whose commit or branch belongs to an open pull request (the pull request may have been pushed to since). A default-branch run always goes to its branch's folder, even when an open pull request's head is, or contains, its commit.

Each folder holds the runs of every workflow (`ci`, `load`). A run on any other branch, or a push from a fork, with no open pull request is not published. The site keeps the last 30 runs of each workflow per branch and the last 10 of each workflow per pull request; a re-run replaces its folder. GitHub Pages sites are limited to 1 GB. A run's report here is about 3.6 MB (1.9 MB of it the viewer), and each folder also carries its rolling report, about the viewer plus the runs' data again: at the defaults that is about 320 MB for `/branch/main/` and about 55 MB per open pull request, so the site nears 1 GB at around a dozen active pull requests. When a pull request closes or merges, `pull_request_target` triggers the `cleanup` job, which removes its `/pr/<number>/` folder; after a merge, `/branch/main/` carries the merged result. The per-workflow folders of earlier versions (`/ci/`, `/load/`) are removed by the next publish; nothing redirects from them.

`/branch/<name>/` and `/pr/<number>/` are rolling reports: after each publish the publisher merges the channel's retained `runs/<run_id>/` reports, oldest first, into one report and replaces everything in the folder except `runs/` and any `preview-*.png` screenshots, which survive rebuilds (a later step may refresh them). After each rebuild it also writes a `badge-<workflow>.json` file per workflow into the folder, a shields.io endpoint badge showing that workflow's newest run. Runs inside it are told apart by trace id (one per run attempt, so a re-run is its own trace) and by the `cicd.pipeline.run.id` resource attribute, which the dashboard's `run` variable selects. Retention bounds it: a run older than its workflow's newest 30 (10 on a pull request) drops out of the channel, and the next rebuild leaves it out. The run being published always stays listed, even when it is older than the ones kept (a dispatched rebuild of an old run), and the next publish's retention removes it. A per-run report whose format this version of otel-html no longer reads is skipped with a warning; its run stays listed and the rest still merge, until retention removes it. If the merge fails for any other reason, the channel warns and falls back to a stub forwarding to the newest run. A `load` run whose jobs were skipped has no job reports and publishes nothing.

The `gh-pages` branch is the store: one orphan commit holding the whole site, replaced on every publish rather than grown, so history does not accumulate every run's data. [site-branch.sh](.github/actions/otel-html-publish/site-branch.sh) checks out the tip and pushes the new commit with `--force-with-lease` against it. A rejected lease (another publish or a cleanup got there first) checks out again, re-applies and retries, up to 5 attempts, so a cleaned-up pull request is never brought back. The `report` job in [ci-report.yml](.github/workflows/ci-report.yml) runs the [otel-html-publish](.github/actions/otel-html-publish/action.yml) action with `deploy: false`, which builds the report, publishes it and links it; on default-branch runs it also sets `preview: true`, which keeps the screenshot at the top of the README current. The `deploy` job ships the `gh-pages` tip under the concurrency group `pages`, so a pending deploy replaced by a newer one loses nothing: the one that runs ships the latest tip. It runs only from the default branch, so a `workflow_dispatch` on another branch updates `gh-pages` and skips the deploy; the next default-branch deploy ships it.

`otel-html ci link` posts one sticky comment per workflow on the open pull requests of a pull request run (found by a per-workflow marker, so `ci` and `load` do not overwrite each other; a default-branch run comments on none). The comment links this run's report, the pull request's rolling report (`All runs on pull request #<number>`, `/pr/<number>/`) and the run before it on the pull request (the previous run of the same workflow, else the one before it of any workflow), and creates a check run named `otel-html report` that concludes `neutral`: it is a link, not a second verdict on the run.

These subcommands are for the actions; stable flags, output format not guaranteed.

| Subcommand | What it does | Flags |
| --- | --- | --- |
| `ci report` | Builds a run's report from the Actions API (with `$GITHUB_TOKEN` from the environment) and merges it with the downloaded job artifacts. Writes the summary table to the job summary, and `published=false` to `$GITHUB_OUTPUT` when the run has no job reports. | `--run-id`, `--repository`, `--artifacts`, `--out` (all required); `--config`; `--no-summary` (the action does not pass it: on `github-pages` it points `$GITHUB_STEP_SUMMARY` at a file for this step and appends that file to the job summary only when the site push did not publish, since `ci link` writes the linked summary otherwise) |
| `ci site` | Places a run's report in the checked-out site folder, applies retention, drops the older per-workflow channels, rewrites the indexes and the rolling report. Writes `published`, `report-url`, `channel` and `rolling` (`built`, or `stub` when the merge fell back to the redirect) to `$GITHUB_OUTPUT`, and a `badge-<workflow>.json` per workflow beside the rolling report. | `--site`, `--report`, `--run-id`, `--repository`, `--base-url` (all required); `--retention` (30 per workflow, per branch), `--pr-retention` (10 per workflow, per pull request) |
| `ci link` | Comments on the pull requests (this run's report, the pull request's rolling report (`/pr/<number>/`), the previous run), creates the check run and writes the job summary. Never fails the job. | `--run-id`, `--repository`, `--url`, `--site` (all required); `--no-comment`, `--no-check` |
| `ci cleanup` | Removes a closed pull request's reports (`pr/<number>/`) from the site folder. Writes `cleaned=true` to `$GITHUB_OUTPUT`, or `cleaned=false` and changes nothing when the site never had the pull request. | `--site`, `--pr` (required); `--repository` (default `$GITHUB_REPOSITORY`) |

See [Use in your CI](#use-in-your-ci) to adopt this in another repo.

### Use in your CI

Three composite actions let another repository report on its own CI. They need an otel-html release that has `run` and `ci` (the first release after 0.1.1). `@v0` floats to the latest 0.x release (the release workflow moves it; prereleases leave it alone), and with `version: latest` (the default) the actions used at `@v0` install the newest 0.x binary, never a 1.x one; at any other ref `latest` is the repository's latest release. Pin a release tag such as `@otel-html-v0.2.0` for reproducibility. `v0` becomes `v1` at 1.0.

- `bjstabi/otel-html/.github/actions/otel-html-setup@v0` installs the CLI (checksum-verified) and joins the job to the run's trace.
- `bjstabi/otel-html/.github/actions/otel-html-collect@v0` uploads the job's `.otel-html/` folder as an `otel-html-<job>` artifact.
- `bjstabi/otel-html/.github/actions/otel-html-publish@v0` builds the run's report from those artifacts, publishes it to the `gh-pages` branch and links it from the pull request.

In each job, run setup first, make the CLI the job shell, and collect last. A `run:` step before setup runs before the CLI exists, so it needs `shell: bash`:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read # checkout
      actions: read # setup reads the run's jobs to find this one
    defaults:
      run:
        shell: otel-html run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}
    steps:
      - uses: actions/checkout@v7
      - uses: bjstabi/otel-html/.github/actions/otel-html-setup@v0
      - run: npm test
      - if: always()
        uses: bjstabi/otel-html/.github/actions/otel-html-collect@v0
```

Setup inputs: `version` (a release such as `0.2.0`, default `latest`), `command` (an executable instead of a download), `job-name` (the job's display name, used to tell the job apart when the lookup is ambiguous, and for the span id when it fails; see above) and `token`. Collect inputs: `name` (default `otel-html-<job>`; matrix legs need one each, or one leg's upload replaces another's) and `path` (default `.otel-html/`).

#### The publisher

Publish from a separate `workflow_run` workflow, which runs the default branch's copy and never the triggering run's code (which may be a fork PR). [ci-report.yml](.github/workflows/ci-report.yml) is the model. In short:

```yaml
name: ci-report
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
  pull_request_target:
    types: [closed]
permissions: {}

jobs:
  report:
    # A failed or cancelled run is worth a report; a run that never really ran is not.
    if: >-
      github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'skipped' &&
      github.event.workflow_run.conclusion != 'action_required'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: write # the gh-pages push
      pages: read
      pull-requests: write # the comment
      checks: write # the check run
    outputs:
      published: ${{ steps.publish.outputs.published }}
    steps:
      - id: publish
        uses: bjstabi/otel-html/.github/actions/otel-html-publish@v0
        with:
          deploy: false

  cleanup:
    if: github.event_name == 'pull_request_target'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      cleaned: ${{ steps.cleanup.outputs.cleaned }}
    # No checkout: the action installs the CLI, and this job holds a write token, so it never runs the PR's code.
    steps:
      - id: cleanup
        uses: bjstabi/otel-html/.github/actions/otel-html-publish@v0
        with:
          cleanup-pr: ${{ github.event.pull_request.number }}
          deploy: false

  deploy:
    needs: [report, cleanup]
    # The github-pages environment accepts the default branch only; a pull request the site never had deploys nothing.
    # Closing a pull request into another branch updates gh-pages, and the next report's deploy ships it.
    if: >-
      !cancelled() && github.ref_name == github.event.repository.default_branch &&
      (needs.report.outputs.published == 'true' || needs.cleanup.outputs.cleaned == 'true')
    runs-on: ubuntu-latest
    concurrency:
      group: pages
      cancel-in-progress: false
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    permissions:
      contents: read
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: gh-pages
          path: public
          persist-credentials: false
      - run: rm -rf public/.git
      - uses: actions/upload-pages-artifact@v5
        with:
          path: public
      - id: deployment
        uses: actions/deploy-pages@v5
```

`report` and `cleanup` do not share a concurrency group; only `deploy` does. GitHub cancels a superseded pending run in a concurrency group, so that group on the publishing jobs would drop reports; deploying the `gh-pages` tip makes a replaced deploy harmless, because the one that runs ships the latest. Pin the actions to SHAs as this repo does.

The site has the same layout as this repo's: a default-branch run goes to `/branch/<name>/` (rolling, last 30 runs of each workflow) and `/branch/<name>/runs/<run_id>/`; a pull request's runs go to `/pr/<number>/` (rolling, last 10 runs of each workflow) and `/pr/<number>/runs/<run_id>/`. Each holds the runs of every workflow. The sticky comment links this run's report and `All runs on pull request #<number>`, the pull request's rolling report. When the pull request closes or merges, `cleanup` deletes `/pr/<number>/`; after a merge the default branch's page carries the merged result. Upgrading from a version with per-workflow folders (`/ci/`, `/load/`): the next publish removes them, with no redirect, and the default branch starts over at `/branch/<name>/`.

Pages setup: Settings, Pages, Source: GitHub Actions (`build_type: workflow`), and the `github-pages` environment's deployment branches must allow the default branch.

A private repository's Pages site is public unless the organization has Pages access control (GitHub Enterprise Cloud). The reports carry the CI logs, job names and pull request titles, so publishing them makes those public; the action warns when it publishes from a private repository. Use `target: artifact` to keep the reports in the run's artifacts instead.

Nothing in a report is redacted. The job logs come from the Actions API, where GitHub has already masked the secrets it knows about; the jobs' own telemetry (what the commands under `otel-html run` export) is published as sent, so keep secrets out of the spans, logs and metrics your jobs emit.

Publish inputs:

| Input | Default | |
| --- | --- | --- |
| `run-id` | the `workflow_run`'s run, else this run | The run to report on. |
| `version`, `command` | `latest`, empty | As for setup. |
| `config` | the action's own `otel-html-ci.yaml` | The dashboard config for the reports. |
| `target` | `github-pages` | `artifact` uploads the run report as the `ci-run-report` artifact only: nothing reaches the site and nothing is linked. |
| `retention`, `pr-retention` | 30, 10 | Runs kept of each workflow per branch page and per pull request page. GitHub Pages sites are limited to 1 GB, and a run's report is about 3.6 MB in this repo, so mind the total: about workflows × (`retention` + open pull requests × `pr-retention`) × your report size × 1.5, the 1.5 for the rolling reports (each holds its runs' data again). In this repo that is about 320 MB for the default branch and 55 MB per open pull request. |
| `comment`, `check` | true | The sticky PR comment and the `otel-html report` check run. |
| `deploy` | true | Deploy to Pages in this job; needs `environment: github-pages` and `pages: write` and `id-token: write`. `false` leaves it to a separate `deploy` job as above. |
| `preview` | false | Screenshot the default branch's rolling report in light and dark (`preview-light.png`, `preview-dark.png` in its folder) when a run rebuilds it, for a README image. Installs Playwright's Chromium, about 1 minute per run; needs Node and passwordless sudo on the runner. Only the default branch's page; a failed install or screenshot is a warning and the publish goes on. |
| `cleanup-pr` | empty | A pull request number: skip the report and remove that PR's reports (`/pr/<number>/`) from the site. |
| `token` | `github.token` | Needs `actions: read`, `contents: write`, `pages: read`, `pull-requests: write`, `checks: write`. |

Outputs: `report-url` (empty when nothing was published), `published` and `cleaned`. A cleanup sets `published=false`, and `cleaned=true` only when the site had that pull request; for one it never had, nothing is pushed or deployed and `cleaned=false`.

GitHub points a check run created with `GITHUB_TOKEN` at the Actions run page, so the report URL is in the check's summary and in the PR comment.

Final-job mode: for a repository with no separate publisher, put the action in the last job of the same workflow (`needs:` every other job, `if: always()`), with `deploy: true`, `environment: github-pages` and the write permissions above. That job's own timings are incomplete in the report, and a fork PR's token cannot push, so prefer the `workflow_run` publisher.

### Report format compatibility

`data/` is the model; `assets/` and `index.html` are the viewer. The manifest's `formatVersion` (now 3) is bumped only for a change an older reader cannot read. This otel-html reads formats 1 to 3 (see [`src/format/version.ts`](src/format/version.ts)), and a reader fails fast on a version it does not know.

- `merge` re-renders any readable report with the current viewer, so reports from different otel-html versions combine into one report in the current format.
- `--append` needs the same otel-html version as the report it appends to.
- A new viewer must read every version in `READABLE_FORMAT_VERSIONS`. Frozen format-1, format-2 and format-3 reports in `fixtures/reports/` are merged, and opened by the viewer's data layer, by the tests to hold that.
- Maintainers: every format version a release ships has a frozen report, written by that release, in `fixtures/reports/`, added with its compat test when the release is cut; a version leaves `READABLE_FORMAT_VERSIONS` only together with its fixture.

## Configuration

Config is a YAML or JSON file (`otel-html.yaml` by default), or an object passed to the API. Precedence, lowest to highest: defaults, config file, environment variables, CLI flags or API arguments. Unknown keys are rejected. The JSON Schema for editor autocomplete is [`schema/otel-html.schema.json`](schema/otel-html.schema.json).

| Key | Default | Meaning |
|---|---|---|
| `title` | none | Report title. Env: `OTEL_HTML_TITLE`. |
| `writer.format` | `chunks` | Report format: `chunks` (the current format), or `local` / `site`, which write format 4 (Parquet partitions; `site` is for a published site with shared assets). With `local` or `site`, closing the report compacts its flush partitions into one sorted partition when there are two or more; if the compaction fails, the failure is logged and the report keeps its flush partitions, still complete and valid. Format 4 is not yet readable by the viewer, so `chunks` stays the default for now. Env: `OTEL_HTML_FORMAT`. |
| `writer.rowGroupRows` | 50000 | Rows per Parquet row group in format 4 (50000 to 100000). |
| `writer.statisticsKeys` | `[]` | Extra columns whose statistics are kept per partition file in format 4, beyond those the dashboards and views use. Each entry is a column name, `attr:<key>` (a span, log or metric point attribute) or `resource:<key>` (a resource attribute); a bare attribute key is accepted but matches nothing, so it prunes nothing. |
| `writer.localWarnBytes` | 256000000 | The size, in bytes of Parquet, past which a `local` report warns (once per session) that `--format site` serves large reports better. The base64 scripts a `local` report loads are about a third larger. |
| `writer.assetsBase` | `assets/` | Where a format-4 report loads the viewer assets from: `assets/`, or a relative path such as `../../assets/0.3.0/`. Only with `writer.format` `local` or `site`; any other value with `chunks` is a configuration error. |
| `writer.chunkTargetBytes` | 4000000 | Target size of a data chunk. With `writer.format: local` or `site` it is the size at which held rows are cut into a flush partition (spans, logs and metric points alike); a closed report compacts those flush partitions when there are two or more (see `writer.format`). |
| `writer.flushIntervalMs` | 5000 | Checkpoint interval. Also checkpoints once after this long idle with new records. |
| `writer.dedupeCapacity` | 200000 | Recent span IDs remembered for de-duplication. |
| `writer.facetValueCap` | 1000 | Distinct values kept per facet key; also bounds the viewer's filtered facets. |
| `writer.facetKeyCap` | 500 | Facet keys kept. |
| `writer.metricSeriesCap` | 1000 | Series kept per metric. Further series fold into one "other" series, and charts that would need to split it say they are partial. Applies to `writer.format: chunks` only: `local` and `site` write every point as a row and fold nothing. |
| `writer.metricExemplars` | 4 | Exemplars kept per series per finest time bucket (those with a trace id first, then the most extreme values). Applies to `writer.format: chunks` only: `local` and `site` keep every exemplar on its point row. |
| `writer.drop.traces.span` | `[]` | OTTL conditions; matching spans are dropped at write time. |
| `writer.drop.logs.log_record` | `[]` | Same, for log records. |
| `writer.drop.metrics.datapoint` | `[]` | Same, for metric data points. |
| `receiver.host` | `127.0.0.1` | Address the receiver listens on. |
| `receiver.http.enabled` | `true` | Listen for OTLP/HTTP. |
| `receiver.http.port` | 4318 | OTLP/HTTP port (0 picks a free port). |
| `receiver.grpc.enabled` | `true` | Listen for OTLP/gRPC. |
| `receiver.grpc.port` | 4317 | OTLP/gRPC port (0 picks a free port). |
| `receiver.maxBodyBytes` | 67108864 | Largest request body accepted, after decompression (64 MiB). Larger requests are rejected (413 / `RESOURCE_EXHAUSTED`). |
| `receiver.inflightBudgetBytes` | 134217728 | Body bytes the receiver holds in progress or queued (128 MiB). A request that would exceed it while another is in progress is refused with 503 / `UNAVAILABLE` so the exporter retries. |
| `viewer.eagerBudgetBytes` | 75000000 | Decoded size under which the viewer loads everything up front. Applies to each signal on its own: the viewer estimates the decoded size of the spans and of the logs separately, so a report can have eager spans and windowed logs. Env: `OTEL_HTML_EAGER_BUDGET_BYTES`. |
| `viewer.listCap` | 10000 | Maximum rows in result lists. |
| `viewer.defaultDashboard` | `fusion` | The dashboard `g d` and the sidebar's ★ item open. Must be `fusion` or the id of a dashboard in `dashboards`. A config without `dashboards` that leaves it at `fusion` keeps the default of the report it is written into. |
| `viewer.home` | `traces` | Where the report opens: `traces`, `logs`, `metrics` or `dashboards` (the default dashboard). A config that leaves it at `traces` keeps the home page of the report it is written into (or, with `merge`, the first report's). |
| `viewer.theme` | `system` | `system`, `light` or `dark`. The theme a report opens in; a theme the viewer picks themselves is remembered and wins. |
| `dashboards` | `[]` | Dashboards: `{ id, title, description?, variables?, widgets }`. `variables` are resource attribute keys, or `{ key, label?, default? }`. Each widget has `type`, `x`, `y`, `w`, `h` on a 12-column grid, plus `id?`, `title?` and `follow?`, and the fields of its type (`toplist` and `table`: `signal`, `groupBy`, optional `measure` of `count` or, for spans, `duration.sum`, `duration.avg`, `duration.max`, `duration.p95` or `duration.p99`). An `echarts` object on a `metric` or `toplist` widget is merged over the chart option otel-html builds. **It is unstable:** it is passed to ECharts as is, so its compatibility is ECharts', not otel-html's. Treat it as code: ECharts renders string templates such as `tooltip.formatter` as HTML, and the names they fill in come from the telemetry. Ids are lowercase letters, digits and dashes; `fusion` is reserved. Checked when the config loads, with errors at their path (`dashboards[0].widgets[2].query`). A config without `dashboards` keeps the ones of the report it is written into. With `merge`, the dashboards of `--config` win; without them the first report's are kept. |
| `views` | `[]` | Saved views for the explorers' Views menu: `{ id, title, page, query?, text?, mode?, groupBy?, view?, sort?, metrics? }`, where `page` is `traces`, `logs` or `metrics`. |

`OTEL_HTML_CONFIG` selects the config file. `OTEL_HTML_DEBUG=1` makes the CLI print stack traces on errors.

## Limits

- A report folder reused by many runs grows without bound; start it over with `--replace` now and then. Each `run` is its own trace, told apart by start time and `process.command_args`.
- Timestamps are JavaScript numbers, exact to 2^53 ns. That is about 104 days of relative time span within one report.
- The receiver has no TLS or authentication and reflects only localhost origins for CORS; bodies over 64 MiB are refused (413); logs and metric points a sender retries are not deduplicated.
- Over gRPC a message larger than twice `receiver.maxBodyBytes` is refused by grpc-js before otel-html sees it and is not counted; between the limit and twice the limit it is counted as `too-large`.
- The in-flight budget (`receiver.inflightBudgetBytes`, 128 MiB) is reserved from `Content-Length`, or as a streamed body inflates, before the body is buffered, so HTTP memory is bounded by the budget plus one body.
- gRPC: a call reserves `maxBodyBytes` of the in-flight budget when it starts, before its message is read, and is refused `UNAVAILABLE` (retryable, counted `busy`) when that would exceed the budget. The reservation is held until the message has been read in full and the handler admits its real size. Each admitted call reserves `maxBodyBytes` but may buffer up to twice that (the grpc-js ceiling) before the handler refuses it as too large, so across connections gRPC memory is bounded by about twice the budget. Each connection is additionally capped by Node's HTTP/2 session memory at that ceiling × its stream limit. Each concurrent call needs `maxBodyBytes` of budget while its message is read, so a budget below twice `maxBodyBytes` lets a connection run only one call at a time (the defaults are exactly twice).
- The viewer is for static reports that open from `file://`. It does not follow a report that is still being written; reload to see what the receiver has checkpointed.
- When a signal is larger than `viewer.eagerBudgetBytes`, the viewer reads its chunks on demand. Services numbers, filtered log results and filtered patterns are then partial (the viewer says "from N of M chunks") until you choose "Scan entire run" (in Traces mode that scan still stops at `viewer.listCap` traces; a trace whose spans sit in several chunks shows its service share as partial unless the scan reaches its first matching span in the first of those chunks it reads; Newest first reads the newest chunk first). Opening a trace or its Logs tab reads only the chunks the trace index lists for it.
- Dashboard layout edits are not saved: Edit layout changes the page until you reload. Use Copy config and paste the result into your config file.
- The Fusion timeline's metric lane comes from the run-wide rollup, so it ignores variables and says "all resources" when one is set.
- Log pattern clustering stops creating clusters at 2,000. A message that fits no existing cluster after that stays unclustered, and the Patterns view reports how many.
- The design target for logs is 1,000,000 records in about 200 bytes each on disk. The end-to-end suite builds a 100k-span, 1M-log report to check the landing and a one-window filtered scan.
- Input files are read in pieces and parsed one resource entry (one element of `resourceSpans`, `resourceLogs` or `resourceMetrics`) at a time, so memory does not grow with file size. Converting 1M logs from 10 files peaks at about 320 MB of resident memory, against a design target of 512 MB. A single resource entry is still parsed whole, and a protobuf file is read whole before it is decoded, so peak memory still scales with the largest resource entry and with protobuf file size. If one OTLP JSON object repeats a signal key (two `resourceLogs`, say), both arrays are imported. The exception is `--replace` on a folder that already holds a report (a `--replace` conversion, or the first request into a replaced `serve` report): the old report is kept until the first input file or request has been read without error, so everything accepted from it (encoded chunks and metric buckets) stays in memory until its end. Convert a file that does not fit in memory into an empty folder, or empty the folder first.
- Metrics: `otel-html convert` turns 200 metrics × 1,000 series × 360 points (72M points, OTLP JSON) into a report with a peak of about 460 MB of resident memory. When a conversion or merge takes metric points, the CLI under Node switches V8 to `--optimize-for-size` as the first ones arrive, which costs about 40% in conversion time; trace and log conversions are not affected. `serve` and `run` set it at process start, together with `--heap-growing-percent=40`: with the first flag alone V8 runs a full garbage collection about every 0.4 s with pauses up to 200 ms, and a sender's batch queue overflows when the receiver stalls that long, so the second keeps pauses short (at most about 80 ms) at the same memory. The library sets no V8 flags, so the same workload fed to `Report.addMetrics` peaks at about 770 MB: V8 grows its heap to several times the live data (about 100 MB here) when allocation is this steady. The 512 MB writer target is defined on the CLI; the library figure is measured and reported beside it, not held to the target. Both come from `mise run test:load` (the `load` workflow runs it on ubuntu). To get the CLI's figure in your own process, start Node with `--optimize-for-size`, or call `v8.setFlagsFromString('--optimize-for-size')` before converting. Calling `flush()` more often (or lowering `writer.flushIntervalMs`) bounds what the writer holds between checkpoints but does not lower this peak, which is V8 heap slack rather than live data. Gauges and sums in OTLP JSON are read without building protobuf-es messages. Other metric types, and points that carry exemplars, are decoded through protobuf-es and allocate more per point. The 512 MB target is for that workload (cumulative counters and gauges). For every metric type the buckets the writer holds before writing them out are bounded by their estimated size (about 40 MB; a histogram bucket weighs as much as its bucket counts), but the state kept per series is not: each cumulative stream keeps its previous point, which for a histogram is its bucket counts (roughly half a kilobyte at 16 buckets), so memory grows with the number of cumulative histogram series. Series folded into `other` keep their streams for at most 10 × `writer.metricSeriesCap` series per metric.
- Receiver: `otel-html serve` takes 1M spans (OTLP/gRPC, paced at 4,000 spans/s) and 1M logs (OTLP/HTTP, one record per request) from telemetrygen into one complete report with nothing rejected, against a design target of 512 MB of resident memory. Measured on ubuntu-latest (4 cores, AMD EPYC 7763) on 2026-10-30: every span and log was written, 0 requests refused and 0 records rejected, with a peak of 417 MB of resident memory. The generator ran for 255 s (spans) and 209 s (logs). On the finished report the Traces and Logs landings were interactive in a median of 313 ms and 258 ms (Chromium). Checkpoints are written in the background while requests keep arriving, because a sender's batch span processor (2,048 spans by default) drops spans when the receiver stalls for about half a second. The load job also prints serve's event-loop delay (p99 and max) and GC pauses, so a red run shows why spans dropped. From `mise run test:load:receiver` (the `receiver` job of the `load` workflow).
- Metric values, counts and sums are 64-bit floating point once read, as in Prometheus: an integer point (`asInt`) or a count above 2^53 loses precision.
- The flame graph merges very narrow bars in traces above 2000 spans and clips anything deeper than 200 levels.

## Development

Tasks are defined in `mise.toml`; CI runs the same ones. The Linux binaries (`linux-x64`, `linux-arm64`) are built and smoke-tested on every PR by the `binary` job (`test/cli/binary.test.ts` against the compiled binary: `convert`, `serve` over HTTP and gRPC, `run`, a SIGINT exit 0 and a bad-port exit 2); the release workflow smoke-tests the artefacts it uploads. Tasks with `sources` are skipped while up to date; `mise run --force <task>` overrides.

### Test and viewer spans

The test suites trace themselves. Spans are exported only when an OTLP endpoint is configured (`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), for example by running under `otel-html run`, as CI's job shell does; `OTEL_SDK_DISABLED=true` turns it off. The protocol comes from `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` by default, `http/json` or `grpc`). Test spans carry `service.name` `otel-html-tests`, or `OTEL_HTML_TEST_SERVICE_NAME` when set; the inherited `OTEL_SERVICE_NAME` is ignored.

- **vitest:** its built-in (experimental) OpenTelemetry support, with vitest's own span names (`vitest.test_run`, `vitest.test.runner.run.suite`, `vitest.test.runner.run.test`, hooks, module imports), parented to `TRACEPARENT`, which mise sets per task.
- **Playwright:** one span per test (`test.case.name`, `test.case.result.status`, ...) under `TRACEPARENT`. The viewer's own spans (`viewer.load`, `viewer.chunk.load`, `viewer.query`, `viewer.navigate`, resource `service.name=otel-html-viewer`) are exported under each test's span, except for `@perf` tests, `scale.spec.ts`, `load.spec.ts` and the hostile-content report (`hostileTest`), and at most 2 000 per test.
- **The library's own spans:** under an endpoint, the spans the library emits through the global tracer (`otel-html.flush`, `otel-html.receive`, in `src/api/report.ts`) during unit tests are exported too, under vitest's spans.

The shipped viewer contains only the no-op `@opentelemetry/api`: a report sends nothing and records nothing unless a page registers a provider. A cached `mise run` task replays without running, so it emits no test spans; `--force` reruns it.

<!-- mise-tasks -->
## `bench:metrics`

Time the metrics writer on 2.4M points (200 metrics x 1,000 series x 12 collections) under bun
Goes through the library API and hashes the report it writes, so a change can show both its speed-up and that its
output is unchanged. `-- --runs 3` takes the median of three; `-- --keep` leaves the last report in a temp folder.
The reference figures are in https://github.com/bjstabi/otel-html/issues/35.


- **Usage:** `bench:metrics [args]…`

### Arguments
- **`[args]…`**

## `bootstrap`

- **Usage:** `bootstrap`

Set this machine up: dependencies, git hooks and the Playwright browsers (`mise bootstrap` runs this after the host packages)

## `build`

- Depends: build:viewer

- **Usage:** `build`

Build the library, then the viewer, into dist/

## `build:binaries`

Compile standalone binaries into dist/bin/ (after build); -- --target darwin-arm64 builds one


- **Usage:** `build:binaries [args]…`

### Arguments
- **`[args]…`**

## `build:lib`

- **Usage:** `build:lib`

Build the library and CLI into dist/ (skipped while up to date)

## `build:viewer`

- Depends: build:lib

- **Usage:** `build:viewer`

Build the viewer and the DuckDB engine files into dist/viewer (skipped while up to date)

## `check`

- Depends: lint, typecheck, test:unit:main, knip

- **Usage:** `check`

Fast gate: lint, typecheck, unit tests, knip
Results of lint, typecheck, knip and the parallel unit pass are cached by the content of their inputs, so a second run
with nothing changed skips them. The unit tests with a time budget (named @perf) always run afterwards, alone and one
file at a time; OTEL_HTML_PERF_FACTOR scales their budgets on a slow machine and, when OTEL_HTML_PERF_REFERENCE_MS is
set (CI sets 100), so does how much slower than that reference a fixed CPU workload runs here (never below 1; the perf
pass logs one `PERF calibration:` line).

## `check:package`

- Depends: build

- **Usage:** `check:package`

publint and are-the-types-wrong on the packed package

## `coverage`

- **Usage:** `coverage`

Unit coverage from the suite without @perf, per vitest project, into coverage/unit-&lt;project>/ (lcov, summary); never cached

## `demo`

- Depends: build

- **Usage:** `demo`

Open the small, linked-*, metrics and ci fixtures as one report in a browser (not for CI)
Converts them with fixtures/dashboards.otel-html.yaml (the Checkout and CI dashboards) and opens the report on the
Checkout dashboard. In code-server or over SSH it serves the report over HTTP instead (code-server's port proxy, or
localhost for VS Code's port forwarding; over plain SSH, forward the printed port), until Ctrl-C. Interactive only:
refuses to run in CI.

## `e2e:fixtures`

- Depends: build, e2e:otel-recorder

- **Usage:** `e2e:fixtures`

Build the e2e fixture reports into e2e/.reports/ (skipped while up to date; --force rebuilds)
All but `scale` and `huge`, which e2e:fixtures:scale builds; about a second after `build`.

## `e2e:fixtures:scale`

- Depends: e2e:fixtures:scale:data

- **Usage:** `e2e:fixtures:scale`

The e2e `scale` and `huge` reports with the current viewer (only e2e/scale.spec.ts reads them)
Depends on e2e:fixtures:scale:data; `otel-html upgrade` then swaps in the current dist/viewer (~0.3 s, every run: a
freshness record of its own could miss a viewer that :data wrote in between), so a viewer change never converts again.

## `e2e:fixtures:scale:data`

- Depends: build

- **Usage:** `e2e:fixtures:scale:data`

Convert the e2e `scale` and `huge` reports into e2e/.reports-scale/ (skipped while up to date)
100k spans, 1M logs and metrics, converted twice (~15 s, ~1 GB of memory). Its sources are the writer's build output,
not the viewer's: a viewer change only reruns e2e:fixtures:scale.

## `e2e:otel-recorder`

- **Usage:** `e2e:otel-recorder`

Bundle the e2e in-page span recorder into e2e/.cache/otel-recorder.js (skipped while up to date)

## `fixtures`

- **Usage:** `fixtures`

Regenerate fixtures/*.otlp.json with the OpenTelemetry SDK

## `format`

- **Usage:** `format`

Fix formatting with biome

## `gen`

- **Usage:** `gen`

protobuf-es, the config schema and the OTTL grammar; also rewrites the README's generated task section
`mise run --force gen` restores a hand-edited generated file (gen:check does this).

## `gen:check`

- **Usage:** `gen:check`

Regenerate with --force and fail if git sees a difference (never cached)

## `knip`

- **Usage:** `knip`

unused files, exports and dependencies

## `lint`

- **Usage:** `lint`

biome ci, actionlint, the task graph and the formatting of mise.toml

## `setup`

- **Usage:** `setup`

Install dependencies and git hooks

## `test:e2e`

Playwright over the fixture reports, per browser (--browser chromium|firefox|webkit, default all)
Two passes: the `<browser>-file` and `<browser>-http` projects in parallel (`-http` runs only specs tagged HTTP), then the
`<browser>-perf-file` project (@perf tests) alone with one worker. Only Chromium has `-http` and `-perf-file`, and
Firefox and WebKit leave out e2e/scale.spec.ts (playwright.config.ts). Both passes run; the task fails if either does.
The perf pass is skipped for a browser without a `-perf-file` project. The perf pass writes its artifacts to test-results/perf, so it does not clear the first pass's failures. Playwright args after `--` go to both passes (`mise run test:e2e --browser chromium -- e2e/scale.spec.ts`);
narrow the browsers with `--browser`, not `--project`, which would add to the two passes' own projects.
The scale reports (e2e:fixtures:scale, ~15 s cold, ~35 s on CI) are built only when the selection includes e2e/scale.spec.ts, decided
by `playwright test --list` with the same args; a direct `playwright test e2e/scale.spec.ts` needs that task run first.
Browsers are installed first unless OTEL_HTML_SKIP_BROWSER_INSTALL is set (CI's Playwright image has them).
The metrics scale check runs only with OTEL_HTML_METRICS_SCALE=1 (CI runs it in its own Chromium job): it writes a
report of 200 metrics x 1,000 series in which only the charted metric has the full 1 h at 10 s (a few seconds locally,
under a minute on CI; about 150 MB in e2e/.metrics-scale/), and fails if the Explorer or Catalog loads another metric's
points. The @perf budgets scale by OTEL_HTML_PERF_FACTOR and, when OTEL_HTML_PERF_REFERENCE_MS is set (CI: 100), by how
much slower than that reference a fixed CPU workload runs here (never below 1; the setup logs `PERF calibration: N ms`).
A run whose inputs match a cached success is replayed. `MISE_TASK_CACHE=off` re-runs the browsers, also through
`test:e2e:chromium`; `--force` reaches only the task it is given to, so it works on `test:e2e` and not on the wrapper.


- Depends: e2e:fixtures

- **Usage:** `test:e2e [--browser <browser>] [args]…`

### Arguments
- **`[args]…`**

### Flags
- **`--browser <browser>`**

  **Default:** `*`

## `test:e2e:chromium`

Chromium only: the quick loop while iterating (`test:e2e --browser chromium`). Playwright args after `--` (`mise run test:e2e:chromium -- e2e/metrics-explorer.spec.ts`) go to both passes.


- **Usage:** `test:e2e:chromium [args]…`

### Arguments
- **`[args]…`**

## `test:load`

- Depends: build

- **Usage:** `test:load`

The slow peak-memory tests: 1M logs; 200 metrics x 1,000 series x 360 points through the CLI and through Report.addMetrics
Runs after a build. Not part of `check` or CI's gate; the `load` workflow runs it on an ubuntu runner on demand, and daily
when main has changed since the last measurement.

## `test:load:receiver`

The receiver under load, after a build (Linux with Docker only)
telemetrygen (a pinned Docker image, on the host network) sends 1M spans over gRPC, paced at 500 spans/s per worker
(250 traces/s), and 1M logs over HTTP (one record per request) to `otel-html serve`; then the report must be complete
with every record, nothing rejected and a peak under 512 MB of resident memory. The report stays in `dist/load-receiver`.
`-- --spans 20000 --logs 100000` runs a small version. The `receiver` job of the `load` workflow runs it, then checks
the Traces and Logs landings with e2e/load.spec.ts.


- Depends: build

- **Usage:** `test:load:receiver [args]…`

### Arguments
- **`[args]…`**

## `test:unit`

- **Usage:** `test:unit`

Unit tests: the parallel pass, then the @perf pass

## `test:unit:changed`

Unit tests whose import graph reaches a file changed since `ref` (default main)


- **Usage:** `test:unit:changed [ref]`

### Arguments
- **`[ref]`**

  **Default:** `main`

## `test:unit:main`

- **Usage:** `test:unit:main`

vitest, everything but @perf, in parallel

## `test:unit:perf`

- **Usage:** `test:unit:perf`

The @perf unit tests alone, one file at a time (never cached: timing)

## `typecheck`

- **Usage:** `typecheck`

tsc on the node, viewer and e2e projects

## `verify`

- Depends: check

- **Usage:** `verify`

Before a push or a PR: check, then the Chromium e2e suite
<!-- /mise-tasks -->

## Roadmap

- M2 (done): Logs explorer, log patterns and log panel, with log and trace cross-linking.
- M3 (done): Metrics explorer and catalog, with embedded metric charts in all panels.
- M4 (done): Dashboards, including the built-in Fusion dashboard, and dashboard config.
- M5 (done): OTLP receiver (HTTP, then gRPC), `serve` and `run` commands, SDK exporters and load tests.

The design is in [`docs/superpowers/specs/2026-10-25-otel-html-design.md`](docs/superpowers/specs/2026-10-25-otel-html-design.md).

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
