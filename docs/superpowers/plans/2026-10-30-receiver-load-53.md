# Receiver under load (#53): memory and checkpoint stalls

**Spec:** `docs/superpowers/specs/2026-10-29-otel-html-m5-design.md` §"load.yml" (line ~126): `otel-html serve` takes 1M spans over gRPC (500 spans/s per worker, 8 workers) and 1M logs over HTTP from telemetrygen; assert peak RSS under 512 MB, a complete manifest with exactly the sent totals, zero rejected; then the Playwright landing check. Issue #53 is done when one `receiver` run is green on ubuntu-latest and its numbers are in README Limits.

## What was measured (local, macOS, telemetrygen v0.140.0 built natively, same flags as CI)

| Run | Spans received | Peak RSS |
|---|---|---|
| main, 1M spans + 1M logs | 929,107 / 1M | 1,764 MB |
| streamed state write only (prototype) | 936,461 / 1M | 867 MB |
| no periodic checkpoints (flushIntervalMs huge) + lean index | 1,000,000 | 648 MB |
| same, plus `node --optimize-for-size` | 1,000,000 | 387 MB |

Causes:
1. **Checkpoint stalls.** Every `writer.flushIntervalMs` (5 s) the session rewrites the whole trace index twice: all 256 trace shards (random trace ids dirty every shard; 101 MB at 1M spans) and the state slot, which embeds the whole index (116 MB). The checkpoint runs inside the session's serial queue, so receives wait behind it. Its duration grows with the index: 178 ms at the start, 1.3 s at ~470k traces. telemetrygen's batch span processor (queue 2,048 spans, one exporter) at 4,000 spans/s overflows after about 0.5 s of stall and drops spans. With no periodic checkpoints, all 1M spans arrive.
2. **Transient memory.** `writeStateSlot` builds `JSON.stringify(state)` as one string (116 MB) and `writeFile` encodes it into one Buffer; `TraceIndex.toJSON()`/`shardPayload()` deep-copy every entry first.
3. **Retained memory.** Retained heap at 1M spans (500k traces) is about 300 MB. Each `TraceEntry.chunks` array grows by `push` from `[]`, which allocates 17 slots (184 B per array; an exact one-element array is 56 B): 76 MB. Each chunk key in those arrays is its own sliced string (`ChunkBuffer.pendingKey` builds a new string per call): 15 MB. Root `name`/`service`/`resource` strings are one copy per trace.
4. **V8 heap slack.** RSS runs at about twice the live heap under steady allocation; `--optimize-for-size` (already set by the CLI when metric points arrive) brings the 1M-span run to 387 MB.

## Global Constraints

- The report format does not change: data files, the state slot (`data/state/session.<slot>.json`) and trace shard files are byte-for-byte what they are today for the same session contents. `SessionState` field order is `formatVersion, otelHtmlVersion, epochUnixNano, nextChunk, rollups, dedupe, traceIndex, metricStreams, nextSegment`.
- A crash at any point leaves the previous committed manifest valid and a state slot that matches it (`test/writer/crash.test.ts` keeps passing unchanged in intent).
- `mise run check` passes (Biome, typecheck, unit tests, knip: no unused exports).
- Comments explain why, wrapped at 120 columns like the surrounding code. No new dependencies.
- The library sets no V8 flags; only `src/cli/main.ts` does.

## Task 1: Lean trace-index entries

**Files:** `src/writer/chunker.ts`, `src/writer/trace-index.ts`, `test/writer/trace-index.test.ts` (and a chunker test if one exists, else in `test/writer/session.test.ts` or a new `test/writer/chunker.test.ts`).

1. `ChunkBuffer.pendingKey` returns the same string instance until the pending chunk number changes (cache the key with the number it was built for). Test: two reads with no cut in between are `Object.is`-equal; after a cut the key is the next chunk's.
2. `TraceIndex`:
   - New entries share one module-level frozen empty array for `chunks` and `logChunks` (`Object.freeze([])` typed as `string[]` via a cast is acceptable, or a `readonly string[]` constant if `TraceEntry` typing allows). Appending a chunk key replaces the array with `entry.chunks.concat(chunk)` (exact-size array; never `push`, which would mutate the shared empty array or over-allocate). Same for `logChunks`.
   - Root strings (`service`, `name`, `resource`) go through a per-`TraceIndex` interner: a `Map<string, string>` that returns the first instance of an equal string and stops adding new strings after 10,000 distinct ones (later strings are stored as they are). `TraceIndex.load` interns the same way.
   - Tests: two traces in the same chunk do not share their `chunks` array after one of them gets a second chunk (mutation isolation); an entry's `chunks` after two chunks equals `[c0, c1]`; `shardPayload`/`toJSON` output is unchanged for an existing fixture; root strings of two traces with equal names are `Object.is`-equal; the interner cap (construct with a small cap through a constructor option or a module constant exported only if knip allows; prefer a private static with a test through behaviour: after the cap, equal new strings are still stored correctly).
