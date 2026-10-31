# CI dogfooding M0 + M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `otel-html run` joins an inherited trace (M0), and every `ci.yml` job writes a report that a `workflow_run` publisher merges with the run's own trace, logs and metrics into one downloadable report that opens on a CI dashboard (M1).

**Architecture:** M0 is one pure parser (`src/run/traceparent.ts`), an optional parent on the root span builder, and a flag/env on the `run` command. M1 is a set of pure modules under `scripts/ci/` (ids, job context, workflow trace, job logs, metrics, summary) with unit tests, two thin I/O entry points (`scripts/ci-context.ts` in each job, `scripts/ci-report.ts` in the publisher), the CI dashboard config, and the workflow edits. The pure/IO split follows `scripts/load-receiver.ts` + `scripts/load-receiver-plan.ts`.

**Tech Stack:** TypeScript (Node 24, bun for scripts), vitest, zod, the `otel-html` library API (`Report`, `merge`), GitHub REST API via `fetch` with `GITHUB_TOKEN`, GitHub Actions (`workflow_run`, `actions/download-artifact`), actionlint (runs in `mise run lint`).

**Spec:** `docs/superpowers/specs/2026-10-30-ci-dogfood-design.md` (§3, §6.1–6.3, §6.7, §6.10, §7 M0 and M1).

## Global Constraints

- Conventional commits (commitlint); `mise run check` (biome with warnings as errors, tsc on three tsconfigs, vitest, knip) must pass on every commit. New script modules must be reachable from an entry point or knip flags them.
- No new runtime dependencies. Scripts use `node:crypto`, `fetch` and the library API only.
- A report failure must never fail a job that otherwise passed; `run`'s existing exit-code contract is untouched.
- Deterministic ids: `run key = github.com/<owner>/<repo>/actions/runs/<run_id>/attempts/<run_attempt>`; trace id = `sha256(run key)[0:16]`; run span = `sha256(run key + "#run")[0:8]`; job span = `sha256(run key + "/jobs/" + <job id>)[0:8]`; step span = `sha256(run key + "/jobs/" + <job id> + "/steps/" + <step number>)[0:8]`.
- Resource attributes on every CI record: `cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.run.url.full`, `vcs.ref.head.name`, `vcs.ref.head.revision`, `vcs.repository.url.full`; job reports add `cicd.pipeline.task.name = <job name>`.
- `defaults.run.shell` cannot see `GITHUB_ENV`; the report path in the shell line is the literal `.otel-html/report`.
- Secrets never reach a report: the publisher reads only public run, job, step and log fields with the default token.
- No macOS runners.

## Review Focus

1. A `TRACEPARENT` with uppercase hex, a version other than `00`, or all-zero ids must be a usage error (exit 2), never a silent fresh trace. Test in Task 1.
2. A job whose API lookup is ambiguous (two in-progress jobs on one runner name) must fall back to the name hash on both sides identically. Test in Task 7 (`resolveJob`) and Task 9 (publisher uses `approximate` the same way).
3. A job log line without a leading timestamp (continuation of a multi-line message) must attach to the previous record, not be dropped or mis-timed. Test in Task 10.
4. A step still `in_progress` or with no `completed_at` (cancelled run) must produce a span that ends at the job's `completed_at`, never a negative or NaN duration. Test in Task 8.
5. The custom shell must not break steps that run before the CLI is built; `check` must build first and pre-build steps must set `shell: bash`. Covered by actionlint plus the workflow review in Task 14 (the CI run itself is the test).

---

## M0: trace context inheritance

### Task 1: W3C traceparent parser

**Files:**
- Create: `src/run/traceparent.ts`
- Test: `test/run/traceparent.test.ts`

