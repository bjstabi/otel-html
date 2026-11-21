# Faster report open: engine bytes handed to the worker, the shell during the load, fewer binding reads — design

Date: 2026-11-21. Status: maintainer handed the work over whole ("make all suggested improvements, unattended, one
PR"); the design calls below are the session's, recorded as such. Process: unattended
(`docs/agents/process-unattended.md`), one PR.

## 1. Intent

Opening a report shows a bare "Starting the query engine" line for most of the load. Measured on 2026-11-20/21
(Chromium unless said; `e2e/.reports/sample` and the live `branch/main/` CI report; the bench scripts lived in the
session scratchpad):

| where                                   | engine phase       | what it is                                                                   |
| --------------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `local` report at `file://`, dev machine | 1.16 s (FF 0.97, WK 1.5) | `instantiate` 0.8 s, of which **~0.47 s is the 46 MB base64 `data:` URL** the wasm is handed to the worker as; gunzip 80 ms; two extension `LOAD`s 160 ms |
| `site` report, localhost                | 0.49 s (FF 0.54, WK 1.4) | instantiate 0.32 s, extension `LOAD`s 130 ms                                     |
| live Pages, no throttle                 | 0.64–1.7 s         | the 7.7 MB gzipped wasm download (edge HIT vs MISS)                              |
| live Pages, 50 Mbps / 40 ms RTT         | 2.1 s              | wasm 1.6 s; **the four engine requests are serial** (worker → wasm → parquet ext → json ext) and start only once the viewer script has parsed (~0.3–0.4 s) |
| live Pages, 10 Mbps / 60 ms RTT         | 7.9 s              | wasm 6.6 s                                                                       |

After the engine, the "Preparing views" phase binds the five base views: DuckDB reads the footer of the **first file of
each `read_parquet` group** with a probe `GET bytes=0-0`, a `HEAD` and one or two range `GET`s, all serial through the
worker's synchronous XHR: 19 requests, 0.44 s on localhost, 1.1 s at 40 ms RTT, 1.6 s at 60 ms, before anything but
the loading line is on screen.

Mosaic is not involved in any of this: the coordinator is created after the views exist. duckdb-wasm's worker wraps
the fetched body in a `TransformStream` (for progress) before `instantiateStreaming`, so the browsers' wasm code cache
never applies; repeat loads re-compile. Nothing in this design changes that.

Spikes run for this design (all three Playwright browsers):

- `<link rel="preload">` for the engine files: Firefox 2.5 → 1.07 s, Chromium 2.5 → 1.87 s, **WebKit no gain and every
  file downloaded twice**; `as="worker"` is rejected by Chromium and Firefox. Rejected as the mechanism.
- Handing the wasm to the worker as a transferred `ArrayBuffer` served by a `fetch` override in the worker instead of
  a `data:` URL (`local` at `file://`): Chromium 1.25 → 0.76 s, Firefox 1.07 → 0.82 s, WebKit 1.50 → 1.17 s. Works in
  all three. Chosen.
- Handing `site`'s wasm over as a transferred body stream instead (tried 2026-11-21): ~370 ms slower in WebKit and
  ~55 ms slower in Chromium on loopback, ~150 ms faster in Chromium and Firefox at 50 Mbps, equal in WebKit; not
  adopted, the buffer is simpler and better on fast links.

## 2. Goals, non-goals, anti-goals

Goals

- A `local` report opens about 0.4–0.5 s sooner (no `data:` URL for the wasm).
- A `site` report starts downloading its engine files at time zero of the page, all four in parallel, each exactly
  once, and the extension `LOAD`s cost no further request.
- The report's navigation (sidebar, run card, theme) is on screen while the engine starts; the loading line sits where
  the page will be.
- Binding the base views costs no request for a group whose first file is small (the usual case: traces, points,
  patterns, cicd, logs); only a large first file (spans, typically) keeps its range reads.
- No change to the report format, the manifest, the public API or a CLI flag. No new dependency.

Non-goals

- Making the wasm smaller (the Pages host gzips to 7.7 MB; Brotli is not available there), caching compiled code
  (duckdb-wasm's `TransformStream` wrapper prevents it), or changing the DuckDB-WASM version.
- Rendering a page's content before its data source exists; pages still wait for the data source.
- The `host` page (`otel-html host`): it starts no engine and is untouched beyond compiling.

Anti-goals

- A `site` report that downloads an engine file twice (the preload spike's WebKit behaviour), or that opens offline
  worse than today (`e2e/offline.spec.ts` must stay green).
- A `local` report that works in Chromium only: the hand-off is verified in Firefox and WebKit too (the spike did;
  the e2e matrix does on every push).
- An e2e suite whose "report loaded" heuristic (`e2e/test.ts`: a `main` in the DOM) fires early because the shell
  renders a `main` before the data source is ready.

## 3. Design

### 3.1 Engine bytes handed to the worker (both formats)

`src/viewer/data/engine/start.ts` keeps its contract (`startEngine(engine, deps): Promise<Engine>`, the
`viewer.engine.start` span around it, D13 errors naming the file) and changes how the bytes reach DuckDB:

- **The worker is always created from a blob**: a shim script followed by the worker script's bytes (today only
  `local` does this). The shim does three things in the worker, before duckdb-wasm's code runs:
  1. `self.addEventListener('message', …, true)` catches the one hand-off message `{ __oh: { wasm: ArrayBuffer } }`,
     stops its propagation (`stopImmediatePropagation`, so duckdb-wasm's own handler never sees it) and resolves a
     promise with the buffer.
  2. Overrides `self.fetch` so that a request for `EMBEDDED_HOST + 'duckdb.wasm'` resolves to
     `new Response(buffer, { headers: { 'content-type': 'application/wasm', 'content-length': … } })` once the
     hand-off arrived; any other request passes through. duckdb-wasm's `instantiateWasm` fetches this URL and runs
     `instantiateStreaming` over it, as it does today over a network response.
  3. Keeps today's `XMLHttpRequest.prototype.open` rewrite for the two extensions (`EMBEDDED_HOST + <ext>` → a
     `data:application/wasm;base64,…` URL; anything else there → `data:,`). The extensions are 0.7 and 0.2 MB, so
     the base64 detour costs about 15 ms and is kept for both formats.
- `db.instantiate(EMBEDDED_HOST + 'duckdb.wasm')` after `worker.postMessage({ __oh: { wasm } }, [wasm])` (the buffer
  is transferred, not copied).
- **`local`**: the four base64 wrappers (`wasm.gz`, `worker`, two extensions) are loaded **concurrently** through the
  script loader (today: strictly in sequence), gunzipped where gzipped, and the wasm bytes are kept as bytes (no
  `toBase64`). The `data:` URL and its `null`ing go.
- **`site`**: the worker script, the wasm and the two extensions are fetched **concurrently** on the main thread with
  `fetch(url)` → `arrayBuffer()`; a non-OK response or a network error becomes the D13 `invalid-report` error naming
  the file. Where `index.html` already started the fetch (3.2), the viewer awaits that promise instead; a prefetch
  that rejected is retried once by the viewer's own fetch, so the error path and the message stay the viewer's.
  `db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true } })` stays for `site`. Extensions are
  `LOAD`ed through the shim for both formats; the extension repositories point at `EMBEDDED_HOST + 'no-extensions'`
  for both (the shim answers `data:,`, DuckDB reports a clean load error; `e2e/offline.spec.ts` covers it).
- `startLocal`/`startSite` collapse into one path with a `bytes` step per format. `engineUrls`/`extensionUrls`
  stay exported (tests and `files.ts` use them).

### 3.2 Early prefetch from `index.html` (`site` only)

`renderIndexHtml(entry, title, opts)` gains `opts.format?: 'local' | 'site'`. With `'site'` it writes, right after
the `__OH__` bootstrap line and before `data/manifest.js`, one inline script:

```html
<script>__OH__.pre={};for(const u of ["assets/duckdb.1.32.0.worker.js","assets/duckdb.1.32.0.wasm","assets/parquet.1.32.0.duckdb_extension.wasm","assets/json.1.32.0.duckdb_extension.wasm"])__OH__.pre[u]=fetch(u).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.arrayBuffer()});__OH__.pre[u]?.catch(()=>{});</script>
```

(the exact text is the implementer's, with the hrefs built by `assetUrl(…)` under `assetsBase`, escaped as the other
hrefs are; the `.catch(() => {})` is a second consumer that stops an unhandled-rejection report, the promise itself
stays rejected for the viewer to see). The hrefs are the page-relative strings `engineAssetNames('site')` gives, under
`assetsBase`; the viewer looks them up by the same strings (`engine.assetsBase + name`), which is what
`engineUrls`/`extensionUrls` resolve today.

`installRegistry` carries `pre` over from the bootstrap object (`Registry.prefetched(href): Promise<ArrayBuffer> |
undefined`); `main.tsx` passes it to `openReportRefreshable` as a dep. With `'local'` or no `format` nothing is written
(a `file://` page cannot fetch). Call sites pass the manifest's `engine.format`: `src/writer/partition-session.ts`,
`src/writer/upgrade.ts`, `src/cli/ci/run-report.ts`, `src/cli/ci/main-report.ts`. `src/host/server.ts` passes
nothing (no engine in a hosted page). `index.html` is not part of the report format (the manifest and partitions
are); a report written by an older version simply has no prefetch block and loads as today.

### 3.3 The shell during the load

- `LoadProgress` gains `manifest?: ManifestV4`, set on the first progress event (`engine` or `host`), right after
  the manifest validated. `openReportRefreshable` sends it.
- `App` keeps `Load` but its `loading` state carries the manifest once known. Until then it renders today's bare
  status line. Once the manifest is known it renders `<Shell manifest={…} dataSource={null} loading={progress}
  history={…} />`; when ready, `<Shell manifest={ds.manifest} dataSource={ds} … />` as today (a `key` is not
  needed: the same `Shell` instance keeps its selection store, so the URL state parsed at mount is kept).
- `Shell` takes `manifest: ManifestV4` and `dataSource: DataSource | null` (plus `loading?: LoadProgress`). Everything
  it builds from `dataSource.manifest` today builds from `manifest`. Where it renders `RoutedPage`, with `dataSource`
  null it renders the loading line instead: `<p role="status" aria-label="Loading the report" …>{progressText}</p>`,
  **not** inside a `main` (the e2e heuristic in `e2e/test.ts` waits for a `main`; the comment there is updated to say
  the nav may be visible before it). `progressText` moves next to it (from `app.tsx`).
- `Root` applies the report's theme from the first progress carrying a manifest, so the shell appears in the right
  theme; the existing "set once loaded" stays as the fallback.
- The `failed` state is unchanged (the `LoadFailure` alert in a `main`).

### 3.4 Fewer binding reads (`site` only)

`createViews` binds each base view by reading the first file of each `read_parquet` group. Before it runs, the files
that binding will read are fetched whole and swapped in as buffers through the existing `SmallFiles.prepare` (files
at or under `SMALL_FILE_BYTES`, six in flight at a time, failures leave the URL registration and its range reads):

- `src/query/sql/views.ts` exports `viewBindingFiles(manifest, set, resolve)`: the first file of each group a view
  statement of `set` reads, in statement order (for `traces`, the first file with `serviceShare` and the first without,
  when each group exists). Unit-tested against `viewStatements`: every returned path is the first path of a
  `read_parquet([...])` list in the statements.
- `openReportRefreshable` creates the `SmallFiles` instance before registering partitions (it needs only the engine
  and the manifest's sizes) and passes `small.prepare(viewBindingFiles(manifest, 'base', p => p))` to
  `registerPartitions`, which awaits it between `registerFiles` and `createViews`. The prepared buffers are also the
  ones the first queries read. For `local` nothing changes (every file is a buffer already).
- `refreshReport` already recreates the views over the new manifest; it gets the same prepare step for the new
  manifest's binding files when it has a `smallFiles` (one line; the implementer checks the existing refresh tests).

## 4. Measurements the PR body carries

From the session's bench harness (the coordinator runs it; the scripts are in the scratchpad and the method is: a
`MutationObserver` records when the loading line's phases appear and when a `main` attaches), before and after, on
the dev machine, Chromium / Firefox / WebKit:

1. `e2e/.reports/sample` at `file://`: engine phase and time to `main`.
2. `e2e/.reports-site/sample` over localhost: engine phase and time to `main`.
3. `e2e/.reports-site/ci` over the throttled local server (40 ms latency, 50 Mbps, the wasm counted at its gzipped
   7.66 MB): engine phase, time to `main`, number of requests per engine file (expected exactly 1 each), number of
   Parquet requests between "Preparing views" and `main` (expected: only the large first files' range reads).
4. After the merge deploys: the live `branch/main/` page cold at 50 Mbps / 40 ms RTT (today 2.1 s engine, 3.6 s to
   `main`); the maintainer asked for this measurement specifically.

Expectation: `local` engine phase down by ≥ 0.35 s in Chromium; `site` at 50 Mbps / 40 ms down by ≥ 0.7 s; the nav
visible within ~0.4 s of navigation on localhost. A result worse than today on any row is a stop (process rule).

## 5. Tests

- `test/writer/html.test.ts`: `format: 'site'` writes the prefetch block with the four hrefs under `assetsBase`, before
  `data/manifest.js`; `'local'`/absent writes none; hrefs are escaped. Call-site tests that compare `index.html` text
  (`test/writer/local-format.test.ts`, `partition-session`, `upgrade`, `test/cli/ci/*`) pass the format where they
  render the expected text.
- `test/viewer-data/engine-start.test.ts`: the fake `AsyncDuckDB` sees `instantiate(EMBEDDED_HOST + 'duckdb.wasm')`;
  the fake `Worker` (from `deps.createWorker`) records one `postMessage` whose `__oh.wasm` holds the gunzipped bytes
  and whose transfer list holds the same buffer; `site` fetches the four URLs (a fake `fetch` dep) concurrently and
  uses a provided prefetched promise instead of fetching; a rejected prefetch falls back to one fetch; a 404 on any
  file is the D13 error naming it; the shim text has the message listener, the `fetch` override and the XHR rewrite
  (a `new Function` smoke test as today's `extensionShim` test does, if one exists).
- `test/viewer-data/registry` (or where `installRegistry` is tested): `pre` is carried over.
- `test/query/sql/views.test.ts`: `viewBindingFiles`.
- `test/viewer/open-report.test.ts`: `prepare` is called with the binding files before the views are created (order
  of the fake parts' calls); `local` calls none.
- `test/viewer/root.test.tsx` and `test/viewer/shell.test.tsx`: the shell (nav) renders once progress carries a
  manifest, with the loading line and no `main`; the page renders when the data source arrives; the theme applies
  from the first progress.
- e2e, new `e2e/engine-load.spec.ts` (HTTP tag, so it runs over http; it also runs at `file://` and asserts only what
  holds there): over http, the server's request log (`/__requests`, as `scale.spec.ts` reads it) shows each of the
  four engine files requested exactly once for one page load; the navigation (`nav`) is attached before `main` is
  (a `MutationObserver` installed with `addInitScript` records the order, as the bench did); no console error, no
  failed request (as `smoke.spec.ts` checks).
- Existing: `offline.spec.ts`, `otel.spec.ts` (`viewer.engine.start` span), `smoke.spec.ts`, `refresh.spec.ts`
  unchanged and green.

## 6. Constraints and decisions

- No change under `.github/`; `src/cli/ci/run-report.ts` and `main-report.ts` change only the `renderIndexHtml`
  call (the deployer regenerates `index.html` when its text differs, so the next deploy picks the block up).
- `src/viewer/data/engine/start.ts` keeps `engineUrls`, `extensionUrls`, `extensionShim` (extended) exported.
- README: one sentence in the viewer section saying the navigation shows while the engine starts, and that a `site`
  page starts the engine downloads from its first bytes.
- Decisions made by the session (the maintainer opted out of the design conversation): the hand-off message shape,
  the blob worker for `site`, `data:` URLs kept for the extensions, the loading line's placement, the binding-files
  prepare instead of a DuckDB `schema=` hint (untested, and the footers are needed by the first query anyway).
