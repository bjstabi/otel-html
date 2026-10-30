# otel-html open issues #70–#76 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open issue (#70–#76) in four pull requests, each closing its issues whole, opened and squash-merged unattended once CI is green.

**Architecture:** The writer session gains an idle timer (a `Timers` port, so tests drive it) and stops letting a background checkpoint's failure reach the request that triggered it. The gRPC transport gains a server interceptor that reserves budget on call start, before grpc-js buffers the message, plus Node's per-session HTTP/2 memory cap. The load job prints event-loop and GC stall figures and the receiver's V8 flags move to process start. The rest is test calibration and the small cleanups left from #69.

**Tech Stack:** unchanged (TypeScript, vitest, commander, `@grpc/grpc-js` 1.14.6, `@bufbuild/protobuf`). No new dependencies.

**Spec:** the issues are the spec; their text is quoted where it fixes a value. The decisions taken in the brainstorm (2026-10-30) are recorded in the PR sections below. Conventions: `docs/superpowers/plans/2026-10-30-otel-html-m5-followups.md` and the earlier plans.

## Pull requests

The repository squash-merges: **the PR title is the conventional commit** that lands on `main` and that release-please reads; the PR body carries `Fixes #N` lines (one per issue) and any extra conventional-commit lines release-please should see.

| PR | Branch | Title (the squash commit) | Issues | Tasks |
|---|---|---|---|---|
| 1 | `fix/writer-idle-checkpoint` | `fix(writer): checkpoint an idle receiver, and a failed interval checkpoint no longer fails the request that triggered it` | #70, #71, #72 | 1–4 |
| 2 | `fix/grpc-global-admission` | `fix(receiver): bound gRPC memory across connections: admission on call start, before the message is buffered` | #75 | 5–7 |
| 3 | `ci/load-stall-diagnostics` | `ci(load): print event-loop and GC stall figures; set the receiver's V8 flags at process start` | #73 | 8–10 |
| 4 | `test/perf-calibration-and-69-cleanups` | `test: calibrate the unit perf budgets to the runner; the cleanups left from #69` | #74, #76 | 11–12 |

**Order:** 1 → 2 → 3 → 4, each branched from `main` after the previous one merged. PR 2 is independent of PR 1 but 3 and 4 both touch `src/cli/main.ts` and `src/cli/commands/receive.ts` (PR 3 removes `favourShortPauses`; PR 4 moves `CliDeps`), so they stay sequential.

## PR process (unattended)

- **Implementers and per-task reviewers:** Sonnet subagents. **Whole-branch review:** Opus (the maintainer's standing preference). Reviews are on the branch, before the PR is opened.
- **Merging:** once a PR's CI is green and the branch review found nothing blocking, **squash-merge it without waiting for the maintainer**: `gh pr merge <n> --squash --delete-branch` with the PR title as the commit subject and the body as its message; then branch the next PR from the updated `main`. A red CI is fixed on the branch, never merged around. The one exception is a decision this plan leaves open (Task 5's fallback); stop and ask then.
- **New findings:** anything found on the way is fixed inline in the PR that found it and listed in its body under "Also". Only something that would change a public interface or needs a measurement the PR cannot make gets a new issue (`gh issue create`), linked from the body.
- Each PR body carries `Fixes #N` for every issue it closes and, per issue, what changed and what was decided against (an issue with options is closed by naming the option taken).

## Global Constraints

Everything in the M1–M5 plans' Global Constraints still applies:

- No `any`, no non-null assertions, exhaustive `switch` via `never`, typed `OtelHtmlError`s. Biome strict at error. `mise run check` under 60 s; receiver tests bind port 0 on `127.0.0.1` and close servers in `afterEach`.
- `src/receiver/signals.ts`, `status.ts` and `src/run/root-span.ts` stay free of `node:*` imports.
- Public API (`src/api/index.ts`) changes only where a task says so: `WriterDeps` gains `timers: Timers` (Task 1, exported from `ports.ts` like `Clock`). Nothing else new is exported.
- TDD per task: the failing test first, run it, implement, run it, commit. Before each commit run `pnpm exec biome check .` and `mise run typecheck` by hand, never through a pipe that hides the exit status. Each commit message ends with the session's `Co-Authored-By` and `Claude-Session` trailers.
- Test commands: a single file is `pnpm exec vitest run <file>`; `@perf` tests run only with `OTEL_HTML_PERF_PASS=1`.