3. No behaviour change otherwise; existing trace-index and session tests pass.

## Task 2: Streamed checkpoint writes

**Files:** `src/writer/checkpoint.ts`, `src/writer/session.ts`, `src/writer/trace-index.ts`, tests in `test/writer/` (checkpoint/session/node-fs as fits).

1. `TraceIndex.shardView(shard): Readonly<TraceShard>`: the shard's live entries as a plain object (`Object.fromEntries(map)`), no copy of entries or arrays, for serializing at once. The session writes trace shard files with `wrapDataFile(traceShardKey(shard), traceIndex.shardView(shard))`. Keep `shardPayload` only if something else still uses it (knip will tell); same for `toJSON`.
2. The state slot is written in pieces: a generator in `checkpoint.ts` produces exactly the bytes `JSON.stringify(state)` would, with
   - every field except `dedupe` and `traceIndex` stringified as today,
   - `dedupe` emitted in slices of 1,000 keys,
   - `traceIndex` emitted one shard at a time (`"<shard>":<JSON.stringify(shardView)>`, shards sorted as `TraceIndex.shards()` sorts them).
   `writeStateSlot` takes the pieces source (shape is the implementer's call: e.g. `head: Omit<SessionState, 'dedupe' | 'traceIndex'>`, `dedupe: readonly string[]`, `shards: Iterable<[string, Readonly<TraceShard>]>`) and uses `fs.writePiecesAtomic` when the port has it, else `fs.writeTextAtomic` of the joined pieces. The session no longer calls `TraceIndex.toJSON()` or builds a full `SessionState` object for the write.
3. Tests: for a session state with several shards, a non-empty and an empty dedupe list, an empty trace index, and strings that need JSON escaping (quotes, `<`, U+2028), the joined pieces equal `JSON.stringify(state)` of the equivalent full object; the written slot parses with `parseSessionState`; append/resume tests keep passing (a session reopened from a streamed slot has the same trace index). A test with a file-system double that records `writePiecesAtomic` calls shows the state goes through it in more than one piece when the index has more than one shard.

## Task 3: Interval checkpoints do not block receives

**Files:** `src/writer/session.ts`, `src/writer/trace-index.ts`, `test/writer/session.test.ts`, `test/writer/crash.test.ts` (extend), maybe `test-support/memory-fs.ts` (a gate to hold writes).

Today `#maybeCheckpoint()` (called from `add` when not partial, `addRecords` and `endInput`) runs `#checkpoint(false)` inside `#serial`, so every add queued behind it waits for the whole write. Split the checkpoint into a short synchronous-ish **prepare** under the serial queue and an asynchronous **write** that runs outside it:

1. **Prepare** (inside the serial task that found a checkpoint due): `#wipeReplaced`, the three `#cutSync`, `#drainUnwritten(true)`, `#series.flush(...)` (metric segments stay under the queue; they are not this workload's cost), then capture an immutable snapshot:
   - the dirty shard list and, for every shard, a shallow copy of its entry map (`TraceIndex.snapshot()`: `Map<shard, Map<traceId, TraceEntry>>` of the same entry objects);
   - rollups serialized and wrapped into their data-file strings now (they are small and mutable);
   - the state head (everything but `dedupe` and `traceIndex`) stringified now; `dedupe` as an array copy (`DedupeSet.toJSON()`);
   - the manifest object (`#manifest(false)`), the next slot, and the pending chunk entries it lists (move them out of `#pending` into the snapshot; on failure put them back in front of `#pending`, preserving order).
   Then clear the index's dirty set and `#dirty`, and start the write. The serial task returns without awaiting it.
2. **Copy-on-write.** While a snapshot is held, `TraceIndex.add`/`addLog` must not mutate an entry object the snapshot shares: if the snapshot's map for that shard holds the same object, replace it in the live map with a copy (`{ ...e }`; `chunks`/`logChunks` are already replaced, not mutated, after Task 1) before changing it. New entries go only to the live map. Releasing the snapshot (write finished or failed) stops the checks. The cost is one map lookup per add while a write is in flight.
3. **Write** (outside the queue): dirty shard files from the snapshot (`wrapDataFile(traceShardKey(s), Object.fromEntries(snapshotMap))`), the rollup files, the state slot in pieces (Task 2's writer, fed from the snapshot), the shell if not yet written, then the manifest. On success: `#slot` moves to the snapshot's slot, the snapshot's chunk entries are appended to `#committed`, `#everCommitted = true`, `#lastFlushMs` is set at completion. On failure: log `checkpoint failed; will retry at the next flush` with the error (logger.error), re-mark the snapshot's dirty shards dirty, set `#dirty = true`, return the chunk entries to `#pending`, and keep the error so the next foreground checkpoint surfaces a persistent problem by failing itself (it simply retries; do not rethrow the stale error from an unrelated call).
4. **One at a time.** While a write is in flight, `#maybeCheckpoint` does nothing. `flush()`, `close()` and `abort()` first await the in-flight write (inside their serial task), then behave as today: `flush()` and `close()` run a foreground checkpoint (prepare + write awaited), so their callers still get errors. The self-telemetry span `otel-html.flush` covers prepare through write.
5. **Semantics kept.** A report on disk is only ever advanced by a complete write ending with the manifest. Readers and resume see either the previous checkpoint or the new one. Chunks cut and written by adds during a background write get numbers after the snapshot's and are listed by the next checkpoint. `partial` adds and the replace-wipe ordering are unchanged (the wipe still happens before the first write, in prepare).
6. Tests (fake clock to make a checkpoint due; a memory-fs gate that holds `writeTextAtomic`/`writePiecesAtomic` for a chosen path until released):
   - while the state-slot write is held, a further `add` (and `endInput`) resolves, and its spans are in memory (totals);
   - a trace whose entry is in the held snapshot and gets another span during the write: the written shard file and state slot show the entry as it was at prepare; the next checkpoint shows the updated entry;
   - a held write that then fails: the next `flush()` writes everything (the dirty shards and the chunk entries return), and the manifest lists all chunks in order;
   - `flush()` and `close()` called during a held write wait for it and then commit;
   - crash test: killing (abandoning) the session while a background write is held leaves the previous manifest and a matching state slot (`loadCheckpoint` succeeds and reopening resumes from the previous checkpoint).

## Task 4: The CLI favours heap size for `serve` and `run`

**Files:** `src/cli/main.ts`, `src/cli/program.ts` and/or `src/cli/commands/serve.ts`, `src/cli/commands/run.ts`, their tests, README.

1. The CLI under Node sets `--optimize-for-size` when a receiver starts (`serve` and `run`), as it does today when metric points first arrive. One function in `main.ts` does it (rename `beforeMetrics` to something that says what it does, e.g. `favourHeapSize`, and pass it both as the session's `beforeMetrics` dep and as a new optional CLI dep the serve and run commands call once before opening the receiver). Under Bun it does nothing (as today).
2. Tests: serve and run call the hook once before the receiver binds (a fake dep in the existing command tests); convert does not call it for a trace-only input.
3. README: the Limits bullet on metrics says the CLI switches V8 to `--optimize-for-size` when metric points arrive; add that `serve` and `run` set it at start. Update the comment above the function in `main.ts`. Do not touch the "Receiver:" Limits bullet (Task 5 rewrites it with measured numbers).

## Task 4b: The snapshot copies shard maps lazily

**Why:** the first CI run on the branch (run 41067773876, 4-core runner, the CLI setting `--optimize-for-size`) met the memory target (peak RSS 435 MB) and took all 1M logs, but 1,548 spans (three export batches) were dropped by telemetrygen: something still stalls receives for about 0.5 s. Locally the checkpoint prepare takes up to 123 ms, almost all of it `TraceIndex.snapshot()` copying every shard's entry map (`new Map(traces)` for ~500k entries) inside the serial queue; full GCs under `--optimize-for-size` add up to 65 ms. On the CI runner both are 2-3× slower.

**Files:** `src/writer/trace-index.ts`, `test/writer/trace-index.test.ts` (and `test/writer/background-checkpoint.test.ts` only if needed).

1. `snapshot()` no longer copies shard maps. It records the live shard `Map` objects as the snapshot's maps (O(number of shards)) and marks every shard as shared.
2. Before the first change to a shared shard while the snapshot is held (a new trace id in that shard, or an update to one of its entries), the live index replaces that shard's map with a copy (`new Map(map)`) and marks the shard unshared; the snapshot keeps the original map. A new shard created while the snapshot is held is never shared. Entry-level copy-on-write stays as it is (an entry object the snapshot's map still holds is cloned before it is changed).
3. `release()` drops the snapshot and the shared marks.
4. Behaviour and bytes are unchanged; the existing snapshot/copy-on-write tests keep passing. New tests: a snapshot taken, then a new trace added to an existing shard and to a new shard: the snapshot's entries for those shards do not include the new traces, the live index does; a shard untouched during the snapshot is written from the same map object (no copy — observable through a test-only check that `snapshot().entries(shard)` and a second read after release refer to equal content; identity is not required to be observable); `snapshot()` cost does not grow with the number of traces is not unit-tested (measured by the load run).

## Task 4c: Fewer heap objects per trace; receivers keep GC pauses short

**Why:** the CI run on the head after Task 4b (run 41077748099) met memory (430 MB) but telemetrygen still dropped 3,746 spans. Reproduced in a Linux container limited to 2 CPUs (node 24.22.1, native telemetrygen, CI flags): under `--optimize-for-size` V8 runs a full mark-compact about every 0.4 s (682-792 in 280 s) with pauses up to 200 ms; stalls of 300+ ms drop spans. Measured in that container (1M spans unless noted):

| Trace index | V8 flags set by the CLI at receiver start | Spans | Peak RSS |
|---|---|---|---|
| head | `--optimize-for-size` | 993,894-996,522 | 421-430 MB |
| head | none | 1,000,000 | 842 MB |
| shared roots + shared chunk lists | `--optimize-for-size` | 995,368 | 356 MB |
| shared roots + shared chunk lists | `--heap-growing-percent=20` | 1,000,000 | 542 MB |
| shared roots + shared chunk lists | `--optimize-for-size --heap-growing-percent=40` | 1,000,000 | 435 MB (152 mark-compacts, pauses ≤ 77 ms) |
| same, 1M spans + 1M logs | same | 1,000,000 + 1,000,000 | 438 MB |

**Files:** `src/writer/trace-index.ts`, `test/writer/trace-index.test.ts`, `src/cli/main.ts`, the CLI tests that pin the hook if they assert the flag string, README (the metrics Limits bullet sentence added in Task 4).

1. `TraceIndex` shares root objects: a root is frozen and reused for every trace with the same `service`, `name` and `resource` (a map keyed by the three strings joined with `\u0000`, bounded by the same intern cap; past the cap a fresh frozen root is stored). `load` shares the same way.
2. `TraceIndex` shares one-element chunk lists: when an entry's `chunks` (or `logChunks`) is empty and gets its first chunk, it takes a frozen one-element array shared by every entry that got the same first chunk (cache the last such array per list kind: the pending chunk key only changes on a cut). Longer lists keep `concat`. `load` shares one-element lists the same way.
3. Tests: entries with equal roots or the same single chunk serialize exactly as before; a shared one-element list is never mutated (an entry that gets a second chunk has `[c0, c1]` and the other entries keep `[c0]`); a frozen root cannot be changed (assigning throws in strict mode, or the entry's root is replaced, not mutated, wherever the code sets it).
4. `src/cli/main.ts`: receivers (`serve`, `run`, through the `favourHeapSize` CLI dep) set `--optimize-for-size --heap-growing-percent=40`; metric conversions keep `--optimize-for-size` alone (the 72M-point metrics figure was measured with it). The comment above the functions gives the reason and the numbers above in two sentences. README: the sentence Task 4 added to the metrics bullet says what receivers set and why (short GC pauses: a sender's batch queue overflows when the receiver stalls).

## Task 5 (controller): measure, document, close #53

1. Local run with native telemetrygen (1M spans gRPC + 1M logs HTTP, CI flags): all records, 0 refused/rejected, peak RSS under 512 MB.
2. Open the PR; dispatch `load.yml` on the branch (`gh workflow run load.yml --ref <branch>`); the `receiver` job must be green.
3. README Limits "Receiver:" bullet: measured spans/logs, peak RSS, generator times, landing timings if printed, the date and runner. PR body says `Fixes #53`.
