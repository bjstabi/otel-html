import { expect, test, vi } from 'vitest';
import type { DataSource } from '../../src/viewer/data/data-source.js';
import { pendingDataSource } from '../../src/viewer/data/pending-source.js';
import type { SpanQuery } from '../../src/viewer/data/results.js';
import { baseManifest, dataSourceOf } from './dashboard-shell.js';

const METHODS = Object.entries(dataSourceOf(baseManifest))
  .filter(([, v]) => typeof v === 'function')
  .map(([k]) => k) as (keyof DataSource)[];

test('manifest and epoch are synchronous', () => {
  const pending = pendingDataSource(baseManifest, new Promise(() => undefined));
  expect(pending.manifest).toBe(baseManifest);
  expect(pending.epoch).toBe(BigInt(baseManifest.epochUnixNano));
});

test('every method waits for the real data source and passes its arguments through', async () => {
  const calls: [string, unknown[]][] = [];
  const real = Object.fromEntries(
    METHODS.map((m) => [
      m,
      (...args: unknown[]) => {
        calls.push([m, args]);
        return Promise.resolve(`${m}-result`);
      },
    ]),
  ) as unknown as DataSource;
  let resolve: (ds: DataSource) => void = () => undefined;
  const pending = pendingDataSource(
    baseManifest,
    new Promise((r) => {
      resolve = r;
    }),
  );
  const results = METHODS.map((m) => (pending[m] as (...a: unknown[]) => Promise<unknown>)('a', 2));
  await Promise.resolve();
  expect(calls).toEqual([]);
  resolve(real);
  expect(await Promise.all(results)).toEqual(METHODS.map((m) => `${m}-result`));
  expect(calls).toEqual(METHODS.map((m) => [m, ['a', 2]]));
});

test('a signal aborted before the engine is ready skips the query', async () => {
  const querySpans = vi.fn();
  const controller = new AbortController();
  const pending = pendingDataSource(
    baseManifest,
    Promise.resolve({ ...dataSourceOf(baseManifest), querySpans } as DataSource),
  );
  const call = pending.querySpans({} as SpanQuery, controller.signal);
  controller.abort();
  await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  expect(querySpans).not.toHaveBeenCalled();
});

test('a failed load rejects every call with its error', async () => {
  const pending = pendingDataSource(baseManifest, Promise.reject(new Error('engine: boom')));
  await expect(pending.services({ window: null, condition: null, limit: 1 })).rejects.toThrow('engine: boom');
});
