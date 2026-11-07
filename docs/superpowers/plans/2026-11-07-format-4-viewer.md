# Format 4 Viewer Implementation Plan (plan 2 of the format-4 spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The viewer opens format-4 reports in both output formats, from `file://` and over HTTP, and answers every span and log question of the Traces, Logs, Services and Dashboards pages with SQL over the five Parquet views; the chunk format is no longer written or read by the viewer.

**Architecture:** `main.tsx` starts DuckDB-WASM from the manifest's `engine` block (base64 scripts and a data: URL in `local`, plain files with range reads in `site`), registers the partitions the manifest lists and creates the views `spans`, `logs`, `points`, `traces`, `patterns`. A Mosaic `Coordinator` (consolidation, cache, Arrow IPC decoded by flechette) owns the connection. `src/query/sql/` holds typed mosaic-sql builders for every result shape the pages consume and the OTTL-to-SQL translator; `src/viewer/data/duckdb-source.ts` implements the existing `DataSource` methods by running those builders through the Coordinator and mapping the Arrow results into the result types the components already consume. The eager and windowed strategies, the rollup accumulators, the trace index and the chunk writer are deleted; `writer.format` defaults to `local`.

**Tech Stack:** TypeScript (strict), `@uwdata/mosaic-sql` 0.35.0 (runtime dependency: the builders are shared with `host` in plan 4), `@uwdata/mosaic-core` 0.35.0 and `@uwdata/flechette` 2.7.1 (viewer only, devDependencies), `@duckdb/duckdb-wasm` 1.32.0 (DuckDB v1.4.3; pinned through a pnpm override because mosaic-core declares a dev build), React 19, vitest (the DuckDB Node build runs the data-layer tests), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md` §7, §5.3, §6.4, §10, §11 milestone 2, read together with the record at the end of `docs/superpowers/plans/2026-11-06-format-4-writer.md` ("Record: rulings and notes for plan 2"; the record wins over the spec). Column names: `docs/format/schema.md`.

**Process:** unattended (`docs/agents/process-unattended.md`); PRs target `feat/format-4`, the next PR branches from the updated `feat/format-4`. Implementers and task reviewers on Sonnet 5.5, the branch review on Opus 5.5; each review's summary names its model. PR 8 touches the publisher action and CI config, which the process marks "stop and ask"; its tasks say so.

## Decisions this plan makes

The spec leaves these to the builder or says something plan 1's record or the code makes impossible. Each is applied where named; the maintainer can object at review.

- **D1 Mosaic without clients.** The pages keep calling `DataSource` methods through the existing `useQuery` hook; the methods run mosaic-sql `Query` objects through `Coordinator.query()`, which gives consolidation and caching. Mosaic `Selection`s and `MosaicClient` subclasses are not introduced: the zustand selection store already re-queries every consumer when a filter changes, and the one feature that needs clients, pre-aggregation of the brush, is off in this plan (spec §7.1 and §14 leave it a designer's call; `preagg: { enabled: false }`). Components never import Mosaic.
- **D2 Times.** The viewer keeps report-relative nanoseconds (`RelNanos`, `TimeWindow`) everywhere above the data layer. Every SQL builder selects time as `(<column> - <epoch>::BIGINT)` and compares windows after adding the epoch; the Coordinator decodes with `useBigInt: true` and the mapping layer converts with a checked `toNumber` so a value past 2^53 fails loudly instead of rounding.
- **D3 Pruning.** The views are created once with `read_parquet([...], filename = true, file_row_number = true)`. A query that the manifest statistics prune adds `WHERE filename IN (...)`; one that prunes nothing adds no file predicate; one that prunes everything is not sent. Spans and traces prune on `timeMin > window.end` only (a span may start before the window and end inside it); logs and points prune on both bounds. Statistics values are strings (R16); `null` prunes nothing.
- **D4 Attribute access.** `attributes["k"]` becomes `json_extract(attributes, '/<k>')` in JSON Pointer form (`~` as `~0`, `/` as `~1`), so any key works. Tagged numbers (`{"$i"}`, `{"$d"}`, R11) are read by a shared SQL expression; a string compare uses `json_extract_string`.
- **D5 Residual conditions.** A top-level `and` term the translator cannot express stays in the browser: row lists re-check rows with `compileCondition` and page until `limit` survivors (at most 8 pages of `limit`), aggregates fetch the candidate rows' `(filename, file_row_number)` into a temp table (`registerFileText` + `read_csv`, capped at 200 000 candidates) and join on it. The UI shows "evaluated in the browser". Over the REST connector (plan 4) aggregates with a residual are refused.
- **D6 Rollup classes.** `RedSeries`, `ExpHistogram` and `GroupDurations` leave the viewer. The RED strip and Services read per-bucket and overall quantiles from SQL (`RedBuckets`, `DurationSummary`); the measured facet views read `GroupStats`; the Duration facet's bins are exact over the filtered set (today they come from the first `listCap` rows).
- **D7 Trace rows.** `TraceRow.root`, `shareComplete` and `serviceShare` go; the root's service, name and resource come from `traces`, and the Service share column loads per visible row through `DataSource.serviceShare(traceId)` (exclusive time needs the trace's spans).
- **D8 Log identity.** `LogRef` is `<partition n>.<file_row_number>`, stable while the partition exists (compaction renumbers; a `log=` URL from before compaction then fails as "not found", as a missing chunk does today).
- **D9 Patterns.** The Logs explorer's patterns mode reads the writer's `patterns` table combined by template (note 2); the condition and text filters do not apply to it, the window does (by first/last overlap), and the page says so. Drain in the browser is gone with the scan code.
- **D10 Text search** runs in SQL as a case-insensitive `contains` over the same fields as today, where the attribute fields are the JSON texts (keys are therefore matched too; a quote inside the text does not match the JSON escaping).
- **D11 Metrics until plan 3.** `metricCatalog()`, `metric()` and `metricsForResources()` on the format-4 source reject with a `usage` error whose message names plan 3; the Metrics pages show it as their error state; `metricPoints()` is answered from `points` (one grouped query) so the Fusion timeline keeps its metric lane. The metric e2e specs and the unit tests that read metric chunk files are skipped with a reference to plan 3, listed in PR 5.
- **D12 Format gate.** The viewer reads format 4 only. A format 1 to 3 manifest shows "This report is format N; this viewer reads format 4. `otel-html merge <report> --out <new>` converts it." `upgrade` refuses a format 1 to 3 report the same way (exit 2). Frozen fixtures are opened after `merge`.
- **D13 Engine assets.** The viewer resolves the engine files from `manifest.engine.version` and `assetsBase` (note 8), fails with an `invalid-report` error naming the file when one is missing, and releases every base64 string and decoded buffer once registered.
- **D14 Config.** `writer.format` becomes `'local' | 'site'`, default `local`; `chunks` is `invalid-config` with a hint; `viewer.eagerBudgetBytes` and `OTEL_HTML_EAGER_BUDGET_BYTES` are removed (R19); v1 to v3 manifests keep their config schema for reading. `--format chunks` is gone from the CLI.
- **D15 e2e.** The fixture reports are built in `local` format and opened from `file://`; a `site` copy of each mounted report (`upgrade --format site` into `e2e/.reports-site/`) is served over HTTP for the `@http` tests by a static server that answers `Range` and `HEAD`. The scale reports are `site` only, under a new `chromium-perf-http` project; `huge` (an over-budget report) is replaced by `many` (the same data left uncompacted in about a hundred partitions, note 10). Budgets are re-measured on the new path and set at twice the measured median, never above today's.
- **D16 Shared facet definitions.** The core facets of spans and logs (key, label, scope, SQL expression) live in `src/query/sql/facets.ts`; `DEFAULT_SPAN_FACETS` and `DEFAULT_LOG_FACETS` move there and the rollup modules go.
- **D17 Publisher.** `ci report` and `ci site` write `site` reports, `ci site` compacts the rolling report (`compactOnMerge`) and passes a shared `assetsBase` of `<site>/assets/<otel-html version>/`, uploading that folder once per version; the README preview is rendered over a loopback HTTP server. Workflow, action and CI config edits stop and ask.
- **D18 No dedupe in SQL.** `span_id` is not unique across partitions after a merge of a report with its own converted ancestor (R55, note 3). The views carry no deduplication (spec §7.4); a trace with duplicate spans shows them twice (`buildTraceTree` tolerates duplicate ids) and counts them twice. Dedupe stays the writer's and the publisher's concern.
- **D19 One query-engine seam.** `src/viewer/data/query-engine.ts` defines `QueryEngine` (`query(q, signal)`, `exec(sql)`, `registerText(name, text)`, `close()`); `createDuckDbDataSource` and `residualIdTable` take a `QueryEngine`, never a `Coordinator`. `src/viewer/data/mosaic.ts` is the only module that imports `@uwdata/mosaic-core`: it builds the Coordinator over a hand-written `Connector` (`connection.useUnsafe` then `runQuery`, the shape Task 1.2's Node connector already has), not mosaic-core's `DuckDBWASMConnector`, so mosaic-core never calls duckdb-wasm, the pnpm override only prevents a second install, and the viewer's dependence on mosaic-core is one file. Plan 4's REST path is another `Connector` behind the same seam; a Mosaic-free `QueryEngine` over a bare connection would be another implementation of the same interface. `@uwdata/mosaic-sql` stays the SQL AST of every builder and of the OTTL translator: that is the deliberate, deeper investment. Agreed with the maintainer on 2026-11-07.

## Plans for this spec

Unchanged from plan 1: this is plan 2 (§7); plan 3 covers metrics in the viewer, plan 4 `host`, the publishing plan follows plan 2.

## Global Constraints

- Mosaic pinned exact: `@uwdata/mosaic-sql` **0.35.0** (dependency), `@uwdata/mosaic-core` **0.35.0**, `@uwdata/flechette` **2.7.1** (devDependencies). `@duckdb/duckdb-wasm` stays **1.32.0** (R47), enforced by `overrides` in `pnpm-workspace.yaml`. No `@duckdb/node-api`, no `@uwdata/mosaic-duckdb`.
- Import boundaries, each enforced by a biome `noRestrictedImports` override (D19): `@uwdata/mosaic-sql` only under `src/query/sql/` and `src/viewer/data/`; `@uwdata/mosaic-core` only in `src/viewer/data/mosaic.ts`; `@uwdata/flechette` only under `src/viewer/data/` (values in `mosaic.ts`, the `Table` type anywhere there); `@duckdb/duckdb-wasm` only under `src/viewer/data/engine/` and in `mosaic.ts`. Components, pages and state never import `@uwdata/*` or `@duckdb/*`. `apache-arrow` values are never imported under `src/viewer/` or `src/query/` (note 11; duckdb-wasm brings apache-arrow 17).
- `file://` rules: no `fetch` of report files, no ES modules, no worker loaded by URL in `local`; the worker comes from a blob URL and the engine binary reaches it as a data: URL (§3, §12).
- Queries name only the five views and the two virtual columns `filename` and `file_row_number`; never a file path in a FROM clause (§7.4).
- Every time column is selected relative to the epoch (D2); no SQL result carries an absolute time.
- `viewer.listCap` stays the row-list bound; `writer.facetValueCap` and `facetKeyCap` (from the manifest config) bound facet results as today.
- Partitions are immutable: the viewer never writes, and the only DDL it runs is the view creation at start and the residual temp table of D5.
- Engineering standards of plan 1 hold: strict TS, no `any`, typed `OtelHtmlError`s, injected deps, Biome clean, README in the PR that changes behaviour, TDD per task, `mise run check` before every push, the Chromium e2e suite before every PR.

## Review Focus

1. A report with no partitions, or a signal with no file in any partition: every view exists (typed, empty), every page shows its empty state and no query errors. (Task 1.2)
2. Attribute keys containing `/`, `~`, `"`, `.` or starting with `$`, and values stored as tagged objects (`{"$i":"9007199254740993"}`, `{"$d":"3"}`): `attributes["k"] == 3` and `== "x"` match the same rows in SQL as in `compileCondition`. (Task 2.4)
3. A span that starts before the window and ends inside it is counted, and a file whose `timeMax` is below the window start is still read for spans; a log file in that position is pruned. (Task 2.3)
4. A trace whose spans sit in three partitions: one trace row with the summed counts and the overall start and end, `getTrace` returns every span, `logCount` sums the partitions' `log_count`. (Task 3.4)
5. A `local` report whose `assets/` lacks an engine file, and a `site` report whose static host answers `HEAD` with 200 and no `Content-Range`: the first fails with an error naming the missing file, the second opens and range-reads. (Tasks 1.3, 5.7)

---

## PR 1: Engine start, coordinator and views

Branch `feat/format-4-viewer-engine` from `feat/format-4`. Title: `feat(viewer): DuckDB-WASM engine start, a Mosaic coordinator and the five views over a format-4 manifest`.

Nothing in the UI changes in this PR; the modules are unit-tested with the DuckDB Node build.

### Task 1.1: Dependencies and layering

**Files:**
- Modify: `package.json`, `pnpm-workspace.yaml`, `biome.json`, `test/scaffold.test.ts`
- Create: `src/format/parquet/columns.ts` (from the non-Arrow half of `schema.ts`), `src/format/engine.ts` (from `src/writer/engine-assets.ts`)
- Modify: `src/format/parquet/schema.ts` (keeps `arrowSchema` only, imports the rest), `scripts/engine-assets.ts`, `src/writer/viewer-assets.ts`, `scripts/gen-schema-doc.ts` and every importer of the moved names
- Test: `test/format/parquet/schema.test.ts`, `test/writer/engine-assets.test.ts` (moved to `test/format/engine.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  // src/format/parquet/columns.ts: TABLES, Table, ColumnType, ColumnDef, TABLE_COLUMNS, SORT_COLUMNS, TIME_COLUMN,
  // FIXED_STATISTICS_COLUMNS exactly as schema.ts exports them today; no apache-arrow import.
  // src/format/engine.ts
  export const ENGINE_VERSION = '1.32.0';
  export function engineAssetNames(format: 'local' | 'site'): string[];
  export const ENGINE_WASM_KEY = 'engine/wasm.gz';
  export const ENGINE_WORKER_KEY = 'engine/worker';
  ```

- [ ] **Step 1: Write the failing tests.** In `test/scaffold.test.ts` add `@uwdata/mosaic-sql` to the expected runtime dependency list. Add to `test/format/parquet/schema.test.ts`:

```ts
test('columns.ts carries no apache-arrow import', () => {
  const src = readFileSync(new URL('../../../src/format/parquet/columns.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/from 'apache-arrow'/);
});
```

- [ ] **Step 2: Run both files; expected FAIL** (missing dependency, missing module).
- [ ] **Step 3: Add the dependencies** with `pnpm add --save-exact @uwdata/mosaic-sql@0.35.0` and `pnpm add -D --save-exact @uwdata/mosaic-core@0.35.0 @uwdata/flechette@2.7.1`, then add to `pnpm-workspace.yaml`:

```yaml
overrides:
  "@duckdb/duckdb-wasm": "1.32.0"
```

  Check with `pnpm why @duckdb/duckdb-wasm` that one version is installed. Split `schema.ts` as the Interfaces block says; move `ENGINE_VERSION` and `engineAssetNames` to `src/format/engine.ts` with the two key constants, and make `scripts/engine-assets.ts` use the constants instead of its literals (M2). Add the biome overrides of the Global Constraints (D19): for `src/viewer/**` and `src/query/**`, `noRestrictedImports` on `apache-arrow` ("type-only imports allowed; the viewer bundles duckdb-wasm's apache-arrow 17"); for `src/viewer/**` except `src/viewer/data/**`, on `@uwdata/mosaic-core`, `@uwdata/mosaic-sql`, `@uwdata/flechette` and `@duckdb/duckdb-wasm` ("the data layer wraps the query engine"); for `src/viewer/data/**` except `src/viewer/data/mosaic.ts`, on `@uwdata/mosaic-core` ("mosaic.ts is the only Mosaic coordinator seam, D19"); for `src/viewer/data/**` except `src/viewer/data/engine/**` and `mosaic.ts`, on `@duckdb/duckdb-wasm` ("the engine folder wraps duckdb-wasm").
- [ ] **Step 4: Run `mise run check`; expected PASS** (knip must not report the new packages: they are imported by the end of this PR; until Task 1.5 lands, list them in a `// knip` ignore only if check fails, and remove the ignore in Task 1.5).
- [ ] **Step 5: Commit** `chore(viewer): mosaic-sql, mosaic-core and flechette pinned; engine names and column defs move to src/format`

### Task 1.2: The five views and the Node test engine

**Files:**
- Create: `src/query/sql/views.ts`, `test-support/duckdb-node.ts`, `test-support/format4-fixture.ts`
- Test: `test/query/sql/views.test.ts`

**Interfaces:**
- Consumes: `ManifestV4`, `PartitionEntry` (`src/format/manifest.ts`), `TABLE_COLUMNS`, `TABLES`, `ColumnType` (`columns.ts`), `parquetMetadata`'s way of loading the Node build (`test-support/parquet-metadata.ts`).
- Produces:
  ```ts
  // src/query/sql/views.ts
  /** DuckDB type of a column: utf8/json VARCHAR, int32 INTEGER, int64 BIGINT, float64 DOUBLE, bool BOOLEAN, lists DOUBLE[] / BIGINT[]. */
  export function duckdbType(type: ColumnType): string;
  /** The files of `table` in manifest order, as the names they are registered under (`resolve(manifestPath)`). */
  export function tableFiles(manifest: ManifestV4, table: Table, resolve: (path: string) => string): string[];
  /**
   * One `CREATE OR REPLACE VIEW <table> AS SELECT * FROM read_parquet([...], filename = true, file_row_number = true,
   * union_by_name = false)` per table; a table with no file gets a typed empty view (`SELECT NULL::<type> AS <col>, ...,
   * NULL::VARCHAR AS filename, NULL::BIGINT AS file_row_number WHERE false`).
   */
  export function viewStatements(manifest: ManifestV4, resolve: (path: string) => string): string[];
  /** The partition number in a `filename` value (`.../partitions/<p6>/<table>.parquet`); invalid-report when absent. */
  export function partitionOfFilename(filename: string): number;

  // test-support/duckdb-node.ts (tests only; the DuckDB Node blocking build, loaded as parquet-metadata.ts does)
  export interface TestDb {
    registerFile(name: string, bytes: Uint8Array): void;
    /** `db.registerFileText`; makes TestDb an `EngineFiles` (Task 1.5). */
    registerText(name: string, text: string): void;
    exec(sql: string): void;
    rows(sql: string): Record<string, unknown>[];
    /** A mosaic Connector over this database: `type: 'arrow'` returns the IPC bytes of `bindings.runQuery(conn, sql)`; it records every request in `requests` (tests count statements). */
    connector: Connector & { readonly requests: readonly { type: string; sql: string }[] };
    close(): void;
  }
  export async function openTestDb(): Promise<TestDb>;

  // test-support/format4-fixture.ts (tests only)
  export interface Format4Fixture { manifest: ManifestV4; files: Map<string, Uint8Array>; epoch: bigint }
  /** A `site`-format report written by the real partition session into a memory file system: one flush per `requests` entry, so each is a partition; `close: false` leaves them uncompacted. */
  export async function buildFormat4Report(requests: readonly OtlpRequest[], opts?: { config?: ConfigInput; close?: boolean }): Promise<Format4Fixture>;
  /** `openTestDb()` with every listed file registered under its manifest path and the views created. */
  export async function openFixtureDb(f: Format4Fixture): Promise<TestDb>;
  /** `n` spans in one trace over two services (OTLP JSON through `otlp()` of writer-deps.ts); `emptyManifest()` is a valid v4 manifest with no partitions. */
  export function spansOnlyRequest(n: number): OtlpRequest;
  export function emptyManifest(): ManifestV4;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('every table is a view; a table with no file is typed and empty', async () => {
  const f = await buildFormat4Report([spansOnlyRequest(3)]); // spans and traces only
  const db = await openFixtureDb(f);
  expect(db.rows('SELECT count(*) AS n FROM spans')[0]?.n).toBe(3n);
  expect(db.rows('SELECT count(*) AS n FROM logs')[0]?.n).toBe(0n);
  expect(db.rows("SELECT typeof(severity_number) AS t FROM logs LIMIT 1")).toEqual([]);
  expect(db.rows('DESCRIBE logs').map((r) => r.column_name)).toEqual([
    ...TABLE_COLUMNS.logs.map((c) => c.name), 'filename', 'file_row_number',
  ]);
});
test('filename and file_row_number name the partition and the row', async () => {
  const f = await buildFormat4Report([spansOnlyRequest(2), spansOnlyRequest(2)], { close: false });
  const db = await openFixtureDb(f);
  const rows = db.rows('SELECT filename, file_row_number AS i FROM spans ORDER BY filename, i');
  expect(rows.map((r) => partitionOfFilename(String(r.filename)))).toEqual([0, 0, 1, 1]);
  expect(rows.map((r) => r.i)).toEqual([0n, 1n, 0n, 1n]);
});
test('a filename predicate reads the named files only', async () => {
  const f = await buildFormat4Report([spansOnlyRequest(2), spansOnlyRequest(5)], { close: false });
  const db = await openFixtureDb(f);
  const [only] = tableFiles(f.manifest, 'spans', (p) => p).slice(1);
  expect(db.rows(`SELECT count(*) AS n FROM spans WHERE filename = '${only}'`)[0]?.n).toBe(5n);
});
test('viewStatements of an empty manifest creates five empty views', () => {
  const stmts = viewStatements(emptyManifest(), (p) => p);
  expect(stmts).toHaveLength(5);
  for (const s of stmts) expect(s).toMatch(/WHERE false$/);
});
```

- [ ] **Step 2: Run `pnpm exec vitest run test/query/sql/views.test.ts`; expected FAIL**
- [ ] **Step 3: Implement** `views.ts`, `duckdb-node.ts` (its connector runs `conn.useUnsafe((bindings, id) => bindings.runQuery(id, sql))`; for `type: 'exec'` it runs the statement and returns undefined) and `format4-fixture.ts` (the partition session with `writer: { format: 'site' }`, `flush()` after each request, `close()` unless `close: false`; the bytes come from `fs.readBytes` of every file the manifest lists).
- [ ] **Step 4: Run the test; expected PASS**
- [ ] **Step 5: Commit** `feat(query): the five format-4 views from a manifest; a DuckDB Node test engine and a format-4 fixture builder`

### Task 1.3: Engine start in both formats

**Files:**
- Create: `src/viewer/data/engine/bytes.ts`, `src/viewer/data/engine/start.ts`
- Test: `test/viewer-data/engine-bytes.test.ts`, `test/viewer-data/engine-start.test.ts` (a new `test/viewer-data/` folder: it runs in the `node` vitest project, which already includes `test/**` minus `test/viewer/`)

**Interfaces:**
- Consumes: `ScriptLoader` (`src/viewer/data/script-loader.ts`), `ENGINE_WASM_KEY`, `ENGINE_WORKER_KEY`, `engineAssetNames` (`src/format/engine.ts`), `ManifestV4['engine']`.
- Produces:
  ```ts
  // bytes.ts: pure, Node-testable
  export function fromBase64(s: string): Uint8Array;   // Uint8Array.fromBase64 when present, else atob
  export function toBase64(bytes: Uint8Array): string; // Uint8Array#toBase64 when present, else btoa in 32 KiB slices
  export function gunzip(bytes: Uint8Array): Promise<Uint8Array>; // DecompressionStream('gzip')

  // start.ts
  export interface EngineDeps {
    loader: ScriptLoader;
    /** `document.baseURI`: engine and partition URLs resolve against it. */
    baseUrl: string;
    createWorker: (url: string) => Worker;
    /** `URL.createObjectURL` / `revokeObjectURL`, injected for tests. */
    blobUrl: { create(blob: Blob): string; revoke(url: string): void };
  }
  export interface Engine {
    readonly db: AsyncDuckDB;
    readonly connection: AsyncDuckDBConnection;
    readonly format: 'local' | 'site';
    /** `db.registerFileText` (D5's id table); makes Engine an `EngineFiles` (Task 1.5). */
    registerText(name: string, text: string): Promise<void>;
    close(): Promise<void>; // connection.close(), db.terminate()
  }
  /** `assetsBase + name` resolved against `baseUrl`, for the two engine files of `format`. */
  export function engineUrls(engine: ManifestV4['engine'], baseUrl: string): { wasm: string; worker: string };
  /**
   * site: a Worker from the worker file's URL, `db.instantiate(wasmUrl)`, then
   * `db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } })`.
   * local: `loader.load(wasmWrapperUrl, ENGINE_WASM_KEY)` → fromBase64 → gunzip → `data:application/wasm;base64,<toBase64>`;
   * `loader.load(workerWrapperUrl, ENGINE_WORKER_KEY)` → fromBase64 → text → Worker from a blob URL (revoked after
   * instantiate). Both: `new AsyncDuckDB(new VoidLogger(), worker)`, `db.instantiate(wasmUrl)`, `db.connect()`.
   * A wrapper that fails to load rejects with the loader's invalid-report error (it names the file).
   */
  export async function startEngine(engine: ManifestV4['engine'], deps: EngineDeps): Promise<Engine>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// engine-bytes.test.ts
test('base64 round-trips and gunzip inverts gzipSync', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
  expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  expect(await gunzip(new Uint8Array(gzipSync(Buffer.from('hello'))))).toEqual(new TextEncoder().encode('hello'));
});
// engine-start.test.ts
test('engineUrls resolves the two files under assetsBase for each format', () => {
  const base = 'https://x.test/site/branch/main/index.html';
  expect(engineUrls({ version: '1.32.0', format: 'site', assetsBase: '../../assets/0.3.0/' }, base)).toEqual({
    wasm: 'https://x.test/site/assets/0.3.0/duckdb.1.32.0.wasm',
    worker: 'https://x.test/site/assets/0.3.0/duckdb.1.32.0.worker.js',
  });
  expect(engineUrls({ version: '1.32.0', format: 'local', assetsBase: 'assets/' }, 'file:///r/index.html').wasm)
    .toBe('file:///r/assets/duckdb.1.32.0.wasm.gz.b64.js');
});
test('local start gunzips the wrapper into a data: URL and makes the worker from a blob URL', async () => {
  // a fake AsyncDuckDB module is injected through vi.mock('@duckdb/duckdb-wasm'); the test records instantiate's argument
  const loader = scriptedLoader({ 'engine/wasm.gz': toBase64(gzipSync(Buffer.from('WASM'))), 'engine/worker': toBase64(Buffer.from('self.x=1')) });
  const created: string[] = [];
  await startEngine(localEngine, { loader, baseUrl: 'file:///r/index.html', createWorker: (u) => { created.push(u); return fakeWorker(); }, blobUrl: fakeBlobUrls() });
  expect(instantiated()[0]).toBe(`data:application/wasm;base64,${toBase64(Buffer.from('WASM'))}`);
  expect(created[0]).toMatch(/^blob:/);
});
test('a missing wrapper fails with the file name', async () => {
  await expect(startEngine(localEngine, deps(loaderThatFails('assets/duckdb.1.32.0.wasm.gz.b64.js')))).rejects.toMatchObject({ code: 'invalid-report', path: 'assets/duckdb.1.32.0.wasm.gz.b64.js' });
});
```

