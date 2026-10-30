import { describe, expect, test, vi } from 'vitest';
import { StreamNormalizer } from '../../src/rollups/metric-streams.js';
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
import { manifestOf, readDataFile, spanIdOf, traceIdOf } from './helpers.js';

const OUT = 'r';
const INTERVAL_MS = 5_000;
const STATE_0 = 'data/state/session.0.json';
// One chunk per span, so chunk numbers show which checkpoint listed what.
const config = testConfig({ writer: { chunkTargetBytes: 1, flushIntervalMs: INTERVAL_MS } });

const one = (trace: number, spanN: number): ReturnType<typeof otlp> =>
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

const makeDue = (w: TestWriter): void => w.clock.advance(BigInt(INTERVAL_MS) * 1_000_000n);

const stateOf = (
  w: TestWriter,
  file: string,
): { traceIndex: Record<string, Record<string, { spans: number }>> } =>
  JSON.parse(w.fs.snapshot().get(`${OUT}/${file}`) ?? 'null');

const shardEntry = (w: TestWriter, trace: number): { spans: number } | undefined =>
  (
    readDataFile(w, OUT, `data/traces/${traceIdOf(trace).slice(0, 2)}.js`) as Record<
      string,
      { spans: number }
    >
  )[traceIdOf(trace)];

/** A session whose first interval checkpoint (after two spans) is held at its state slot write. */
async function heldCheckpoint(holdPath = STATE_0): Promise<{
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

describe('interval checkpoints run in the background', () => {
  test('adds and endInput resolve while the state slot write is held, and their spans are kept', async () => {
    const { w, s, gate } = await heldCheckpoint();
    expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(false);
    expect(await s.add(one(2, 3), 'c.json')).toMatchObject({ accepted: 1 });
    await s.endInput();
    gate.release();
    await s.flush();
    expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 3 } });
    expect(manifestOf(w, OUT).chunks.map((c) => c.n)).toEqual([0, 1, 2]);
    await s.close();
  });

  test('an entry in the held snapshot that gains a span keeps its prepare-time value in the written files', async () => {
    const { w, s, gate } = await heldCheckpoint();
    await s.add(one(0, 4), 'again.json'); // trace 0 is in the snapshot
    gate.release();
    await s.flush(); // waits for the held write, then checkpoints the update
    expect(manifestOf(w, OUT).totals.spans).toBe(3);
    // the held write's state slot (slot 0) was read after the update, yet shows the entry as prepared
    expect(stateOf(w, STATE_0).traceIndex[traceIdOf(0).slice(0, 2)]?.[traceIdOf(0)]?.spans).toBe(1);
    // the next checkpoint (slot 1) and the shard file show it updated
    expect(
      stateOf(w, 'data/state/session.1.json').traceIndex[traceIdOf(0).slice(0, 2)]?.[traceIdOf(0)]?.spans,
    ).toBe(2);
    expect(shardEntry(w, 0)?.spans).toBe(2);
    await s.close();
  });

  test('a failed background write is retried by the next flush with everything it held', async () => {
    const { w, s, gate } = await heldCheckpoint();
    await s.add(one(2, 3), 'c.json'); // chunk 2 is cut during the write
    gate.fail(new Error('disk gone'));
    await s.flush();
    expect(w.logs.some((l) => l.level === 'error' && l.msg.includes('checkpoint failed; will retry'))).toBe(
      true,
    );
    const m = manifestOf(w, OUT);
    expect(m.chunks.map((c) => c.n)).toEqual([0, 1, 2]);
    expect(m.totals.spans).toBe(3);
    for (const t of [0, 1, 2]) expect(shardEntry(w, t)?.spans).toBe(1);
    await s.close();
  });

  test('the shards of a failed shard write are dirty again: the next flush writes them without any new add', async () => {
    const { w, s, gate } = await heldCheckpoint('data/traces/00.js');
    gate.fail(new Error('disk gone'));
    await s.flush(); // nothing was added since: only the restored dirty set tells it to write shard 00
    expect(shardEntry(w, 0)?.spans).toBe(1);
    expect(shardEntry(w, 1)?.spans).toBe(1);
    await s.close();
  });

  test('a prepare that throws leaves the session able to checkpoint', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    const spy = vi.spyOn(StreamNormalizer.prototype, 'toJSON').mockImplementationOnce(() => {
      throw new Error('prepare broke');
    });
    await expect(s.flush()).rejects.toThrow(/prepare broke/);
    spy.mockRestore();
    await s.flush();
    expect(shardEntry(w, 0)?.spans).toBe(1);
    expect(manifestOf(w, OUT).totals.spans).toBe(1);
    await s.close();
  });

  test.each(['flush', 'close'] as const)(
    '%s() during a held write waits for it and then commits',
    async (call) => {
      const { w, s, gate } = await heldCheckpoint();
      let done = false;
      const p = s[call]().then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(done).toBe(false);
      gate.release();
      await p;
      expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 2 }, complete: call === 'close' });
      if (call === 'flush') await s.close();
    },
  );
});
