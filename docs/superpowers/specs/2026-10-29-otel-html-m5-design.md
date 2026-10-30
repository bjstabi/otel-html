# otel-html M5: Receiver, `serve`, `run`, SDK exporters and load tests design

Date: 2026-10-29 · Status: draft for approval

Builds on the main design, [`2026-10-25-otel-html-design.md`](2026-10-25-otel-html-design.md) (§2, §5, §6, §7.5, §7.6, §10, §11.2, §14, §16). Everything there still holds unless this document narrows it. The M1–M4 plans set the conventions (`docs/superpowers/plans/`).

## 1. Intent

M5 adds the live ways in. After M5 a test suite, a batch job or a browser can send OTLP to otel-html as it runs, with no file in between, and a Node program can hand its SDK's spans, logs and metrics straight to a report:

- an **OTLP receiver** (OTLP/HTTP, then OTLP/gRPC) that feeds the existing writer session as requests arrive;
- `otel-html serve`, which receives until SIGINT/SIGTERM and then finishes the report;
- `otel-html run -- <cmd…>`, which starts the receiver, launches a command with the standard `OTEL_EXPORTER_OTLP_*` variables and a `TRACEPARENT`, wraps the command in a root span, and exits with the command's exit code;
- the **SDK exporters** `OtelHtmlSpanExporter`, `OtelHtmlLogRecordExporter` and `OtelHtmlMetricExporter`;
- the **load workflow** (`load.yml`): telemetrygen → receiver at about 1M spans and 1M logs (telemetrygen sends one record per request, so 1M requests), asserting bounded writer memory and the viewer's landing time on the result.

Today every input is a file or an in-process object (`convert`, `Report.addSpans` with SDK spans). The writer session (§7.5) already streams, checkpoints at every flush and rewrites the manifest atomically, so a report opened mid-run shows what has arrived (§7.6). The lock's hint already points at `otel-html serve`.

## 2. Goals, non-goals, anti-goals

