# otel-html M5 follow-ups Implementation Plan (issues #51–#61)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open issue (#51–#61) in five pull requests, each closing its issues whole, with no follow-up issues opened.

**Architecture:** The receiver core (`src/receiver/receiver.ts`) keeps owning admission and counting; the transports only learn to reserve budget before buffering and to count what grpc-js used to refuse silently. Report writing gains a third session mode, `open` (append when a report is there, create otherwise), which becomes every command's and `Report.create`'s default; `replace` is the old `create`. The rest is small corrections, tests and docs from the M5 review.

**Tech Stack:** unchanged (TypeScript, vitest, commander, `@grpc/grpc-js` 1.14.6, `@bufbuild/protobuf`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-otel-html-m5-design.md` (§5 receiver, §6 commands) on top of `docs/superpowers/specs/2026-10-25-otel-html-design.md`. The issues themselves are the spec for each change; their text is quoted where it fixes a value. Conventions: `docs/superpowers/plans/2026-10-29-otel-html-m5.md` and the earlier plans.

## Pull requests

The repository squash-merges. So **the PR title is the conventional commit** that lands on `main` and that release-please reads; the PR body carries `Fixes #N` lines (one per issue, so GitHub closes them) and any extra conventional-commit lines release-please should see. Commits inside a branch still follow conventional commits (the pre-commit hook asks for it) but their text does not reach `main`.

| PR | Branch | Title (the squash commit) | Issues | Tasks |
|---|---|---|---|---|
| 1 | `fix/receiver-contract` | `fix(receiver): bind errors get their own code, empty entries do not count as accepted, startReceiver reuses the report's deps, run binds only the transport the child uses` | #51, #58, #56, #60, and the #61 correctness items that touch the same lines | 1–5 |
| 2 | `fix/receiver-backpressure` | `fix(receiver): count oversized gRPC exports, reserve the in-flight budget before buffering, drain before the gRPC force-shutdown` | #52, #57, #59 | 6–8 |
| 3 | `feat/append-by-default` | `feat!: append to an existing report by default; --replace starts it over` | #55 | 9–13 |
| 4 | `chore/m5-deferred-findings` | `fix: the rest of the M5 deferred review findings (#61)` | #61 | 14–16 |
| 5 | `ci/binary-smoke` | `ci: build and smoke-test the Linux binaries on every PR; the receiver load job sends 1M logs with a 30-minute ceiling` | #54, #53 (Task 18 steps 1–2; its measurement and docs PR follow) | 17–18 |

**Order:** 1 → 2 → 3 → 4, each branched from `main` after the previous one merged (they touch the same files: `receiver.ts`, `grpc.ts`, `http.ts`, `api/receiver.ts`, `receive.ts`). PR 5's Task 17 is independent and can be opened at any time; Task 18's workload change ships in PR 5; its measurement (steps 3–5) runs last, against `main` with PRs 1–4 merged, because the numbers must describe the shipped receiver.

**PR 3 is a breaking change** (the CLI default and `Report.create`'s default change). `release-please-config.json` has no `bump-minor-pre-major`, so a `feat!:` on `main` would make the next release 1.0.0. Task 13 adds `"bump-minor-pre-major": true` so it lands as 0.2.0 (ordinary `feat:` commits keep bumping the minor, as they do today). If the maintainer wants 1.0.0 instead, drop that step.

## PR process (unattended)

- **Reviews:** per-task reviews and the whole-branch review run on **Fable** (the session model), not Opus, for this plan.
- **Merging:** once a PR's CI is green and the branch review found nothing blocking, **squash-merge it without waiting for the maintainer** (`gh pr merge <n> --squash --delete-branch`, with the PR title as the commit subject and the body as its message), then branch the next PR from the updated `main`. The maintainer reads the merged PRs afterwards. A red CI is fixed on the branch, never merged around. The one exception is anything that needs a human decision the plan has left open; stop and ask then.
- Each PR's body carries `Fixes #N` for every issue it closes and, for PR 3, a `BREAKING CHANGE:` paragraph.

## Global Constraints

Everything in the M1–M5 plans' Global Constraints still applies:

- No `any`, no non-null assertions, exhaustive `switch` via `never`, typed `OtelHtmlError`s (`path`/`expected`/`actual`/`hint`). Biome strict at error. `mise run check` under 60 s; receiver tests bind port 0 on `127.0.0.1` and close servers in `afterEach`.
- Never silently wrong: everything refused is counted and the first of each kind is warned about; a changed default is in the README and the CHANGELOG.
- `src/receiver/signals.ts`, `status.ts` and `src/run/root-span.ts` stay free of `node:*` imports.
- Public API (`src/api/index.ts`) changes only where a task says so: `ErrorCode` gains `'receiver-bind'` (Task 1); `ReportOptions`, `ConvertOptions`, `MergeOptions` gain `replace?: boolean` (Task 11). Nothing else new is exported.
- TDD per task: the failing test first, run it, implement, run it, commit. Before each commit run `pnpm exec biome check .` and `mise run typecheck` by hand, never through a pipe that hides the exit status. Each commit message ends with the session's `Co-Authored-By` and `Claude-Session` trailers.
- Every PR's body says, per issue, what changed and what was decided against (an issue with options is closed by naming the option taken).

## Review Focus

1. **`serve` on a machine where a collector owns 4317.** Expected after PR 1: `run -- cmd` with no flags succeeds over HTTP; `serve` still fails with `EADDRINUSE` and exit 1 and a hint naming `--grpc`. Pinned in Task 1 and Task 4.
2. **An exporter that sends only `{}` bodies.** Expected: 200 every time, nothing written, `requests` counted, `refused` all zero (`{}` is a success with nothing, not a refusal). Pinned in Task 2.
3. **A gzip body whose compressed size is under the budget but inflates past it while another request is in flight.** Expected: 503 with `Retry-After: 1`, counted as `busy`, and the inflated bytes are never fully buffered. Pinned in Task 7.
4. **`otel-html convert a.json -o ./report` run twice.** Expected after PR 3: the second run appends (totals add up); with `--replace` it starts over; against a report written by another otel-html version it fails with the message in Task 10, nothing deleted. Pinned in Tasks 9, 10 and 12.
5. **`otel-html run` reused for many runs in one folder.** Expected: each run's root span is a separate trace; the viewer tells them apart by start time and `process.command_args`; README Limits says the folder grows without bound. Pinned in Task 13 (docs) and Task 12 (two `run`s in one folder).

---

## File structure

```
src/model/errors.ts              (modify) ErrorCode + 'receiver-bind'
src/model/otlp-json.ts           (modify) NO_SIGNAL marker on the {} error
src/model/sdk-metrics.ts         (modify) typed error for a non-finite INT value
src/receiver/host.ts             (modify) bindError: code, hint by errno
src/receiver/status.ts           (modify) outcomeOf 'receiver-bind'; statusMessage hides internal
src/receiver/signals.ts          (modify) recordCount throws on a signal mismatch
src/receiver/receiver.ts         (modify) empty entries; admit()/Admission replaces the in-receive budget check
src/receiver/http.ts             (modify) reserve from Content-Length, grow while streaming
src/receiver/grpc.ts             (modify) ceiling 2×maxBodyBytes, handler refuses too-large; forceShutdownAfterMs option; max_concurrent_streams
src/api/report.ts                (modify) depsOf(report); ReportOptions.replace; mode resolution
src/api/receiver.ts              (modify) uses depsOf; close(): receiver first, allSettled
src/api/convert.ts               (modify) replace on ConvertOptions/MergeOptions
src/writer/session.ts            (modify) SessionOptions.mode: 'open' | 'append' | 'replace'
src/writer/checkpoint.ts         (modify) version-mismatch message and hint
src/writer/merge.ts              (modify) merge into an existing report at out
src/cli/io.ts                    (modify) ReceiverFlags/ConfigFlags: replace
src/cli/commands/report-mode.ts  (new) addReportModeOptions(command), modeOf(flags)
src/cli/commands/{convert,merge,serve,run,receive}.ts (modify)
src/run/child-env.ts             (unchanged; checkedProtocol is reused)
.github/workflows/ci.yml         (modify) binary job
release-please-config.json       (modify) bump-minor-pre-major
README.md, docs/superpowers/specs/2026-10-29-otel-html-m5-design.md (modify)
test/…                           one test file per source file above, as today
```

---

# PR 1 — receiver contract (#51, #58, #56, #60)

### Task 1: Bind failures get their own error code (#51)

**Files:**
- Modify: `src/model/errors.ts` (ErrorCode), `src/receiver/host.ts`, `src/receiver/status.ts`
- Test: `test/receiver/host.test.ts` (new), `test/api/receiver.test.ts`, `test/cli/serve.test.ts`, `test/receiver/status.test.ts`

**Interfaces:**
- Produces: `ErrorCode` includes `'receiver-bind'`. `bindError(e: unknown, flag: '--http' | '--grpc'): OtelHtmlError` with `code === 'receiver-bind'`. `outcomeOf(e)` maps `'receiver-bind'` to `'internal'`.

- [ ] **Step 1: Write the failing tests**

`test/receiver/host.test.ts`:
```ts
test('EADDRINUSE names the port flag', () => {
  const e = bindError(Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:4317'), { code: 'EADDRINUSE' }), '--grpc');
  expect(e.code).toBe('receiver-bind');
  expect(e.message).toContain('EADDRINUSE');
  expect(e.hint).toBe('pass --grpc <port> or --no-grpc');
});
test('EACCES says the port needs privileges', () => {
  expect(bindError(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }), '--http').hint).toBe('ports below 1024 need privileges; pass --http <port>');
});
test('EADDRNOTAVAIL points at --host', () => {
  expect(bindError(Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' }), '--http').hint).toBe('--host must be an address of this machine');
});
test('an unknown code carries no hint', () => {
  expect(bindError(new Error('boom'), '--http').hint).toBeUndefined();
});
```
`test/api/receiver.test.ts`: `'a taken port is a receiver-bind error, not receiver-busy'` — `net.createServer().listen(0, '127.0.0.1')`, then `startReceiver(report, { http: { port: <that port> }, grpc: false }, w.deps)` → `e.code === 'receiver-bind'`, `e.hint` contains `--http`; the report is closed in `finally`.
`test/receiver/status.test.ts`: `outcomeOf(new OtelHtmlError('receiver-bind'))` is `'internal'`.
`test/cli/serve.test.ts`: the existing taken-port test additionally asserts `h.stderr` contains `EADDRINUSE` and `--grpc` (or `--http`), and the exit code is 1.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run test/receiver/host.test.ts test/api/receiver.test.ts test/receiver/status.test.ts test/cli/serve.test.ts`
Expected: FAIL (`'receiver-bind'` is not an `ErrorCode`; hints differ).

- [ ] **Step 3: Implement**

`errors.ts`: add `| 'receiver-bind'`. `host.ts`: `bindError` reads `Reflect.get(e, 'code')` and picks the hint from a `HINT_BY_CODE: Readonly<Record<string, (flag) => string>>` table for `EADDRINUSE`, `EACCES`, `EADDRNOTAVAIL`/`ENOTFOUND`; no hint otherwise. `status.ts`: add `case 'receiver-bind':` to the `internal` group. `runCli`'s `exitCodeOf` is unchanged (1).

- [ ] **Step 4: Run the tests to verify they pass**, then `mise run check`.

- [ ] **Step 5: Commit** — `fix(receiver): bind failures are receiver-bind, with a hint chosen by errno (#51)`

### Task 2: An empty entry is not an accepted entry (#58, #61 T2/T3)

**Files:**
- Modify: `src/receiver/receiver.ts`, `src/receiver/signals.ts`, `src/model/otlp-json.ts`
- Test: `test/receiver/receiver.test.ts`, `test/receiver/http.test.ts`, `test/receiver/grpc.test.ts`, `test/receiver/signals.test.ts`

**Interfaces:**
- Produces: `noSignal(source)` returns an `OtelHtmlError` with `path === NO_SIGNAL_PATH` where `export const NO_SIGNAL_PATH = '$'` (the root); `jsonEntries` detects it by `e.path === NO_SIGNAL_PATH` instead of comparing messages. `SignalService.recordCount(entry)` throws `Error('invariant violated: …')` when `entry.signal` differs from the service's.

- [ ] **Step 1: Write the failing tests**

`receiver.test.ts`:
```ts
test('[empty, bad] is invalid-otlp, not a partial success', async () => { /* JSON body with resourceSpans: [{ scopeSpans: [] }, <entry with a 15-byte traceId>] */ expect((await failure(receiver.receive('traces', body, 'json', 't'))).code).toBe('invalid-otlp'); expect(receiver.stats().refused.invalid).toBe(1); });
test('[empty] alone succeeds with nothing', async () => { expect(await receiver.receive('traces', encode({ resourceSpans: [{ scopeSpans: [] }] }), 'json', 't')).toEqual({ accepted: 0, rejected: 0, errorMessage: null }); });
test('{} succeeds with nothing and is not a refusal', …) // keep or extend the existing one: refused all zero
```
`http.test.ts`: `[empty, bad]` → 400 with a `Status` body naming `resourceSpans[1]`; `grpc.test.ts`: the same shape → `INVALID_ARGUMENT`.
`signals.test.ts`: `serviceOf('traces').recordCount(<a logs entry>)` throws `/invariant violated/`.

- [ ] **Step 2: Run to verify they fail** (`[empty, bad]` currently resolves 200).

- [ ] **Step 3: Implement**

`receiver.ts` `process`: `if (records > 0) { await session.add(...); acceptedEntries++; }` and `accepted += records` stays. `otlp-json.ts`: `noSignal` sets `path: NO_SIGNAL_PATH`; `receiver.ts` `jsonEntries` catches `e instanceof OtelHtmlError && e.path === NO_SIGNAL_PATH`. `signals.ts`: each `recordCount` starts with `if (entry.signal !== '<signal>') throw new Error(\`invariant violated: ${'<signal>'} service counted a ${entry.signal} entry\`)`.

- [ ] **Step 4: Run the tests; `mise run check`.**
- [ ] **Step 5: Commit** — `fix(receiver): an entry with no records is not an accepted entry (#58)`

### Task 3: `startReceiver` reuses the report's deps; `close()` always closes the receiver (#56, #61 T6)

**Files:**
- Modify: `src/api/report.ts`, `src/api/receiver.ts`, `src/cli/commands/receive.ts`
- Test: `test/api/receiver.test.ts`, `test/api/report.test.ts`

**Interfaces:**
- Produces: `export let depsOf: (report: Report) => WriterDeps` in `report.ts`, assigned in the static block beside `sessionOf`/`configOf` (comment: "assigned once by Report's static block; module-level `let` because the class body cannot reach a private field from outside"). `Report` stores `#deps`. `startReceiver(report, overrides = {}, deps?)`: `const full: WriterDeps = { ...depsOf(report), ...deps }` — **no `resolveDeps`** (the report's deps were already validated).
- `RunningReceiver.close()`: `const results = await Promise.allSettled(listeners.map((l) => l.close())); await receiver.close();` then rethrow the first rejection, in `try/finally` around the span. (Task 8 later moves `receiver.close()` to the front; keep `allSettled` either way.)

- [ ] **Step 1: Write the failing tests**

`api/receiver.test.ts`:
```ts
test('a receiver started without deps logs on the logger the Report was created with', async () => {
  const lines: string[] = [];
  const logger = { debug() {}, info() {}, warn: (m: string) => { lines.push(m); }, error() {} };
  const report = await Report.create({ out: 'r' }, { ...w.deps, logger });
  const rx = await startReceiver(report, { http: { port: 0 }, grpc: false }); // no deps
  await fetch(`${rx.http}/v1/traces`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  expect(lines.some((l) => l.includes('receiver refused a request'))).toBe(true);
});
test('close() closes the receiver even when a listener close rejects, and rethrows', …) // a fake Listener via a startReceiver over a report whose http listener is stubbed is awkward; instead: start with grpc only, close the grpc server out from under it is not possible either — so test at the unit level: extract `closeAll(listeners, receiver)` into src/api/receiver.ts (not exported from index) and test it with fakes: one listener rejecting, assert receiver.close called and the rejection rethrown.
```
`report.test.ts`: `depsOf(report).logger` is the injected logger; `Report.create` with an unresolvable `viewerAssets` fails but a `startReceiver` over a good report never re-validates (spy on `viewerAssets.files` — called once by `Report.create`, not again by `startReceiver`).

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** as in Interfaces. `receive.ts` `openReceiver`: `startReceiver(report)` — drop the `deps` argument (the report carries them).
- [ ] **Step 4: Run the tests; `mise run check`.**
- [ ] **Step 5: Commit** — `fix(api): startReceiver uses the deps its Report was created with (#56)`

### Task 4: `run` binds only the transport the child will use (#60)

**Files:**
- Modify: `src/cli/commands/receive.ts`, `src/cli/commands/run.ts`, `README.md` (`run` section)
- Test: `test/cli/run.test.ts`

**Interfaces:**
- `openReceiver(io, deps, flags, precheck?)`: `precheck: (enabled: { http: boolean; grpc: boolean }) => ReceiverOverrides | undefined` — its return value is passed to `startReceiver(report, overrides)`.
- `run.ts` precheck: `const protocol = checkedProtocol(io.env, enabled); return protocol === 'grpc' ? (flags.http === undefined ? { http: false } : undefined) : (flags.grpc === undefined ? { grpc: false } : undefined);` — **rule:** the transport the child's protocol does not use is left unbound unless the user asked for it with an explicit `--http <port>` / `--grpc <port>`.

- [ ] **Step 1: Write the failing tests**

`run.test.ts`:
```ts
test('with the default protocol only HTTP is bound, so a taken gRPC port does not matter', async () => {
  const taken = await listenOn0(); // net server on 127.0.0.1:0; its port goes into the config file as receiver.grpc.port
  fs: otel-html.yaml → receiver: { grpc: { port: taken.port }, http: { port: 0 } }
  argv: ['run', '-o', 'out', '--', process.execPath, '-e', CHILD, '0']  → exit 0, child posted its span, manifest has 2 spans
});
test('OTEL_EXPORTER_OTLP_PROTOCOL=grpc binds gRPC and leaves HTTP unbound', …) // config http.port = taken port; env protocol grpc; --grpc 0; exit 0
test('an explicit --grpc <port> is still bound under the HTTP protocol', …) // --http 0 --grpc 0: both addresses appear (assert via a `--grpc 0` run whose child reads nothing; simplest: have CHILD print process.env, or assert run does not fail when grpc config port is free; pick: spawnOverride captures `options.env` and the test asserts the endpoint, then separately assert `receiver.grpc !== null` by binding `--grpc <taken>` and expecting EADDRINUSE exit 1)
```

- [ ] **Step 2: Run to verify they fail** (today the first test exits 1 with EADDRINUSE).
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: README `run`**: after the flags sentence add: "`run` binds only the transport the command's protocol needs: OTLP/HTTP on 4318 by default, or OTLP/gRPC on 4317 when `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`; an explicit `--http <port>` or `--grpc <port>` binds that transport as well. A local collector on 4317 therefore does not get in the way."
- [ ] **Step 5: Run the tests; `mise run check`. Commit** — `fix(run): bind only the transport the child's protocol uses (#60)`

### Task 5: #61 correctness items on the same files

**Files:**
- Modify: `src/receiver/status.ts` (statusMessage), `src/model/sdk-metrics.ts`, `docs/superpowers/specs/2026-10-29-otel-html-m5-design.md` §5.2
- Test: `test/receiver/status.test.ts`, `test/model/sdk-metrics.test.ts`, `test/receiver/http.test.ts`

Decisions:
- **statusMessage:** `return outcomeOf(e) === 'internal' ? 'internal error' : (e as OtelHtmlError | ReceiverRejected).message` — the message of a typed error is only shown for outcomes a client can act on. Test: `statusMessage(new OtelHtmlError('report-locked', { path: '/secret/x' }))` is `'internal error'`; `statusMessage(new OtelHtmlError('invalid-otlp', { message: 'bad' }))` is `'bad'`.
- **`Content-Encoding: identity`:** keep accepting it (it is HTTP's name for "none") and amend spec §5.2 to "`Content-Encoding` absent, `identity` or `gzip`". Test in `http.test.ts`: `identity` with a plain JSON body → 200.
- **sdk-metrics INT value:** `BigInt(Math.trunc(p.value))` guarded: `if (!Number.isFinite(p.value)) throw new OtelHtmlError('invalid-otlp', { path: \`${metric.descriptor.name}.dataPoints[${i}].value\`, expected: 'a finite integer', actual: String(p.value) })`. Test: a `NaN` point on an INT instrument throws `invalid-otlp` with that path.

- [ ] Steps 1–5 as above (tests first, run, implement, run, `mise run check`), commit — `fix(receiver): internal outcomes say "internal error"; identity encoding pinned; typed error for non-finite INT points (#61)`

**PR 1 done when:** `mise run check` green; PR body has `Fixes #51`, `Fixes #58`, `Fixes #56`, `Fixes #60` and lists the #61 boxes it ticked (tick them on the issue after merge).

---

# PR 2 — receiver backpressure (#52, #57, #59)

### Task 6: Oversized gRPC exports are counted (#52)

**Files:**
- Modify: `src/receiver/grpc.ts`, `README.md` (`serve` paragraph and Limits)
- Test: `test/receiver/grpc.test.ts`

**Interfaces:**
- `GrpcTransportOptions { maxBodyBytes: number; forceShutdownAfterMs?: number }` (the second is Task 8's). `export const GRPC_CEILING_FACTOR = 2`: the server is created with `'grpc.max_receive_message_length': maxBodyBytes * GRPC_CEILING_FACTOR`; the handler refuses `call.request.length > maxBodyBytes` with `receiver.refused('too-large', …)` and answers `RESOURCE_EXHAUSTED` with `statusMessage` of a `ReceiverRejected('too-large', \`request of ${n} bytes exceeds the limit of ${maxBodyBytes} bytes\`)`.

- [ ] **Step 1: Failing test** — extend `'a message over maxBodyBytes is RESOURCE_EXHAUSTED'`: after the call, `receiver.stats().requests === 1` and `.refused['too-large'] === 1`. Add `'a message over twice the limit is refused by grpc-js and is not counted'` (documents the ceiling: `requests === 0`).
- [ ] **Step 2: Run; fails** (`requests` is 0 today).
- [ ] **Step 3: Implement** per Interfaces. `handlerFor` gets `options`.
- [ ] **Step 4: README** `serve` paragraph: "too large" stays a counted refusal; Limits gains: "Over gRPC a message larger than twice `receiver.maxBodyBytes` is refused by grpc-js before otel-html sees it and is not counted; between the limit and twice the limit it is counted as `too-large`."
- [ ] **Step 5: Run; `mise run check`; commit** — `fix(receiver): oversized gRPC exports are counted as too-large (#52)`

### Task 7: The in-flight budget is reserved before the body is buffered (#57)

**Files:**
- Modify: `src/receiver/receiver.ts`, `src/receiver/http.ts`, `src/receiver/grpc.ts`, `README.md` Limits, spec §5.1 (wording "before decoding" → "before buffering")
- Test: `test/receiver/receiver.test.ts`, `test/receiver/http.test.ts`, `test/receiver/grpc.test.ts`

**Interfaces:**
```ts
export interface Admission {
  /** Bytes claimed so far. */
  readonly bytes: number;
  /** Claim `more` bytes; false (and nothing claimed) when that would exceed the budget while another admission is open. */
  grow(more: number): boolean;
  /** Give the bytes back. Idempotent. */
  release(): void;
}
interface Receiver {
  /** Claim `bytes` of the in-flight budget before buffering a body. Null when it would exceed the budget while another admission is open. A single request is always admitted when nothing else is. */
  admit(bytes: number): Admission | null;
  receive(signal, body, encoding, transport, admission: Admission): Promise<ReceiveResult>; // releases `admission` when done; the body-size budget check moves out of receive
}
```
- Rule (spec §5.1): the budget is only enforced while another admission is open; `admit`/`grow` never refuse the only request in flight.
- `http.ts`: after the header checks and the `Content-Length > maxBodyBytes` check: `const admission = receiver.admit(Number.isFinite(declared) ? declared : 0)`; null → `refuse(... new ReceiverRejected('busy', \`receiver is busy: ${declared} bytes would exceed the in-flight budget\`), closeRequest)`. `readBody(req, gzip, admission)`: for each inflated chunk, if `total > admission.bytes` then `admission.grow(total - admission.bytes)` must be true, else throw `ReceiverRejected('busy', …)`. Every exit path (refusal, client gone, invalid) calls `admission.release()`; the success path hands it to `receive`.
- `grpc.ts`: the handler calls `receiver.admit(call.request.length)` after grpc-js has buffered (it cannot do better); null → `UNAVAILABLE` with `RetryInfo`, counted `busy`. The server is created with `'grpc.max_concurrent_streams': Math.max(1, Math.ceil(inflightBudgetBytes / maxBodyBytes))` — so `GrpcTransportOptions` gains `inflightBudgetBytes: number`.
- `OUTCOME_STATUS.busy` is unchanged (503 / `UNAVAILABLE`, retryable).

- [ ] **Step 1: Failing tests**

`receiver.test.ts`: `admit(10)` then `admit(budget)` while the first is open → null and `refused.busy` unchanged (the transport counts the refusal); `release()` then `admit(budget)` → not null; a lone `admit(budget * 2)` → not null (single request always admitted); `grow` past the budget with another open → false.
`http.test.ts`: `'a second upload is answered 503 from its Content-Length before its body is sent'`: real receiver with `inflightBudgetBytes: 1000` over a gated fake session; first request (600 bytes) in flight; second request opened with `http.request`, headers `content-length: 600`, **no body written** → the response arrives (503, `retry-after: 1`) while the request is still open; `stats().refused.busy === 1`. `'a chunked body that grows past the budget while another is in flight is 503'`: same setup, second request chunked, write 10 chunks of 100 bytes → 503 after a few chunks, before the end. `'a gzip body is counted inflated'`: 100 bytes of gzip inflating to 2000 → 503.
`grpc.test.ts`: a fake receiver whose `admit` returns null → `UNAVAILABLE` with `RetryInfo` 1 s and `refused('busy', …)` called.

- [ ] **Step 2: Run; fails** (`admit` does not exist).
- [ ] **Step 3: Implement** per Interfaces. In `receive`, `totals.bytes += body.length` and `inflightBytes` bookkeeping move into `admit`/`grow`/`release` (`inflightBytes` is the sum of open admissions' `bytes`).
- [ ] **Step 4: Docs** — README Limits: "The in-flight budget (`receiver.inflightBudgetBytes`, 128 MiB) is reserved from `Content-Length`, or as a streamed body inflates, before the body is buffered, so HTTP memory is bounded by the budget plus one body. gRPC messages are buffered by grpc-js before the budget applies; each connection is limited to ⌈budget ÷ `maxBodyBytes`⌉ concurrent calls." Spec §5.1 wording updated.
- [ ] **Step 5: Run; `mise run check`; commit** — `fix(receiver): reserve the in-flight budget before buffering a body (#57)`

### Task 8: Drain the receiver before the gRPC force-shutdown (#59)

**Files:**
- Modify: `src/api/receiver.ts` (`close()` order), `src/receiver/grpc.ts` (`forceShutdownAfterMs` option)
- Test: `test/receiver/grpc.test.ts`, `test/api/receiver.test.ts`

Decision: `RunningReceiver.close()` runs `await receiver.close()` **first** (stop admitting, drain the queue; late requests are answered `busy`, which clients retry), then `Promise.allSettled(listeners.map(close))`, then rethrows the first rejection. After the drain no handler is pending, so `tryShutdown` completes and the force timer only ever cuts idle or half-open streams, whose data was never written. `FORCE_SHUTDOWN_AFTER_MS` becomes the default of `GrpcTransportOptions.forceShutdownAfterMs`.

- [ ] **Step 1: Failing test** — `grpc.test.ts`: `'a call queued at shutdown completes once the receiver has drained'`: real receiver over a fake session whose `add` is gated; `forceShutdownAfterMs: 50`; start an Export (now queued on the gate); begin `const closing = (async () => { await receiver.close(); await listener.close(); })()`; after 200 ms release the gate; the Export callback gets `err === null`; `calls` shows exactly one `add`. A control test documents the old hazard: with `listener.close()` alone (no drain first) and the same timings the client sees `CANCELLED` while `add` still ran once — mark it `test.skip` with the reason, or drop it; the plan prefers dropping it (the ordering is the fix and the first test pins it). `api/receiver.test.ts`: `'close() closes the receiver first'` — `closeAll` from Task 3 with a recording fake receiver and listener asserts the order `['receiver.close', 'listener.close']`.
- [ ] **Step 2: Run; fails.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; `mise run check`; commit** — `fix(receiver): drain before closing the transports so a force-shutdown never cancels a written call (#59)`

**PR 2 done when:** `mise run check` green; body has `Fixes #52`, `Fixes #57`, `Fixes #59`; the serve paragraph and Limits in the README describe the counted and uncounted refusals.

---

# PR 3 — append by default (#55)

### Task 9: Session mode `open`

**Files:**
- Modify: `src/writer/session.ts`
- Test: `test/writer/session.test.ts`

**Interfaces:**
- `export type SessionMode = 'open' | 'append' | 'replace'`; `SessionOptions.mode: SessionMode`. Semantics: `open` — if `data/manifest.js` exists, behave as `append`; else behave as today's `create` (a non-empty folder that is not a report is refused with the existing message; a folder holding only `data/state` from a failed session is replaced). `replace` — today's `create`. `append` — unchanged (a missing report is a `usage` error; its hint becomes `'the folder holds no report; drop --append to create one'`).
- The literal `'create'` disappears from `SessionOptions` (the compiler finds every caller).

- [ ] **Step 1: Failing tests** — rename `'create replaces an existing unlocked report completely'` → `'replace replaces …'` (mode `replace`); add `'open appends when a report is there'` (two `open` sessions, totals add up, chunk numbering continues), `'open creates in a new or empty folder'`, `'open refuses a non-empty folder that is not a report'` (same message as today), `'open replaces a folder holding only a failed session's state dir'`.
- [ ] **Step 2: Run; fails** (type error on `'open'`).
- [ ] **Step 3: Implement** in `openSession`: `const appending = options.mode === 'append' || (options.mode === 'open' && (await fs.exists(at(out, MANIFEST_PATH))))`, then the two existing branches keyed on `appending`.
- [ ] **Step 4: Run; `mise run check` (fix the other callers by passing `'replace'` where they passed `'create'`, for now).**
- [ ] **Step 5: Commit** — `feat(writer): session mode open appends when a report is there (#55)`

### Task 10: The version-mismatch message says what to do

**Files:**
- Modify: `src/writer/checkpoint.ts`
- Test: `test/writer/append.test.ts`

Decision: **throw; no merge path** (the merge path is left out: it needs the current writer to replay a foreign report into itself while holding its own lock, and the format version changes less often than the package version, so the error with a hint is the honest answer today; say so in the PR body).

- [ ] **Step 1: Failing test** — `'a version mismatch tells the user to replace or merge, with both versions'`: message `cannot append: the report at ${out} was written by otel-html 9.9.9 (this is ${version})`; hint `pass --replace (replace: true in the library) to start it over, or combine across versions with \`otel-html merge ${out} <new> -o <dir>\``. Update the two existing mismatch tests to the new text.
- [ ] **Step 2–5:** run, implement (`versionMismatch(out, reportVersion, currentVersion)` — the `where` argument is dropped from the message and kept in `path`), run, commit — `fix(writer): the version mismatch names --replace and merge (#55)`

### Task 11: Library defaults (`Report.create`, `convert`, `merge`)

**Files:**
- Modify: `src/api/report.ts`, `src/api/convert.ts`, `src/writer/merge.ts`
- Test: `test/api/report.test.ts`, `test/api/convert.test.ts`, `test/writer/merge.test.ts`

**Interfaces:**
- `ReportOptions`, `ConvertOptions`, `MergeOptions` gain `replace?: boolean` ("Start the report over, even when `out` already holds one."); `append?: boolean` keeps its doc but now reads "Require a report at `out` (fail when there is none)."; `MergeOptions` gains `append?` too. Both true → `OtelHtmlError('usage', { message: 'append and replace exclude each other' })`.
- `export function sessionModeOf(o: { append?: boolean; replace?: boolean }): SessionMode` in `src/api/report.ts` (internal, not in index): `replace → 'replace'`, `append → 'append'`, else `'open'`.
- `mergeReports(deps, inputs, options)`: when `options.mode !== 'replace'` and `out` holds a manifest, the existing report is the base: skip the first-input title/dashboard inheritance (the append branch of `openSession` inherits from the existing manifest) and replay the inputs into it. `assertDisjoint` still refuses an input equal to or inside `out`.

- [ ] **Step 1: Failing tests** — `report.test.ts`: `'create over an existing report appends'` (two `Report.create({ out: 'r' })` in a row, 3 + 2 spans → totals 5), `'replace: true starts over'`, `'append and replace together is a usage error'`, the existing `'append: true reopens a closed report'` keeps passing, and `'append: true on an empty folder fails'`. `convert.test.ts`: `'convert twice into one folder appends'`; the test at line 218 passes `replace: true`. `merge.test.ts`: `'merge into an existing report adds the inputs to it'` (report A at out, inputs B, C → totals A+B+C, A's title and dashboards kept), `'merge with replace: true writes a fresh combined report'`.
- [ ] **Step 2–5:** run, implement, run, `mise run check`, commit — `feat(api): Report.create, convert and merge append by default; replace starts over (#55)`

### Task 12: CLI `--replace` everywhere, `--append` everywhere

**Files:**
- Create: `src/cli/commands/report-mode.ts`
- Modify: `src/cli/io.ts`, `src/cli/commands/convert.ts`, `merge.ts`, `serve.ts`, `run.ts`, `receive.ts`
- Test: `test/cli/program.test.ts`, `test/cli/serve.test.ts`, `test/cli/run.test.ts`

**Interfaces:**
- `report-mode.ts`: `export function addReportModeOptions(command: Command): Command` adds `--append` ("require a report at -o and add to it") and `--replace` ("start the report over") with `.conflicts()` between them; `export function modeOf(flags: { append?: boolean; replace?: boolean }): SessionMode` delegates to `sessionModeOf`.
- `ConfigFlags` gains `append?: boolean; replace?: boolean` (moved up from `ReceiverFlags`). `openReceiver` passes `{ out, mode: modeOf(flags) }` to `Report.createResolved`, whose second parameter becomes `Pick<ReportOptions, 'out' | 'append' | 'replace'>`.
- README `run`: "the `serve` flags except `--append`" → all `serve` flags.

- [ ] **Step 1: Failing tests** — `program.test.ts`: `'convert into an existing report appends; --replace starts over; --append needs a report'` (three runs), `'--append with --replace exits 2'`, `'merge into an existing report at -o adds to it'`. `serve.test.ts`: `'serve twice into one folder appends'`. `run.test.ts`: `'two runs in one folder keep both root spans'` (2 traces, each with its own root span and child), `'run --replace keeps only the last run'`.
- [ ] **Step 2–5:** run, implement, run, `mise run check`, commit — `feat(cli): --replace on every writing command; appending is the default (#55)`

### Task 13: Docs, changelog, release config for the breaking change

**Files:**
- Modify: `README.md` (CLI tables for `convert`, `serve`, `run`, `merge`; Library API paragraph; Configuration rows 331–334 wording "appended to" → "written into"; Limits), `release-please-config.json`, spec `docs/superpowers/specs/2026-10-25-otel-html-design.md` wherever it says a report is replaced by default (grep `replac`)

- [ ] **Step 1:** README: every `--append` row becomes two rows: `--append` "Require a report at `-o` and add to it (fails when there is none; useful in CI to catch a wrong path)." and `--replace` "Start the report over. Without either flag, `-o` is appended to when it already holds a report and created otherwise." `merge` says it adds its inputs to an existing report at `-o`. Library: "`Report.create`, `convert` and `merge` append when `out` already holds a report written by the same otel-html version; `replace: true` starts over, `append: true` requires the report to be there. A report from another version fails with a message naming `--replace` and `merge`." Limits: "A report folder reused by many runs grows without bound; start it over with `--replace` now and then. Each `run` is its own trace, told apart by start time and `process.command_args`."
- [ ] **Step 2:** `release-please-config.json`: add `"bump-minor-pre-major": true` under the package, so `feat!:` → 0.2.0 instead of 1.0.0 (**maintainer's call**; skip this step for 1.0.0).
- [ ] **Step 3:** `mise run check`; commit — `docs: append by default, --replace, and the release bump policy (#55)`

**PR 3 done when:** PR title is `feat!: append to an existing report by default; --replace starts it over` and the body has a `BREAKING CHANGE:` paragraph (release-please puts it in the changelog) and `Fixes #55`.

---

# PR 4 — the rest of #61

### Task 14: Remaining correctness items

Decisions, one per #61 box not handled in PRs 1–2:

- **T7 SIGINT during start-up:** in `openReceiver`, `const stop = nextSignal(io)` before `Report.createResolved`; the start races `stop.signalled` (which throws `CliExit(130)` after `io.stdout('interrupted\n')`); on either failure the report session is aborted (lock released); `stop.cancel()` in `finally`. Test in `serve.test.ts`: a `fs` whose `createExclusive` (the lock) waits until the test fires SIGINT → exit 130, no `data/lock` left.
- **T14 Playwright inherits `OTEL_EXPORTER_OTLP_*`:** a comment in `playwright.config.ts` at the `use`/`env` block: nothing reads them today; a test that spawns `serve`/`run` or registers an SDK must unset them. No code change.

- [ ] Tests first, implement, `mise run check`, commit — `fix(cli): a stop signal during serve start-up exits 130 and leaves no lock (#61)`

### Task 15: Docs and code-health items

- `proto/LICENSE`: year 2026 (matches the vendored headers).
- `http.ts` debug log: `{ method, path, status, requestBytes, responseBytes }`; the last-resort catch logs the path without its query (`(req.url ?? '').split('?')[0]`).
- `report.ts`: the `export let` comment (done in Task 3 if not already); `otel-html.receive` attributes become camelCase like `otel-html.flush`: `acceptedTraces`, `acceptedLogs`, `acceptedMetrics`, `rejectedTraces`, … — and Task 16 tests them.
- `src/run/resource.ts`: comment that `process.env` (not `io.env`) is deliberate: the detectors read the real environment, and the two are equal in production.
- `src/exporters/base.ts` `shutdown` doc: "Shut the provider down first, then `report.close()`; `shutdown()` rejects when the report is already closed."
- `src/model/sdk-logs.ts` at `flags`: "raw `traceFlags`, as the upstream log serializer does (spans mask it)". No `sdk-common.ts` yet (two mappers do not justify it; say so in the PR).
- `e2e/load.spec.ts` uses `global-setup`'s `serve` helper (export it from `e2e/global-setup.ts` or move both to `e2e/static-server.ts`); the long comment in `load.yml` is re-wrapped at 120 columns.

- [ ] Implement, `mise run check` and `mise run lint` (actionlint), commit — `chore: M5 deferred docs and code-health findings (#61)`

### Task 16: Test items

One test per box; each named here so the implementer writes exactly one thing:

- `receiver.test.ts`: the fake session returns a real `AddResult` (`{ accepted: 1, dropped: 0, duplicates: 0 }`); the serialization and close tests wait on an `added` promise the fake resolves inside `add`, not on `await Promise.resolve()`.
- `http.test.ts`: `'a plain body streamed past the limit without Content-Length is 413'` (chunked, no gzip).
- `grpc.test.ts`, `span-exporter.test.ts`: `test-support/decode.ts` exports `decodeResponse<T extends Message>(schema: DescMessage, bytes: Uint8Array): T`-style helpers replacing the `as never` casts (one helper per cast site kind).
- `api/receiver.test.ts`: `'the receive span carries per-signal accepted and rejected counts'` via the test tracer (`acceptedTraces: 3`, `rejectedTraces: 1` after one good and one bad entry).
- `serve.test.ts`: retitle the second-signal lock test to what it shows ("a second signal while a write is stuck exits 130 and releases the lock"); the four bad-port tests assert the stderr text (`is not a port`).
- `exporters/span-exporter.test.ts`: `forceFlush` test asserts `manifestOf` throws (no manifest) before the flush and resolves after.
- `model/sdk-metrics.test.ts`: the unsupported `dataPointType` branch throws `invalid-otlp` naming the type; the export-count test asserts the metric names (`['a', 'b']`) instead of `>= 2`.
- `cli/binary.test.ts` (shared with PR 5, do it here): on watchdog kill the failure message includes the captured stdout/stderr; the `run` test attaches a `spawn` `error` listener and its timeout says "timed out after 50 s"; the gRPC span is asserted by name.
- `cli/main.test.ts` (new): `process.exit(code)` safety net — run `dist/cli/main.js`? No build in unit tests; instead spawn `node --import tsx src/cli/main.ts`? Not available either. Decision: a test that spawns `process.execPath` with `--experimental-strip-types src/cli/main.ts convert -o <tmp>` (Node ≥ 24 strips types natively) and a `fs` that cannot be injected… — too far. **Decision: document the gap in a comment in `main.ts` and tick the box as "not unit-testable; covered by the binary smoke test's `serve` + SIGINT path (exit 0) and its bad-port test (exit 1)"** — add the bad-port case to `binary.test.ts` so the exit path is in fact exercised.

- [ ] Implement, `mise run check`, commit — `test: M5 deferred test findings (#61)`

**PR 4 done when:** every box in #61 is ticked on the issue (or answered in the PR body with the reason), body has `Fixes #61`.

---

# PR 5 — binaries on CI and the receiver load numbers (#54, #53)

### Task 17: Build and smoke-test the Linux binaries on every PR (#54)

**Files:**
- Modify: `.github/workflows/ci.yml`, `README.md` (Development: what CI runs), `test/cli/binary.test.ts` (Task 16's items if PR 4 is not merged yet — otherwise nothing)

Decision: the cheapest permanent answer to "unverified before the first release" is to run the smoke test on PRs. Add a `binary` job: `needs: build`, `strategy.matrix.include: [{ os: ubuntu-latest, target: linux-x64 }, { os: ubuntu-24.04-arm, target: linux-arm64 }]`, steps: checkout, `./.github/actions/setup`, `mise run build`, `mise run build:binaries -- --target "$TARGET"`, `OTEL_HTML_BINARY=dist/bin/otel-html-$TARGET pnpm exec vitest run test/cli/binary.test.ts`. `timeout-minutes: 15`. The release workflow keeps its own smoke step (it tests the artefact it uploads).

- [ ] **Step 1:** add the job; `mise run lint` (actionlint) passes.
- [ ] **Step 2:** open the PR and read the job's result on both targets.
- [ ] **Step 3a (green):** README Development says the Linux binaries are built and smoke-tested on every PR; close #54 with the run link in the PR body.
- [ ] **Step 3b (gRPC fails under Bun on Linux):** apply the M5 plan Task 12 step 3 fallback in this PR: `main.ts` passes `grpcAvailable: false` with the Bun deps; `WriterDeps` gains `grpcAvailable?: boolean`; `openReceiver` defaults `receiver.grpc.enabled` to false when it is false and makes an explicit `--grpc <port>` a `usage` error "OTLP/gRPC is not available in the standalone binary; use OTLP/HTTP or run otel-html under Node"; `binary.test.ts` asserts that message instead of the gRPC export; README Install says so. Paste the failing error in the PR body.
- [ ] Commit — `ci: build and smoke-test the Linux binaries on every PR (#54)`

### Task 18: The receiver load job runs end to end on a right-sized workload; numbers in the README (#53)

Runs after PRs 1–4 are on `main` (the numbers must describe the shipped receiver).

**Decision: the workload shrinks to 1M spans + 1M logs, and the job's ceiling to 30 minutes.** telemetrygen sends one log record per HTTP request with no batching flag, so 10M logs is 10M requests, roughly 1,850 req/s for an hour on a 4-core runner: that measures telemetrygen and the runner's HTTP stack, not otel-html. What the job exists to assert (peak RSS under 512 MB, every record written, nothing rejected, landings interactive) plateaus long before 10M records, because the writer checkpoints and the in-flight budget bounds the receiver. 1M single-record requests is still a harsher per-request test than the 1M batched spans.

**Files:**
- Modify: `scripts/load-receiver.ts` (default `--logs` 1000000, usage comment), `mise.toml` (`test:load:receiver` comment), `.github/workflows/load.yml` (`receiver` job `timeout-minutes: 30`; both comments), `docs/superpowers/specs/2026-10-29-otel-html-m5-design.md` lines 15 and 126 ("10M logs" → "1M logs", with the one-record-per-request reason), `README.md` Limits (line 351) and Development table (line 365)
- Test: `test/scripts/load-receiver-plan.test.ts` (the default plan's totals)

- [ ] **Step 1:** change the test's expectation of the default log total to 1,000,000; run it; fails.
- [ ] **Step 2:** apply the file changes above; the test passes; `mise run lint` (actionlint) passes. Commit on the PR 5 branch — `ci(load): the receiver job sends 1M logs (one request each) and has a 30-minute ceiling (#53)`.
- [ ] **Step 3:** once PR 5 is merged: `gh workflow run load.yml --ref main`, then `gh run watch` the run; read the `receiver` job's log: wall time for spans and logs, the peak RSS `scripts/load-receiver.ts` prints, the Playwright landing timings.
- [ ] **Step 4 (if it still exceeds 30 minutes):** raise `--workers` to the runner's core count (`nproc`, 4 on ubuntu-latest) first; only then lower `--logs` further, and say so in the README. Re-dispatch.
- [ ] **Step 5:** README Limits: replace "peak RSS not measured yet on 1M spans + 10M logs" with the measured RSS and wall time (and the landing timings), the run date and the runner. Open a small docs PR, body `Fixes #53` with the run link — `docs: receiver load numbers from the first end-to-end load run (#53)`.

---

## Self-review notes

- **Coverage:** #51 T1; #52 T6; #53 T18; #54 T17; #55 T9–T13; #56 T3; #57 T7; #58 T2; #59 T8; #60 T4; #61 T2 (recordCount, `{}` marker), T3 (close allSettled), T5 (statusMessage, identity, BigInt), T14–T16 (everything else). Every #61 box is assigned.
- **Names used across tasks:** `depsOf` (T3, used by T4's `openReceiver` indirectly), `Admission`/`admit` (T7; T8 relies on `receiver.close()` draining admitted work), `SessionMode`/`sessionModeOf`/`modeOf` (T9, T11, T12), `GrpcTransportOptions.forceShutdownAfterMs` and `inflightBudgetBytes` (T6, T7, T8), `closeAll` (T3, T8).
- **Not done on purpose:** the mismatched-append merge path (#55 "worth trying first") — the PR body says why; a gRPC server interceptor for #52 — the ceiling plus handler check is simpler and the uncounted band is documented.
