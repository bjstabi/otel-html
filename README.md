# otel-html

otel-html turns OpenTelemetry data into a static, self-contained HTML report. You give it OTLP files (or feed it spans from your own code) and it writes a folder you can open from disk, attach to a CI run, or publish on any static host. No server and no network access are needed to view it.

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

Turns OTLP files into a report. Inputs can be OTLP JSON, JSON lines (such as Collector file-exporter output) or protobuf.

| Option | Meaning |
|---|---|
| `-o, --out <dir>` | Report folder. |
| `--config <file>` | Config file. Default: `$OTEL_HTML_CONFIG`, else `./otel-html.yaml`. |
| `--title <title>` | Report title. |
| `--append` | Require a report at `-o` and add to it (fails when there is none; useful in CI to catch a wrong path). |
| `--replace` | Start the report over. Without either flag, `-o` is appended to when it already holds a report written by the same otel-html version and created otherwise. |
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
| `--replace` | Start the report over. Without either flag, `-o` is appended to when it already holds a report written by the same otel-html version and created otherwise. |
| `--config <file>`, `--title <title>` | As for `convert`. |

Turning off both transports is a usage error (exit 2). A port that is already in use exits 1 with the system's `EADDRINUSE` message and a hint to pass `--http <port>` or `--grpc <port>`, or to turn that transport off (other bind errors get a hint for their cause: privileges for ports below 1024, `--host` for an address that is not this machine's).

On Ctrl-C (SIGINT) or SIGTERM, `serve` finishes the requests in progress, then stops listening (a request arriving meanwhile is answered 503 and retried by the client), completes the report and prints `wrote <out>: ...` and `received <N> requests (<K> refused); <M> records rejected`. A request is refused when it fails outright (it could not be decoded, has an unsupported content type or path, is too large (over gRPC, see Limits), or arrives while the receiver is busy); records are rejected when a request is otherwise accepted but an entry in it is dropped. When K is not zero, a second line breaks the refusals down, for example `refused: 3 invalid, 1 unsupported`, and a warning on stderr names the first refusal of each kind, so a misconfigured exporter shows up while `serve` runs. A second Ctrl-C while it finishes prints `interrupted; the report is at its last checkpoint` and exits 130; the report is then viewable and resumable from its last checkpoint but is not marked complete.

### `run`

Runs a command with its OpenTelemetry SDK pointed at a receiver, wraps the run in a root span, and writes the report when the command exits.

```sh
otel-html run -o ./report -- pytest -q
```

Everything before `--` is an `otel-html` flag: the `serve` flags (`-o`, `--host`, `--http`, `--no-http`, `--grpc`, `--no-grpc`, `--config`, `--title`, `--append`, `--replace`). `run` binds only the transport the command's protocol needs: OTLP/HTTP on 4318 by default, or OTLP/gRPC on 4317 when `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`; an explicit `--http <port>` or `--grpc <port>` binds that transport as well (a transport enabled only in the config file is not bound by `run`). A local collector on 4317 therefore does not get in the way. The receiver starts first, then the command runs with its stdio inherited and these variables added to its environment:

| Variable | Value |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The receiver's `http://host:port`, or the gRPC address when the protocol is `grpc`. Kept if you already set it (a warning is printed, and the command will not send to this receiver). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Your value if set to `grpc`, `http/protobuf` or `http/json`, else `http/protobuf`. Any other value is a usage error, as is a protocol whose receiver is turned off. |
| `TRACEPARENT` | `00-<trace id>-<root span id>-01`, always set to `run`'s own root span, so the command's own spans become its children (whatever `TRACEPARENT` `run` itself inherited). `TRACESTATE` passes through untouched. |

`--traceparent <value>` (default `$TRACEPARENT`) makes the root span a child of that W3C trace context, so a `run` inside a traced CI job joins the job's trace instead of starting its own. An empty `TRACEPARENT` counts as unset. A malformed value (uppercase hex, a version other than `00`, all-zero ids) is a usage error (exit 2) that names where it came from, `--traceparent` or `TRACEPARENT`.

The root span is named after the command's basename (`.exe` stripped), has kind `INTERNAL`, and runs from spawn to exit. Its attributes are `process.command_args` (the full command line), `process.executable.name`, `process.pid` and, when the command exited, `process.exit.code`. A non-zero exit sets the status to `ERROR` with `exit code N`; a command killed by a signal sets `ERROR` with `killed by SIGTERM` (for example) and has no exit code; a zero exit leaves the status unset. The resource comes from the OpenTelemetry environment (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`), host and process detectors, and `service.name` defaults to the command's basename. The `process.*` resource attributes from the process detector describe `otel-html` itself, not the command.

