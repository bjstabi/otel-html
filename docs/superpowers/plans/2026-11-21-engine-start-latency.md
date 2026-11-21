# Faster report open — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A report's engine starts from bytes the page fetched itself (all four files in parallel, from the page's first
bytes on a `site` report, no `data:` URL for the wasm), the navigation is on screen while it starts, and binding the
base views costs no range read for a small first file.

**Architecture:** `start.ts` creates the worker from a blob (shim + worker script) for both formats and hands it the
wasm as a transferred `ArrayBuffer` that a `fetch` override in the shim serves to duckdb-wasm; `index.html` of a `site`
report starts the four downloads inline and the viewer awaits them. `App` renders the `Shell` as soon as the manifest
is known, with a loading line where the page will be. `openReport` fetches the first file of each view group whole
(through the existing `SmallFiles`) before creating the views.

**Tech Stack:** TypeScript (strict), React, @duckdb/duckdb-wasm 1.32.0 (unchanged), vitest, Playwright, mise.

**Spec:** `docs/superpowers/specs/2026-11-21-engine-start-latency-design.md`. The spec wins where they differ.

**PR process:** unattended (`docs/agents/process-unattended.md`), one PR.

| #   | branch              | PR title                                                                                                   | status |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `perf/engine-start` | `perf(viewer): engine bytes handed to the worker, the shell during the load, views bound without range reads` | merged #367 (3379619e) |

- **Models.** Implementers and task reviewers run on Sonnet 5.5. The branch review runs on Opus 5.5.
- **Bugs found on the way** are fixed in this PR and listed under **Also** in its body.
- **Write-token files.** Nothing under `.github/` changes. `src/cli/ci/run-report.ts` and `main-report.ts` change
  one call each (precedent: the slim-history plan). Any other change there is a stop.
- **Commits** end with the session's trailers (`Co-Authored-By`, `Claude-Session`).

## Global Constraints

- No change to the manifest, the partition files, the public API (`src/api/index.ts`) or any CLI flag. `index.html`
  gains an inline script for `site` reports only.
- No new dependency. `@duckdb/duckdb-wasm` stays at 1.32.0.
- `EMBEDDED_HOST = 'https://oh-engine.invalid/'` stays; the wasm hand-off URL is `EMBEDDED_HOST + 'duckdb.wasm'`; the
  hand-off message is `{ __oh: { wasm: ArrayBuffer } }`, posted with the buffer in the transfer list.
- The extension repositories of **both** formats point at `EMBEDDED_HOST + 'no-extensions'`.
- The loading line keeps `role="status"`; it gets `aria-label="Loading the report"`; it is never inside a `main`.
- The `viewer.engine.start`, `viewer.partitions.register` and `viewer.load` spans keep their names and nesting.
- Strict TypeScript as `tsconfig.base.json`; Biome at error. Before each commit: `pnpm exec biome check .` and
  `mise run typecheck`; `mise run check` after each task; `mise run verify` before the PR.
- The wait loop rule of AGENTS.md: no `pgrep -f`/`pkill -f` loops; run long commands in the foreground with a timeout.

## Review Focus

