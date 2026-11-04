# Main report showcase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every default-branch publish writes a shields.io badge file per workflow and (opt-in) light/dark screenshots of the rolling report, and the README shows both at the top.

**Architecture:** `ci site` writes `badge-<workflow>.json` into the channel folder after the rolling rebuild and reports `rolling=built|stub`. A wrapper script inside the gh-pages lease runs `ci site`, then a Node screenshot script (Playwright, installed by the action) on the channel folder, so the images go out in the same push. `clearRolling` keeps the previous `preview-*.png`.

**Tech Stack:** TypeScript (strict), vitest, bash, Playwright 1.64.1 (`@playwright/test`, already a devDependency; installed at action run time, no new dependency), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-04-main-report-showcase-design.md`

**PR process:** unattended (`docs/agents/process-unattended.md`). One PR: branch `feat/main-report-showcase`, title `feat(ci): a live badge and screenshot of the default branch's report`. The maintainer approved the spec's changes to `.github/workflows/ci-report.yml` and `.github/actions/otel-html-publish/`; they do not stop the run.

## Global Constraints

- Badge file: `<channel>/badge-<slug(workflow)>.json`, content `{"schemaVersion":1,"label":"<workflow> report","message":"<mark> <duration>","color":"<color>"}`.
- Conclusion → mark, color: `success` → `✓`, `brightgreen`; `failure` / `timed_out` / `startup_failure` → `✗`, `red`; `cancelled` → `cancelled`, `lightgrey`; anything else → the conclusion word, `lightgrey`.
- Duration `completedAt − startedAt`, formatted `52s`, `4m12s`, `1h03m`; no `startedAt` → message is the mark alone.
- Screenshots: `<channel>/preview-light.png`, `<channel>/preview-dark.png`; viewport 1280×720, device scale factor 2 (2560×1440 PNG); only `branch/` channels, only when `rolling=built`, only with the action input `preview: true` (default `false`).
- A screenshot or browser-install failure is a `::warning::` and never fails the publish; the previous images stay.
- Playwright version `1.64.1`, equal to `@playwright/test` in `package.json`.
- No change to the viewer, the report format or `src/api`.

## Review Focus

- **Two workflows on one channel** (`ci` and `load` both publish to `branch/main`): publishing a `load` run must leave `badge-ci.json` showing the newest `ci` run. Test in Task 1.
- **A late older run** (a re-run finishing after a newer run): the badge shows the newest by `completedAt`, not the run just published. Test in Task 1.
- **The rolling rebuild falls back to the stub:** `rolling=stub`, no screenshot, previous `preview-*.png` still there. Test in Task 2.
- **The report never finishes loading** (a chart stays busy): the script gives up after 30 s with a warning and writes nothing, so the old images stay. Covered by the timeout path in Task 3.
- **Browser missing on the runner** (install failed, or `preview` on a runner without sudo): the wrapper warns and the push still happens. Test in Task 4.

---

### Task 1: Badge files from `ci site`

**Files:**
- Modify: `src/cli/ci/site.ts` (`SiteRun`, `siteRunSchema`, new exports)
- Modify: `src/cli/ci/site-main.ts` (`siteRun` gets `startedAt`; write badges after `rebuildRolling`)
- Modify: `src/cli/ci/site-io.ts` (new `writeBadges`)
- Test: `test/cli/ci/site.test.ts`, `test/cli/ci/command.test.ts`