## Review Focus

1. **A burst of spans, then 5 s of silence, then the process is killed.** Expected after PR 1: the report on disk holds the burst. Pinned in Task 1 (the `serve` test).
2. **A library caller calls `report.flush()` right after an idle checkpoint already ran.** Expected: the manifest lists each chunk once. Pinned in Task 1 (`flush after the idle checkpoint lists each chunk once`).
3. **One OTel exporter over one gRPC connection with the default budget.** Expected after PR 2: two calls still proceed concurrently (no throughput regression from the start-time reservation). Pinned in Task 6.
4. **A gRPC client that starts a call and never sends the message (deadline, cancel).** Expected: its reservation is released, the next call is admitted. Pinned in Task 6.
5. **A perf test on a slow or loaded machine.** Expected after PR 4: the budget scales by the measured runner factor, never below 1, and `OTEL_HTML_PERF_FACTOR` still multiplies on top. Pinned in Task 11.

---

## File structure

```
src/writer/ports.ts                    (modify) Timers port
src/writer/session.ts                  (modify) idle timer; #maybeCheckpoint and #writeCheckpoint error paths
src/api/report.ts                      (modify) defaultDeps().timers
test-support/fake-timers.ts            (new)    createFakeTimers()
test-support/writer-deps.ts            (modify) TestWriter.timers
test/writer/idle-checkpoint.test.ts    (new)
test/writer/background-checkpoint.test.ts (modify) #71 tests; #76 sleep and titles
test/cli/serve.test.ts                 (modify) idle checkpoint through serve
src/receiver/grpc.ts                   (modify) admission interceptor; grpc-node.max_session_memory
test/receiver/grpc.test.ts             (modify)
scripts/load-receiver.ts               (modify) stall preload, LOAD line
scripts/load-receiver-plan.ts          (modify) parseStallStats
test/scripts/load-receiver-plan.test.ts (modify)
src/cli/main.ts                        (modify) flags at start; CliDeps.favourShortPauses removed
src/cli/commands/receive.ts            (modify) favourShortPauses removed; CliDeps moves out (PR 4)
src/cli/program.ts                     (modify) CliDeps lives here (PR 4)
test-support/calibrate.ts              (moved from e2e/calibrate.ts)
test-support/perf-factor.ts            (new)    PERF_FACTOR, runnerFactor()
test/perf-factor.test.ts               (new)
test/viewer/{log-query,log-body,metric-query,span-query}.test.ts(x), test/rollups/drain.test.ts (modify) import PERF_FACTOR
test/viewer/metric-scaling.test.ts     (modify) explicit timeouts
tsconfig.e2e.json, .github/workflows/ci.yml (modify)
src/format/trace-shard.ts, src/writer/trace-index.ts, test/writer/trace-index.test.ts (modify) readonly chunks; untouched-shard test
README.md, CHANGELOG (via the PR body)   (modify)
```

---

# PR 1 — writer checkpoints (#70, #71, #72)

### Task 1: An idle session checkpoints by itself (#70)

**Files:**
- Modify: `src/writer/ports.ts`, `src/writer/session.ts:338-400` (fields, constructor), `:422-510` (add/addRecords/endInput/flush/close/abort), `:836-862` (`#maybeCheckpoint`), `src/api/report.ts:40-58` (`defaultDeps`), `test-support/writer-deps.ts`
- Create: `test-support/fake-timers.ts`, `test/writer/idle-checkpoint.test.ts`
- Modify: `test/cli/serve.test.ts`
- README: the `writer.flushIntervalMs` row (line ~317) and the paragraph at line ~193 (Task 4 edits the same paragraph; do both there if Task 4 is done in the same sitting, otherwise here).

