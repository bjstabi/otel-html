# Format 4 Writer Implementation Plan (plan 1 of the format-4 spec)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The writer produces format-4 reports: Parquet partitions per flush with a statistics-bearing manifest, compacted at close, in `local` and `site` output formats, with merge by copy and conversion of format 1–3 inputs.

**Architecture:** A `PartitionWriter` replaces the chunk buffer, rollup accumulators, trace index and metric series writer on a new writer path selected by `writer.format`. Rows are mapped to one Arrow table per signal (`spans`, `logs`, `points`, `traces`, `patterns`), sorted, and encoded to Parquet with ZSTD through `parquet-wasm`; the manifest lists partitions with per-file statistics and a `source`. The old chunk path stays writable and **default** on the branch until plan 2 (the DuckDB viewer) flips the default and deletes it, so every PR of this plan keeps CI green.

**Tech Stack:** TypeScript (strict), `parquet-wasm` 0.9.0 and `apache-arrow` 21.2.0 (runtime dependencies, no native code), `@duckdb/duckdb-wasm` 1.32.0 (engine assets shipped with the viewer; its Node build reads Parquet metadata in tests), zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md` (§5, §6, §9, §10 §11 milestone 1). The viewer (§7, §8) is plan 2; metrics in the viewer plan 3; `host` plan 4; the publishing spec is its own plan. Those plans are written after this one lands, from the spec and the interfaces this plan produces.

**Process:** unattended (`docs/agents/process-unattended.md`), with one change: PRs target the long-lived branch **`feat/format-4`**, not `main`, and the next PR branches from the updated `feat/format-4`. `main` keeps shipping format 3 meanwhile.

## Plans for this spec

| Plan | Covers | Written when |
| --- | --- | --- |
| 1 (this) | §5, §6, §9, §10: writer, format on disk, formats, merge, upgrade | now |
| 2 | §7: Mosaic data layer, views, OTTL to SQL, Traces and Logs pages, Services, dashboards' span/log widgets, delete scan code, flip the default format, e2e re-baseline, publisher switch | after plan 1 merges to `feat/format-4` |
| 3 | §6.4 metrics in the viewer: `points` queries, Metrics explorer, catalog, metric widgets | after plan 2 |
| 4 | §8: `host`, REST connector, engine policy | after plan 3 |
| publishing | `2026-11-06-incremental-ci-publishing-design.md` | after plan 2 (needs the publisher on format 4) |

## Kickoff prompts for the sessions that follow

Each is pasted into a fresh session after `/clear`, in order; each waits for the previous plan to have merged to
`feat/format-4`. They are kept here so no session has to remember them.

**Session A, this plan:**

```
Execute docs/superpowers/plans/2026-11-06-format-4-writer.md with superpowers:subagent-driven-development.

