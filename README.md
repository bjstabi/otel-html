# otel-html

otel-html turns OpenTelemetry data into a static, self-contained HTML report. You give it OTLP files (or feed it spans from your own code) and it writes a folder you can open from disk, attach to a CI run, or publish on any static host. No server and no network access are needed to view it.

Milestone 1 covers traces: a Traces explorer with a trace panel (flame graph, waterfall, span list, services, span details). Milestone 2 adds logs: a Logs explorer with log patterns and a log panel, linked to traces both ways. Milestone 3 adds metrics: a Metrics explorer with exemplars, a metrics catalog, and metric charts in the log, span and trace panels. Milestone 4 adds dashboards: the built-in Fusion dashboard, which puts every signal on one timeline, and dashboards you define in config.

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
| `--append` | Add to an existing report instead of replacing it. Only works with a report written by the same otel-html version. |
| `--signal <signal>` | `traces`, `logs` or `metrics`. Needed for protobuf (`.pb`) inputs, which do not say what they hold. |

### `merge <reports...>`

Combines report folders into a new one, for example the reports of parallel CI jobs. It reads each report's data chunks, so it works across otel-html versions that share the report format version. A cumulative metric series that appears in two reports is two runs: the second report's stream starts from its own start time and is not counted as a counter reset.

```sh
otel-html merge ./job-1 ./job-2 -o ./combined
```

Options: `-o, --out <dir>` and `--config <file>`.

### `config print`

Prints the resolved configuration and where each value came from (default, file, environment or flag).

```sh
otel-html config print --config otel-html.yaml
```

Options: `--config <file>` and `--title <title>`.

## Library API

The package exports `convert`, `merge`, `Report` and `OtelHtmlError`, plus types (`ConfigInput`, `ConvertOptions`, `MergeOptions`, `ReportOptions`, `ReportSummary`, `AddResult` and others).

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

`Report` also has `addLogs`, `addMetrics` (OTLP request objects, JSON or protobuf-es messages) and `flush()`. `addSpans` accepts SDK `ReadableSpan` arrays, OTLP trace requests, or OTLP JSON objects. `config` takes an object or the path of a YAML/JSON file. Environment variables are not read by the library.

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
    metrics/            per metric (<id6>/): series.js, l<k>.js resolution levels and ex.js exemplars,
                        or seg-<n6>.js segments until the writer closes
    traces/             trace index shards (<xx>.js)
    state/              writer checkpoint (session.<n>.json)
```

Every data file is a classic script that registers its payload with a global, so the report works without `fetch`, ES modules or workers. All paths are relative and navigation uses the URL hash.

- Local disk: open `index.html` directly (`file://`).
- GitHub Pages and GitLab Pages: publish the folder as it is. It works under a subpath such as `https://user.github.io/repo/report/`.
- Any other static host or subpath works the same way.
- CI: upload the folder as a build artifact.

The report is exercised from both `file://` and a static server in Chromium, Firefox and WebKit by the end-to-end tests.

## Configuration

Config is a YAML or JSON file (`otel-html.yaml` by default), or an object passed to the API. Precedence, lowest to highest: defaults, config file, environment variables, CLI flags or API arguments. Unknown keys are rejected. The JSON Schema for editor autocomplete is [`schema/otel-html.schema.json`](schema/otel-html.schema.json).

| Key | Default | Meaning |
|---|---|---|
| `title` | none | Report title. Env: `OTEL_HTML_TITLE`. |
| `writer.chunkTargetBytes` | 4000000 | Target size of a data chunk. |
| `writer.flushIntervalMs` | 5000 | Checkpoint interval. |
| `writer.dedupeCapacity` | 200000 | Recent span IDs remembered for de-duplication. |
| `writer.facetValueCap` | 1000 | Distinct values kept per facet key. |
| `writer.facetKeyCap` | 500 | Facet keys kept. |
| `writer.metricSeriesCap` | 1000 | Series kept per metric. Further series fold into one "other" series, and charts that would need to split it say they are partial. |
| `writer.metricExemplars` | 4 | Exemplars kept per series per finest time bucket (those with a trace id first, then the most extreme values). |
| `writer.drop.traces.span` | `[]` | OTTL conditions; matching spans are dropped at write time. |
| `writer.drop.logs.log_record` | `[]` | Same, for log records. |
| `writer.drop.metrics.datapoint` | `[]` | Same, for metric data points. |
| `viewer.eagerBudgetBytes` | 75000000 | Decoded size under which the viewer loads everything up front. Applies to each signal on its own: the viewer estimates the decoded size of the spans and of the logs separately, so a report can have eager spans and windowed logs. Env: `OTEL_HTML_EAGER_BUDGET_BYTES`. |
| `viewer.listCap` | 10000 | Maximum rows in result lists. |
| `viewer.defaultDashboard` | `fusion` | The dashboard `g d` and the sidebar's ★ item open. Must be `fusion` or the id of a dashboard in `dashboards`. |
| `viewer.home` | `traces` | Where the report opens: `traces`, `logs`, `metrics` or `dashboards` (the default dashboard). |
| `viewer.theme` | `system` | `system`, `light` or `dark`. The theme a report opens in; a theme the viewer picks themselves is remembered and wins. |
| `dashboards` | `[]` | Dashboards: `{ id, title, description?, variables?, widgets }`. `variables` are resource attribute keys, or `{ key, label?, default? }`. Each widget has `type`, `x`, `y`, `w`, `h` on a 12-column grid, plus `id?`, `title?` and `follow?`, and the fields of its type. An `echarts` object on a `metric` or `toplist` widget is merged over the chart option otel-html builds. **It is unstable:** it is passed to ECharts as is, so its compatibility is ECharts', not otel-html's. Ids are lowercase letters, digits and dashes; `fusion` is reserved. Checked when the config loads, with errors at their path (`dashboards[0].widgets[2].query`). A config without `dashboards` keeps the ones of the report it is appended to. With `merge`, the dashboards of `--config` win; without them the first report's are kept. |
| `views` | `[]` | Saved views for the explorers' Views menu: `{ id, title, page, query?, text?, mode?, groupBy?, view?, sort?, metrics? }`, where `page` is `traces`, `logs` or `metrics`. |

