# Scale fixtures on demand (2026-11-02)

`mise run e2e:fixtures` takes ~15 s on a 20-core machine, and ~14 s of it is two reports only `e2e/scale.spec.ts`
reads. This document says how the e2e fixtures stop paying for them on runs that do not need them, and on viewer-only
changes. The process is **unattended** (`docs/agents/process-unattended.md`): one PR, squash-merged when CI is green.

## Intent

The quick e2e loop (`mise run test:e2e:chromium -- e2e/<spec>.spec.ts`) should build only what the selected specs
read, and an edit to the viewer should not re-convert data the viewer does not write. Coverage does not shrink: the
full suite, `mise run verify` and CI build and test everything they do today.

## Measurements (2026-11-02, 20 cores)

`bun e2e/build-fixtures.ts`: 15 s wall, 39 s CPU. Sampling the running `convert`s:

| step | wall | peak RSS |
| --- | --- | --- |
| generating the scale inputs in bun (100k spans, 1M logs in 10 × 26 MB files, metrics) | 0–2 s | — |
| `convert` → `scale/` | 2–14 s | ~500 MB |
| `convert` → `huge/` (same inputs, `OTEL_HTML_EAGER_BUDGET_BYTES`), in parallel | 2–14 s | ~510 MB |
| every other report (`main`, `large` 50k spans, fixtures, merges, dashboards, run charts, frozen, unfinished) | within ~1 s | — |

Converting the scale inputs one signal at a time: 1M logs 9.3 s, 100k spans 1.6 s, metrics 0.6 s.

`otel-html upgrade` on copies of the built `small`, `dashboards`, `scale` and `huge` reports: byte-identical to the
originals (`diff -rq`), ~160 ms each. On `unfinished` it reclaims the stale writer lock and deletes `data/state/lock.json`, so it
changes that report.

`pnpm exec playwright test --list …`: ~0.6 s, does not run `e2e/global-setup.ts`, prints one line per test with its
file (`[chromium-file] › smoke.spec.ts:4:1 › …`).

## Why `dist/` is an input, and the split

A report is two layers from two disjoint parts of `dist/`:

| part of a report | written by | depends on |
| --- | --- | --- |
| `data/` | the writer (`dist/cli/main.js convert`/`merge`/`upgrade`; `unfinished` through `src/api` under bun) | the `build:lib` outputs: `dist/cli/**`, `dist/index.js`, `dist/index.d.ts`, `dist/receiver-*.js` |
| `index.html`, `.nojekyll`, `assets/` | the writer, copying the viewer build and stamping its entry name | `dist/viewer/**` (`build:viewer`) |

Freshness is by content (`task.source_freshness_hash_contents = true` in `mise.toml`), so `dist/**` as a source is
correct but coarse: a viewer-only change re-converts every report. Splitting at this `dist/` boundary is reliable —
the subtrees do not overlap, and `upgrade` is the product's tested way to replace a report's viewer. Isolating finer
(which `src/` modules each report depends on) is rejected: a map to maintain, and a wrong entry is a stale fixture.

## Goals

1. A run that selects no test in `e2e/scale.spec.ts` does not build `scale` or `huge`.
2. After a change that leaves the `build:lib` outputs and the scale inputs alone (a viewer-only change), `scale` and
   `huge` are refreshed by `upgrade` (~0.3 s), not re-converted (~14 s).
3. A run that selects `scale.spec.ts` (including the full suite, `verify` and CI) gets current `scale` and `huge`.
4. A missing scale report fails loudly, naming the command that builds it.

## Non-goals

- Splitting the cheap reports further, or applying the `upgrade` path to them: they all rebuild in ~1 s.
- Changing the scale workload (`SCALE_LOGS` etc.) or the reports' contents.
- Changing `.github/workflows/ci.yml`.

## Anti-goals

- A test that passes against a stale `scale`/`huge` (built from older lib output or older inputs).
- A per-spec report map that a new spec must remember to update.
- Caching or freshness logic hand-written in a script where a mise task's `sources`/`outputs` can do it.

## Design (decided by the maintainer)

1. **`e2e:fixtures` keeps every report except `scale` and `huge`**, with its current sources (`dist/**` minus the
   binaries and load receiver) and full rebuild. `build-fixtures.ts` no longer builds the scale inputs or reports.
