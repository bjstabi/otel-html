# The page before the engine, and engine files from the browser's cache storage — design

Date: 2026-11-21. Status: the maintainer approved the proposal in chat ("Yes approved unattended but use one pr for
all changes") after asking for the page to render first with the engine starting in the background, and after the
reload finding below; the design calls are the session's, recorded as such. Process: unattended
(`docs/agents/process-unattended.md`), one PR. Follows the engine-start project
(`2026-11-21-engine-start-latency-design.md`, PR #367).

## 1. Intent

Two things remain after PR #367, measured 2026-11-21 (the bench scripts lived in the session scratchpad; the method
is a `MutationObserver` on the loading line's phases and on the first `main`, plus Playwright's request log):

**A plain reload downloads the engine again in Chromium and WebKit.** A `site` page's inline prefetch uses
`fetch()`; on a reload those browsers re-request every `fetch()`ed subresource in full (no `If-None-Match`), while
`<script src>` comes from the HTTP cache. Firefox serves the fetch from its cache. `fetch(url, { cache:
'force-cache' })` does not change this. On the live `branch/main/` page:

| reload                 | engine line shown | `main` attached | wasm (7.66 MB gzipped)     |
| ---------------------- | ----------------- | --------------- | -------------------------- |
| Chromium, 50 Mbps/40 ms | 1.83 s            | 2.06 s          | downloaded again (1.4 s)   |
| Firefox, no throttle   | 0.46 s            | 0.88 s          | from the HTTP cache        |
| WebKit, no throttle    | 0.9–1.3 s         | 1.45–1.85 s     | downloaded again           |

Storing the engine files in the Cache API (`caches.open(name)`, `match`, `put`) from the inline prefetch fixes it:
on a local copy of the site with Pages' headers, a Chromium reload at 50 Mbps went from 2.06 s to 0.65 s to `main`
with no engine request; WebKit serves the reload from that cache too in a persistent profile over https (what a real
Safari has); Firefox is unchanged. A hard reload benefits as well (it bypasses the HTTP cache only). Measured costs: the
engine files decoded are 34 MB (wasm) + 4 MB per engine version in the origin's storage; a `put` during a Firefox
cold load cost about 150 ms; `caches` is undefined in insecure contexts, and WebKit's ephemeral contexts
(Playwright's default, a private window) accept `put` but hold nothing across a reload. (Correction 2026-11-21, after
the build: all three browsers treat `http://127.0.0.1` as a secure context, WebKit included; the earlier reading that
WebKit does not was wrong, see the plan's Status section.)

**Under the download there is a floor no cache removes**: DuckDB's instantiate, `open` and the two extension `LOAD`s,
about 0.5 s in Chromium and Firefox and about 1 s in WebKit on loopback. The "Starting the query engine" line stays on
screen for at least that long on every visit. The maintainer asked for the page to render first, with the engine
starting in the background and the widgets showing a loading animation. The viewer is built for it: `DataSource` is
all async methods plus `manifest` and `epoch`; `useQuery` keys on the data-source object and aborts on a swap; every
page and widget already has a loading state (`LoadingNote`, `QueryNote`, `aria-busy`).

## 2. Goals, non-goals, anti-goals

Goals

- A reload (plain or hard) of a `site` page in Chromium, Firefox and Safari makes no request for an engine file once
  the page has loaded once in that browser profile; a first visit stores them without slowing itself down.
- The page (navigation, header, filter bar, widget frames or list frame) is on screen as soon as the manifest is read,
  in every format; each query shows its loading note until the engine answers; one line names the load phase until the
  data is ready.
- The loading notes animate (and stop under `prefers-reduced-motion`).
- No change to the report format, the manifest, the public API or a CLI flag. No new dependency.

Non-goals

- Making the wasm smaller, compiling it ahead (a compiled-`Module` hand-off saved 50–70 ms in the spike), a service
  worker, or changing the DuckDB-WASM version.
- `local` reports and the Cache API: a `file://` page has no `caches`, and its engine is embedded; the page-first
  render applies to every format, the cache only to `site`.
- Rendering query results before the engine exists, or a skeleton that mimics the data.

Anti-goals

- A page that starts queries twice because the data source changed identity when the engine became ready.
- Widgets that show an error for a failed engine start: the load-failure page replaces the shell, as today.
- An e2e suite whose "report loaded" heuristic fires on the page frame before the data is ready (`e2e/test.ts` today
  waits for a `main`, which the page-first render attaches early).
- A `site` page that behaves worse than today where the Cache API is unavailable, refuses (quota, private window) or
  is slow: every cache step is optional and falls back to today's fetch.
- Storage that grows with each engine version: caches of other versions are deleted.

## 3. Design

### 3.1 Engine files through the Cache API (`site` `index.html`)

`renderIndexHtml` with `format: 'site'` keeps writing one inline script after the `__OH__` bootstrap and before
`data/manifest.js`, with the same contract to the viewer (`__OH__.pre[href]: Promise<ArrayBuffer>` for each of the
four hrefs under `assetsBase`, each promise given a `.catch(() => {})` as a second consumer) and one addition,
`__OH__.store: () => Promise<void>`. The script:

- Opens one cache named `oh-engine-<ENGINE_VERSION>` (`oh-engine-1.32.0` today; the name is written by
  `renderIndexHtml` from `ENGINE_VERSION`): `typeof caches !== 'undefined' ? caches.open(name).catch(() => null) :
  Promise.resolve(null)`. A null cache means "no cache" for everything below.
- For each href: `cache.match(href, { ignoreVary: true })` (a failure counts as a miss; `ignoreVary` so a `Vary:
  Accept-Encoding` on the stored response cannot make a lookup miss); a hit resolves with `hit.arrayBuffer()` (the
  Cache API stores the decoded body, 34 MB for the wasm); a miss runs today's `fetch(href)` → non-OK throws `HTTP
  <status>` → `arrayBuffer()`, and, with a cache, keeps `response.clone()` in a list of pending stores. The lookup is
  serial before the fetch (an eager fetch would download on every reload). The keys are the page-relative hrefs, which
  the Cache API resolves against the page's URL (`…/branch/main/` and `…/branch/main/index.html` resolve the same; the
  page URL's hash is not part of a key; `assetsBase` is always relative, `ASSETS_BASE_RE`): two reports sharing an
  `assetsBase` share the entries; a report with its own `assets/` has its own.
- `__OH__.store()` puts every pending clone (`cache.put(href, clone)`), then deletes every cache whose name starts
  with `oh-engine-` and is not this one (`caches.keys()` → `caches.delete`), and resolves; every failure (quota, a
  refused put, no cache) is swallowed. It is idempotent (the list is emptied once taken). A `put` stores a body only
  whole (a stream that fails rejects the put), and the file names carry the engine version, so an entry's bytes never
  go stale under their name.
- `__OH__.drop()` deletes this version's cache (`caches.delete(name)`, failures swallowed) and resolves: the way out
  of an entry that somehow cannot start the engine, so the next reload fetches afresh.

The viewer calls it once the load is done, so the writes never compete with the download, the instantiate or the
partition reads: `Registry` gains `storeEngine(): void` and `dropEngine(): void`, which call `boot.store?.()` and
`boot.drop?.()` and ignore their results; `main.tsx` calls `registry.storeEngine()` after `openReportRefreshable`
resolves and `registry.dropEngine()` when it rejects (a failed load for any reason: the cost of a wrong drop is one
download on the next visit). The cloned responses hold their bodies in memory until the store (about 38 MB, released
by the put).

A `site` page written by an older version has no `__OH__.store` or `drop`; the registry's calls are no-ops. A report served by
`otel-html host` has no prefetch block and no engine. Entries of other report paths on the same origin are not
purged (a bounded cost: one set per distinct assets folder visited; the live site has one shared folder).

### 3.2 The page before the engine: a pending data source

`src/viewer/data/pending-source.ts` exports `pendingDataSource(manifest: ManifestV4, ready: Promise<DataSource>):
DataSource`: `manifest` and `epoch` (`BigInt(manifest.epochUnixNano)`) are synchronous; every method of `DataSource`
(the `MetricMethods` included; the object literal is typed `DataSource`, so the compiler lists them) awaits `ready`
and delegates the same arguments to the real data source. If an `AbortSignal` among the arguments is already aborted
when `ready` resolves, the call rejects with a `DOMException` named `AbortError` instead of running the query. A
rejected `ready` rejects every call with its error. `close()` delegates too.

The manifest the first progress carries is the object `openReportRefreshable` validated and passes to
`createSource` (and `tracedDataSource` spreads it unchanged), so the pending source's `manifest` and `epoch` are the
real source's; a Refresh replaces the shown data source with one over the new manifest as today, and `Shell` keeps
taking `manifest` from the shown data source.

`App` builds it when the first progress carries the manifest: the load's promise is created once per effect, `ready`
is `opened.then(o => o.dataSource)` (given a `.catch(() => {})` so a failed load has a consumer before any page asks),
and the `loading` state carries `pending: DataSource | null` instead of `manifest`. The `ready` state keeps the pending
data source as the shown one when there is one (`dataSource: s.pending ?? opened.dataSource`): the data source's
identity does not change when the engine becomes ready, so `useQuery` does not abort and re-run the first queries;
they simply resolve. A Refresh (D55) replaces the shown data source as today, and as today nothing closes the data source it replaced
(the engine is shared). `close()` is called only where it is today: `App`'s unmount-mid-load path closes
`opened.dataSource`, the real one; the pending wrapper is never closed by the viewer. The Refresh control stays null
until ready (the in-progress line already renders without controls then; the button appears at ready, no placeholder).
`Shell` takes `dataSource: DataSource` (never null now) and `loading?: LoadProgress | null`; it renders `RoutedPage`
whenever it renders, and, while `loading` is set, the loading line (3.3). `App`'s `failed` state still replaces the shell with
`LoadFailure`; the pending calls reject afterwards into aborted or unmounted consumers. `Root` keeps applying the
theme from the first progress. The `host` page (`phase: 'host'`) goes through the same path and is ready at once.

Spans: `viewer.load` is unchanged; a query made while pending gets its `viewer.query.*` span from the traced real
source once it runs, so the wait for the engine is not inside the query span (the load span covers it).

### 3.3 The loading line and the loading notes

`LoadingLine` keeps `role="status"`, `aria-label="Loading the report"` and the phase texts (`Loading report`,
`Starting the query engine`, `Loading partition N of M`, `Preparing views`, `Connecting to the host`), and gets two
placements: bare (before the manifest, as today, a `p` with `p-8`) and, inside the shell, a pill fixed at the bottom
centre of the viewport, out of the flow (`fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full border
border-hairline bg-surface px-3 py-1.5 text-sm text-muted shadow`), rendered by `Shell` while `loading` is set and
removed when the data is ready: nothing in the page moves when it leaves (the dashboard specs measure widget
positions). It is never inside a `main`. Both placements show the loading indicator below.

`LoadingNote` (widgets and explorers) and `QueryNote`'s loading line get an inline indicator before the word: a small
element with no text (a spinner of `border` + `animate-spin`, or pulsing dots as empty spans with `animate-pulse`;
the builder's choice), `aria-hidden`, stopped under `prefers-reduced-motion` (`motion-reduce:animate-none`). The
note's text content stays exactly `Loading` (the scale spec reads `textContent` with `/^(Loading|…)/`, unit tests
use `getByText('Loading')`) and its height stays one `text-sm` line (`LOADING_NOTE_PX` in `widgets/traces.tsx` and
`NOTE_PX` in `facet-chart.tsx` subtract it from the widget's body). `Loading metrics`, `Loading services` and
`Loading variables…` are left as they are.

### 3.4 The e2e "report loaded" heuristic

`waitForReportLoaded` in `e2e/test.ts` waits for a `main` to be attached **and then** for
`[aria-label="Loading the report"]` to be detached (both within `REPORT_LOAD_TIMEOUT_MS`): the page frame attaches
early now, the line leaves when the data is ready, and the load-failure page is a `main` without the line. There is
no race: the line is in the DOM exactly while the data is pending, and it is committed together with the first `main`
(before the manifest the bare line shows and there is no `main`); a `host` page (`e2e/host.spec.ts`) is ready in the
same tick and shows it for a frame at most. The comment
there is updated. `e2e/engine-load.spec.ts`'s order check becomes: `main` is attached while the loading line is still
in the DOM (the page before the engine), and the line is gone by the time the span count shows. The spec gains a
reload check (3.1): after `page.reload()` on the `-http` project, once the cache holds the four files, the engine
files have no new request (the request count per file stays 1). Only Chromium has an `-http` project
(`playwright.config.ts`), so the check runs there; Firefox and WebKit reloads are measured by the bench instead. `e2e/scale.spec.ts`'s settled checks read `[role="status"]` text
inside the widget frames and are unaffected; the loading bar sits outside the frames.

## 4. Measurements the PR body carries

Before and after, Chromium unless said, from the session's bench harness:

1. `e2e/.reports-site/sample` over localhost: time to `main` attached (expected: within ~0.4 s of navigation, before
   the engine phase ends), time to the loading line gone (the data-ready mark; expected unchanged within ±100 ms), the
   engine phase itself (unchanged).
2. The same page reloaded (Chromium and Firefox over http; WebKit over https with a persistent profile): requests for
   engine files on the reload (expected 0 with the cache; today 4 in Chromium and WebKit) and time to data ready.
3. `e2e/.reports-site/ci` over the throttled local server (40 ms / 50 Mbps): cold load to data ready unchanged
   (±100 ms, the serial `caches.open` + `match` before each fetch is the only addition), reload to data ready
   (expected under 1 s; today ~2.1 s).
4. After the merge deploys: the live `branch/main/` page cold and reloaded at 50 Mbps / 40 ms in Chromium (today
   reload: line 1.83 s, `main` 2.06 s, wasm downloaded again).

A cold load worse than today on any row is a stop (process rule).

## 5. Tests

- `test/writer/html.test.ts`: the block names `oh-engine-<ENGINE_VERSION>` and defines `__OH__.store`; run in a `vm`
  context with a fake `caches` and `fetch`: a hit resolves from the cache without a fetch; a miss fetches and
  `store()` puts it; `store()` deletes `oh-engine-0.0.0` and keeps the current cache; no `caches` → fetch only and
  `store()` resolves; `caches.open` or `put` rejecting → fetch path, `store()` resolves; a non-OK miss rejects `HTTP
  404`. Existing assertions (position before `data/manifest.js`, hrefs under `assetsBase`, none for `local`) stay.
- `test/viewer/registry.test.ts`: `storeEngine()` and `dropEngine()` call the bootstrap's `store`/`drop` once;
  without them they are no-ops.
- `test/viewer/pending-source.test.ts`: `manifest`/`epoch` synchronous; a call made before `ready` resolves after it
  with the real result and the same arguments; a signal aborted before `ready` makes the call reject with
  `AbortError` and the real method is not called; a rejected `ready` rejects the call; every `DataSource` method is
  covered by iterating the keys of a fake whose every method records its name.
- `test/viewer/root.test.tsx`: once a progress carries the manifest, `Shell` gets a non-null `dataSource` and the
  progress; when the load resolves, `Shell` gets the same `dataSource` object and no `loading`; a load that resolves
  before any manifest progress passes its own data source; a failed load still shows `LoadFailure`. `test/viewer/shell.test.tsx`: with `loading` set, the
  navigation, the loading pill (`status`, "Starting the query engine") and the page's `main` are all present; without
  `loading` the pill is gone.
- `test/viewer/explorer-states.test.tsx` (new or where `LoadingNote` is tested): the note's text is `Loading`, the
  indicator is `aria-hidden`.
- e2e: `engine-load.spec.ts` as in 3.4. `offline.spec.ts`, `otel.spec.ts`, `smoke.spec.ts`, `refresh.spec.ts`,
  `scale.spec.ts` unchanged and green.

## 6. Constraints and decisions

- Nothing under `.github/` changes; the `renderIndexHtml` call sites are unchanged (the block is generated inside).
- README (the "Report layout and hosting" bullet that says the navigation shows while the engine starts): the page
  renders as soon as the manifest is read, with a loading note per query and a line naming the phase; a `site`
  page keeps the engine files in the browser's cache storage (about 40 MB per engine version, older versions
  removed) so a reload does not download them again.
- Decisions made by the session: the Cache API over a service worker (no registration, no lifecycle, one inline
  script); storing after the load instead of during the download (the Firefox cost); one cache per engine version
  purged by name, entries of other report paths kept; the pending data source kept as the session's data source (no
  identity change at ready); the phase line as a fixed pill at the bottom of the viewport (no layout shift when it leaves); an inline indicator
  that keeps the note's height; `drop()` on any failed load.
