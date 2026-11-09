# Format 4 Host Implementation Plan (plan 4 of the format-4 spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `otel-html host <report>` serves a format-4 report over HTTP and answers the viewer's SQL through Mosaic's REST connector protocol from a locked-down DuckDB engine in a Node worker, so a report that is too large to ship to a browser is queried where it lives; the viewer picks that path from a `<meta>` tag the host writes and otherwise changes nothing.

**Architecture:** `src/host/` is new and has three parts. `engine.ts` starts DuckDB-WASM's Node async build (the same `duckdb.<v>.wasm` the viewer ships, with the two Node bindings files added to `dist/viewer/assets/`) in a `worker_threads` Worker behind a small Web-Worker shim, registers every partition file under its manifest path (`NODE_FS`, range reads), creates the five views with `viewStatements(manifest, (p) => p)` exactly as the viewer does, applies the engine policy (extension autoload off, `enable_external_access = false`, `lock_configuration = true`) and then runs one client statement at a time as a pending query (polled, so a statement timeout can cancel it; a worker that stops answering is replaced). `server.ts` is a `node:http` server: `POST /query` takes Mosaic's `{ type: 'arrow', sql }` and answers Arrow IPC bytes (the client's SQL wrapped as `SELECT * FROM (<sql>) AS otel_host`, so DDL, DML, `SET`, `LOAD` and multi-statement requests are parser errors); it serves the host's own viewer shell and assets, and the report's `data/manifest.js`, and nothing else. `src/cli/commands/host.ts` is the command. In the viewer, `main.tsx` reads `<meta name="otel-html-host">`, `openReport` skips the engine and partitions and builds the data source over `restQueryEngine` (mosaic-core's `restConnector` behind the D19 `QueryEngine` seam); the D5 temp table is the one thing a served engine cannot do, so `QueryEngine` gains `tempTables: boolean` and the data sources refuse a residual aggregate before fetching its candidates.