2. **`e2e:fixtures:scale:data`** builds `scale` and `huge` (the code now in `buildScaleReports`, moved out of
   `build-fixtures.ts`). Its sources are the `build:lib` outputs above, the scale input generators and the files they
   import (`test-support/scale-logs.ts`, `test-support/scale-metrics.ts`, `test-support/otlp-builders.ts`,
   `test-support/fixture-ids.ts`, `e2e/fixture.ts`, the new script), and `@group:deps`. Not `dist/viewer/**`. It
   depends on `build`.
3. **`e2e:fixtures:scale`** depends on `e2e:fixtures:scale:data`; its sources are `dist/viewer/**` (plus `@group:deps`);
   it runs `node dist/cli/main.js upgrade` on `scale` and `huge`. When `:data` re-ran it wrote the current viewer
   already and the upgrade is a no-op; when only the viewer changed, only this task runs.
4. **`test:e2e` builds the scale reports only when they are needed**: before the two Playwright passes it runs
   `pnpm exec playwright test --list` with the same arguments and projects as the passes, and if any listed test is in
   `scale.spec.ts` it runs `mise run --skip-deps e2e:fixtures:scale:data` and then
   `mise run --skip-deps e2e:fixtures:scale` (two invocations, so the order holds). `--skip-deps` because `dist/` is
   already built by `test:e2e`'s own dependency chain locally, and in CI it must not be rebuilt under the job shell
   (the reason CI already runs `mise run --skip-deps e2e:fixtures`). No arguments means the full suite, which lists
   `scale.spec.ts`, so `verify` and CI build the scale reports with no change to `ci.yml`.
5. **Fail where used**: `e2e/global-setup.ts` stops requiring `scale` and `huge` in `assertReportsBuilt` (as it already
   skips `metrics-scale`) but still mounts them. `scale.spec.ts` checks, before the tests that open `scale` or `huge`,
   that their `data/manifest.js` exists, and otherwise fails with a message naming `mise run e2e:fixtures:scale`.
   The check covers only the tests that open `scale` or `huge`, never the metrics-scale tests: CI's
   `e2e-metrics-scale` job runs `pnpm exec playwright test e2e/scale.spec.ts --project chromium-perf-file --grep
   'metrics scale'` directly, after `mise run --skip-deps e2e:fixtures` and without the scale reports, and must keep
   passing unchanged.

## Calls made by the agent (the maintainer may override)

- The scale reports live in **`e2e/.reports-scale/`** (`scale/`, `huge/`, and the generated inputs), outside
  `e2e/.reports/`, which `build-fixtures.ts` deletes on every run and which is `e2e:fixtures`' declared output.
  `reportDir('scale' | 'huge')` returns the new folder. It is added to `.gitignore` and to the `biome.json` ignores next
  to `e2e/.reports`.
- **`--list` decides**, not a spec→report map: it honours file filters, `-g`/`--grep`, `--grep-invert` and tags
  exactly as the passes will, for ~0.6 s per run. Selecting only the metrics-scale tests in `scale.spec.ts` still builds
  `scale`/`huge`; that over-build is accepted.
- **`large`** (50k spans, under 1 s) stays in `e2e:fixtures`.
- The new script is **`e2e/build-scale-fixtures.ts`**, run with bun like `build-fixtures.ts`.

## Left to the builder

- How the `--list` output is matched (a grep for `scale.spec.ts` in the listed lines is enough) and how the listing is
  shared by both passes' project sets.
- Where in `scale.spec.ts` the existence check sits (a `beforeAll` per describe that opens `scale`/`huge`, or a helper
  beside `ensureMetricsScaleReport`).
- Whether `metrics-scale.ts`/`build-fixtures.ts` comments that describe the old layout need rewording, and the
  `mise.toml` task descriptions (they document themselves; say what each task costs).
- README or `AGENTS.md` lines that mention `e2e:fixtures` building everything: update them if they become wrong.

## Verification

- `mise run check` green.
- `mise run test:e2e:chromium -- e2e/smoke.spec.ts` on a clean checkout (`rm -rf e2e/.reports e2e/.reports-scale`)
  does not create `e2e/.reports-scale/`.
- `mise run test:e2e:chromium -- e2e/scale.spec.ts` builds it and passes.
- After a viewer-only edit (any change under `src/viewer/`), the second command runs `e2e:fixtures:scale` and skips
  `e2e:fixtures:scale:data` (mise's output says which ran); after a change under `src/writer/` both run.
- With `e2e/.reports-scale/` deleted, `pnpm exec playwright test e2e/scale.spec.ts` (after `mise run e2e:fixtures`)
  fails with the message naming `mise run e2e:fixtures:scale`.
- `mise run verify` green; CI green on the PR.
