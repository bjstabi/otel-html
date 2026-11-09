import { setImmediate } from 'node:timers/promises';
import { describe, expect, test, vi } from 'vitest';
import { StreamNormalizer } from '../../src/rollups/metric-streams.js';
import { PartitionWriter } from '../../src/writer/partition-writer.js';
import { openSession } from '../../src/writer/session.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { metricsRequest } from '../../test-support/otlp-builders.js';
import { createTestWriter, EPOCH_NS, otlp, testConfig } from '../../test-support/writer-deps.js';
import { config, heldCheckpoint, makeDue, OUT, one } from './checkpoint-helpers.js';
import { allSpans, manifestOf } from './helpers.js';

describe('interval checkpoints run in the background', () => {
  test('adds and endInput resolve while the state slot write is held, and their spans are kept', async () => {
    const { w, s, gate } = await heldCheckpoint();
    expect(w.fs.snapshot().has('r/data/manifest.js')).toBe(false);
    expect(await s.add(one(2, 3), 'c.json')).toMatchObject({ accepted: 1 });
    await s.endInput();
    gate.release();
    await s.flush();
    expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 3 } });
    expect(allSpans(w, OUT)).toHaveLength(3);
    await s.close();
  });

  test('a failed background write is retried by the next flush with everything it held', async () => {
    const { w, s, gate } = await heldCheckpoint();
    await s.add(one(2, 3), 'c.json'); // a third span arrives during the write
    gate.fail(new Error('disk gone'));
    await s.flush();
    expect(w.logs.some((l) => l.level === 'error' && l.msg.includes('checkpoint failed; will retry'))).toBe(
      true,
    );
    const m = manifestOf(w, OUT);
    expect(m.totals.spans).toBe(3);
    expect(allSpans(w, OUT)).toHaveLength(3);
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

  test('a tracer that throws after the manifest is written does not list partitions twice', async () => {
    const w = createTestWriter({ fs: createMemoryFileSystem({ pieces: true }) });
    const inner = w.deps.tracer;
    const deps = {
      ...w.deps,
      tracer: {
        startSpan(name: string, attrs?: Record<string, string | number | boolean>) {
          const h = inner.startSpan(name, attrs);
          return name === 'otel-html.flush'
            ? {
                ...h,
                setAttributes() {
                  throw new Error('telemetry broke');
                },
              }
            : h;
        },
      },
    };
    const s = await openSession(deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    makeDue(w);
    await s.add(one(1, 2), 'b.json');
    await vi.waitFor(() => expect(w.fs.snapshot().has(`${OUT}/data/manifest.js`)).toBe(true));
    await s.add(one(2, 3), 'c.json');
    makeDue(w);
    await s.add(one(3, 4), 'd.json');
    await vi.waitFor(() => expect(manifestOf(w, OUT).partitions.length).toBeGreaterThanOrEqual(2));
    await expect(s.flush()).resolves.toBeUndefined();
    const ns = manifestOf(w, OUT).partitions.map((p) => p.n);
    expect(new Set(ns).size).toBe(ns.length);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
    expect(
      w.logs.some((l) => l.level === 'warn' && Object.values(l.attrs ?? {}).includes('telemetry broke')),
    ).toBe(true);
    expect(w.logs.some((l) => l.level === 'error')).toBe(false);
    await s.close();
  });

  test('a span.end() that throws after the commit does not fail flush()', async () => {
    const w = createTestWriter({ fs: createMemoryFileSystem({ pieces: true }) });
    const inner = w.deps.tracer;
    const deps = {
      ...w.deps,
      tracer: {
        startSpan(name: string, attrs?: Record<string, string | number | boolean>) {
          const h = inner.startSpan(name, attrs);
          return name === 'otel-html.flush'
            ? {
                ...h,
                end() {
                  throw new Error('end broke');
                },
              }
            : h;
        },
      },
    };
    const s = await openSession(deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    await expect(s.flush()).resolves.toBeUndefined();
    expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 1 } });
    expect(
      w.logs.some(
        (l) =>
          l.level === 'warn' &&
          l.msg === 'flush telemetry failed' &&
          Object.values(l.attrs ?? {}).includes('end broke'),
      ),
    ).toBe(true);
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
      // A macrotask boundary: a held write cannot resolve `done` however long we wait, so one turn proves the same.
      await setImmediate();
      expect(done).toBe(false);
      gate.release();
      await p;
      expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 2 }, complete: call === 'close' });
      if (call === 'flush') await s.close();
    },
  );
});

describe('back-pressure on the library path', () => {
  const TARGET = 1_500;
  const T0 = BigInt(EPOCH_NS);
  const gauge = (i: number) =>
    otlp(
      metricsRequest([
        {
          name: `m${i}`,
          unit: 'By',
          gauge: { dataPoints: [{ asInt: String(i), timeUnixNano: String(T0 + BigInt(i)) }] },
        },
      ]),
    );

  test('add waits for the in-flight checkpoint once the held rows reach the target, and the hold stays bounded', async () => {
    const w = createTestWriter({ fs: createMemoryFileSystem({ pieces: true }) });
    const held: number[] = [];
    const getter = Object.getOwnPropertyDescriptor(PartitionWriter.prototype, 'pendingBytes')?.get;
    if (getter === undefined) throw new Error('pendingBytes getter missing');
    let writer: PartitionWriter | null = null;
    vi.spyOn(PartitionWriter.prototype, 'pendingBytes', 'get').mockImplementation(function (
      this: PartitionWriter,
    ) {
      writer = this;
      return getter.call(this);
    });
    const s = await openSession(w.deps, {
      out: OUT,
      config: testConfig({ writer: { format: 'site', chunkTargetBytes: TARGET } }),
      mode: 'replace',
    });
    const observe = (): void => {
      if (writer !== null) held.push(getter.call(writer));
    };
    const gate = w.fs.holdNextWrite('000000/points.parquet');
    let reached = false;
    void gate.reached.then(() => {
      reached = true;
    });
    let i = 0;
    let blocked: Promise<unknown> | null = null;
    // add until one stays pending: the first to reach the target starts the checkpoint (held at its write), a later
    // one reaches the target again while the write is in flight and must wait for it
    for (; blocked === null && i < 200; i++) {
      const add = s.add(gauge(i), 'a.json');
      const winner = await Promise.race([add.then(() => 'added'), setImmediate('tick')]);
      if (winner === 'tick') blocked = add;
      else observe();
    }
    if (blocked === null) throw new Error('no add waited for the checkpoint');
    expect(reached).toBe(true);
    expect(Math.max(...held)).toBeLessThan(2 * TARGET);
    // still pending after a further tick, until the held write is released
    expect(await Promise.race([blocked.then(() => 'added'), setImmediate('tick')])).toBe('tick');
    gate.release();
    await blocked;
    observe();
    for (let k = 0; k < 20; k++) {
      await s.add(gauge(i + k), 'a.json');
      observe();
    }
    expect(Math.max(...held)).toBeLessThan(2 * TARGET);
    await s.close();
    vi.restoreAllMocks();
  });
});