**Interfaces:**
- Produces: `SiteRun.startedAt?: string` (zod `z.string().exactOptional()`); `export type Badge = { schemaVersion: 1; label: string; message: string; color: string }`; `export function badgeFor(run: SiteRun): Badge`; `export function formatRunDuration(ms: number): string`; `export function channelBadges(channel: Channel): Record<string, Badge>` (file name `badge-<slug(workflow)>.json` → badge, from each workflow's first run in `channel.runs`, runs without `workflow` skipped); `export async function writeBadges(site: string, key: string, channel: Channel): Promise<void>` in `site-io.ts`.

- [ ] **Step 1: Write failing unit tests in `test/cli/ci/site.test.ts`**

`formatRunDuration`: `52_000` → `'52s'`, `252_000` → `'4m12s'`, `3_780_000` → `'1h03m'`, `0` → `'0s'`, negative → `'0s'`.
`badgeFor`: success with `startedAt: '…T00:00:00Z'`, `completedAt: '…T00:04:12Z'`, `workflow: 'ci'` → `{schemaVersion:1,label:'ci report',message:'✓ 4m12s',color:'brightgreen'}`; `failure`, `timed_out`, `startup_failure` → `✗ …`, `red`; `cancelled` → `'cancelled 4m12s'`, `lightgrey`; `neutral` → `'neutral 4m12s'`, `lightgrey`; no `startedAt` → message `'✓'`.
`channelBadges`: runs `[ci newest success, load failure, ci older failure, (no workflow)]` → exactly keys `badge-ci.json` (success) and `badge-load.json` (failure). `parseSiteIndex` round-trips an entry with and without `startedAt`.

- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/site.test.ts` — FAIL (not exported).
- [ ] **Step 3: Implement** the Produces items in `site.ts` and `writeBadges` in `site-io.ts` (JSON with a trailing newline, like `index.json`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Write failing command tests in `test/cli/ci/command.test.ts`** beside the existing `ci site` tests:
  - a default-branch `ci` run writes `branch/main/badge-ci.json` with `message` `✓ <duration from the fake run's run_started_at/updated_at>`;
  - then a `load` run (`name: 'load'`) on the same channel: `badge-ci.json` unchanged, `badge-load.json` written;
  - then a `ci` run whose `updated_at` is older than the first `ci` run, `conclusion: 'failure'`: `badge-ci.json` still `✓`;
  - the `index.json` entry carries `startedAt`.
- [ ] **Step 6: Run** `pnpm exec vitest run test/cli/ci/command.test.ts` — FAIL.
- [ ] **Step 7: Implement** in `runSite`: `startedAt: run.run_started_at ?? run.created_at`; after `rebuildRolling` (also on the stub path), `writeBadges(opts.site, placed.key, index.channels[placed.key])`.
- [ ] **Step 8: Run** both test files — PASS; `pnpm exec biome check .`; `mise run typecheck`.
- [ ] **Step 9: Commit** `feat(ci): ci site writes a shields.io badge file per workflow`.

### Task 2: `rolling` output, and screenshots survive rebuilds

**Files:**
- Modify: `src/cli/ci/site-main.ts` (`rebuildRolling` returns the outcome; `clearRolling` keeps previews; `setOutputs` adds `rolling`)
- Modify: `README.md` (`ci site` row ~line 375: outputs `published`, `report-url`, `channel`, `rolling`; badge files; the rolling-report paragraph ~line 364: badge files and that `preview-*.png` survive rebuilds)
- Test: `test/cli/ci/command.test.ts`

**Interfaces:**
- Produces: `ci site` writes `rolling=built` or `rolling=stub` to `$GITHUB_OUTPUT` on every published run (Task 4 reads it with `channel`). `rebuildRolling(...): Promise<'built' | 'stub'>`. `clearRolling` keeps `runs/` and every name matching `/^preview-.*\.png$/`.

- [ ] **Step 1: Write failing tests:** a successful publish's output contains `rolling=built`; the existing "rolling merge that fails" test also expects `rolling=stub`; a `branch/main/preview-light.png` and `preview-dark.png` placed in the site before a publish are still there, byte-identical, after a built rebuild and after a stub fallback; a `branch/main/other.png` is removed.
- [ ] **Step 2: Run** `pnpm exec vitest run test/cli/ci/command.test.ts` — FAIL.
- [ ] **Step 3: Implement** the Produces items; update the README rows.
- [ ] **Step 4: Run** — PASS; biome; typecheck.
- [ ] **Step 5: Commit** `feat(ci): ci site reports whether the rolling report was rebuilt and keeps its previews`.

### Task 3: The screenshot script

**Files:**
- Create: `.github/actions/otel-html-publish/preview.mjs`
- Create: `e2e/preview.spec.ts`
- Modify: `playwright.config.ts` only if needed so the spec runs in `chromium-file` only (follow how `scale.spec.ts` is limited)

**Interfaces:**
- Produces: `node preview.mjs <report-dir>`; env `PLAYWRIGHT_FROM` (a path `createRequire` resolves `@playwright/test` from; required). Writes `<report-dir>/preview-light.png` and `<report-dir>/preview-dark.png` atomically (to `*.png.tmp`, then rename), only once both are taken. Exit 0 on success; on any failure prints `::warning::otel-html preview: <message>` to stdout, writes nothing, exits 0.

- [ ] **Step 1: Write the failing spec `e2e/preview.spec.ts`:** copy the `dashboards` fixture report (`REPORTS_DIR`) to a temp dir, run `node .github/actions/otel-html-publish/preview.mjs <copy>` with `PLAYWRIGHT_FROM` set to the repo's `package.json`; expect exit 0, both PNGs present with IHDR width 2560 and height 1440, the two files differ (light ≠ dark), and stdout has no `::warning::`. Second test: a dir with no `index.html` → exit 0, stdout contains `::warning::otel-html preview:`, no PNG written.
- [ ] **Step 2: Run** `mise run test:e2e:chromium -- e2e/preview.spec.ts` — FAIL (no script).
- [ ] **Step 3: Implement `preview.mjs`:** launch Chromium once; per scheme, a context with `viewport {1280,720}`, `deviceScaleFactor: 2`, `colorScheme`; `page.goto(pathToFileURL(<dir>/index.html))`; wait (overall cap 30 s) with `waitForFunction(() => document.querySelector('main') !== null && document.querySelector('[aria-busy="true"]') === null)`, then a 1 s settle; screenshot the viewport. A timeout is a failure (warning, nothing written). Plain ESM JavaScript with a JSDoc header like the action's shell scripts.
- [ ] **Step 4: Run** the spec — PASS. Look at the two PNGs once (they should resemble the CI-style dashboard of the fixture, not a loading state).
- [ ] **Step 5:** biome, typecheck, `mise run check` (knip must not flag the `.mjs`; if it does, add it to knip's entry list).
- [ ] **Step 6: Commit** `feat(ci): a script that screenshots a report in light and dark`.

### Task 4: Wire it into the action and ci-report

**Files:**
- Create: `.github/actions/otel-html-publish/site-publish.sh`
- Modify: `.github/actions/otel-html-publish/action.yml` (input `preview`, install step, the site step's lease command)
- Modify: `.github/workflows/ci-report.yml` (`preview: true` on the `publish` step)
- Modify: `README.md` (publisher inputs table ~line 511: `preview`, default `false`, what it writes, the ~1 min cost, needs Node and sudo on the runner)
- Test: `test/actions/site-publish.test.ts`, `test/actions/preview-version.test.ts`

**Interfaces:**
- Consumes: `channel=` and `rolling=` lines from Task 2 in `$GITHUB_OUTPUT`; `preview.mjs` from Task 3.
- Produces: `site-publish.sh <site> <command...>`: runs `<command...>`; on its failure exits with its status. Then, when env `PREVIEW_COMMAND` is non-empty and `$GITHUB_OUTPUT` has `channel=branch/…` and `rolling=built`, runs `$PREVIEW_COMMAND "<site>/<channel>"` (unquoted on purpose, like `CMD`); a non-zero exit becomes `::warning::otel-html preview: …`. Always exits 0 after a successful command.

- [ ] **Step 1: Write failing tests `test/actions/site-publish.test.ts`** (style of `site-branch.test.ts`, skipped on win32): a fake command that writes `channel=branch/main` and `rolling=built` → `PREVIEW_COMMAND` (a stub script recording its args) called with `<site>/branch/main`; `rolling=stub` → not called; `channel=pr/3` → not called; `PREVIEW_COMMAND` empty → not called; stub exits 1 → wrapper exits 0 with the warning; the command itself exits 1 → wrapper exits 1, preview not called.
- [ ] **Step 2: Write failing `test/actions/preview-version.test.ts`:** the `playwright@<v>` in `action.yml` equals `devDependencies['@playwright/test']` in `package.json`.
- [ ] **Step 3: Run** `pnpm exec vitest run test/actions/` — FAIL.
- [ ] **Step 4: Implement:**
  - `site-publish.sh` per Produces.
  - `action.yml`: input `preview` (description per the README row, default `"false"`). A step `Install the preview browser` (`id: browser`, `if: preview == 'true' && cleanup-pr == '' && target == 'github-pages'`, `continue-on-error: true`): `npm install --prefix "$RUNNER_TEMP/otel-html-playwright" @playwright/test@1.64.1` then `npx --prefix … playwright install --with-deps chromium`. The site step wraps: `site-lease.sh "$SITE" … published=true "$GITHUB_ACTION_PATH/site-publish.sh" "$SITE" $CMD ci site …`, with env `PREVIEW_COMMAND` = `node $GITHUB_ACTION_PATH/preview.mjs` when `steps.browser.outcome == 'success'`, else empty, and `PLAYWRIGHT_FROM=$RUNNER_TEMP/otel-html-playwright/package.json`. When `preview` is true but the install failed, the site step prints one `::warning::otel-html preview: the browser install failed; no screenshot`.
  - `ci-report.yml`: `preview: true` with a one-line comment (the README's screenshot).
- [ ] **Step 5: Run** the tests — PASS; `actionlint` if mise has it (`mise run check` runs the repo's workflow lint); biome; typecheck.
- [ ] **Step 6: Commit** `feat(ci): the publisher's preview input screenshots the default branch's report`.

### Task 5: README hero

**Files:**
- Modify: `README.md` (top, between `# otel-html` and the first paragraph)

- [ ] **Step 1:** Insert the `ci` badge (the spec's exact markdown) and below the first paragraph the screenshot:

```html
<a href="https://bjstabi.github.io/otel-html/branch/main/"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://bjstabi.github.io/otel-html/branch/main/preview-dark.png">
  <img alt="This repository's own CI, as an otel-html report" src="https://bjstabi.github.io/otel-html/branch/main/preview-light.png">
</picture></a>
<sub>Live: this repository's own CI, reported by otel-html. Click to open.</sub>
```

- [ ] **Step 2:** `mise run gen:check` (README generated section untouched); `mise run check`.
- [ ] **Step 3: Commit** `docs: the main report's badge and screenshot at the top of the README`.

### Finish

- [ ] `mise run verify`; branch review on Opus 5.5 with the whole diff and this plan; PR with the title above, body per conventions (decisions from the spec's "Decisions made" section; no new dependency: Playwright is fetched at run time by the action only); merge on green.
- [ ] After merge: wait for the next `ci` → `ci-report` run on main; check `https://bjstabi.github.io/otel-html/branch/main/badge-ci.json` and both PNGs return 200 and the README renders them. Report the result in the summary.