- [ ] **Step 2: Run `pnpm exec vitest run test/viewer-data/`; expected FAIL**
- [ ] **Step 3: Implement** `bytes.ts` and `start.ts` as the Interfaces block says (the `local` path must `null` out the base64 strings and decoded buffers once `instantiate` resolves; `Blob` and `DecompressionStream` are globals in Node 24, so no DOM shim is needed).
- [ ] **Step 4: Run the tests; expected PASS**
- [ ] **Step 5: Commit** `feat(viewer): start DuckDB-WASM from a format-4 manifest's engine block in local and site format`

### Task 1.4: Registering the partitions

**Files:**
- Create: `src/viewer/data/engine/files.ts`
- Test: `test/viewer-data/engine-files.test.ts`

**Interfaces:**
- Consumes: `Engine` (Task 1.3), `viewStatements`, `tableFiles` (Task 1.2), `partitionWrapperPath`, `partitionKey` (`src/format/paths.ts`), `DuckDBDataProtocol.HTTP` (`@duckdb/duckdb-wasm`).
- Produces:
  ```ts
  export interface RegisterProgress { done: number; total: number }
  /**
   * Registers every file the manifest lists under its manifest path (`data/partitions/<p6>/<table>.parquet`) and runs
   * `viewStatements(manifest, (p) => p)`. site: `db.registerFileURL(path, new URL(path, baseUrl).href, HTTP, false)`.
   * local: `loader.load(new URL(partitionWrapperPath(n, t), baseUrl).href, partitionKey(n, t))` → fromBase64 →
   * `db.registerFileBuffer(path, bytes)`, four loads in flight at a time, `onProgress` after each file.
   */
  export async function registerPartitions(engine: Engine, manifest: ManifestV4, deps: Pick<EngineDeps, 'loader' | 'baseUrl'>, onProgress?: (p: RegisterProgress) => void): Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('site registers each file by URL with range reads and creates the views', async () => {
  const engine = fakeEngine('site');
  await registerPartitions(engine, twoPartitionManifest, { loader: neverLoader(), baseUrl: 'https://h/r/index.html' });
  expect(engine.calls.registerFileURL).toEqual([
    ['data/partitions/000000/spans.parquet', 'https://h/r/data/partitions/000000/spans.parquet', DuckDBDataProtocol.HTTP, false],
    ...
  ]);
  expect(engine.calls.exec.filter((s) => s.startsWith('CREATE OR REPLACE VIEW'))).toHaveLength(5);
});
test('local loads each wrapper under its partition key and registers the bytes, reporting progress', async () => {
  const loader = scriptedLoader({ 'partitions/000000/spans': toBase64(PARQUET_BYTES), ... });
  const progress: RegisterProgress[] = [];
  await registerPartitions(fakeEngine('local'), twoPartitionManifest, { loader, baseUrl: 'file:///r/index.html' }, (p) => progress.push(p));
  expect(loader.calls).toContain('file:///r/data/partitions/000000/spans.parquet.js');
  expect(progress.at(-1)).toEqual({ done: 4, total: 4 });
});
```

- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement** `files.ts`.
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(viewer): register the manifest's partitions by URL or from their wrappers and create the views`

### Task 1.5: The query-engine seam and its Mosaic implementation

**Files:**
- Create: `src/viewer/data/query-engine.ts`, `src/viewer/data/mosaic.ts`
- Test: `test/viewer-data/mosaic.test.ts`

**Interfaces:**
- Consumes: `Coordinator`, `Connector`, `QueryResult` (`@uwdata/mosaic-core`; this file and its test are the only importers, D19), `AsyncDuckDBConnection` (`@duckdb/duckdb-wasm`), `Table` (`@uwdata/flechette`), `Query` (`@uwdata/mosaic-sql`), `Engine` (Task 1.3), `TestDb` (Task 1.2).
- Produces:
  ```ts
  // query-engine.ts: the one seam between the data source and whatever runs SQL (D19). No Mosaic import.
  export interface QueryEngine {
    /** Runs one query; int64 columns decode as bigint. An aborted signal rejects with `DOMException('AbortError')`. */
    query(q: Query, signal?: AbortSignal): Promise<Table>;
    /** A statement without a result: the view creation at start, the D5 temp table. */
    exec(sql: string): Promise<void>;
    /** Registers a text file a later statement reads (D5: `read_csv`). */
    registerText(name: string, text: string): Promise<void>;
    close(): Promise<void>;
  }
  /** What the engine does besides SQL; `Engine` and `TestDb` both satisfy it. */
  export interface EngineFiles {
    registerText(name: string, text: string): void | Promise<void>;
    close(): void | Promise<void>;
  }

  // mosaic.ts
  export type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  /**
   * A hand-written mosaic Connector over a duckdb-wasm connection, not `DuckDBWASMConnector` (D19): `type: 'arrow'`
   * returns the IPC bytes of `connection.useUnsafe((bindings, id) => bindings.runQuery(id, sql))`; `type: 'exec'` runs
   * the same and resolves undefined; `type: 'json'` is rejected with `invalid-report` (never requested).
   */
  export function engineConnector(connection: AsyncDuckDBConnection): Connector;
  /** `new Coordinator(connector, { logger, cache: true, consolidate: true, ipc: { useBigInt: true, useDate: false }, preagg: { enabled: false } })`. */
  export function createCoordinator(connector: Connector, logger: Logger): Coordinator;
  /**
   * The `QueryEngine` over a coordinator. `query` is `coordinator.query(q)`; an aborted signal rejects with
   * `DOMException('AbortError')` and cancels the request if it is still queued (`coordinator.cancel([result])`); the
   * generated SQL is attached to a failure as `OtelHtmlError('invalid-report', { path: 'query', expected: 'a query the
   * engine accepts', actual: <engine message>, hint: <sql> })`. `exec` sends `{ type: 'exec', sql }` through the
   * coordinator (so its cache sees the DDL); `registerText` and `close` delegate to `files`.
   */
  export function mosaicQueryEngine(coordinator: Coordinator, files: EngineFiles): QueryEngine;
  ```

- [ ] **Step 1: Write the failing tests** (the fake connector answers with flechette `tableToIPC(tableFromArrays(...))` bytes and records every request it saw; `fakeFiles()` records texts)

```ts
test('query decodes int64 as bigint and the coordinator caches the same SQL', async () => {
  const conn = fakeConnector({ n: [5n] });
  const qe = mosaicQueryEngine(createCoordinator(conn, silentLogger), fakeFiles());
  const t1 = await qe.query(Query.from('spans').select({ n: count() }));
  expect(t1.getChild('n')?.at(0)).toBe(5n);
  await qe.query(Query.from('spans').select({ n: count() }));
  expect(conn.requests).toHaveLength(1);
});
test('an aborted signal rejects with AbortError', async () => {
  const ctl = new AbortController(); ctl.abort();
  const qe = mosaicQueryEngine(createCoordinator(fakeConnector({}), silentLogger), fakeFiles());
  await expect(qe.query(Query.from('spans').select('x'), ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
test('an engine error carries the SQL as its hint', async () => {
  const qe = mosaicQueryEngine(createCoordinator(failingConnector('Binder Error: x'), silentLogger), fakeFiles());
  await expect(qe.query(Query.from('spans').select('x'))).rejects.toMatchObject({ code: 'invalid-report', hint: expect.stringContaining('SELECT') });
});
test('exec is an exec request and registerText reaches the engine files', async () => {
  const conn = fakeConnector({}); const files = fakeFiles();
  const qe = mosaicQueryEngine(createCoordinator(conn, silentLogger), files);
  await qe.exec('CREATE TEMP TABLE t AS SELECT 1');
  expect(conn.requests.at(-1)).toMatchObject({ type: 'exec', sql: expect.stringContaining('CREATE TEMP TABLE') });
  await qe.registerText('ids.csv', 'filename,row\n');
  expect(files.texts.get('ids.csv')).toBe('filename,row\n');
});
test('engineConnector runs arrow and exec requests through useUnsafe/runQuery', async () => {
  const seen: string[] = [];
  const connection = fakeConnection((sql) => { seen.push(sql); return ipcBytes({ n: [1n] }); }); // { useUnsafe(f) { return f({ runQuery: async (_id, sql) => ... }, 1); } }
  const c = engineConnector(connection);
  const bytes = await c.query({ type: 'arrow', sql: 'SELECT 1 AS n' });
  expect(bytes).toBeInstanceOf(Uint8Array);
  await expect(c.query({ type: 'exec', sql: 'CREATE VIEW v AS SELECT 1' })).resolves.toBeUndefined();
  expect(seen).toEqual(['SELECT 1 AS n', 'CREATE VIEW v AS SELECT 1']);
});
test('the same connector shape runs against the Node engine', async () => {
  const db = await openFixtureDb(await buildFormat4Report([spansOnlyRequest(3)]));
  const t = await mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db).query(Query.from('spans').select({ n: count() }));
  expect(t.getChild('n')?.at(0)).toBe(3n);
});
```

- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement** `query-engine.ts` and `mosaic.ts`. Remove any knip ignore added in Task 1.1. `mise run check` must show the D19 biome override holding: a deliberate `import { Coordinator } from '@uwdata/mosaic-core'` in `duckdb-source.ts` is reported (try it, then revert).
- [ ] **Step 4: Run; expected PASS. Run `mise run check`; expected PASS.**
- [ ] **Step 5: Commit** `feat(viewer): the QueryEngine seam, a hand-written duckdb-wasm connector and its Mosaic coordinator implementation`

### PR 1 close

- [ ] Run `mise run verify`. Open the PR with the title above; the body lists the new dependencies (D-list entry D1 and the override), the bundle size delta of `dist/viewer/assets/viewer.*.js` (before and after `mise run build`), and `pnpm why @duckdb/duckdb-wasm` output. Branch review on Opus 5.5. Merge.

---

## PR 2: OTTL to SQL and partition pruning

Branch `feat/format-4-viewer-ottl-sql` from `feat/format-4`. Title: `feat(query): OTTL conditions as mosaic-sql predicates, with residual terms and partition pruning hints`.

### Task 2.1: Column map and JSON access

**Files:**
- Create: `src/query/sql/columns.ts`
- Test: `test/query/sql/columns.test.ts`

**Interfaces:**
- Consumes: `ExprNode`, `column`, `sql`, `literal` (`@uwdata/mosaic-sql`), `OttlContextName` (`src/ottl/contexts.ts`).
- Produces:
  ```ts
  export type SqlContext = 'span' | 'log_record';
  export type ColumnKind = 'string' | 'int' | 'bool' | 'json' | 'bigid';
  export interface PathColumn { readonly column: string; readonly kind: ColumnKind; readonly nullAsEmpty?: true }
  /**
   * Canonical OTTL path (context prefix stripped, as `CONTEXTS[c].paths` keys it) → view column. span: name, kind,
   * status.code, status.message, trace_id.string, span_id.string, parent_span_id.string (null reads as ''), trace_state,
   * flags, start_time_unix_nano, end_time_unix_nano, dropped_*_count, attributes (json), resource.attributes (json),
   * resource.schema_url, resource.dropped_attributes_count, instrumentation_scope.name/version/attributes/schema_url/
   * dropped_attributes_count. log_record: time_unix_nano, observed_time_unix_nano (null reads as 0), severity_number,
   * severity_text, event_name, body (json), body.string, attributes, trace_id.string, span_id.string (null as ''), flags,
   * dropped_attributes_count, the same resource and scope paths.
   */
  export const PATH_COLUMNS: Readonly<Record<SqlContext, ReadonlyMap<string, PathColumn>>>;
  /** `/a~1b` for keys ['a/b']; a numeric key is an array index segment. */
  export function jsonPointer(keys: readonly (string | number)[]): string;
  /** `json_extract(<col>, '<pointer>')` (JSON typed) and `json_extract_string(...)` (VARCHAR). */
  export function jsonAt(col: string, keys: readonly (string | number)[]): ExprNode;
  export function jsonStringAt(col: string, keys: readonly (string | number)[]): ExprNode;
  /** A JSON value as DOUBLE: plain numbers directly, `{"$i"}` / `{"$d"}` through TRY_CAST of the tag text, else NULL. */
  export function jsonNumber(json: ExprNode): ExprNode;
  /** OTTL kind of a JSON value: 'string' | 'int' | 'double' | 'bool' | 'map' | 'list' | 'bytes' | 'nil', as a VARCHAR expression (reads the tags). */
  export function jsonKind(json: ExprNode): ExprNode;
  /** `<col> - <epoch>::BIGINT`; and `<epoch>::BIGINT + <rel>` for literals. */
  export function relTime(col: string, epoch: bigint): ExprNode;
  export function absLiteral(rel: number, epoch: bigint): ExprNode;
  /** DuckDB SQL text of an expression (mosaic-sql's DuckDB code generator), for tests and error hints. */
  export function toSql(e: ExprNode): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('jsonPointer escapes ~ and / and takes numeric segments as indexes', () => {
  expect(jsonPointer(['a/b~c', 0, 'x'])).toBe('/a~1b~0c/0/x');
});
test('jsonNumber reads plain numbers and tagged ints and doubles', async () => {
  const db = await openTestDb();
  const sql = (j: string) => db.rows(`SELECT ${toSql(jsonNumber(verbatim(`'${j}'::JSON`)))} AS v`)[0]?.v;
  expect(sql('3')).toBe(3); expect(sql('{"$i":"9007199254740993"}')).toBe(9007199254740992); expect(sql('{"$d":"3"}')).toBe(3); expect(sql('"x"')).toBeNull();
});
test('every OTTL path CONTEXTS knows is mapped or listed as unmapped', () => {
  for (const c of ['span', 'log_record'] as const) {
    for (const path of CONTEXTS[c].paths.keys()) expect(PATH_COLUMNS[c].has(path) || UNMAPPED_PATHS[c].has(path), path).toBe(true);
  }
});
```

- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement** `columns.ts`. `UNMAPPED_PATHS` is exported for the test and lists the paths with no column (none expected for span and log_record; the test exists so a new OTTL path cannot go unmapped silently).
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(query): OTTL path to column map, JSON pointer access and tagged-number reading for format 4`

### Task 2.2: The translator

**Files:**
- Create: `src/query/sql/ottl.ts`
- Test: `test/query/sql/ottl.test.ts` (golden SQL)

**Interfaces:**
- Consumes: `parseCondition` (`src/ottl/parse.ts`), `Expr`, `Value` (`src/ottl/ast.ts`), `ENUMS` (`src/ottl/contexts.ts`), Task 2.1, `and`, `or`, `not`, `eq`, `neq`, `lt`, `gt`, `lte`, `gte`, `isNull`, `isNotNull`, `regexp_matches`, `coalesce`, `literal`, `duckDBCodeGenerator` (`@uwdata/mosaic-sql`).
- Produces:
  ```ts
  /** Statistics key → the values a matching row must have (strings as R16 stores them). Keys: scope_name, service_name, name, severity_number, `resource:<k>`. */
  export type PruneHints = ReadonlyMap<string, ReadonlySet<string>>;
  export interface Translation {
    /** The translatable terms of the top-level `and`, or null when none. */
    predicate: ExprNode | null;
    /** The untranslatable terms as one OTTL condition (printed with printCondition), or null when the whole condition translated. */
    residual: string | null;
    hints: PruneHints;
  }
  export function translateCondition(src: string, context: SqlContext): Translation;
  /** Case-insensitive contains over the signal's text fields (D10): spans name, status_message, attributes, resource_attributes; logs body text, severity_text, event_name, attributes, resource_attributes. Empty text is null. */
  export function textPredicate(text: string, context: SqlContext): ExprNode | null;
  export { toSql } from './columns.js';
  ```
- Rules the implementer applies:
  - Flatten the top-level `and`. Translate each term; a term whose translation throws `Untranslatable` goes to the residual. Inside a term, `and`, `or`, `not` translate recursively; one untranslatable leaf makes the whole term residual.
  - `cmp` with a path on one side and a literal or enum on the other. Column kinds: `string` columns compare as VARCHAR (`nullAsEmpty` wraps in `coalesce(col, '')`); `int` columns compare with the literal cast `::BIGINT`; `bool`; `bigid` (`trace_id.string` etc.) as VARCHAR. Time paths compare the absolute column against the literal as `::BIGINT`. `json` paths with keys: a string literal compares `jsonStringAt`, a number compares `jsonNumber(jsonAt)`, a boolean compares `jsonAt(...) = 'true'::JSON`, `nil` compares `jsonAt(...) IS NULL`; `== nil` on a column is `IS NULL` (`nullAsEmpty` columns compare against `''`). `body.string` reads `CASE WHEN json_type(body) = 'VARCHAR' THEN json_extract_string(body, '$') ELSE body END`. `<`, `>` on strings are lexical, as OTTL. A `cmp` between two paths, or math other than `end_time_unix_nano - start_time_unix_nano` (which is `duration_ns`), is untranslatable.
  - Calls: `IsMatch(x, "re")` → `regexp_matches(coalesce(<x as VARCHAR>, ''), 're')` (a JSON path uses `jsonStringAt`); `IsRootSpan()` → `parent_span_id IS NULL`; `IsString/IsInt/IsDouble/IsBool/IsMap/IsList(path)` → `jsonKind(...) = '<kind>'` for json paths, a constant for columns; any other converter (`Len`, nested calls) is untranslatable.
  - Hints: a translated top-level term `path == literal` (or enum) where the path maps to `scope_name`, `service_name`, `name` (span), `severity_number` (log), or is `resource.attributes["k"]` adds `{ key → {String(value)} }`; `or` of such terms on one key adds the union; anything else adds nothing. Enum literals use their numeric text.

- [ ] **Step 1: Write the failing golden test**

```ts
const cases: [string, SqlContext, string, string | null][] = [
  ['name == "GET /"', 'span', `("name" = 'GET /')`, null],
  ['status.code == STATUS_CODE_ERROR', 'span', `("status_code" = 2::BIGINT)`, null],
  ['attributes["http.status_code"] >= 500', 'span', `(<jsonNumber over json_extract("attributes", '/http.status_code')> >= 500)`, null],
  ['resource.attributes["service.name"] == "web" and IsMatch(name, "^GET")', 'span', `(("json_extract_string("resource_attributes", '/service.name') = 'web')) AND (regexp_matches(coalesce("name", ''), '^GET')))`, null],
  ['span.end_time_unix_nano - span.start_time_unix_nano > 1000000', 'span', `("duration_ns" > 1000000::BIGINT)`, null],
  ['IsRootSpan()', 'span', `("parent_span_id" IS NULL)`, null],
  ['log.severity_number >= SEVERITY_NUMBER_WARN and Len(body) > 3', 'log_record', `("severity_number" >= 13::BIGINT)`, 'Len(body) > 3'],
  ['trace_id.string == ""', 'log_record', `(coalesce("trace_id", '') = '')`, null],
];
test.each(cases)('%s', (src, ctx, sql, residual) => {
  const t = translateCondition(src, ctx);
  expect(t.predicate === null ? null : toSql(t.predicate)).toBe(sql);
  expect(t.residual).toBe(residual);
});
test('hints collect equality on statistics columns and resource keys', () => {
  expect(translateCondition('resource.attributes["service.name"] == "web" and name == "a" and kind == SPAN_KIND_SERVER', 'span').hints)
    .toEqual(new Map([['service_name', new Set(['web'])], ['name', new Set(['a'])]]));
  expect(translateCondition('resource.attributes["cicd.pipeline.run.id"] == 42', 'span').hints).toEqual(new Map([['resource:cicd.pipeline.run.id', new Set(['42'])]]));
  expect(translateCondition('name != "a" or name == "b"', 'span').hints.size).toBe(0);
});
```

  The exact golden strings are fixed on the first green run (write them from `toSql` output after reading it for correctness) and committed; the point is that a later change to the generator is visible.

- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement** `ottl.ts`.
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(query): translate OTTL conditions to mosaic-sql predicates, residual terms and pruning hints`

### Task 2.3: Pruning by manifest statistics

**Files:**
- Create: `src/query/sql/prune.ts`
- Test: `test/query/sql/prune.test.ts`

**Interfaces:**
- Consumes: `ManifestV4`, `PartitionFile`, `Table`, `PruneHints`.
- Produces:
  ```ts
  export interface AbsWindow { start: bigint; end: bigint }
  export interface Pruned { files: readonly string[]; /** all files kept: no predicate needed */ all: boolean; total: number }
  /**
   * The files of `table` a query must read. A file is dropped when, for some hint key, the file's `values[key]` is an
   * array disjoint from the hint set (an `attr:`/`resource:` key only when `manifest.statisticsKeys[table]` lists it);
   * or when `window` is set and `timeMin > window.end`; or, for logs and points only, when `timeMax < window.start`.
   * `null` statistics and keys the file lacks keep the file.
   */
  export function prunePartitions(manifest: ManifestV4, table: Table, hints: PruneHints, window: AbsWindow | null): Pruned;
  export function absWindow(w: TimeWindow | null, epoch: bigint): AbsWindow | null;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('an equality hint drops files whose values exclude it and keeps null statistics', () => {
  const m = manifestWith([{ service_name: ['a'] }, { service_name: ['b'] }, { service_name: null }]);
  expect(prunePartitions(m, 'spans', hints({ service_name: ['a'] }), null)).toEqual({ files: [file(0), file(2)], all: false, total: 3 });
});
test('a resource key hint applies only when statisticsKeys lists it', () => {
  const m = manifestWith([{ 'resource:run': ['1'] }], { statisticsKeys: { spans: ['resource:run'] } });
  expect(prunePartitions(m, 'spans', hints({ 'resource:run': ['2'] }), null).files).toEqual([]);
  expect(prunePartitions(withoutKey(m), 'spans', hints({ 'resource:run': ['2'] }), null).all).toBe(true);
});
test('spans prune on the upper bound only, logs on both', () => {
  const m = manifestWith([{ timeMin: '100', timeMax: '200' }, { timeMin: '500', timeMax: '600' }]);
  const w = { start: 300n, end: 400n };
  expect(prunePartitions(m, 'spans', new Map(), w).files).toEqual([file(0)]);
  expect(prunePartitions(m, 'logs', new Map(), w).files).toEqual([]);
});
```

- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement** `prune.ts`.
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(query): prune format-4 partitions by manifest statistics and the time window`

### Task 2.4: Equivalence with the browser evaluator

**Files:**
- Test: `test/query/sql/ottl-equivalence.test.ts`

- [ ] **Step 1: Write the test.** Build a fixture of about 40 spans and 40 logs whose attributes cover: strings with quotes and slashes in keys (`a/b`, `q"x`, `$weird`), ints within and beyond 2^53, whole and fractional doubles, bools, nested maps, arrays, bytes, empty values; log bodies that are strings, maps and ints; some null trace ids and parent ids. For each condition in a list of at least 25 (every golden case of Task 2.2 plus `attributes["a/b"] == "x"`, `attributes["n"] == 9007199254740993`, `attributes["d"] == 3`, `attributes["d"] == 3.5`, `attributes["b"] == true`, `attributes["m"]["k"] == "v"`, `attributes["missing"] == nil`, `IsMap(attributes["m"])`, `IsMatch(body.string, "err.*")`, `severity_text == "WARN"`, `body.string == "plain"`): run `SELECT span_id FROM spans WHERE <predicate>` (or `file_row_number` for logs) and compare the id set with the rows for which `compileCondition(src, ctx).test(target)` is true over the same records; a condition with a residual asserts that the SQL set is a superset and the residual re-check equals the JS set.
- [ ] **Step 2: Run; fix translator bugs the comparison finds (expected: the tagged-number and nil cases).**
- [ ] **Step 3: Run `mise run check`; expected PASS**
- [ ] **Step 4: Commit** `test(query): SQL and browser evaluation agree on the translatable OTTL subset`

### PR 2 close

- [ ] `mise run verify`; PR with the title above; body lists the translatable subset and the residual rule (D4, D5, D10). Branch review on Opus 5.5. Merge.

---

## PR 3: Span, trace and service queries; the format-4 data source

Branch `feat/format-4-viewer-spans` from `feat/format-4`. Title: `feat(viewer): span, trace and service queries over DuckDB and the format-4 data source`.

### Task 3.1: Decoding rows back into records

**Files:**
- Create: `src/format/parquet/decode.ts`
- Test: `test/format/parquet/decode.test.ts`

**Interfaces:**
- Consumes: `spanRow`, `logRow`, `Context` (`src/format/parquet/rows.ts`), `anyValueFromJson`, `attributesFromJson` (`src/format/columns.ts`), `SpanRecord`, `LogRecordRecord`, `ResourceRecord`, `ScopeRecord`.
- Produces:
  ```ts
  /** A row as the query result delivers it: column name → value (bigint for int64, string for json). */
  export type ResultRow = Readonly<Record<string, unknown>>;
  export interface DecodedShared { resource: ResourceRecord; scope: ScopeRecord }
  /** The inverse of `spanRow`: times relative to `epoch`, attributes/events/links from their JSON texts; `resource`/`scope` refs are left for the caller's interner (0 placeholders). */
  export function spanFromRow(row: ResultRow, epoch: bigint): { span: SpanRecord; shared: DecodedShared };
  export function logFromRow(row: ResultRow, epoch: bigint): { log: LogRecordRecord; shared: DecodedShared };
  /** Interns resources and scopes by their JSON text + schema_url + dropped count, handing out stable refs within one result. */
  export class SharedInterner { resource(r: ResourceRecord): ResourceRef; scope(s: ScopeRecord): ScopeRef; readonly resources: readonly ResourceRecord[]; readonly scopes: readonly ScopeRecord[] }
  ```

- [ ] **Step 1: Write the failing test:** for a span and a log with every field set (events with attributes, links, bytes and big-int attributes, a map body), `spanFromRow(spanRow(span, ctx) as ResultRow, epoch)` equals the original record (resource/scope refs excepted) and the shared records equal `ctx`'s.
- [ ] **Step 2: Run; expected FAIL** · **Step 3: Implement** · **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(format): decode format-4 span and log rows back into records`

### Task 3.2: Result types

**Files:**
- Create: `src/viewer/data/results.ts`
- Modify: `src/viewer/data/span-query.ts` (types only in this task; the scan code is deleted in PR 5)
- Test: none (types), covered by Task 3.4

**Interfaces:**
- Produces:
  ```ts
  export interface RedBuckets { startNs: number; widthNs: number; counts: readonly number[]; errors: readonly number[]; p50: readonly (number | null)[]; p95: readonly (number | null)[]; p99: readonly (number | null)[]; max: readonly (number | null)[] }
  export interface DurationSummary { count: number; min: number; max: number; sum: number; p50: number; p95: number; p99: number }
  export interface DurationBin { fromNs: number; toNs: number; count: number } // moves here from facet-panel.tsx
  export interface GroupStats { group: string; count: number; sum: number; avg: number; max: number; p95: number; p99: number }
  export interface GroupStatsResult { groups: readonly GroupStats[]; cap: number; dropped: number }
  export interface Durations { summary: DurationSummary | null; bins: readonly DurationBin[] }
  export type SpanNeed = 'rows' | 'facets' | 'timeline' | 'durations' | 'groups';
  export interface ServiceStats { service: string; requests: number; errors: number; p50: number; p95: number; p99: number; max: number; buckets: TimeBuckets<'count'> }
  export interface ServicesResult { services: readonly ServiceStats[]; total: number }
  ```
  `SpanQuery` gains `needs: readonly SpanNeed[]` (what to compute; absent parts are empty) and `facetKeys: readonly string[] | null` (restrict facets to these keys; null means every core facet plus attributes), and loses `scanAll`. `SpanQueryResult` becomes `{ rows; total; facets: FacetCounts; buckets: TimeBuckets<SpanStatusKey>; red: RedBuckets | null; durations: Durations; groups: GroupStatsResult | null; residual: boolean }` (`partial` gone; `residual` true when D5 applied). `TraceRow` becomes `{ traceId; rootSummary: { service; name; resource } | null; start; durationNs; spans; errors }`. `SpanRow` keeps `{ span; service; resource; durationNs }`; its refs index the result's `RowTables { resources; scopes }` returned beside the rows as `SpanQueryResult.tables`.

- [ ] **Step 1: Write the types; `mise run typecheck` fails in consumers (expected until PR 5); keep the old modules compiling by adjusting their literals minimally (`needs: ['rows','facets','timeline']`).**
- [ ] **Step 2: Commit** `feat(viewer): result types for SQL-backed span queries`

### Task 3.3: Span query builders

**Files:**
- Create: `src/query/sql/filter.ts`, `src/query/sql/facets.ts`, `src/query/sql/time.ts`, `src/query/sql/spans.ts`
- Test: `test/query/sql/spans.test.ts` (against the Node engine and the fixture of Task 1.2)

**Interfaces:**
- Consumes: Tasks 2.1 to 2.3, `Query`, aggregate and operator functions (`@uwdata/mosaic-sql`), `SEVERITY_BANDS` (`src/semconv/severity.ts`), `ATTR_*` constants (`src/semconv/attributes.ts`).
- Produces:
  ```ts
  // filter.ts
  export interface SqlFilter { predicate: ExprNode | null; text: ExprNode | null; files: Pruned; window: AbsWindow | null; epoch: bigint }
  /** translateCondition + textPredicate + prunePartitions for one table; `traceId` adds `trace_id = ?` and prunes to the partitions `traces` names (the caller passes them). */
  export function buildFilter(opts: { manifest: ManifestV4; table: 'spans' | 'logs'; condition: string | null; text: string; window: TimeWindow | null; traceId?: TraceId | null; traceFiles?: readonly string[] }): { filter: SqlFilter; residual: string | null };
  /** The WHERE terms: predicate, text, `filename IN (...)` unless `files.all`, and the window: spans `end >= start_abs AND start <= end_abs`, logs `coalesce(time, observed) BETWEEN`. */
  export function whereOf(f: SqlFilter, table: 'spans' | 'logs' | 'traces'): ExprNode[];

  // facets.ts (D16)
  export interface CoreFacet { key: string; label: string; scope: 'core' | 'resource'; /** the VARCHAR expression of the facet's value, null when the row has none */ expr: ExprNode; kind: 'string' | 'int' | 'double' | 'bool' }
  export const CORE_SPAN_FACETS: readonly CoreFacet[]; // service.name, span.name, span.kind (names: unspecified..consumer), status.code (ok|error|unset), resource (resource_name), instrumentation_scope.name, host.name, deployment.environment.name
  export const CORE_LOG_FACETS: readonly CoreFacet[];  // severity (band via SEVERITY_BANDS CASE), service.name, host.name, instrumentation_scope.name, event.name (null for ''), trace.present (yes|no)
  export const SPAN_RESOURCE_FACET_KEYS: ReadonlySet<string>; export const LOG_RESOURCE_FACET_KEYS: ReadonlySet<string>;
  /** One query: `GROUP BY GROUPING SETS ((f1),(f2),...)` over the chosen core facets → rows (key, value, count); nulls skipped. */
  export function coreFacetsQuery(f: SqlFilter, table: 'spans' | 'logs', keys: readonly CoreFacet[]): Query;
  /**
   * Attribute facets in one query: `unnest(json_keys(attributes)) AS k`, value text and kind through jsonKind/jsonStringAt
   * (truncated to MAX_FACET_VALUE_LENGTH), scalar kinds only, keys not among the core keys; `QUALIFY row_number() OVER
   * (PARTITION BY k ORDER BY n DESC, v) <= valueCap` and keys ranked by `sum(n) OVER (PARTITION BY k)` within keyCap;
   * per key also the total and the kind (`mixed` when more than one). Returns rows (key, kind, value, count, total).
   */
  export function attributeFacetsQuery(f: SqlFilter, table: 'spans' | 'logs', caps: FacetCaps, excludeKeys: readonly string[]): Query;

  // time.ts
  export interface BucketSpec { widthNs: number; startNs: number; endNs: number } // relative, aligned, width = 1 ms * 2^k, <= 4096 buckets over [startNs, endNs]
  /** From the window, else the manifest range (relative), with TimeBuckets' rule (4096 max, widths 1 ms * 2^k). */
  export function bucketSpec(window: TimeWindow | null, range: { start: number; end: number } | null): BucketSpec;
  /** `greatest(floorDiv(rel, w) * w, startNs)` with the exact non-negative-modulo floor division of time-buckets.ts. */
  export function bucketExpr(col: string, spec: BucketSpec, epoch: bigint): ExprNode;

  // spans.ts
  export interface SpanSort { column: 'start' | 'duration' | 'name' | 'service' | 'resource' | 'status'; dir: 'asc' | 'desc' }
  export interface TraceSort { column: 'start' | 'duration' | 'spans' | 'errors' | 'service' | 'resource'; dir: 'asc' | 'desc' }
  /** Every spans column (times relative) plus filename, file_row_number and `count(*) OVER () AS total`; ORDER BY the sort then (start, span_id); LIMIT. */
  export function spanRowsQuery(f: SqlFilter, sort: SpanSort, limit: number): Query;
  /** Trace ids of matching spans (`SELECT DISTINCT trace_id`), joined to `traces` aggregated per trace_id: sum(span_count), sum(error_count), min(start), max(end), root from the row with the smallest start whose root_name is not null; sort, limit, `count(*) OVER ()`. */
  export function traceRowsQuery(f: SqlFilter, sort: TraceSort, limit: number): Query;
  /** bucket, count(*), count FILTER status_code = 2 (errors), status buckets (ok 1 / error 2 / unset other), quantile_cont(duration_ns, [0.5, 0.95, 0.99]), max(duration_ns), GROUP BY bucket. */
  export function timelineQuery(f: SqlFilter, spec: BucketSpec): Query;
  export function durationSummaryQuery(f: SqlFilter): Query; // count, min, max, sum, quantiles
  /** `width_bucket(log2(greatest(duration_ns, 1)), lo, hi, n)` over the axis `durationAxis` gives (views.ts). */
  export function durationBinsQuery(f: SqlFilter, axis: { fromNs: number; toNs: number }[]): Query;
  /** GROUP BY the facet expression of `key` (core facet or `jsonStringAt(attributes, [key])`), ORDER BY count DESC, LIMIT cap + 1 (the extra row is counted into `dropped` by the mapper). */
  export function groupStatsQuery(f: SqlFilter, table: 'spans', key: string, cap: number): Query;
  export function tracePartitionsQuery(traceId: TraceId): Query;           // SELECT DISTINCT filename FROM traces WHERE trace_id = ?
  export function traceSpansQuery(traceId: TraceId, files: readonly string[], epoch: bigint): Query; // every span of the trace from the spans files of those partitions
  export function traceSummaryQuery(traceId: TraceId): Query;              // sum(span_count), sum(log_count), count(*) FROM traces WHERE trace_id = ?
  export function percentileQuery(service: string, resource: string, durationNs: number): Query; // count FILTER (duration_ns <= d) * 100.0 / count(*), count(*)
  export function servicesQuery(f: SqlFilter, limit: number): Query;       // GROUP BY service_name: count, errors, quantiles, max; ORDER BY count DESC LIMIT
  export function serviceBucketsQuery(f: SqlFilter, services: readonly string[], spec: BucketSpec): Query; // service_name, bucket, count(*)
  export function resourceValuesQuery(key: string, cap: number): Query;    // UNION of DISTINCT jsonStringAt(resource_attributes,[key]) and jsonKind over spans, logs, points; LIMIT cap + 1
  ```

- [ ] **Step 1: Write the failing tests** (each builder runs against `openFixtureDb` of a fixture with two services, a few error spans, attributes of mixed kinds, two partitions; assertions on the rows, for example):

```ts
test('spanRowsQuery sorts by duration desc with the start/span_id tiebreak and carries total', ...);
test('traceRowsQuery aggregates a trace split across partitions into one row with summed counts', ...); // Review Focus 4
test('coreFacetsQuery counts every core facet in one statement and skips nulls', ...);
test('attributeFacetsQuery keeps valueCap values per key, counts the rest in other, and reports mixed kinds', ...);
test('timelineQuery buckets by the spec and clamps a span starting before the window to the first bucket', ...);
test('bucketSpec picks the smallest 1 ms * 2^k width that fits 4096 buckets', () => {
  expect(bucketSpec({ start: 0, end: 4095e6 }, null).widthNs).toBe(1e6);
  expect(bucketSpec({ start: 0, end: 4096e6 }, null).widthNs).toBe(2e6);
});
test('servicesQuery returns one row per service with quantiles; serviceBucketsQuery only the named services', ...);
test('percentileQuery is 100 at the maximum and 0 below the minimum', ...);
```

- [ ] **Step 2: Run; expected FAIL** · **Step 3: Implement the four modules** · **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(query): span, trace, timeline, facet and service query builders over the format-4 views`

### Task 3.4: The format-4 data source (spans)

**Files:**
- Create: `src/viewer/data/duckdb-source.ts`, `src/viewer/data/span-results.ts`, `src/viewer/data/residual.ts`
- Modify: `src/viewer/data/data-source.ts` (the interface)
- Test: `test/viewer-data/duckdb-source-spans.test.ts`

**Interfaces:**
- Consumes: `QueryEngine` (Task 1.5; `duckdb-source.ts`, `span-results.ts` and `residual.ts` import nothing from `@uwdata/mosaic-core`, D19), Tasks 2.x, 3.1 to 3.3; `FacetCounts.from`, `TimeBuckets.from`; `compileCondition` (`src/ottl/compile.ts`); `buildTraceTree`, `exclusiveTimeByService` (`src/viewer/data/trace-tree.ts`).
- Produces:
  ```ts
  // data-source.ts (the interface after this plan; the log half is Task 4.3)
  export interface DataSource {
    readonly manifest: ManifestV4;
    readonly epoch: bigint;
    querySpans(q: SpanQuery, signal?: AbortSignal): Promise<SpanQueryResult>;
    getTrace(traceId: TraceId): Promise<TraceDetail>;      // memoised for the last id as today
    hasTrace(traceId: TraceId): Promise<boolean>;           // bound (consumers pass it unbound)
    /** 0 to 100 within the unfiltered spans of that service and resource; null when there are none. */
    percentileOf(service: string, resource: string, durationNs: number): Promise<number | null>;
    /** Exclusive time per service of one trace, largest first (D7). */
    serviceShare(traceId: TraceId): Promise<readonly { service: string; ns: number }[]>;
    services(opts: { window: TimeWindow | null; condition: string | null; limit: number }, signal?: AbortSignal): Promise<ServicesResult>;
    queryLogs(q: LogQuery, signal?: AbortSignal): Promise<LogQueryResult>;
    getLog(ref: LogRef): Promise<LogRow>;
    traceLogs(traceId: TraceId, signal?: AbortSignal): Promise<readonly LogRow[]>;
    surroundingLogs(ref: LogRef, n: number): Promise<SurroundingLogs>; // no `partial`
    patterns(opts: { window: TimeWindow | null; sort: { column: 'count' | 'first' | 'last'; dir: 'asc' | 'desc' }; limit: number }): Promise<{ rows: readonly PatternRow[]; total: number }>;
    metricPoints(): Promise<TimeBuckets<'points'>>;
    metricCatalog(): Promise<MetricCatalog>;                // rejects (D11) until plan 3
    metric(id: number): Promise<LoadedMetric>;              // rejects (D11)
    metricsForResources(resources: readonly ResourceRecord[]): Promise<readonly MetricEntry[]>; // rejects (D11)
    resourceValues(key: string): Promise<ResourceValues>;
    close(): Promise<void>;
  }
  // duckdb-source.ts
  /** Over a `QueryEngine` (D19): no Mosaic type in this signature; `close()` is `engine.close()`. */
  export function createDuckDbDataSource(opts: { engine: QueryEngine; manifest: ManifestV4 }): DataSource;
  // span-results.ts: Table → result types
  export function spanRows(t: Table, epoch: bigint): { rows: SpanRow[]; total: number; tables: RowTables };
  export function traceRows(t: Table, epoch: bigint): { rows: TraceRow[]; total: number };
  export function facetCounts(core: Table, attrs: Table | null, caps: FacetCaps, pinned: readonly string[]): FacetCounts; // via FacetCounts.from
  export function timeline(t: Table, spec: BucketSpec): { buckets: TimeBuckets<SpanStatusKey>; red: RedBuckets };
  export function groupStats(t: Table, cap: number): GroupStatsResult;
  /** bigint → number; throws invalid-report when not a safe integer (D2). */
  export function toNumber(v: unknown, path: string): number;
  // residual.ts (D5)
  export function residualRows<T>(opts: { fetch: (limit: number, offset: number) => Promise<T[]>; test: (row: T) => boolean; limit: number }): Promise<{ rows: T[]; exhausted: boolean }>;
  export function residualIdTable(engine: QueryEngine, ids: readonly { filename: string; row: number }[]): Promise<string>; // `registerText` then `exec(CREATE TEMP TABLE ... AS SELECT * FROM read_csv(...))`; the temp table's name
  ```
  `querySpans` runs, in parallel for the requested `needs`, the rows query (spans or traces mode), the two facet queries (restricted by `facetKeys`), the timeline query, the duration summary then bins, and the group stats; an empty `Pruned` short-circuits to empty results; a `residual` applies D5.

- [ ] **Step 1: Write the failing tests** over `openFixtureDb` fixtures (the fake-free path: `mosaicQueryEngine(createCoordinator(db.connector, silentLogger), db)`; the statement-counting tests read `db.connector`'s recorded requests):

```ts
test('querySpans with an error condition returns exactly the error spans, facets over them, exact buckets and no residual', ...);
test('traces mode returns one row per matching trace with the root summary from traces', ...);
test('a trace split across three partitions aggregates to one row and getTrace returns all its spans with logCount summed', ...); // Review Focus 4
test('a residual condition (Len) re-checks rows in the browser and marks the result', ...);
test('percentileOf answers from the unfiltered service/resource durations', ...);
test('services returns one query per table, not per service', async () => { /* count the SQL statements the connector saw: 2 */ });
test('a window that prunes every partition returns empty results without a query', ...);
test('needs restricts the work: needs ["rows"] sends one statement', ...);
test('a signal aborted mid-flight rejects with AbortError and leaves no state', ...);
```

- [ ] **Step 2: Run; expected FAIL** · **Step 3: Implement** · **Step 4: Run; expected PASS; `mise run check` PASS** (the old `createDataSource` and consumers still compile with the adjusted types; PR 5 switches them)
- [ ] **Step 5: Commit** `feat(viewer): the format-4 data source answers span, trace and service queries through the QueryEngine seam`

### PR 3 close

- [ ] `mise run verify`; PR; body carries the statement counts per page action the tests assert (explorer: 5 statements for all needs; services: 2). Branch review on Opus 5.5. Merge.

---

## PR 4: Log queries

Branch `feat/format-4-viewer-logs` from `feat/format-4`. Title: `feat(viewer): log, pattern and log-trace queries over DuckDB`.

### Task 4.1: Log identity and row decoding

**Files:**
- Modify: `src/viewer/data/log-query.ts` (types and `LogRef` only; the scan code goes in PR 5), `src/viewer/state/url-state.ts` (the `log=` validation message)
- Test: `test/viewer/log-query.test.ts` (the ref tests), `test/viewer/url-state.test.ts`

**Interfaces:**
- Produces: `LogRef` is `"<partition n>.<file_row_number>"` with the same regex (D8); `logRef(n, i)`, `parseLogRef`, `refParts` unchanged in shape; `LogRow` keeps `ref`, `n`, `i`, `log`, `resource`, `scope`, `time`, `timeSource`, `service`, `host`. `LogQuery` loses `scanAll`, gains `needs: readonly LogNeed[]` (`'rows' | 'facets' | 'timeline'`) and `facetKeys`. `LogQueryResult` loses `partial`, gains `residual: boolean`; the `patterns` mode variant is removed from `LogQueryResult` (patterns come from `DataSource.patterns`, D9); `LogMode` stays `'logs' | 'patterns' | 'traces'` for the UI.

- [ ] **Step 1: Adjust the ref tests' wording (chunk → partition) and the URL message; run; expected PASS after the edit.**
- [ ] **Step 2: Commit** `feat(viewer): a log ref names its partition and row`

### Task 4.2: Log query builders

**Files:**
- Create: `src/query/sql/logs.ts`
- Test: `test/query/sql/logs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LogSort { column: 'time' | 'severity' | 'service'; dir: 'asc' | 'desc' }
  /** Every logs column (times relative; `coalesce(time, observed, epoch) - epoch AS time_rel`), filename, file_row_number, `count(*) OVER ()`; ORDER BY the sort then (time_rel, filename, file_row_number). */
  export function logRowsQuery(f: SqlFilter, sort: LogSort, limit: number): Query;
  /** bucket (by the effective time), severity band counts: GROUP BY bucket, band. */
  export function logTimelineQuery(f: SqlFilter, spec: BucketSpec): Query;
  /** trace_id, count(*), min/max effective time, max(severity_number), list_sort(list_distinct(service_name)) WHERE trace_id IS NOT NULL GROUP BY trace_id, sort (first | logs | severity), limit, `count(*) OVER ()`. */
  export function logTracesQuery(f: SqlFilter, sort: { column: 'first' | 'logs' | 'severity'; dir: 'asc' | 'desc' }, limit: number): Query;
  export function logByRefQuery(ref: LogRef, manifest: ManifestV4): Query; // WHERE filename = <path of partition n> AND file_row_number = i
  /** Same service and host (`IS NOT DISTINCT FROM`), strictly before (time, filename, row) in reverse order LIMIT n; and the mirror after. Two queries. */
  export function surroundingQueries(target: LogRow, manifest: ManifestV4, n: number, epoch: bigint): { before: Query; after: Query };
  export function traceLogsQuery(traceId: TraceId, files: readonly string[] | null, epoch: bigint): Query; // ORDER BY time_rel, filename, file_row_number
  /** patterns combined by template (note 2): sum(count), min(first), max(last), per-band sums of json_extract(severity_counts, '$.<band>'), arg_min(sample, first_time_unix_nano); window by overlap of [first, last]; ORDER BY the sort; LIMIT; `count(*) OVER ()`. */
  export function patternsQuery(opts: { window: AbsWindow | null; sort: { column: 'count' | 'first' | 'last'; dir: 'asc' | 'desc' }; limit: number; epoch: bigint }): Query;
  /** bucket, count(*) over points by time_unix_nano (D11). */
  export function pointsTimelineQuery(spec: BucketSpec, epoch: bigint): Query;
  ```

- [ ] **Step 1: Write the failing tests** against a log fixture (three services on two hosts, severities across every band, some with trace ids, two partitions, bodies of three kinds): row order and ties, the band buckets, traces mode grouping, by-ref lookup, surrounding logs crossing a partition boundary, trace logs pruned to the trace's partitions, patterns combined across partitions by template with severity sums, points timeline.
- [ ] **Step 2: Run; expected FAIL** · **Step 3: Implement** · **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(query): log row, timeline, trace, surrounding, pattern and points query builders`

### Task 4.3: The data source (logs, patterns, resource values, points)

**Files:**
- Modify: `src/viewer/data/duckdb-source.ts`; Create: `src/viewer/data/log-results.ts`
- Test: `test/viewer-data/duckdb-source-logs.test.ts`

**Interfaces:**
- Produces: the log half of `DataSource` (Task 3.4's block): `queryLogs`, `getLog` (`usage` error "no such log" when the row is absent), `traceLogs` (prunes with `tracePartitionsQuery` first; a trace with no `traces` row reads every logs file), `surroundingLogs`, `patterns`, `metricPoints`, `resourceValues` (values sorted, `kind` merged as `resourceValuesOf` does today, `capped` when `cap + 1` rows came back), and the D11 rejections.
- `log-results.ts`: `logRows(t, epoch, manifest)`, `logTraceRows`, `patternRows` (regex from the template through a template-string variant of `templateToRegex`; add `templateStringToRegex(template: string): string` to `src/rollups/drain.ts` beside the cluster one, with a test that the two agree).

- [ ] **Step 1: Write the failing tests:** filtered logs with exact facets and buckets; traces mode; `getLog` by ref across partitions and the not-found error; `surroundingLogs` with `n` on each side across a partition boundary and the same-stream rule; `traceLogs` ordering; `patterns` combining two partitions' identical templates and the window; `metricPoints` over a fixture with points; `resourceValues('host.name')` over spans, logs and points with `capped`.
- [ ] **Step 2: Run; expected FAIL** · **Step 3: Implement** · **Step 4: Run; expected PASS; `mise run check` PASS**
- [ ] **Step 5: Commit** `feat(viewer): the format-4 data source answers log, pattern, points and resource-value queries`

### PR 4 close

- [ ] `mise run verify`; PR; body notes D8, D9, D10. Branch review on Opus 5.5. Merge.

---

## PR 5: The viewer opens format 4

Branch `feat/format-4-viewer-pages` from `feat/format-4`. Title: `feat(viewer)!: the viewer reads format 4 through DuckDB-WASM; partial results and Scan entire run are gone`.

This PR is large by nature: the viewer switches formats in one step so every e2e spec runs on format-4 fixtures. Tasks are ordered so `mise run check` passes after each; the Chromium e2e suite is the gate at the end. The metrics pages are quarantined (D11) until plan 3.

### Task 5.1: Composition root and loading states

**Files:**
- Modify: `src/viewer/main.tsx`, `src/viewer/app.tsx`, `src/viewer/root.tsx`, `src/viewer/data/traced.ts`, `src/viewer/telemetry.ts`
- Delete: `src/viewer/data/data-source.ts`'s `createDataSource`, `signalBudgets`, `Strategy` (the interface stays)
- Test: `test/viewer/root.test.tsx`, `test/viewer/telemetry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // main.tsx
  export interface LoadProgress { phase: 'engine' | 'partitions' | 'views'; done?: number; total?: number }
  /** parseAnyManifest; a non-4 manifest throws invalid-report with the D12 message; then startEngine, registerPartitions, `mosaicQueryEngine(createCoordinator(engineConnector(engine.connection), logger), engine)`, createDuckDbDataSource; traced as `viewer.load` with `viewer.engine.start` and `viewer.partitions.register` child spans (attributes: format, partitions, bytes). */
  async function load(onProgress: (p: LoadProgress) => void): Promise<DataSource>;
  ```
  `App` shows the phase while loading ("Starting the query engine", "Loading partition 12 of 89", "Preparing views"). `tracedDataSource` wraps `querySpans`, `queryLogs`, `getTrace`, `traceLogs`, `surroundingLogs`, `services`, `patterns` as `viewer.query` spans with `otel_html.query.kind`; `tracedLoader` keeps its name but the span is `viewer.script.load`.

- [ ] **Step 1: Write the failing tests:** root.test.tsx renders the three loading phases; a format-3 manifest shows the D12 text; telemetry.test.ts expects `viewer.script.load` and a `viewer.query` span for `services`.
- [ ] **Step 2: Run; expected FAIL** · **Step 3: Implement** · **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(viewer): the composition root starts the engine and the format-4 data source`

### Task 5.2: `useQuery` without scans; the traces pages

**Files:**
- Modify: `src/viewer/state/use-query.ts`, `src/viewer/traces/use-span-query.ts`, `src/viewer/traces/explorer.tsx`, `views.ts`, `columns.tsx`, `red-strip.tsx`, `services-page.tsx`, `trace-panel.tsx`, `span-section.tsx`, `span-detail-tabs.tsx`, `src/viewer/components/explorer-states.tsx`, `facet-views.ts`, `facet-panel.tsx`, `export.ts`, `results-table.tsx`
- Test: `test/viewer/use-span-query.test.tsx`, `explorer.test.tsx`, `views.test.ts`, `red-services.test.tsx`, `services-page.test.tsx`, `results-table.test.tsx`, `trace-panel.test.tsx`, `export.test.ts`, `facet-panel.test.tsx`

**Interfaces:**
- `useQuery<Q, R>(dataSource, query, run)` returns `{ state: QueryState<R> }` where loading is `{ status: 'loading'; previous: R | null }` (no progress, no `scanAll`); `QueryRunner` is `(ds, q, signal) => Promise<R>`.
- `PartialNote` and `LoadingNote` become one `QueryNote` component: shows "Evaluated in the browser: <residual>" when `result.residual` (D5), otherwise nothing; the loading state keeps today's spinner text without a count.
- The explorer asks `needs: ['rows', 'facets', 'timeline', 'durations']` (`'groups'` when a measured view is open); RedStrip reads `RedBuckets` and `Durations.summary`; the Duration facet reads `durations.bins` (exact; the "from the first N" note goes); `measuredSlices` reads `GroupStatsResult`.
- Services page: one `dataSource.services({ window, condition: null, limit: 50 })` call; no `PartialTag`, no `≥`, no Scan entire run.
- Columns: the Service share cell renders `useKeyedAsync(row.traceId, ds.serviceShare)`; no "partial" label.
- `percentileOf` through `useKeyedAsync` in the span section.

- [ ] **Step 1: Rewrite the listed tests** for the new result shapes (fake `DataSource`s lose `strategy`, `partial`; `services` is a fake method); drop the partial/Scan tests; add "the duration facet counts every matching span" and "the service share cell loads per row".
- [ ] **Step 2: Run `pnpm exec vitest run test/viewer`; expected FAIL** · **Step 3: Implement** · **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(viewer): traces explorer, services and trace panel on the format-4 source; partial results and Scan entire run removed`

### Task 5.3: The logs pages

**Files:**
- Modify: `src/viewer/logs/explorer.tsx`, `use-log-query.ts`, `views.ts`, `columns.tsx`, `log-panel.tsx`, `log-tabs.tsx`, `patterns-table.tsx`, `traces/trace-logs-tab.tsx`
- Test: `test/viewer/logs-explorer.test.tsx`, `log-panel.test.tsx`, `log-views.test.ts`, `trace-logs-tab.test.tsx`, `log-list.test.tsx`

- Patterns mode calls `dataSource.patterns({ window, sort, limit })`; the facet panel is hidden in that mode and a note reads "Patterns are computed over every log when the report is written; the time range applies, filters do not" (D9). Clicking a pattern keeps adding its `matches` token and switching to logs mode. The Surrounding tab has no partial note.

- [ ] **Step 1: Rewrite tests** (fake data sources gain `patterns`; drop partial tests; add the D9 note test).
- [ ] **Step 2: Run; FAIL** · **Step 3: Implement** · **Step 4: Run; PASS**
- [ ] **Step 5: Commit** `feat(viewer): logs explorer, log panel and patterns on the format-4 source`

### Task 5.4: Dashboards' span and log widgets

**Files:**
- Modify: `src/viewer/dashboards/widgets/facet-chart.tsx`, `timeline.tsx`, `traces.tsx`, `logs.tsx`, `dashboard-page.tsx`
- Test: `test/viewer/dashboard-facets.test.tsx`, `fusion-timeline.test.tsx`, `dashboard-traces.test.tsx`, `dashboard-logs.test.tsx`, `dashboard-shell.tsx` (the fake)

- Toplist and table widgets query `needs: ['facets']` with `facetKeys: [groupBy]` (plus `'groups'` for a duration measure); the timeline widget `needs: ['timeline']` on both signals and `metricPoints()`; traces widget `needs: ['rows']` limit 200; logs widget as today minus `partial`. The timeline's "from N of M chunks" notes and Scan entire run button go.
- These tests used the real chunk source with a budget of 1; they switch to a fake `DataSource` built by `dashboard-shell.tsx` from fixture rows (the SQL path is covered in `test/viewer-data/`).

- [ ] **Step 1: Rewrite tests** · **Step 2: FAIL** · **Step 3: Implement** · **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(viewer): dashboard span and log widgets ask only for what they draw`

### Task 5.5: Metrics quarantine until plan 3

**Files:**
- Modify: `src/viewer/metrics/explorer.tsx`, `catalog.tsx`, `metric-grid.tsx`, `src/viewer/dashboards/widgets/metric.tsx`, `src/viewer/traces/trace-tabs.tsx` (Metrics tab), `src/viewer/logs/log-tabs.tsx` (Metrics tab)
- Test: `test/viewer/metrics-explorer.test.tsx`, `metrics-catalog.test.tsx`, `metric-grid.test.tsx`, `metric-grid-zoom.test.tsx`, `use-metric-query.test.tsx`, `dashboard-metric.test.tsx`, `metric-load.test.ts`, `metric-scaling.test.ts`, `frozen-reports.test.ts`

- The pages render the D11 error from `metricCatalog()` as their error state ("Metrics are not available in this build yet; they arrive with format-4 plan 3"). `useHasMetrics` returns false when the catalog rejects with that error. The listed tests that need metric chunk data are wrapped in `describe.skip('plan 3: metrics in the format-4 viewer', ...)` with the plan name; `frozen-reports.test.ts` is rewritten to merge each frozen fixture into format 4 (`mergeWith`) and open it with `createDuckDbDataSource` over the Node engine, asserting the totals and one trace.
- [ ] **Step 1 to 4** as above. **Step 5: Commit** `feat(viewer): metrics pages report that metrics arrive with plan 3; frozen reports open after merge`

### Task 5.6: Delete the span and log scan code and the chunk-era tests

**Files:**
- Delete: `src/viewer/data/eager.ts`, `windowed.ts`, `chunk-window.ts` (move `Lru` to `src/viewer/data/lru.ts`: the metric LRU still uses it), `load.ts`, `log-eager.ts`, `log-windowed.ts`, `log-load.ts`, `top-k.ts`, the `SpanQueryRun`/`querySpanEntries`/`scanSpanEntries`/`toEntries` half of `span-query.ts` (the file keeps the types), the equivalent half of `log-query.ts`, `visitInBlocks`/`EAGER_BLOCK`/`yieldToEvents`/`AbortTicker` from `query-common.ts` (keep `checkLimit`, `cmp`, `sortFor`, `ordered`, `throwIfAborted`, `FacetCaps`, `DEFAULT_FACET_CAPS`; `metric-query.ts` keeps its own ticker: move `AbortTicker` there), `test/viewer/data-source.test.ts`, `log-data-source.test.ts`, `span-query.test.ts`, `log-query.test.ts` (its ref tests move to `test/viewer-data/`), `lru.test.ts` (→ `lru.test.ts` on the moved module), `top-k.test.ts`, `query-common.test.ts`, `facet-matching.test.tsx` (its intent is Task 2.4), `test/viewer/report-fixture.ts`, `test-support/scripted-loader.ts` if unused (knip says)
- Test: `mise run check` (knip reports what is now dead)

- [ ] **Step 1: Delete; run `mise run check`; fix every knip finding by deleting or moving; expected PASS.**
- [ ] **Step 2: Commit** `refactor(viewer): delete the eager and windowed scan code and the trace index reader`

### Task 5.7: e2e fixtures in format 4 and a range-serving static server

**Files:**
- Modify: `e2e/static-server.ts`, `e2e/fixture.ts`, `e2e/global-setup.ts`, `e2e/test.ts`, `e2e/build-fixtures.ts`, `e2e/frozen.spec.ts`, `e2e/otel.spec.ts`, `e2e/scale.spec.ts` (the non-perf `huge` test and the chunk assertions go now; the perf tests are PR 7), the metric specs (`metric-grid`, `metrics-catalog`, `metrics-explorer`, `run-chart`, the metric parts of `dashboards.spec.ts` and `trace-panel.spec.ts`) get `test.skip(true, 'plan 3: metrics in the format-4 viewer')`, `mise.toml` (`e2e:fixtures` outputs include `e2e/.reports-site/**`), `.gitignore` and `biome.json` (ignore `e2e/.reports-site`)
- Test: `test/e2e-support/static-server.test.ts` (new)

**Interfaces:**
- `serve(mounts)` answers `GET` with `Accept-Ranges: bytes` and `Content-Length`, a single `Range: bytes=a-b` or `bytes=a-` with `206` and `Content-Range`, `416` when unsatisfiable; `HEAD` with `200`, `Content-Length` and no body, and no `Content-Range` even when the request carries `Range` (GitHub Pages behaves so, spec §12; Review Focus 5); MIME for `.parquet` (`application/vnd.apache.parquet`) and `.wasm` (`application/wasm`). It records every request path, exposed as `requests(): readonly string[]` for PR 7.
- `reportDir(name, kind: UrlKind = 'file')`: `file` → `e2e/.reports/<name>/` (local format), `http` → `e2e/.reports-site/<name>/` (site format). `baseUrlFor(kind, name)` and the mounts use it.
- `build-fixtures.ts` passes `--format local` to every convert and merge (until PR 6 makes it the default), then runs `cp -r` plus `node dist/cli/main.js upgrade <copy> --format site` into `e2e/.reports-site/<name>/` for every mounted report; the `frozen-format-N` reports are `merge fixtures/reports/format-N --out ... --format local` (D12). The `large` report stays `local`, file only.
- `scale.spec.ts`'s "a report over the eager budget" test is deleted; `e2e/otel.spec.ts` expects `viewer.engine.start` and `viewer.query` spans.

- [ ] **Step 1: Write the static-server test** (206 with the right bytes, HEAD with Content-Length and no body, 416, a `.parquet` MIME) and run it; FAIL.
- [ ] **Step 2: Implement the server; PASS.** Update the fixture builder, mounts and specs.
- [ ] **Step 3: `mise run e2e:fixtures`; then `mise run test:e2e:chromium`.** Fix viewer bugs the specs find (expected: the `@http` specs exercise `site` over ranges for the first time, Review Focus 5).
- [ ] **Step 4: Commit** `test(e2e): format-4 fixtures in local and site format; the static server answers Range and HEAD`

### Task 5.8: README for the viewer that reads format 4

- [ ] Update: the `--format` row ("the viewer reads format 4" replaces "cannot open format-4 reports yet"), "Format 4" and "Hosting" sections (how each format opens; `site` needs range requests; the e2e sentence now says `local` from `file://`, `site` over HTTP), "Report format compatibility" (the viewer reads format 4; `merge` converts 1 to 3), Limits (the eager-budget bullet is replaced by "`site` reports read only the row groups a query needs; `local` reports decode every partition a query touches"), "Viewing logs" (patterns, D9), and a note that metrics pages arrive with plan 3 on this branch (removed in PR 9 of plan 3). Commit `docs: the viewer reads format 4`.

### PR 5 close

- [ ] `mise run verify` (the Chromium suite in both url kinds), then `mise run test:e2e --browser firefox` and `--browser webkit` locally once (the three-browser matrix is CI's, but this PR is the first to run the engine in them; a failure here is cheaper to see now). PR body: what the three browsers showed, the engine start time measured in each (from the `viewer.engine.start` span or `performance.now()` around `load`), bundle size, the skipped metric specs (D11) with the plan-3 pointer. Branch review on Opus 5.5. Merge.

---

## PR 6: Format 4 is the only format written

Branch `feat/format-4-remove-chunks` from `feat/format-4`. Title: `feat(writer)!: format 4 is the only format written; writer.format defaults to local and viewer.eagerBudgetBytes is removed`.

### Task 6.1: Config and CLI

**Files:**
- Modify: `src/config/schema.ts`, `src/config/env.ts`, `src/cli/commands/report-mode.ts`, `src/cli/commands/upgrade.ts`, `src/writer/upgrade.ts`, `src/format/manifest.ts` (v4 `ConfigSchema` without `eagerBudgetBytes`; the v1 to v3 schema keeps it), `schema/` (`mise run gen`), README configuration rows
- Test: `test/config/resolve.test.ts`, `test/config/load.test.ts`, `test/format/manifest-v4.test.ts`, `test/writer/upgrade.test.ts`, `test/cli/program.test.ts`

- `ReportFormat = 'local' | 'site'`; `writer.format` default `'local'`; the value `chunks` fails `invalid-config` with message "format 3 (chunks) is no longer written; use local or site (otel-html merge converts an older report)". `viewer.eagerBudgetBytes` is an unknown key (rejected as every unknown key is, D14); `OTEL_HTML_EAGER_BUDGET_BYTES` is dropped from `env.ts`. The R51/R58 refinements go (nothing to refine). `upgrade` on a format 1 to 3 report fails `usage` with the D12 message (exit 2).

- [ ] **Step 1: Write the failing tests** (default format, the chunks message, the unknown key, upgrade's refusal, `--format chunks` rejected by commander's choices).
- [ ] **Step 2: FAIL** · **Step 3: Implement; `mise run gen`** · **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(config)!: writer.format is local or site, default local; viewer.eagerBudgetBytes is gone`

### Task 6.2: Delete the chunk writer

**Files:**
- Modify: `src/writer/session.ts` (becomes `openSession` dispatch plus the shared types `WriterSession`, `AddResult`, `ReportSummary`, `OpenOptions`; the chunk session class and its helpers go), `src/writer/merge.ts` (no chunk output path; format 1 to 3 inputs still read through `decodeColumns`), `src/api/*` as needed
- Delete (knip-driven; the expected list): `src/writer/chunker.ts`, `trace-index.ts`, `metric-series-writer.ts`, `metric-buffer.ts`, `rebase.ts` (if only the chunk merge used it), `checkpoint.ts` (chunk state) where not shared with `partition-checkpoint.ts`, `src/rollups/report-rollups.ts`, `span-rollups.ts`, `log-rollups.ts` (its facet definitions moved in Task 3.3; `LogRollups` goes), `red.ts`, `exp-histogram.ts`, `value-buckets.ts`, `metric-agg.ts`, `metric-streams.ts` (keep anything `partition-session.ts` or the viewer's metric modules still import until plan 3; knip is the judge), `src/format/trace-shard.ts` (reader unused once the viewer stops reading shards; merge converts from chunks, not shards), the chunk `state.ts` v1 schema if the partition checkpoint has its own, the encoder half of `src/format/columns.ts` (`encodeColumns`, `ColumnEncoder`; the decoder stays for merge), `src/format/metric-files.ts` only if the viewer's metric modules no longer import it (they do until plan 3: keep)
- Delete tests: `test/writer/session.test.ts`, `chunker.test.ts`, `trace-index.test.ts`, `metric-series.test.ts`, `metric-buffer.test.ts`, `checkpoint.test.ts`, `split-trace.test.ts`, `idle-checkpoint.test.ts`, `background-checkpoint.test.ts`, `crash.test.ts`, `append.test.ts`, `log-size.test.ts`, `metric-memory.test.ts` where they test the chunk session (those with a partition-session twin: keep the twin; those without: port the scenario to the partition session before deleting), `test/rollups/*` for deleted modules, `test/format/data-file.test.ts` parts for chunk payloads (the binary wrapper tests stay), `test/format/compat.test.ts` stays (it asserts merge converts the frozen reports)
- `mise.toml`: `test:load` points its two files at the partition-session twins; `scripts/load-receiver.ts` and the binary smoke step in `ci.yml` drop `chunks`.

- [ ] **Step 1: Remove the chunk session; run `mise run check`; delete or port until knip, typecheck and tests pass.** Every ported test keeps its name with "(partition session)" dropped.
- [ ] **Step 2: Run `mise run test:load` locally once; record the memory figures in the PR body (the targets stay those of the load workflow).**
- [ ] **Step 3: Commit** `refactor(writer)!: delete the chunk session, the rollup accumulators and the trace index writer`

### Task 6.3: README and format docs

- [ ] "Format 3" section becomes "Older formats (1 to 3)": readable by `merge`, not written, not opened by the viewer; the "Report layout and hosting" tree shows format 4 only; `writer.format` row; Limits; `--format` rows for `convert`, `serve`, `run`, `merge`, `upgrade`. `mise run gen` for the task docs. Commit `docs: format 4 is the format otel-html writes`.

### PR 6 close

- [ ] `mise run verify`; PR body lists every deleted module and the ported tests; the load figures. Branch review on Opus 5.5. Merge.

---

## PR 7: The scale reports over HTTP

Branch `test/format-4-scale-http` from `feat/format-4`. Title: `test(e2e): the scale reports in site format over the range-serving server; budgets re-baselined`.

### Task 7.1: `scale` and `many` in site format; the `chromium-perf-http` project

**Files:**
- Modify: `e2e/build-scale-fixtures.ts`, `e2e/fixture.ts`, `e2e/scale.spec.ts`, `playwright.config.ts`, `e2e/test.ts` (`kindOf` keeps reading the last segment), `mise.toml` (`e2e:fixtures:scale` upgrades nothing: the reports are written `site` directly; `test:e2e` runs `chromium-perf-http` in pass 2 beside `chromium-perf-file`), `.github/workflows/ci.yml` (the perf project name only; stop and ask before editing, as the file runs with a write token)

- `scale`: the 100k-span, 1M-log input converted with `--format site` and closed (one compacted partition per signal). `many`: the same input written through `Report.create` with a flush every 1 000 spans and never closed (about 100 uncompacted partitions, `complete: false`; D15). Both mounted over HTTP only; `reportDir('scale' | 'many', 'http')`.
- Project `chromium-perf-http`: `grep: /@perf/`, `use: devices['Desktop Chrome']`; `chromium-perf-file` keeps `trace-panel.spec.ts`'s flame-graph budget (a `local` report).
- Specs (all `@perf`, median of `LOAD_SAMPLES`): explorer interactive on `scale` and on `many` (< today's 3 s × factor until measured); facet toggle repaint (< 150 ms median, 300 max); Logs landing on `scale` (< 3 s); a one-minute warn+ window over 1M logs (< 1 s: no chunks to read); the trace Logs tab reads only the partitions `traces` names (assert the `Range` requests seen by the server touch at most the trace's partitions' files: the static server records request paths and exposes them through `e2e/static-server.ts`'s `requests()`); Fusion interactive (< 3 s) and a trace click updates Logs (< 1 s). The windowed `huge` scenarios are gone.

- [ ] **Step 1: Rewrite the fixtures and specs; run `mise run test:e2e:chromium -- e2e/scale.spec.ts`; record the medians.**
- [ ] **Step 2: Set each budget at twice the measured median, never above today's value; run twice more; PASS.**
- [ ] **Step 3: Commit** `test(e2e): scale and many reports in site format under chromium-perf-http`

### Task 7.2: The CI dashboard's open time as a budget stand-in

- [ ] Add to `scale.spec.ts` (`@perf`, `many`): open `#/dashboards/fusion`, wait for every widget's result, assert the median under 3 s × factor and that the server saw fewer than 400 range requests (the many-partition shape of an incomplete run, note 10, is the motivating case of §1). Commit `test(e2e): the Fusion dashboard over a hundred uncompacted partitions opens within budget`.

### PR 7 close

- [ ] `mise run verify`; PR body carries the measured medians and the budgets set, per spec; a note on the request counts. Branch review on Opus 5.5. Merge.

---

## PR 8: The publisher writes site reports

Branch `feat/format-4-publisher` from `feat/format-4`. Title: `feat(ci): the publisher writes site reports with a shared assets base and compacts the rolling report`.

**Stop and ask** before Tasks 8.2 and 8.3: they edit `.github/actions/otel-html-publish/*`, `.github/otel-html-ci.yaml` and `ci-report.yml`, which run with a write token on `main`. Task 8.1 is code under `src/` and proceeds.

### Task 8.1: `ci site` and `ci report` in site format

**Files:**
- Modify: `src/cli/ci/site.ts`, `site-io.ts`, `site-main.ts`, `publish-io.ts`, `report-main.ts`
- Test: `test/cli/ci/site.test.ts` (existing tests for the site layout), `test/cli/ci/report.test.ts`

**Interfaces:**
- `mergeWithConfig(deps, config, opts: { format: 'site'; assetsBase: string; compact: boolean })` passes `writer: { format, assetsBase, compactOnMerge: compact }` over the config.
- `ci site` computes the base per destination: the rolling report at `<site>/<channel>/` uses `../assets/<version>/`, a run report at `<site>/<channel>/runs/<id>/` uses `../../../assets/<version>/`, where `<version>` is `otelHtmlVersion`. `copyReport` of the run report becomes `upgrade --format site --assets-base <base>` of the copied folder (it is a `local`-or-`site` format-4 report from `ci report`; R57 applies). `ensureSharedAssets(site, version)` copies `viewerAssets.files('site')` into `<site>/assets/<version>/` when the folder is absent (idempotent). Retention leaves `assets/` alone; a `prune-assets` pass removes versions no report under `<site>` references (the manifests' `engine.assetsBase`).
- `ci report` writes its run report with `format: 'site'` (own `assets/`, so a downloaded artifact opens over any static server; the site copy switches to the shared base).

- [ ] **Step 1: Write the failing tests:** the rolling manifest has `engine: { format: 'site', assetsBase: '../assets/<v>/' }` and one partition per signal; a run report under `runs/<id>` has `../../../assets/<v>/` and no `assets/` folder; `<site>/assets/<v>/` holds the viewer and the two plain engine files; a second publish does not rewrite them; an unreferenced version is pruned.
- [ ] **Step 2: FAIL** · **Step 3: Implement** · **Step 4: PASS**
- [ ] **Step 5: Commit** `feat(ci): site reports with a shared assets base; the rolling report is compacted`

### Task 8.2: The preview over HTTP (stop and ask)

- `preview.mjs` serves the channel folder with a loopback static server (`Range` and `HEAD`, as the e2e server does; a small copy in the action, since the action has no build step) and opens `http://127.0.0.1:<port>/<channel>/index.html`. `test/actions/site-publish.test.ts` and `e2e/preview.spec.ts` follow.
- [ ] Ask the maintainer with the diff summary; on approval implement and commit `ci(publish): the README preview renders the site report over a loopback server`.

### Task 8.3: Workflow and config (stop and ask)

- `.github/otel-html-ci.yaml` and the action's `otel-html-ci.yaml`: no `writer.format` key is needed (the code passes `site`), but `writer.statisticsKeys` should list the dashboard variables' resource keys if the config's dashboards do not already name them (check `.github/otel-html-ci.yaml`'s `variables`). `ci-report.yml`: unchanged unless the preview needs a port; `pages` deploy unchanged (the site folder gains `assets/<version>/`).
- [ ] Ask the maintainer; on approval commit `ci: publisher config for format 4`.

### PR 8 close

- [ ] `mise run verify`; PR body: the per-destination bases, the site size before and after (from a local `ci site` run over two fixture run reports), and the stop-and-ask outcomes. Branch review on Opus 5.5. Merge. The first real publish on `main` happens only when the branch is released (session F); until then the publisher on `main` keeps writing format 3.

---

## PR 9: The views as the contract; plan close-out

Branch `docs/format-4-viewer-record` from `feat/format-4`. Title: `docs(format): the five views are the viewer's contract; plan 2 record`.

### Task 9.1: Schema page

**Files:**
- Modify: `scripts/gen-schema-doc.ts`, `docs/format/schema.md` (generated), `test/scripts/gen-schema-doc.test.ts`

- [ ] The page gains "The views": each table is a view of the same name over every listed file; two virtual columns `filename` (the manifest path) and `file_row_number`; a log's identity is `<partition>.<file_row_number>`; the viewer prunes files by the manifest statistics before querying (D3); attribute access is JSON Pointer (D4); a backend satisfies the contract by defining the same views with these columns. `mise run gen`; the golden test covers the new section. Commit `docs(format): the five views and their virtual columns are the viewer contract`.

### Task 9.2: Record for plan 3 and the kickoff prompt

- [ ] Append to this plan a "Record: rulings and notes for plan 3" section in plan 1's format (rulings `R<n>` from the PR bodies and the ledger, spec deviations with line numbers, notes for plan 3: the D11 stubs to replace, the skipped tests to revive, `metricPoints` as the first points query, `AbortTicker`'s new home, what `metric-query.ts` still imports). Confirm the "Kickoff prompts" section of `docs/superpowers/plans/2026-11-06-format-4-writer.md` carries session C's prompt (added when this plan was written; update it if the plan's path or process changed). Commit `docs(plan): plan 2 record and notes for plan 3`.

### Plan close-out

- [ ] Post the summary the unattended process asks for: each PR's number, title and measurements; issues opened; anything stopped on (PR 8's asks). This session ends; `/format-4` next picks session C or, once this plan's PRs are merged, session D (write plan 3).
