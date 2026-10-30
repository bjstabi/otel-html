import type { ResolvedConfig } from '../../src/config/schema.js';
import { openSession, type WriterSession } from '../../src/writer/session.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import {
  createTestWriter,
  EPOCH_NS,
  otlp,
  type TestWriter,
  testConfig,
} from '../../test-support/writer-deps.js';
import { spanIdOf, traceIdOf } from './helpers.js';

export const OUT = 'r';
const INTERVAL_MS = 5_000;
export const STATE_0 = 'data/state/session.0.json';
// One chunk per span, so chunk numbers show which checkpoint listed what.
export const config: ResolvedConfig = testConfig({
  writer: { chunkTargetBytes: 1, flushIntervalMs: INTERVAL_MS },
});

export const one = (trace: number, spanN: number): ReturnType<typeof otlp> =>
  otlp(
    traceRequest([
      span({
        traceId: traceIdOf(trace),
        spanId: spanIdOf(spanN),
        startTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(spanN)),
        endTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(spanN) + 10n),
      }),
    ]),
  );

export const makeDue = (w: TestWriter): void => w.clock.advance(BigInt(INTERVAL_MS) * 1_000_000n);

/** A session whose first interval checkpoint (after two spans) is held at its state slot write. */
export async function heldCheckpoint(holdPath: string = STATE_0): Promise<{
  w: TestWriter;
  s: WriterSession;
  gate: ReturnType<ReturnType<typeof createMemoryFileSystem>['holdNextWrite']>;
}> {
  const w = createTestWriter({ fs: createMemoryFileSystem({ pieces: true }) });
  const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
  await s.add(one(0, 1), 'a.json');
  makeDue(w);
  const gate = w.fs.holdNextWrite(holdPath);
  await s.add(one(1, 2), 'b.json'); // due: prepares the checkpoint and returns while its write is held
  await gate.reached;
  return { w, s, gate };
}
