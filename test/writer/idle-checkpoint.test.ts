import { describe, expect, test, vi } from 'vitest';
import { openSession } from '../../src/writer/session.js';
import { createTestWriter } from '../../test-support/writer-deps.js';
import { config, heldCheckpoint, OUT, one } from './checkpoint-helpers.js';
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

  test('close cancels the timer', async () => {
    const w = createTestWriter();
    const s = await openSession(w.deps, { out: OUT, config, mode: 'replace' });
    await s.add(one(0, 1), 'a.json');
    await s.close();
    expect(w.timers.pending).toBe(0);
  });
});
