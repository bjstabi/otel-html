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

Commands: `convert` (OTLP files to a report), `serve` (receive OTLP over HTTP and gRPC), `run` (wrap a command and report its telemetry), `merge`, `host` (serve a format-4 report with its queries answered by DuckDB), `upgrade` and `config print`.

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
| `--format <format>` | Report format: `local` (default) or `site` (both format 4: Parquet partitions; see [Report layout and hosting](#report-layout-and-hosting)). Sets `writer.format`. `chunks` (format 3) is no longer written. The viewer opens format-4 reports only; a format 1-3 report is converted with `merge` first. Appending needs the report's own format and the same version, so `--format` must match the report's. |
| `--assets-base <path>` | Where the report loads its viewer files from: `assets/` (default; the report carries them) or a relative path such as `../../assets/0.3.0/` (`../` segments, then `assets/` and at most one more folder), in which case no `assets/` is written beside the report. Sets `writer.assetsBase`. A report that carries its own `assets/` cannot move to a shared base on append; `otel-html upgrade <report> --assets-base <base>` moves it. |
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
| `--export-otlp <url>` | Also forward every accepted request to this OTLP/HTTP collector (see below). Config: `receiver.exportOtlp`. |
| `--append` | Require a report at `-o` and add to it (fails when there is none; useful in CI to catch a wrong path). |
| `--replace` | Start the report over. Without either flag, `-o` is appended to when it already holds a report written by the same otel-html version and created otherwise. The same applies here: the existing report is wiped only once the first request has been read without error, so that request is held in memory until then (see Limits). |
| `--format <format>`, `--assets-base <path>` | As for `convert`. |
| `--config <file>`, `--title <title>` | As for `convert`. |

Turning off both transports is a usage error (exit 2). A port that is already in use exits 1 with the system's `EADDRINUSE` message and a hint to pass `--http <port>` or `--grpc <port>`, or to turn that transport off (other bind errors get a hint for their cause: privileges for ports below 1024, `--host` for an address that is not this machine's).

Forwarding to a collector: with `--export-otlp http://collector:4318`, `serve` and `run` POST each request they accepted (answered 200, or partially accepted) to `<url>/v1/traces`, `/v1/logs` or `/v1/metrics`, with the content type it arrived with (`application/x-protobuf` or `application/json`); a request received over gRPC is forwarded as protobuf over HTTP. The headers come from `OTEL_EXPORTER_OTLP_HEADERS` (`key=value,key2=value2`, values URL-decoded; a malformed pair is a usage error); headers sent over plain `http:` to a collector that is not on loopback get a warning on stderr, since they usually carry credentials. Requests are sent in order from a queue of at most 64 requests or 64 MiB; a full queue drops the request and counts it, a failed request (10 s timeout, no retry) is counted and the first failure is warned about once, and on exit the totals line is followed by `forwarded <n>, dropped <n>, failed <n>`. Forwarding never slows or fails the report: the endpoint comes only from the flag or config, never from a request. With `--export-otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL` must be unset, `http/protobuf` or `http/json`; any other value is a usage error. The URL must be `http:` or `https:`, with no query, fragment or credentials (use `OTEL_EXPORTER_OTLP_HEADERS` for those). `run` also forwards its own root span. In `run`, `OTEL_EXPORTER_OTLP_PROTOCOL` also selects the command's exporter, so a command that exports over gRPC together with `--export-otlp` is refused (gRPC fan-out is tracked in [#259](https://github.com/bjstabi/otel-html/issues/259)); `run` reads only that generic variable and passes `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, `_LOGS_PROTOCOL` and `_METRICS_PROTOCOL` through to the command unchanged. A workaround: start `run` with `--grpc <port>` (it keeps gRPC bound), leave the generic protocol unset or `http/protobuf`, and have the command set the per-signal protocol to `grpc` with `OTEL_EXPORTER_OTLP_<SIGNAL>_ENDPOINT=http://127.0.0.1:<port>`; its gRPC requests are then forwarded as protobuf over HTTP.

On Ctrl-C (SIGINT) or SIGTERM, `serve` finishes the requests in progress, then stops listening (a request arriving meanwhile is answered 503 and retried by the client), completes the report and prints `wrote <out>: ...` and `received <N> requests (<K> refused); <M> records rejected`. A request is refused when it fails outright (it could not be decoded, has an unsupported content type or path, is too large (over gRPC, see Limits), or arrives while the receiver is busy); records are rejected when a request is otherwise accepted but an entry in it is dropped. When K is not zero, a second line breaks the refusals down, for example `refused: 3 invalid, 1 unsupported`, and a warning on stderr names the first refusal of each kind, so a misconfigured exporter shows up while `serve` runs. A second Ctrl-C while it finishes prints `interrupted; the report is at its last checkpoint` and exits 130; the report is then viewable and resumable from its last checkpoint but is not marked complete.

### `run`

Runs a command with its OpenTelemetry SDK pointed at a receiver, wraps the run in a root span, and writes the report when the command exits.

```sh
otel-html run -o ./report -- pytest -q
```

Everything before `--` is an `otel-html` flag: the `serve` flags (`-o`, `--host`, `--http`, `--no-http`, `--grpc`, `--no-grpc`, `--export-otlp`, `--config`, `--title`, `--append`, `--replace`, `--format`, `--assets-base`). `run` binds only the transport the command's protocol needs: OTLP/HTTP on 4318 by default, or OTLP/gRPC on 4317 when `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`; an explicit `--http <port>` or `--grpc <port>` binds that transport as well (a transport enabled only in the config file is not bound by `run`). A local collector on 4317 therefore does not get in the way. The receiver starts first, then the command runs with its stdio inherited and these variables added to its environment:

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

Combines report folders into one, for example the reports of parallel CI jobs. It reads reports of every format, so it works across otel-html versions (see [Report format compatibility](#report-format-compatibility)). A cumulative metric series that appears in two reports is two runs: the second report's stream starts from its own start time and is not counted as a counter reset.

```sh
otel-html merge ./job-1 ./job-2 -o ./combined
```

Options: `-o, --out <dir>`, `--config <file>`, `--append`, `--replace` (as for `convert`), `--format` and `--assets-base`, and `--compact`. When `-o` already holds a report, `merge` adds its inputs to it, but only in that report's own format: asking for the other one (`--format site` into a `local` report, or the reverse; `-o <site report>` without `--format site` counts, because the default is `local`) fails with exit 2 and the hint "append with --format <the report's format>, or switch the report with `otel-html upgrade <report> --format <wanted>`". Switch the report with `upgrade` first, or merge into a new folder.

`merge` writes a format-4 report (`local` unless `--format site`). A format 1-3 input is converted row by row, as `convert` would write it. A format-4 input is copied: each of its partition folders is added to the output under the next free number, with its Parquet files byte for byte (nothing is decoded), its statistics cut to the output's `writer.statisticsKeys` (a key the input did not keep is unknown), and `source` `merge:<input>#<n>` (`<input>` is the input's index once the inputs are sorted by epoch, oldest first; `<n>` its partition number there). Copying into `local` writes every file's `.parquet.js` wrapper afresh, whichever format the input had; copying into `site` writes none. Copies are not deduplicated against other inputs' rows, and each input keeps its own pattern cluster ids. `--compact` (config `writer.compactOnMerge`) then compacts each input's copied partitions into one partition, so the copied partitions end up as one partition per format-4 input (an input with a single partition is left as copied). Other partitions the output holds, such as ones from an earlier run when appending, are not touched, and the flush partitions of converted rows are compacted into their own partition as at any close; within an input, pattern rows are summed only when both the cluster id and the template match.

### `host <report>`

Serves a format-4 report over HTTP and answers its queries on the machine that runs `host`, so the viewer never downloads the report: every query is SQL to the host, and the browser receives only the results. Use it for a report too large to open from `file://` or to download whole.

```sh
otel-html host ./report
# serving ./report at http://127.0.0.1:8080/ (12 partitions, 340 MB of Parquet); press Ctrl-C to stop
```

| Flag | Meaning |
| --- | --- |
| `--host <addr>` | Address to listen on. Default `127.0.0.1`. |
| `--port <port>` | Port to listen on. Default 8080; 0 picks a free port. |
| `--timeout <ms>` | Longest a statement may run, from 1 to 86,400,000 (24 hours). Default 30,000. A statement past it is cancelled and answered 504. |
| `--max-result-bytes <n>` | Largest result of one statement, in bytes of Arrow IPC, from 1 to 4,294,967,296. Default 67,108,864 (64 MiB). A larger result is refused 413. |

The printed size is the Parquet bytes the manifest lists, in megabytes (10^6 bytes) rounded to the nearest whole number, so a small report shows `0 MB`.

`host` serves the report whether it was written as `local` or `site`, with any `assetsBase`, and whichever otel-html version wrote it, because it serves its own viewer rather than the report's: `/` and `/index.html` are the host's page, `/assets/` its viewer files, `/data/manifest.js` the report's manifest, and `POST /query` the queries (Mosaic's REST protocol, Arrow results). Nothing else is served; in particular the Parquet files are never sent, and only `arrow` queries run. A statement must be a single read-only `SELECT` over the report's views (`spans`, `logs`, `points` and the other tables); anything else (DDL, `SET`, `COPY`, `ATTACH`, `LOAD`, a second statement, reading a file) is refused 400.

Open the page at exactly the address `host` prints. The viewer then sends its queries to the host instead of starting the DuckDB engine in the page, so a served page never requests a Parquet file, a WebAssembly file or a worker. Fusion, dashboards and the Metrics pages work unchanged, and the Traces, Logs and Metrics pages show the same counts, tables and charts as the same report opened from disk.

One difference: the host evaluates conditions in SQL only. An OTTL condition, or a metric `where`, with a term that has no SQL form (`Len(name) > 2`, say) is refused with `this served report evaluates conditions in SQL only: "<term>" has no SQL form; rewrite or remove it`, where a report opened from disk would evaluate that term in the browser and say so ("Evaluated in the browser"). A condition on `log.body.string` (the body as text) has no SQL form, so a served report refuses it: the Logs explorer's body `contains` and `matches` filter tokens, and the pattern filter a click on a pattern adds, are refused (a view that needs only rows, such as the Traces and Logs widgets of a dashboard, still evaluates the term in the browser and says "Evaluated in the browser").

A report that is not format 4 exits 2 with the hint to run `otel-html merge <report> --out <new>`; a folder without a report exits 2, and so does a Parquet file the manifest lists that is missing (`invalid-report`). A port that is already in use exits 1 with a hint to pass `--port <port>`. On Ctrl-C (SIGINT) or SIGTERM, `host` stops at once, whatever is running: new connections are refused, the engine stops (a statement still running is answered 503) and it exits 0; a second Ctrl-C while it starts or stops exits 130.

### `upgrade <report>`

Rewrites a report's viewer (`index.html` and `assets/`) with the one in this otel-html, so an old report opens with the current viewer. Only a format-4 report can be upgraded: a report of format 1 to 3 fails with exit 2 and the message "This report is format N; this viewer reads format 4. `otel-html merge <report> --out <new>` converts it." (`merge` converts it). The report's data is not touched (a format-4 manifest's `engine` block is updated to this version's engine), and viewer files in `assets/` that this version does not use are removed. It fails with exit 2, writing nothing, when the folder holds no report or another otel-html has the report open.

```sh
otel-html upgrade ./report
```

A report can also be switched with `--format local|site` and `--assets-base <path>` (`assets/` or a relative path like `../../assets/0.3.0/`). Going to `local` writes the `.parquet.js` wrapper beside every listed Parquet file and the base64 engine files; going to `site` removes them and takes the plain engine files. With a shared `--assets-base` the report's own engine and `viewer.*` files are removed (a subfolder such as `assets/0.3.0/` is never touched), and `index.html` and the manifest's `engine.assetsBase` name the new base; the shared copy is the publisher's to upload. The Parquet data is not touched. `upgrade` warns whenever the resulting format is `local` and the Parquet bytes exceed 256000000, the default `writer.localWarnBytes`; `upgrade` reads no config file, so it cannot be changed there. The writes are ordered so that a crash leaves extra files rather than missing ones, and running `upgrade` again finishes the job. A format-4 report that loads its viewer from a shared base needs `--assets-base` on every upgrade (the same base to keep it, `assets/` to copy the files into the report), because the shared copy is not the report's to check.

### `config print`

Prints the resolved configuration and where each value came from (default, file, environment or flag).

```sh
otel-html config print --config otel-html.yaml
```

Options: `--config <file>`, `--title <title>`, `--format` and `--assets-base` (as for `convert`).

## Library API

The package exports `convert`, `merge`, `Report` and `OtelHtmlError`, plus types (`ConfigInput`, `ConvertOptions`, `MergeOptions`, `ReportOptions`, `ReportSummary`, `AddResult` and others).

`Report.create` also takes `format` (`local` or `site`) and `assetsBase`, which override `config.writer.format` and `config.writer.assetsBase`.

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
const summary = await report.close(); // flushes the open partitions and finalizes the manifest
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
- **Patterns.** The writer clusters every log message with an in-house Drain implementation (numbers, IDs and similar tokens are masked into placeholders) and stores the clusters in the report's `patterns` table. The Patterns view reads that table, so it is exact, and it does not re-cluster: the condition and free-text filters do not apply to it (the page says so), while the time window does, by each pattern's first and last occurrence. Choosing a pattern adds a filter token that matches its template with `IsMatch(log.body.string, ...)`, which stays editable in the query bar. `IsMatch` patterns are RE2-like (no backreferences, no lookaround, no inline flag groups such as `(?i:...)`; a leading `(?i)` or `(?s)` is fine), and a repeated group with a variable part inside is accepted only when a literal the repeated part cannot match ends each variable part, like `(\d+\.){3}`.
- **Log panel.** Click a log to open its panel. The body is shown above the tabs, rendered by type (text, JSON-like maps and lists, bytes). Attributes lists the log's attributes and its record fields. Trace shows the trace's flame graph with the span that emitted the log outlined. It is hidden when the log's trace is not in the report. Surrounding logs lists the logs before and after it from the same stream. Resource shows the resource and scope. A very long body shows its first 16,384 characters with a control to show all.
- **Cross-links.** A span or trace panel has a Logs tab that lists its logs, and "Open in Logs Explorer" jumps to the Logs explorer with the matching `trace_id` or `span_id` condition. A log with trace context links back to its trace and span: the log panel's Trace fact, its Trace tab ("Open trace →") and the log list's trace column open the trace.

### What carries between explorers

When you move between explorers (the sidebar, `g l` and `g t`, or an "Open in ... Explorer" link), only the time window (`t`), the free text (`text`) and a query (`q`) that compiles in the target explorer's OTTL context come along. Everything else resets: group, view, sort, selected trace, span or log, and panel tabs. A query that does not compile there (such as `span.name == "x"` carried to Logs) is dropped, and the page shows a dismissible notice naming it. Inside one explorer everything is kept.

## Viewing metrics

Choose Metrics → Explorer in the sidebar (or press `g m`). Like the other explorers, everything you set lives in the URL.

- **Explorer.** Each query row picks a metric (with its type badge and unit), a `where` filter (an OTTL condition over the data point: `resource.attributes[...]`, `attributes[...]`, `metric.name`), what to show, a `by` grouping and functions (`ƒ`: rate, increase, rollup, top/bottom N). What you can show depends on the type: a monotonic sum shows rate, increase or sum; a gauge or other sum shows avg, min, max or last; a histogram shows p50 to p99, count, sum or avg; a summary shows its quantiles, count or sum. Series inside one group are combined by type: counters add, histograms merge their buckets, and gauges use the chosen aggregation (`last` adds the series' last values, so `process.memory.usage` by everything is the total). Up to 10 queries, plus formulas over them (`a / b`). Displays: Lines, Area, Bars, and for histograms Heatmap and Distribution, on a linear or log y-axis. A chart shows one unit; queries with different units are split into one chart per query. Export writes the charted series as CSV or JSON. Charts are exact over every partition of the report, with no cap on the number of series and no "other" line. Buckets are whole, so the first and last bucket of a chart may include points just outside the selected window. When a `where` has a term that cannot be turned into SQL, the chart says "Evaluated in the browser: <term>" (see [Limits](#limits)). A run chart's counter rate is the increase per second from the report's start to the run's last point.
- **Exemplars and the click menu.** With Exemplars on, the exemplars stored with the series are drawn as rings (at most 5,000 exemplar points per query, the oldest first; a note says when the rest were left out). Clicking a chart opens a menu: open the exemplar's trace (or say that the report does not hold it), Traces or Logs in this window (the clicked bucket's time window, with the query's `where` carried as between explorers), or zoom. Dragging across a chart zooms to that span.
- **Catalog.** Metrics → Catalog lists every metric definition: type, unit, temporality, scope, attribute keys, series count and a sparkline over the run. It reads the whole `points` table once, the first time a Metrics page or a Metrics tab needs it, so it takes longer the more points the report holds. A text filter matches name, unit and scope. Clicking a row opens the metric in the Explorer with its type's default display.
- **Metrics tabs.** The log panel, the span section and the trace panel have a Metrics tab when the log's, span's or trace's resources report metrics. It charts every metric of those resources over the moment ± 5 minutes, grouped by namespace (`process.*`, `http.*`, ...). Only the first group starts expanded, and charts render as they scroll into view. A dashed line marks the log, the span or the trace start, and exemplars of the same trace are highlighted. Size S/M/L changes the chart height, and "Open in Explorer →" opens the expanded group's metrics with the same resource filter and window.
- **Never silently wrong.** A chart says so in a note when its numbers need a caveat: counter resets, summary quantiles at a coarse resolution, a name with several definitions, histograms with different bucket bounds, a `where` evaluated in the browser, or exemplars capped. The click menu says when an exemplar's trace is not in the report.

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

### Older formats (1 to 3)

Reports of formats 1 to 3 are no longer written, and the viewer does not open them; `merge` still reads them (`otel-html merge <report> --out <new>` converts one to format 4). Format 3 looked like this:

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

The viewer reads this format, through DuckDB-WASM: it creates one view per table over the partition files and runs SQL against them. The tables and columns are listed in [docs/format/schema.md](docs/format/schema.md) (generated from the schema). The format-3 layout above is what older otel-html versions wrote; the viewer no longer opens it (see [Report format compatibility](#report-format-compatibility)).

```
report/
  index.html
  .nojekyll
  assets/                 viewer.<hash>.js and .css, plus the DuckDB engine files for this format (omitted when assetsBase is shared); the package's `dist/viewer/assets/` also holds the host's two Node engine files (`duckdb.<v>.node.cjs`, `duckdb.<v>.node.worker.cjs`), which no report copies, and the `parquet` and `json` extension files (`*.duckdb_extension.wasm`), which a `site` report copies and a `local` report carries as base64 wrappers
  data/
    manifest.js           run metadata, the partition list with per-file statistics, and `engine` (version, format, assetsBase)
    partitions/<p6>/      <table>.parquet for spans, logs, points, traces and patterns (000000/, 000001/, ...)
                          and, for `local`, <table>.parquet.js beside each: the same bytes as a base64 script
    state/                writer checkpoint
```

- `site` is for a report served over http: the viewer reads the `.parquet` files and loads `assets/duckdb.<v>.wasm`, `duckdb.<v>.worker.js` and DuckDB's signed `parquet.<v>.duckdb_extension.wasm` and `json.<v>.duckdb_extension.wasm`.
- `local` opens from `file://`, where nothing can be fetched: every `.parquet.js` wrapper and the engine's `duckdb.<v>.wasm.gz.b64.js`, `duckdb.<v>.worker.b64.js` and the two extensions' `duckdb.<v>.parquet.ext.gz.b64.js` and `duckdb.<v>.json.ext.gz.b64.js` are classic scripts that register their bytes. Wrappers are a third larger than the Parquet, so a large report is better served as `site` (the writer warns past `writer.localWarnBytes`). Either way a report makes no network request: the extensions DuckDB would otherwise download at first use travel in `assets/` (about 3.9 MB plain, 1.2 MB wrapped).
- Closing a report compacts its flush partitions into one sorted partition when there are two or more.
- `assetsBase` (default `assets/`) names where the viewer and engine files load from. A site that publishes them once for many reports sets it to a shared relative path such as `../../assets/0.3.0/`, and the report then carries no `assets/` of its own.

### Hosting

- `local` reports: open `index.html` directly from disk (`file://`). The viewer reads every partition a query touches whole, from the scripts the report loaded.
- `site` reports need a web server that answers `Range` requests (and `HEAD`): the viewer fetches the Parquet files and the engine, and reads only the row groups a query needs. A host that ignores `Range` still works, but sends whole files.
- GitHub Pages and GitLab Pages: publish the folder as it is. It works under a subpath such as `https://user.github.io/repo/report/`.
- Any other static host or subpath works the same way.
- CI: upload the folder as a build artifact.
- A report too large to open or download whole: run `otel-html host <report>` on a machine that has it and open the address it prints (see [`host`](#host-report)).

The report is exercised in Chromium, Firefox and WebKit by the end-to-end tests: the tests open the `local` report from `file://`, and a tagged subset opens a `site` copy of it over HTTP from a static server that answers `Range` and `HEAD`.

### A report that is still growing

Any report with `complete: false` in its manifest is still growing: a `site` report while its CI run goes on, or a `local` one written by `otel-html run` mid-run (Refresh works from `file://` too). The viewer shows a line under the page header, "In progress · updated 3 min ago", with a **Refresh** button and an **Auto-refresh** checkbox. Refresh loads `data/manifest.js` again, registers the partitions the new manifest lists, drops the ones it no longer lists and re-runs the open page's queries. Auto-refresh does the same every 60 seconds (it is off by default, and the choice is remembered for the tab). The age is the manifest's `updatedAt`, so it also shows when the host is still serving an older manifest than the last publish: GitHub Pages' CDN ignores the cache directives of a request, so a Refresh can land on a manifest that is a few minutes old. Refresh again later; nothing is lost.

When a publish drops a partition (a compaction), the site deletes the file only 15 minutes later. After that, a query that reads a file the page has not read yet fails, and the page says "This report has changed. Refresh." with a Refresh button. A served report (`otel-html host`) has no Refresh: the host serves one manifest.

### This repo's CI

This repo's CI reports on itself with `otel-html`. Every job in [ci.yml](.github/workflows/ci.yml) builds the CLI first, then uses it as the job's shell, so each `run:` step is a traced command:

```yaml
shell: node dist/cli/main.js run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}
```

The `otel-html ci context` step ([src/cli/ci/context-main.ts](src/cli/ci/context-main.ts)) looks the job up in the Actions API and sets `TRACEPARENT` and the resource attributes for later steps. The trace id is derived from the run, and the span ids from the run and job, so the job reports nest under the run → job spans without the jobs talking to each other. If the job lookup fails, the job id falls back to a hash of its name and runner (with a warning), and `context.json` records both; the publisher matches it to the job (its display name, or a matrix leg `<name> (…)`, on that runner), so matrix legs no longer need `OTEL_HTML_JOB_NAME`. Set it when the job's `name:` differs from its id beyond case, or when two legs of one name ran one after another on one runner. Each job uploads its `.otel-html/` folder as an `otel-html-*` artifact. At its end it also uploads its report partitions as an `otel-html-update-push-*` artifact (a site update) and wakes the deployer (the collect action's `publish: true`, see below).

When the `ci` or `load` workflow completes, [ci-report.yml](.github/workflows/ci-report.yml) runs `otel-html ci report` ([src/cli/ci/report-main.ts](src/cli/ci/report-main.ts)). The workflow is the default branch's copy, and it builds the report with the triggering commit's own code when that commit is in this repository and a person started the run; a fork's or a bot's run, or a dispatched `ci` run, uses the default branch's code (a manual dispatch of `ci-report` uses the code of the ref it was dispatched on). A person's same-repository commit executes under `main`'s Actions cache scope and could save a `mise-tasks-*` entry that later runs replay as a pass. Only people with write access can do that, and `main`'s ruleset requires a pull request with an approving review and requires no status check, so a forged pass can make a run look green but cannot merge anything a reviewer would not see. This risk is accepted. The report job writes the run → job spans from the Actions API, turns each job's log into log records, adds queue-time and duration metrics, and merges these with the job artifacts into one `local` report, uploaded as `ci-run-report`. That artifact is about 15 MB and opens from disk (double-click `index.html` after unzipping); only the copy that goes to the site is converted to `site` format. Run it by hand with `workflow_dispatch` and a `run_id` to rebuild a past run. The report opens on the [CI dashboard](.github/actions/otel-html-publish/otel-html-ci.yaml): job duration, queue time, step counts, runs, and warnings and errors, with `workflow` (`cicd.pipeline.name`, to tell `ci` and `load` runs apart on a shared page), `run` and `job` variables. The run-level span lives on the run's own resource, so selecting a job in `job` hides it from the widgets that list spans; the Runs list still shows each run that job ran in, through its job span. A job skipped by its `if:` gets no duration or queue-time point. The run key includes the run attempt, so after a partial re-run the artifacts of jobs that did not re-run (still attempt 1) show up as separate traces without a job span.

The run's report is then published to the site at <https://bjstabi.github.io/otel-html/>. The layout is:

- `/index.html` (landing page) and `/index.json` (site index).
- `/assets/<otel-html version>/`: the viewer and the DuckDB engine files, written once per version and shared by every report on the site. The reports on the site are `site` format and load their viewer from there; they hold only their data.
- `/branch/<name>/` and `/branch/<name>/runs/<run_id>/` for pushes to the default branch of this repo: [`/branch/main/`](https://bjstabi.github.io/otel-html/branch/main/). `<name>` is the branch lower-cased with each run of other characters as one `-`.
- `/pr/<number>/` and `/pr/<number>/runs/<run_id>/` for any other run whose commit or branch belongs to an open pull request (the pull request may have been pushed to since). A default-branch run always goes to its branch's folder, even when an open pull request's head is, or contains, its commit.

Each folder holds the runs of every workflow (`ci`, `load`). A run on any other branch, or a push from a fork, with no open pull request is not published. The site keeps the last 30 runs of each workflow per branch and the last 10 of each workflow per pull request; a re-run replaces its folder. GitHub Pages sites are limited to 1 GB. A run's report here is its data only (the viewer is shared). It is estimated at about 1.7 MB: the format-3 report's 3.6 MB less its 1.9 MB viewer. That is the format-3 figure; format 4 has not been measured on the site yet, and the first format-4 publishes will measure it. Each folder also carries its rolling report, the runs' data again: at the defaults that is about 150 MB for `/branch/main/` and about 25 MB per open pull request. On top of that each otel-html version in use adds about 40 MB of `/assets/<version>/` (the DuckDB engine and its extensions) until no retained report references it. Every deployer pass removes the asset versions no report references any more, so a version leaves the site once its last report does. Do not delete `/assets/` by hand: every report breaks. A change to the viewer without a version bump adds its new `viewer.<hash>` files to the same version's folder, a few MB each, until that version is pruned. When a pull request closes or merges, `pull_request_target` triggers the `cleanup` job, which removes its `/pr/<number>/` folder; after a merge, `/branch/main/` carries the merged result. The per-workflow folders of earlier versions (`/ci/`, `/load/`) are removed by the next deployer pass; nothing redirects from them.

`/branch/<name>/` and `/pr/<number>/` are rolling reports: after each deployer pass the deployer merges the channel's retained `runs/<run_id>/` reports, oldest first, into one report and replaces everything in the folder except `runs/` and any `preview-*.png` screenshots, which survive rebuilds (a later step may refresh them). After each rebuild it also writes a `badge-<workflow>.json` file per workflow into the folder, a shields.io endpoint badge showing that workflow's newest run. Runs inside it are told apart by trace id (one per run attempt, so a re-run is its own trace) and by the `cicd.pipeline.run.id` resource attribute, which the dashboard's `run` variable selects. Retention bounds it: a run older than its workflow's newest 30 (10 on a pull request) drops out of the channel, and the next rebuild leaves it out. The run being published always stays listed, even when it is older than the ones kept (a dispatched rebuild of an old run), and the next publish's retention removes it. A per-run report whose format this version of otel-html no longer reads is skipped with a warning; its run stays listed and the rest still merge, until retention removes it. If the merge fails for any other reason, the channel warns and falls back to a stub forwarding to the newest run. A `load` run whose jobs were skipped has no job reports and publishes nothing.

Only one workflow writes the site: [pages-deploy.yml](.github/workflows/pages-deploy.yml), the deployer, which runs the [otel-html-deploy](.github/actions/otel-html-deploy/action.yml) action from the default branch's code. Nothing else pushes to the site, and no job holds `contents: write`. The jobs only upload artifacts, and the deployer applies them.

The site's life cycle:

- **Updates.** Every report-producing job in `ci` and `load` (all but the `changes` and `changed` helpers) uploads `otel-html-update-push-*` artifacts every 60 s while it runs (when its report changed) (the pusher, `push-every: 60s` on the setup step) and once more when it ends: its report's partitions, the job's CI spans and an `update.json`. The `report` job in [ci-report.yml](.github/workflows/ci-report.yml), which runs the [otel-html-publish](.github/actions/otel-html-publish/action.yml) action when a run completes, uploads an `otel-html-update-run-*` artifact: the finished run's compacted report. When a pull request closes or reopens, the `cleanup` job uploads an `otel-html-update-remove-pr-*` or `otel-html-update-reopen-pr-*` artifact. Each uploader then dispatches `pages-deploy.yml` with `otel-html ci dispatch`. A dispatch that fails only delays the site: the deployer also runs when `ci-report` ends and on a five-minute schedule, which is the only wake-up for fork pull requests and bot branches, which `ci dispatch` does not wake the deployer for.
- **Passes.** A pass starts with a cheap `plan` job that lists the update artifacts it has not applied yet. With none pending it ends. Otherwise the `deploy` job (one at a time, in the `pages` concurrency group) takes the last deployed site as its base, applies every pending update, and deploys the result with `actions/deploy-pages`. A pass that GitHub cancels for a newer one loses nothing, because the newer pass lists everything pending. Never re-run a pass; dispatch a new one. A job's update is accepted only from a run of `ci.yml` or `load.yml` and is checked against that run; a rejected update is named in the pass's log.
- **Deferred deletion.** A compaction drops the files it replaced from the manifest, but the site deletes them only 15 minutes later, so a viewer holding an older manifest (the Pages CDN may serve one for ten minutes) still finds its files.
- **`site-state/`.** The site's state (which updates were applied, the removed pull requests, the file list and the pending deletions) lives in `site-state/` at the site root. Each pass also uploads it alone as the small `otel-html-site-state-*` artifact, and `plan` reads that instead of downloading the site. After 90 days (artifact retention) the base comes from the live site over HTTPS, using `site-state/files.json`.
- **Migration.** The first pass after the move from the `gh-pages` branch (the old store) takes the last deployment's Pages artifact as its base, or the `gh-pages` tip when that has expired. The branch is no longer read or written; it stays only so that reverting the move still works, and goes once the deployer has run for a few days.

Permissions: the jobs that produce a report hold `contents: read` and `actions: write`. The write is for `ci dispatch`, which (when a person started the run) dispatches with the deployer App's token, whose only permission is Actions (see Dispatch token); the artifact uploads use the runtime token every job has. The `report` job holds `actions: write` (downloading the run's artifacts, uploading the update, dispatching), `pages: read`, `pull-requests: write` and `checks: write`; `cleanup` holds `actions: write` only. The deployer's `deploy` job holds `contents: read`, `actions: write` (downloading updates, pruning artifacts), `deployments: read`, `pages: write` and `id-token: write`. The preview screenshot at the top of this README is taken by the deployer, over a loopback server (`127.0.0.1`, a random port) on the site it is about to deploy, because a `site` report loads its engine over http and does not open from `file://`.

`otel-html ci link` posts one sticky comment per workflow on the open pull requests of a pull request run (found by a per-workflow marker, so `ci` and `load` do not overwrite each other; a default-branch run comments on none). The comment links this run's report, the pull request's rolling report (`All runs on pull request #<number>`, `/pr/<number>/`) and the run before it on the pull request (the previous run of the same workflow, else the one before it of any workflow), and creates a check run named `otel-html report` that concludes `neutral`: it is a link, not a second verdict on the run.

These subcommands are for the actions; stable flags, output format not guaranteed.

| Subcommand | What it does | Flags |
| --- | --- | --- |
| `ci report` | Builds a run's report from the Actions API (with `$GITHUB_TOKEN` from the environment) and merges it with the downloaded job artifacts. Writes the report in `local` format (opens from `file://`; about 15 MB), the summary table to the job summary, and `published=false` to `$GITHUB_OUTPUT` when the run has no job reports. | `--run-id`, `--repository`, `--artifacts`, `--out` (all required); `--config`; `--no-summary` (the action does not pass it: on `github-pages` it points `$GITHUB_STEP_SUMMARY` at a file for this step and appends that file to the job summary only when the site push did not publish, since `ci link` writes the linked summary otherwise) |
| `ci link` | Comments on the pull requests (this run's report, the pull request's rolling report (`/pr/<number>/`), the previous run), creates the check run and writes the job summary. With `--index-url` the previous run is the newest other finished run of the run's channel in the live `index.json`, and the channel comes from the GitHub API, so a run the index does not list yet still gets both links; a failed fetch is a warning and no previous-run line. Never fails the job. | `--run-id`, `--repository`, `--url`, `--index-url` (the live site's `index.json`) (all required); `--no-comment`, `--no-check` |
| `ci update push` | Writes a `push` update from a job's report: the partitions the job has produced since its last update, and the CI spans. Never fails the job. Writes `name`, `sequence` and `partitions` to `$GITHUB_OUTPUT` (all empty or `0` when nothing was written). | `--report`, `--out` (required); `--final` (stop the pusher first, number the update after its last upload); `--config`; `--publish-dir` (default `<report>/../publish`) |
| `ci update run` | Writes a `run` update: the finished run's compacted report, for the deployer to place. Writes `name`, `channel`, `report-url` and `published` (`false` when the run has no open pull request and is not on the default branch) to `$GITHUB_OUTPUT`. | `--report`, `--out`, `--run-id`, `--base-url` (all required); `--repository` (default `$GITHUB_REPOSITORY`); `--config` |
| `ci update remove-pr`, `ci update reopen-pr` | Write an update that removes a pull request's channel from the site, or lifts that removal. Write `name` to `$GITHUB_OUTPUT`. | `--pr`, `--out` (both required) |
| `ci update done` | Records a finished upload in the pusher's ledger. Never fails the job. | `--name` (required); `--publish-dir` (default `.otel-html/publish`) |
| `ci update stop` | Stops a running pusher (SIGKILL after 90 s); with `--log`, prints the failure lines of that log as one notice. Does nothing without a pusher. Never fails the job. | `--publish-dir` (default `.otel-html/publish`); `--log` (the pusher log to summarise; collect passes `<publish-dir>/pusher.log`) |
| `ci pusher` | Starts the pusher (see [The pusher](#the-pusher-push-every)): re-spawns itself detached, its output in `<report>/../publish/pusher.log`, and returns at once. | `--report`, `--every` (a duration such as `60s`, `2m` or `500ms`) (both required); `--config`; `--deployer-workflow` (default `pages-deploy.yml`); `--detached` is internal |
| `ci upload` | Zips a folder and uploads it as an artifact of the current run. Needs the runtime variables (`ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`) that only a JavaScript action's environment holds, so it runs as a child of one (`actions/github-script`). | `--name`, `--path` (both required); `--retention-days` |
| `ci dispatch` | Wakes the deployer workflow on the default branch, for a same-repository run by a user. Never fails the job; a refusal is one log line. | `--workflow` (default `pages-deploy.yml`); `--repository`; `--run-id` (default `$GITHUB_RUN_ID`) |
| `ci deploy plan` | Finds the last deployed site, the newest site state and the pending updates; writes `pending.json` and the state. Writes `pending`, `base_kind`, `base_run_id`, `base_artifact_id`, `base_deployment_id` and `wait` to `$GITHUB_OUTPUT`. | `--out`, `--state-out`, `--pages-url` (all required); `--repository`; `--ci-workflows` (default `ci.yml`); `--report-workflow` (default `ci-report.yml`); `--deployer-workflow` (default `pages-deploy.yml`; only its runs on the default branch may upload a consumed state) |
| `ci deploy fetch` | Downloads the accepted updates of `pending.json` into `<out>/<update name>/`. An unreadable download (a malformed zip, an oversized body) marks that update rejected for good in `pending.json` (`unreadable: ...`); a network or HTTP failure marks it `retry`, and the next pass tries it again. | `--pending`, `--out` (both required); `--repository` |
| `ci deploy apply` | Applies the pending updates to the unpacked site in the specified order, deleting superseded files only after a later pass, and writes `site-state/`. Calls no API and deploys nothing. Writes `changed`, `consumed`, `deploy`, `previews` and `pending_jobs` to `$GITHUB_OUTPUT`. | `--site`, `--updates` (required); `--pending` (required without `--trust-updates`); `--state`; `--repository`; `--retention` (30), `--pr-retention` (10); `--config`; `--pass-run-id` (default `$GITHUB_RUN_ID`); test flags: `--trust-updates` (accept every update folder without `pending.json`), `--channel` (with it, the channel to apply them to) |
| `ci deploy prune` | Deletes the artifacts of deployments older than the newest `--keep`, and the update artifacts they consumed. Needs a token that can delete artifacts; a failed delete is a warning. | `--site` (required); `--keep` (3); `--repository` |
| `ci deploy fetch-live` | Cold start: downloads the live site's files, as its `site-state/files.json` lists them, into `--out`. | `--pages-url`, `--out` (both required) |
| `ci deploy scan` | Rewrites `<site>/site-state/files.json` from the files now in the site. | `--site` (required) |

See [Use in your CI](#use-in-your-ci) to adopt this in another repo.

### Use in your CI

Three composite actions let another repository report on its own CI. They need an otel-html release that has `run` and `ci` (the first release after 0.1.1). `@v0` floats to the latest 0.x release (the release workflow moves it; prereleases leave it alone), and with `version: latest` (the default) the actions used at `@v0` install the newest 0.x binary, never a 1.x one; at any other ref `latest` is the repository's latest release. Pin a release tag such as `@otel-html-v0.2.0` for reproducibility. `v0` becomes `v1` at 1.0.

- `bjstabi/otel-html/.github/actions/otel-html-setup@v0` installs the CLI (checksum-verified) and joins the job to the run's trace.
- `bjstabi/otel-html/.github/actions/otel-html-collect@v0` uploads the job's `.otel-html/` folder as an `otel-html-<job>` artifact and, with `publish: true`, the job's partitions as a site update.
- `bjstabi/otel-html/.github/actions/otel-html-publish@v0` builds the run's report from those artifacts, uploads it as a site update and links it from the pull request.
- `bjstabi/otel-html/.github/actions/otel-html-deploy@v0` is the only writer of the site: it applies the pending updates to the last deployed site and deploys it to GitHub Pages.

The publisher and the deployer need a Pages site (see Pages setup below). Without one, use `target: artifact` on the publisher and skip the other two.

In each job, run setup first, make the CLI the job shell, and collect last. A `run:` step before setup runs before the CLI exists, so it needs `shell: bash`:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read # checkout
      actions: write # setup reads the run's jobs to find this one; collect dispatches the deployer
    defaults:
      run:
        shell: otel-html run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}
    steps:
      - uses: actions/checkout@v7
      - uses: bjstabi/otel-html/.github/actions/otel-html-setup@v0
      - run: npm test
      - if: always()
        uses: bjstabi/otel-html/.github/actions/otel-html-collect@v0
        with:
          publish: true # the job's partitions reach the site while the run goes on; optional
```

Setup inputs: `version` (a release such as `0.2.0`, default `latest`), `command` (an executable instead of a download), `job-name` (the job's display name, used to tell the job apart when the lookup is ambiguous, and for the span id when it fails; see above) and `token`, plus the pusher's `push-every`, `config`, `deployer-workflow`, and `dispatch-app-id` / `dispatch-app-private-key` (an App token for the pusher's dispatches, as for collect; see Dispatch token) below.

##### The pusher (`push-every`)

With `push-every: 60s` (empty by default: no pusher), setup starts a background process, `otel-html ci pusher`, that runs for the rest of the job. Every tick (never faster than once a second) it looks at the job's report, uploads the partitions it has not shipped yet as an `otel-html-update-push-*` artifact and wakes the deployer, so the run's report grows on the site while the job is still going. The pusher needs the collect step: collect stops it first (with any `publish`; a pusher still running after 90 s is killed) and, with `publish: true`, uploads whatever is left, and the job's last update carries the compacted partitions. Without collect nothing stops the pusher before the job ends. The job needs `actions: write`. Setup starts the pusher through `actions/github-script`, because the upload needs the runtime variables that only a JavaScript action sees; they are never put in the job's environment (`GITHUB_ENV`); only the pusher's process holds them. A pusher that cannot start is a warning in the log, and a failed upload is a line in `.otel-html/publish/pusher.log` that collect turns into one notice; neither fails the job: the final upload from collect ships what the pusher did not.

Files in `.otel-html/publish/`: `pusher.log` (one line per upload, with its duration, and per failure; failure lines start with `! `), `uploads.json` (the ledger: the last sequence reserved, the manifest sources already shipped, and each finished upload), `pusher.pid` and `pusher.stop` (the stop request). Collect uploads the folder with the rest of `.otel-html/`, so a run's artifact says what the pusher did. After an upload the pusher wakes the deployer only when no deployer run is already waiting (one listing call; a failed check dispatches anyway), and it looks up the job's CI spans at most every 5 minutes, reusing the last result between lookups; the job's final update builds the complete one. The pusher builds each update under `$RUNNER_TEMP`, never inside `.otel-html/`. The smoke jobs run the pusher on hosted runners only; the `e2e` jobs that run in a container are not covered by a smoke test, so check one of their `otel-html-*` artifacts (`publish/pusher.log` shows uploads) when changing the pusher. `config` is the config file for the CI spans report of each update, and `deployer-workflow` the workflow file dispatched after an upload (default `pages-deploy.yml`). The pusher dispatches with the App token minted when setup ran, or with `token` when no App is configured or the mint failed (a dispatch GitHub may refuse; see Dispatch token). The App token expires after one hour, so in a longer job the later dispatches fail (one line each in `pusher.log`) while the uploads go on. Updates whose dispatch failed reach the site on the deployer's next pass: its 5-minute schedule, or collect's own dispatch.

Collect inputs:

| Input | Default | |
| --- | --- | --- |
| `name` | `otel-html-<job>` | Matrix legs need one each, or one leg's upload replaces another's. |
| `path` | `.otel-html/` | The directory to upload. |
| `publish` | false | Also upload the job's partitions as an `otel-html-update-push-*` artifact and wake the deployer. The job needs `actions: write`. A failure here is a warning, never a failed job; the `.otel-html/` upload still runs. |
| `deployer-workflow` | `pages-deploy.yml` | The deployer's workflow file, dispatched on the default branch. |
| `dispatch-app-id`, `dispatch-app-private-key` | empty | A GitHub App's ID and private key, to dispatch the deployer with an App token (see Dispatch token). Empty, or a failed mint, dispatches with `token`. |
| `command` | empty | The executable that ran the job (as for setup). Empty uses `otel-html` from the PATH. |
| `config` | empty | Config file for the CI spans report of the update. |
| `token` | `github.token` | Needs `actions: write`. Used for the site update, and for the dispatch unless an App token is minted. |

#### Dispatch token

GitHub refuses a workflow dispatch made with `GITHUB_TOKEN`: the API answers 204, but the run ends in `startup_failure` ("Actor is not allowed to trigger Actions workflows"). The collect and publish actions therefore dispatch the deployer with a GitHub App installation token when you give them one. Create an App with the repository permission Actions: read and write and nothing else, install it on the repository, and store its ID as the variable `DEPLOYER_APP_ID` and its private key as the secret `DEPLOYER_APP_PRIVATE_KEY`. Then pass both to the actions, the key only on a run a person started so that a bot's run (Renovate: dependency code) never holds it:

```yaml
with:
  dispatch-app-id: ${{ vars.DEPLOYER_APP_ID }}
  dispatch-app-private-key: ${{ github.event.sender.type == 'User' && secrets.DEPLOYER_APP_PRIVATE_KEY || '' }}
```

The action mints a token with `actions: write` scoped to this repository alone, only for the dispatch; every other command keeps `token`. Without the two settings (or if minting fails) the dispatch uses `token` as before; `otel-html ci dispatch` then notices the deployer run that ends in `startup_failure` and prints a warning naming it, and the site updates only when `ci-report` ends and on the deployer's five-minute schedule.

#### The publisher and the deployer

Publish from a separate `workflow_run` workflow, which runs the default branch's copy and never the triggering run's code (which may be a fork PR). The deployer is a workflow of its own. [ci-report.yml](.github/workflows/ci-report.yml) and [pages-deploy.yml](.github/workflows/pages-deploy.yml) are the models. In short:

```yaml
# .github/workflows/ci-report.yml
name: ci-report
on:
  workflow_run:
    workflows: [ci]
    types: [completed]
  pull_request_target:
    types: [closed, reopened]
permissions: {}

jobs:
  report:
    # A failed or cancelled run is worth a report; a run that never really ran is not.
    if: >-
      github.event_name == 'workflow_run' && github.event.workflow_run.conclusion != 'skipped' &&
      github.event.workflow_run.conclusion != 'action_required'
    runs-on: ubuntu-latest
    permissions:
      actions: write # the run's artifacts, the update upload, the deployer dispatch
      pages: read # the site's URL
      pull-requests: write # the comment
      checks: write # the check run
    steps:
      - uses: bjstabi/otel-html/.github/actions/otel-html-publish@v0

  cleanup:
    if: github.event_name == 'pull_request_target'
    runs-on: ubuntu-latest
    permissions:
      actions: write
    # No checkout: the action installs the CLI, and this job holds a write token, so it never runs the PR's code.
    steps:
      - uses: bjstabi/otel-html/.github/actions/otel-html-publish@v0
        with:
          cleanup-pr: ${{ github.event.action == 'closed' && github.event.pull_request.number || '' }}
          reopen-pr: ${{ github.event.action == 'reopened' && github.event.pull_request.number || '' }}
```

```yaml
# .github/workflows/pages-deploy.yml
name: pages-deploy
on:
  workflow_dispatch:
  workflow_run:
    workflows: [ci-report]
    types: [completed]
  schedule:
    - cron: "*/5 * * * *"
permissions: {}

jobs:
  # Cheap, outside the `pages` group: is anything pending? An idle tick then never queues an environment job.
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      deployments: read
      pages: read
      pull-requests: read # a private repository: the pull requests of each update's commit
    outputs:
      pending: ${{ steps.plan.outputs.pending }}
    steps:
      - id: otel
        uses: bjstabi/otel-html/.github/actions/otel-html-setup@v0
      - id: pages
        uses: actions/configure-pages@v6
      - id: plan
        env:
          CMD: ${{ steps.otel.outputs.command }}
          GITHUB_TOKEN: ${{ github.token }}
          PAGES_URL: ${{ steps.pages.outputs.base_url }}
        run: |
          # CMD is deliberately unquoted: it may be a command with arguments.
          $CMD ci deploy plan --pages-url "$PAGES_URL" --out "$RUNNER_TEMP/plan/pending.json" \
            --state-out "$RUNNER_TEMP/plan/state" --ci-workflows ci.yml --report-workflow ci-report.yml \
            --deployer-workflow pages-deploy.yml

  deploy:
    needs: plan
    if: needs.plan.outputs.pending == 'true'
    runs-on: ubuntu-latest
    # One pass at a time. A pending run that GitHub cancels for a newer one loses nothing: the newer one lists everything.
    concurrency:
      group: pages
      cancel-in-progress: false
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    permissions:
      contents: read
      actions: write # downloading the updates, pruning artifacts
      deployments: read # the last successful deployment
      pull-requests: read # a private repository: the pull requests of each update's commit
      pages: write
      id-token: write
    steps:
      - id: deploy
        uses: bjstabi/otel-html/.github/actions/otel-html-deploy@v0
        with:
          ci-workflows: ci.yml
```

The `deploy` job runs on the default branch's code (the `schedule` and `workflow_run` triggers always do; a `workflow_dispatch` runs the ref it is dispatched on, so dispatch the default branch). Never re-run a pass; dispatch a new one. Pin the actions to SHAs as this repo does.

The site has the same layout as this repo's: a default-branch run goes to `/branch/<name>/` (rolling, last 30 runs of each workflow) and `/branch/<name>/runs/<run_id>/`; a pull request's runs go to `/pr/<number>/` (rolling, last 10 runs of each workflow) and `/pr/<number>/runs/<run_id>/`. Each holds the runs of every workflow. The sticky comment links this run's report and `All runs on pull request #<number>`, the pull request's rolling report. When the pull request closes or merges, `cleanup` uploads the update that removes `/pr/<number>/`; a reopened pull request lifts the removal with `reopen-pr`. After a merge the default branch's page carries the merged result. Upgrading from a version with per-workflow folders (`/ci/`, `/load/`): the next deployer pass removes them, with no redirect, and the default branch starts over at `/branch/<name>/`.

Pages setup: Settings, Pages, Source: GitHub Actions (`build_type: workflow`), and the `github-pages` environment's deployment branches must allow the default branch. The deployer is the only job that deploys, so it is the only one with `pages: write` and `id-token: write`.

Migrating from the version that pushed to `gh-pages`: add the `pages-deploy.yml` workflow above, give `ci-report.yml` the new publisher example (the publisher drops `deploy`, `preview`, `retention` and `pr-retention`, and `contents: write`), set the Pages source to "GitHub Actions" if it is not, and add `publish: true` to your collect steps if you want reports while runs go on. The deployer's first pass takes the last deployment's Pages artifact as its base, or the `gh-pages` tip when that has expired. The branch is no longer written. Keep it while you may still roll back to the old publisher, which needs it, and delete it once the deployer has run for a few days. A rollback starts from the branch as the migration left it: reports published by the deployer since then are lost, and pull request reports it removed come back until their next cleanup.

Security: the report-producing jobs hold `actions: write`, to dispatch the deployer, instead of `contents: write`. That token can also cancel runs and delete artifacts and caches in the repository. otel-html uses it only to dispatch, and only for a person's same-repository run; bot branches (Renovate) never dispatch. A job's `permissions` cannot be conditional, so the token exists on bot runs too: the design guarantees otel-html does not use it there, not that the dependency code could not. Fork runs get a read-only token whatever you declare. No job can write the site; only the deployer can, and it runs the default branch's code. Every update artifact is untrusted data, a fork's included: the deployer accepts a job's update only from a run of one of its `ci-workflows`, takes the run and the channel from the API instead of the update, and rejects an update that is malformed, too large or disagrees with its own name.

A private repository's Pages site is public unless the organization has Pages access control (GitHub Enterprise Cloud). The reports carry the CI logs, job names and pull request titles, so publishing them makes those public; the action warns when it publishes from a private repository. Use `target: artifact` to keep the reports in the run's artifacts instead.

Nothing in a report is redacted. The job logs come from the Actions API, where GitHub has already masked the secrets it knows about; the jobs' own telemetry (what the commands under `otel-html run` export) is published as sent, so keep secrets out of the spans, logs and metrics your jobs emit.

Publish inputs:

| Input | Default | |
| --- | --- | --- |
| `run-id` | the `workflow_run`'s run, else this run | The run to report on. |
| `version`, `command` | `latest`, empty | As for setup. |
| `config` | the action's own `otel-html-ci.yaml` | The dashboard config for the reports. |
| `target` | `github-pages` | `artifact` uploads the run report as the `ci-run-report` artifact only: nothing reaches the site and nothing is linked. The artifact is a `local` report (about 15 MB) that opens from disk. |
| `comment`, `check` | true | The sticky PR comment and the `otel-html report` check run. |
| `cleanup-pr` | empty | A pull request number: upload the update that removes that PR's reports (`/pr/<number>/`) from the site, instead of publishing. |
| `reopen-pr` | empty | A pull request number: upload the update that lifts that removal (a reopened PR). |
| `deployer-workflow` | `pages-deploy.yml` | The deployer's workflow file, dispatched on the default branch after the upload. A failed dispatch only delays the site. |
| `dispatch-app-id`, `dispatch-app-private-key` | empty | As for collect: the App whose token dispatches the deployer. |
| `token` | `github.token` | Needs `actions: write`, `pages: read`, `pull-requests: write`, `checks: write`. A `cleanup-pr` or `reopen-pr` job needs only `actions: write`. |

Deploy inputs:

| Input | Default | |
| --- | --- | --- |
| `version`, `command` | `latest`, empty | As for setup. |
| `token` | `github.token` | Needs `contents: read`, `actions: write`, `deployments: read`, `pages: write`, `id-token: write`; in a private repository also `pull-requests: read`. |
| `config` | the tool's built-in dashboard | The dashboard config for the rolling reports. |
| `retention`, `pr-retention` | 30, 10 | Runs kept of each workflow per branch page and per pull request page. GitHub Pages sites are limited to 1 GB, so mind the total: about 40 MB per otel-html version still referenced (the shared `assets/<version>/`) plus workflows × (`retention` + open pull requests × `pr-retention`) × your report's data size × 2, the 2 for the rolling reports (each holds its runs' data again). In this repo (reports estimated at about 1.7 MB without the viewer, the format-3 figure; format 4 has not been measured on the site yet) that is about 150 MB for the default branch and 25 MB per open pull request. |
| `preview` | false | Screenshot each default-branch rolling report the pass rebuilt, in light and dark (`preview-light.png`, `preview-dark.png` in its folder), for a README image. Installs Playwright's Chromium, about 1 minute per pass; needs Node and passwordless sudo on the runner. A failed install or screenshot is a warning and the pass goes on. |
| `ci-workflows` | `ci.yml` | Comma-separated workflow files whose jobs upload `push` updates. |
| `report-workflow` | `ci-report.yml` | The workflow file that uploads the run and pull request updates. |
| `keep-deployments` | 3 | Successful deployments whose `github-pages` and site-state artifacts the pass keeps. |
| `update-retention-days` | 90 | Days the pass keeps the artifacts it uploads. |

The deploy action runs on Linux only.

Publish outputs: `report-url` (the URL the deployer will serve the report at; empty when no update was uploaded) and `published` (`true` when an update was uploaded). A run with no page on the site (no open pull request, not the default branch) uploads nothing. Deploy outputs: `deployed` and `page_url`.

GitHub points a check run created with `GITHUB_TOKEN` at the Actions run page, so the report URL is in the check's summary and in the PR comment.

Final-job mode: for a repository with no separate publisher, put the publish action in the last job of the same workflow (`needs:` every other job, `if: always()`) with `actions: write`. That job's own timings are incomplete in the report, and a fork PR's token cannot upload to the base repository, so prefer the `workflow_run` publisher.

### Report format compatibility

`data/` is the model; `assets/` and `index.html` are the viewer. The manifest's `formatVersion` (4 for `local` and `site`; 3 and below for reports an older otel-html wrote) is bumped only for a change an older reader cannot read. This otel-html writes format 4 only (`writer.format` `local`, the default, or `site`). `merge` reads versions 1 to 4; a reader fails fast on a version it does not know. The viewer in this build reads format 4 only: opening a report of format 1 to 3 shows "This report is format N; this viewer reads format 4. `otel-html merge <report> --out <new>` converts it." `upgrade` refuses a report of format 1 to 3 with the same message (see [`src/format/version.ts`](src/format/version.ts)).

- `merge` re-renders any readable report with the current viewer, so reports from different otel-html versions combine into one report in the current format.
- `--append` needs the same otel-html version as the report it appends to.
- `merge` reads every version in `READABLE_FORMAT_VERSIONS`; `upgrade` and the viewer read format 4 only. Frozen format-1 to format-4 reports are in `fixtures/reports/`. The format-1 to format-3 ones are converted by `merge` and the result is opened by the tests; the format-4 one is read as is by `merge` and by `otel-html host`, and by the viewer tests over its manifest and `.parquet.js` wrappers (the e2e opens it after `upgrade`), to hold that.
- Maintainers: every format version a release ships has a frozen report, written by that release, in `fixtures/reports/`, added with its compat test when the release is cut; a version leaves `READABLE_FORMAT_VERSIONS` only together with its fixture.

## Configuration

Config is a YAML or JSON file (`otel-html.yaml` by default), or an object passed to the API. Precedence, lowest to highest: defaults, config file, environment variables, CLI flags or API arguments. Unknown keys are rejected. The JSON Schema for editor autocomplete is [`schema/otel-html.schema.json`](schema/otel-html.schema.json).

| Key | Default | Meaning |
|---|---|---|
| `title` | none | Report title. Env: `OTEL_HTML_TITLE`. |
| `writer.format` | `local` | Report format: `local` (the default) or `site`, which write format 4 (Parquet partitions; `site` is for a published site with shared assets). Closing the report compacts its flush partitions into one sorted partition when there are two or more; if the compaction fails, the failure is logged and the report keeps its flush partitions, still complete and valid. `chunks` (format 3) is no longer written and fails with "format 3 (chunks) is no longer written; use local or site (otel-html merge converts an older report)". Env: `OTEL_HTML_FORMAT`. |
| `writer.rowGroupRows` | 50000 | Rows per Parquet row group in format 4 (50000 to 100000). |
| `writer.statisticsKeys` | `[]` | Extra columns whose statistics are kept per partition file in format 4, beyond those the dashboards and views use. Each entry is a column name, `attr:<key>` (a span, log or metric point attribute) or `resource:<key>` (a resource attribute); a bare attribute key is accepted but matches nothing, so it prunes nothing. |
| `writer.localWarnBytes` | 256000000 | The size, in bytes of Parquet, past which a `local` report warns (once per session) that `--format site` serves large reports better. The base64 scripts a `local` report loads are about a third larger. |
| `writer.compactOnMerge` | `false` | With `merge`: compact each format-4 input's copied partitions into one partition (`merge --compact`). Without it they are copied as they are. |
| `writer.assetsBase` | `assets/` | Where a format-4 report loads the viewer assets from: `assets/`, or a relative path such as `../../assets/0.3.0/`. |
| `writer.chunkTargetBytes` | 4000000 | The size at which held rows are cut into a flush partition (spans, logs and metric points alike); a closed report compacts those flush partitions when there are two or more (see `writer.format`). |
| `writer.flushIntervalMs` | 5000 | Checkpoint interval. Also checkpoints once after this long idle with new records. |
| `writer.dedupeCapacity` | 200000 | Recent span IDs remembered for de-duplication. |
| `writer.facetValueCap` | 1000 | Distinct values kept per column in a partition file's statistics, and the most values the viewer lists per facet key. The report records it in its manifest. |
| `writer.facetKeyCap` | 500 | The most attribute keys the viewer lists in a filtered facet panel. The report records it in its manifest; a report without it uses 500. |
| `writer.drop.traces.span` | `[]` | OTTL conditions; matching spans are dropped at write time. |
| `writer.drop.logs.log_record` | `[]` | Same, for log records. |
| `writer.drop.metrics.datapoint` | `[]` | Same, for metric data points. |
| `receiver.host` | `127.0.0.1` | Address the receiver listens on. |
| `receiver.http.enabled` | `true` | Listen for OTLP/HTTP. |
| `receiver.http.port` | 4318 | OTLP/HTTP port (0 picks a free port). |
| `receiver.grpc.enabled` | `true` | Listen for OTLP/gRPC. |
| `receiver.grpc.port` | 4317 | OTLP/gRPC port (0 picks a free port). |
| `receiver.exportOtlp` | none | Base URL of an OTLP/HTTP collector that every accepted request is also forwarded to (`--export-otlp`). |
| `receiver.maxBodyBytes` | 67108864 | Largest request body accepted, after decompression (64 MiB). Larger requests are rejected (413 / `RESOURCE_EXHAUSTED`). |
| `receiver.inflightBudgetBytes` | 134217728 | Body bytes the receiver holds in progress or queued (128 MiB). A request that would exceed it while another is in progress is refused with 503 / `UNAVAILABLE` so the exporter retries. |
| `viewer.listCap` | 10000 | Maximum rows in result lists. |
| `viewer.defaultDashboard` | `fusion` | The dashboard `g d` and the sidebar's ★ item open. Must be `fusion` or the id of a dashboard in `dashboards`. A config without `dashboards` that leaves it at `fusion` keeps the default of the report it is written into. |
| `viewer.home` | `traces` | Where the report opens: `traces`, `logs`, `metrics` or `dashboards` (the default dashboard). A config that leaves it at `traces` keeps the home page of the report it is written into (or, with `merge`, the first report's). |
| `viewer.theme` | `system` | `system`, `light` or `dark`. The theme a report opens in; a theme the viewer picks themselves is remembered and wins. |
| `dashboards` | `[]` | Dashboards: `{ id, title, description?, variables?, widgets }`. `variables` are resource attribute keys, or `{ key, label?, default? }`. Each widget has `type`, `x`, `y`, `w`, `h` on a 12-column grid, plus `id?`, `title?` and `follow?`, and the fields of its type (`toplist` and `table`: `signal`, `groupBy`, optional `measure` of `count` or, for spans, `duration.sum`, `duration.avg`, `duration.max`, `duration.p95` or `duration.p99`). An `echarts` object on a `metric` or `toplist` widget is merged over the chart option otel-html builds. **It is unstable:** it is passed to ECharts as is, so its compatibility is ECharts', not otel-html's. Treat it as code: ECharts renders string templates such as `tooltip.formatter` as HTML, and the names they fill in come from the telemetry. Ids are lowercase letters, digits and dashes; `fusion` is reserved. Checked when the config loads, with errors at their path (`dashboards[0].widgets[2].query`). A config without `dashboards` keeps the ones of the report it is written into. With `merge`, the dashboards of `--config` win; without them the first report's are kept. |
| `views` | `[]` | Saved views for the explorers' Views menu: `{ id, title, page, query?, text?, mode?, groupBy?, view?, sort?, metrics? }`, where `page` is `traces`, `logs` or `metrics`. |

`OTEL_HTML_CONFIG` selects the config file. `OTEL_HTML_DEBUG=1` makes the CLI print stack traces on errors.

## Limits

- `host` runs one statement at a time (up to 256 at once, the running one included; more are refused 503), cancels a statement at `--timeout` (504) and refuses a result over `--max-result-bytes` (413); a statement whose worker had to be replaced is 504, and 503 when the restart fails. Request bodies over 1 MiB are refused (413). Memory can reach `--max-result-bytes` for each connection that reads its result slowly. It has no TLS or authentication and binds `127.0.0.1` unless `--host` says otherwise, so put it behind a proxy before exposing it. When the address it binds is a loopback one (`127.0.0.0/8`, `::1`, however `--host` spells it, `localhost` included) it answers 403 to a request whose `Host` header is not its own address and port (the port may be left out on port 80; so a page on another site cannot reach it, even through DNS rebinding), and 415 to a query that is not `application/json`; on any other address every `Host` is accepted. It serves the report as it was when `host` started: a report still being written is not followed; restart `host` to see more.
- A report folder reused by many runs grows without bound; start it over with `--replace` now and then. Each `run` is its own trace, told apart by start time and `process.command_args`.
- Times are stored as absolute int64 nanoseconds, but the viewer measures them relative to the report's epoch (`epochUnixNano` in the manifest, the earliest time the report's first data carried) as JavaScript numbers, exact to 2^53 ns. So the window is ±2^53 ns, about 104 days on each side of the epoch: the writer refuses data outside that window (`time-out-of-range`), and `merge` of inputs whose times lie further apart than that succeeds but produces a report the viewer cannot open and a later append refuses ([#216](https://github.com/bjstabi/otel-html/issues/216)).
- The receiver has no TLS or authentication and reflects only localhost origins for CORS; bodies over 64 MiB are refused (413); logs and metric points a sender retries are not deduplicated.
- Forwarding (`--export-otlp`) is OTLP/HTTP only, has no retry, and holds at most 64 requests or 64 MiB of request bodies in memory (a body over 64 MiB is dropped with one warning); what does not fit, fails or is still unsent 5 s after the receiver stops is counted, not delivered.
- Over gRPC a message larger than twice `receiver.maxBodyBytes` is refused by grpc-js before otel-html sees it and is not counted; between the limit and twice the limit it is counted as `too-large`.
- Memory: besides the in-flight budget, `--export-otlp` holds up to 64 requests or 64 MiB of bodies in its queue.
- The in-flight budget (`receiver.inflightBudgetBytes`, 128 MiB) is reserved from `Content-Length`, or as a streamed body inflates, before the body is buffered, so HTTP memory is bounded by the budget plus one body.
- gRPC: a call reserves `maxBodyBytes` of the in-flight budget when it starts, before its message is read, and is refused `UNAVAILABLE` (retryable, counted `busy`) when that would exceed the budget. The reservation is held until the message has been read in full and the handler admits its real size. Each admitted call reserves `maxBodyBytes` but may buffer up to twice that (the grpc-js ceiling) before the handler refuses it as too large, so across connections gRPC memory is bounded by about twice the budget. Each connection is additionally capped by Node's HTTP/2 session memory at that ceiling × its stream limit. Each concurrent call needs `maxBodyBytes` of budget while its message is read, so a budget below twice `maxBodyBytes` lets a connection run only one call at a time (the defaults are exactly twice).
- The viewer is for static reports that open from `file://` (`local`) or a static host (`site`), or that `otel-html host` serves (the host answers the viewer's queries, so the page never loads the engine, and evaluates conditions in SQL only). It does not follow a report that is still being written; reload to see what the receiver has checkpointed.
- Results are never partial: every query runs over the whole report. `site` reports read only the row groups a query needs; `local` reports decode every partition a query touches, so a large `local` report is slower to open and query than the same data as `site` (the writer warns past `writer.localWarnBytes`). Lists stop at `viewer.listCap` rows.
- The trace list's "Latency by service" bar is drawn for traces of at most 10,000 spans. Computing it reads every span of the trace, so a larger trace shows a dash there; its other columns are exact.
- A filter term the viewer cannot turn into SQL is evaluated in the browser, and the page says "evaluated in the browser". Lists then check rows in the browser and page through the matches (at most 8 pages of `viewer.listCap`); charts and counts fetch the candidate rows (at most 200,000) first and join on them. Narrow the filter with a term that has a SQL form when a query reports too many candidates.
- The Metrics Catalog and the Metrics tabs' resource matching read the whole `points` table once per open, so their cost grows with the number of points in the report. Resources are matched by their attributes, so resources that differ only in `schema_url` or dropped attribute count are not told apart.
- A metric chart whose `where` needs evaluating in the browser reads the series it applies to (at most 200,000); above that the query fails with a message asking you to narrow the window or the condition. A query draws at most 5,000 exemplar points and says so when it stops there.
- Text search is a case-insensitive substring match over the same fields as before, where attributes match as their JSON text: keys match too, and a quote inside a value does not match its JSON escaping.
- Dashboard layout edits are not saved: Edit layout changes the page until you reload. Use Copy config and paste the result into your config file.
- The Fusion timeline's metric lane is read from the report's `points` table in one grouped query over the whole report, so it ignores variables and says "all resources" when one is set.
- Log pattern clustering stops creating clusters at 2,000. A message that fits no existing cluster after that stays unclustered, and the Patterns view reports how many.
- The design target for logs is 1,000,000 records in about 200 bytes each on disk. The end-to-end suite builds a 100k-span, 1M-log report to check the landing and a filtered query over one time window (`e2e/scale.spec.ts`, in the Chromium perf pass over HTTP).
- Input files are read in pieces and parsed one resource entry (one element of `resourceSpans`, `resourceLogs` or `resourceMetrics`) at a time, so memory does not grow with file size. Converting 1M logs from 10 files peaks at about 540-575 MB of resident memory through the library (`mise run test:load`), above the 512 MB design target: the library sets no V8 flags, V8 lets the heap grow to 2-3x the live data, and with `--optimize-for-size` the same run peaks at about 243 MB. A single resource entry is still parsed whole, and a protobuf file is read whole before it is decoded, so peak memory still scales with the largest resource entry and with protobuf file size. If one OTLP JSON object repeats a signal key (two `resourceLogs`, say), both arrays are imported. The exception is `--replace` on a folder that already holds a report (a `--replace` conversion, or the first request into a replaced `serve` report): the old report is kept until the first input file or request has been read without error, so everything accepted from it (its held rows) stays in memory until its end. Convert a file that does not fit in memory into an empty folder, or empty the folder first.
- Metrics: `otel-html convert` on 200 metrics × 1,000 series × 360 points (72M points, OTLP JSON, written as 4,800 flush partitions of 15,000 rows and compacted into one 208 MB `points` file) peaks at about 497 MB of resident memory and takes about 53 minutes, within the 512 MB writer target (`mise run test:load`; the `load` workflow runs it on ubuntu; the test allows two hours). Compaction merges the flush partitions in rounds of 16 files, then 8, writing each file as it goes. The same workload fed to `Report.addMetrics` peaks at about 994 MB in about 31 minutes, above the target only because the library sets no V8 flags and V8 lets the heap grow far past the live data (about 90 MB) when no flag restrains it; with `--optimize-for-size`, which the Node CLI sets when metric points arrive, it peaks at about 503 MB but takes about 3,550 s (about 59 minutes), which is slower. Applications that embed the library and need the target can start Node with `--optimize-for-size`. The `serve` and `run` commands set `--optimize-for-size` and `--heap-growing-percent=40` at process start. Writer memory was tracked in [#227](https://github.com/bjstabi/otel-html/issues/227) and partition compaction is tracked in [#210](https://github.com/bjstabi/otel-html/issues/210).
- Receiver: `otel-html serve` takes 1M spans (OTLP/gRPC, paced at 4,000 spans/s) and 1M logs (OTLP/HTTP, one record per request) from telemetrygen into one complete report with nothing rejected, against a design target of 512 MB of resident memory. Measured on format 4 on 2026-11-07 (a 20-thread Intel Core Ultra 7 265K workstation running Node 24, not ubuntu-latest): every span and log was written, 0 requests refused and 0 records rejected, but the peak was 749 MB of resident memory, above the 512 MB target, so the target does not hold on format 4 yet (remeasured on 2026-11-08 after the writer memory fixes of #227: 759 MB, 299 s, event-loop delay p99 61.6 ms and max 874 ms, 13,823 GC pauses totalling 9.8 s; the receiver's memory is not changed by them). The generator ran for 251 s (spans) and 32 s (logs). On the finished report the Traces and Logs landings were interactive in a median of 4,492 ms (over the 3,000 ms budget) and 2,761 ms (Chromium). Memory and the landing are tracked with the writer's memory in [#210](https://github.com/bjstabi/otel-html/issues/210) and [#227](https://github.com/bjstabi/otel-html/issues/227). The figures this section gave before (417 MB, 313 ms and 258 ms) were measured on the chunk writer. Checkpoints are written in the background while requests keep arriving, because a sender's batch span processor (2,048 spans by default) drops spans when the receiver stalls for about half a second. The load job also prints serve's event-loop delay (p99 and max) and GC pauses, so a red run shows why spans dropped. From `mise run test:load:receiver` (the `receiver` job of the `load` workflow).
- Metric values, counts and sums are 64-bit floating point once read, as in Prometheus: an integer point (`asInt`) or a count above 2^53 loses precision.
- The flame graph merges very narrow bars in traces above 2000 spans and clips anything deeper than 200 levels.

## Development

Clone with `git clone --single-branch https://github.com/bjstabi/otel-html.git` (about 4 MB of git data). A plain clone also fetches the `gh-pages` branch, the published report site (about 150 MB), which development never needs. `--single-branch` fetches `main` only; to fetch every other branch too but still not `gh-pages` (git 2.29 or later), run `git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'` and then `git config --add remote.origin.fetch '^refs/heads/gh-pages'`. An existing clone drops the site the same way: add that second refspec, delete the branch (`git branch -rd origin/gh-pages`, and `git branch -D gh-pages` if you ever checked it out), then `git reflog expire --expire=now --all` and `git gc --prune=now`, while no other git command runs. The last two also discard every reflog (the way back from a recent reset or rebase) and other unreachable objects, such as dropped stashes.

Tasks are defined in `mise.toml`; CI runs the same ones. The `linux-x64`, `linux-arm64` and `windows-x64` binaries are built and smoke-tested on every PR by the `binary` job (`test/cli/binary.test.ts` against the compiled binary: `convert`, `serve` over HTTP and gRPC, `host` answering one Arrow query, `ci context`, `run`, a SIGINT exit 0 and a bad-port exit 2), and a step that runs the binary outside the checkout (site and local conversions, a compaction, `host`); the release workflow smoke-tests the artefacts it uploads. Tasks with `sources` are skipped while up to date; `mise run --force <task>` overrides.

### Test and viewer spans

The test suites trace themselves. Spans are exported only when an OTLP endpoint is configured (`OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), for example by running under `otel-html run`, as CI's job shell does; `OTEL_SDK_DISABLED=true` turns it off. The protocol comes from `OTEL_EXPORTER_OTLP_PROTOCOL` (`http/protobuf` by default, `http/json` or `grpc`). Test spans carry `service.name` `otel-html-tests`, or `OTEL_HTML_TEST_SERVICE_NAME` when set; the inherited `OTEL_SERVICE_NAME` is ignored.

- **vitest:** its built-in (experimental) OpenTelemetry support, with vitest's own span names (`vitest.test_run`, `vitest.test.runner.run.suite`, `vitest.test.runner.run.test`, hooks, module imports), parented to `TRACEPARENT`, which mise sets per task.
- **Playwright:** one span per test (`test.case.name`, `test.case.result.status`, ...) under `TRACEPARENT`. The viewer's own spans (`viewer.load`, `viewer.script.load`, `viewer.query`, `viewer.navigate`, resource `service.name=otel-html-viewer`) are exported under each test's span, except for `@perf` tests, `scale.spec.ts`, `load.spec.ts` and the hostile-content report (`hostileTest`), and at most 2 000 per test.
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

Build the e2e fixture reports into e2e/.reports/ and their site copies into e2e/.reports-site/ (skipped while up to date)
All but `scale` and `many`, which e2e:fixtures:scale builds; about a second after `build`.

## `e2e:fixtures:scale`

- Depends: e2e:fixtures:scale:data

- **Usage:** `e2e:fixtures:scale`

The e2e `scale` and `many` reports with the current viewer (only e2e/scale.spec.ts reads them)
Depends on e2e:fixtures:scale:data; `otel-html upgrade` then swaps in the current dist/viewer (~0.3 s, every run: a
freshness record of its own could miss a viewer that :data wrote in between), so a viewer change never converts again.

## `e2e:fixtures:scale:data`

- Depends: build

- **Usage:** `e2e:fixtures:scale:data`

Write the e2e `scale` and `many` reports (site format) into e2e/.reports-scale/ (skipped while up to date)
100k spans and 1M logs, converted once (`scale`) and written through the library in 100 flushes (`many`) (~1 GB of memory). Its sources are the writer's build output,
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

protobuf-es, the config schema, the OTTL grammar and docs/format/schema.md; also rewrites the README's generated task section
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
`<browser>-perf-file` and `<browser>-perf-http` projects (@perf tests) alone with one worker. Only Chromium has `-http` and the perf projects, and
Firefox and WebKit leave out e2e/scale.spec.ts (playwright.config.ts). Both passes run; the task fails if either does.
The perf pass is skipped for a browser without a `-perf-file` project. The perf pass writes its artifacts to test-results/perf, so it does not clear the first pass's failures. Playwright args after `--` go to both passes (`mise run test:e2e --browser chromium -- e2e/scale.spec.ts`);
narrow the browsers with `--browser`, not `--project`, which would add to the two passes' own projects.
The scale reports (e2e:fixtures:scale, ~15 s cold, ~35 s on CI) are built only when the selection includes e2e/scale.spec.ts, decided
by `playwright test --list` with the same args; a direct `playwright test e2e/scale.spec.ts` needs that task run first.
Browsers are installed first unless OTEL_HTML_SKIP_BROWSER_INSTALL is set (CI's Playwright image has them).
The metrics scale check runs only with OTEL_HTML_METRICS_SCALE=1 (CI runs it in its own Chromium job): it writes a
site-format report of 200 metrics x 1,000 series in which only the charted metric has the full 1 h at 10 s (a few
seconds locally, under a minute on CI, in e2e/.metrics-scale/), serves it over HTTP (the `chromium-perf-http` project),
and fails if the Explorer or Catalog asks for `points.parquet` without a Range header.
The @perf budgets scale by OTEL_HTML_PERF_FACTOR and, when OTEL_HTML_PERF_REFERENCE_MS is set (CI: 100), by how
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

tsc on the node, viewer, viewer-data and e2e projects

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
