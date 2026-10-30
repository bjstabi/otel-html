import { describe, expect, test, vi } from 'vitest';
import { StreamNormalizer } from '../../src/rollups/metric-streams.js';
import { openSession } from '../../src/writer/session.js';
import { createMemoryFileSystem } from '../../test-support/memory-fs.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { config, heldCheckpoint, makeDue, OUT, one, STATE_0 } from './checkpoint-helpers.js';
import { manifestOf } from './helpers.js';

const MANIFEST = 'r/data/manifest.js';

describe('an idle session checkpoints by itself', () => {
  test('a session with new records checkpoints when the idle timer fires', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    expect(w.timers.pending).toBe(1);
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(w.fs.snapshot().has(MANIFEST)).toBe(true));
    expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 1 } });
    await s.close();
  });

  test('flush after the idle checkpoint lists each chunk once', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    w.timers.fire();
    await vi.waitFor(() => expect(w.fs.snapshot().has(MANIFEST)).toBe(true));
    await s.flush();
    expect(manifestOf(w, OUT).chunks.map((c) => c.n)).toEqual([0]);
    await s.close();
  });

  test('nothing new since the last checkpoint arms no timer', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    await s.flush();
    expect(w.timers.pending).toBe(0);
    await s.close();
  });

  test('the timer fired during a background write re-arms', async () => {
    const { w, s, gate } = await heldCheckpoint();
    await s.add(one(2, 3), 'c.json');
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(w.timers.pending).toBe(1));
    gate.release();
    // The held write may not have ended yet, in which case the timer re-arms again: fire until it has run.
    await vi.waitFor(() => {
      w.timers.fire();
      expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 3 } });
    });
    await s.close();
  });

  test('an idle checkpoint whose prepare throws is logged, not left unhandled', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    const spy = vi.spyOn(StreamNormalizer.prototype, 'toJSON').mockImplementationOnce(() => {
      throw new Error('prepare broke');
    });
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() =>
      expect(w.logs.some((l) => l.level === 'error' && l.msg.includes('checkpoint failed; will retry'))).toBe(
        true,
      ),
    );
    spy.mockRestore();
    await s.flush();
    expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 1 } });
    await s.close();
  });

  test('an idle prepare failure re-arms the timer and the next firing commits', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    const spy = vi.spyOn(StreamNormalizer.prototype, 'toJSON').mockImplementationOnce(() => {
      throw new Error('prepare broke');
    });
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(w.logs.some((l) => l.level === 'error')).toBe(true));
    spy.mockRestore();
    await vi.waitFor(() => expect(w.timers.pending).toBe(1));
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 1 } }));
    await s.close();
  });

  test('a failed background write re-arms the idle timer and the next firing commits', async () => {
    const w = createTestWriter({ fs: createMemoryFileSystem({ pieces: true }) });
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    makeDue(w);
    w.fs.failNextWrite(STATE_0);
    await s.add(one(1, 2), 'b.json'); // due: the background write fails
    await vi.waitFor(() => expect(w.logs.some((l) => l.level === 'error')).toBe(true));
    await vi.waitFor(() => expect(w.timers.pending).toBe(1));
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 2 } }));
    await s.close();
  });

  test('the timer firing during a partial add re-arms; the checkpoint follows once the input ends', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json', { partial: true });
    expect(w.timers.pending).toBe(1);
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(w.timers.pending).toBe(1));
    expect(w.fs.snapshot().has(MANIFEST)).toBe(false);
    await s.endInput();
    expect(w.timers.fire()).toBe(1);
    await vi.waitFor(() => expect(manifestOf(w, OUT)).toMatchObject({ totals: { spans: 1 } }));
    await s.close();
  });

  test('abort cancels the timer', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    await s.abort();
    expect(w.timers.pending).toBe(0);
  });

  test('close cancels the timer', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    await s.close();
    expect(w.timers.pending).toBe(0);
  });
});