`run` exits with the command's exit code, or `128` plus the signal number when the command was killed (143 for SIGTERM; signal numbers are Linux's, and a signal outside the table counts as 128). If the command succeeded but the report could not be finished, it exits 1 and prints the error; if the command failed too, it exits with the command's code and still prints the error. An empty command is a usage error (exit 2). A command that cannot be started (not found, not executable) exits 1 with the system's message, and no report is kept. SIGINT and SIGTERM sent to `run` are forwarded to the command, and `run` keeps waiting for it (in a terminal, Ctrl-C also reaches the command directly from the tty, so it sees the signal twice); a signal while the report is finishing exits 130, as for `serve`.

`run` does not wait after the command exits: the receiver stops accepting, drains the requests in progress and closes the report. An SDK that has not flushed by then loses its tail, so make sure the command shuts its SDK down before it exits. On Windows the executable must be a real binary or a script `run` can start directly; no shell is involved, so a `.cmd` file needs `cmd /c` in front of it.

### `merge <reports...>`

Combines report folders into one, for example the reports of parallel CI jobs. It reads each report's data chunks, so it works across otel-html versions (see [Report format compatibility](#report-format-compatibility)). A cumulative metric series that appears in two reports is two runs: the second report's stream starts from its own start time and is not counted as a counter reset.

```sh
otel-html merge ./job-1 ./job-2 -o ./combined
```

Options: `-o, --out <dir>`, `--config <file>`, `--append` and `--replace` (as for `convert`). When `-o` already holds a report, `merge` adds its inputs to it.

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

Options: `--config <file>` and `--title <title>`.

## Library API

The package exports `convert`, `merge`, `Report` and `OtelHtmlError`, plus types (`ConfigInput`, `ConvertOptions`, `MergeOptions`, `ReportOptions`, `ReportSummary`, `AddResult` and others).

`Report.create`, `convert` and `merge` append when `out` already holds a report written by the same otel-html version; `replace: true` starts over, `append: true` requires the report to be there. A report from another version fails with a message naming `--replace` and `merge`.

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

`startReceiver(report, overrides?, deps?)` binds the OTLP/HTTP and OTLP/gRPC receivers over a report, the same receivers `serve` uses. `overrides` takes `http` and `grpc` (each `false` to disable, or `{ host?, port? }` to enable; port `0` picks a free one), plus `maxBodyBytes` and `inflightBudgetBytes`; anything left out comes from the report's `receiver.*` config. `deps` defaults to the deps the report was created with, with any you pass merged on top. It returns `{ http, grpc, stats(), close() }`. `close()` stops listening and finishes requests in progress; the report stays open, so the caller closes it.

```ts
import { Report, startReceiver } from 'otel-html';

const report = await Report.create({ out: './report-d' });
const receiver = await startReceiver(report, { http: { port: 0 }, grpc: false });
console.log(receiver.http); // http://127.0.0.1:<port>
// ... point exporters at it ...
await receiver.close();
await report.close();
```

`Report` also has `addLogs`, `addMetrics` (an SDK `ResourceMetrics`, or OTLP request objects, JSON or protobuf-es messages) and `flush()`. Interval checkpoints (every `writer.flushIntervalMs`, and after that long idle) are written in the background, so after `add*` resolves the report on disk may lag; `flush()` (or `close()`) is the only point at which the report on disk is known to be current. Crash safety does not depend on it: a report is always readable at its last checkpoint. `addMetrics` reads an OTLP JSON object in place rather than copying it: leave it unchanged until the returned promise settles (`addSpans` and `addLogs` copy). `addSpans` accepts SDK `ReadableSpan` arrays, OTLP trace requests, or OTLP JSON objects. `config` takes an object or the path of a YAML/JSON file. Environment variables are not read by the library.

## Viewing logs

Open a report and choose Logs in the sidebar (or press `g l`). The Logs explorer is built like the Traces explorer: a query bar, a severity histogram, facets on the left and results on the right. Everything you set lives in the URL, so a link reproduces the view.

