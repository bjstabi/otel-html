# The page before the engine — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `site` page's reload serves the engine files from the browser's cache storage instead of downloading them
again, and every report renders its page as soon as the manifest is read, with the queries waiting for the engine
behind the widgets' loading notes.

**Architecture:** The inline prefetch in `index.html` looks each engine file up in a Cache API cache named by the engine
version before fetching it, and exposes `__OH__.store()`/`__OH__.drop()` that the viewer calls after the load. `App`
hands the shell a pending `DataSource` (every method awaits the real one) as soon as a progress event carries the
manifest, and keeps that object as the shown data source when the load resolves, so the first queries run once. The
loading line becomes a pill fixed at the bottom of the viewport while the data is pending, and the loading notes get
an animated indicator.

**Tech Stack:** TypeScript (strict), React 19, Tailwind 4, @duckdb/duckdb-wasm 1.32.0 (unchanged), vitest, Playwright,
mise.

**Spec:** `docs/superpowers/specs/2026-11-21-page-before-engine-design.md`. The spec wins where they differ.

**PR process:** unattended (`docs/agents/process-unattended.md`), one PR.

| #   | branch              | PR title                                                                                         | status |
| --- | ------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 1   | `perf/page-before-engine` | `perf(viewer): the page renders before the engine starts, and a site keeps the engine files in cache storage` | built; stopped before the PR on the WebKit loopback reload row (see Status) |

- **Models.** Implementers and task reviewers run on Sonnet 5.5. The branch review runs on Opus 5.5.
- **Bugs found on the way** are fixed in this PR and listed under **Also** in its body.
- **Write-token files.** Nothing under `.github/` changes; no `src/cli/ci/*` change is expected (the prefetch block
  is generated inside `renderIndexHtml`). Any such change is a stop.
- **Commits** end with the session's trailers (`Co-Authored-By`, `Claude-Session`). Commitlint: subject ≤ 100 chars,
  body lines ≤ 100 chars.

## Global Constraints

- No change to the manifest, the partition files, the public API (`src/api/index.ts`) or any CLI flag. No new
  dependency. `@duckdb/duckdb-wasm` stays at 1.32.0.
- The cache name is `oh-engine-${ENGINE_VERSION}` (`oh-engine-1.32.0` today), written by `renderIndexHtml` from
  `ENGINE_VERSION` in `src/format/engine.ts`. The inline script's contract to the viewer: `__OH__.pre[href]:
  Promise<ArrayBuffer>` for each href (each with a `.catch(() => {})` consumer), `__OH__.store(): Promise<void>`,
  `__OH__.drop(): Promise<void>`; both resolve whatever happens.
- `cache.match(href, { ignoreVary: true })`. The lookup precedes the fetch (never both in parallel).
- The loading line keeps `role="status"` and `aria-label="Loading the report"`, is never inside a `main`, and keeps
  its texts: `Loading report`, `Starting the query engine`, `Loading partition N of M`, `Preparing views`,
  `Connecting to the host`.
- `LoadingNote`'s and `QueryNote`'s text content stays exactly `Loading`; the indicator carries no text, is
  `aria-hidden`, and keeps the note one `text-sm` line tall.
- The shown data source's identity does not change when the load resolves (no second run of the first queries).
- The `viewer.load`, `viewer.engine.start` and `viewer.partitions.register` spans keep their names and nesting.
- Strict TypeScript as `tsconfig.base.json`; Biome at error. Before each commit: `pnpm exec biome check .` and
  `mise run typecheck`; `mise run check` after each task; `mise run verify` before the PR.
- The wait-loop rule of AGENTS.md: no `pgrep -f`/`pkill -f` loops; long commands in the foreground with a timeout.

## Review Focus

1. A browser without `caches` (an insecure context, `file://`), or whose `caches.open`/`match`/`put` rejects (a
   private window, quota): the page must load exactly as today and `store()`/`drop()` must resolve. (Task 1 tests
   all three.)
2. A query started while the engine is pending whose consumer goes away (navigation, a filter change): the pending
   source must not run it once the engine is ready. (Task 3 tests the aborted signal.)
