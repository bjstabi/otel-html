import { expect, test } from 'vitest';
import { createFileGate } from '../../src/viewer/data/engine/file-gate.js';
import { swapToBuffer } from '../../src/viewer/data/engine/files.js';
import type { Engine } from '../../src/viewer/data/engine/start.js';
import { engineConnector } from '../../src/viewer/data/mosaic.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function fake(registerFails = false) {
  const log: string[] = [];
  const connection = {
    useUnsafe: async (f: (b: { runQuery: (id: number, sql: string) => Uint8Array }, id: number) => unknown) =>
      f(
        {
          runQuery: (_id, sql) => {
            log.push(`stmt ${sql}`);
            return new Uint8Array();
          },
        },
        1,
      ),
  };
  const db = {
    dropFile: async (p: string) => {
      log.push(`drop ${p}`);
      await tick();
    },
    registerFileBuffer: async (p: string) => {
      await tick();
      if (registerFails) throw new Error('no memory');
      log.push(`buffer ${p}`);
    },
    registerFileURL: async (p: string, url: string) => void log.push(`url ${p} ${url}`),
  };
  const gate = createFileGate();
  const engine = { db, connection, gate, format: 'site' } as unknown as Engine;
  return { engine, log, connector: engineConnector(connection as never, gate) };
}

test('a statement issued during a swap runs after it, and sees the file', async () => {
  const { engine, log, connector } = fake();
  const swap = swapToBuffer(engine, 'a', new Uint8Array(1), 'http://x/a');
  const statement = connector.query({ type: 'exec', sql: 'SELECT 1' } as never, {} as never);
  await Promise.all([swap, statement]);
  expect(log).toEqual(['drop a', 'buffer a', 'stmt SELECT 1']);
});

test('a statement posted before the swap runs before it', async () => {
  const { engine, log, connector } = fake();
  const statement = connector.query({ type: 'exec', sql: 'SELECT 1' } as never, {} as never);
  await tick();
  await Promise.all([swapToBuffer(engine, 'a', new Uint8Array(1), 'http://x/a'), statement]);
  expect(log[0]).toBe('stmt SELECT 1');
});

test('a register failure leaves the path readable by URL, rethrows, and releases the statements', async () => {
  const { engine, log, connector } = fake(true);
  const swap = swapToBuffer(engine, 'a', new Uint8Array(1), 'http://x/a');
  const outcome = expect(swap).rejects.toThrow('no memory');
  const statement = connector.query({ type: 'exec', sql: 'SELECT 1' } as never, {} as never);
  await outcome;
  await statement;
  expect(log).toEqual(['drop a', 'url a http://x/a', 'stmt SELECT 1']);
});