**Interfaces:**
- Produces: `parseTraceparent(value: string): { traceId: Uint8Array; spanId: Uint8Array; flags: number }`, throwing `OtelHtmlError('usage', …)` with `hint: 'the W3C form 00-<32 hex trace id>-<16 hex span id>-<2 hex flags>'`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('parseTraceparent', () => {
  test('parses the W3C form', () => {
    const p = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
    expect(Buffer.from(p.traceId).toString('hex')).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(Buffer.from(p.spanId).toString('hex')).toBe('b7ad6b7169203331');
    expect(p.flags).toBe(1);
  });
  test.each([
    ['01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', 'version'],
    ['00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01', 'uppercase'],
    ['00-00000000000000000000000000000000-b7ad6b7169203331-01', 'zero trace id'],
    ['00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01', 'zero span id'],
    ['00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331', 'missing flags'],
    ['', 'empty'],
  ])('%s is a usage error (%s)', (value) => {
    expect(() => parseTraceparent(value)).toThrow(OtelHtmlError);
    expect(usageOf(() => parseTraceparent(value)).code).toBe('usage');
  });
});
```

`usageOf` as in `test/run/child-env.test.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run test/run/traceparent.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `parseTraceparent` in `src/run/traceparent.ts`**

One regex `^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$`, then reject all-zero ids. The error message names the value: `TRACEPARENT is not a W3C traceparent: <value>`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run test/run/traceparent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/run/traceparent.ts test/run/traceparent.test.ts
git commit -m "feat(run): parse a W3C traceparent"
```

### Task 2: root span with a parent

**Files:**
- Modify: `src/run/root-span.ts` (`RootSpanInput`, `rootSpanRequest`)
- Test: `test/run/root-span.test.ts`

**Interfaces:**
- Produces: `RootSpanInput.parentSpanId?: Uint8Array` (absent or empty means root). The span's `parentSpanId` is set from it; `flags` keep `SAMPLED_LOCAL_FLAGS` when absent and become `0x301` (sampled, has-is-remote, is-remote) when present.

- [ ] **Step 1: Write the failing test** in the `rootSpanRequest` describe:

```ts
test('an inherited parent makes the root span a remote child', () => {
  const parent = Uint8Array.from({ length: 8 }, (_, i) => 0x20 + i);
  const span = spanOf({ ...input({ code: 0, signal: null }), parentSpanId: parent });
  expect(span.parentSpanId).toEqual(parent);
  expect(span.flags).toBe(0x301);
});
test('without a parent the span stays a local root', () => {
  expect(spanOf(input({ code: 0, signal: null })).flags).toBe(0x101);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run test/run/root-span.test.ts`
Expected: FAIL on `parentSpanId`.

- [ ] **Step 3: Implement**: add the optional field, pass it to `create(SpanSchema, …)`, add a `SAMPLED_REMOTE_FLAGS = 0x301` constant beside `SAMPLED_LOCAL_FLAGS`.

- [ ] **Step 4: Run to verify pass**, then **Step 5: Commit** `feat(run): root span accepts an inherited parent`.

### Task 3: `run --traceparent` and the `TRACEPARENT` variable

**Files:**
- Modify: `src/cli/commands/run.ts` (option, id selection)
- Test: `test/cli/run.test.ts`

**Interfaces:**
- Consumes: `parseTraceparent` (Task 1), `RootSpanInput.parentSpanId` (Task 2).
- Produces: option `--traceparent <value>`; when absent, `io.env.TRACEPARENT`; when both absent, random ids as today. The child's `TRACEPARENT` always points at `run`'s own root span (unchanged).

- [ ] **Step 1: Write the failing tests** in the `run` describe, using the file's `start(w, argv, env)` helper:

```ts
test('TRACEPARENT in the environment is inherited: same trace id, root parented under it', async () => {
  const w = createTestWriter();
  const h = start(w, ['run', '-o', 'out', ...node, '0'], {
    TRACEPARENT: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  });
  open.push(h);
  expect(await h.result).toBe(0);
  const { spans } = chunkOf(w);
  const root = spans.find((s) => s.name === 'node');
  const child = spans.find((s) => s.name === 'child-work');
  expect(root?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  expect(root?.parentSpanId).toBe('b7ad6b7169203331');
  expect(child?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
  expect(child?.parentSpanId).toBe(root?.spanId);
});
test('--traceparent wins over the variable', async () => { /* flag value's trace id on the root */ });
test('a malformed TRACEPARENT is a usage error before the child starts', async () => {
  const w = createTestWriter();
  const h = start(w, ['run', '-o', 'out', ...node, '0'], { TRACEPARENT: 'nope' });
  open.push(h);
  expect(await h.result).toBe(2);
  expect(h.stderr).toContain('TRACEPARENT');
  expect(w.fs.exists('out/data/manifest.js')).resolves.toBe(false);
});
```

Check how `chunkOf` spells ids (hex strings via `test-support/decode.ts`) and match it.

- [ ] **Step 2: Run to verify failure**: `pnpm exec vitest run test/cli/run.test.ts -t traceparent`.

- [ ] **Step 3: Implement**: `.option('--traceparent <value>', 'join this W3C trace context; default $TRACEPARENT')`; resolve `const inherited = flags.traceparent ?? io.env.TRACEPARENT` and parse it before `detectRunResource` (so the usage error precedes the receiver bind, as the test asserts). `traceId` comes from it, `spanId` stays random, `parentSpanId` goes into `rootSpanRequest`.

- [ ] **Step 4: Run the whole file and `mise run check`**: PASS.

- [ ] **Step 5: Commit** `feat(run): join an inherited trace via --traceparent or TRACEPARENT`.

### Task 4: README for `run` and the format contract

**Files:**
- Modify: `README.md` (the `run` section; a new "Report format compatibility" subsection under "Report layout and hosting")

- [ ] **Step 1**: In the `run` table, change the `TRACEPARENT` row to say the child always gets `run`'s root span, and add a paragraph: `--traceparent <value>` (default `$TRACEPARENT`) makes the root span a child of that context, so a `run` inside a traced CI job joins the job's trace; a malformed value is a usage error.
- [ ] **Step 2**: Add "Report format compatibility": `data/` is the model, `assets/` and `index.html` the viewer; `formatVersion` (now 3) is bumped only for changes an older reader cannot read; this otel-html reads 1–3; `merge` re-renders any readable report with the current viewer; `--append` needs the same otel-html version. Link `src/format/version.ts`.
- [ ] **Step 3: Commit** `docs: run --traceparent and the report format contract`.

### Task 5: frozen reports of each readable format version

**Files:**
- Create: `fixtures/reports/format-1/data/**`, `fixtures/reports/format-2/data/**` (data folders only, no `assets/`, no `index.html`), `fixtures/reports/README.md`
- Test: `test/format/compat.test.ts`

**Interfaces:**
- Consumes: public `merge` from `src/api/convert.ts`, `createTestWriter` from `test-support/writer-deps.ts`.

- [ ] **Step 1: Generate the fixtures** (one-off, documented in `fixtures/reports/README.md`): for `(1, 1b83faa, fixtures/small.otlp.json)` and `(2, 01d0e53, fixtures/small.otlp.json fixtures/metrics.otlp.json)`: `git worktree add /tmp/fmt-<n> <sha>`, `mise run setup && mise run build` there, `node dist/cli/main.js convert <inputs> -o /tmp/fmt-<n>-report --title "format <n> fixture"`, copy `data/` into `fixtures/reports/format-<n>/`, remove the worktree. If the format-1 commit's `convert` cannot take `metrics.otlp.json`, use `small.otlp.json` alone and say so in the README.

- [ ] **Step 2: Write the failing test**

```ts
describe.each(['format-1', 'format-2'])('%s', (name) => {
  test('merge reads it and the totals survive', async () => {
    const w = createTestWriter();
    const expected = await copyFixtureReport(w, name); // reads fixtures/reports/<name>/data/** from disk into w.fs at <name>/, returns its parsed manifest
    const summary = await merge({ inputs: [name], out: 'm' }, w.deps);
    expect(summary.totals).toEqual(expected.totals);
    expect(manifestOf(w, 'm').formatVersion).toBe(FORMAT_VERSION);
  });
});
```

`copyFixtureReport` lives in the test file; `manifestOf` as in `test/cli/run.test.ts`.

- [ ] **Step 3: Run to verify failure** (no fixtures yet), **Step 4: add the fixtures**, **Step 5: run to verify pass**.

- [ ] **Step 6: Commit** `test(format): frozen format-1 and format-2 reports stay mergeable`.

## M1: dogfood `ci.yml`

### Task 6: deterministic CI ids

**Files:**
- Create: `scripts/ci/ids.ts`
- Test: `test/scripts/ci/ids.test.ts`

**Interfaces:**
- Produces:
  - `runKey(i: { repository: string; runId: number; runAttempt: number }): string` (the Global Constraints form; `repository` is `owner/repo`).
  - `traceIdOf(key: string): string` (32 hex), `runSpanIdOf(key): string`, `jobSpanIdOf(key, jobId: number | string): string`, `stepSpanIdOf(key, jobId, stepNumber: number): string` (16 hex).
  - `jobTraceparent(key, jobId): string` = `00-<traceIdOf>-<jobSpanIdOf>-01`.
  - `jobId` is a number for an API-resolved job and the string `name:<job name>` for the fallback (§6.2), so both sides hash the same thing.

- [ ] **Step 1: Write the failing tests**: `runKey` renders the exact string for `{repository:'bjstabi/otel-html', runId: 42, runAttempt: 2}`; ids have the right lengths and are lowercase hex; the same inputs give the same ids and a different attempt gives a different trace id; `jobSpanIdOf(k, 7) !== jobSpanIdOf(k, 'name:e2e (webkit)')`; `jobTraceparent` round-trips through `parseTraceparent` (Task 1).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** with `createHash('sha256')`. **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): deterministic trace and span ids for workflow runs`.

### Task 7: job-side context

**Files:**
- Create: `scripts/ci/context.ts` (pure), `scripts/ci-context.ts` (entry point)
- Test: `test/scripts/ci/context.test.ts`

**Interfaces:**
- Consumes: Task 6.
- Produces:
  - `type ApiJob = { id: number; name: string; status: string; runner_name: string | null; conclusion: string | null; started_at: string | null; completed_at: string | null; created_at: string; html_url: string | null; steps: ApiStep[] }`, `type ApiStep = { number: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }` (the subset of the jobs API both scripts read; shared by Tasks 8–10).
  - `resolveJob(jobs: ApiJob[], runnerName: string, jobNameHint: string): { jobId: number | string; approximate: boolean }`: the single job with `status === 'in_progress'` and `runner_name === runnerName` → `{ jobId: id, approximate: false }`; zero or several → `{ jobId: 'name:' + jobNameHint, approximate: true }`.
  - `contextEnv(i: { repository: string; runId: number; runAttempt: number; workflow: string; runUrl: string; ref: string; sha: string; serverUrl: string; jobName: string; jobId: number | string; existingResourceAttributes?: string }): Record<string, string>` returning `TRACEPARENT`, `OTEL_RESOURCE_ATTRIBUTES` (existing pairs kept, ours appended, values with `,` or `=` percent-encoded) and `OTEL_SERVICE_NAME = <workflow>/<jobName>`.
  - `scripts/ci-context.ts`: reads `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_WORKFLOW`, `GITHUB_SERVER_URL`, `GITHUB_REF_NAME`, `GITHUB_SHA`, `RUNNER_NAME`, `GITHUB_JOB`, `GITHUB_TOKEN`, optional `OTEL_HTML_JOB_NAME` (hint override); fetches `GET {api}/repos/{repo}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100` (follow `Link: rel="next"`); appends `KEY=value` lines to `$GITHUB_ENV`; prints a `::warning::` when approximate; any failure prints `::warning::otel-html context: <message>` and exits 0 (a job must never fail for this).

- [ ] **Step 1: Write the failing tests** for `resolveJob` (exact match; two matches → approximate; none → approximate) and `contextEnv` (exact `TRACEPARENT` from Task 6; `OTEL_RESOURCE_ATTRIBUTES` contains `cicd.pipeline.run.id=42` and `cicd.pipeline.task.name=e2e (webkit)` (spaces are kept; only `,` and `=` in a value are percent-encoded, so a job named `a,b` yields `a%2Cb`); an existing `a=b` stays first; `OTEL_SERVICE_NAME` is `ci/e2e (webkit)`).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement both files.** **Step 4: Run to verify pass; `mise run check`.** knip's `entry` lists `src/**`, tests and e2e only, so add `"scripts/*.ts"` to `knip.json` `entry` (the existing scripts are reached the same way or not at all; check `mise run knip` before and after).
- [ ] **Step 5: Commit** `feat(ci): job context script exports TRACEPARENT and CI resource attributes`.

### Task 8: workflow trace builder

**Files:**
- Create: `scripts/ci/workflow-trace.ts`
- Test: `test/scripts/ci/workflow-trace.test.ts`

**Interfaces:**
- Consumes: Task 6 ids, `ApiJob`/`ApiStep` (Task 7).
- Produces:
  - `type ApiRun = { id: number; run_attempt: number; name: string; event: string; status: string; conclusion: string | null; created_at: string; run_started_at: string | null; updated_at: string; html_url: string; head_branch: string | null; head_sha: string; repository: { full_name: string; html_url: string } }`.
  - `ciResource(run: ApiRun): Record<string, string>`: the Global Constraints resource keys plus `service.name = run.name`, `service.namespace = repository.full_name`, `service.instance.id = "<id>/<attempt>"`.
  - `workflowTraceRequest(run: ApiRun, jobs: ApiJob[], approximate: ReadonlySet<number>): object` returning an OTLP JSON `ExportTraceServiceRequest` (one `resourceSpans`, scope `otel-html-ci`), with: the run span (`name = run.name`, `kind = SERVER`, start `run_started_at ?? created_at`, end `updated_at`, attributes `cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.result` (conclusion mapped: success→`success`, failure→`failure`, cancelled→`cancellation`, timed_out→`timeout`, skipped→`skip`, else `error`), `cicd.pipeline.run.url.full`, `github.event`, `github.run_number`? no (not in `ApiRun`; keep to the listed fields); one job span per job (`name = job.name`, parent the run span, id `jobSpanIdOf(key, approximate.has(job.id) ? 'name:'+job.name : job.id)`, attributes `cicd.pipeline.task.name`, `cicd.pipeline.task.run.id`, `cicd.pipeline.task.run.result`, `cicd.pipeline.task.run.url.full`, `cicd.worker.name = runner_name`, `github.job.id`, and `otel_html.ci.parent_approximate = true` when approximate); one `queued` span per job from `created_at` to `started_at` when both exist; one step span per step (`stepSpanIdOf`, parent the job span, `cicd.pipeline.task.name = step.name`, `github.job.step.number`). Status `ERROR` with the conclusion as message when the result is not `success`/`skip`. A missing `completed_at` on a step or job ends at the job's `completed_at`, else the run's `updated_at`; an end before its start is clamped to the start.

- [ ] **Step 1: Write the failing tests** on a two-job fixture (one with a cancelled step lacking `completed_at`): span count = 1 + 2 jobs + 2 queued + steps; the run span's `traceId` equals `traceIdOf(runKey(...))` and its `spanId` equals `runSpanIdOf`; each job's `parentSpanId` is the run span; the cancelled step's end equals the job's `completed_at` and its status is `ERROR`/`cancellation`; an approximate job's span id is `jobSpanIdOf(key, 'name:<name>')`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** (times as decimal nanosecond strings: `BigInt(Date.parse(s)) * 1_000_000n`). **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): build the workflow run trace from the jobs API`.

### Task 9: `scripts/ci-report.ts` entry point and the per-job summary

**Files:**
- Create: `scripts/ci/summary.ts` (pure), `scripts/ci-report.ts` (entry point)
- Test: `test/scripts/ci/summary.test.ts`

**Interfaces:**
- Consumes: Tasks 6, 8 (and 10, 11 once they exist: the entry point calls `jobLogRecordsRequest` and `ciMetricsRequest`, which Tasks 10 and 11 add; until then those calls are absent).
- Produces:
  - `summaryTable(run: ApiRun, jobs: ApiJob[], reportUrl: string | null): string`: GitHub-flavoured markdown: a heading with the run's conclusion and a link to `run.html_url`, a table `Job | Result | Queued | Duration` (durations as `1m 23s`), and a line "Report: <url>" or "Report: see the `ci-run-report` artifact" when `reportUrl` is null.
  - `scripts/ci-report.ts --run-id <n> --repository <owner/repo> --artifacts <dir> --out <dir> [--config <file>]`: fetches the run (`GET /repos/{r}/actions/runs/{id}`), its jobs (attempt from the run, paginated), each job's log (`GET /repos/{r}/actions/jobs/{id}/logs`, following the redirect; a 404 or non-2xx is a `::warning::` and the job has no logs); determines `approximate` as the set of job ids whose artifact folder is missing a `context.json` marker with `approximate: false` (see Task 14: `ci-context.ts` writes `.otel-html/context.json`), writes `<out>/../workflow-trace/` with `Report.create` + `addSpans` (+ `addLogs`, `addMetrics` when Tasks 10–11 land) + `close`; then `merge({ inputs: [workflowTrace, ...every <artifacts>/otel-html-*/report and /pr-build folder that holds data/manifest.js], out, config, replace: true })`; appends `summaryTable` to `$GITHUB_STEP_SUMMARY` when set and prints it to stdout. Exit 1 on a failed merge, 0 otherwise.

- [ ] **Step 1: Write the failing tests** for `summaryTable`: contains `| e2e (webkit) | success | 12s | 4m 05s |`, the heading contains the conclusion, the artifact line appears when `reportUrl` is null.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement both files** (argument parsing with `node:util` `parseArgs`). **Step 4: Run to verify pass; `mise run check`.**
- [ ] **Step 5: Commit** `feat(ci): publisher script merges job reports with the workflow trace`.

### Task 10: job logs as log records

**Files:**
- Create: `scripts/ci/job-logs.ts`
- Modify: `scripts/ci-report.ts` (call it)
- Test: `test/scripts/ci/job-logs.test.ts`

**Interfaces:**
- Consumes: Task 6 ids, `ApiJob` (Task 7), `ciResource` (Task 8).
- Produces: `jobLogRecordsRequest(i: { key: string; jobId: number | string; job: ApiJob; text: string; resource: Record<string, string> }): object` (OTLP JSON `ExportLogsServiceRequest`, scope `otel-html-ci`). Per line: a leading `YYYY-MM-DDTHH:MM:SS.fffffffZ ` is the time (`timeUnixNano`, 100 ns units kept); the rest is the body. A line with no timestamp appends to the previous record's body with `\n`. Prefixes `##[error]`, `##[warning]`, `##[debug]`, `##[group]`, `##[endgroup]`, `##[command]`: severity ERROR (17), WARN (13), DEBUG (5); INFO (9) otherwise; `##[group]<title>` opens a group whose `title` becomes the `log.group` attribute of the following records until `##[endgroup]`, and the marker lines themselves are not records. Every record carries `traceId = traceIdOf(key)`, `spanId` of the step whose `[started_at, completed_at]` contains the time (else the job span), and attribute `cicd.pipeline.task.run.id = <step number>` when attributed to a step.

- [ ] **Step 1: Write the failing tests** with a nine-line fixture (group open, two info lines, a warning, a continuation line, endgroup, an error in a second step's window): record count, severities, group attribute, continuation joined, step attribution, a trailing empty line ignored.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Wire into `ci-report.ts` and run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): job logs become log records in the run report`.

### Task 11: CI metrics

**Files:**
- Create: `scripts/ci/metrics.ts`
- Modify: `scripts/ci-report.ts` (call it)
- Test: `test/scripts/ci/metrics.test.ts`

**Interfaces:**
- Consumes: `ApiRun`, `ApiJob`, `ciResource`.
- Produces: `ciMetricsRequest(run: ApiRun, jobs: ApiJob[], resource: Record<string, string>): object` (OTLP JSON `ExportMetricsServiceRequest`, scope `otel-html-ci`), all points at `run.updated_at`, delta temporality, explicit bounds `[1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600]` seconds, unit `s`:
  - `cicd.pipeline.run.duration` histogram, one point, attributes `cicd.pipeline.name`, `cicd.pipeline.result`.
  - `cicd.pipeline.task.run.duration` histogram, one point per job, attributes `cicd.pipeline.task.name`, `cicd.pipeline.task.run.result`.
  - `cicd.pipeline.task.run.queue.duration` histogram, one point per job with both `created_at` and `started_at`, attribute `cicd.pipeline.task.name`.
  - `cicd.pipeline.run.errors` sum (monotonic, delta), one point per non-success job, attributes `cicd.pipeline.name`, `error.type = <conclusion>`; absent when every job succeeded.

- [ ] **Step 1: Write the failing tests**: metric names present; the task duration histogram has `count: "1"`, `sum` equal to the job's seconds, and the right bucket count; the errors sum is absent for an all-green run and has `asInt: "1"` for a failed job.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Wire into `ci-report.ts`; run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): CI/CD duration and error metrics per run`.

### Task 12: the CI dashboard config

**Files:**
- Create: `.github/otel-html-ci.yaml`
- Test: `test/config/ci-dashboard.test.ts`

**Interfaces:**
- Consumes: `loadConfigFile` (`src/config/load.ts`) and `resolveConfig` (`src/config/resolve.ts`), as `test/config/load.test.ts` uses them.
- Produces: a config with `title: CI`, `viewer.home: dashboards`, `viewer.defaultDashboard: ci`, dashboard `ci` ("CI") with variables `cicd.pipeline.run.id` (label "run") and `cicd.pipeline.task.name` (label "job"), widgets on the 12-column grid: `timeline` (0,0,12,6); `metric` "Job duration" (0,6,12,8) with query `a`: `metric: cicd.pipeline.task.run.duration`, `show: avg`, `by: [cicd.pipeline.task.name]`, `display: lines`; `metric` "Queue time" (0,14,6,8) on `cicd.pipeline.task.run.queue.duration`, `show: avg`, `by: [cicd.pipeline.task.name]`; `toplist` "Slowest steps" (6,14,6,8) `signal: spans`, `groupBy: name`; `traces` "Runs" (0,22,6,10) `mode: traces`, `query: span.parent_span_id.string == ""` (the span context's root test, `src/ottl/contexts.ts:138`); `logs` "Warnings and errors" (6,22,6,10) `query: severity_number >= 13`.

- [ ] **Step 1: Write the failing test**: loading and resolving the file yields no errors, `viewer.defaultDashboard === 'ci'`, `viewer.home === 'dashboards'`, the `ci` dashboard has six widgets and two variables.
- [ ] **Step 2: Run to verify failure.** **Step 3: Write the YAML.** **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(ci): CI dashboard config for the run report`.

### Task 13: `ci.yml` collects a report per job

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/ci-context.ts` (also write `.otel-html/context.json` `{ jobId, approximate }`, used by Task 9)

**Interfaces:**
- Consumes: Task 7's entry point, the M0 `run`.

- [ ] **Step 1: Edit the workflow**:
  - top-level `permissions: { contents: read, actions: read }`.
  - In every job, right after `./.github/actions/setup`: a step `shell: bash` named "Build otel-html" running `mise run build` in `check`, `unit-os`, `build` and `binary` (the custom shell needs `dist/` before the first wrapped step starts, so `build`'s own `check:package` step cannot be the one that creates it; `e2e` and `e2e-metrics-scale` download `dist` instead), then a step `shell: bash` named "otel-html context" running `bun scripts/ci-context.ts` with `env: GITHUB_TOKEN: ${{ github.token }}`. In `binary`, drop the now-redundant `mise run build` step.
  - Job-level `defaults: run: shell: node dist/cli/main.js run -o .otel-html/report -- bash --noprofile --norc -eo pipefail {0}` on every job (on `unit-os` the same line; Windows runners have `bash` on `PATH`, and `node` resolves through mise's shims; if the Windows run shows otherwise, `unit-os` falls back to `shell: bash` with an explicit `node dist/cli/main.js run … -- mise run test:unit` step and a comment saying why).
  - Steps that run before "Build otel-html" (none today except `uses:` steps) keep `shell: bash` explicitly if any are added.
  - `e2e`: replace the explicit `node dist/cli/main.js run -o ci-report/… -- mise run --skip-deps test:e2e …` with the bare `mise run --skip-deps test:e2e -- --project '…'` under the default shell, drop the `ci-report-<project>` upload, and keep the other uploads.
  - Every job ends with `if: always()` `actions/upload-artifact` (same pinned SHA as the file uses) `name: otel-html-${{ github.job }}${{ matrix.project && format('-{0}', matrix.project) || '' }}${{ matrix.target && format('-{0}', matrix.target) || '' }}${{ matrix.os && format('-{0}', matrix.os) || '' }}`, `path: .otel-html/`, `include-hidden-files: true`, `if-no-files-found: ignore`.
  - Add `.otel-html/` to `.gitignore`.
- [ ] **Step 2: Verify**: `mise run lint` (actionlint) passes. Push the branch and open a draft PR; every job must still pass and each must upload an `otel-html-*` artifact; download one and confirm `data/manifest.js` has `complete: true` and the root spans' trace id equals `traceIdOf(runKey(...))` for that run (compute with `bun -e` using Task 6).
- [ ] **Step 3: Commit** `ci: every job writes an otel-html report under the run's trace`.

### Task 14: the `ci-report.yml` publisher

**Files:**
- Create: `.github/workflows/ci-report.yml`

**Interfaces:**
- Consumes: Task 9's entry point, Task 12's config, Task 13's artifacts.

- [ ] **Step 1: Write the workflow**:
  - `on: workflow_run: { workflows: [ci], types: [completed] }`; `permissions: { contents: read, actions: read }`; `concurrency: { group: ci-report-${{ github.event.workflow_run.id }}, cancel-in-progress: false }`; `env: MISE_DISABLE_TOOLS: claude`.
  - One job `report` on `ubuntu-latest`, `timeout-minutes: 15`: checkout (pinned SHA as in `ci.yml`), `./.github/actions/setup`, `mise run build`, `actions/download-artifact` (pinned SHA) with `run-id: ${{ github.event.workflow_run.id }}`, `github-token: ${{ github.token }}`, `pattern: otel-html-*`, `path: artifacts/`; then `bun scripts/ci-report.ts --run-id "$RUN_ID" --repository "$GITHUB_REPOSITORY" --artifacts artifacts --out ci-run-report --config .github/otel-html-ci.yaml` with `env: { GITHUB_TOKEN: ${{ github.token }}, RUN_ID: ${{ github.event.workflow_run.id }} }`; `actions/upload-artifact` `name: ci-run-report`, `path: ci-run-report/`, `include-hidden-files: true`, `if-no-files-found: error`.
- [ ] **Step 2: Verify**: `mise run lint` passes. After the draft PR's `ci` completes, the `ci-report` run on `main`… note: a `workflow_run` workflow runs from the default branch's copy of the file, so it only exists after this PR merges. Until then, verify by `workflow_dispatch`: add `workflow_dispatch: { inputs: { run_id: { required: true } } }` to the trigger and use `${{ github.event.inputs.run_id || github.event.workflow_run.id }}` for the run id; dispatch it from the PR branch against the PR's `ci` run id (`gh workflow run ci-report.yml --ref <branch> -f run_id=<id>`). The `ci-run-report` artifact must open on the CI dashboard with the job-duration chart showing every job, the trace of the run with jobs and steps, and the Logs explorer holding the job logs.
- [ ] **Step 3: Commit** `ci: publish one merged report per workflow run`.

### Task 15: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1**: Add a "CI" subsection under the `run` section or near "Report layout and hosting": how this repo instruments its own CI (custom shell, `scripts/ci-context.ts`, the `workflow_run` publisher, the `ci-run-report` artifact, the CI dashboard), two paragraphs and the shell line, with a sentence that a reusable action is the next milestone.
- [ ] **Step 2: Commit** `docs: how CI reports on itself`.

---

## Self-review notes

- Spec coverage: §6.2 → Tasks 1–3, 6–7; §6.3 trace/logs/metrics/resource → Tasks 8, 10, 11, 7; §6.7 contract → Tasks 4–5; §6.10 first form → Task 12; §6.1 collection mechanics → Task 13; publisher (M1 scope, no Pages) → Tasks 9, 14. §6.4–6.6, 6.9 and the second-form dashboard are M2+ and out of this plan.
- Collection always uses the code at the SHA under test (`mise run build` + `node dist/cli/main.js`), per spec §6.1; the publisher runs `main`'s build (workflow_run checks out the default branch, and must for fork PRs).
- Types: `ApiJob`/`ApiStep` are defined once in Task 7 and consumed by 8–11; `runKey`/`*IdOf` names are the same everywhere; `approximate` is a `ReadonlySet<number>` of job ids in Task 8 and the publisher derives it from `context.json` (Task 9/13).
- Open to the builder: the exact OTTL root-span condition for the "Runs" widget (Task 12); whether knip needs the new entry points listed; the Windows shell line (Task 13, with the fallback stated).