3. A load that fails after the shell rendered (a missing partition file): `LoadFailure` must replace the shell and no
   widget error must be the last thing on screen; the cache is dropped. (Task 4 tests the failure after a manifest
   progress; Task 2 tests `dropEngine` on rejection.)
4. The e2e "report loaded" wait on the load-failure page and the `host` page (no engine): `main` without the loading
   line must count as loaded, and must not hang. (Task 4 keeps `hostile.spec.ts` and `host.spec.ts` green and runs
   them.)
5. A reload in WebKit over `http://127.0.0.1` (no `caches`): the engine fetches as today and the e2e reload check
   skips the no-request assertion there. (Task 6.)

---

### Task 1: The inline prefetch through the Cache API

**Files:**
- Modify: `src/writer/html.ts` (the `pre` block, ~line 59; export a new `enginePrefetchScript`)
- Test: `test/writer/html.test.ts`

**Interfaces:**
- Produces: `export function enginePrefetchScript(hrefs: readonly string[], cacheName: string): string` — the body of
  the inline `<script>` (no tags). `renderIndexHtml` writes
  `<script>${enginePrefetchScript(hrefs, \`oh-engine-${ENGINE_VERSION}\`)}</script>\n` where it writes the block
  today, with the same hrefs (`base + name` for `engineAssetNames('site')`, raw strings via `JSON.stringify`).
- Produces (runtime, read by Task 2): `__OH__.pre`, `__OH__.store`, `__OH__.drop` as in Global Constraints.

- [ ] **Step 1: Write the failing tests**

Replace the first `renderIndexHtml` test's block assertions with tests of `enginePrefetchScript` run in a `vm`
context (`import { runInNewContext } from 'node:vm'`). A helper builds the context:

```ts
function run(script: string, env: { caches?: unknown; fetch: unknown }) {
  const ctx = { __OH__: { q: [], push() {} } as { pre?: Record<string, Promise<ArrayBuffer>>; store?: () => Promise<void>; drop?: () => Promise<void> }, Promise, Error, ...env };
  runInNewContext(script, ctx);
  return ctx.__OH__;
}
const HREFS = ['assets/duckdb.1.32.0.wasm', 'assets/duckdb.1.32.0.worker.js'];
const body = (n: number) => new Response(new Uint8Array([n]));
```

Tests (`describe('enginePrefetchScript')`), each building its own `cache = { match: vi.fn(), put: vi.fn(async () => undefined) }`
and `caches = { open: vi.fn(async () => cache), keys: vi.fn(async () => ['oh-engine-0.0.0', 'oh-engine-1.32.0', 'other']), delete: vi.fn(async () => true) }`:

- `a hit resolves from the cache without a fetch`: `cache.match` resolves `body(7)` for the wasm href and `undefined`
  for the worker; `fetch` resolves `body(9)` and is `vi.fn`. `await oh.pre[wasm]` is a 1-byte buffer `[7]`;
  `fetch` was called once, with the worker href only; `cache.match` was called with `(href, { ignoreVary: true })`.
- `a miss is fetched and stored by store()`: both miss; after awaiting both `pre` entries, `cache.put` not yet
  called; `await oh.store()`; `cache.put` called twice with `(href, Response)`; `caches.delete` called with
  `'oh-engine-0.0.0'` only (not the current name, not `'other'`); a second `await oh.store()` puts nothing more.
- `a non-OK miss rejects naming the status`: `fetch` resolves `new Response(null, { status: 404 })`;
  `await expect(oh.pre[wasm]).rejects.toThrow('HTTP 404')`; `cache.put` never called after `store()`.
- `no caches: fetch only, store and drop resolve`: context without `caches`; `pre` resolves from `fetch`;
  `await oh.store()` and `await oh.drop()` resolve.
- `a cache that cannot open, match or put is a miss and never fails`: `caches.open` rejecting → fetched, `store()`
  resolves; `match` rejecting → fetched; `put` rejecting → `store()` resolves.
- `drop() deletes this version's cache`: `await oh.drop()` → `caches.delete` called with `'oh-engine-1.32.0'`;
  with `caches.delete` rejecting it still resolves.
