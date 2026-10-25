# otel-html

otel-html turns OpenTelemetry data into a static, self-contained HTML report. You give it OTLP files (or feed it spans from your own code) and it writes a folder you can open from disk, attach to a CI run, or publish on any static host. No server and no network access are needed to view it.

Milestone 1 covers traces: a Traces explorer with a trace panel (flame graph, waterfall, span list, services, span details). Logs and metrics are accepted and stored, but their explorers are not built yet (see [Roadmap](#roadmap)).

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
sha256sum --check --ignore-missing SHA256SUMS
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

Combines report folders into a new one, for example the reports of parallel CI jobs. It reads each report's data chunks, so it works across otel-html versions.

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
| `writer.drop.traces.span` | `[]` | OTTL conditions; matching spans are dropped at write time. |
| `writer.drop.logs.log_record` | `[]` | Same, for log records. |
| `writer.drop.metrics.datapoint` | `[]` | Same, for metric data points. |
| `viewer.eagerBudgetBytes` | 75000000 | Decoded size under which the viewer loads everything up front. Env: `OTEL_HTML_EAGER_BUDGET_BYTES`. |
| `viewer.listCap` | 10000 | Maximum rows in result lists. |
| `viewer.theme` | `system` | `system`, `light` or `dark`. |

`OTEL_HTML_CONFIG` selects the config file. `OTEL_HTML_DEBUG=1` makes the CLI print stack traces on errors.

## Limits

- Timestamps are JavaScript numbers, exact to 2^53 ns. That is about 104 days of relative time span within one report.
- The viewer is for static reports that open from `file://`. It does not follow a report that is still being written.
- When a report is larger than `viewer.eagerBudgetBytes`, windowed Services numbers are partial (the viewer labels them) until you run a scan.
- The flame graph merges very narrow bars in traces above 2000 spans and clips anything deeper than 200 levels.

## Development

Tasks are defined in `mise.toml`; CI runs the same ones.

| Task | Does |
|---|---|
| `mise run setup` | Install dependencies and git hooks. |
| `mise run check` | Fast gate: lint, typecheck, unit tests, knip. |
| `mise run build` | Build the library, then the viewer, into `dist/`. |
| `mise run test:e2e` | Build, then run the Playwright suite in Chromium, Firefox and WebKit. |
| `mise run build:binaries` | Compile standalone binaries into `dist/bin/` (after `build`). |
| `mise run fixtures` | Regenerate `fixtures/*.otlp.json` with the OpenTelemetry SDK. |
| `mise run demo` | Convert `fixtures/small.otlp.json` and open it in a browser. Not for CI. |

Other tasks: `lint`, `format`, `typecheck`, `test:unit`, `knip`, `gen`, `gen:check`, `check:package`, `test:e2e:chromium`.

## Roadmap

- M2: Logs explorer and log panel, with log and trace cross-linking.
- M3: Metrics explorer and catalog, with embedded metric charts in all panels.
- M4: Dashboards, including the built-in Fusion dashboard, and dashboard config.
- M5: OTLP receiver (HTTP, then gRPC), `serve` and `run` commands, SDK exporters and load tests.

The design is in [`docs/superpowers/specs/2026-10-25-otel-html-design.md`](docs/superpowers/specs/2026-10-25-otel-html-design.md).