- **Filters.** Type free text or an OTTL condition over the log record (for example `log.severity_number >= SEVERITY_NUMBER_WARN`), or use the facets: Severity, Service, `host.name`, Scope, `event.name`, Has trace, and any attribute. Severity rows offer Only and "And above". Brushing the histogram sets the time window.
- **Group into.** Logs lists records. Patterns groups them by message template. Traces groups them by trace, so you can see which traces are noisy. Group by and the chart views (time series, top list, bar, table, treemap, pie and a severity scatter) work as in the Traces explorer.
- **Patterns.** The writer clusters every log message with an in-house Drain implementation (numbers, IDs and similar tokens are masked into placeholders) and stores the clusters in `data/rollups/logs.js`. The unfiltered Patterns view is therefore exact. With a filter or free text, the viewer runs the same clustering over the matching logs. Choosing a pattern adds a filter token that matches its template with `IsMatch(log.body.string, ...)`, which stays editable in the query bar.
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

The grid has 12 columns. A widget is `timeline`, `traces`, `logs`, `metric`, `toplist` or `table`; `toplist` and `table` take `signal` (`spans` or `logs`) and `groupBy`. A `metric` widget without `queries` is a grid of the metrics of the selected trace's resources. [`fixtures/dashboards.otel-html.yaml`](fixtures/dashboards.otel-html.yaml) has one widget of each type.

## Report layout and hosting

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

- Local disk: open `index.html` directly (`file://`).
- GitHub Pages and GitLab Pages: publish the folder as it is. It works under a subpath such as `https://user.github.io/repo/report/`.
- Any other static host or subpath works the same way.
- CI: upload the folder as a build artifact.

The report is exercised from both `file://` and a static server in Chromium, Firefox and WebKit by the end-to-end tests.

### This repo's CI

This repo's CI reports on itself with `otel-html`. Every job in [ci.yml](.github/workflows/ci.yml) builds the CLI first, then uses it as the job's shell, so each `run:` step is a traced command:

```yaml
shell: node dist/cli/main.js run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}
```

The `otel-html ci context` step ([src/cli/ci/context-main.ts](src/cli/ci/context-main.ts)) looks the job up in the Actions API and sets `TRACEPARENT` and the resource attributes for later steps. The trace id is derived from the run, and the span ids from the run and job, so the job reports nest under the run → job spans without the jobs talking to each other. If the job lookup fails, the job id falls back to a hash of its name (with a warning); matrix legs share a name, so set `OTEL_HTML_JOB_NAME` to give each its own. Each job uploads its `.otel-html/` folder as an `otel-html-*` artifact.

When the `ci` workflow completes, [ci-report.yml](.github/workflows/ci-report.yml) runs `otel-html ci report` ([src/cli/ci/report-main.ts](src/cli/ci/report-main.ts)) from `main`'s code, never the run's own, since the run may come from a fork. It writes the run → job spans from the Actions API, turns each job's log into log records, adds queue-time and duration metrics, and merges these with the job artifacts into one report, uploaded as `ci-run-report`. Run it by hand with `workflow_dispatch` and a `run_id` to rebuild a past run. The report opens on the [CI dashboard](.github/actions/otel-html-publish/otel-html-ci.yaml): job duration, queue time, step counts, runs, and warnings and errors, with `run` and `job` variables. The run-level span lives on the run's own resource, so selecting a job in `job` hides it. The run key includes the run attempt, so after a partial re-run the artifacts of jobs that did not re-run (still attempt 1) show up as separate traces without a job span.

The run's report is then published to the site at <https://bjstabi.github.io/otel-html/>. The layout is:

- `/index.html` (landing page) and `/index.json` (site index).
- `/<workflow>/` and `/<workflow>/runs/<run_id>/` for pushes to the default branch of this repo, for example `/ci/`.
- `/pr/<number>/` and `/pr/<number>/runs/<run_id>/` for any other run whose commit or branch belongs to an open pull request (the pull request may have been pushed to since). A default-branch run always goes to its workflow's folder, even when an open pull request's head is, or contains, its commit.

`/pr/<number>/` is a stub that forwards to the pull request's newest run. A run on any other branch, or a push from a fork, with no open pull request is not published. The site keeps the last 30 runs per workflow and the last 5 per pull request; a re-run replaces its folder. When a pull request closes, `pull_request_target` triggers the `cleanup` job, which removes its folder.