- `renderIndexHtml` (existing describe): `format: 'site'` embeds `enginePrefetchScript` with the four hrefs and
  `"oh-engine-1.32.0"` between the bootstrap and `data/manifest.js` (keep the existing position and `local` tests;
  assert `html` contains `enginePrefetchScript(hrefs, 'oh-engine-1.32.0')` verbatim).

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/writer/html.test.ts`
Expected: FAIL (`enginePrefetchScript` is not exported).

- [ ] **Step 3: Implement `enginePrefetchScript` and use it in `renderIndexHtml`**

Classic-script text (no modules; arrows and `const` are fine, today's block uses them). Reference body, the exact
text is the implementer's:

```js
(()=>{const n=<cacheName>,p=__OH__.pre={};let s=[];
const c=typeof caches==="undefined"?Promise.resolve(null):caches.open(n).catch(()=>null);
const get=u=>c.then(k=>(k?k.match(u,{ignoreVary:true}).catch(()=>undefined):Promise.resolve(undefined)).then(r=>r?r.arrayBuffer():fetch(u).then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);if(k)s.push([u,r.clone()]);return r.arrayBuffer()})));
for(const u of <hrefs>){p[u]=get(u);p[u].catch(()=>{})}
__OH__.store=()=>{const t=s;s=[];return c.then(k=>k&&Promise.allSettled(t.map(e=>k.put(e[0],e[1]))).then(()=>caches.keys()).then(ks=>Promise.allSettled(ks.filter(x=>x.startsWith("oh-engine-")&&x!==n).map(x=>caches.delete(x))))).then(()=>{},()=>{})};
__OH__.drop=()=>c.then(k=>k&&caches.delete(n)).then(()=>{},()=>{});})()
```

`<cacheName>` and `<hrefs>` are `JSON.stringify`ed. Update the comment above the block in `html.ts` (the cache, the
version-named cache, `store`/`drop` for the viewer).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run test/writer/html.test.ts`, then `pnpm exec vitest run test/writer test/cli` (call-site
tests compare `index.html` text through `renderIndexHtml`, so they should still pass unchanged).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/writer/html.ts test/writer/html.test.ts
git commit -m "feat(writer): a site's inline prefetch reads the engine files from cache storage"
```

---

### Task 2: The viewer stores or drops the cache after the load

**Files:**
- Modify: `src/viewer/data/registry.ts` (`OhGlobal`, `Registry`, `installRegistry`)
- Modify: `src/viewer/main.tsx` (`load`)
- Test: `test/viewer/registry.test.ts`

**Interfaces:**
- Consumes: `__OH__.store?: () => Promise<void>`, `__OH__.drop?: () => Promise<void>` (Task 1).
- Produces: `Registry.storeEngine(): void` and `Registry.dropEngine(): void`: call the bootstrap's `store`/`drop`
  once per call when present (captured at install, like `pre`), swallow their result and any throw; no-ops without
  them.

- [ ] **Step 1: Write the failing tests**

In `test/viewer/registry.test.ts`:

```ts
test('storeEngine and dropEngine call the bootstrap once; without them they are no-ops', async () => {
  const store = vi.fn(async () => undefined);
  const drop = vi.fn(async () => undefined);
  const registry = installRegistry({ __OH__: { q: [], push() {}, store, drop } } as unknown as Window);
  registry.storeEngine();
  registry.dropEngine();
  expect(store).toHaveBeenCalledOnce();
  expect(drop).toHaveBeenCalledOnce();
  const bare = installRegistry({ __OH__: { q: [], push() {} } } as unknown as Window);
  expect(() => bare.storeEngine()).not.toThrow();
  expect(() => bare.dropEngine()).not.toThrow();
  const throwing = installRegistry({ __OH__: { q: [], push() {}, store: () => Promise.reject(new Error('x')) } } as unknown as Window);
  expect(() => throwing.storeEngine()).not.toThrow();
  await Promise.resolve();
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm exec vitest run test/viewer/registry.test.ts`
Expected: FAIL (`storeEngine is not a function`).

- [ ] **Step 3: Implement**

`OhGlobal` gains `store?: () => Promise<void>` and `drop?: () => Promise<void>` (doc: "`site` reports: writes the
engine files the page fetched to cache storage / deletes that cache; the viewer calls them after the load"). In
`main.tsx`'s `load`:

```ts
return openReportRefreshable(…).then(
  (opened) => { registry.storeEngine(); return opened; },
  (error: unknown) => { registry.dropEngine(); throw error; },
);
```

with a comment: the store runs only after the load so it never competes with the download, the instantiate or the
partition reads; a failed load drops the cache so the next visit fetches afresh.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run test/viewer/registry.test.ts` and `mise run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/data/registry.ts src/viewer/main.tsx test/viewer/registry.test.ts
git commit -m "feat(viewer): the engine files are stored after the load and dropped after a failed one"
```

---

### Task 3: The pending data source

**Files:**
- Create: `src/viewer/data/pending-source.ts`
- Test: `test/viewer/pending-source.test.ts`

**Interfaces:**
- Produces: `export function pendingDataSource(manifest: ManifestV4, ready: Promise<DataSource>): DataSource`.
  `manifest` is the argument; `epoch` is `BigInt(manifest.epochUnixNano)`; every method (the `MetricMethods` too;
  the returned object literal is typed `DataSource`) does `ready.then(ds => …)` and calls the same method on `ds`
  with the same arguments, unless an `AbortSignal` among the arguments is already aborted, in which case it rejects
  with `new DOMException('<message>', 'AbortError')` and calls nothing. A rejected `ready` rejects every call.
  `close()` delegates.

- [ ] **Step 1: Write the failing tests**

`test/viewer/pending-source.test.ts`, using `baseManifest` and `dataSourceOf` from `./dashboard-shell.js` to list the
methods:

```ts
const METHODS = Object.entries(dataSourceOf(baseManifest)).filter(([, v]) => typeof v === 'function').map(([k]) => k) as (keyof DataSource)[];

test('manifest and epoch are synchronous', () => {
  const pending = pendingDataSource(baseManifest, new Promise(() => undefined));
  expect(pending.manifest).toBe(baseManifest);
  expect(pending.epoch).toBe(BigInt(baseManifest.epochUnixNano));
});

test('every method waits for the real data source and passes its arguments through', async () => {
  const calls: [string, unknown[]][] = [];
  const real = Object.fromEntries(METHODS.map((m) => [m, (...args: unknown[]) => { calls.push([m, args]); return Promise.resolve(`${m}-result`); }])) as unknown as DataSource;
  let resolve: (ds: DataSource) => void = () => undefined;
  const pending = pendingDataSource(baseManifest, new Promise((r) => { resolve = r; }));
  const results = METHODS.map((m) => (pending[m] as (...a: unknown[]) => Promise<unknown>)('a', 2));
  await Promise.resolve();
  expect(calls).toEqual([]);
  resolve(real);
  expect(await Promise.all(results)).toEqual(METHODS.map((m) => `${m}-result`));
  expect(calls).toEqual(METHODS.map((m) => [m, ['a', 2]]));
});

test('a signal aborted before the engine is ready skips the query', async () => {
  const querySpans = vi.fn();
  const controller = new AbortController();
  const pending = pendingDataSource(baseManifest, Promise.resolve({ ...dataSourceOf(baseManifest), querySpans } as DataSource));
  const call = pending.querySpans({} as SpanQuery, controller.signal);
  controller.abort();
  await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  expect(querySpans).not.toHaveBeenCalled();
});

test('a failed load rejects every call with its error', async () => {
  const pending = pendingDataSource(baseManifest, Promise.reject(new Error('engine: boom')));
  await expect(pending.services({ window: null, condition: null, limit: 1 })).rejects.toThrow('engine: boom');
});
```

(`SpanQuery` from `src/viewer/data/results.js`; the abort test's signal is aborted after the call, before the
`ready` microtask resolves: use `Promise.resolve(...)` for `ready` as written, the check happens in `then`.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/viewer/pending-source.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `pendingDataSource`**

A local helper keeps the literal short:

```ts
const after = <A extends unknown[], R>(call: (ds: DataSource, ...args: A) => Promise<R>) =>
  (...args: A): Promise<R> =>
    ready.then((ds) => {
      if (args.some((a) => a instanceof AbortSignal && a.aborted)) throw abandoned();
      return call(ds, ...args);
    });
```

then `querySpans: after((ds, q, signal) => ds.querySpans(q, signal))` and so on for every member of `DataSource`
and `MetricMethods` (`src/viewer/data/metric-results.ts`), `close: after((ds) => ds.close())`. Doc comment: what it is
for (the shell renders before the engine; `App` keeps it as the shown data source), the abort rule, the manifest
identity (the manifest the first progress carries is the one the real source gets).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run test/viewer/pending-source.test.ts` and `mise run typecheck`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/data/pending-source.ts test/viewer/pending-source.test.ts
git commit -m "feat(viewer): a pending data source whose queries wait for the engine"
```

---

### Task 4: The page renders before the engine

**Files:**
- Modify: `src/viewer/app.tsx` (`Load`, the load effect, the `loading`/`ready` renders)
- Modify: `src/viewer/shell/shell.tsx` (`Shell` props and render)
- Modify: `src/viewer/shell/loading-line.tsx` (`placement`)
- Modify: `e2e/test.ts` (`waitForReportLoaded` and its comment)
- Modify: `e2e/engine-load.spec.ts` (the order check)
- Test: `test/viewer/root.test.tsx`, `test/viewer/shell.test.tsx`

**Interfaces:**
- Consumes: `pendingDataSource` (Task 3).
- Produces: `Shell` props `{ manifest: ManifestV4; dataSource: DataSource; loading?: LoadProgress | null; history; refresh? }`;
  `LoadingLine` props `{ progress: LoadProgress | null; placement?: 'page' | 'pill' }` (default `'page'`).

- [ ] **Step 1: Write the failing tests**

`test/viewer/root.test.tsx`: the `Shell` mock records its props through `vi.hoisted`:

```ts
const seen = vi.hoisted(() => ({ props: [] as { dataSource: unknown; loading: unknown }[] }));
vi.mock('../../src/viewer/shell/shell.js', () => ({
  Shell: (props: { dataSource: unknown; loading?: unknown }): string => {
    seen.props.push({ dataSource: props.dataSource, loading: props.loading ?? null });
    return props.loading ? 'shell-loading' : 'shell';
  },
}));
```

In `the shell while the engine starts`, after `report({ phase: 'engine', manifest: manifest('dark') })`: the last
seen `dataSource` is not null, its `manifest` is that manifest, and `loading` is `{ phase: 'engine', manifest }`; after
`finish(dataSource('dark'))`: `shell` shows, the last seen `dataSource` is the same object as while loading (`toBe`),
`loading` is null. New tests in that describe:

- `a load that resolves before any manifest progress passes its own data source`: `load` resolves at once; the last
  seen `dataSource` is `opened.dataSource`.
- `a load that fails after the shell rendered shows the failure page`: `report({ phase: 'engine', manifest })`, then
  reject the load with `new Error('spans.parquet: missing')`; `await screen.findByText('This report could not be
  loaded')`; `shell-loading` is gone. Also: a query made on the pending source rejects with that error (call
  `(seen.props.at(-1).dataSource as DataSource).services(...)` before rejecting; `await expect(...).rejects`).

`test/viewer/shell.test.tsx` `while the engine starts`: render with `dataSource={dataSource}` and
`loading={{ phase: 'engine' }}`: `getByRole('navigation')`, `getByRole('status', { name: 'Loading the report' })`
has text `Starting the query engine`, `getByRole('main')` exists; rerender without `loading`: the status is gone,
`main` stays. (The test's `ui` helper takes `loading: LoadProgress | undefined`.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm exec vitest run test/viewer/root.test.tsx test/viewer/shell.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app.tsx`:
- `Load`'s loading state: `{ status: 'loading'; progress: LoadProgress | null; pending: DataSource | null }`.
- In the effect, before calling `load`: a deferred `ready` promise (`let settle: { resolve; reject }`), with
  `ready.catch(() => undefined)` as a consumer. `onProgress` sets `pending` to the existing one or, when
  `progress.manifest` is defined, `pendingDataSource(progress.manifest, ready)`. On resolve: `settle.resolve(opened.dataSource)`
  and `setState(s => ({ status: 'ready', dataSource: s.status === 'loading' && s.pending !== null ? s.pending : opened.dataSource, refresh: opened.refresh }))`;
  the unmounted-mid-load branch closes `opened.dataSource` as today. On reject: `settle.reject(e)` and the failed state.
- Render: `loading` with `pending === null` → `<LoadingLine progress={state.progress} />`; with a pending source →
  `<Shell manifest={pending.manifest} dataSource={pending} loading={state.progress} history refresh={null} />`;
  `ready` as today (no `loading`).
- Comments: why the identity is kept (`useQuery` keys on the object), why `ready` has a catch consumer.

`shell.tsx`: `dataSource: DataSource` (doc: "while the engine starts, a pending one whose queries wait for it") and
`loading?: LoadProgress | null` ("set while the data is pending: the loading pill shows"); always
`<RoutedPage dataSource={dataSource} />`; after the `flex min-h-screen` div (outside any `main`):
`{props.loading != null && <LoadingLine progress={props.loading} placement="pill" />}`.

`loading-line.tsx`: `placement` prop; `'page'` keeps today's classes; `'pill'` renders the same `p` with
`fixed bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-hairline bg-surface px-3 py-1.5 text-sm text-muted shadow`.
Update its doc comment (two placements; never a `main`; the e2e wait reads the `aria-label`).

`e2e/test.ts` `waitForReportLoaded`: after the `main` wait, `await page.locator('[aria-label="Loading the report"]').waitFor({ state: 'detached', timeout: REPORT_LOAD_TIMEOUT_MS }).catch(() => undefined)`;
rewrite the comment: the page frame attaches as soon as the manifest is read, the line (bare before the manifest, a
pill after) leaves when the data is ready, the failure page is a `main` without it.

`e2e/engine-load.spec.ts`: the init script records `'main-while-loading'` when the first `main` attaches with the
loading line present (`'main'` otherwise) and `'ready'` once a `main` exists and the line is gone; the expectation
becomes `['main-while-loading', 'ready']`; rename the test (`…the page shows before the engine is ready`).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run test/viewer/root.test.tsx test/viewer/shell.test.tsx`, then `mise run check`, then
`mise run test:e2e:chromium -- e2e/engine-load.spec.ts e2e/hostile.spec.ts e2e/host.spec.ts e2e/offline.spec.ts e2e/smoke.spec.ts`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/app.tsx src/viewer/shell/shell.tsx src/viewer/shell/loading-line.tsx e2e/test.ts e2e/engine-load.spec.ts test/viewer/root.test.tsx test/viewer/shell.test.tsx
git commit -m "perf(viewer): the page renders before the engine starts; the phase shows in a pill"
```

---

### Task 5: The loading indicator

**Files:**
- Modify: `src/viewer/components/explorer-states.tsx` (`LoadingNote`, `QueryNote`; a new `LoadingIndicator`)
- Modify: `src/viewer/shell/loading-line.tsx` (the indicator before the text)
- Test: `test/viewer/explorer-states.test.tsx` (new)

**Interfaces:**
- Produces: `export function LoadingIndicator(): JSX.Element` — an `aria-hidden` inline element with no text, e.g.
  `<span aria-hidden className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-hairline border-t-ink-2 align-[-2px] motion-reduce:animate-none" />`
  (the design or pulsing dots are the builder's; the constraints are in Global Constraints).

- [ ] **Step 1: Write the failing test**

```tsx
test('the loading note says Loading with a hidden indicator and nothing else', () => {
  render(<LoadingNote />);
  const note = screen.getByRole('status');
  expect(note.textContent).toBe('Loading');
  expect(screen.getByText('Loading')).toBe(note);
  const indicator = note.querySelector('[aria-hidden="true"]');
  expect(indicator?.className).toMatch(/animate-/);
  expect(indicator?.className).toMatch(/motion-reduce:animate-none/);
});
test('the query note while loading carries the indicator too', () => {
  render(<QueryNote loading residual={null} />);
  expect(screen.getByRole('status').querySelector('[aria-hidden="true"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm exec vitest run test/viewer/explorer-states.test.tsx`
Expected: FAIL (no indicator).

- [ ] **Step 3: Implement**

`LoadingIndicator` in `explorer-states.tsx`; `LoadingNote` and `QueryNote`'s loading `p` render it before the word;
`LoadingLine` (both placements) renders it before the phase text. The note's height must not change: check
`LOADING_NOTE_PX` in `src/viewer/dashboards/widgets/traces.tsx` and `NOTE_PX` in `widgets/facet-chart.tsx` still
match one `text-sm` line (an inline element of `size-3` with `align-[-2px]` does not grow the line).

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm exec vitest run test/viewer/explorer-states.test.tsx test/viewer`, then `mise run check`, then
`mise run test:e2e:chromium -- e2e/scale.spec.ts e2e/dashboards.spec.ts` (the settled checks read the notes' text).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/components/explorer-states.tsx src/viewer/shell/loading-line.tsx test/viewer/explorer-states.test.tsx
git commit -m "feat(viewer): loading notes animate"
```

---

### Task 6: The reload check and the README

**Files:**
- Modify: `e2e/engine-load.spec.ts` (a reload after the first assertions)
- Modify: `README.md` (the "Report layout and hosting" bullet about the navigation showing while the engine starts)

- [ ] **Step 1: Write the failing e2e assertion**

After the existing assertions, on `-http` projects whose browser is not WebKit (`http://127.0.0.1` is not a secure
context in WebKit, so `caches` is unavailable and the engine fetches as before):

```ts
await page.reload();
await expect(page.getByRole('main').locator('output', { hasText: /\bspans\b/ })).toHaveText(new RegExp(`^${SPAN_COUNT} spans`));
expect([...engineRequests.values()], 'a reload serves the engine files from cache storage').toEqual([1, 1, 1, 1]);
```

(the `engineRequests` map keeps counting across the reload; with the Cache API serving them, no request is made.)
Comment the WebKit skip. Keep `problems` empty across the reload.

- [ ] **Step 2: Run it to see it fail without the cache**

Verify the assertion is live by running the spec once with the Cache API disabled in the page: temporarily add
`await page.addInitScript(() => { Object.defineProperty(window, 'caches', { value: undefined }); })` before `goto`,
run `mise run test:e2e:chromium -- e2e/engine-load.spec.ts`, see the reload assertion fail (`[2, 1, 1, 1]` or
similar: Chromium re-downloads on a reload), then remove that init script.

- [ ] **Step 3: Run the spec to see it pass**

Run: `mise run test:e2e:chromium -- e2e/engine-load.spec.ts`, and `pnpm exec playwright test --project=firefox-http --project=webkit-http e2e/engine-load.spec.ts`
(fixtures are already built by the mise task).
Expected: PASS in all three.

- [ ] **Step 4: README**

Replace the bullet "The viewer shows its navigation while the engine starts, with a loading line where the page will
be; a `site` report's `index.html` starts the engine downloads from its first bytes, before the viewer script has
loaded." with: the viewer renders the page as soon as the manifest is read (navigation, page frame, a loading note
per list or chart until its query answers), a pill at the bottom names the load phase until the data is ready; a
`site` report's `index.html` starts the engine downloads from its first bytes and keeps the engine files in the
browser's cache storage (about 40 MB per engine version, older versions removed), so a reload does not download
them again. Run `mise run gen:check` (the README's Development section is generated; this bullet is not).

- [ ] **Step 5: Commit**

```bash
git add e2e/engine-load.spec.ts README.md
git commit -m "test(e2e): a reload makes no engine request; README on the page before the engine"
```

---

### Task 7 (coordinator): verify, measure, review, PR

- [ ] `mise run verify` (≈ 2 min) green.
- [ ] Measurements (spec §4) with the session's bench (`scratchpad/bench/pbe.mjs <root> <browsers> [throttle]`):
  rows 1–3 after, against the baseline in `scratchpad/bench/before-pbe.txt` (sample: Chromium cold `main` 829 ms,
  reload 709 ms with the wasm re-fetched; Firefox 1019/845 from the HTTP cache; WebKit 1469/1377 re-fetched; `ci`
  throttled Chromium cold 7.6 s, reload 6.4 s with the wasm re-fetched). WebKit's cached reload needs https and a
  persistent profile (`scratchpad/bench/reload-https.mjs`).
- [ ] Branch review on Opus 5.5 (whole diff + the spec); fix blocking findings; re-review.
- [ ] `gh pr create` with the plan's title, the body per conventions (what changed, decisions, measurements, **Also**),
  the footer with the session URL. Merge on green CI (`--squash --delete-branch`); re-run a flaky-looking failure
  once.
- [ ] After the deploy: live `branch/main/` cold and reloaded in Chromium at 50 Mbps / 40 ms
  (`scratchpad/bench/run-live-reload2.mjs` or the like): engine requests on reload (expected 0), time to `main` and
  to data ready; record in this plan's Status section and the PR (a comment, since it is merged by then).

## Status (2026-11-21)

Tasks 1–6 done on `perf/page-before-engine` (a9128bc4..2a42cfad), each task reviewed on Sonnet 5.5, the branch
reviewed on Opus 5.5: two Important findings fixed (a no-change poll tick swapped the pending data source for the real
one, re-running every query; the e2e reload check raced the fire-and-forget store) plus five minors (the inline
script survives a throwing `caches` getter and a bad cache entry falls through to the fetch; comment fixes; `pending`
kept in the effect closure; the e2e wait no longer waits twice on a missing `main`); re-review clean. `mise run
verify` green before the fix wave, `mise run check` green after it.

Measurements (`scratchpad/bench/pbe.mjs`, `pbe-webkit.mjs`; ms since navigation; `main` = page frame attached,
`ready` = loading line gone = data source ready; one run each):

| row | before: main / ready | after: main / ready | engine files on reload |
| --- | --- | --- | --- |
| sample, Chromium, cold | 829 / 829 | 248 / 787 | — |
| sample, Chromium, reload | 709 / 709 | 47 / 629 | wasm re-downloaded → none |
| sample, Firefox, cold | 1019 / 1019 | 342 / 1005 | — |
| sample, Firefox, reload | 845 / 845 | 207 / 706 | HTTP cache → cache storage |
| sample, WebKit over http (ephemeral context), cold | 1469 / 1469 | 422 / 1507 | — |
| sample, WebKit over http (ephemeral context), reload | 1377 / 1377 | 42 / 1736–1804 | re-downloaded before and after (the context drops the cache on reload) |
| sample, WebKit over https, persistent profile, cold | 1611 / 1611 | 156 / 1390 | — |
| sample, WebKit over https, persistent profile, reload | 1210 (HTTP cache) and 1776 (re-download) | 36 / 1559–1592 | → none; `match` of the 34 MB entry 141 ms |
| ci, Chromium 50 Mbps / 40 ms, cold | 7595 / 7595 | 1617 / 7529 | — |
| ci, Chromium 50 Mbps / 40 ms, reload | 6381 / 6381 | 91 / 681 | wasm re-downloaded (1.4 s) → none |

The page frame is on screen 0.6–6 s earlier everywhere; Chromium and Firefox data-ready times are unchanged or
better; a Chromium reload on the throttled link goes from 6.4 s to 0.7 s.

**The one worse row:** WebKit on loopback over http, reload: +0.35–0.4 s to data ready. Variants isolated it
(`scratchpad/bench/variant-*`): not the response clone, not the store; a no-cache build with the fetches delayed by
90 ms (the lookup's cost) gives 1422–1507, so part is the page rendering earlier and overlapping the body
downloads on WebKit's main thread (the engine's steps are round trips through it), part the lookup itself. WebKit's
ephemeral context never hits the cache, so that row pays the lookup without the benefit; a persistent profile over
https (a real Safari) reads from the cache in ~140 ms instead of downloading. On a real link (the wasm download is
1.4 s at 50 Mbps) the cache wins in every browser. Cold rows are within noise of before.

Correction to the spec and plan: WebKit does treat `http://127.0.0.1` as a secure context (`isSecureContext` true,
`caches.open` works); what fails there is persistence across a reload in an ephemeral context. Only Chromium has
`-http` e2e projects, so the reload assertion runs in Chromium only.