Context: this is plan 1 of the format-4 design (docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md, approved). The PR process is unattended (docs/agents/process-unattended.md) with one change the plan states: every PR targets the long-lived branch feat/format-4, not main, and the next PR branches from the updated feat/format-4. Per CLAUDE.md, implementers and task reviewers run on Sonnet 5.5 and the whole-branch review on Opus 5.5; say which model each review ran on. Start at PR 1, Task 1.1, from `git switch feat/format-4`. Stop and ask only where the process or the plan says to.
```

**Session B, write plan 2 (the viewer):**

```
Write plan 2 of the format-4 spec (docs/superpowers/specs/2026-11-06-parquet-duckdb-format-4-design.md §7: the Mosaic data layer, the five views, OTTL to SQL, Traces and Logs pages, Services, the dashboards' span and log widgets, deleting the scan code, flipping writer.format's default to local and removing chunks, the e2e re-baseline in site format, and the publisher switch) with superpowers:writing-plans. Skip brainstorming: the spec is approved. Read docs/superpowers/plans/2026-11-06-format-4-writer.md first for the interfaces plan 1 produced and for the "Kickoff prompts" section, run the builder check, and save as docs/superpowers/plans/<date>-format-4-viewer.md on feat/format-4, adding its own execution prompt to that section. Same process: unattended, PRs target feat/format-4.
```

**Session C, execute plan 2:** the prompt session B adds here.

**Session D, write plan 3 (metrics in the viewer):**

```
Write plan 3 of the format-4 spec (§6.4 and §7.2 for metrics: `points` queries through mosaic-sql, metric `fn`s and formulas, the Metrics explorer, catalog and metric dashboard widgets, downsampled tables only if the metrics-scale budget demands them) with superpowers:writing-plans. Skip brainstorming. Read the format-4 writer and viewer plans first, run the builder check, save as docs/superpowers/plans/<date>-format-4-metrics.md on feat/format-4 and add its execution prompt to the writer plan's "Kickoff prompts" section. Unattended; PRs target feat/format-4.
```

**Session E, write plan 4 (`host`):**

```
Write plan 4 of the format-4 spec (§8: `otel-html host`, Mosaic's REST connector protocol, the engine policy and its tests, the REST connector path in the viewer) with superpowers:writing-plans. Skip brainstorming. Read the earlier format-4 plans first, run the builder check, save as docs/superpowers/plans/<date>-format-4-host.md on feat/format-4 and add its execution prompt to the writer plan's "Kickoff prompts" section. Unattended; PRs target feat/format-4.
```

**Session F, the format-4 release:** once plans 1–3 are merged on `feat/format-4`, open the PR from `feat/format-4` to
`main` titled `feat!: format 4, Parquet partitions queried by DuckDB in the browser` (reviewed by the maintainer: it is
the format bump), with the frozen format-4 fixture added as the compatibility rule asks when the release is cut.

**Session G, write the publishing plan** (after the publisher runs on format 4, i.e. plan 2 shipped):

```
Write the implementation plan for docs/superpowers/specs/2026-11-06-incremental-ci-publishing-design.md with superpowers:writing-plans. Skip brainstorming: the spec is approved and the maintainer's decisions are in its §10. Run the builder check, save as docs/superpowers/plans/<date>-incremental-ci-publishing.md. The PR process is unattended, but the plan must mark every task that touches ci-report.yml, pages-deploy.yml, the otel-html-publish action or anything running with a write token as "stop and ask" per docs/agents/process-unattended.md.
```

## Global Constraints

- No native dependency in the package or the binaries: `parquet-wasm`, `apache-arrow` and `@duckdb/duckdb-wasm` only; `@duckdb/node-api` is not a dependency.
- Pinned exact versions (`save-exact`); `@duckdb/duckdb-wasm` **1.32.0**, never the `latest` tag (it points at dev builds).
- Parquet compression **ZSTD**; row groups **50 000** rows by default (`writer.rowGroupRows`, allowed 50 000–100 000).
- Rows within a partition file sorted by `scope_name`, `service_name`, then time (§6.2).
- Timestamps are **absolute** unix nanoseconds as int64 (OTel Arrow convention; merges never rebase). `epochUnixNano` stays in the manifest for readers that want relative time.
- Attributes are JSON text in the chunk format's tagged encoding (`encodeJson` in `src/format/columns.ts`), so nothing is lost (§6.3).
- Partitions are immutable; the manifest is written before any file it stops listing is deleted (§5.1).
- Statistics keys: `scope_name`, `service_name`, `name` (spans), `severity_number` (logs), `metric_name` (points), plus every resource attribute key named by a dashboard `variables` entry in the report's config, plus `writer.statisticsKeys`; distinct values kept up to `writer.facetValueCap`, `null` past it (§5.2).
- Layout rule: no file or folder starts with `_`; every path relative; manifest paths validated by regex.
- Engineering standards (spec §3): strict TS, no `any`, typed `OtelHtmlError`s, injected deps (`WriterDeps`), Biome clean, README updated in the PR that changes behaviour, TDD per task, `mise run check` before every push, Chromium e2e before every PR.

## Review Focus

Inputs the spec implies but no section's tests would exercise without these lines; each is pinned to a task below.

1. A signal with zero records in a flush: the partition has no file for that table, the manifest entry omits it, and a reader iterating `files` never meets an empty Parquet file. (Task 3.3)
2. Attribute keys with quotes, dots, `$`-prefixed names and values beyond 2^53, bytes and non-finite doubles round-trip exactly through Parquet. (Task 1.2)
3. A crash after partition files are written but before the manifest commit leaves the old manifest valid and the orphan files unlisted; a crash during compaction leaves the flush partitions live and the half-written compacted files unlisted. (Task 6.2)
4. A `local` wrapper of a 3 MB Parquet file is a valid classic script: base64 only, no `</script>`, registration key equal to the manifest's path without `data/` and `.parquet`, and it registers through the existing `__OH__` bootstrap. (Task 7.2)
5. Three format-3 inputs with different epochs merge into one format-4 output whose absolute times are each input's `epoch + relative`, and a format-4 input is copied, never re-encoded. (Task 8.1, 8.2)

---

## PR 1: Parquet encoding core

Branch `feat/format-4-parquet-core` from `feat/format-4`. Title: `feat(format): Arrow schemas and a ZSTD Parquet codec for the five format-4 tables`.

### Task 1.1: Table schemas

**Files:**
- Create: `src/format/parquet/schema.ts`
- Test: `test/format/parquet/schema.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TABLES = ['spans', 'logs', 'points', 'traces', 'patterns'] as const;
  export type Table = (typeof TABLES)[number];
  export type ColumnType = 'utf8' | 'json' | 'int32' | 'int64' | 'float64' | 'bool' | 'list_float64' | 'list_int64';
  export interface ColumnDef { readonly name: string; readonly type: ColumnType; readonly nullable: boolean; readonly dictionary: boolean }
  export const TABLE_COLUMNS: Readonly<Record<Table, readonly ColumnDef[]>>;
  /** The columns a table's rows are sorted by, in order: scope_name, service_name, then its time column. */
  export const SORT_COLUMNS: Readonly<Record<Table, readonly string[]>>;
  export const TIME_COLUMN: Readonly<Record<Table, string>>;
  export const FIXED_STATISTICS_COLUMNS: Readonly<Record<Table, readonly string[]>>;
  export function arrowSchema(table: Table): import('apache-arrow').Schema;
  ```
- Column lists (spec §6.1; OTel Arrow names where they exist):
  - `spans`: trace_id, span_id, parent_span_id, trace_state, flags, name, kind, start_time_unix_nano, end_time_unix_nano, duration_ns, status_code, status_message, dropped_attributes_count, dropped_events_count, dropped_links_count, attributes (json), events (json), links (json), resource_attributes (json), resource_schema_url, resource_dropped_attributes_count, scope_name, scope_version, scope_attributes (json), scope_schema_url, scope_dropped_attributes_count, service_name, resource_name.
  - `logs`: time_unix_nano, observed_time_unix_nano, severity_number, severity_text, body (json), attributes (json), dropped_attributes_count, flags, trace_id, span_id, the same resource and scope columns, service_name, host_name.
  - `points`: metric_name, metric_description, metric_unit, point_type (utf8: gauge|sum|histogram|exp_histogram|summary), aggregation_temporality (int32), is_monotonic, start_time_unix_nano, time_unix_nano, attributes (json), series_id (utf8), the resource and scope columns, value_double, count, sum, min, max, explicit_bounds (list_float64), bucket_counts (list_int64), scale (int32), zero_count, positive_offset (int32), positive_counts (list_int64), negative_offset (int32), negative_counts (list_int64), quantiles (json), exemplars (json), flags, delta_value, delta_count, reset (bool), out_of_order (bool).
  - `traces`: trace_id, start_time_unix_nano, end_time_unix_nano, span_count, error_count, root_service, root_name, root_resource, log_count.
  - `patterns`: cluster_id (int64), template, count, first_time_unix_nano, last_time_unix_nano, severity_counts (json), sample.
  - `dictionary: true` for scope_name, service_name, resource_name, host_name, name, metric_name, point_type, trace_id, span_id, parent_span_id, status_message, severity_text, scope_version, template, and every json column.
  - `SORT_COLUMNS`: spans `['scope_name','service_name','start_time_unix_nano']`; logs `['scope_name','service_name','time_unix_nano']`; points `['scope_name','service_name','metric_name','time_unix_nano']`; traces `['start_time_unix_nano']`; patterns `['cluster_id']`.
  - `FIXED_STATISTICS_COLUMNS`: spans `['scope_name','service_name','name']`; logs `['scope_name','service_name','severity_number']`; points `['scope_name','service_name','metric_name']`; traces and patterns `[]`.

- [ ] **Step 1: Write the failing test**

```ts
test('every table has its sort and time columns and no duplicate names', () => {
  for (const t of TABLES) {
    const names = TABLE_COLUMNS[t].map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SORT_COLUMNS[t]) expect(names).toContain(s);
    expect(names).toContain(TIME_COLUMN[t]);
    expect(arrowSchema(t).fields.map((f) => f.name)).toEqual(names);
  }
});
test('spans carry the OTel Arrow time names and json attributes', () => {
  const spans = TABLE_COLUMNS.spans;
  expect(spans.find((c) => c.name === 'start_time_unix_nano')?.type).toBe('int64');
  expect(spans.find((c) => c.name === 'attributes')).toMatchObject({ type: 'json', dictionary: true });
});
```

- [ ] **Step 2: Run `pnpm exec vitest run test/format/parquet/schema.test.ts`; expected FAIL (module not found)**
- [ ] **Step 3: Add dependencies: `pnpm add parquet-wasm@0.9.0 apache-arrow@21.2.0` (runtime), then implement `schema.ts`.** `arrowSchema` maps `utf8`/`json` to `Utf8` (wrapped in `Dictionary(Utf8, Int32)` when `dictionary`), `int32` to `Int32`, `int64` to `Int64`, `float64` to `Float64`, `bool` to `Bool`, lists to `List<Float64|Int64>`.
- [ ] **Step 4: Run the test; expected PASS**
- [ ] **Step 5: Commit** `feat(format): table schemas for format 4`

### Task 1.2: Row mapping

**Files:**
- Create: `src/format/parquet/rows.ts`
- Test: `test/format/parquet/rows.test.ts`

**Interfaces:**
- Consumes: `SpanRecord`, `LogRecordRecord`, `MetricPointRecord`, `ResourceRecord`, `ScopeRecord` (`src/model/records.ts`); `encodeJson`-style tagging: export a public `attributesToJson(a: Attributes): string` and `anyValueJson(v: AnyValue): string` from `src/format/columns.ts` (today's encoders, made reusable) that produce the tagged JSON of §6.3; `serviceName`, `resourceName` (`src/semconv/resource-name.ts`); `UnixNanos`, `RelNanos` (`src/model/ids.ts`).
- Produces:
  ```ts
  export type Row = Record<string, unknown>;      // keyed by column name; bigint for int64 columns
  export interface Context { epoch: UnixNanos; resources: (r: ResourceRef) => ResourceRecord; scopes: (s: ScopeRef) => ScopeRecord }
  export function spanRow(span: SpanRecord, ctx: Context): Row;
  export function logRow(log: LogRecordRecord, ctx: Context): Row;
  export interface PointNormalization { deltaValue: number | null; deltaCount: number | null; reset: boolean; outOfOrder: boolean; seriesId: string }
  export function pointRow(point: MetricPointRecord, norm: PointNormalization, ctx: Context): Row;
  export function absolute(t: RelNanos, epoch: UnixNanos): bigint;  // epoch + t
  ```
  Null `parentSpanId`, `traceId`/`spanId` on logs, and times become `null`; `duration_ns` is `max(0, end - start)` as a number; `status_code` the enum number.

- [ ] **Step 1: Write the failing tests** (Review Focus 2 lives here)

```ts
test('a span row carries absolute times and tagged attributes', () => {
  const row = spanRow(span({ start: 5n as unknown as RelNanos, attributes: attrs({ 'a.b"c': int(2n ** 60n), raw: bytes([1, 2]) }) }), ctx);
  expect(row['start_time_unix_nano']).toBe(EPOCH + 5n);
  expect(JSON.parse(row['attributes'] as string)).toEqual({ 'a.b"c': { $i: (2n ** 60n).toString() }, raw: { $b: 'AQI=' } });
});
test('non-finite doubles and $-prefixed keys survive', () => { /* -0, NaN, Infinity -> {$d}; a key "$x" is kept as a key, not a tag */ });
test('a log row has null trace ids when unset and the host name promoted', () => { /* ... */ });
test('a point row carries the normalization columns verbatim', () => { /* deltaValue 3 -> delta_value 3, reset true */ });
```

- [ ] **Step 2: Run the file; expected FAIL**
- [ ] **Step 3: Implement `rows.ts`; refactor `columns.ts` to export `attributesToJson` and `anyValueJson` without changing the chunk encoding (the existing `columns.test.ts` must stay green).**
- [ ] **Step 4: Run `pnpm exec vitest run test/format`; expected PASS**
- [ ] **Step 5: Commit** `feat(format): record to format-4 row mapping with tagged JSON attributes`

### Task 1.3: Codec

**Files:**
- Create: `src/format/parquet/codec.ts`
- Test: `test/format/parquet/codec.test.ts`
- Test helper: `test-support/parquet-metadata.ts` (reads Parquet metadata through `@duckdb/duckdb-wasm`'s Node build: `createDuckDB` from `dist/duckdb-node-blocking.cjs`, a `NODE_FS` registered file, `SELECT * FROM parquet_metadata('f')`)

**Interfaces:**
- Produces:
  ```ts
  export interface EncodeOptions { rowGroupRows: number }
  /** Sorts `rows` by SORT_COLUMNS[table] (stable) and encodes them; throws `invalid-report` on a row missing a non-nullable column. */
  export function encodeTable(table: Table, rows: readonly Row[], opts: EncodeOptions): Uint8Array;
  export function decodeTable(table: Table, bytes: Uint8Array): Row[];
  ```
  Implementation: `tableFromArrays` per column in `arrowSchema` order, `tableToIPC(table, 'stream')`, `Table.fromIPCStream`, `WriterPropertiesBuilder().setCompression(Compression.ZSTD).setMaxRowGroupSize(rowGroupRows).build()`, `writeParquet`; decode with `readParquet(bytes).intoIPCStream()` and `tableFromIPC`. Dictionary columns come back as Arrow dictionaries; `decodeTable` returns plain values.

- [ ] **Step 1: Write the failing tests**

```ts
test('encode then decode is the identity after sorting', () => { /* 3 spans out of order -> decoded rows sorted by scope_name, service_name, start */ });
test('ZSTD and row groups are what the options say', async () => {
  const bytes = encodeTable('spans', manySpans(120_000), { rowGroupRows: 50_000 });
  const meta = await parquetMetadata(bytes);      // test-support helper
  expect(new Set(meta.map((m) => m.compression))).toEqual(new Set(['ZSTD']));
  expect(new Set(meta.map((m) => m.row_group_id)).size).toBe(3);
  expect(meta.find((m) => m.path_in_schema === 'scope_name')?.stats_min).toBeDefined();
});
test('a missing non-nullable column is an invalid-report error naming the column', () => { /* ... */ });
test('an empty row list encodes to a valid empty table', () => { expect(decodeTable('logs', encodeTable('logs', [], opts))).toEqual([]); });
```

- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement `codec.ts` and the metadata helper (add `@duckdb/duckdb-wasm@1.32.0` as a devDependency now; PR 7 promotes it).**
- [ ] **Step 4: Run; expected PASS. Record the encode time of 120 000 spans in the PR body.**
- [ ] **Step 5: Commit** `feat(format): ZSTD Parquet codec over Arrow for format-4 tables`

### Task 1.4: File statistics

**Files:**
- Create: `src/format/parquet/stats.ts`
- Test: `test/format/parquet/stats.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FileStatistics { rows: number; timeMin: string | null; timeMax: string | null; values: Record<string, string[] | null> }
  /** `keys`: column names and `attr:<key>` / `resource:<key>` paths read from the json columns; a key with more than `cap` distinct values is `null`. Times as decimal strings (int64). */
  export function fileStatistics(table: Table, rows: readonly Row[], keys: readonly string[], cap: number): FileStatistics;
  export function statisticsKeysFor(table: Table, config: { dashboards: readonly ResolvedDashboard[]; writer: { statisticsKeys: readonly string[] } }): string[];
  ```
  `statisticsKeysFor` = `FIXED_STATISTICS_COLUMNS[table]` ∪ `resource:<key>` for every dashboard variable key ∪ config keys (as given), deduplicated, in that order.

- [ ] **Step 1: Write the failing tests** (distinct values sorted; `null` past the cap; a `resource:cicd.pipeline.run.id` key read from `resource_attributes`; `timeMin`/`timeMax` from `TIME_COLUMN`; empty rows give `rows: 0` and null times)
- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(format): per-file statistics for partition pruning`