`/ci/` and `/load/` are rolling reports: after each publish the publisher merges the channel's retained `runs/<run_id>/` reports, oldest first, into one report and replaces everything in the folder except `runs/`. Runs inside it are told apart by trace id (one per run attempt, so a re-run is its own trace) and by the `cicd.pipeline.run.id` resource attribute, which the dashboard's `run` variable selects. Retention bounds it: a run older than the newest 30 drops out of the channel, and the next rebuild leaves it out. A per-run report whose format this version of otel-html no longer reads is skipped with a warning; its run stays listed and the rest still merge, until retention removes it. If the merge fails for any other reason, the channel warns and falls back to a stub forwarding to the newest run. A `load` run whose jobs were skipped has no job reports and publishes nothing.

The `gh-pages` branch is the store: one orphan commit holding the whole site, replaced on every publish rather than grown, so history does not accumulate every run's data. [site-branch.sh](.github/actions/otel-html-publish/site-branch.sh) checks out the tip and pushes the new commit with `--force-with-lease` against it. A rejected lease (another publish or a cleanup got there first) checks out again, re-applies and retries, up to 5 attempts, so a cleaned-up pull request is never brought back. The `report` job in [ci-report.yml](.github/workflows/ci-report.yml) runs the [otel-html-publish](.github/actions/otel-html-publish/action.yml) action with `deploy: false`, which builds the report, publishes it and links it. The `deploy` job ships the `gh-pages` tip under the concurrency group `pages`, so a pending deploy replaced by a newer one loses nothing: the one that runs ships the latest tip. It runs only from the default branch, so a `workflow_dispatch` on another branch updates `gh-pages` and skips the deploy; the next default-branch deploy ships it.

`otel-html ci link` posts one sticky comment per workflow on the open pull requests of a pull request run (found by a per-workflow marker, so `ci` and `load` do not overwrite each other; a default-branch run comments on none) and creates a check run named `otel-html report` that concludes `neutral`: it is a link, not a second verdict on the run.

These subcommands are for the actions; stable flags, output format not guaranteed.

| Subcommand | What it does | Flags |
| --- | --- | --- |
| `ci report` | Builds a run's report from the Actions API (with `$GITHUB_TOKEN` from the environment) and merges it with the downloaded job artifacts. Writes the summary table to the job summary, and `published=false` to `$GITHUB_OUTPUT` when the run has no job reports. | `--run-id`, `--repository`, `--artifacts`, `--out` (all required); `--config`; `--no-summary` (the action passes it on `github-pages`, where `ci link` writes the summary with the report's link) |
| `ci site` | Places a run's report in the checked-out site folder, applies retention, rewrites the indexes and stubs. Writes `published` and `report-url` to `$GITHUB_OUTPUT`. | `--site`, `--report`, `--run-id`, `--repository`, `--base-url` (all required); `--retention` (30), `--pr-retention` (5) |
| `ci link` | Comments on the pull requests, creates the check run and writes the job summary. Never fails the job. | `--run-id`, `--repository`, `--url`, `--site` (all required); `--no-comment`, `--no-check` |
| `ci cleanup` | Removes a closed pull request's reports from the site folder. Writes `cleaned=true` to `$GITHUB_OUTPUT`, or `cleaned=false` and changes nothing when the site never had the pull request. | `--site`, `--pr` (required); `--repository` (default `$GITHUB_REPOSITORY`) |

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

Setup inputs: `version` (a release such as `0.2.0`, default `latest`), `command` (an executable instead of a download), `job-name` (matrix legs share a name, so give each its own) and `token`. Collect inputs: `name` (default `otel-html-<job>`; matrix legs need one each, or one leg's upload replaces another's) and `path` (default `.otel-html/`).

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

Pages setup: Settings, Pages, Source: GitHub Actions (`build_type: workflow`), and the `github-pages` environment's deployment branches must allow the default branch.

A private repository's Pages site is public unless the organization has Pages access control (GitHub Enterprise Cloud). The reports carry the CI logs, job names and pull request titles, so publishing them makes those public; the action warns when it publishes from a private repository. Use `target: artifact` to keep the reports in the run's artifacts instead.

Publish inputs:

| Input | Default | |
| --- | --- | --- |
| `run-id` | the `workflow_run`'s run, else this run | The run to report on. |
| `version`, `command` | `latest`, empty | As for setup. |
| `config` | the action's own `otel-html-ci.yaml` | The dashboard config for the reports. |
| `target` | `github-pages` | `artifact` uploads the run report as the `ci-run-report` artifact only: nothing reaches the site and nothing is linked. |
| `retention`, `pr-retention` | 30, 5 | Runs kept per workflow channel and per pull request. |
| `comment`, `check` | true | The sticky PR comment and the `otel-html report` check run. |
| `deploy` | true | Deploy to Pages in this job; needs `environment: github-pages` and `pages: write` and `id-token: write`. `false` leaves it to a separate `deploy` job as above. |
| `cleanup-pr` | empty | A pull request number: skip the report and remove that PR's reports from the site. |
| `token` | `github.token` | Needs `actions: read`, `contents: write`, `pages: read`, `pull-requests: write`, `checks: write`. |

Outputs: `report-url` (empty when nothing was published), `published` and `cleaned`. A cleanup sets `published=false`, and `cleaned=true` only when the site had that pull request; for one it never had, nothing is pushed or deployed and `cleaned=false`.

GitHub points a check run created with `GITHUB_TOKEN` at the Actions run page, so the report URL is in the check's summary and in the PR comment.

Final-job mode: for a repository with no separate publisher, put the action in the last job of the same workflow (`needs:` every other job, `if: always()`), with `deploy: true`, `environment: github-pages` and the write permissions above. That job's own timings are incomplete in the report, and a fork PR's token cannot push, so prefer the `workflow_run` publisher.

### Report format compatibility

`data/` is the model; `assets/` and `index.html` are the viewer. The manifest's `formatVersion` (now 3) is bumped only for a change an older reader cannot read. This otel-html reads formats 1 to 3 (see [`src/format/version.ts`](src/format/version.ts)), and a reader fails fast on a version it does not know.

- `merge` re-renders any readable report with the current viewer, so reports from different otel-html versions combine into one report in the current format.
- `--append` needs the same otel-html version as the report it appends to.
- A new viewer must read every version in `READABLE_FORMAT_VERSIONS`. Frozen format-1 and format-2 reports in `fixtures/reports/` are merged, and opened by the viewer's data layer, by the tests to hold that.
- Maintainers: bumping `FORMAT_VERSION` adds a frozen report of the outgoing version to `fixtures/reports/` with its compat test, and a version leaves `READABLE_FORMAT_VERSIONS` only together with its fixture.

## Configuration

Config is a YAML or JSON file (`otel-html.yaml` by default), or an object passed to the API. Precedence, lowest to highest: defaults, config file, environment variables, CLI flags or API arguments. Unknown keys are rejected. The JSON Schema for editor autocomplete is [`schema/otel-html.schema.json`](schema/otel-html.schema.json).

