import { describe, expect, test } from 'vitest';
import { finishReceiver, type OpenReceiver } from '../../src/cli/commands/receive.js';
import type { CliIo } from '../../src/cli/io.js';
import type { Forwarder } from '../../src/receiver/forward.js';

function io(): CliIo {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    cwd: '/work',
    signals: { on: () => () => undefined },
    spawn: () => {
      throw new Error('unused');
    },
  };
}

function opened(closeReceiver: () => Promise<void>): {
  value: OpenReceiver;
  forwarderClosed: () => number;
  aborted: () => number;
} {
  let closes = 0;
  let aborts = 0;
  const forwarder: Forwarder = {
    enqueue: () => undefined,
    stats: () => ({ forwarded: 0, dropped: 0, failed: 0 }),
    close: async () => {
      closes++;
    },
  };
  const report = {
    abort: async () => {
      aborts++;
    },
    close: async () => {
      throw new Error('not reached');
    },
  } as unknown as OpenReceiver['report'];
  const receiver = { close: closeReceiver, stats: () => ({}) } as unknown as OpenReceiver['receiver'];
  return { value: { report, receiver, forwarder }, forwarderClosed: () => closes, aborted: () => aborts };
}

describe('finishReceiver', () => {
  test('the forwarder is closed when beforeClose throws, and the original error propagates', async () => {
    const o = opened(async () => undefined);
    await expect(
      finishReceiver(io(), o.value, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(o.forwarderClosed()).toBe(1);
    expect(o.aborted()).toBe(1);
  });

  test('the forwarder is closed when the receiver fails to close', async () => {
    const o = opened(async () => {
      throw new Error('listener');
    });
    await expect(finishReceiver(io(), o.value)).rejects.toThrow('listener');
    expect(o.forwarderClosed()).toBe(1);
  });
});