**Tech Stack:** TypeScript (strict), `@duckdb/duckdb-wasm` 1.32.0 (devDependency, R47: the host loads its Node build by path from the shipped assets, never by import), `@uwdata/mosaic-core` 0.35.0 (`restConnector`, viewer only), `node:http`, `node:worker_threads`, vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md` §8 (and §7.1 for the connector, §7.4 for the views as the contract, §11 milestone 4), read with the "Record" sections at the end of `docs/superpowers/plans/2026-11-07-format-4-viewer.md` ("Notes for plan 3", R60 to R92) and `docs/superpowers/plans/2026-11-08-format-4-metrics.md` ("Notes for plan 4", R93 to R114); the records win over the spec. The builder check this plan rests on ran on 2026-11-09 against the installed engine; its findings are in "Decisions this plan makes" (D35 to D37).

**Process:** unattended (`docs/agents/process-unattended.md`); PRs target `feat/format-4`, the next PR branches from the updated `feat/format-4`. Implementers and task reviewers on Sonnet 5.5, the branch review on Opus 5.5; each review's summary names its model. Stop-and-ask points: Task 2.4 if the Bun binary cannot run the engine worker (D44); Task 4.1 if the host's measured median exceeds the browser engine's budget on the same report (D50). Nothing in this plan touches `ci.yml` beyond adding `host` to the binary smoke test's assertions (R81's class of change), `release.yml`, the publisher or anything with a write token.

## Decisions this plan makes

The spec leaves these to the builder (§8 "the builder measures and picks the default", §15) or states something the engine makes impossible. Each is applied where named; the maintainer can object at review. Numbering continues plan 3's D20 to D34.

- **D35 The engine is DuckDB-WASM's Node async build in a worker; no native dependency.** `duckdb-node.cjs` (35 KB, the `AsyncDuckDB` bindings) and `duckdb-node-eh.worker.cjs` (1.25 MB, the worker) ship in `dist/viewer/assets/` as `duckdb.<v>.node.cjs` and `duckdb.<v>.node.worker.cjs` beside the `duckdb.<v>.wasm` the viewer already ships (it is the same `duckdb-eh.wasm`), copied by `scripts/engine-assets.ts`, excluded from reports by `ENGINE_ASSET_RE`, and embedded in the binaries like every other asset. The host loads the bindings at run time with `createRequire` from a path and types them through a local interface (as `test-support/duckdb-node.ts` does), so `src/` has no `@duckdb/duckdb-wasm` import, the scaffold test's dependency rule holds and R47 stands. The worker is `new Worker(code, { eval: true, workerData: { mod } })` where `code` is a 12-line Web-Worker shim (an `EventTarget` as `self`, `postMessage` to `parentPort`, incoming messages dispatched to `onmessage`) that `require`s the DuckDB worker file: duckdb-wasm's own Node path needs the `web-worker` package, which is not added. `@duckdb/node-api` as an optional peer (spec §8) is not added in this plan: Task 4.1 measures the WASM host against the browser engine on the `scale` report and files an issue with the figures if the native engine is worth it (D50).
- **D36 Files and views as the viewer has them.** Each partition file is registered under its manifest path (`data/partitions/<p6>/<table>.parquet`) with `registerFileURL(path, <absolute path>, DuckDBDataProtocol.NODE_FS, false)`, so DuckDB range-reads it from disk and no file is loaded whole; the views are `viewStatements(manifest, (p) => p)` (`src/query/sql/views.ts`), so `filename` values equal the manifest paths the browser prunes with (plan 3's note 1). Both output formats serve: the host reads `.parquet` only. The parquet and json functions are built into this engine build (verified: `read_parquet` and `json_extract_string` answer with `autoload_known_extensions = false` and no `LOAD`), so the host loads no extension.
- **D37 The engine policy, as verified.** After the views, before the listener opens, on the one connection: `SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET allowed_directories = ['data/partitions/']; SET enable_external_access = false; SET lock_configuration = true`. Verified on the installed engine: afterwards `read_csv('/etc/passwd')`, `read_parquet('<absolute path>')`, `COPY ... TO`, `ATTACH`, `LOAD httpfs`, `LOAD icu` and every `SET` are refused with a `Permission Error` or `Invalid Input Error`, at once (a `LOAD` of an extension the build lacks hangs the worker for good when it runs *before* the policy, which is why the order is fixed), while `SELECT count(*) FROM spans` still reads the registered files. The spec's "opened read-only" cannot be done for an in-memory database, and `CREATE TABLE`, `CREATE TEMP TABLE`, `CREATE VIEW` and `SET VARIABLE` still succeed in memory after the policy, so the server wraps every client statement as `SELECT * FROM (\n<sql>\n) AS otel_host`: a DDL, DML, `SET`, `PRAGMA`, `LOAD` or second statement inside the parentheses is a parser error (verified), and `ORDER BY` inside the subquery is kept (verified on 10 and 100,000 rows). Only `type: 'arrow'` requests are run; `exec` and `json` are refused (spec §8: the views are the only DDL). The policy is a test, not a comment (Task 1.3).
- **D38 Statements run as pending queries, one at a time.** `startPendingQuery(conn, sql, false)` returns the IPC schema message or `null`; while `null`, `pollPendingQuery` executes a slice and is the point where `cancelPendingQuery` interrupts (verified: a long query cancelled at 429 ms after 3 polls, the connection answered the next statement in 2 ms); once the header is in, `fetchQueryResults` yields the record-batch messages until `null`, and their concatenation is the Arrow IPC stream the response carries (verified: 250,000 rows in 124 chunks, 4.0 MB, decoded by flechette). The worker is single-threaded, so `HostEngine.query` serialises statements through a FIFO queue; more than `MAX_QUEUED` = 256 waiting is refused (503). The statement timeout (`--timeout`, default 30,000 ms) covers execution and fetching, not queueing; on expiry the engine cancels and the request fails 504. A worker call that does not settle within the timeout plus `HUNG_GRACE_MS` = 5,000 (the one way to reach it is a hang like the pre-policy `LOAD`) makes the engine `terminate()` the worker, start a fresh one (files, views, policy; about 0.45 s measured), fail the request 504 and log a warning; queued requests run on the new worker. A result past `--max-result-bytes` (default 64 MiB of IPC) stops fetching, closes and reopens the connection (the cheap way to drop a half-read result) and fails 413.
- **D39 The HTTP surface.** `POST /query` with a JSON body `{ type, sql }` (Mosaic's `restConnector` request; bodies over 1 MiB are 413, invalid JSON 400, `type !== 'arrow'` 400 with "the host runs arrow queries only; its views are the schema"), answered `200` with `content-type: application/vnd.apache.arrow.stream` and `cache-control: no-store`, or `400` with DuckDB's message as `text/plain` for a statement the engine refuses or cannot run, `413`, `503`, `504` as D38 says. `GET /query` is 405 (the connector's GET mode is not used). `GET` and `HEAD` of `/` and `/index.html` return the host's own shell (D40); `/assets/<name>` the host's own viewer files (`viewerAssets.files()` with no format: the viewer's `viewer.<hash>.js` and `.css`, no engine files), content-hashed so `cache-control: public, max-age=31536000, immutable`; `/data/manifest.js` the manifest text read at start (D41), `no-store`. Everything else is 404, every other method 405; in particular `/data/partitions/...` is never served, and an e2e test asserts the served viewer never asks for one. No `Range` handling (nothing served is read by range) and no CORS (one origin).
- **D40 The host serves its own viewer, not the report's.** `renderIndexHtml` gains `opts.host` (the query endpoint, relative to the page: `query`) and writes `<meta name="otel-html-host" content="query">` after the viewport meta; the host renders the shell from its own `viewerAssets.entry()` with the report's title and `assetsBase: 'assets/'`. So a `site` report on a shared `assetsBase` (R88), a `local` report and a report written by an older build are all served by the same code, and the viewer that queries the host is the one built with it.
- **D41 One manifest, read at start.** The host reads `data/manifest.js` once (`unwrapDataFile`, `reviveDataJson`, `parseAnyManifest`, the D12 gate: a format 1 to 3 manifest is `invalid-report` with `oldFormatMessage` and the `merge` hint; a listed file that is missing is `invalid-report` naming it) and serves that text and those views until it stops. Serving a report that is still being written, and the receiver exposing the endpoint over the report it writes (spec §8's optional item), are out of this plan: the views would have to follow the manifest's partition set at every flush. PR 2 files the follow-up issue.
- **D42 CLI only.** `otel-html host <report> [--host <addr>] [--port <port>] [--timeout <ms>] [--max-result-bytes <n>]`, defaults `127.0.0.1`, `8080`, `30000`, `67108864`; `--port 0` picks a free port, as the receiver's do. It prints `serving <report> at http://127.0.0.1:<port>/ (<n> partitions, <mb> MB of Parquet); press Ctrl-C to stop` and exits 0 on SIGINT or SIGTERM after closing the listener and the engine. A bind failure is `receiver-bind` (exit 1) with the hint naming `--port`; a missing report is `usage` (exit 2). `src/api/index.ts` does not change: nothing in the library API, the report format or the config schema.
- **D43 The viewer's served path.** `QueryEngine` gains `readonly tempTables: boolean`. `restQueryEngine(endpoint, logger)` in `mosaic.ts` (still the only `@uwdata/mosaic-core` importer, D19) is `mosaicQueryEngine(createCoordinator(restConnector({ uri: endpoint, method: 'POST' }), logger), servedFiles, false)`, where `servedFiles.registerText` rejects with `usage` and `close` does nothing. `openReport` takes `deps.host: string | null` (the meta tag's content, resolved against `baseUrl`); when set it reports `{ phase: 'host' }` ("Connecting to the host"), skips `startEngine` and `registerPartitions`, and builds the data source over the REST engine. `withIds` in `duckdb-source.ts` and `scoped` in `duckdb-metrics.ts` throw `servedResidual(term)` (`usage`: `this served report evaluates conditions in SQL only: "<term>" has no SQL form; rewrite or remove it`) when `engine.tempTables` is false and the filter left a residual, before any candidate is fetched (plan 3's note 3). Row lists keep the D5 browser re-check: it needs no temp table. The catalog, `metricShowOptions`, `metricsForResources`, trace detail and every fully translatable query work unchanged.
- **D44 The binaries.** `hostEngineFiles()` resolves the three engine files (`duckdb.<v>.node.cjs`, `duckdb.<v>.node.worker.cjs`, `duckdb.<v>.wasm`) from `dist/viewer/assets/` under Node (the two candidate dirs `src/api/report.ts` uses for the viewer) and, inside a Bun binary, writes the embedded copies into a `mkdtemp` folder that `close()` removes, because `worker_threads` and the Emscripten glue need real paths. `test/cli/binary.test.ts` starts `host` on a converted report and runs one query. If Bun cannot run the worker from a file, stop and ask (the process rule; R28 was the parquet-wasm analogue).
- **D45 Tests run the real engine.** `test/host/*.test.ts` start the real Node engine from the package's files (`test-support/host-engine-files.ts` resolves them from `node_modules`, as `test-support/duckdb-node.ts` does, so no `mise run build` is needed) over `buildFormat4Report` fixtures written to a temp folder (`test-support/report-dir.ts`). Fakes are used only for what the real engine cannot do on demand: a worker that never answers (D38's restart).
- **D46 Each query is a span.** `HostServer` runs each `/query` in a `host.query` span through the `Tracer` port of `WriterDeps` (`otel_html.sql.bytes`, `otel_html.result.bytes`, `otel_html.status`, the error recorded on failure), so a hosted report shows up in this repo's own dashboards like the receiver's requests do.
- **D47 e2e.** `e2e/host.spec.ts` starts `node dist/cli/main.js host e2e/.reports/linked --port 0` once per worker (a worker-scoped `hostUrl` fixture; the spec runs in every browser's `-file` project, untagged, with its own server) and checks the pages over the served path; `e2e/scale.spec.ts` gains a `host` perf test over `scale` (the scale reports are built only when the selection includes that file, R-rule of `test:e2e`). Budgets follow R85: twice the measured median, recorded in the PR body.
- **D48 Logging.** A refused or failed statement logs one `warn` line with the status and the first 200 characters of the SQL; a cancelled, over-cap or restarted one too; successes are `debug`.
- **D49 `allowed_directories` is belt and braces.** The registered names (`data/partitions/...`) are read through the engine's virtual file system; the setting is applied anyway, before `enable_external_access = false`, because the builder check verified the two together. If Task 1.3's tests pass without it, the implementer drops it and records that in the PR body.
- **D50 Measurement before a native engine.** Task 4.1 measures the host (Traces explorer interactive, Services table) on `scale` against the browser-engine figures of `e2e/scale.spec.ts` (`EXPLORER_BUDGET_MS.scale` 2,150 ms). If the host's median is above the browser's budget, stop and ask whether to open the `@duckdb/node-api` optional-peer issue or accept the figure; either way the figures go in the PR body and the record.

## Plans for this spec

Plans 1 (writer), 2 (viewer) and 3 (metrics) are merged; this is plan 4 (§8, milestone 4). Session F (the release PR from `feat/format-4` to `main`) follows once this plan is merged; the publishing plan (session G) after that.

## Global Constraints

- Plans 2 and 3's layering holds: `@uwdata/mosaic-core` only in `src/viewer/data/mosaic.ts`; `@uwdata/mosaic-sql` only under `src/query/sql/` and `src/viewer/data/`; `@duckdb/duckdb-wasm` only under `src/viewer/data/engine/` and `mosaic.ts`, and **never imported under `src/host/`** (D35: loaded by path); `apache-arrow` never under `src/viewer`, `src/query` or `src/host` (R62). `src/host/` imports from `src/format/`, `src/query/sql/views.ts`, `src/writer/html.ts`, `src/writer/viewer-assets.ts`, `src/writer/ports.ts`, `src/receiver/host.ts`, `src/model/` and `node:*` only.
- `@duckdb/duckdb-wasm` stays a devDependency (R47); `test/scaffold.test.ts`'s dependency list does not change. No new dependency.
- Queries name only the five views and the two virtual columns; the host creates the views from the manifest and that is the only DDL it runs (spec §8); every client statement is wrapped (D37) and run as `type: 'arrow'`.
- The policy statements and their order are those of D37; the server opens its listener only after they ran.
- The host binds `127.0.0.1` unless `--host` says otherwise; it has no TLS and no authentication (the README's Limits say so, as for the receiver).
- The public API (`src/api/index.ts`), the config schema, the report format and the viewer's `DataSource` interface do not change. The CLI gains exactly the `host` command and the five options of D42.
- Engineering standards of plans 1 to 3: strict TS, no `any`, typed `OtelHtmlError`s (host-internal HTTP outcomes are `HostError` with a status), injected deps, Biome clean, README in the PR that changes behaviour, TDD per task, `mise run check` before every push, the Chromium e2e suite before every PR.

## Review Focus

1. Client statements the policy must refuse, each as a POST to a running host: `CREATE TABLE t AS SELECT 1`, `SELECT 1; SELECT 2`, `SET threads = 1`, `LOAD icu`, `COPY (SELECT 1) TO '/tmp/x.csv'`, `ATTACH '/tmp/x.db' AS o`, `SELECT * FROM read_csv('/etc/passwd')`, `SELECT * FROM read_parquet('<the report's absolute spans.parquet path>')`: each is 400 within the timeout (no hang), the body names the parser or permission error, and `SELECT count(*) FROM spans` answers right after. (Task 1.3, Task 2.2)
2. A statement that runs past the timeout (`SELECT count(*) FROM range(300000000) r1, range(50) r2 WHERE (r1.range * r2.range) % 7919 = 1` with `--timeout 300`): 504 at about 300 ms, and the next statement answers within 100 ms; a worker that stops answering is replaced within timeout + grace and later statements succeed. (Task 1.4)
3. A result above the cap (`SELECT range AS x, range AS y, range AS z FROM range(20000000)` with `--max-result-bytes 1000000`): 413 after reading at most a few chunks past the cap, never the whole result, and the next statement works. (Task 1.4)
4. The served viewer never requests `*.parquet`, `*.wasm`, `*worker*` or `/data/partitions/`; a Traces filter whose term has no SQL form (`Len(name) > 2`) shows the served refusal where the browser engine would say "evaluated in the browser"; a metric `where` of the same kind too; the span count, Services table and metric list equal the browser engine's over the same report. (Task 3.4)
5. `host` on a `site` report with a shared `assetsBase` (no `assets/` folder), on a `local` report, on a format-3 report (fails with the `merge` hint, exit 2), on a folder without `data/manifest.js` (usage, exit 2) and with a port in use (exit 1, the hint names `--port`). (Task 2.3)

---

## PR 1: The engine in a Node worker

Branch `feat/format-4-host-engine` from `feat/format-4`. Title: `feat(host): a locked-down DuckDB-WASM engine in a Node worker over a format-4 report`.

Nothing user-visible changes in this PR: the engine is a module under `src/host/` tested with the real DuckDB build; knip reaches it only from tests until PR 2 (list `src/host/engine.ts` and `engine-files.ts` in a knip ignore with a comment naming PR 2, removed there).

### Task 1.1: The Node engine files are assets; test support

**Files:**
- Modify: `src/format/engine.ts` (`engineNodeAssetNames()`), `src/format/paths.ts` (`ENGINE_ASSET_RE` accepts `node.cjs` and `node.worker.cjs`), `scripts/engine-assets.ts` (copies `duckdb-node.cjs` and `duckdb-node-eh.worker.cjs` under the new names), `README.md` ("Report layout and hosting", the `assets/` line: the two Node files are the host's and never copied into a report)
- Create: `test-support/host-engine-files.ts`, `test-support/report-dir.ts`
- Test: `test/format/engine.test.ts`, `test/format/paths.test.ts`, `test/scripts/engine-assets.test.ts`, `test/writer/viewer-assets.test.ts` (or wherever `wantsAsset` is tested: `grep -rn "wantsAsset" test`)

**Interfaces:**
- Produces:
  ```ts
  // src/format/engine.ts
  /** The DuckDB-WASM Node build the host runs: the AsyncDuckDB bindings and the worker, named by engine version. Shipped in the viewer's assets folder, never copied into a report. */
  export function engineNodeAssetNames(): { bindings: string; worker: string }; // `duckdb.<v>.node.cjs`, `duckdb.<v>.node.worker.cjs`

  // test-support/host-engine-files.ts: the three files from node_modules (tests need no build), as `HostEngineFiles` (Task 1.2) whose close() is a no-op
  export function packageHostEngineFiles(): HostEngineFiles;

  // test-support/report-dir.ts
  /** A `Format4Fixture` written to a fresh temp folder as a report on disk: every listed file at its manifest path and `data/manifest.js` through `wrapDataFile(MANIFEST_KEY, manifest)`. */
  export async function writeReportDir(f: Format4Fixture): Promise<{ dir: string; close(): Promise<void> }>;
  ```

- [ ] **Step 1: Write the failing tests**: `engineNodeAssetNames()` equals `{ bindings: 'duckdb.1.32.0.node.cjs', worker: 'duckdb.1.32.0.node.worker.cjs' }`; `ENGINE_ASSET_RE` matches both `assets/duckdb.1.4.1-abc.node.cjs` and `.node.worker.cjs` (in the existing `ENGINE_ASSET_RE` test's loop) and `wantsAsset('assets/duckdb.1.32.0.node.cjs', 'site')` and `('local')` are both false; `buildEngineAssets` writes both files byte-identical to the package's `duckdb-node.cjs` and `duckdb-node-eh.worker.cjs` and the "writes the engine files named by the package version" test's expected name list includes them; `writeReportDir` of `buildFormat4Report([spansOnlyRequest(3)])` gives a folder whose `data/manifest.js` unwraps to a v4 manifest listing one partition and whose `spans.parquet` exists.
- [ ] **Step 2: Run** `pnpm exec vitest run test/format test/scripts/engine-assets.test.ts`; expected FAIL.
- [ ] **Step 3: Implement**; `mise run build:viewer` once so `dist/viewer/assets/` holds the two files (the e2e fixtures and the binary read them from there).
- [ ] **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(format): the DuckDB-WASM Node bindings and worker ship with the viewer assets for the host`

### Task 1.2: Starting the engine: worker, files, views

**Files:**
- Create: `src/host/engine-files.ts`, `src/host/node-duckdb.ts`, `src/host/engine.ts`
- Test: `test/host/engine.test.ts`

**Interfaces:**
- Consumes: `ManifestV4`, `PartitionEntry` (`src/format/manifest.ts`), `viewStatements`, `tableFiles` (`src/query/sql/views.ts`), `FileSystem` (`src/writer/ports.ts`), `Logger` (`src/writer/ports.ts`), `BunLike` (`src/writer/viewer-assets.ts`), `engineNodeAssetNames`, `engineAssetNames('site')[0]` (the wasm name).
- Produces:
  ```ts
  // src/host/engine-files.ts
  export interface HostEngineFiles { readonly bindings: string; readonly worker: string; readonly wasm: string; close(): Promise<void> }
  /**
   * Node: the first of `dirs` (default: the two candidates `src/api/report.ts` uses, as `.../viewer/assets/`) holding the
   * three files; when none does, the development fallback: the installed package's own copies, located with
   * `createRequire(import.meta.url).resolve('@duckdb/duckdb-wasm/dist/duckdb-node.cjs')` in a try/catch (a string, not an
   * import: the scaffold test's dependency rule is untouched, and the published package never reaches it because its
   * `dist/viewer/assets/` is the first candidate). Bun binary (`bun.embeddedFiles` present): the three embedded files
   * written into `mkdtemp('otel-html-host-')`, removed by close(). Nothing found is `usage` naming the bindings file with
   * the hint "run the viewer build".
   */
  export async function hostEngineFiles(opts?: { dirs?: readonly URL[]; bun?: BunLike }): Promise<HostEngineFiles>;

  // src/host/node-duckdb.ts: the slice of duckdb-wasm's Node build the host uses, typed locally (no package import, D35)
  export interface NodeDuckDb { startPendingQuery(conn: number, sql: string, allowStreamResult: boolean): Promise<Uint8Array | null>; pollPendingQuery(conn: number): Promise<Uint8Array | null>; cancelPendingQuery(conn: number): Promise<boolean>; fetchQueryResults(conn: number): Promise<Uint8Array | null>; registerFileURL(name: string, url: string, proto: number, directIO: boolean): Promise<void>; connect(): Promise<{ readonly id: number; query(sql: string): Promise<unknown>; close(): Promise<void> }>; terminate(): Promise<void> }
  /** `require(files.bindings)`, a Worker from the shim (`eval: true`, `workerData.mod = files.worker`), `new AsyncDuckDB(new VoidLogger(), shim)`, `instantiate(files.wasm)`, `open({})`. */
  export async function openNodeDuckDb(files: HostEngineFiles): Promise<NodeDuckDb>;
  /** The Web-Worker shim source run with `eval: true` (an EventTarget as `self`, `postMessage` to parentPort, parentPort messages to `onmessage` and the target). Exported so a test can read it. */
  export const WORKER_SHIM: string;
  export const NODE_FS_PROTOCOL = 1; // DuckDBDataProtocol.NODE_FS

  // src/host/engine.ts
  export interface HostEngineOptions { report: string; manifest: ManifestV4; files: HostEngineFiles; fs: Pick<FileSystem, 'exists'>; logger: Logger; timeoutMs: number; maxResultBytes: number; open?: typeof openNodeDuckDb }
  export class HostError extends Error { readonly status: 400 | 413 | 503 | 504; constructor(status, message: string) }
  export interface HostEngine {
    /** One client statement, wrapped (D37), queued (D38), as Arrow IPC stream bytes. Rejects with HostError. */
    query(sql: string): Promise<Uint8Array>;
    readonly restarts: number;
    close(): Promise<void>;
  }
  export async function startHostEngine(opts: HostEngineOptions): Promise<HostEngine>;
  export const MAX_QUEUED = 256;
  export const HUNG_GRACE_MS = 5_000;
  export function wrapStatement(sql: string): string; // `SELECT * FROM (\n${sql}\n) AS otel_host`
  ```
  `startHostEngine` checks every listed file exists (`invalid-report` naming the first missing path), opens the engine, registers each file by its manifest path (`registerFileURL(path, resolve(report, path), NODE_FS_PROTOCOL, false)`), runs `viewStatements(manifest, (p) => p)`, then the policy (Task 1.3) and resolves.

- [ ] **Step 1: Write the failing tests** (the fixture: `writeReportDir(await buildFormat4Report([spansOnlyRequest(3), spansOnlyRequest(2)], { close: false }))`, two partitions; the engine files `packageHostEngineFiles()` here and in Tasks 1.3, 1.4 and 2.2; `hostEngineFiles()` with no `dirs` resolves the same three files through the development fallback in a checkout without `dist/`):
  - `query('SELECT count(*) AS n FROM spans')` decodes (flechette `tableFromIPC`, `useBigInt`) to `5n`; `query("SELECT count(*) AS n FROM spans WHERE filename = 'data/partitions/000001/spans.parquet'")` to `2n` (the filename values are the manifest paths, D36);
  - `logs`, `points`, `patterns` views exist and are empty; `DESCRIBE logs` through `query` lists `TABLE_COLUMNS.logs` names then `file_row_number`, `filename`;
  - a manifest whose listed file is missing on disk rejects `startHostEngine` with `invalid-report` naming the path;
  - `WORKER_SHIM` contains `parentPort` and `onmessage`; `hostEngineFiles({ dirs: [<a temp dir with the three files>] })` returns them, and with an empty dir rejects `usage` naming the bindings file; with `bun: { embeddedFiles: [three Blobs named as the assets] }` it writes them into a temp folder that `close()` removes;
  - `close()` terminates the worker (the process exits cleanly: the test ends with no open handles).
- [ ] **Step 2: Run** `pnpm exec vitest run test/host/engine.test.ts`; expected FAIL.
- [ ] **Step 3: Implement** `engine-files.ts`, `node-duckdb.ts`, `engine.ts`. Here `query` runs D38's loop in its plain form (`startPendingQuery`, `pollPendingQuery` while `null`, `fetchQueryResults` until `null`, the chunks concatenated), one statement at a time, with no wrap, timeout, cap or restart yet: Tasks 1.3 and 1.4 add those.
- [ ] **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(host): the Node DuckDB engine over a format-4 report: worker shim, registered partitions, the five views`

### Task 1.3: The policy

**Files:**
- Modify: `src/host/engine.ts` (`applyPolicy(conn)`, `wrapStatement`, `query` refuses before the engine sees it where it can)
- Test: `test/host/engine-policy.test.ts`

**Interfaces:**
- Produces: `export const POLICY_STATEMENTS: readonly string[]` in the order of D37; `query` wraps every statement with `wrapStatement` and maps an engine rejection to `HostError(400, <DuckDB's message>)`.

- [ ] **Step 1: Write the failing tests** over the Task 1.2 fixture, each the Review Focus 1 statement through `query`, asserting `rejects.toMatchObject({ status: 400 })` and a message matching `/Parser Error|Permission Error|Invalid Input Error/`, each followed by `SELECT count(*) AS n FROM spans` → `5n` within 1 s; `POLICY_STATEMENTS` in D37's order; `wrapStatement('WITH r AS (SELECT range AS x FROM range(10)) SELECT x FROM r ORDER BY x DESC')` run through `query` gives `9n, 8n, ...` (order kept); `SELECT current_setting('enable_external_access')` is `false` and `('lock_configuration')` `true`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement** (D49: try the suite without `allowed_directories`; keep the line only if a test needs it, and say which in the PR body). **Step 4: Run**; PASS.
- [ ] **Step 5: Commit** `feat(host): the engine policy: no external access, locked configuration, statements wrapped so only a query runs`

### Task 1.4: Pending queries, the timeout, the cap and the restart

**Files:**
- Modify: `src/host/engine.ts`
- Test: `test/host/engine-limits.test.ts`

**Interfaces:**
- Produces: `query` runs the D38 loop (`startPendingQuery` → `pollPendingQuery` while `null`, cancel on the deadline → `HostError(504, 'the statement did not finish within <ms> ms')` → `fetchQueryResults` until `null`, accumulating; past `maxResultBytes` → close and reopen the connection, `HostError(413, 'the result exceeds <n> bytes')`); a FIFO of at most `MAX_QUEUED` → `HostError(503, 'the host is busy')`; a worker call unsettled for `timeoutMs + HUNG_GRACE_MS` → `terminate()`, reopen (files, views, policy), `restarts += 1`, the request fails 504, a `warn` line.

- [ ] **Step 1: Write the failing tests**: Review Focus 2's long statement with `timeoutMs: 300` rejects 504 between 250 and 1,500 ms and `SELECT 1` answers within 100 ms after; Review Focus 3's wide statement with `maxResultBytes: 1_000_000` rejects 413 and `SELECT 1` works after; 300 concurrent `query('SELECT 1')` calls: at least `MAX_QUEUED` resolve and the rest reject 503 (count both); the restart: `open` injected with a fake `NodeDuckDb` whose first `pollPendingQuery` never settles and whose second instance answers → the first `query` rejects 504 after about `timeoutMs + HUNG_GRACE_MS` (use `timeoutMs: 50` and a test-only `graceMs` option defaulting to `HUNG_GRACE_MS`), `restarts` is 1, `terminate` was called on the first instance, and a later `query` resolves from the second; the IPC of a 250,000-row statement decodes to 250,000 rows.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(host): statements run as cancellable pending queries with a timeout, a result cap and a worker restart`

### PR 1 close

- [ ] `mise run verify`; PR; body notes D35 to D38, D45, D49's outcome, the measured cancel latency and restart time from the tests' logs. Branch review on Opus 5.5. Merge.

---

## PR 2: The server and the `host` command

Branch `feat/format-4-host-command` from `feat/format-4`. Title: `feat(cli): otel-html host serves a report and answers Mosaic REST queries under the engine policy`.

### Task 2.1: The manifest and the shell

**Files:**
- Create: `src/host/manifest.ts`
- Modify: `src/writer/html.ts` (`renderIndexHtml` `opts.host`)
- Test: `test/host/manifest.test.ts`, `test/writer/html.test.ts`

**Interfaces:**
- Consumes: `unwrapDataFile`, `reviveDataJson` (`src/format/data-file.ts`), `MANIFEST_KEY`, `MANIFEST_PATH` (`src/format/paths.ts`), `parseAnyManifest`, `isV4` (`src/format/manifest.ts`), `oldFormatMessage` (`src/format/version.ts`).
- Produces:
  ```ts
  // src/host/manifest.ts
  export interface HostManifest { manifest: ManifestV4; script: string; partitionBytes: number }
  /** `usage` when `data/manifest.js` is missing ("no report found at <report> (missing data/manifest.js)"); `invalid-report` with `oldFormatMessage` and the hint `otel-html merge <report> --out <new>` for formats 1 to 3. */
  export async function readHostManifest(fs: Pick<FileSystem, 'exists' | 'readText'>, report: string): Promise<HostManifest>;

  // src/writer/html.ts
  export function renderIndexHtml(entry: ViewerEntry, title: string, opts?: { assetsBase?: string; host?: string }): string;
  // with `host`, `<meta name="otel-html-host" content="<escaped host>">` follows the viewport meta
  ```

- [ ] **Step 1: Tests**: a `writeReportDir` report reads back with `manifest.formatVersion` 4, the script starting with `__OH__.push("manifest",` and `partitionBytes` the sum of the files' `bytes`; a folder without the file is `usage` with the message; a copy of `fixtures/reports/format-3/data/manifest.js` is `invalid-report` whose message contains "format 3" and whose hint names `merge`; `renderIndexHtml(entry, 't', { host: 'query' })` contains exactly one `<meta name="otel-html-host" content="query">` placed before `<title>`, and without `host` contains none; a host value with `"` is escaped.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(host): the report's manifest read once at start; the shell names its host`

### Task 2.2: The HTTP server

**Files:**
- Create: `src/host/server.ts`
- Modify: `src/receiver/host.ts` (`BindFlag` gains `'--port'`; `HINT_BY_CODE`'s `EADDRINUSE` text for it is `pass --port <port>`), `src/receiver/http.ts` (`listenHttp(handler, host, port, flag: BindFlag = '--http')`)
- Test: `test/host/server.test.ts`

**Interfaces:**
- Consumes: `HostEngine`, `HostError` (PR 1), `HostManifest` (Task 2.1), `ViewerAssets` (`src/writer/viewer-assets.ts`), `renderIndexHtml`, `listenHttp`, `Listener`, `Tracer`, `Logger`.
- Produces:
  ```ts
  // src/host/server.ts
  export interface HostServerOptions { report: string; manifest: HostManifest; engine: HostEngine; viewerAssets: ViewerAssets; host: string; port: number; logger: Logger; tracer: Tracer }
  export const QUERY_PATH = '/query';
  export const HOST_META_CONTENT = 'query'; // the meta tag's value: the endpoint relative to index.html
  export const MAX_QUERY_BODY_BYTES = 1_048_576;
  export const ARROW_STREAM_TYPE = 'application/vnd.apache.arrow.stream';
  /** Binds and serves (D39); `address` is `http://<host>:<port>`; close() stops the listener (the engine is the caller's). */
  export async function startHostServer(opts: HostServerOptions): Promise<Listener>;
  /** The request handler alone, for tests and for the listener. */
  export function hostHandler(opts: Omit<HostServerOptions, 'host' | 'port'>, assets: ReadonlyMap<string, Uint8Array>, shell: string): (req: IncomingMessage, res: ServerResponse) => void;
  ```
  The shell is `renderIndexHtml(viewerAssets.entry(), manifest.manifest.title, { host: HOST_META_CONTENT })` rendered once; `assets` are `viewerAssets.files()` (no format) keyed by path. Each `/query` runs in a `host.query` span (D46).

- [ ] **Step 1: Write the failing tests** (a real engine over the Task 1.2 fixture, `startHostServer` on port 0, `fetch`):
  - `POST /query` `{ type: 'arrow', sql: 'SELECT count(*) AS n FROM spans' }` → 200, `content-type` `application/vnd.apache.arrow.stream`, `cache-control: no-store`, the body decodes to `5n`; through mosaic-core's `restConnector({ uri, method: 'POST' })` and a `Coordinator` (as `test/viewer-data/mosaic.test.ts` builds one) the same query gives the same table;
  - `{ type: 'exec', sql: 'CREATE TABLE t AS SELECT 1' }` → 400 with a body mentioning "arrow"; `{ type: 'json', sql }` → 400; `CREATE TABLE t AS SELECT 1` as `arrow` → 400 whose body contains "Parser Error"; a 2 MB body → 413; `not json` → 400; `GET /query` → 405;
  - `GET /` and `/index.html` → 200 `text/html` containing `<meta name="otel-html-host" content="query">` and the viewer script path; `HEAD /index.html` → 200 with no body; `GET /assets/<entry script>` → 200 `text/javascript` with `immutable`; `GET /data/manifest.js` → the script text, `no-store`; `GET /data/partitions/000000/spans.parquet` → 404; `GET /assets/duckdb.1.32.0.wasm` → 404 (not a viewer file); `PUT /` → 405; `GET /../package.json` → 404;
  - the tracer (a recording fake, `test-support/writer-deps.ts`'s pattern) saw one `host.query` span per request with `otel_html.status` 200 or 400 and `otel_html.result.bytes` on success;
  - `listenHttp` on a port in use, with flag `'--port'`, rejects `receiver-bind` whose hint contains `--port`.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**. **Step 4: Run**; PASS. `mise run check` PASS.
- [ ] **Step 5: Commit** `feat(host): the HTTP server: Mosaic REST queries, the host's own viewer shell and assets, the report's manifest`

### Task 2.3: The `host` command

**Files:**
- Create: `src/cli/commands/host.ts`
- Modify: `src/cli/program.ts` (`addHostCommand`), `src/cli/commands/receive.ts` (export `portOf`), `README.md` ("CLI" intro lists `host`; a `### \`host <report>\`` section after `merge` with the flag table of D42, the printed line, exit codes, what is served and what is refused, "the viewer never downloads the report: every query is SQL to the host"; "Hosting" gains a bullet; "Limits" gains: one statement at a time, the timeout and result cap, no TLS or authentication, binds loopback by default, a report being written is served as of start)
- Test: `test/cli/host.test.ts` (the `serve.test.ts` harness: `runCli` with a `CliIo` whose `signals.on` is captured; a real report in a temp folder from `writeReportDir`; `deps.fs` the real `createNodeFileSystem()`; `viewerAssets` from `fakeViewerAssets()`; no test-only `CliDeps` field: the engine files come from `hostEngineFiles()`, whose development fallback finds the package's copies, so the test needs no build)

**Interfaces:**
- Consumes: `resolveDeps` (`src/api/report.ts`), `nextSignal` (`src/cli/commands/receive.ts`), `readHostManifest`, `hostEngineFiles`, `startHostEngine`, `startHostServer`, `CliExit`.
- Produces: `addHostCommand(program: Command, io: CliIo, deps: CliDeps): void` with the five options of D42 (`--port` and `--timeout` and `--max-result-bytes` through `portOf`-style integer parsers; a non-integer is a usage error), the printed line, SIGINT/SIGTERM → close server, close engine, close files, exit 0.

- [ ] **Step 1: Tests**: `host <dir> --port 0` prints `serving <dir> at http://127.0.0.1:<port>/ (2 partitions, 0 MB of Parquet); press Ctrl-C to stop`, a `fetch` of `<address>/index.html` is 200 and of `/query` answers `5n`, `fire('SIGINT')` resolves the run with 0 and the port is closed; the same over a `site` report written with `config: { writer: { format: 'site', assetsBase: '../../assets/0.0.0/' } }` (no `assets/` folder of its own, R88's shape) and over a `local` one: both serve, and both `index.html` responses are the host's shell (they carry the host meta tag and the fake viewer's entry script, not the report's); a missing folder exits 2 with the usage message; a format-3 fixture copy exits 2 with the `merge` hint; a port held by a `net.Server` exits 1 and stderr names `--port`; `--timeout x` exits 2.
- [ ] **Step 2: Run**; FAIL. **Step 3: Implement**; README. **Step 4: Run**; PASS; `mise run check` PASS (knip: remove PR 1's ignore entries).
- [ ] **Step 5: Commit** `feat(cli): otel-html host serves a format-4 report over HTTP`

### Task 2.4: The binaries

**Files:**
- Modify: `test/cli/binary.test.ts` (a test: convert `fixtures/small.otlp.json`, start `host --port 0`, read the printed address, POST one query, decode `6n`, SIGINT, exit 0), `.github/workflows/ci.yml` (the "Binary runs outside the checkout" step: start `./otel-html host out --port 0` in the background, wait for the line, `curl` one query to a file, `test -s`, kill; a comment names D44), `scripts/build-binaries.ts` only if the embedded asset list needs the two Node files named (it embeds every file of `dist/viewer/assets/`, so expect no change)

- [ ] **Step 1**: the test; `mise run build && mise run build:binaries -- --target linux-x64` and `OTEL_HTML_BINARY=dist/bin/otel-html-linux-x64 pnpm exec vitest run test/cli/binary.test.ts`. Expected PASS. If Bun cannot start the worker from the materialised file (D44), stop and ask with the error.
- [ ] **Step 2**: the `ci.yml` lines (R81's class: assertions in an existing step); the PR body lists them.
- [ ] **Step 3: Commit** `test(cli): the binaries serve a report with host`

### PR 2 close

- [ ] `mise run verify`; PR; body notes D39 to D42, D44, D46, D48, the `ci.yml` lines; files the follow-up issue of D41 (a host that follows a report being written; the receiver exposing the endpoint) and links it. Branch review on Opus 5.5. Merge.

---

## PR 3: The viewer queries the host

Branch `feat/format-4-host-viewer` from `feat/format-4`. Title: `feat(viewer): a served report queries its host over Mosaic's REST connector; residual aggregates are refused`.

### Task 3.1: `tempTables` on the seam and the served refusal

**Files:**
- Modify: `src/viewer/data/query-engine.ts` (`readonly tempTables: boolean`), `src/viewer/data/mosaic.ts` (`mosaicQueryEngine(coordinator, files, tempTables = true)`), `src/viewer/data/residual.ts` (`servedResidual(term)`), `src/viewer/data/duckdb-source.ts` (`withIds` takes the residual text; the check before `candidates`), `src/viewer/data/duckdb-metrics.ts` (`scoped`: the check before the probe), `test-support/duckdb-node.ts` and every fake `QueryEngine` in tests (`tempTables: true`)
- Test: `test/viewer-data/duckdb-source-spans.test.ts`, `duckdb-source-logs.test.ts`, `duckdb-source-metrics.test.ts` (one test each)

**Interfaces:**
- Produces: `export function servedResidual(term: string): OtelHtmlError` (D43's message, code `usage`); the data sources throw it when `!engine.tempTables && residual !== null` on the aggregate paths (`withResidualIds` callers in spans and logs; `scoped` in metrics); row lists are unchanged.

- [ ] **Step 1: Tests**: over the Node engine wrapped so `tempTables` is false (a one-line wrapper object spreading the real engine), `spanQuery` with `condition: 'Len(name) > 2'` and `needs: ['facets']` rejects with `usage` and a message containing `Len(name) > 2`; the same with `needs: ['rows']` resolves with rows and `residual` set; `logQuery` likewise; `metricQuery` with a residual `where` rejects the same way and with a translatable `where` resolves; with `tempTables` true every call resolves as before.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(viewer): the query-engine seam says whether it has temp tables; served residual aggregates are refused`

### Task 3.2: The REST query engine

**Files:**
- Modify: `src/viewer/data/mosaic.ts` (`restQueryEngine`)
- Test: `test/viewer-data/mosaic.test.ts`

**Interfaces:**
- Produces: `export function restQueryEngine(endpoint: string, logger: Logger, fetchImpl?: typeof fetch): QueryEngine` (D43; `fetchImpl` is for tests and is passed as `restConnector`'s `fetch`); its `tempTables` is false; `registerText` rejects `usage` ("a served report creates no temp tables"); `exec` rejects `usage` (the host runs no DDL); `close` resolves.

- [ ] **Step 1: Tests**: with a fake `fetch` that answers `tableToIPC(tableFromArrays({ n: [5n] }))`, `query(Query.from('spans').select({ n: count() }))` decodes `5n`, the fake saw one `POST` to the endpoint whose JSON body is `{ type: 'arrow', sql: <the SQL> }` and `content-type: application/json`; a 400 answer with body `Parser Error: x` rejects `invalid-report` whose `actual` contains `Parser Error: x` and whose hint is the SQL; `registerText` and `exec` reject `usage`; an aborted signal rejects `AbortError`.
- [ ] **Step 2 to 4**. **Step 5: Commit** `feat(viewer): a QueryEngine over mosaic-core's REST connector`

### Task 3.3: `openReport` and `main.tsx` pick the host

**Files:**
- Modify: `src/viewer/data/open-report.ts` (`OpenDeps.host?: string | null`, `OpenParts.createRestEngine`, `LoadProgress.phase` gains `'host'`), `src/viewer/main.tsx` (reads the meta tag), `src/viewer/app.tsx` (`progressText`: `'host'` → "Connecting to the host")
- Test: `test/viewer-data/open-report.test.ts` (new, or the existing test of `openReport`: `grep -rn "openReport" test`)

- [ ] **Step 1: Tests**: `openReport(manifest, { ...deps, host: 'query', parts: { createRestEngine: spy, startEngine: mustNotBeCalled } }, onProgress)` resolves a data source, called `createRestEngine` with `new URL('query', baseUrl).href`, never called `startEngine` or `registerPartitions`, and reported `{ phase: 'host' }` then nothing else; without `host` the existing path runs (the existing tests); a format-3 manifest with `host` set still fails the D12 gate.
- [ ] **Step 2 to 4** (`main.tsx` is not unit-tested, R73: it reads `document.querySelector('meta[name="otel-html-host"]')?.getAttribute('content') ?? null`). **Step 5: Commit** `feat(viewer): a page whose shell names a host queries it instead of starting the engine`

### Task 3.4: e2e over the host; README

**Files:**
- Create: `e2e/host.spec.ts`, `e2e/host-process.ts`
- Modify: `README.md` (`host` section: what the viewer does on a served report, the refusal note, "Fusion, dashboards and the Metrics pages work unchanged"; the "Report format compatibility" paragraph unchanged), `e2e/console-noise.ts` only if the served page logs something new

**Interfaces:**
- Produces:
  ```ts
  // e2e/host-process.ts
  /** Spawns `node dist/cli/main.js host <report> --port 0 [...args]`, resolves the printed `http://127.0.0.1:<port>` once the serving line appears (30 s), kills it on close(). */
  export async function startHost(report: string, args?: readonly string[]): Promise<{ url: string; stderr(): string; close(): Promise<void> }>;
  ```
  `e2e/host.spec.ts` extends `test` with a worker-scoped `hostUrl` fixture over `reportDir('linked', 'file')` (D47) and guards every page's requests: none matches `/\.parquet(\.js)?$|\.wasm$|worker|\/data\/partitions\//`.

- [ ] **Step 1: Tests**: Traces explorer shows the `linked` report's span count (`fixtureSpanCount('linked')`) and the Services page its two services with counts equal to those the `-file` project asserts in `e2e/traces-explorer.spec.ts` (copy the numbers); Logs explorer shows `LINKED_LOG_COUNT` logs; the Metrics Catalog lists its metrics and a chart draws; the trace panel opens a trace; a filter `Len(name) > 2` in the Traces explorer shows an alert containing `has no SQL form`; the Explorer URL with a metric `where` of `Len(attributes["k"]) > 1` shows the same; the request guard passed in every test; `stderr()` has no `warn` line except those of the two refusals.
- [ ] **Step 2**: `mise run test:e2e:chromium -- e2e/host.spec.ts`; PASS; then `mise run test:e2e -- e2e/host.spec.ts` (all three browsers); PASS.
- [ ] **Step 3: Commit** `test(e2e): the viewer over otel-html host in three browsers`

### PR 3 close

- [ ] `mise run verify`; PR; body notes D43, D47, the refusal copy. Branch review on Opus 5.5. Merge.

---

## PR 4: Measurement, record and the kickoff prompts

Branch `docs/format-4-host-record` from `feat/format-4`. Title: `test(e2e): host measured on the scale report; plan 4 record; the release is next`.

### Task 4.1: The host on `scale`

**Files:**
- Modify: `e2e/scale.spec.ts` (a `describe('host')` with one `@perf` test: `startHost(SCALE_REPORTS_DIR/scale)`, the Traces explorer interactive, median of three loads, the Services table's first row visible), `e2e/fixture.ts` (`HOST_EXPLORER_BUDGET_MS`)

- [ ] **Step 1**: the test with a provisional budget; `mise run test:e2e:chromium -- e2e/scale.spec.ts --grep host` three times; the medians. Budget: twice the median (R85). Compare with `EXPLORER_BUDGET_MS.scale` (2,150 ms) and the browser medians in #229: if the host's median is above the browser's *budget*, stop and ask (D50). Record the host's RSS (`ps -o rss` of the host process after the loads) in the PR body.
- [ ] **Step 2: Commit** `test(e2e): the host's Traces explorer on scale within <budget> ms (median <n>)`

### Task 4.2: Record and kickoff prompts

- [ ] Append to this plan a "Record: rulings and notes for the release" section in plan 1's format: rulings `R<n>` continuing from R114 (from the PR bodies), spec deviations with line numbers (§8 "opened read-only" → the wrap and the settings, D37; "`@duckdb/node-api` as an optional peer" → D50's outcome; the receiver's endpoint → D41's issue), the measured figures (Task 4.1, the cancel latency and restart time, the binary's host start), and notes for session F (the README's `host` section is part of the release notes; the frozen format-4 fixture should include a `host` smoke in `frozen.spec.ts` or `binary.test.ts`).
- [ ] In `docs/superpowers/plans/2026-11-06-format-4-writer.md`, "Kickoff prompts": rule 5 reads "the host plan merged" once this PR lands and rule 6 becomes the active one (session F); confirm session F's paragraph lists this plan's figures among what the release PR body carries (add "plan 4's host figures: the `scale` median and budget, the binary smoke"). Commit `docs: kickoff prompts after plan 4`.

### Plan close-out

- [ ] `mise run check`; PR; merge. Post the summary the unattended process asks for: each PR's number, title and measurements (the cancel latency and restart time of PR 1, PR 4's medians and budget, the host RSS); issues opened (D41's follow-up, D50's if any); anything stopped on. This session ends; the next `/format-4` is session F (the release PR), as the kickoff rules say.

## Record: rulings and notes for the release

Written after plan 4 finished (PRs #245, #247, #249 and this one, branch `feat/format-4`), because the rulings lived
only in a git-ignored ledger. It continues plan 3's numbering (R93 to R114). Where this record and the spec disagree,
this record wins; where it and the earlier records disagree, this record wins for what it names. Decisions D35 to D50
above stand except where a ruling here says otherwise.

### Rulings

Format: `R<n>`: what was decided; why. The source is named in the row when it is not a plain implementation choice.

| R    | Decision | Why |
| ---- | -------- | --- |
| R115 | The host loads the two signed extension files the viewer ships (`parquet`, `json`) before the views and the policy, through a stand-in for `XMLHttpRequest` in the worker shim that serves only those two names. D36's "built into this engine build" is wrong for `json`. | The e2e failed on `json_extract_string` in the Node engine (`parquet` had worked through autoload). Loading before autoload is turned off and the configuration is locked keeps D37's policy unchanged; the Bun binary embeds the two files (`binary.test.ts` 8/8). |
| R116 | The policy sets `allowed_paths = [<every manifest-listed file>]` instead of D37's `allowed_directories = ['data/partitions/']`. | `allowed_directories` is a prefix rule resolved against the process's working directory, so it exposed files the manifest does not list (found by the PR 1 branch review on Opus 5.5). Exact paths keep to spec §8's "only the views". |
| R117 | A client statement is refused if it holds more than one statement: `conn.prepare` of the wrapped SQL (`Cannot prepare multiple statements at once`) runs before the pending query, in addition to D37's wrap. | The wrap alone was escapable with `)` then `;` (verified accepted before the fix). |
| R118 | Opening a worker has its own deadline (`OPEN_DEADLINE_MS`, 30 s), independent of the statement timeout; a restart that misses it answers 503 "could not be restarted" and is logged as a warning. | On CI (Ubuntu and Windows) a real reopen took over the old `timeout + HUNG_GRACE_MS` (1,050 ms in the tests) and every restart failed. |
| R119 | `apache-arrow` is bundled into the engine files the host loads, so the Bun binary needs no `node_modules`. | Maintainer (2026-11-09), Task 2.4's stop-and-ask: the binary failed to find `apache-arrow`; bundling was the recommended option. |
| R120 | On a loopback bind the host answers 403 to a request whose `Host` header names anything other than a loopback address or `localhost`, judged from the bound address with a `BlockList`; 415 to a body that is not JSON; `nosniff` on every response. | DNS rebinding would defeat the README's only access control (bind to loopback), and a form post from another site would otherwise reach `/query` without CORS preflight. |
| R121 | On Ctrl-C or SIGTERM the host closes the engine first, so running and queued statements answer 503 "the host is closed" (unlogged), then it closes connections; a second Ctrl-C exits 130, during start-up too. A statement interrupted by the close answers 503, not 400. | Before the fix a statement in flight held the process for about 22 s, and the interrupted statement answered 400 "Cannot read properties of undefined". |
| R122 | A 413 drains the rest of the request body before the socket closes (bounded at 2 s or 16 MiB more). | On Windows the reset reached the client before the response did (`ECONNRESET` on CI). |
| R123 | On a served report, aggregates whose filter leaves a residual term are refused with D43's message, and so are traces-mode row queries that go through `withIds`, which also needs the D5 temp table. Conditions on `log.body.string` (the body `contains`/`matches` tokens and the Logs pattern click) have no SQL form, so they are refused there; the README says so and #248 tracks translating them. | Translating `IsMatch(body.string)` to SQL changes OTTL-to-SQL semantics (JavaScript against RE2 regexes) for the browser engine too and needs the equivalence suite; out of this plan's scope. |
| R124 | Host failures are worded for the reader (`describeHostFailure` in `mosaic.ts`): a 400 keeps DuckDB's message; 413, 503 and 504 name `--max-result-bytes`, busy or stopping, and `--timeout`, followed by the host's own text; a network failure reads "the host did not answer (is otel-html host still running?)". The error code stays `invalid-report`. | Each of those statuses has more than one cause on the host (a request body over 1 MiB is also 413; a restarted engine is also 504), and no better `ErrorCode` exists. |
| R125 | `e2e/host.spec.ts` runs in order in one worker per browser project (`mode: 'default'`), and its comparison pages over file:// wait 15 s for the browser engine's cold start. | Ten local workers each starting hosts and browsers exhausted the container's process limit (`pids.max` 2048). On CI the comparison page's cold start once passed the 5 s default (the served table had drawn). |
| R126 | D50's outcome: the host's Traces explorer on `scale` has a median of 359 ms (runs 346, 365, 359), so the budget is 750 ms (twice the median rounded up to 50, R85's rule). It is below the browser's budget (2,150 ms; the browser's median here is 1,230 ms), so no `@duckdb/node-api` issue is opened and the WASM build stays the only engine. | The host's engine starts once per process; the browser pays the engine start on every load. |

### Spec deviations

Spec file: `docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md`. Each was checked against its text.

- Line 325 (§8, "DuckDB opened read-only"): DuckDB-WASM has no read-only open for registered files. The policy is the wrap (one `SELECT` per request, R117), the settings of D37 with `allowed_paths` (R116), and the views as the only DDL. A query that reads a local file, writes, attaches, loads or sets is refused (the D37 tests).
- Lines 332-334 (§8, "`@duckdb/node-api` as an optional peer dependency for speed; the builder measures and picks the default"): measured, and not added (R126). The WASM build in a Node worker is the default and the only engine.
- Lines 334-335 (§8, the receiver exposing the endpoint over the report it writes): deferred to #246 with serving a report that is still being written (D41), because the views would have to follow the manifest at every flush.
- Lines 337-338 (§8, the meta tag): as written. The tag's content is `query`, the endpoint resolved against the page's URL (D43).

### Measured figures

| what | figure | where |
| ---- | ------ | ----- |
| cancel at a 300 ms timeout | 504 at 330–335 ms; the next statement 4–5 ms later | PR #245 |
| result cap at 1 MB | 413 in about 114 ms | PR #245 |
| a real worker restart | about 530 ms | PR #245 |
| 300 concurrent `SELECT 1` | 256 answered, 44 refused with 503 (`MAX_QUEUED` 256) | PR #245 |
| SIGINT to exit with a statement in flight | 22 ms (about 22 s before R121) | PR #247 |
| the binary, launch to the serving line | 866–870 ms | PR #247 |
| host, Traces explorer interactive on `scale` | median 359 ms (346, 365, 359), budget 750 ms | this PR |
| host, the Services table's first row after the hash change | about 46 ms | this PR |
| host, a facet toggle on `scale` | median 68 ms, max 71 ms (no budget; the browser's is 140 ms) | this PR |
| host RSS after the loads and toggles | 563–576 MB | this PR |

### Notes for the release (session F)

1. The README's `host` section is part of the release notes: the command, its flags (`--host`, `--port`, `--timeout` up to 24 h, `--max-result-bytes` up to 4 GiB), the policy, the status codes, the refused conditions (R123) and the binaries.
2. The frozen format-4 fixture should get a `host` smoke when it is added: one query through `otel-html host` over the frozen report, in `binary.test.ts` or `e2e/frozen.spec.ts`.
3. The release PR body carries plan 4's host figures from the table above: the `scale` median and budget (R126), the binary's start, and the cancel and restart figures.
4. Open follow-ups from plan 4: #246 (serving a report being written; the receiver exposing the endpoint), #248 (body and pattern conditions on a served report).
5. The host's RSS (about 570 MB on `scale`) is the WASM engine's memory plus the worker; it has no bound and no test. If the release wants one, measure it on `many` first.

## Record: rulings of the release session (session F)

Written while the release PR was prepared (2026-11-09). It continues plan 4's numbering (R115 to R126).

| R    | Decision | Why |
| ---- | -------- | --- |
| R127 | Maintainer (2026-11-09), #216's format question: `epochUnixNano` stays a required manifest field with its meaning unchanged (the earliest time of the report's first data), and the frozen format-4 fixture is cut with it (`fixtures/reports/format-4/`, written by `7da10ea5`). No format change. What remains of #216 is behaviour, not format: `merge` by copy should refuse (a report outside the window does not open in the viewer) when its inputs put the report's range outside ±2^53 ns of the epoch, and `run --append` must exit non-zero when an append is refused. Both are follow-ups after the release. README Limits states the window and why. | Plan 1 called the field close to vestigial, before the viewer existed. Plan 2's viewer measures every time relative to the epoch as a JavaScript number (`relTime` in `src/query/sql`, the time range, the log and trace columns), so the ±2^53 ns accept window guards the viewer's precision. |
| R128 | Maintainer (2026-11-09): #229 does not block the release. The Logs landing (6,150 ms against format 3's 3,000), the warn+ window (2,300 against 1,000) and the Fusion budgets (7,900 on `scale`, 12,200 on `many`) ship as re-baselined at twice their medians; the release PR lists #229 with the figures. | The landings are slower; partial results, the scan path and the format-3 ceilings are gone, and the host answers the same pages in a fraction of the time. |
| R129 | The frozen format-4 fixture's `host` smoke is in `test/cli/host.test.ts` (in-process, runs in `mise run check`), not in `binary.test.ts` or `e2e/frozen.spec.ts` as note 2 above suggested. The fixture is `data/**` of a default (`local`) `convert`, so it holds the `.parquet.js` wrappers too. | `binary.test.ts` runs only where a binary exists and the e2e spec only in the browser suite; the unit test runs on every `check`. `host` needs only the manifest and the listed Parquet files, so the frozen `data/` folder serves as is. |