`OTEL_HTML_CONFIG` selects the config file. `OTEL_HTML_DEBUG=1` makes the CLI print stack traces on errors.

## Limits

- Timestamps are JavaScript numbers, exact to 2^53 ns. That is about 104 days of relative time span within one report.
- The viewer is for static reports that open from `file://`. It does not follow a report that is still being written.
- When a signal is larger than `viewer.eagerBudgetBytes`, the viewer reads its chunks on demand. Services numbers, filtered log results and filtered patterns are then partial (the viewer says "from N of M chunks") until you choose "Scan entire run". Opening a trace or its Logs tab reads only the chunks the trace index lists for it.
- Dashboard layout edits are not saved: Edit layout changes the page until you reload. Use Copy config and paste the result into your config file.
- The Fusion timeline's metric lane comes from the run-wide rollup, so it ignores variables and says "all resources" when one is set.
- Log pattern clustering stops creating clusters at 2,000. A message that fits no existing cluster after that stays unclustered, and the Patterns view reports how many.
- The design target for logs is 1,000,000 records in about 200 bytes each on disk. The end-to-end suite builds a 100k-span, 1M-log report to check the landing and a one-window filtered scan.
- Input files are read in pieces and parsed one resource entry (one element of `resourceSpans`, `resourceLogs` or `resourceMetrics`) at a time, so memory does not grow with file size. Converting 1M logs from 10 files peaks at about 320 MB of resident memory, against a design target of 512 MB. A single resource entry is still parsed whole, and a protobuf file is read whole before it is decoded, so peak memory still scales with the largest resource entry and with protobuf file size. If one OTLP JSON object repeats a signal key (two `resourceLogs`, say), both arrays are imported.
- Metrics: `otel-html convert` turns 200 metrics × 1,000 series × 360 points (72M points, OTLP JSON) into a report with a peak of about 450 MB of resident memory. When a conversion or merge takes metric points, the CLI under Node switches V8 to `--optimize-for-size` as the first ones arrive, which costs about 40% in conversion time; trace and log conversions are not affected. The library sets no V8 flags, so the same workload fed to `Report.addMetrics` peaks at about 770 MB: V8 grows its heap to several times the live data (about 100 MB here) when allocation is this steady. To get the CLI's figure in your own process, start Node with `--optimize-for-size`, or call `v8.setFlagsFromString('--optimize-for-size')` before converting. Gauges and sums in OTLP JSON are read without building protobuf-es messages. Other metric types, and points that carry exemplars, are decoded through protobuf-es and allocate more per point. The 512 MB target is for that workload (cumulative counters and gauges). For every metric type the buckets the writer holds before writing them out are bounded by their estimated size (about 40 MB; a histogram bucket weighs as much as its bucket counts), but the state kept per series is not: each cumulative stream keeps its previous point, which for a histogram is its bucket counts (roughly half a kilobyte at 16 buckets), so memory grows with the number of cumulative histogram series. Series folded into `other` keep their streams for at most 10 × `writer.metricSeriesCap` series per metric.
- The flame graph merges very narrow bars in traces above 2000 spans and clips anything deeper than 200 levels.

## Development

Tasks are defined in `mise.toml`; CI runs the same ones.

| Task | Does |
|---|---|
| `mise run setup` | Install dependencies and git hooks. |
| `mise run check` | Fast gate: lint, typecheck, unit tests, knip. Unit tests with a time budget (named `@perf`) run afterwards, alone and one file at a time; `OTEL_HTML_PERF_FACTOR` scales their budgets on a slow machine. |
| `mise run build` | Build the library, then the viewer, into `dist/`. |
| `mise run test:e2e` | Build, then run the Playwright suite in Chromium, Firefox and WebKit. Extra arguments go to Playwright (`mise run test:e2e -- e2e/merge.spec.ts`). The metrics scale check runs only with `OTEL_HTML_METRICS_SCALE=1` (CI runs it in its own Chromium job): it writes a 200 metrics × 1,000 series × 1 h report the first time (about 15 minutes and 12 GB) and keeps it in `e2e/.cache/` until the writer sources change. |
| `mise run build:binaries` | Compile standalone binaries into `dist/bin/` (after `build`). |
| `mise run fixtures` | Regenerate `fixtures/*.otlp.json` with the OpenTelemetry SDK. |
| `mise run demo` | Convert the `small`, `linked-*` and `metrics` fixtures (traces, logs and metrics) with `fixtures/dashboards.otel-html.yaml` and open the report in a browser, on the Checkout dashboard. Not for CI. |

Other tasks: `lint`, `format`, `typecheck`, `test:unit`, `knip`, `gen`, `gen:check`, `check:package`, `test:e2e:chromium`.

## Roadmap

- M2 (done): Logs explorer, log patterns and log panel, with log and trace cross-linking.
- M3 (done): Metrics explorer and catalog, with embedded metric charts in all panels.
- M4 (done): Dashboards, including the built-in Fusion dashboard, and dashboard config.
- M5: OTLP receiver (HTTP, then gRPC), `serve` and `run` commands, SDK exporters and load tests.

The design is in [`docs/superpowers/specs/2026-10-25-otel-html-design.md`](docs/superpowers/specs/2026-10-25-otel-html-design.md).