| Key | Default | Meaning |
|---|---|---|
| `title` | none | Report title. Env: `OTEL_HTML_TITLE`. |
| `writer.chunkTargetBytes` | 4000000 | Target size of a data chunk. |
| `writer.flushIntervalMs` | 5000 | Checkpoint interval. Also checkpoints once after this long idle with new records. |
| `writer.dedupeCapacity` | 200000 | Recent span IDs remembered for de-duplication. |
| `writer.facetValueCap` | 1000 | Distinct values kept per facet key. |
| `writer.facetKeyCap` | 500 | Facet keys kept. |
| `writer.metricSeriesCap` | 1000 | Series kept per metric. Further series fold into one "other" series, and charts that would need to split it say they are partial. |
| `writer.metricExemplars` | 4 | Exemplars kept per series per finest time bucket (those with a trace id first, then the most extreme values). |
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
| `dashboards` | `[]` | Dashboards: `{ id, title, description?, variables?, widgets }`. `variables` are resource attribute keys, or `{ key, label?, default? }`. Each widget has `type`, `x`, `y`, `w`, `h` on a 12-column grid, plus `id?`, `title?` and `follow?`, and the fields of its type. An `echarts` object on a `metric` or `toplist` widget is merged over the chart option otel-html builds. **It is unstable:** it is passed to ECharts as is, so its compatibility is ECharts', not otel-html's. Treat it as code: ECharts renders string templates such as `tooltip.formatter` as HTML, and the names they fill in come from the telemetry. Ids are lowercase letters, digits and dashes; `fusion` is reserved. Checked when the config loads, with errors at their path (`dashboards[0].widgets[2].query`). A config without `dashboards` keeps the ones of the report it is written into. With `merge`, the dashboards of `--config` win; without them the first report's are kept. |
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
- When a signal is larger than `viewer.eagerBudgetBytes`, the viewer reads its chunks on demand. Services numbers, filtered log results and filtered patterns are then partial (the viewer says "from N of M chunks") until you choose "Scan entire run". Opening a trace or its Logs tab reads only the chunks the trace index lists for it.
- Dashboard layout edits are not saved: Edit layout changes the page until you reload. Use Copy config and paste the result into your config file.
- The Fusion timeline's metric lane comes from the run-wide rollup, so it ignores variables and says "all resources" when one is set.
- Log pattern clustering stops creating clusters at 2,000. A message that fits no existing cluster after that stays unclustered, and the Patterns view reports how many.
- The design target for logs is 1,000,000 records in about 200 bytes each on disk. The end-to-end suite builds a 100k-span, 1M-log report to check the landing and a one-window filtered scan.
- Input files are read in pieces and parsed one resource entry (one element of `resourceSpans`, `resourceLogs` or `resourceMetrics`) at a time, so memory does not grow with file size. Converting 1M logs from 10 files peaks at about 320 MB of resident memory, against a design target of 512 MB. A single resource entry is still parsed whole, and a protobuf file is read whole before it is decoded, so peak memory still scales with the largest resource entry and with protobuf file size. If one OTLP JSON object repeats a signal key (two `resourceLogs`, say), both arrays are imported.
- Metrics: `otel-html convert` turns 200 metrics × 1,000 series × 360 points (72M points, OTLP JSON) into a report with a peak of about 460 MB of resident memory. When a conversion or merge takes metric points, the CLI under Node switches V8 to `--optimize-for-size` as the first ones arrive, which costs about 40% in conversion time; trace and log conversions are not affected. `serve` and `run` set it at process start, together with `--heap-growing-percent=40`: with the first flag alone V8 runs a full garbage collection about every 0.4 s with pauses up to 200 ms, and a sender's batch queue overflows when the receiver stalls that long, so the second keeps pauses short (at most about 80 ms) at the same memory. The library sets no V8 flags, so the same workload fed to `Report.addMetrics` peaks at about 770 MB: V8 grows its heap to several times the live data (about 100 MB here) when allocation is this steady. The 512 MB writer target is defined on the CLI; the library figure is measured and reported beside it, not held to the target. Both come from `mise run test:load` (the `load` workflow runs it on ubuntu). To get the CLI's figure in your own process, start Node with `--optimize-for-size`, or call `v8.setFlagsFromString('--optimize-for-size')` before converting. Calling `flush()` more often (or lowering `writer.flushIntervalMs`) bounds what the writer holds between checkpoints but does not lower this peak, which is V8 heap slack rather than live data. Gauges and sums in OTLP JSON are read without building protobuf-es messages. Other metric types, and points that carry exemplars, are decoded through protobuf-es and allocate more per point. The 512 MB target is for that workload (cumulative counters and gauges). For every metric type the buckets the writer holds before writing them out are bounded by their estimated size (about 40 MB; a histogram bucket weighs as much as its bucket counts), but the state kept per series is not: each cumulative stream keeps its previous point, which for a histogram is its bucket counts (roughly half a kilobyte at 16 buckets), so memory grows with the number of cumulative histogram series. Series folded into `other` keep their streams for at most 10 × `writer.metricSeriesCap` series per metric.
- Receiver: `otel-html serve` takes 1M spans (OTLP/gRPC, paced at 4,000 spans/s) and 1M logs (OTLP/HTTP, one record per request) from telemetrygen into one complete report with nothing rejected, against a design target of 512 MB of resident memory. Measured on ubuntu-latest (4 cores, AMD EPYC 7763) on 2026-10-30: every span and log was written, 0 requests refused and 0 records rejected, with a peak of 417 MB of resident memory. The generator ran for 255 s (spans) and 209 s (logs). On the finished report the Traces and Logs landings were interactive in a median of 313 ms and 258 ms (Chromium). Checkpoints are written in the background while requests keep arriving, because a sender's batch span processor (2,048 spans by default) drops spans when the receiver stalls for about half a second. The load job also prints serve's event-loop delay (p99 and max) and GC pauses, so a red run shows why spans dropped. From `mise run test:load:receiver` (the `receiver` job of the `load` workflow).
- Metric values, counts and sums are 64-bit floating point once read, as in Prometheus: an integer point (`asInt`) or a count above 2^53 loses precision.
- The flame graph merges very narrow bars in traces above 2000 spans and clips anything deeper than 200 levels.