---

## PR 2: Manifest and layout for format 4

Branch `feat/format-4-manifest`. Title: `feat(format): the format-4 manifest with partitions, statistics keys and engine fields`.

### Task 2.1: Paths and version

**Files:**
- Modify: `src/format/paths.ts`, `src/format/version.ts`
- Test: `test/format/paths.test.ts` (new), `test/format/manifest.test.ts`

**Interfaces:**
- Produces: `PARTITION_FORMAT_VERSION = 4`, `CHUNK_FORMAT_VERSION = 3` (the old `FORMAT_VERSION` renamed; `READABLE_FORMAT_VERSIONS = [1, 2, 3, 4]`), `partitionDir(n: number): string` (`data/partitions/<p6>`), `partitionFilePath(n, table): string` (`.../<table>.parquet`), `partitionWrapperPath(n, table)` (`.parquet.js`), `partitionKey(n, table)` (`partitions/<p6>/<table>`), `PARTITION_FILE_RE`, `ENGINE_ASSET_RE` (`assets/duckdb\.[0-9][A-Za-z0-9.-]*\.(wasm|worker\.js|wasm\.gz\.b64\.js|worker\.b64\.js)`).

- [ ] Steps: failing tests for the paths and regexes (a `p6` wider than six digits is still valid; `..` is not) → FAIL → implement → PASS → commit `feat(format): partition paths and the format-4 version`.