**Interfaces:**
- Produces, in `ports.ts`: `export interface Timers { after(ms: number, fn: () => void): () => void }` (the return cancels; a fired or cancelled timer's cancel is a no-op). `WriterDeps` gains `timers: Timers`.
- Produces, in `test-support/fake-timers.ts`: `export function createFakeTimers(): Timers & { fire(): number; readonly pending: number }`: `fire()` runs every armed callback once, in arming order, and returns how many ran; callbacks armed while firing wait for the next `fire()`.
- `createTestWriter` wires a fake and exposes it as `TestWriter.timers`.
- `defaultDeps().timers`: Node `setTimeout` with `.unref()` (an idle session must not keep a process alive), cancel = `clearTimeout`.

Session design (the implementer writes the bodies):
- `#sinceCheckpoint = false`: set true in `add`/`addRecords` when `result.accepted > 0`, cleared at the end of `#prepareCheckpoint`.
- `#cancelIdle: (() => void) | null`. `#armIdle()`: cancel any armed timer, then if `#sinceCheckpoint` and the session is open, arm `timers.after(flushIntervalMs, () => this.#serial(() => this.#idleCheckpoint()))`. Called at the end of `add`, `addRecords` and `endInput` (after `#maybeCheckpoint`).
- `#idleCheckpoint()`: return if closed/aborted or `!#sinceCheckpoint`; if `#inflight !== null` or `#partial`, re-arm and return; else start a background checkpoint exactly as `#maybeCheckpoint` does, ignoring the interval. Factor the prepare-and-write-in-background part of `#maybeCheckpoint` into `#startBackgroundCheckpoint(): Promise<void>` and call it from both.
- `close()` and `abort()` cancel the timer first.
- Rewrite the comment at `session.ts:838-842`: interval checkpoints are evaluated inside `add` and, after `writer.flushIntervalMs` of silence with new records, by the idle timer; `flush()` is still the only point at which the report on disk is known to be current.

- [ ] **Step 1:** Write `test/writer/idle-checkpoint.test.ts` (reuse `background-checkpoint.test.ts`'s `config`, `one`, `makeDue`, `heldCheckpoint` by exporting them from a `test/writer/checkpoint-helpers.ts` or duplicating the three short ones; your call):
  - `'a session with new records checkpoints when the idle timer fires'`: add one span (interval not due), `expect(w.timers.pending).toBe(1)`, `expect(w.timers.fire()).toBe(1)`, `await vi.waitFor(() => expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(true))`, manifest totals `{ spans: 1 }`.
  - `'flush after the idle checkpoint lists each chunk once'`: as above, then `await s.flush()`; `manifestOf(w, OUT).chunks.map((c) => c.n)` equals `[0]`.
  - `'nothing new since the last checkpoint arms no timer'`: add, `flush()`, `expect(w.timers.pending).toBe(0)`.
  - `'the timer fired during a background write re-arms'`: `heldCheckpoint()`, add a third span, `fire()` returns 1, `expect(w.timers.pending).toBe(1)`; release the gate, `fire()`, waitFor totals `{ spans: 3 }`.
  - `'close cancels the timer'`: add, `close()`, `pending` is 0.
- [ ] **Step 2:** Run it; fails (`timers` missing / `pending` undefined).
- [ ] **Step 3:** Implement the port, fake, `defaultDeps`, `createTestWriter` and the session changes above. `mise run typecheck` finds every hand-built `WriterDeps` in tests (`grep -rn "clock:" test test-support`); give each `timers: createFakeTimers()`.
- [ ] **Step 4:** Run the file and `test/writer`; pass.
- [ ] **Step 5:** In `test/cli/serve.test.ts` add `'a burst followed by silence reaches the report before SIGINT'`: start `serve` over HTTP, POST one trace request (as the existing tests do), `w.timers.fire()`, `vi.waitFor` the manifest on `w.fs` with `totals.spans` ≥ 1, then SIGINT and the usual finish. Run; pass.
- [ ] **Step 6:** README edits above. `pnpm exec biome check .`, `mise run typecheck`, commit — `fix(writer): checkpoint an idle session after flushIntervalMs (#70)`.

### Task 2: A failed interval prepare does not fail the triggering request (#71.1)

**Files:**
- Modify: `src/writer/session.ts` (`#maybeCheckpoint` / `#startBackgroundCheckpoint`), `test/writer/background-checkpoint.test.ts`

**Interfaces:**
- Consumes: `createMemoryFileSystem().failNextWrite(pathSuffix)` (exists, `test-support/memory-fs.ts:42`) and the test logger's entries in `w.logs` (`LogEntry[]`, `test-support/writer-deps.ts:34`).

Design: `#startBackgroundCheckpoint` wraps `#prepareCheckpoint(false)` in try/catch; on failure it sets `#lastFlushMs = clock.monotonicMs()` and logs `'checkpoint failed; will retry at the next flush'` with `{ error }` (the same message the write path uses) and returns normally. The caller's `add` resolves with its `AddResult`.

- [ ] **Step 1:** Test `'a failed interval prepare is logged and does not fail the add that triggered it'`: config as the file's, two spans with `makeDue` before the second; `w.fs.failNextWrite('chunks/spans/000001.js')` (the chunk the prepare drains; read the actual suffix from a passing run first) before the second add; `await expect(s.add(one(1, 2), 'b.json')).resolves.toMatchObject({ accepted: 1 })`; `w.logs` has one `error` whose message is `'checkpoint failed; will retry at the next flush'`; a third add straight after (interval not due) does not retry (`w.logs` still has one error and the snapshot has no manifest); `makeDue`, a fourth add, `vi.waitFor` manifest totals `{ spans: 4 }`.
- [ ] **Step 2:** Run; fails (the add rejects).
- [ ] **Step 3:** Implement. **Step 4:** Run `test/writer`; pass.
- [ ] **Step 5:** Commit — `fix(writer): a failed interval checkpoint prepare no longer fails the request that triggered it (#71)`.

### Task 3: Telemetry after commit cannot undo the bookkeeping (#71.2)

**Files:**
- Modify: `src/writer/session.ts:948-985` (`#writeCheckpoint`), `test/writer/background-checkpoint.test.ts`

Design: after `writeManifest`, move the bookkeeping (`#slot`, `#committed.push`, `#everCommitted`, `#lastFlushMs`) ahead of `p.span.setAttributes(...)`, and put `setAttributes` in its own try/catch that logs `logger.warn('flush telemetry failed', { error })`. The outer catch now only sees failures before commit.

- [ ] **Step 1:** Test `'a tracer that throws after the manifest is written does not list chunks twice'`: `createTestWriter` with a tracer whose span's `setAttributes` throws for spans named `otel-html.flush`; two interval checkpoints (add, `makeDue`, add, `vi.waitFor` manifest, add, `makeDue`, add, waitFor); `await s.flush()` resolves; `manifestOf(w, OUT).chunks.map((c) => c.n)` has no duplicates and equals the sorted chunk numbers; the logger has `warn` entries, no `error`.
- [ ] **Step 2:** Run; fails (duplicates, or `flush` rejects). **Step 3:** Implement. **Step 4:** Run `test/writer`; pass.
- [ ] **Step 5:** Commit — `fix(writer): flush telemetry errors after commit cannot undo the chunk bookkeeping (#71)`.

### Task 4: Docs: `flush()` is the only point the report on disk is current (#72)

**Files:**
- Modify: `README.md` (library section paragraph at ~193 that lists `flush()`; the `writer.flushIntervalMs` row)

- [ ] **Step 1:** Add to the `flush()` sentence: "Interval checkpoints (every `writer.flushIntervalMs`, and after that long idle) are written in the background, so after `add*` resolves the report on disk may lag; `flush()` (or `close()`) is the only point at which the report on disk is known to be current. Crash safety does not depend on it: a report is always readable at its last checkpoint."
- [ ] **Step 2:** The PR body carries a second conventional-commit paragraph for release-please: `docs(api): flush() is the only point at which the report on disk is current; interval checkpoints are written in the background`.
- [ ] **Step 3:** Commit — `docs(api): flush() is the only point the report on disk is current (#72)`.

**PR 1 done when:** body has `Fixes #70`, `Fixes #71`, `Fixes #72`; CI green; merged.

---

# PR 2 — gRPC memory across connections (#75)

**Decision (brainstorm, A + C):** a grpc-js server interceptor reserves `maxBodyBytes` from the receiver's in-flight budget when a call *starts* (headers), before grpc-js buffers its message, and refuses with the receiver's existing `busy` outcome (`UNAVAILABLE` + RetryInfo, the same thing the HTTP path's 503 maps to; the issue's `RESOURCE_EXHAUSTED` is answered in the PR body: OTLP clients retry both, and `busy` keeps one outcome and one counter). When the message arrives the reservation is released and the handler admits the real size as it does today. Alongside, `grpc-node.max_session_memory` makes the per-connection ceiling something Node's HTTP/2 layer enforces. Option B (a handler-level count, after buffering) is the fallback only if Task 5 shows interceptors run after buffering; then the PR ships C plus docs and **leaves #75 open** with the finding.

### Task 5: Spike: does an interceptor's `start` run before the message is buffered?

Throwaway, not committed (keep it under `$CLAUDE_JOB_DIR/tmp` or an untracked `spike/` dir).

- [ ] **Step 1:** A script: `listenGrpc`-like server (`new Server({ interceptors: [i] })`) where `i` returns a `ServerInterceptingCall` whose `start` sends `UNAVAILABLE` and never calls `next`; a client sends one 60 MB message (`maxBodyBytes` 64 MiB) 20 times sequentially. Print the server's `process.memoryUsage().rss` before and after, and whether the handler ran.
- [ ] **Step 2:** Same without the interceptor (handler refuses). Compare: with the interceptor the RSS growth is bounded by the HTTP/2 flow-control window (tens of KB to a few MB), not by 20 × 60 MB peaks.
- [ ] **Step 3:** Record the two numbers in the PR body. If the interceptor path still buffers the body, stop here, ship C + docs (Task 7 only, body says "A not possible: …"), and **ask the maintainer** before closing #75.

### Task 6: Admission on call start (A)

**Files:**
- Modify: `src/receiver/grpc.ts` (`listenGrpc`, new `admissionInterceptor`), `test/receiver/grpc.test.ts`

**Interfaces:**
- Produces: `function admissionInterceptor(receiver: Receiver, options: GrpcTransportOptions, logger: Logger): ServerInterceptor` (module-private; `listenGrpc` passes `interceptors: [admissionInterceptor(...)]` to `new Server`).
  - `start`: `const admission = receiver.admit(options.maxBodyBytes)`; null → `receiver.refused('busy', 'receiver is busy: a new call would exceed the in-flight budget')`, `call.sendStatus(failure(new ReceiverRejected('busy', …), logger))` (reuse `failure`), do not call `next`.
  - Otherwise `next` with a listener whose `onReceiveMessage`, `onReceiveHalfClose` and `onCancel` each call `admission.release()` (idempotent) before delegating.
- The handler is unchanged: `too-large` check, then `receiver.admit(call.request.length)`.

- [ ] **Step 1:** Tests in `grpc.test.ts` (the file's `fake`, `clientFor`, `realServer` helpers; a client made with `{ 'grpc.use_local_subchannel_pool': 1 }` gets its own connection instead of the shared subchannel pool, so two such clients are two connections):
  - `'a call on a second connection is refused busy while a call on the first holds the budget'`: options `{ maxBodyBytes: 1_000_000, inflightBudgetBytes: 1_000_000 }`; a `fake` whose `receive` awaits a deferred; call 1 on client A (small message) → in flight; call 2 on client B → error `status.UNAVAILABLE` with RetryInfo in `grpc-status-details-bin` (as the existing busy test decodes it); `refused.busy === 1`; `receive` was called once. Resolve the deferred; call 1 succeeds; a third call on client B now succeeds.
  - `'two calls on one connection still proceed together under the default-sized budget'`: options `{ maxBodyBytes: 1_000, inflightBudgetBytes: 2_000 }`; two concurrent calls on the same client against a fake that holds both; both reach `receive` (`receive` called twice before either resolves).
  - `'a call cancelled before its message releases the reservation'`: options as the first test; client A calls with `{ deadline: Date.now() + 50 }` against a fake that never resolves... — a message is sent at once by a unary call, so use instead a client that sends headers only: not expressible with the generic client. **Decision:** test the listener directly: construct the interceptor, call it with a stub `ServerInterceptingCallInterface` whose `start(listener)` is captured, invoke `listener.onCancel()`, then `receiver.admit(budget)` returns non-null. One test, no network.
- [ ] **Step 2:** Run; fail (no interceptor: the second call is admitted). **Step 3:** Implement. **Step 4:** Run `test/receiver`; pass.
- [ ] **Step 5:** Commit — `fix(receiver): reserve the in-flight budget when a gRPC call starts, before its message is buffered (#75)`.

### Task 7: Per-session memory cap (C) and docs

**Files:**
- Modify: `src/receiver/grpc.ts:116-119`, `README.md` Limits (the gRPC bullet at ~350; the `inflightBudgetBytes` row at ~332), `docs/superpowers/specs/2026-10-29-otel-html-m5-design.md` §5 if it describes the per-connection bound.

- [ ] **Step 1:** Server option `'grpc-node.max_session_memory': Math.ceil((GRPC_CEILING_FACTOR * options.maxBodyBytes * streams) / 2 ** 20) + 1` MiB, where `streams` is the computed `grpc.max_concurrent_streams` (hoist it into a const). No new test: the existing suite (including the 1×–2× `too-large` test) must stay green, which shows the cap sits above the per-connection ceiling.
- [ ] **Step 2:** README Limits gRPC bullet becomes: a call reserves `maxBodyBytes` of the in-flight budget when it starts, before its message is read, and is refused `UNAVAILABLE` (retryable, counted `busy`) when that would exceed the budget; so gRPC memory is bounded across connections by the budget plus one message up to twice `maxBodyBytes` (the grpc-js ceiling). Each connection is additionally capped by Node's HTTP/2 session memory at that ceiling × its stream limit.
- [ ] **Step 3:** `mise run check`; commit — `fix(receiver): cap each gRPC connection's HTTP/2 session memory; document the cross-connection bound (#75)`.

**PR 2 done when:** body has `Fixes #75`, the spike numbers, and the `RESOURCE_EXHAUSTED` vs `UNAVAILABLE` decision; CI green; merged.

---

# PR 3 — load job stall diagnostics and V8 flags at start (#73)

### Task 8: The load job prints event-loop delay and GC pauses

**Files:**
- Modify: `scripts/load-receiver.ts:26-27` (the preload), `:119-131` (the LOAD line), `scripts/load-receiver-plan.ts` (parser), `test/scripts/load-receiver-plan.test.ts`

**Interfaces:**
- The preload (`REPORT_RSS` → rename `PRELOAD`) also: `const { monitorEventLoopDelay, PerformanceObserver } = await import('node:perf_hooks')`; `const h = monitorEventLoopDelay({ resolution: 10 }); h.enable()`; a `PerformanceObserver` on `{ entryTypes: ['gc'] }` summing `entry.duration`, counting entries and keeping the max; on `exit` writes two lines to stderr: `LOOP p99 <ms> max <ms>` (nanoseconds ÷ 1e6, one decimal) and `GC count <n> total <ms> max <ms>`.
- `load-receiver-plan.ts`: `export interface StallStats { loopP99Ms: number; loopMaxMs: number; gcCount: number; gcTotalMs: number; gcMaxMs: number }`, `export function parseStallStats(stderr: string): StallStats | null` (null when either line is missing).
- The LOAD line: `LOAD receiver: spans N logs N in S s, peak RSS R MB, loop p99 X ms max Y ms, gc C pauses T ms max M ms` (or `, stalls not reported` when null).

- [ ] **Step 1:** Test `parseStallStats` on a two-line sample (`'LOOP p99 12.3 max 480.0\nGC count 152 total 3200.5 max 77.0\n'` → the object) and on `''` → null.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement preload, parser, LOAD line. **Step 4:** Run the test; pass. Also run the small version locally if Docker is available: `mise run build && mise run test:load:receiver -- --spans 2000 --logs 5000`; the LOAD line shows the figures.
- [ ] **Step 5:** Commit — `ci(load): print serve's event-loop delay and GC pause figures (#73)`.

### Task 9: The receiver's V8 flags are set at process start

**Files:**
- Modify: `src/cli/main.ts:9-22, 44-50`, `src/cli/commands/receive.ts:34-42, 74` (`CliDeps.favourShortPauses` removed), `test/cli/serve.test.ts:81-95`, `test/cli/run.test.ts:152-170`, `test/cli/program.test.ts:56-62` (the three `favour` tests removed; `beforeMetrics` tests stay), README Limits (~358: "`serve` and `run` set it when they start" → "set at process start")

Design: at the top of `main.ts`, before any import that allocates much (keep it right after the imports; ESM hoists them anyway): `const command = process.argv.slice(2).find((a) => !a.startsWith('-'))`; if `command === 'serve' || command === 'run'` and not under Bun, `v8.setFlagsFromString('--optimize-for-size --heap-growing-percent=40')`. `favourHeapSize` for `beforeMetrics` stays. Shorten the comment to what remains true (the #76 item): why the two flags, that they are set at start because the issue measured 473 MB at start vs 524 MB at runtime, and that the library sets none.

- [ ] **Step 1:** Delete the three tests; `mise run typecheck` names every `favourShortPauses` use. **Step 2:** Implement. **Step 3:** `mise run check`; pass. Binary smoke (`test/cli/binary.test.ts`) still covers `serve`/`run` start-up.
- [ ] **Step 4:** Commit — `perf(cli): set the receiver's V8 flags at process start (#73)`.

### Task 10: Measure on the branch, then record

- [ ] **Step 1:** `gh workflow run load.yml --ref ci/load-stall-diagnostics`, then `gh run watch` the run (30-minute ceiling). Read the `receiver` job's log: the LOAD line (RSS, loop p99/max, GC count/total/max), the runner's CPU model (`lscpu` step).
- [ ] **Step 2:** README Limits receiver bullet (~359): replace the RSS, date and runner with this run's, and add one sentence: the job prints the event-loop delay (p99 and max) and GC pauses, so a red run says why spans dropped. If the job is red: fix on the branch (the plan's Task 8/9 code, or the runner), re-dispatch; do not merge a red load run.
- [ ] **Step 3:** Commit — `docs: receiver load numbers with the V8 flags set at start (#73)`. PR body: `Fixes #73`, the run link, both numbers, and that the issue's "track the next daily runs" is now what the daily job does (the figures are in every run's log; a flake gets an issue with them).

---

# PR 4 — perf calibration and the #69 cleanups (#74, #76)

### Task 11: Unit perf budgets scale by the runner factor (#74)

**Files:**
- Move: `e2e/calibrate.ts` → `test-support/calibrate.ts` (update `e2e/global-setup.ts:10`; `tsconfig.e2e.json` `include` gains `"test-support/calibrate.ts"`)
- Create: `test-support/perf-factor.ts`, `test/perf-factor.test.ts`
- Modify: `test/viewer/log-query.test.ts:26`, `log-body.test.tsx:68`, `metric-query.test.ts:34`, `span-query.test.ts:22`, `test/rollups/drain.test.ts:14` (import `PERF_FACTOR` instead of defining it), `test/viewer/metric-scaling.test.ts:182, 206` (`{ timeout: 20_000 }` on both paged tests, with a comment: four fixture builds, 5.4 s seen on windows-latest), `.github/workflows/ci.yml` (`check` and `unit-os` jobs get `env: OTEL_HTML_PERF_REFERENCE_MS: "100"`, same comment as the e2e jobs)

**Interfaces:**
- `test-support/perf-factor.ts`: `export function runnerFactor(referenceMs: number | undefined, calibrationMs: number): number` = `referenceMs === undefined || referenceMs <= 0 ? 1 : Math.max(1, calibrationMs / referenceMs)`; `export const PERF_FACTOR: number` = `Number(process.env.OTEL_HTML_PERF_FACTOR ?? '1') * runnerFactor(reference, calibrationMs(5))`, computed once per process at module load, and one `process.stderr.write` line `PERF calibration: <ms> ms on <cpu> (factor <f>)\n` so a flaky run shows its factor.

- [ ] **Step 1:** `test/perf-factor.test.ts`: `runnerFactor(100, 85) === 1`, `runnerFactor(100, 150) === 1.5`, `runnerFactor(undefined, 150) === 1`.
- [ ] **Step 2:** Run; fails. **Step 3:** Implement and rewire the five files and the two timeouts. **Step 4:** `mise run test:unit` (both passes) and `mise run typecheck` (e2e project included); pass. `mise run lint` (actionlint) for ci.yml.
- [ ] **Step 5:** Commit — `test: scale the unit perf budgets by the runner factor; size the paged metric-scaling tests for Windows (#74)`.

### Task 12: The cleanups left from #69 (#76)

**Files:** per item.

- [ ] **`CliDeps`** moves to `src/cli/program.ts` next to the `CliIo` re-export; `receive.ts`, `main.ts` and the tests import it from there. (`favourShortPauses` is already gone after PR 3, which removes the `resolveDeps` oddity.)
- [ ] **Readonly chunks:** `src/format/trace-shard.ts` `TraceEntry.chunks` and `logChunks` become `readonly string[]`; `src/writer/trace-index.ts:14` `NO_CHUNKS: readonly string[] = Object.freeze([])`, the casts at `:140`, `:165` go, `#loadList` returns `readonly string[]`. `mise run typecheck` names any writer that pushes; each becomes a copy-and-assign.
- [ ] **Untouched-shard test** in `test/writer/trace-index.test.ts`: `'a shard untouched while a snapshot is held is not copied'`: entries in shards A and B; `snap1 = idx.snapshot()`, `a1 = snap1.entries(A).get(idA)`, `b1 = snap1.entries(B).get(idB)`; touch B's trace (add a span); `idx.release()`; `snap2 = idx.snapshot()`: `expect(snap2.entries(A).get(idA)).toBe(a1)` and `expect(snap2.entries(B).get(idB)).not.toBe(b1)`; release.
- [ ] **`payloadOf`** comment in `trace-index.test.ts:21`: say it takes and releases a snapshot, which clears the dirty set.
- [ ] **`background-checkpoint.test.ts`:** replace the 20 ms sleep at `:141` with `await setImmediate()` from `node:timers/promises` (a macrotask boundary: a held write cannot resolve `done` however long we wait, so one turn is the same proof); shorten the two titles over 120 columns (`:78`, `:109`).
- [ ] **`main.ts` comment:** done in PR 3; confirm it is under eight lines, else trim.
- [ ] Test titles saying "favours heap size": removed in PR 3; confirm `grep -rn "favour" test/cli` is empty.
- [ ] `mise run check`; commit — `chore: the cleanups left from #69 (#76)`.

**PR 4 done when:** body has `Fixes #74`, `Fixes #76`, each #76 bullet ticked or answered; CI green; merged.

---

## Self-review notes

- **Coverage:** #70 T1; #71 T2 (1), T3 (2); #72 T4; #73 T8–T10; #74 T11; #75 T5–T7; #76 T12 (two bullets land in T9 and are confirmed in T12).
- **Names used across tasks:** `Timers.after`, `createFakeTimers().fire/pending`, `TestWriter.timers` (T1, T2, T3 via `heldCheckpoint`); `#startBackgroundCheckpoint` (T1, T2); `admissionInterceptor` (T6, T7 hoists `streams`); `parseStallStats`/`StallStats` (T8, T10 reads its output); `runnerFactor`/`PERF_FACTOR` (T11).
- **Not done on purpose:** a global *stream* cap for gRPC (the issue's second option): the byte reservation at start subsumes it. Shrinking the trace index to a columnar layout (#73 step 2's alternative): only if the daily job flakes after the flags move; it would be a new issue with the run's figures.