## Development

Tasks are defined in `mise.toml`; CI runs the same ones. The Linux binaries (`linux-x64`, `linux-arm64`) are built and smoke-tested on every PR by the `binary` job (`test/cli/binary.test.ts` against the compiled binary: `convert`, `serve` over HTTP and gRPC, `run`, a SIGINT exit 0 and a bad-port exit 2); the release workflow smoke-tests the artefacts it uploads.

| Task | Does |
|---|---|
| `mise run setup` | Install dependencies and git hooks. |
| `mise run check` | Fast gate: lint, typecheck, unit tests, knip. Unit tests with a time budget (named `@perf`) run afterwards, alone and one file at a time; `OTEL_HTML_PERF_FACTOR` scales their budgets on a slow machine, and, when `OTEL_HTML_PERF_REFERENCE_MS` is set (CI sets 100), so does how much slower than that reference a fixed CPU workload runs here (never below 1; the perf pass logs one `PERF calibration:` line). |
| `mise run build` | Build the library, then the viewer, into `dist/`. |
| `mise run test:load` | The slow peak-memory tests (1M logs; 200 metrics × 1,000 series × 360 points through the CLI and through `Report.addMetrics`), after a build. Not part of `check` or `ci`; the `load` workflow runs them on an ubuntu runner on demand, and daily when `main` has changed since the last measurement. |
| `mise run test:load:receiver` | The receiver under load, after a build: telemetrygen (a pinned Docker image, on the host network, so Linux only) sends 1M spans over gRPC, paced at 500 spans/s per worker (250 traces/s) so telemetrygen does not drop them, and 1M logs over HTTP (one record per request) to `otel-html serve`, then the report must be complete with every record, nothing rejected and a peak under 512 MB of resident memory. The report stays in `dist/load-receiver`; `-- --spans 20000 --logs 100000` runs a small version. The `receiver` job of the `load` workflow runs it, then checks the Traces and Logs landings with `e2e/load.spec.ts`. |
| `mise run test:e2e` | Build, then run the Playwright suite in Chromium, Firefox and WebKit. Extra arguments go to Playwright (`mise run test:e2e -- e2e/merge.spec.ts`). The metrics scale check runs only with `OTEL_HTML_METRICS_SCALE=1` (CI runs it in its own Chromium job): it writes a report of 200 metrics × 1,000 series in which only the charted metric has the full 1 h at 10 s (a few seconds locally and under a minute on CI; about 150 MB, in `e2e/.reports/`), and fails if the Explorer or Catalog loads another metric's points. The `@perf` budgets scale by `OTEL_HTML_PERF_FACTOR` and, when `OTEL_HTML_PERF_REFERENCE_MS` is set, by how much slower than that reference a fixed CPU workload runs on this machine (never below 1; the setup logs `PERF calibration: N ms`). CI sets the reference to 100 ms. |
| `mise run build:binaries` | Compile standalone binaries into `dist/bin/` (after `build`). |
| `mise run fixtures` | Regenerate `fixtures/*.otlp.json` with the OpenTelemetry SDK. |
| `mise run bench:metrics` | Time the metrics writer on 2.4M points (200 metrics × 1,000 series × 12 collections) through the library API under bun, and hash the report it writes. `-- --runs 3` takes the median of three; `-- --keep` leaves the last report in a temp folder. The reference figures are in [#35](https://github.com/bjstabi/otel-html/issues/35). |
| `mise run demo` | Convert the `small`, `linked-*` and `metrics` fixtures (traces, logs and metrics) with `fixtures/dashboards.otel-html.yaml` and open the report in a browser, on the Checkout dashboard. Not for CI. |

Other tasks: `lint`, `format`, `typecheck`, `test:unit`, `knip`, `gen`, `gen:check`, `check:package`, `test:e2e:chromium`.

## Roadmap

- M2 (done): Logs explorer, log patterns and log panel, with log and trace cross-linking.
- M3 (done): Metrics explorer and catalog, with embedded metric charts in all panels.
- M4 (done): Dashboards, including the built-in Fusion dashboard, and dashboard config.
- M5 (done): OTLP receiver (HTTP, then gRPC), `serve` and `run` commands, SDK exporters and load tests.

The design is in [`docs/superpowers/specs/2026-10-25-otel-html-design.md`](docs/superpowers/specs/2026-10-25-otel-html-design.md).

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