### Task 2.2: Manifest v4 schema

**Files:**
- Modify: `src/format/manifest.ts`
- Test: `test/format/manifest.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PartitionFile { path: string; bytes: number; rows: number; timeMin: string | null; timeMax: string | null; values: Record<string, string[] | null> }
  export interface PartitionEntry { n: number; source: string; files: Partial<Record<Table, PartitionFile>> }
  export interface ManifestV4 {
    formatVersion: 4; otelHtmlVersion: string; title: string; epochUnixNano: string; createdAt: string; updatedAt: string;
    complete: boolean; range: { start: number; end: number } | null; totals: Record<Signal, number>;
    partitions: PartitionEntry[]; statisticsKeys: Record<Table, string[]>;
    engine: { version: string; format: 'local' | 'site'; assetsBase: string };
    config: Manifest['config'];
  }
  export type AnyManifest = Manifest | ManifestV4;          // `Manifest` stays the v1–3 type until plan 2
  export function parseAnyManifest(input: unknown): AnyManifest;  // dispatches on formatVersion
  export function isV4(m: AnyManifest): m is ManifestV4;
  ```
  Strict objects; `source` matches `/^(flush|compact|job|ci|merge):[A-Za-z0-9#:._-]{1,200}$/`; `assetsBase` is `assets/` or a relative path of `../` segments followed by `assets/<segment>/`, never absolute, never a scheme; `partitions[i].files[t].path` must equal `partitionFilePath(n, t)`; `n` strictly increasing.

