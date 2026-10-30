import { describe, expect, test, vi } from 'vitest';
import { StreamNormalizer } from '../../src/rollups/metric-streams.js';
import { openSession } from '../../src/writer/session.js';
import { span, traceRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, EPOCH_NS, otlp, type TestWriter } from '../../test-support/writer-deps.js';
import { config, heldCheckpoint, makeDue, OUT, one, STATE_0 } from './checkpoint-helpers.js';
import { manifestOf, readDataFile, spanIdOf, traceIdOf } from './helpers.js';

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

  test('a failed interval prepare is logged and does not fail the add that triggered it', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    makeDue(w);
    const spy = vi.spyOn(StreamNormalizer.prototype, 'toJSON').mockImplementationOnce(() => {
      throw new Error('prepare broke');
    });
    await expect(s.add(one(1, 2), 'b.json')).resolves.toMatchObject({ accepted: 1 });
    spy.mockRestore();
    const errors = (): string[] => w.logs.filter((l) => l.level === 'error').map((l) => l.msg);
    expect(errors()).toEqual(['checkpoint failed; will retry at the next flush']);
    // the interval restarted: the next add does not retry straight away
    await s.add(one(2, 3), 'c.json');
    expect(errors()).toHaveLength(1);
    expect(w.fs.snapshot().has(`${OUT}/data/manifest.js`)).toBe(false);
    makeDue(w);
    await s.add(one(3, 4), 'd.json');
    await vi.waitFor(() => expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 4 } }));
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

describe('the streamed state', () => {
  test('is byte-identical to JSON.stringify, with integer-named shards first like JS object keys', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    // "0a" sorts before "12", but a JS object lists the integer-like key "12" first
    for (const [i, prefix] of ['0a', '12', '0a', '12'].entries()) {
      const request = traceRequest([
        span({
          traceId: `${prefix}${i.toString(16).padStart(30, '0')}`,
          spanId: spanIdOf(i),
          startTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i)),
          endTimeUnixNano: String(BigInt(EPOCH_NS) + BigInt(i) + 10n),
        }),
      ]);
      await s.add(otlp(request), `${i}.json`);
    }
    await s.flush();
    const text = w.fs.snapshot().get(`${OUT}/${STATE_0}`);
    if (text === undefined) throw new Error('no state slot');
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
    expect(Object.keys(JSON.parse(text).traceIndex)).toEqual(['12', '0a']);
    await s.close();
  });
});