**Goals**
- OTLP/HTTP per the OTLP spec (§6): `POST /v1/traces`, `/v1/logs`, `/v1/metrics`; JSON and protobuf bodies; gzip or uncompressed; the response encoded like the request; partial-success responses with `rejected_*` counts; the retryable statuses only (503 with `Retry-After` when the writer is behind; nothing else retryable); a 64 MiB post-decompression limit answered with 413; CORS for localhost browser telemetry.
- OTLP/gRPC with the same semantics through `@grpc/grpc-js`: `UNAVAILABLE` with `RetryInfo` when behind, `INVALID_ARGUMENT` for bad data, `RESOURCE_EXHAUSTED` over the size limit.
- One receiver core shared by both transports, wrapping one writer session: a request is fed one resource entry at a time, so one bad entry rejects only itself.
- `serve` and `run` as in §5, with the writer's lock, append and checkpoints unchanged.
- Exporters that implement the SDK interfaces (`SpanExporter`, `LogRecordExporter`, `PushMetricExporter`) over a `Report`, with the SDK → OTLP mapping checked against `@opentelemetry/otlp-transformer`.
- The load workflow measures the receiver at scale and the viewer on its output.
- The standalone binary serves OTLP/HTTP; it serves gRPC too if `@grpc/grpc-js` works under Bun (§10's early risk), else it says so.

**Non-goals (M5)**
- Live "following" in the viewer (§15). The viewer still shows a report as of its last checkpoint and says it is unfinished.
- TLS, authentication, rate limiting beyond backpressure, and request tracing headers. The receiver is for localhost and CI networks (deferred with the hosted service, §2).
- Deduplication of logs or metric points (§16).
- Honouring `OTEL_EXPORTER_OTLP_*` for the receiver's *own* listen address. Those variables describe where an SDK sends; `run` sets them for the child.
- A Collector-style file tailing mode (`convert` on file-exporter output covers it, §4).

**Anti-goals**
- A second ingestion path: both transports and all three exporters go through `WriterSession.add` exactly as `convert` does (§7.5).
- Silently accepting bad data: a resource entry the writer rejects is counted in `rejected_*` with the writer's own message, and a request whose every entry is rejected fails with 400 / `INVALID_ARGUMENT`.
- Unbounded memory under a fast sender: bodies are capped, in-flight bytes are budgeted, and the sender is told to retry.

## 3. Constraints

- Every rule from the main spec §11.1 and the M1–M4 Global Constraints.
- Two new runtime dependencies: **`@grpc/grpc-js`** (named in §10; the newest 1.x release at least two weeks old, pinned) and **`@opentelemetry/resources`** (already a devDependency; `run` uses its env, host and process detectors). The SDK packages the exporters implement (`@opentelemetry/sdk-trace-base`, `sdk-logs`, `sdk-metrics`, `core`) stay type-only imports and become **optional peer dependencies**; the built library imports nothing from them at runtime.
- `src/receiver/`, `src/exporters/`, `src/run/` and the new CLI commands are Node-side modules. They are not added to Biome's `noNodejsModules` override. Nothing in the viewer changes.
- No `formatVersion` bump. The manifest is unchanged.

## 4. Approaches (decided: 1)

1. **One receiver core over the writer session; thin transports (chosen).** `node:http` and `@grpc/grpc-js` each parse their framing, hand the body bytes and encoding to the core, and map the core's outcome to their status vocabulary from one table. `serve` and `run` compose the core with the transports; the exporters call the `Report` methods directly. One place decides what is accepted, rejected or retried.
2. **Transport-specific receivers.** Each transport decodes and feeds the writer itself. Less indirection, but the partial-success and backpressure rules would live twice.
3. **gRPC over Connect (`@connectrpc/connect-node`).** One server would speak gRPC, gRPC-Web and Connect. Rejected: the spec names `@grpc/grpc-js`, and the extra protocols have no OTLP sender.

## 5. Receiver

### 5.1 Core
- `createReceiver(session, options, deps)` wraps a `WriterSession`. `receive(signal, body, encoding, source)` decodes `body` (`'json'` or `'protobuf'`) into one request per resource entry (`OtlpJsonStream` and `streamOtlpProtobuf`, the readers `convert` uses), adds each with `{ partial: true }`, then calls `endInput()`. An entry that fails with `invalid-otlp` or `time-out-of-range` is **rejected**: its record count (spans, log records or data points) is added to `rejected`, the first such message is kept as `errorMessage`, and the remaining entries are still added. Any other failure (a write error) propagates as `internal`.
- The result is `{ accepted, rejected, errorMessage }`. The transport answers success with the signal's `Export…ServiceResponse`, filling `partial_success` only when `rejected > 0`. When every entry of a non-empty request is rejected, `receive` throws `invalid-otlp` with that message, and the transport answers 400 / `INVALID_ARGUMENT`.
- A body that does not decode at all (bad JSON, a protobuf that does not parse, a JSON object carrying another signal's key, or `resourceSpans` not an array) is `invalid-otlp`. An empty body, `{}` or `{ "resourceSpans": [] }` is a success with nothing accepted.
- **One receive at a time:** the session's `partial` flag is session-wide, so the core runs receives through its own queue: a whole request's adds and its `endInput()` never interleave with another request's. The writer is single-threaded anyway, so this costs no throughput; the in-flight budget below bounds the queue.
- **Epoch and time:** the first accepted request fixes the report's epoch; offsets are signed, so earlier data (including `run`'s root span, added last but started first) is fine. Only a timestamp more than about 104 days from the epoch is `time-out-of-range` (a bad clock), and rejecting that entry is right. `add` is all-or-nothing per entry: a rejected entry leaves nothing behind except possibly the epoch, which is harmless.
- **Backpressure:** the core tracks the body bytes (after any decompression) of requests in progress or queued. A transport reserves them before buffering the body, from `Content-Length` or as a streamed body inflates (gRPC can only do so once grpc-js has buffered the message). A request that would push the total above `receiver.inflightBudgetBytes` while another is in progress is refused as `receiver-busy` before buffering (503 + `Retry-After: 1` / `UNAVAILABLE` + `RetryInfo` 1 s). A single request up to the body limit is always allowed when nothing else is in flight.
- **Closing:** `close()` stops accepting (`receiver-busy` too, so a late sender retries elsewhere or gives up) and waits for the receives in progress. It does not close the session: `serve` and `run` own the report.
- **Counters:** `stats()` returns requests, accepted and rejected per signal, and body bytes, for the CLI's summary line and the self-telemetry span attributes.

### 5.2 OTLP/HTTP (`node:http`)
- `POST` on `/v1/traces`, `/v1/logs`, `/v1/metrics`. Another path is 404, another method 405 (with `Allow: POST, OPTIONS`).
- `Content-Type` `application/x-protobuf` or `application/json` (parameters such as `charset` ignored); anything else, or none, is 415. `Content-Encoding` absent, `identity` or `gzip`; anything else is 415. The body is decompressed as a stream and counted: past `receiver.maxBodyBytes` (default 64 MiB) the request is answered 413 and the connection closed. A `Content-Length` above the limit is 413 before reading.
- Errors carry a `google.rpc.Status` (`code`, `message`) in the request's encoding (JSON `{ "code": 3, "message": "…" }`, or the protobuf message), per the OTLP spec. The `code` is the gRPC code the table in §5.4 gives.
- CORS: an `Origin` of `http://localhost`, `http://127.0.0.1` or `http://[::1]` (any port, `https` too) is reflected in `Access-Control-Allow-Origin` with `Vary: Origin`; a preflight `OPTIONS` is answered 204 with `Access-Control-Allow-Methods: POST`, the requested headers reflected in `Access-Control-Allow-Headers` (default `Content-Type, Content-Encoding`), and `Access-Control-Max-Age: 600`. Any other origin gets no CORS headers.
- Node's default header and request timeouts stay. No TLS.

### 5.3 OTLP/gRPC (`@grpc/grpc-js`)
- One `Server` with the three services. The service definitions are built from the protobuf-es `GenService` descriptors (`TraceService`, `LogsService`, `MetricsService`): the request deserializer hands the raw bytes to the core (so entries stream exactly as over HTTP), and the response serializer is `toBinary` of the response schema.
- `grpc.max_receive_message_length` is `receiver.maxBodyBytes`; grpc-js's built-in gzip and deflate decoding stays on.
- Status mapping is the §5.4 table. `UNAVAILABLE` carries `grpc-status-details-bin` with a `google.rpc.Status` holding a `RetryInfo` of 1 s. `google/rpc/status.proto` and `error_details.proto` join `proto/` and are generated with the rest.
- Insecure credentials only.

### 5.4 Outcomes (a data table)

| Outcome | Raised by | HTTP | gRPC |
|---|---|---|---|
| success, possibly partial | core | 200 + response | `OK` + response |
| invalid (undecodable, or every entry rejected) | core, `invalid-otlp` | 400 | `INVALID_ARGUMENT` |
| too large | transport (HTTP counts while inflating; grpc-js raises its own) | 413 | `RESOURCE_EXHAUSTED` |
| unsupported media or encoding | HTTP only | 415 | – |
| not found / method | HTTP only | 404 / 405 | – (`UNIMPLEMENTED` is grpc-js's own) |
| busy or closing | core, `receiver-busy` | 503 + `Retry-After: 1` | `UNAVAILABLE` + `RetryInfo` |
| internal (a write failed) | core, any other error | 500 | `INTERNAL` |

Only busy/closing is retryable, as §6 requires.

### 5.5 Library surface
- `startReceiver(report, overrides?)` is the Node-side composition root: it reads `receiver` from the report's resolved config, applies the overrides (`http`, `grpc`: `{ host?, port? }` or `false`; `maxBodyBytes`, `inflightBudgetBytes`), binds the listeners, and returns `{ http, grpc, stats(), close() }`, where `http` is `http://host:port` or `null` and `grpc` is `host:port` or `null`. Port `0` binds an ephemeral port and the returned address says which. `close()` stops listening and drains; the caller closes the report.
- It is exported from the package with its types, next to `Report`.

## 6. Config

`receiver` joins the one schema (§11.1): `host` (default `127.0.0.1`), `http: { enabled: true, port: 4318 }`, `grpc: { enabled: true, port: 4317 }`, `maxBodyBytes` (default 67108864) and `inflightBudgetBytes` (default 134217728). Ports are integers 0–65535. `config print` shows them like any other key, and the JSON Schema is regenerated. No environment bindings are added (see non-goals).

## 7. CLI

### 7.1 `serve`
`otel-html serve -o <dir> [--host <addr>] [--http <port>] [--no-http] [--grpc <port>] [--no-grpc] [--config <file>] [--title <title>] [--append]`. The flags are the flag layer of `receiver.*`. On start it prints one line with the bound addresses, e.g. `listening on http://127.0.0.1:4318 (OTLP/HTTP) and 127.0.0.1:4317 (OTLP/gRPC), writing ./report; press Ctrl-C to finish`. On SIGINT or SIGTERM it stops listening, drains, closes the report, and prints the usual `wrote …` summary plus `received N requests (M rejected)`. A second signal while finishing exits immediately with 130; the report stays at its last checkpoint, viewable and marked unfinished. Disabling both transports is a usage error. Signals reach the command through a new `signals` port on `CliIo`, so tests send them.

### 7.2 `run`
`otel-html run -o <dir> [the serve flags] -- <cmd> [args…]`.
- Starts the receiver, then spawns the command with `stdio` inherited and the environment extended by `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL` and `TRACEPARENT`. The protocol is the user's `OTEL_EXPORTER_OTLP_PROTOCOL` if set (`grpc`, `http/protobuf` or `http/json`), else `http/protobuf`, and the endpoint follows it (`http://host:httpPort` or `http://host:grpcPort`); a protocol whose transport is disabled is a usage error. Variables the user already set are not overwritten, except `TRACEPARENT`.
- The **root span**: name = the command's basename, kind `INTERNAL`, a random 16-byte trace id and 8-byte span id (sampled flags `01`), start at spawn, end at exit. Attributes: `process.command_args` (the full argv), `process.executable.name`, `process.pid`, and `process.exit.code` when the child exited; a child killed by a signal gets status `ERROR` with message `killed by SIG…`, a non-zero exit gets status `ERROR` with message `exit code N`, and zero leaves the status unset. The resource comes from `@opentelemetry/resources`' env, host and process detectors; when none of them sets `service.name`, it is the command's basename.
- Exit code: the child's; `128 + signal number` when it was killed. If the child succeeded but the report failed to finish, 1 with the error printed.
- SIGINT/SIGTERM are forwarded to the child; `run` itself keeps waiting for it. After the child exits the receiver stops accepting, drains, the root span is added, and the report closes.

### 7.3 The CLI's composition root
`main.ts` wires `process.on` for the signals port and `node:child_process`' `spawn`. The program and commands take them through `CliIo`, so the CLI tests use the memory file system as today while the receiver binds real ephemeral ports on localhost.

## 8. Exporters

- `new OtelHtmlSpanExporter({ report })`, `new OtelHtmlLogRecordExporter({ report })`, `new OtelHtmlMetricExporter({ report, temporality?: 'cumulative' | 'delta' })`, in `src/exporters/`, exported from the package.
- `export(batch, callback)` calls `report.addSpans` / `addLogs` / `addMetrics` and reports `SUCCESS`, or `FAILED` with the error. `forceFlush()` and `shutdown()` call `report.flush()`; after `shutdown()` every `export` fails. **The caller closes the report**: three exporters usually share one, and `Report.close()` is already the API's explicit end (the spec's "close on shutdown" is narrowed to a flush, so a shared report is never closed under another exporter).
- The metric exporter's `selectAggregationTemporality` returns the configured temporality for every instrument (cumulative by default).
- Mappings: `readableSpansToRequest` exists; `readableLogRecordsToRequest` (`src/model/sdk-logs.ts`) and `resourceMetricsToRequest` (`src/model/sdk-metrics.ts`) are new, grouping by resource and scope, covering every point kind (sum, gauge, histogram, exponential histogram) and both temporalities. Each is tested against the matching `@opentelemetry/otlp-transformer` JSON serializer as the oracle, like `sdk-spans`.

## 9. Load workflow

`load.yml` gains a `receiver` job beside `load` (same trigger rule): build, start `otel-html serve` on both transports with the process's peak RSS reported on exit, send **1M spans over gRPC, paced at 500 spans/s per worker (250 traces/s) so telemetrygen does not drop them, and 1M logs over HTTP** (one record per request, so 1M requests) with `telemetrygen` from its official container (`ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen`, pinned; `docker run --network host`), send SIGINT, and assert: peak RSS under 512 MB, the manifest complete with exactly the sent totals, zero rejected. Then Playwright (Chromium only, installed on the bare runner) opens the report and asserts the Traces and Logs landings are interactive within 3 s × factor, as the scale spec does. The driver is `scripts/load-receiver.ts`, run by `mise run test:load:receiver`; the browser check is `e2e/load.spec.ts`, gated by `OTEL_HTML_LOAD_REPORT=<dir>`.

## 10. Binary and CI

- `test/cli/binary.test.ts` gains a `serve` smoke: start the binary on ephemeral ports, post one span over HTTP and one over gRPC, SIGINT, and check the report. If gRPC does not work under Bun, the binary disables it by default, `--grpc` in the binary is a usage error that names Node as the way to get gRPC, and the README says so; the task's report says which happened.
- Dogfooding (§11.2): each e2e matrix job already downloads `dist/`, so it runs the Playwright suite under `node dist/cli/main.js run -o e2e/.reports/ci-<project> --no-grpc -- …` (HTTP on 4318; Playwright's own static server uses another port) and uploads that report as an artifact.
- README: `serve` and `run` sections, the exporters and `startReceiver` in the library section, the `receiver.*` rows in the config table, Limits (no TLS or auth; localhost CORS; the 64 MiB limit; logs are not deduplicated on retry), the load task in Development, and "M5 (done)" in the Roadmap.

## 11. Designer's calls (flag if wrong)
- Partial success is per **resource entry**, the writer's existing unit of all-or-nothing, not per record.
- Records dropped by `writer.drop` and duplicate spans count as accepted (the server chose to discard them), so `rejected_*` means "could not be accepted" as the OTLP spec defines it.
- Backpressure is a bytes-in-flight budget answered with 503/`UNAVAILABLE`, never 429.
- CORS reflects localhost origins only.
- The exporters flush on `shutdown()` and never close the report.
- `run` names the root span after the command's basename and defaults `service.name` to it.
- `run` does not wait after the child exits: an SDK that has not flushed by then loses its tail (the SDKs flush on shutdown; document it).
- Receiver listen settings are config/flags only; no new environment variables.
- The load workflow's telemetrygen counts are per worker (`--traces` and `--logs` are per-worker counts); the driver sets workers and counts to hit the totals exactly and asserts them.

## 12. Left to the builder
Exact grpc-js server options, header parsing details, the summary line wording, the `telemetrygen` version and flags, whether the receiver's self-telemetry span wraps the whole `serve` or each request (one per `serve`/`run` with the counters as attributes is enough), and the plan's task order.