- [ ] Steps: failing tests (a v4 manifest parses; a v3 one still parses through `parseAnyManifest`; a wrong file path, a duplicate `n`, an absolute `assetsBase` each fail with the path in the error) → FAIL → implement → PASS → commit `feat(format): manifest v4`.

### Task 2.3: Writer state v2

**Files:**
- Modify: `src/format/state.ts`
- Test: `test/format/state.test.ts` (new)

**Interfaces:**
- Produces: `SessionStateV2 { formatVersion: 2; otelHtmlVersion; epochUnixNano; nextPartition: number; flushPartitions: number[]; dedupe: string[]; metricStreams: unknown; drain: unknown; statisticsKeys: Record<Table, string[]> }`, `AnySessionState = SessionState | SessionStateV2`, `parseAnySessionState`. `flushPartitions` lists the partitions written since open that `close()` compacts.

- [ ] Steps: failing tests → implement → PASS → commit `feat(format): writer state v2 for partitions`.

---

## PR 3: The partition writer for spans and logs

Branch `feat/format-4-partition-writer`. Title: `feat(writer): a writer.format of local or site writes Parquet partitions for spans and logs`.

### Task 3.1: Config keys

**Files:**
- Modify: `src/config/schema.ts`, `schema/otel-html.schema.json` (via `mise run gen`), README configuration table
- Test: `test/config/schema.test.ts`