1. A `site` page whose inline prefetch rejected (a 404, an aborted connection): the viewer must fetch the file itself
   once and, if that fails too, show the D13 error naming the file, never hang. (Task 2 tests the fallback and the
   error; the inline script's `.catch(() => {})` keeps the console clean.)
2. A report written by an older version has no `__OH__.pre`: `registry.prefetched` returns `undefined` for every
   href and the viewer fetches (Task 2).
3. A `local` report in Firefox and WebKit: the blob worker, the transferred buffer and the `Response`-based
   `instantiateStreaming` must work there, not only in Chromium (the spike says yes; the e2e matrix proves it on push,
   Task 5's spec runs in every browser).
4. The e2e "report loaded" heuristic (`e2e/test.ts`, a `main` attached) must not fire on the shell's nav: the loading
   line is a `p`, the Sidebar a `nav`; Task 4 asserts no `main` while loading, Task 5 asserts `nav` before `main`.
5. A view group whose first file is larger than `SMALL_FILE_BYTES` or whose whole-file fetch fails: `prepare` resolves
   anyway and the view binds by range reads as today (Task 3 tests a large first file is skipped; `SmallFiles` already
   swallows fetch failures).

---

### Task 1: `index.html` starts the engine downloads of a `site` report

**Files:**
- Modify: `src/writer/html.ts` (`renderIndexHtml` options), `src/writer/partition-session.ts:1151-1154`,
  `src/writer/upgrade.ts:192-195`, `src/cli/ci/run-report.ts:287-290`, `src/cli/ci/main-report.ts:80`
- Test: `test/writer/html.test.ts`; adjust the call-site tests that compare `index.html` text
  (`test/writer/local-format.test.ts`, `test/writer/partition-session.test.ts`, `test/writer/upgrade*.test.ts`,
  `test/cli/ci/` where `renderIndexHtml(` appears)

**Interfaces:**
- Produces: `renderIndexHtml(entry: ViewerEntry, title: string, opts: { assetsBase?: string; host?: string; format?: 'local' | 'site' }): string`.
  With `format: 'site'` the output contains, after the `__OH__` bootstrap `<script>` and before
  `<script src="data/manifest.js">`, one `<script>` that sets `__OH__.pre` to an object mapping each of
  `engineAssetNames('site')` prefixed by `assetsBase` (the literal string, e.g. `assets/duckdb.1.32.0.wasm`) to
  `fetch(href).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })`, and attaches
  `.catch(() => {})` to each promise as a second consumer (the stored promise stays rejected). The hrefs are escaped like
  the other hrefs. With `'local'` or no `format` the output is byte-identical to today's.
- Task 2 reads `__OH__.pre[href]` by the same href strings (`engine.assetsBase + name`).

- [ ] **Step 1: Write the failing tests** in `test/writer/html.test.ts`:

```ts
test("format 'site' starts the four engine downloads before the manifest script", () => {
  const html = renderIndexHtml(entry, 't', { format: 'site' });
  const block = html.match(/<script>__OH__\.pre=[\s\S]*?<\/script>/)?.[0] ?? '';
  for (const name of engineAssetNames('site')) expect(block).toContain(`"assets/${name}"`);
  expect(html.indexOf('__OH__.pre')).toBeGreaterThan(html.indexOf('window.__OH__={q:[]'));
  expect(html.indexOf('__OH__.pre')).toBeLessThan(html.indexOf('src="data/manifest.js"'));
  expect(block).toContain('arrayBuffer()');
  expect(block).toContain('.catch(');
});
test('a shared base prefixes the engine hrefs', () => {
  expect(renderIndexHtml(entry, 't', { assetsBase: '../../assets/', format: 'site' })).toContain('"../../assets/duckdb.1.32.0.wasm"');
});
test("format 'local' and no format write no prefetch", () => {
  expect(renderIndexHtml(entry, 't', { format: 'local' })).toBe(renderIndexHtml(entry, 't'));
  expect(renderIndexHtml(entry, 't')).not.toContain('__OH__.pre');
});
```

- [ ] **Step 2: Run** `pnpm exec vitest run test/writer/html.test.ts` — expected: the three new tests FAIL.
- [ ] **Step 3: Implement** the `format` option in `src/writer/html.ts`; build the href list from
  `engineAssetNames('site')` (`src/format/engine.ts`) and `base`; escape with `escapeHtml`; emit the block only for
  `'site'`. Update the doc comment.
- [ ] **Step 4: Pass the format at the call sites:** `partition-session.ts` has `format` in scope; `upgrade.ts` has
  `format`; `run-report.ts` and `main-report.ts` use `manifest.engine.format` / `patched.engine.format`. Hosted pages
  (`src/host/server.ts`) pass nothing.
- [ ] **Step 5: Run** `pnpm exec vitest run test/writer test/cli` — fix the call-site tests that compare `index.html`
  text by passing the same `format` to their expected `renderIndexHtml(...)`. Expected: all PASS.
- [ ] **Step 6:** `pnpm exec biome check .` and `mise run typecheck`, then commit:
  `perf(writer): a site report's index.html starts the engine downloads before the viewer loads`.

### Task 2: The engine bytes are fetched by the page and handed to the worker

**Files:**
- Modify: `src/viewer/data/engine/start.ts`, `src/viewer/data/registry.ts`, `src/viewer/main.tsx`,
  `src/viewer/data/open-report.ts` (only `OpenDeps`/`EngineDeps` pass-through if needed)
- Test: `test/viewer-data/engine-start.test.ts`, `test/viewer/registry.test.ts`

**Interfaces:**
- Consumes: `__OH__.pre` as Task 1 writes it.
- Produces:
  - `registry.ts`: `OhGlobal.pre?: Record<string, Promise<ArrayBuffer>>`;
    `Registry.prefetched(href: string): Promise<ArrayBuffer> | undefined` (the bootstrap's map, carried over by
    `installRegistry`; `undefined` when the bootstrap had none or the href is unknown).
  - `start.ts`: `EngineDeps` gains `fetch?: typeof fetch` (default `globalThis.fetch`) and
    `prefetched?: (href: string) => Promise<ArrayBuffer> | undefined`. New exports:
    `WASM_HANDOFF_URL = EMBEDDED_HOST + 'duckdb.wasm'`; `workerShim(extensionDataUrls: Record<string, string>): string`
    (the message listener + `fetch` override, followed by today's `extensionShim(...)` text, which stays exported).
    `startEngine(engine, deps)` keeps its signature and the `Engine` it returns.
  - `main.tsx` passes `prefetched: registry.prefetched` (bound) and nothing for `fetch`.

- [ ] **Step 1: Write the failing registry test** in `test/viewer/registry.test.ts`:

```ts
test('prefetched promises of the bootstrap are carried over', async () => {
  const p = Promise.resolve(new ArrayBuffer(1));
  const win = { __OH__: { q: [], push() {}, pre: { 'assets/x.wasm': p } } } as unknown as Window;
  const registry = installRegistry(win);
  expect(registry.prefetched('assets/x.wasm')).toBe(p);
  expect(registry.prefetched('assets/other')).toBeUndefined();
  expect(installRegistry({ __OH__: { q: [], push() {} } } as unknown as Window).prefetched('a')).toBeUndefined();
});
```

- [ ] **Step 2: Write the failing engine tests** in `test/viewer-data/engine-start.test.ts` (extend the existing
  fake `AsyncDuckDB`; add a fake `Worker` returned by `deps.createWorker` that records `postMessage(message, transfer)`
  calls; a fake `fetch` for `site` that maps URL → bytes or a status):

```ts
test('local: the wasm is posted to the worker as a transferred buffer and instantiated through the hand-off URL', async () => {
  // loader payloads: wasm gz b64 of 'WASM', worker b64 of 'WORKER', the two extension payloads
  await startEngine(localEngine, deps);
  expect(fake.instantiated).toEqual([WASM_HANDOFF_URL]);
  const [message, transfer] = worker.posted[0];
  expect(new TextDecoder().decode(new Uint8Array(message.__oh.wasm))).toBe('WASM');
  expect(transfer).toEqual([message.__oh.wasm]);
  expect(worker.posted).toHaveLength(1);
});
test('local: the four wrappers load concurrently', async () => {
  // a loader that resolves only after all four keys were requested; the test times out if loads are sequential
});
test('site: the worker script, the wasm and both extensions are fetched concurrently and the worker is a blob', async () => {
  // fake fetch resolves after all four URLs were requested; createWorker receives the blob URL deps.blobUrl.create returned
  expect(fetched).toEqual(expect.arrayContaining([urls.worker, urls.wasm, ext.parquet, ext.json]));
  expect(fake.opened).toEqual([{ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } }]);
});
test('site: a prefetched promise is used instead of a fetch; a rejected one falls back to one fetch', async () => { /* prefetched for the wasm href only */ });
test('site: a 404 on an engine file is the D13 error naming it', async () => { /* expect OtelHtmlError invalid-report with path = that URL */ });
test('both formats LOAD the extensions through the shim and point the repositories at the embedded host', async () => {
  expect(fake.statements).toEqual(expect.arrayContaining([`LOAD '${EMBEDDED_HOST}parquet.duckdb_extension.wasm'`, `SET custom_extension_repository = '${EMBEDDED_HOST}no-extensions'`]));
});
test('workerShim serves the posted buffer to a fetch of the hand-off URL and passes other fetches through', async () => {
  // run the shim text with new Function over a fake `self` (addEventListener, fetch) and check: a message { __oh: { wasm } } is
  // stopped (stopImmediatePropagation called) and a later fetch(WASM_HANDOFF_URL) resolves to a Response with content-type application/wasm
});
```

- [ ] **Step 3: Run** `pnpm exec vitest run test/viewer-data/engine-start.test.ts test/viewer/registry.test.ts` — expected: FAIL.
- [ ] **Step 4: Implement** in `start.ts`: one `startEngine` path. `bytes = format === 'local' ? localBytes(...) :
  siteBytes(...)`, each `Promise.all` over its four sources and returning
  `{ wasm: Uint8Array; worker: Uint8Array; extensions: Record<string, string> }` (extensions as `data:` URLs keyed
  `<ext>.duckdb_extension.wasm`). `siteBytes` resolves each href as `engine.assetsBase + name`, takes
  `deps.prefetched?.(href)`, and on `undefined` or rejection fetches `new URL(href, deps.baseUrl).href` once with
  `deps.fetch ?? fetch`; a non-OK status or a thrown fetch becomes `OtelHtmlError('invalid-report', { path: url,
  expected: 'the DuckDB engine file (<name>)', actual })`. Then: blob worker from `workerShim(extensions) + worker
  bytes`, `worker.postMessage({ __oh: { wasm: buffer } }, [buffer])` (a buffer that owns exactly the bytes: slice when
  the `Uint8Array` is a view), `new AsyncDuckDB(new VoidLogger(), worker)`, `instantiate(WASM_HANDOFF_URL)`, `open(...)`
  for `site`, `connect`, `loadExtensions` (repositories at `EMBEDDED_HOST + NO_REPOSITORY` for both). Remove `toBase64`
  of the wasm and the `wasmUrl` nulling; keep releasing the blob URL and `terminate()` on failure. Implement
  `prefetched` in `registry.ts` and wire `main.tsx`.
- [ ] **Step 5: Run** the two test files — expected: PASS. Then `pnpm exec vitest run test/viewer-data test/viewer/open-report.test.ts`.
- [ ] **Step 6:** `pnpm exec biome check .`, `mise run typecheck`, `mise run test:e2e:chromium -- e2e/smoke.spec.ts e2e/offline.spec.ts e2e/otel.spec.ts` — expected: green in both url kinds. Commit:
  `perf(viewer): the page fetches the engine bytes in parallel and hands the wasm to the worker as a buffer`.

### Task 3: Views bind without range reads when their first file is small

**Files:**
- Modify: `src/query/sql/views.ts`, `src/viewer/data/engine/files.ts` (`registerPartitions`),
  `src/viewer/data/open-report.ts`, `src/viewer/data/refresh-report.ts` (`RefreshDeps.smallFiles`)
- Test: `test/query/sql/views.test.ts`, `test/viewer/open-report.test.ts`, `test/viewer-data/refresh-report.test.ts`

**Interfaces:**
- Produces: `viewBindingFiles(manifest: ManifestV4, set: <the type viewStatements takes>, resolve: (path: string) => string): string[]`
  — the first path of every `read_parquet([...])` list a statement of `set` contains, in statement order
  (`traces`: the first stored-share file and the first plain file, each when its group exists; an empty table
  contributes nothing). `registerPartitions(engine, manifest, deps, onProgress?, prepare?: () => Promise<void>)`
  awaits `prepare` between `registerFiles` and `createViews`. `RefreshDeps.smallFiles` becomes
  `Pick<SmallFiles, 'forget' | 'prepare'>` and `refreshReport` awaits
  `deps.smallFiles?.prepare(viewBindingFiles(manifest, 'base', p => p))` before its `createViews`.

- [ ] **Step 1: Write the failing test** in `test/query/sql/views.test.ts`:

```ts
test('viewBindingFiles names the first file of every read_parquet group of the base views', () => {
  const files = viewBindingFiles(manifest, 'base', (p) => p);
  const lists = viewStatements(manifest, (p) => p, 'base').flatMap((s) => [...s.matchAll(/read_parquet\(\[([^\]]*)\]/g)].map((m) => m[1].split(', ')[0].replaceAll("'", '')));
  expect(files).toEqual(lists);
  expect(files).toHaveLength(new Set(files).size);
});
```

  (use a manifest fixture with a traces file with `serviceShare: true` and one without, and one table with no file).

- [ ] **Step 2: Write the failing open-report test** in `test/viewer/open-report.test.ts`: with the fake parts, a
  `site` manifest whose binding files are under `SMALL_FILE_BYTES` except `spans`, a stubbed `fetch` returning bytes of
  the manifest's size: the order of recorded events is `registerFiles` → `fetch <small binding files>` (all of them, not
  the spans file) → `createViews`; for a `local` manifest no fetch happens. (`registerPartitions` is a fake part here:
  assert it received a `prepare` function for `site` and `undefined` for `local`, and that calling it fetches the
  binding files whole; the real `registerPartitions` ordering is a unit test in `test/viewer-data/engine-files.test.ts`:
  `prepare` resolves before the first `CREATE OR REPLACE VIEW` statement.)
- [ ] **Step 3: Run** the three test files — expected: FAIL.
- [ ] **Step 4: Implement**: `viewBindingFiles` next to `viewStatement` (reuse `tableFiles` and the traces split);
  `registerPartitions` with `prepare`; in `openReportRefreshable` move the `small` creation before
  `registerPartitions` and pass `small ? () => small.prepare(viewBindingFiles(manifest, 'base', (p) => p)) : undefined`;
  `refreshReport` prepare before `createViews`. Update `refresh-report.test.ts` fakes to carry `prepare`.
- [ ] **Step 5: Run** `pnpm exec vitest run test/query/sql/views.test.ts test/viewer/open-report.test.ts test/viewer-data/refresh-report.test.ts test/viewer-data/engine-files.test.ts` — expected: PASS.
- [ ] **Step 6:** `pnpm exec biome check .`, `mise run typecheck`, `mise run test:e2e:chromium -- e2e/refresh.spec.ts e2e/format-6.spec.ts`; commit:
  `perf(viewer): fetch the first file of each view group whole before binding the views`.

### Task 4: The shell shows while the engine starts

**Files:**
- Create: `src/viewer/shell/loading-line.tsx`
- Modify: `src/viewer/data/open-report.ts` (`LoadProgress.manifest`), `src/viewer/app.tsx`, `src/viewer/root.tsx`,
  `src/viewer/shell/shell.tsx`, `e2e/test.ts:36-39` (comment only), `README.md` (one sentence, viewer section)
- Test: `test/viewer/root.test.tsx`, `test/viewer/shell.test.tsx`

**Interfaces:**
- Produces: `LoadProgress.manifest?: ManifestV4` (set on the first progress event, `engine` or `host`).
  `LoadingLine({ progress }: { progress: LoadProgress | null }): JSX.Element` renders
  `<p role="status" aria-label="Loading the report" className="p-8 text-sm text-muted">{progressText(progress)}</p>`
  with today's texts (`progressText` moves here, exported). `Shell` props become
  `{ manifest: ManifestV4; dataSource: DataSource | null; loading?: LoadProgress | null; history: HistoryPort; refresh?: RefreshControl | null }`;
  with `dataSource === null` it renders `<LoadingLine progress={loading ?? null} />` in place of `RoutedPage`. `App`'s
  `loading` state is `{ status: 'loading'; progress: LoadProgress | null; manifest: ManifestV4 | null }`.

- [ ] **Step 1: Write the failing tests.** In `test/viewer/root.test.tsx` (the Shell is mocked there as `'shell'`;
  replace the mock by one that renders `props.dataSource === null ? 'shell-loading' : 'shell'` plus the real
  `LoadingLine`'s text is not needed): the status line is bare until a progress carries a manifest; then
  `shell-loading` renders; after the load resolves, `shell`; the theme attribute is set as soon as the manifest
  progress arrives (before the load resolves). In `test/viewer/shell.test.tsx`: `Shell` with `dataSource={null}` and
  `loading={{ phase: 'engine' }}` renders the navigation (`getByRole('navigation')`), a status with text
  `Starting the query engine` and `queryByRole('main')` null; re-rendering with the data source shows the page.
- [ ] **Step 2: Run** `pnpm exec vitest run test/viewer/root.test.tsx test/viewer/shell.test.tsx` — expected: FAIL.
- [ ] **Step 3: Implement.** `openReportRefreshable`: `onProgress({ phase: 'engine', manifest })` and
  `{ phase: 'host', manifest }`. `App`: keep the manifest from progress; render `LoadingLine` alone until it is known,
  then `Shell` with `dataSource={null}`; `ready` renders `Shell` with the data source and `manifest={ds.manifest}`.
  `Root`: apply the theme on the first progress with a manifest (keep the post-load set as fallback). `Shell`: derive
  everything from `props.manifest`; `RoutedPage` only with a data source. Update the `e2e/test.ts` comment (the nav
  may be in the DOM before the `main`) and add the README sentence.
- [ ] **Step 4: Run** the two test files, then `pnpm exec vitest run test/viewer` — expected: PASS.
- [ ] **Step 5:** `pnpm exec biome check .`, `mise run typecheck`, `mise run test:e2e:chromium -- e2e/smoke.spec.ts e2e/traces-explorer.spec.ts e2e/dashboards.spec.ts e2e/host.spec.ts`; commit:
  `feat(viewer): show the navigation while the engine starts`.

### Task 5: e2e: each engine file once, the navigation before the page

**Files:**
- Create: `e2e/engine-load.spec.ts`

- [ ] **Step 1: Write the spec** (HTTP tag so it runs over http too; it also runs at `file://`):

```ts
test('the engine files are requested once each and the navigation shows before the page', HTTP, async ({ page, baseURL }) => {
  const problems: string[] = []; // console errors, page errors, failed requests, HTTP >= 400 (as smoke.spec.ts)
  const engineRequests = new Map<string, number>();
  page.on('request', (r) => { const u = r.url(); if (/\/assets\/.*(duckdb|duckdb_extension)/.test(u)) engineRequests.set(u, (engineRequests.get(u) ?? 0) + 1); });
  await page.addInitScript(() => { /* MutationObserver: push 'nav' when a nav attaches, 'main' when a main attaches, into window.__order */ });
  await page.goto(`${baseURL ?? ''}/index.html#/traces`);
  await expect(page.getByRole('main').locator('output', { hasText: /\bspans\b/ })).toHaveText(new RegExp(`^${SPAN_COUNT} spans`));
  expect([...engineRequests.values()]).toEqual([1, 1, 1, 1]);
  expect(await page.evaluate(() => window.__order)).toEqual(['nav', 'main']);
  expect(problems).toEqual([]);
});
```

- [ ] **Step 2: Run** `mise run test:e2e:chromium -- e2e/engine-load.spec.ts` — expected: PASS in `chromium-file` and
  `chromium-http`. If `nav` is not the Sidebar's landmark, use the role it has (read `src/viewer/shell/sidebar.tsx`).
- [ ] **Step 3:** `pnpm exec biome check .`; commit: `test(e2e): engine files requested once, navigation before the page`.

### Task 6: Verify, measure, review, PR (coordinator)

- [ ] `mise run check`, then `timeout 900 mise run verify`.
- [ ] Measurements of spec §4 rows 1–3 with the session's bench scripts, before (main) and after (branch); put them
  in the PR body as a table.
- [ ] Branch review (Opus 5.5) with the whole diff and this plan; fix blocking findings; re-review.
- [ ] `gh pr create` with the title from the table; body: what changed per spec section, decisions, **Also**,
  measurements, the trailers. Merge on green CI (`--squash --delete-branch`).
- [ ] After the site deploys: spec §4 row 4 (live `branch/main/` at 50 Mbps / 40 ms RTT); record it with the
  plan's status line in a follow-up docs commit (`docs(plan): engine-start record`).

## Status (2026-11-21)

Done. PR #367 merged (squash 3379619e) after per-task reviews on Sonnet 5.5 and a whole-branch review on Opus 5.5
(two Important findings, fixed and re-reviewed: the shim released the wasm buffer only on a second fetch, and the
e2e navigation-before-page assertion could not fail). CI went green on a re-run: the Windows unit shard 2 failed once
in `test/scaling/generator.test.ts` ("the worker holding the lock died"), which the branch does not touch.

Spec §4 rows 1–3 are in the PR body (before → after, time to `main`: `local` at `file://` 1457 → 871 ms Chromium,
1307 → 852 Firefox, 1695 → 1253 WebKit; `site` loopback 754 → 749, 842 → 730, 1228 → 1351 (the one worse row, accepted
by the maintainer before the PR was opened); `ci` at 50 Mbps / 40 ms 4014 → 1948, 4069 → 1903, 4215 → 2396; Parquet
requests before `main` 20 → 1/6/6). Row 4, the live `branch/main/` page cold in Chromium after the deploy (two runs
each, before from spec §1):

| network             | engine phase   | `main` attached | engine files                                             | Parquet requests views → `main` |
| ------------------- | -------------- | --------------- | -------------------------------------------------------- | ------------------------------- |
| 50 Mbps / 40 ms RTT | 2.1 s → 1.68 s | 3.6 s → 2.57 s  | all four start at 120 ms, in parallel, once each; wasm done at 1.82 s | 19 → 7                          |
| 10 Mbps / 60 ms RTT | 7.9 s → 6.1 s  | — → 8.9 s       | wasm done at 8.0 s                                       | 19 → 7                          |
| no throttle         | 0.64–1.7 s → 0.52–1.15 s | — → 1.03–1.83 s | wasm 270 ms (edge hit) to 909 ms (miss)       | 19 → 7                          |

What remains on the throttled rows is the wasm download itself (7.66 MB gzipped) plus ~0.5 s to compile it; the
seven Parquet requests during the views phase are the range reads of the first files above 512 KiB.