**Interfaces:**
- Produces in `WriterSchema`: `format: z.enum(['chunks', 'local', 'site']).default('chunks')` (plan 2 changes the default to `local` and removes `chunks`), `rowGroupRows: z.number().int().min(50_000).max(100_000).default(50_000)`, `statisticsKeys: z.array(z.string()).default([])`, `localWarnBytes: posInt.default(256_000_000)`, `assetsBase: z.string().default('assets/')` (validated like the manifest's). Env: `OTEL_HTML_FORMAT`. README rows for each.

- [ ] Steps: failing tests (defaults; `rowGroupRows: 10` rejected with its path; `assetsBase: '/x'` rejected) → implement → `mise run gen` → PASS → commit `feat(config): writer.format, rowGroupRows, statisticsKeys, localWarnBytes, assetsBase`.

### Task 3.2: PartitionWriter

**Files:**
- Create: `src/writer/partition-writer.ts`
- Test: `test/writer/partition-writer.test.ts`

**Interfaces:**
- Consumes: Task 1.3 `encodeTable`, Task 1.4 `fileStatistics`, `FileSystem` (`src/writer/ports.ts`), `at` (`src/writer/checkpoint.ts`), Task 2.1 paths.
- Produces:
  ```ts
  export interface PartitionWriterOptions { out: string; rowGroupRows: number; statisticsKeys: Record<Table, string[]>; facetValueCap: number; nextPartition: number }
  export class PartitionWriter {
    constructor(fs: FileSystem, opts: PartitionWriterOptions);
    add(table: Table, row: Row): void;
    /** Rows held across every table. */
    get pendingRows(): number;
    /** Estimated bytes held, for the flush-by-size rule (sum of JSON text lengths plus 64 per row). */
    get pendingBytes(): number;
    /** Encodes and writes one partition from the held rows (tables with no rows get no file); returns null when nothing is held. Does not touch the manifest. */
    cut(source: string): Promise<PartitionEntry | null>;
    get nextPartition(): number;
  }
  ```

- [ ] **Step 1: Failing tests**: a cut with spans and logs writes `data/partitions/000000/spans.parquet` and `logs.parquet`, no `points.parquet`, returns an entry whose `files.spans.rows` is the count, `values.scope_name` sorted distinct, `source` as given; a second cut numbers `000001`; a cut with nothing held returns null and writes nothing; rows decode back sorted (Task 1.3 `decodeTable`).
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** → **Step 5: commit** `feat(writer): PartitionWriter`

### Task 3.3: Session wiring for spans and logs

**Files:**
- Modify: `src/writer/session.ts` (`openSession`, `Session`), `src/writer/checkpoint.ts` (`loadCheckpoint` accepts v2 state and a v4 manifest; `writeManifest` takes `AnyManifest`; `isReportFolder` unchanged)
- Create: `src/writer/partition-session.ts` — the format-4 half of `Session`: a class `PartitionSession` with the same `WriterSession` interface, constructed by `openSession` when `config.writer.format !== 'chunks'`. Keep `Session` (chunks) untouched except for the dispatch, so the old path's tests stay green.
- Test: `test/writer/partition-session.test.ts`

**Interfaces:**
- Consumes: Task 3.2; `normalizeTraces`/`normalizeLogs`, `DedupeSet`, drop conditions, lock, idle timers, `#serial` queue (copy the pattern from `Session`), `renderIndexHtml`, `writeViewerAssets`.
- Produces: `openSession(deps, options)` returns a `PartitionSession` for `local`/`site`; `PartitionSession` writes a v4 manifest at every checkpoint with `engine: { version: ENGINE_VERSION, format, assetsBase }` (`ENGINE_VERSION` exported from `src/writer/engine-assets.ts`, Task 7.1; until then a constant `'1.32.0'` in `partition-session.ts` that Task 7.1 moves), `statisticsKeys` from Task 1.4, totals, range, `complete`. Checkpoint rule: at `flushIntervalMs` or when `pendingBytes >= writer.chunkTargetBytes`, `cut('flush:<n>')`, write state v2 (slot alternation as today), then the manifest listing the new partition. `addRecords` (merge input) is Task 8.1's concern: here it throws `usage` "not supported yet" so a reviewer sees the gap is deliberate.

- [ ] **Step 1: Failing tests** (Review Focus 1 here): `openSession` with `writer.format: 'site'`, `add` 3 spans and 2 logs, `flush()`: the manifest parses as v4 with one partition, `source: 'flush:0'`, `files.spans.rows 3`, `files.logs.rows 2`, no `points`; `totals`; a flush with only spans gives a partition without `logs`; a second `add` + `flush` gives partition 1; `close()` marks `complete: true`; dedupe drops a repeated span id; a drop condition drops; the lock is held and released; `mode: 'append'` on a v4 report resumes `nextPartition` from state v2; `mode: 'open'` on a format-3 report with `format: 'site'` fails `version-mismatch` with the hint "use merge to convert".
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: `pnpm exec vitest run test/writer`; every existing writer test still PASS** → **Step 5: commit** `feat(writer): a partition session for spans and logs`

### Task 3.4: Shell for format 4

**Files:**
- Modify: `src/writer/html.ts` (`renderIndexHtml(entry, title, opts?: { assetsBase?: string })` resolves the script and style under `assetsBase`), `src/writer/partition-session.ts` (`#writeShell`)
- Test: `test/writer/html.test.ts`

- [ ] Steps: failing tests (default `assets/viewer.<hash>.js`; `assetsBase: '../../assets/0.3.0/'` yields `../../assets/0.3.0/viewer.<hash>.js`; `data/manifest.js` stays relative to the report) → implement → PASS → commit `feat(writer): index.html references a shared assets base`.

---

## PR 4: Traces and patterns tables

Branch `feat/format-4-traces-patterns`. Title: `feat(writer): per-partition trace summaries and log pattern clusters`.

### Task 4.1: Trace summaries per partition

**Files:**
- Create: `src/writer/trace-summaries.ts`
- Modify: `src/writer/partition-session.ts`
- Test: `test/writer/trace-summaries.test.ts`

**Interfaces:**
- Produces: `class TraceSummaries { addSpan(span: SpanRecord, ctx: Context): void; addLog(traceId: TraceId): void; /** rows for the `traces` table of the partition being cut, then reset */ drain(): Row[] }` — one row per trace touched since the last drain: start/end as absolute, `span_count`, `error_count` (status ERROR), `root_*` when a span with null parent was seen else null, `log_count`.
- The session calls `addSpan`/`addLog` on accept and `drain()` into `PartitionWriter.add('traces', row)` before each `cut`.

- [ ] Steps: failing tests (two spans of one trace in one partition make one row with span_count 2; the same trace in the next flush makes a second row in the next partition; the root's service and name are promoted; a trace with only logs gets a row with span_count 0) → implement → PASS → commit.

### Task 4.2: Patterns per partition

**Files:**
- Modify: `src/writer/partition-session.ts`; reuse `Drain` (`src/rollups/drain.ts`) with its serialized state in state v2 `drain`
- Test: `test/writer/patterns-table.test.ts`

**Interfaces:**
- Produces: on each log accepted, `drain.add(bodyText)` as the log rollup does today; at `cut`, one `patterns` row per cluster whose `count` grew since the last cut: `cluster_id`, `template`, `count` (the increment), `first/last_time_unix_nano` (within the partition), `severity_counts` (json `{ "<severityNumber>": n }`), `sample` (the first body in the partition). Drain state is checkpointed in state v2 so clusters keep their ids across flushes and appends.

- [ ] Steps: failing tests (two logs with one template → one row, count 2; a flush later with one more → a row with count 1 and the same cluster_id; an append session continues the ids) → implement → PASS → commit.

---

## PR 5: Points

Branch `feat/format-4-points`. Title: `feat(writer): metric data points as a long-form Parquet table with delta normalization`.

### Task 5.1: Points in the partition session

**Files:**
- Modify: `src/writer/partition-session.ts`, `src/format/parquet/rows.ts` if a value column was missed
- Test: `test/writer/points-table.test.ts`

**Interfaces:**
- Consumes: `metricPointsOf`, `StreamNormalizer` (`src/rollups/metric-streams.ts`) for cumulative deltas and resets, `MetricCatalog.defOf/seriesOf` only to compute `series_id` (`<def.id>/<series.id>` as today's key), `pointExemplars`.
- Produces: every accepted point is one `points` row; `delta_value`/`delta_count` from the normalizer for cumulative sums and histograms, null otherwise; `reset`/`out_of_order` as the normalizer reports; no folding into "other" (the `metricSeriesCap` config keeps its meaning only on the chunk path; the README says so for `format: local|site`). The normalizer state is checkpointed in state v2 `metricStreams`.

- [ ] Steps: failing tests (a gauge row; a cumulative counter 10 then 15 → delta 5, then 3 → reset true; an explicit histogram's bounds and counts as lists; an exponential histogram's offsets; a summary's quantiles as json; exemplars as json with trace ids) → implement → PASS → commit.

### Task 5.2: Writer memory and throughput measurement

- [ ] **Step 1:** Convert the e2e scale data (`mise run e2e:fixtures:scale:data` inputs, or `scripts/fixtures.ts`-generated OTLP of 100k spans and 1M logs) with `writer.format: site` under `/usr/bin/time -v node dist/cli/main.js convert …`; record wall time and max RSS beside the same conversion with `format: chunks`.
- [ ] **Step 2:** Put both in the PR body. Stop and ask if RSS exceeds the chunk path by more than 25% (the 512 MB target of the spec applies).

---

## PR 6: Compaction and the immutable-partition rule

Branch `feat/format-4-compaction`. Title: `feat(writer): close() compacts a session's partitions into one sorted partition per signal`.

### Task 6.1: Compaction

**Files:**
- Create: `src/writer/compaction.ts`
- Modify: `src/writer/partition-session.ts` (`close()`)
- Test: `test/writer/compaction.test.ts`

**Interfaces:**
- Produces: `compactPartitions(fs, out, entries: readonly PartitionEntry[], opts: { nextPartition: number; rowGroupRows: number; statisticsKeys; facetValueCap; source: string }): Promise<PartitionEntry>` — decodes every file of the given partitions table by table (`decodeTable`), concatenates, encodes one file per table into partition `nextPartition` with `source` `compact:<first>..<last>`, returns the entry. Memory: one table at a time. `close()` compacts `state.flushPartitions` when there are 2 or more, writes the manifest listing the compacted entry instead of them, **then** deletes their folders; a single flush partition is left as is.

- [ ] Steps: failing tests (three flushes → close → one partition whose rows equal the union, sorted, `source 'compact:0..2'`; folders 000000–000002 gone; manifest lists only 000003; a session with one flush partition is not rewritten; merge-copied partitions, marked by a `source` not starting with `flush:`, are never compacted) → implement → PASS → commit.

### Task 6.2: Crash safety

**Files:**
- Test: `test/writer/partition-crash.test.ts` (uses the memory fs's failure injection as `test/writer/crash.test.ts` does)

- [ ] **Step 1: Failing tests** (Review Focus 3): fail the manifest write after partition files are written → the previous manifest parses and lists the previous partitions only; reopening (`append`) prunes the orphan folder before its first checkpoint; fail the delete after a compaction's manifest write → the manifest lists the compacted partition, the stale folders are pruned on the next open; fail the compacted file write → the flush partitions stay listed and the half-written compaction folder is removed on reopen.
- [ ] **Step 2: FAIL** → **Step 3: implement the prune-on-open in `partition-session.ts` (folders under `data/partitions/` the manifest does not list are removed before the first write)** → **Step 4: PASS** → **Step 5: commit**

---

## PR 7: Output formats and engine assets

Branch `feat/format-4-formats`. Title: `feat(writer): local and site output formats; the DuckDB engine ships with the viewer assets`.

### Task 7.1: Engine assets at build time

**Files:**
- Create: `scripts/engine-assets.ts`
- Modify: `mise.toml` (`build:viewer` runs it after vite; its `outputs` include `dist/viewer/assets/duckdb.*`), `src/writer/engine-assets.ts` (new: `ENGINE_VERSION`, `engineAssetNames(format: 'local' | 'site'): string[]`), `src/writer/viewer-assets.ts` (`ViewerAssets.files(format?)` filters engine files by format), `src/api/viewer-dir.ts`
- Test: `test/writer/engine-assets.test.ts`, `test/scripts/engine-assets.test.ts`

**Interfaces:**
- Produces in `dist/viewer/assets/`: `duckdb.<ENGINE_VERSION>.wasm` (copy of `duckdb-eh.wasm`), `duckdb.<ENGINE_VERSION>.worker.js` (copy of `duckdb-browser-eh.worker.js`), `duckdb.<ENGINE_VERSION>.wasm.gz.b64.js` (`__OH__.push("engine/wasm.gz","<base64 of gzip -9>")`), `duckdb.<ENGINE_VERSION>.worker.b64.js` (`__OH__.push("engine/worker","<base64>")`). `@duckdb/duckdb-wasm` moves to `dependencies` (the viewer bundle in plan 2 imports it; the writer only copies files from it). `site` reports get the first two files, `local` reports the last two; `chunks` reports none.

- [ ] Steps: failing tests (the script writes the four names with the version from the package; a `local` session's `assets/` holds exactly viewer files plus the two b64 files; `site` the two plain files; sizes within 10% of the spike's: 9.8 MB and 34 MB) → implement → `mise run build` → PASS → commit.

### Task 7.2: Local wrappers and the size warning

**Files:**
- Modify: `src/writer/partition-writer.ts` (`cut` also writes `<table>.parquet.js` when `format === 'local'`), `src/writer/partition-session.ts` (warn once through `deps.logger.warn` when the sum of partition bytes passes `writer.localWarnBytes`: message names `--format site`), `src/format/data-file.ts` (`wrapBinaryDataFile(key, bytes): string` → `__OH__.push("<key>","<base64>");`)
- Test: `test/writer/local-format.test.ts`

- [ ] **Step 1: Failing tests** (Review Focus 4): the wrapper of a 3 MB partition is `__OH__.push("partitions/000000/spans","…");` with base64 only (`/^[A-Za-z0-9+/=]+$/` on the payload), contains no `<` character, decodes to the Parquet bytes; `site` writes no wrapper; the warning fires once past the threshold and names `--format site`.
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** → **Step 5: commit**

### Task 7.3: CLI and API surface

**Files:**
- Modify: `src/cli/commands/convert.ts`, `serve.ts`, `run.ts`, `merge.ts` (`--format <chunks|local|site>`, `--assets-base <path>`), `src/api/report.ts` (`ReportOptions.format?`, `assetsBase?` map into config), README CLI tables and "Report layout and hosting" (format 4 layout beside format 3 until plan 2 removes the old one)
- Test: `test/cli/program.test.ts`, `test/api/report.test.ts`

- [ ] Steps: failing tests (flag parsed into config; an unknown value exits 2 with the three allowed values) → implement → PASS → commit.

---

## PR 8: Merge, conversion, upgrade

Branch `feat/format-4-merge`. Title: `feat(writer): merge copies format-4 partitions, converts format 1–3 inputs and compacts on request`.

### Task 8.1: Format 1–3 inputs through the partition session

**Files:**
- Modify: `src/writer/partition-session.ts` (`addRecords(batch)` implemented: rebase by `batch.epoch` into absolute times through `rows.ts`, through the same accept paths as `add`), `src/writer/merge.ts` (`mergeReports` picks the session by `config.writer.format`; a v4 output needs `format` not `chunks`, else `usage`)
- Test: `test/writer/merge-convert.test.ts`

- [ ] **Step 1: Failing tests** (Review Focus 5a): the three frozen fixtures `fixtures/reports/format-{1,2,3}` merged with `format: 'site'` produce one v4 report whose span count equals the sum, whose `start_time_unix_nano` of a known span equals that fixture's epoch plus its relative start, and whose `points` rows carry deltas (`test/format/compat.test.ts` gains the v4 target beside the chunk one).
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** → **Step 5: commit**

### Task 8.2: Merge by copy and `--compact`

**Files:**
- Modify: `src/writer/merge.ts`, `src/cli/commands/merge.ts` (`--compact`)
- Test: `test/writer/merge-copy.test.ts`

**Interfaces:**
- Produces: for a v4 input, `mergeReports` copies each partition folder into the output under the next free `n` with `source: merge:<input index>#<n>`, carries the entry's statistics unchanged, and never decodes it; `--compact` (config `writer.compactOnMerge`, default false) runs Task 6.1's `compactPartitions` over everything copied, with `source compact:<first>..<last>`, after the copy's manifest is committed. Mixed inputs (v3 and v4) work: v3 rows go through the session, v4 folders are copied, and statistics keys are the output config's (a copied partition whose `values` lacks a key gets `null` for it).

- [ ] **Step 1: Failing tests** (Review Focus 5b): a v4 input's partition bytes in the output are byte-identical to the input's; merge time for a 20-partition input is under 1 s in the memory fs; `--compact` leaves one partition per signal; a copied partition's `source` names the input.
- [ ] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS** → **Step 5: commit**

### Task 8.3: Upgrade

**Files:**
- Modify: `src/writer/upgrade.ts` (`upgradeReport(deps, dir, opts: { format?: 'local' | 'site'; assetsBase?: string })`: rewrites `assets/` and `index.html` for v4 reports; with `format`, adds or removes the `.parquet.js` wrappers and swaps the engine files; rewrites `manifest.engine`), `src/cli/commands/upgrade.ts` (`--format`, `--assets-base`), README `upgrade` section
- Test: `test/writer/upgrade.test.ts`

- [ ] Steps: failing tests (site → local adds wrappers and b64 engine, manifest `engine.format` flips; local → site removes them; a v3 report keeps today's behaviour; `--assets-base` rewrites `index.html` and `manifest.engine.assetsBase`) → implement → PASS → commit.

---

## PR 9: Schema contract document and plan close-out

Branch `feat/format-4-schema-doc`. Title: `docs(format): the format-4 tables and columns, generated from the schema`.

### Task 9.1: Generated schema page

**Files:**
- Create: `scripts/gen-schema-doc.ts` (writes `docs/format/schema.md` from `TABLE_COLUMNS`, `SORT_COLUMNS`, `FIXED_STATISTICS_COLUMNS`, the `source` grammar and the manifest field list), add to `mise run gen` and `gen:check`
- Test: `test/scripts/gen-schema-doc.test.ts` (the generated text contains every column name once per table; `gen:check` fails when the committed file is stale)

- [ ] Steps: failing test → implement → `mise run gen` → PASS → commit.

### Task 9.2: README and compat rule

- [ ] Update README "Report format compatibility": format 4 written when `writer.format` is `local` or `site`; readable versions 1–4; the viewer reads only the format it is built for (plan 2 states which); the frozen format-4 fixture is added when the release ships, as the rule says.
- [ ] `mise run check` and `mise run test:e2e:chromium` green (the e2e fixtures are still written as `chunks` by default, so the current viewer keeps working).
- [ ] Commit `docs: format 4 in the compatibility rule`.

### Plan close-out

- [ ] The branch reviewer's summary (Opus 5.5) for each PR is quoted in that PR's body; the coordinator posts the summary the unattended process asks for (PR numbers, titles, the measurements of Tasks 1.3 and 5.2, issues opened).
- [ ] Write plan 2 from the spec §7 and the interfaces this plan produced (`PartitionEntry`, `TABLE_COLUMNS`, `partitionKey`, `engineAssetNames`, `ManifestV4`), with the brainstorming skill skipped (the spec is approved) and the builder check run.
